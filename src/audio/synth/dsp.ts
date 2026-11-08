/**
 * Tiny synthesis toolkit shared by the SFX bank and the music instruments. Works on any
 * BaseAudioContext (live or Offline), so every recipe can be baked once or played live.
 */

/** Mulberry32 — deterministic per-variant randomness so baked SFX are reproducible. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Approximately gaussian (sum of 3 uniforms), mean 0, sd ≈ 1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }
}

export type NoiseKind = 'white' | 'pink' | 'brown';

const noiseCache = new WeakMap<BaseAudioContext, Record<NoiseKind, AudioBuffer>>();

/** 3 s looping noise buffers, created once per context. */
export function noiseBank(ac: BaseAudioContext): Record<NoiseKind, AudioBuffer> {
  let bank = noiseCache.get(ac);
  if (bank) return bank;
  const len = Math.floor(ac.sampleRate * 3);
  const rng = new Rng(0x1c0ffee);
  const mk = (fill: (d: Float32Array) => void) => {
    const b = ac.createBuffer(1, len, ac.sampleRate);
    fill(b.getChannelData(0));
    return b;
  };
  bank = {
    white: mk((d) => {
      for (let i = 0; i < d.length; i++) d[i] = rng.next() * 2 - 1;
    }),
    pink: mk((d) => {
      // Paul Kellet's refined pink filter
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = rng.next() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }),
    brown: mk((d) => {
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        last = (last + 0.02 * (rng.next() * 2 - 1)) / 1.02;
        d[i] = last * 3.5;
      }
    }),
  };
  noiseCache.set(ac, bank);
  return bank;
}

/** Everything a recipe needs. `t` is the start time, `out` the destination. */
export interface Synth {
  ac: BaseAudioContext;
  out: AudioNode;
  t: number;
  rng: Rng;
}

export function gain(s: Synth, value = 1): GainNode {
  const g = s.ac.createGain();
  g.gain.value = value;
  return g;
}

export function filter(
  s: Synth,
  type: BiquadFilterType,
  freq: number,
  q = Math.SQRT1_2,
  gainDb = 0,
): BiquadFilterNode {
  const f = s.ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gainDb;
  return f;
}

export function osc(s: Synth, type: OscillatorType, freq: number, t: number, dur: number): OscillatorNode {
  const o = s.ac.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

export function noise(s: Synth, kind: NoiseKind, t: number, dur: number, rate = 1): AudioBufferSourceNode {
  const src = s.ac.createBufferSource();
  src.buffer = noiseBank(s.ac)[kind];
  src.loop = true;
  src.playbackRate.value = rate;
  src.start(t, s.rng.range(0, 2.5));
  src.stop(t + dur + 0.05);
  return src;
}

/** Play a raw buffer once. */
export function play(s: Synth, buffer: AudioBuffer, t: number, rate = 1): AudioBufferSourceNode {
  const src = s.ac.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  src.start(t);
  return src;
}

/** Wire nodes in series; returns the last. */
export function chain<T extends AudioNode>(...nodes: [...AudioNode[], T]): T {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i]!.connect(nodes[i + 1]!);
  return nodes[nodes.length - 1] as T;
}

/**
 * Breakpoint envelope. points: [timeOffset, value, 'lin' | 'exp' | 'set'] relative to t.
 * Exponential ramps clamp to 1e-4 so they can reach "zero".
 */
export function env(
  p: AudioParam,
  t: number,
  start: number,
  points: [number, number, ('lin' | 'exp')?][],
): void {
  p.cancelScheduledValues(t);
  p.setValueAtTime(start, t);
  for (const [dt, v, kind] of points) {
    if (kind === 'exp') p.exponentialRampToValueAtTime(Math.max(1e-4, v), t + dt);
    else p.linearRampToValueAtTime(v, t + dt);
  }
}

/** Percussive amp envelope: linear attack, exponential decay to silence. */
export function perc(p: AudioParam, t: number, attack: number, decay: number, peakV = 1): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peakV, t + attack);
  p.setTargetAtTime(0, t + attack, decay / 4.6);
}

const shaperCache = new WeakMap<BaseAudioContext, Map<number, Float32Array<ArrayBuffer>>>();

/** tanh soft clipper, `drive` ≥ 1. Curves are cached per context. */
export function shaper(s: Synth, drive: number): WaveShaperNode {
  let m = shaperCache.get(s.ac);
  if (!m) {
    m = new Map();
    shaperCache.set(s.ac, m);
  }
  const key = Math.round(drive * 10);
  let curve = m.get(key);
  if (!curve) {
    curve = new Float32Array(1024);
    const norm = Math.tanh(drive);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * drive) / norm;
    }
    m.set(key, curve);
  }
  const w = s.ac.createWaveShaper();
  w.curve = curve;
  w.oversample = '2x';
  return w;
}

