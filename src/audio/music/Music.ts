/**
 * Music director: look-ahead scheduler (Chris Wilson's "tale of two clocks"), per-track layer
 * buses with intensity crossfades, tempo-synced echo and track-to-track crossfades.
 */
import { clamp01 } from '../mix';
import { Instruments } from './instruments';
import type { Kit } from './kit';
import {
  type Intensity,
  LAYERS,
  type LayerName,
  type StepCtx,
  TRACKS,
  type TrackDef,
  type TrackName,
} from './tracks';

const LOOKAHEAD_S = 0.15;

/** Live per-layer overrides shared by every TrackPlayer (Editor stem erasing, blank page). */
export interface LayerMods {
  mul: Record<LayerName, number>;
  pan: Record<LayerName, number>;
}

/** Called for every 16th the *current* track schedules (after the track's own notes). */
export type StepListener = (c: StepCtx, layers: Record<LayerName, GainNode>) => void;

function layerRecord<T>(make: (l: LayerName) => T): Record<LayerName, T> {
  const r = {} as Record<LayerName, T>;
  for (const l of LAYERS) r[l] = make(l);
  return r;
}

class TrackPlayer {
  readonly out: GainNode;
  readonly layers: Record<LayerName, GainNode>;
  private targets = layerRecord(() => 0);
  private lastTargets = layerRecord(() => -1);
  /** Context time of the next unscheduled 16th (the scheduler horizon). */
  next: number;
  /** Next 16th index to schedule. Step n sounds at `anchor + n * sec16`. */
  step = 0;
  /** Context time of step 0. */
  readonly anchor: number;
  readonly sec16: number;
  private pans: Partial<Record<LayerName, StereoPannerNode>> = {};
  onStep: StepListener | null = null;
  private droneStop: (() => void) | null = null;
  private nodes: AudioNode[] = [];
  private ctx: StepCtx;
  dead = false;
  private stopAt = Number.POSITIVE_INFINITY;

  constructor(
    private ac: AudioContext,
    readonly name: TrackName,
    readonly def: TrackDef,
    dest: AudioNode,
    reverb: AudioNode,
    inst: Instruments,
    start: number,
    fadeIn: number,
    rnd: () => number,
    private intensity: Intensity,
    private mods: LayerMods,
    exciter: AudioNode | null,
  ) {
    this.out = ac.createGain();
    this.out.gain.setValueAtTime(0, ac.currentTime);
    this.out.gain.linearRampToValueAtTime(1, start + fadeIn);
    this.out.connect(dest);
    const beat = 60 / def.bpm;
    // tempo-synced dotted-8th echo for the melody
    const delay = ac.createDelay(2);
    delay.delayTime.value = beat * 0.75;
    const fb = ac.createGain();
    fb.gain.value = 0.36;
    const dlp = ac.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 2800;
    const wet = ac.createGain();
    wet.gain.value = 0.32;
    delay.connect(dlp);
    dlp.connect(fb);
    fb.connect(delay);
    dlp.connect(wet);
    wet.connect(this.out);
    const wetSend = ac.createGain();
    wetSend.gain.value = 0.5;
    wet.connect(wetSend);
    wetSend.connect(reverb);
    this.nodes.push(delay, fb, dlp, wet, wetSend);
    this.layers = layerRecord((l) => {
      const g = ac.createGain();
      g.gain.value = 0;
      // Stereo panner per layer so an erased stem can be dragged off toward the eraser sweep.
      if (typeof ac.createStereoPanner === 'function') {
        const p = ac.createStereoPanner();
        p.pan.value = mods.pan[l];
        g.connect(p);
        p.connect(this.out);
        this.pans[l] = p;
        this.nodes.push(p);
      } else g.connect(this.out);
      // phone-speaker mastering: low-end stems feed the harmonic exciter
      if (exciter && (l === 'bass' || l === 'perc' || l === 'drone')) g.connect(exciter);
      const send = def.sends[l];
      if (send) {
        const sg = ac.createGain();
        sg.gain.value = send;
        g.connect(sg);
        sg.connect(reverb);
        this.nodes.push(sg);
      }
      if (def.echo.includes(l)) g.connect(delay);
      this.nodes.push(g);
      return g;
    });
    this.applyLevels(true);
    if (def.drone) this.droneStop = inst.drone(this.layers.drone, start, def.drone, 0.12);
    this.next = start;
    this.anchor = start;
    this.sec16 = beat / 4;
    this.ctx = {
      t: 0,
      step: 0,
      bar: 0,
      s16: 0,
      loop: 0,
      sec16: beat / 4,
      inst,
      out: this.layers,
      int: intensity,
      rnd,
    };
  }

  applyLevels(immediate = false): void {
    this.def.levels(this.intensity, this.targets);
    const now = this.ac.currentTime;
    for (const l of LAYERS) {
      const v = clamp01(this.targets[l]) * this.mods.mul[l];
      const last = this.lastTargets[l];
      if (Math.abs(v - last) < 1e-3) continue;
      const p = this.layers[l].gain;
      if (immediate) p.setValueAtTime(v, now);
      else p.setTargetAtTime(v, now, v > last ? 0.45 : 1.4);
      this.lastTargets[l] = v;
    }
  }

