/**
 * Pure mixing math (no Web Audio dependency) — unit-tested in tests/unit/audio-mix.test.ts.
 */

export const MIN_DB = -96;

export function dbToGain(db: number): number {
  return db <= MIN_DB ? 0 : 10 ** (db / 20);
}

export function gainToDb(g: number): number {
  return g <= 0 ? MIN_DB : Math.max(MIN_DB, 20 * Math.log10(g));
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

/**
 * Settings slider (0..1) → linear gain. Square law: 0.5 ≈ -12 dB, which tracks perceived
 * loudness far better than a linear fader while still reaching true silence at 0.
 */
export function sliderToGain(s: number): number {
  const c = clamp01(s);
  return c * c;
}

export interface BusLevels {
  master: number;
  music: number;
  sfx: number;
}

/** Effective linear gain of the music and sfx buses after the master fader. */
export function busGains(v: BusLevels): { music: number; sfx: number; master: number } {
  const m = sliderToGain(v.master);
  return { master: m, music: sliderToGain(v.music), sfx: sliderToGain(v.sfx) };
}

/** Final per-voice gain: bus chain × per-sound mastering gain × call volume (all linear). */
export function voiceGain(levels: BusLevels, bus: 'music' | 'sfx', mastering: number, volume = 1): number {
  const g = busGains(levels);
  return g.master * g[bus] * mastering * Math.max(0, volume);
}

/** Equal-power crossfade weights for t in 0..1 (a fades out, b fades in). */
export function equalPower(t: number): [number, number] {
  const c = clamp01(t);
  return [Math.cos(c * Math.PI * 0.5), Math.sin(c * Math.PI * 0.5)];
}

/**
 * Smooth fade-in curve for layer intensity: the layer is silent at/below `start`, full at `full`.
 * Used to map a single 0..1 intensity onto several stems that enter one after another.
 */
export function layerLevel(intensity: number, start: number, full: number): number {
  if (full <= start) return intensity >= start ? 1 : 0;
  const t = clamp01((intensity - start) / (full - start));
  return t * t * (3 - 2 * t);
}

export function peak(data: Float32Array): number {
  let p = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]!);
    if (a > p) p = a;
  }
  return p;
}

/** Direct-form biquad applied in place (used for the K-weighting loudness filter). */
function biquad(x: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

/** ITU-R BS.1770 K-weighting coefficients for an arbitrary sample rate (bilinear design). */
function kWeight(x: Float32Array, fs: number): Float32Array {
  // Stage 1: high shelf (+4 dB @ ~1.68 kHz)
  {
    const f0 = 1681.974450955533;
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / fs);
    const Vh = 10 ** (G / 20);
    const Vb = Vh ** 0.4996667741545416;
    const a0 = 1 + K / Q + K * K;
    x = biquad(
      x,
      (Vh + (Vb * K) / Q + K * K) / a0,
      (2 * (K * K - Vh)) / a0,
      (Vh - (Vb * K) / Q + K * K) / a0,
      (2 * (K * K - 1)) / a0,
      (1 - K / Q + K * K) / a0,
    );
  }
  // Stage 2: RLB high-pass (~38 Hz)
  {
    const f0 = 38.13547087602444;
    const Q = 0.5003270373238773;
    const K = Math.tan((Math.PI * f0) / fs);
    const a0 = 1 + K / Q + K * K;
    x = biquad(x, 1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  }
  return x;
}

/**
 * Integrated loudness (LUFS) per BS.1770-4: K-weighting, 400 ms blocks with 75% overlap,
 * absolute gate -70 LUFS, relative gate -10 LU. Sounds shorter than one block are measured as a
 * single block (so short SFX still get a meaningful number). Returns MIN_DB for silence.
 */
export function integratedLoudness(channels: Float32Array[], fs: number): number {
  if (channels.length === 0 || channels[0]!.length === 0) return MIN_DB;
  const weighted = channels.map((c) => kWeight(c, fs));
  const n = weighted[0]!.length;
  const block = Math.min(n, Math.round(0.4 * fs));
  const hop = Math.max(1, Math.round(block / 4));
  const powers: number[] = [];
  for (let start = 0; start + block <= n; start += hop) {
    let sum = 0;
    for (const w of weighted) {
      let s = 0;
      for (let i = start; i < start + block; i++) s += w[i]! * w[i]!;
      sum += s / block;
    }
    powers.push(sum);
  }
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p);
  const abs = powers.filter((p) => p > 0 && lufs(p) > -70);
  if (abs.length === 0) return MIN_DB;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const relGate = lufs(mean(abs)) - 10;
  const rel = abs.filter((p) => lufs(p) > relGate);
  return lufs(mean(rel.length ? rel : abs));
}

/**
 * Mastering gain that brings a sound to `targetLufs` without exceeding `ceilingDb` true-ish peak.
 * Peak always wins (SFX ≤ -1 dBFS), so very transient sounds end up below target — intended.
 */
export function masteringGain(peakLin: number, lufs: number, targetLufs: number, ceilingDb = -1): number {
  if (peakLin <= 0 || lufs <= MIN_DB) return 1;
  const byPeak = dbToGain(ceilingDb) / peakLin;
  const byLoud = dbToGain(targetLufs - lufs);
  return Math.min(byPeak, byLoud);
}

/**
 * Offline lookahead peak limiter (in place). Gain = release-smoothed( box_L( minHold_L(required) ) ),
 * which provably never lets a sample exceed the ceiling while ramping over the lookahead window
 * (no clicks). Used by the bake so punchy sounds can reach their loudness target.
 * Returns the maximum gain reduction applied, in dB (≤ 0).
 */
export function limitInPlace(
  channels: Float32Array[],
  fs: number,
  ceilingDb = -1,
  lookaheadMs = 1.5,
  releaseMs = 60,
): number {
  if (channels.length === 0) return 0;
  const n = channels[0]!.length;
  const c = dbToGain(ceilingDb);
  const L = Math.max(1, Math.round((lookaheadMs / 1000) * fs));
  const req = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (const ch of channels) a = Math.max(a, Math.abs(ch[i]!));
    const r = a > c ? c / a : 1;
    if (r < 1) any = true;
    req[i] = r;
  }
  if (!any) return 0;
  // min-hold over [i, i+L)
  const hold = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 1;
    const end = Math.min(n, i + L);
    for (let k = i; k < end; k++) if (req[k]! < m) m = req[k]!;
    hold[i] = m;
  }
  // box average over (i-L, i]  + release smoothing
  const rel = 1 - Math.exp(-1 / ((releaseMs / 1000) * fs));
  let acc = 0;
  let prev = 1;
  let minG = 1;
  for (let i = 0; i < n; i++) {
    acc += hold[i]!;
    if (i >= L) acc -= hold[i - L]!;
    const box = i >= L ? acc / L : (acc + (L - 1 - i)) / L;
    const g = Math.min(box, prev + (1 - prev) * rel);
    prev = g;
    if (g < minG) minG = g;
    for (const ch of channels) ch[i]! *= g;
  }
  // float safety: the bound is exact in reals; clamp rounding residue
  for (const ch of channels)
    for (let i = 0; i < n; i++) if (Math.abs(ch[i]!) > c) ch[i] = Math.sign(ch[i]!) * c;
  return gainToDb(minG);
}