/** Stereo panner if available (offline stereo bakes), otherwise a pass-through gain. */
export function pan(s: Synth, value: number): AudioNode {
  if (typeof s.ac.createStereoPanner === 'function') {
    const p = s.ac.createStereoPanner();
    p.pan.value = value;
    return p;
  }
  return gain(s, 1);
}

/** Build a mono buffer by evaluating fn per sample. */
export function makeBuffer(
  ac: BaseAudioContext,
  dur: number,
  fn: (i: number, t: number, d: Float32Array) => number,
): AudioBuffer {
  const len = Math.max(1, Math.floor(dur * ac.sampleRate));
  const b = ac.createBuffer(1, len, ac.sampleRate);
  const d = b.getChannelData(0);
  const inv = 1 / ac.sampleRate;
  for (let i = 0; i < len; i++) d[i] = fn(i, i * inv, d);
  return b;
}

/**
 * Crackle: sparse impulsive micro-bursts (paper fibres, crinkles, graphite grit).
 * density(tNorm) → events per second. Each event is a 0.3–3 ms decaying noise burst with
 * random polarity and amplitude. The core of every paper sound in the bank.
 */
export function crackle(
  ac: BaseAudioContext,
  dur: number,
  rng: Rng,
  density: (u: number) => number,
  opts: { minMs?: number; maxMs?: number; ampVar?: number } = {},
): AudioBuffer {
  const fs = ac.sampleRate;
  const len = Math.max(1, Math.floor(dur * fs));
  const b = ac.createBuffer(1, len, fs);
  const d = b.getChannelData(0);
  const minMs = opts.minMs ?? 0.3;
  const maxMs = opts.maxMs ?? 3;
  const ampVar = opts.ampVar ?? 1;
  let i = 0;
  while (i < len) {
    const rate = Math.max(1e-3, density(i / len));
    // exponential inter-arrival
    i += Math.max(1, Math.floor((-Math.log(1 - rng.next() * 0.999) / rate) * fs));
    if (i >= len) break;
    const blen = Math.floor(rng.range(minMs, maxMs) * 0.001 * fs);
    const amp = (1 - ampVar + ampVar * rng.next() ** 2) * (rng.chance(0.5) ? 1 : -1);
    const k = 5 / Math.max(1, blen);
    for (let j = 0; j < blen && i + j < len; j++) {
      d[i + j]! += amp * Math.exp(-j * k) * (rng.next() * 2 - 1);
    }
  }
  return b;
}

export function midiToHz(m: number): number {
  return 440 * 2 ** ((m - 69) / 12);
}

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();

/** Band-limited "warm saw": saw harmonics rolled off by 1/n^tilt, optional odd-only (hollow). */
export function warmWave(ac: BaseAudioContext, tilt = 1.25, harmonics = 32, oddOnly = false): PeriodicWave {
  let m = waveCache.get(ac);
  if (!m) {
    m = new Map();
    waveCache.set(ac, m);
  }
  const key = `${tilt}|${harmonics}|${oddOnly}`;
  let w = m.get(key);
  if (!w) {
    const re = new Float32Array(harmonics + 1);
    const im = new Float32Array(harmonics + 1);
    for (let n = 1; n <= harmonics; n++) {
      if (oddOnly && n % 2 === 0) continue;
      im[n] = 1 / n ** tilt;
    }
    w = ac.createPeriodicWave(re, im);
    m.set(key, w);
  }
  return w;
}

/** Synthetic room impulse response: decorrelated stereo noise, exponential decay, HF damping. */
export function impulseResponse(
  ac: BaseAudioContext,
  seconds: number,
  decay: number,
  preDelay = 0.012,
): AudioBuffer {
  const fs = ac.sampleRate;
  const len = Math.floor(seconds * fs);
  const b = ac.createBuffer(2, len, fs);
  const rng = new Rng(0xbeef);
  const pre = Math.floor(preDelay * fs);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const u = (i - pre) / (len - pre);
      // damping: later tail gets darker (one-pole coefficient grows with time)
      const a = 0.15 + 0.8 * u;
      lp = lp * a + (rng.next() * 2 - 1) * (1 - a);
      const early = i - pre < fs * 0.06 && rng.chance(0.004) ? (rng.next() * 2 - 1) * 2 : 0;
      d[i] = (lp * 1.6 + early) * Math.exp(-u * decay) * (1 - Math.exp(-(i - pre) / (fs * 0.004)));
    }
  }
  return b;
}