  /** Re-read `mods` for one layer with a custom fade time constant (stem erase / restore). */
  applyMod(l: LayerName, tau: number): void {
    const now = this.ac.currentTime;
    this.def.levels(this.intensity, this.targets);
    const v = clamp01(this.targets[l]) * this.mods.mul[l];
    const g = this.layers[l].gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(v, now, tau);
    this.lastTargets[l] = v;
    const p = this.pans[l];
    if (p) {
      p.pan.cancelScheduledValues(now);
      p.pan.setValueAtTime(p.pan.value, now);
      p.pan.setTargetAtTime(this.mods.pan[l], now, tau);
    }
  }

  schedule(until: number): void {
    if (this.dead) return;
    const now = this.ac.currentTime;
    if (now > this.stopAt) {
      this.dispose();
      return;
    }
    const c = this.ctx;
    // main thread stalled: re-align to the grid instead of firing a burst of late notes
    if (this.next < now - 0.1) {
      const missed = Math.ceil((now - this.next) / c.sec16);
      this.next += missed * c.sec16;
      this.step += missed;
    }
    const loop16 = this.def.loopBars * 16;
    while (this.next < until && this.next < this.stopAt) {
      const inLoop = this.step % loop16;
      c.t = this.next;
      c.step = this.step;
      c.bar = inLoop >> 4;
      c.s16 = inLoop & 15;
      c.loop = Math.floor(this.step / loop16);
      this.def.step(c);
      this.onStep?.(c, this.layers);
      this.step++;
      this.next += c.sec16;
    }
  }

  stop(fade: number): void {
    const now = this.ac.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0, now + fade);
    this.stopAt = now + fade + 0.05;
    this.droneStop?.();
    this.droneStop = null;
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.droneStop?.();
    // let release tails finish before cutting the graph
    setTimeout(() => {
      this.out.disconnect();
      for (const n of this.nodes) n.disconnect();
    }, 3000);
  }
}

export class Music {
  readonly inst: Instruments;
  readonly intensity: Intensity = { explore: 0.5, combat: 0, boss: 0.34 };
  readonly mods: LayerMods = {
    mul: layerRecord(() => 1),
    pan: layerRecord(() => 0),
  };
  /** Step hook for the current track (beat events, drummer, freeze letters, heartbeat…). */
  onStep: StepListener | null = null;
  /** Optional send for low stems (phone-speaker exciter). Set before the first track starts. */
  exciter: AudioNode | null = null;
  private players: TrackPlayer[] = [];
  private current: TrackPlayer | null = null;
  private seed = 0x7a3c;
  private rnd = () => {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return (this.seed >>> 8) / 16777216;
  };

  constructor(
    private ac: AudioContext,
    private dest: AudioNode,
    private reverb: AudioNode,
  ) {
    this.inst = new Instruments(ac);
  }

  setKit(k: Kit): void {
    this.inst.setKit(k);
  }

  get track(): TrackName | null {
    return this.current?.name ?? null;
  }

  setTrack(name: TrackName | null, fade = 2.2): void {
    if ((this.current?.name ?? null) === name) return;
    this.current?.stop(fade);
    this.current = null;
    if (!name) return;
    const start = this.ac.currentTime + 0.08;
    const p = new TrackPlayer(
      this.ac,
      name,
      TRACKS[name],
      this.dest,
      this.reverb,
      this.inst,
      start,
      this.players.length ? fade * 0.6 : 0.6,
      this.rnd,
      this.intensity,
      this.mods,
      this.exciter,
    );
    for (const o of this.players) o.onStep = null;
    p.onStep = (c, l) => this.onStep?.(c, l);
    this.players.push(p);
    this.current = p;
  }

  // ── step grid (StepGrid for the beat clock)

  /** Context time of the current track's step 0 (NaN without a track). */
  get anchor(): number {
    return this.current ? this.current.anchor : Number.NaN;
  }
  get sec16(): number {
    return this.current?.sec16 ?? 0;
  }
  get bpm(): number {
    return this.current?.def.bpm ?? 0;
  }
  /** Context time up to which 16ths are already scheduled (look-ahead horizon). */
  get horizon(): number {
    return this.current?.next ?? 0;
  }
  /** Index of the next 16th the scheduler will produce. */
  get nextStep(): number {
    return this.current?.step ?? 0;
  }
  /** Layer gains of the current track (to add notes outside the step function). */
  get layers(): Record<LayerName, GainNode> | null {
    return this.current?.layers ?? null;
  }

  /**
   * Scale one layer of every track (1 = as composed, 0 = erased) and pan it; fades with `tau`.
   */
  setLayerMod(layer: LayerName, mul: number, pan = 0, tau = 0.6): void {
    if (this.mods.mul[layer] === mul && this.mods.pan[layer] === pan) return;
    this.mods.mul[layer] = mul;
    this.mods.pan[layer] = pan;
    for (const p of this.players) p.applyMod(layer, tau);
  }

  resetLayerMods(tau = 0.8): void {
    for (const l of LAYERS) this.setLayerMod(l, 1, 0, tau);
  }

  setIntensity(layer: keyof Intensity, level: number): void {
    const v = clamp01(level);
    if (this.intensity[layer] === v) return;
    this.intensity[layer] = v;
    for (const p of this.players) p.applyLevels();
  }

  /** Called by the engine's scheduler timer. */
  tick(): void {
    if (this.ac.state !== 'running') return;
    const until = this.ac.currentTime + LOOKAHEAD_S;
    for (let i = this.players.length - 1; i >= 0; i--) {
      const p = this.players[i]!;
      p.schedule(until);
      if (p.dead) this.players.splice(i, 1);
    }
  }

  stopAll(): void {
    this.setTrack(null, 0.5);
  }
}
