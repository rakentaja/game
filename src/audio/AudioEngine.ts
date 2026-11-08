/**
 * AudioEngine — raw Web Audio implementation of AudioAPI.
 *
 * Graph:
 *   voices ─┬─────────────► sfxBus ──┐
 *           └► sfxVerbSend ─► reverb ─► verbReturn ─┐
 *   music  ─► pauseLP ─► duck ─► musicBus ──────────┴─► master ─► limiter ─► destination
 *
 * iOS notes
 *  - The context starts "suspended" everywhere until resume() runs inside a user gesture; call
 *    unlock() from the first pointerdown/touchend/keydown (install() wires this for you).
 *  - Web Audio follows the ringer/silent switch on iOS. We explicitly request the "ambient"
 *    audio session (Safari 16.4+: navigator.audioSession) so the game respects the switch and
 *    mixes with the player's own music, like native games do. `mayBeMutedBySwitch` lets the UI
 *    show a "sound off? check the silent switch" hint.
 *  - Phone calls/Siri put the context into "interrupted"; we resume on the next gesture.
 *
 * Allocation: voices, buses and panners are created once. A play() costs one
 * AudioBufferSourceNode (one-shot by spec) and nothing else.
 */
import type { Vector3 } from 'three';
import type { AudioAPI, SfxId } from '../core/types';
import { type BusLevels, busGains, dbToGain } from './mix';
import { bakeKit } from './music/kit';
import { Music } from './music/Music';
import type { TrackName } from './music/tracks';
import {
  type CanPlay,
  normalizeSprites,
  pickFormats,
  SPRITE,
  type SpriteEntry,
  type SpriteManifest,
} from './sprites';
import { type BakedSfx, bakeRecipe } from './synth/bake';
import { impulseResponse, Rng } from './synth/dsp';
import { BAKE_ORDER, SFX, SFX_IDS } from './synth/sfx';

const SPATIAL_VOICES = 18;
const FLAT_VOICES = 10;
/** Music sits ~4 LU under SFX at equal faders (measured: explore ≈ -23 LUFS, SFX reel ≈ -18). */
const MUSIC_TRIM = 0.6;
/** Camera-to-player distance (TUNING.camera: 9 m back, 7.5 m up ≈ 11.7 m). */
const LISTENER_REF_M = 12;
/** Events that count as user activation for touch (pointerdown/touchstart do NOT on iOS). */
export const ACTIVATION_EVENTS = ['touchend', 'pointerup', 'click', 'keydown', 'mousedown'] as const;
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19];

interface Voice {
  gain: GainNode;
  panner: PannerNode | null;
  src: AudioBufferSourceNode | null;
  id: SfxId | null;
  priority: number;
  endsAt: number;
}

interface LoopHandle {
  id: SfxId;
  volume: number;
  gain: GainNode;
  src: AudioBufferSourceNode | null;
  active: boolean;
}

export interface AudioEngineOptions {
  /** Respect the iOS silent switch (default true → "ambient" session). */
  respectSilentSwitch?: boolean;
  /** Recorded sprite override (defaults to SPRITE, null = fully procedural). */
  sprite?: SpriteManifest | null;
  /** Called after each SFX variant is baked (dev harness meters). */
  onBaked?: (b: BakedSfx) => void;
}

type Ctor = new (opts?: AudioContextOptions) => AudioContext;

export class AudioEngine implements AudioAPI {
  readonly ac: AudioContext;
  readonly music: Music;
  /** True on iOS/iPadOS, where the hardware silent switch mutes Web Audio. */
  readonly mayBeMutedBySwitch: boolean;
  /** Resolves when every SFX variant and the music kit are baked. */
  readonly ready: Promise<void>;
  readonly baked = new Map<SfxId, BakedSfx[]>();

