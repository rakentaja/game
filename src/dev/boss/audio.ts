/**
 * DEV HARNESS ONLY — tiny procedural Web Audio stand-in for the audio workstream so the fight has
 * weight in the harness (roar, eraser rub, hits, a boss drone that follows intensity).
 */
import type * as THREE from 'three';
import type { AudioAPI, SfxId } from '../../core/types';

type Voice = {
  kind: 'noise' | 'saw' | 'sine' | 'square';
  f: number;
  f2?: number;
  dur: number;
  q?: number;
  gain: number;
  lp?: number;
};
const BANK: Partial<Record<SfxId, Voice[]>> = {
  boss_roar: [
    { kind: 'saw', f: 70, f2: 42, dur: 1.6, gain: 0.35, lp: 600 },
    { kind: 'saw', f: 104, f2: 61, dur: 1.4, gain: 0.2, lp: 900 },
    { kind: 'noise', f: 400, dur: 1.5, gain: 0.25, q: 0.7 },
  ],
  eraser_sweep: [{ kind: 'noise', f: 1300, dur: 0.6, gain: 0.3, q: 1.4 }],
  scribble_fire: [{ kind: 'noise', f: 3000, f2: 1800, dur: 0.25, gain: 0.22, q: 4 }],
  bolt_fire: [{ kind: 'sine', f: 880, f2: 330, dur: 0.12, gain: 0.18 }],
  bolt_hit: [
    { kind: 'noise', f: 600, dur: 0.15, gain: 0.35, q: 1 },
    { kind: 'sine', f: 160, f2: 60, dur: 0.18, gain: 0.3 },
  ],
  ghost_die: [{ kind: 'noise', f: 2400, f2: 600, dur: 0.4, gain: 0.3, q: 2 }],
  player_hurt: [{ kind: 'noise', f: 1800, f2: 400, dur: 0.35, gain: 0.35, q: 3 }],
  dash: [{ kind: 'noise', f: 500, f2: 2500, dur: 0.25, gain: 0.25, q: 1.5 }],
  sketch_loop: [{ kind: 'noise', f: 3500, dur: 0.5, gain: 0.12, q: 6 }],
  sketch_done: [
    { kind: 'sine', f: 140, f2: 70, dur: 0.25, gain: 0.5 },
    { kind: 'noise', f: 300, dur: 0.1, gain: 0.3, q: 1 },
  ],
  page_turn: [{ kind: 'noise', f: 900, f2: 2600, dur: 0.6, gain: 0.3, q: 1.2 }],
  blot_drain: [{ kind: 'sine', f: 300, f2: 120, dur: 0.2, gain: 0.25 }],
  fanfare: [
    { kind: 'square', f: 392, dur: 0.25, gain: 0.08 },
    { kind: 'square', f: 523, dur: 0.6, gain: 0.08 },
  ],
};

export class StubAudio implements AudioAPI {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private drone: { g: GainNode; o: OscillatorNode[] } | null = null;
  private level = 0;

  async unlock(): Promise<void> {
    if (this.ac) return;
    try {
      this.ac = new AudioContext();
      this.master = this.ac.createGain();
      this.master.gain.value = 0.6;
      const comp = this.ac.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ac.destination);
      const n = this.ac.sampleRate * 2;
      this.noise = this.ac.createBuffer(1, n, this.ac.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    } catch {
      this.ac = null;
    }
  }

  private voice(v: Voice, rate: number, vol: number, loop = false): AudioScheduledSourceNode | null {
    const ac = this.ac;
    if (!ac || !this.master) return null;
    const t = ac.currentTime;
    const g = ac.createGain();
    const dur = v.dur / rate;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v.gain * vol, t + 0.015);
    if (!loop) g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let src: AudioScheduledSourceNode;
    let out: AudioNode = g;
    if (v.kind === 'noise') {
      const s = ac.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      const f = ac.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = v.q ?? 1;
      f.frequency.setValueAtTime(v.f * rate, t);
      if (v.f2) f.frequency.exponentialRampToValueAtTime(v.f2 * rate, t + dur);
      s.connect(f).connect(g);
      src = s;
    } else {
      const o = ac.createOscillator();
      o.type = v.kind === 'saw' ? 'sawtooth' : v.kind;
      o.frequency.setValueAtTime(v.f * rate, t);
      if (v.f2) o.frequency.exponentialRampToValueAtTime(v.f2 * rate, t + dur);
      if (v.lp) {
        const f = ac.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = v.lp;
        o.connect(f).connect(g);
      } else o.connect(g);
      src = o;
    }
    out.connect(this.master);
    out = g;
    src.start(t);
    if (!loop) src.stop(t + dur + 0.05);
    return src;
  }

  play(id: SfxId, opts?: { position?: THREE.Vector3; volume?: number; rate?: number }): void {
    const vs = BANK[id];
    if (!vs) return;
    for (const v of vs) this.voice(v, opts?.rate ?? 1, opts?.volume ?? 1);
  }

  loop(id: SfxId, opts?: { volume?: number }): () => void {
    const vs = BANK[id];
    if (!vs || !this.ac) return () => {};
    const srcs = vs.map((v) => this.voice(v, 1, opts?.volume ?? 1, true));
    return () => {
      for (const s of srcs)
        try {
          s?.stop();
        } catch {
          /* already stopped */
        }
    };
  }

  setMusic(track: 'title' | 'explore' | 'boss' | 'cover' | null): void {
    const ac = this.ac;
    if (!ac || !this.master) return;
    if (track === 'boss' && !this.drone) {
      const g = ac.createGain();
      g.gain.value = 0;
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 380;
      const o = [55, 82.4, 110.5].map((f) => {
        const x = ac.createOscillator();
        x.type = 'sawtooth';
        x.frequency.value = f;
        x.connect(lp);
        x.start();
        return x;
      });
      lp.connect(g).connect(this.master);
      this.drone = { g, o };
      this.setIntensity('boss', this.level);
    } else if (track !== 'boss' && this.drone) {
      for (const x of this.drone.o) x.stop();
      this.drone = null;
    }
  }
  setIntensity(_layer: 'explore' | 'combat' | 'boss', level: number): void {
    this.level = level;
    if (this.drone && this.ac)
      this.drone.g.gain.setTargetAtTime(0.03 + level * 0.07, this.ac.currentTime, 0.6);
  }
  setListener(): void {}
  setVolumes(): void {}
  suspend(): void {
    void this.ac?.suspend();
  }
  resume(): void {
    void this.ac?.resume();
  }
}