  private master: GainNode;
  private limiter: DynamicsCompressorNode;
  private musicBus: GainNode;
  private sfxBus: GainNode;
  private duck: GainNode;
  private pauseLP: BiquadFilterNode;
  private reverb: ConvolverNode;
  private sfxSend: GainNode;
  private musicIn: GainNode;
  private voices: Voice[] = [];
  private loops: LoopHandle[] = [];
  private lastPlay = new Map<SfxId, number>();
  private rr = new Map<SfxId, number>();
  private spriteBuf: AudioBuffer | null = null;
  private sprites = new Map<SfxId, SpriteEntry[]>();
  private rng = new Rng(0xa0d10);
  private combo = { last: -10, idx: 0 };
  private levels: BusLevels = { master: 0.9, music: 0.7, sfx: 0.9 };
  private userSuspended = false;
  private unlocked = false;
  private resuming = false;
  private lastListener = new Float64Array([Number.NaN, 0, 0, 0, 0, 0]);
  private paused = false;
  private wantTrack: TrackName | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private analyser: AnalyserNode | null = null;
  private disposers: (() => void)[] = [];

  constructor(opts: AudioEngineOptions = {}) {
    const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
    const C = g.AudioContext ?? g.webkitAudioContext;
    if (!C) throw new Error('Web Audio unsupported');
    this.ac = new C({ latencyHint: 'interactive' });
    const ac = this.ac;
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    this.mayBeMutedBySwitch =
      !!nav &&
      (/iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1));
    const session = (nav as unknown as { audioSession?: { type: string } } | null)?.audioSession;
    if (session) {
      try {
        session.type = opts.respectSilentSwitch === false ? 'playback' : 'ambient';
      } catch {
        /* older WebKit: property is read-only */
      }
    }

    // ── master chain
    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;
    this.master = ac.createGain();
    this.master.connect(this.limiter);
    this.limiter.connect(ac.destination);

    this.musicBus = ac.createGain();
    this.sfxBus = ac.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);

    this.reverb = ac.createConvolver();
    this.reverb.buffer = impulseResponse(ac, 3.2, 4.2);
    const verbReturn = ac.createGain();
    verbReturn.gain.value = 0.55;
    this.reverb.connect(verbReturn);
    // music reverb returns through the music bus (so the music fader governs it)…
    const musicVerb = ac.createConvolver();
    musicVerb.buffer = this.reverb.buffer;
    const musicVerbRet = ac.createGain();
    musicVerbRet.gain.value = 0.7;
    // …sfx reverb through the sfx bus
    verbReturn.connect(this.sfxBus);
    this.sfxSend = ac.createGain();
    this.sfxSend.gain.value = 0.12;
    this.sfxSend.connect(this.reverb);

    this.duck = ac.createGain();
    this.pauseLP = ac.createBiquadFilter();
    this.pauseLP.type = 'lowpass';
    this.pauseLP.frequency.value = 20000;
    this.pauseLP.Q.value = 0.5;
    this.musicIn = ac.createGain();
    this.musicIn.gain.value = MUSIC_TRIM;
    this.musicIn.connect(this.pauseLP);
    musicVerb.connect(musicVerbRet);
    musicVerbRet.connect(this.pauseLP);
    this.pauseLP.connect(this.duck);
    this.duck.connect(this.musicBus);
    this.music = new Music(ac, this.musicIn, musicVerb);

    // ── voice pool
    const sfxIn = ac.createGain();
    sfxIn.connect(this.sfxBus);
    sfxIn.connect(this.sfxSend);
    for (let i = 0; i < SPATIAL_VOICES + FLAT_VOICES; i++) {
      const gain = ac.createGain();
      let panner: PannerNode | null = null;
      if (i < SPATIAL_VOICES) {
        panner = ac.createPanner();
        panner.panningModel = 'equalpower';
        panner.distanceModel = 'inverse';
        // The listener rides the camera ~12 m from the player, so unity gain sits at that
        // distance: the hero's own sounds play at mastered level and things further up the
        // page fall off naturally (24 m ≈ -6 dB, 48 m ≈ -12 dB).
        panner.refDistance = LISTENER_REF_M;
        panner.maxDistance = 80;
        panner.rolloffFactor = 1;
        gain.connect(panner);
        panner.connect(sfxIn);
      } else gain.connect(sfxIn);
      this.voices.push({ gain, panner, src: null, id: null, priority: 0, endsAt: 0 });
    }

    this.applyVolumes(true);
    this.installLifecycle();
    this.timer = setInterval(() => this.music.tick(), 25);
    if (import.meta.env?.DEV) (globalThis as { __inkAudio?: AudioEngine }).__inkAudio = this;
    this.ready = this.bakeAll(opts.onBaked, opts.sprite === undefined ? SPRITE : opts.sprite);
  }

  // ───────────────────────────── AudioAPI ─────────────────────────────

  async unlock(): Promise<void> {
    const ac = this.ac;
    this.unlocked = true;
    if (ac.state !== 'running') {
      // iOS < 15 needs a buffer started inside the gesture to truly unlock; harmless elsewhere.
      const s = ac.createBufferSource();
      s.buffer = ac.createBuffer(1, 1, ac.sampleRate);
      s.connect(ac.destination);
      s.start(0);
    }
    if (ac.state !== 'running' && !this.userSuspended) {
      // resume() settles a few ms after the gesture; sounds requested meanwhile (the tap's own
      // UI click, a title stinger) are scheduled anyway and start the moment the clock runs.
      this.resuming = true;
      try {
        await ac.resume();
      } catch {
        /* resume rejected outside a gesture — the next gesture retries */
      } finally {
        this.resuming = false;
      }
    }
    if (this.wantTrack && !this.music.track) this.music.setTrack(this.wantTrack);
  }

  play(id: SfxId, opts?: { position?: Vector3; volume?: number; rate?: number }): void {
    const p = opts?.position;
    this.playAt(id, p ? p.x : Number.NaN, p ? p.y : 0, p ? p.z : 0, opts?.volume ?? 1, opts?.rate ?? 1);
  }

  /** Allocation-free entry used by the event bridge (positions arrive as tuples). */
  playAt(id: SfxId, x: number, y: number, z: number, volume = 1, rate = 1): void {
    const ac = this.ac;
    if (ac.state !== 'running' && !this.resuming) return;
    const r = SFX[id];
    if (!r) return;
    const now = ac.currentTime;
    const last = this.lastPlay.get(id) ?? -1;
    if ((now - last) * 1000 < r.minGapMs) return;
    let active = 0;
    for (const v of this.voices) if (v.id === id && v.endsAt > now) active++;
    if (active >= r.maxVoices) return;

    const spatial = !Number.isNaN(x);
    const voice = this.allocVoice(spatial, r.priority, now);
    if (!voice) return;
    this.lastPlay.set(id, now);

    let playRate = rate * (1 + (this.rng.next() * 2 - 1) * r.rateJitter);
    if (id === 'ink_pickup') {
      // consecutive pickups climb a pentatonic ladder — collecting a trail plays a little tune
      this.combo.idx = now - this.combo.last < 0.7 ? Math.min(PENTA.length - 1, this.combo.idx + 1) : 0;
      this.combo.last = now;
      playRate *= 2 ** (PENTA[this.combo.idx]! / 12);
    }

    if (spatial && voice.panner) this.setPannerPos(voice.panner, x, y, z, now);
    const start = voice.src ? now + 0.012 : now;
    if (voice.src) {
      // stolen: fast fade the old one
      voice.gain.gain.setTargetAtTime(0, now, 0.003);
      try {
        voice.src.stop(start);
      } catch {
        /* already stopped */
      }
    }
    voice.gain.gain.setValueAtTime(Math.max(0, volume), start);
    voice.id = id;
    voice.priority = r.priority;

    const sprite = this.sprites.get(id);
    if (sprite && this.spriteBuf) {
      const e = sprite[this.nextVariant(id, sprite.length)]!;
      const src = ac.createBufferSource();
      src.buffer = this.spriteBuf;
      src.playbackRate.value = playRate;
      src.connect(voice.gain);
      src.start(start, e.start, e.dur);
      voice.src = src;
      voice.endsAt = start + e.dur / playRate;
    } else {
      const list = this.baked.get(id);
      if (list?.length) {
        const b = list[this.nextVariant(id, list.length)]!;
        const src = ac.createBufferSource();
        src.buffer = b.buffer;
        src.playbackRate.value = playRate;
        src.connect(voice.gain);
        src.start(start);
        voice.src = src;
        voice.endsAt = start + b.buffer.duration / playRate;
      } else {
        // not baked yet: synthesize live straight into the voice (one-off cost, boot only)
        r.build({ ac, out: voice.gain, t: start, rng: this.rng }, 0);
        voice.gain.gain.setValueAtTime(Math.max(0, volume) * dbToGain(-8), start);
        voice.src = null;
        voice.endsAt = start + r.dur;
      }
    }
    if (r.duckDb) this.duckMusic(r.duckDb, Math.min(r.dur, 2.5));
  }

  loop(id: SfxId, opts?: { volume?: number }): () => void {
    const g = this.ac.createGain();
    g.gain.value = 0;
    g.connect(this.sfxBus);
    g.connect(this.sfxSend);
    const h: LoopHandle = { id, volume: opts?.volume ?? 1, gain: g, src: null, active: true };
    this.loops.push(h);
    this.startLoop(h);
    return () => {
      if (!h.active) return;
      h.active = false;
      const now = this.ac.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setTargetAtTime(0, now, 0.03);
      try {
        h.src?.stop(now + 0.2);
      } catch {
        /* not started */
      }
      setTimeout(() => g.disconnect(), 400);
      const i = this.loops.indexOf(h);
      if (i >= 0) this.loops.splice(i, 1);
    };
  }

  setMusic(track: 'title' | 'explore' | 'boss' | 'cover' | null): void {
    this.wantTrack = track;
    if (this.unlocked || this.ac.state === 'running') this.music.setTrack(track);
  }

  setIntensity(layer: 'explore' | 'combat' | 'boss', level: number): void {
    this.music.setIntensity(layer, level);
  }

  setListener(pos: Vector3, forward: Vector3): void {
    // Called every frame: skip the 9 AudioParam writes while the camera is still (menus,
    // panel cuts, pause) — each write is a timeline event the audio thread must process.
    const c = this.lastListener;
    if (
      Math.abs(c[0]! - pos.x) + Math.abs(c[1]! - pos.y) + Math.abs(c[2]! - pos.z) < 1e-3 &&
      Math.abs(c[3]! - forward.x) + Math.abs(c[4]! - forward.y) + Math.abs(c[5]! - forward.z) < 1e-4
    ) {
      return;
    }
    c[0] = pos.x;
    c[1] = pos.y;
    c[2] = pos.z;
    c[3] = forward.x;
    c[4] = forward.y;
    c[5] = forward.z;
    const l = this.ac.listener;
    // up = world Y orthogonalised against forward (the camera looks down at ~48°)
    let fx = forward.x;
    let fy = forward.y;
    let fz = forward.z;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    let ux = -fy * fx;
    let uy = 1 - fy * fy;
    let uz = -fy * fz;
    const ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-4) {
      ux = 0;
      uy = 0;
      uz = -1;
    } else {
      ux /= ul;
      uy /= ul;
      uz /= ul;
    }
    if (l.positionX) {
      const t = this.ac.currentTime;
      l.positionX.setValueAtTime(pos.x, t);
      l.positionY.setValueAtTime(pos.y, t);
      l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fx, t);
      l.forwardY.setValueAtTime(fy, t);
      l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(ux, t);
      l.upY.setValueAtTime(uy, t);
      l.upZ.setValueAtTime(uz, t);
    } else {
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void;
      };
      legacy.setPosition(pos.x, pos.y, pos.z);
      legacy.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  setVolumes(v: { master: number; music: number; sfx: number }): void {
    this.levels.master = v.master;
    this.levels.music = v.music;
    this.levels.sfx = v.sfx;
    this.applyVolumes(false);
  }

  suspend(): void {
    this.userSuspended = true;
    void this.ac.suspend().catch(() => {});
  }

  resume(): void {
    this.userSuspended = false;
    if (document.visibilityState !== 'hidden') void this.ac.resume().catch(() => {});
  }

  // ───────────────────────────── extras ─────────────────────────────

  /** Pause-menu treatment: music muffled and lowered, loops silenced; UI sfx still play. */
  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    const now = this.ac.currentTime;
    this.pauseLP.frequency.setTargetAtTime(p ? 650 : 20000, now, p ? 0.12 : 0.3);
    this.musicIn.gain.setTargetAtTime(p ? MUSIC_TRIM * dbToGain(-5) : MUSIC_TRIM, now, 0.2);
    for (const h of this.loops) h.gain.gain.setTargetAtTime(p ? 0 : h.volume, now, 0.05);
  }

  /** Momentary music duck (sidechain feel) for big moments. */
  duckMusic(db: number, holdS: number): void {
    const now = this.ac.currentTime;
    const d = this.duck.gain;
    d.cancelScheduledValues(now);
    d.setValueAtTime(d.value, now);
    d.setTargetAtTime(dbToGain(-db), now, 0.025);
    d.setTargetAtTime(1, now + holdS * 0.6, 0.45);
  }

  /** Lazily-created analyser on the master output (harness meters). */
  meter(): AnalyserNode {
    if (!this.analyser) {
      this.analyser = this.ac.createAnalyser();
      this.analyser.fftSize = 2048;
      this.limiter.connect(this.analyser);
    }
    return this.analyser;
  }

  get state(): AudioContextState {
    return this.ac.state;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const d of this.disposers) d();
    this.music.stopAll();
    void this.ac.close().catch(() => {});
  }

  // ───────────────────────────── internals ─────────────────────────────

  private applyVolumes(immediate: boolean): void {
    const g = busGains(this.levels);
    const now = this.ac.currentTime;
    const set = (p: AudioParam, v: number) =>
      immediate ? p.setValueAtTime(v, now) : p.setTargetAtTime(v, now, 0.05);
    set(this.master.gain, g.master);
    set(this.musicBus.gain, g.music);
    set(this.sfxBus.gain, g.sfx);
  }

  private allocVoice(spatial: boolean, priority: number, now: number): Voice | null {
    const lo = spatial ? 0 : SPATIAL_VOICES;
    const hi = spatial ? SPATIAL_VOICES : this.voices.length;
    let victim: Voice | null = null;
    for (let i = lo; i < hi; i++) {
      const v = this.voices[i]!;
      if (v.endsAt <= now) {
        v.src = null;
        return v;
      }
      if (v.priority <= priority && (!victim || v.priority < victim.priority || v.endsAt < victim.endsAt))
        victim = v;
    }
    return victim;
  }

  private setPannerPos(p: PannerNode, x: number, y: number, z: number, t: number): void {
    if (p.positionX) {
      p.positionX.setValueAtTime(x, t);
      p.positionY.setValueAtTime(y, t);
      p.positionZ.setValueAtTime(z, t);
    } else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }

  private nextVariant(id: SfxId, n: number): number {
    // round-robin with a random skip so the order never feels mechanical
    const i = ((this.rr.get(id) ?? 0) + 1 + (n > 2 && this.rng.chance(0.3) ? 1 : 0)) % n;
    this.rr.set(id, i);
    return i;
  }

  private startLoop(h: LoopHandle): void {
    if (!h.active || h.src) return;
    const ac = this.ac;
    const sprite = this.sprites.get(h.id)?.[0];
    const baked = this.baked.get(h.id)?.[0];
    if (!sprite && !baked) return; // started by bakeAll() once ready
    const src = ac.createBufferSource();
    if (sprite && this.spriteBuf) {
      src.buffer = this.spriteBuf;
      src.loop = true;
      src.loopStart = sprite.start;
      src.loopEnd = sprite.start + sprite.dur;
      src.connect(h.gain);
      src.start(ac.currentTime, sprite.start);
    } else if (baked) {
      src.buffer = baked.buffer;
      src.loop = true;
      src.connect(h.gain);
      src.start(ac.currentTime);
    }
    h.src = src;
    const now = ac.currentTime;
    h.gain.gain.setValueAtTime(0, now);
    h.gain.gain.setTargetAtTime(this.paused ? 0 : h.volume, now, 0.03);
  }

  private async bakeAll(
    onBaked: AudioEngineOptions['onBaked'],
    sprite: SpriteManifest | null,
  ): Promise<void> {
    const sr = this.ac.sampleRate;
    if (sprite)
      await this.loadSprite(sprite).catch((e) => console.warn('[audio] sprite failed, using synth', e));
    const kit = bakeKit(sr).then((k) => this.music.setKit(k));
    for (const id of BAKE_ORDER) {
      if (this.sprites.has(id)) continue;
      const r = SFX[id];
      const list: BakedSfx[] = [];
      for (let v = 0; v < r.variants; v++) {
        const b = await bakeRecipe(id, v, sr);
        list.push(b);
        onBaked?.(b);
      }
      this.baked.set(id, list);
      for (const h of this.loops) if (h.id === id) this.startLoop(h);
    }
    for (const id of SFX_IDS)
      if (!this.baked.has(id) && !this.sprites.has(id)) console.warn(`[audio] no sound for ${id}`);
    await kit;
  }

  private async loadSprite(m: SpriteManifest): Promise<void> {
    const canPlay: CanPlay = (mime) => document.createElement('audio').canPlayType(mime);
    const base = import.meta.env.BASE_URL;
    for (const file of pickFormats(m.files, canPlay)) {
      try {
        const res = await fetch(base + file);
        if (!res.ok) throw new Error(`${res.status}`);
        const buf = await this.ac.decodeAudioData(await res.arrayBuffer());
        this.sprites = normalizeSprites(m, buf.duration);
        this.spriteBuf = buf;
        return;
      } catch (e) {
        console.warn(`[audio] ${file} not decodable, trying next format`, e);
      }
    }
    throw new Error('no decodable sprite');
  }

  private installLifecycle(): void {
    if (typeof document === 'undefined') return;
    const ac = this.ac;
    const onVis = () => {
      if (document.visibilityState === 'hidden') void ac.suspend().catch(() => {});
      else if (!this.userSuspended && this.unlocked) void ac.resume().catch(() => {});
    };
    // A context resumed by any later gesture picks up the track that was requested meanwhile.
    const onState = () => {
      if (ac.state === 'running' && this.wantTrack && !this.music.track) this.music.setTrack(this.wantTrack);
    };
    ac.addEventListener('statechange', onState);
    // First touch, iOS "interrupted" (call, Siri, app switch) or a refused resume(): every
    // activation-triggering gesture retries. unlock()'s synchronous part runs inside the gesture.
    const onGesture = () => {
      if (!this.userSuspended && ac.state !== 'running' && document.visibilityState !== 'hidden') {
        void this.unlock();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    addEventListener('pagehide', onVis);
    addEventListener('pageshow', onVis);
    for (const e of ACTIVATION_EVENTS) addEventListener(e, onGesture, true);
    this.disposers.push(() => {
      document.removeEventListener('visibilitychange', onVis);
      removeEventListener('pagehide', onVis);
      removeEventListener('pageshow', onVis);
      ac.removeEventListener('statechange', onState);
      for (const e of ACTIVATION_EVENTS) removeEventListener(e, onGesture, true);
    });
  }
}
