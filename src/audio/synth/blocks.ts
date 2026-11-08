/** Reusable synthesis gestures shared by the SFX bank and the music kit. */
import { chain, crackle, env, filter, gain, noise, osc, pan, perc, play, type Synth, warmWave } from './dsp';

// ───────────────────────────── building blocks ─────────────────────────────

/** Bubble-resonance droplet: sine whose pitch rises sharply (that's what a real drop does). */
export function droplet(s: Synth, dest: AudioNode, t: number, f0: number, amp: number, decay = 0.07): void {
  const o = osc(s, 'sine', f0, t, decay * 3);
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f0 * 2.4, t + decay * 0.6);
  const g = gain(s, 0);
  perc(g.gain, t, 0.0015, decay, amp);
  chain(o, g, dest);
}

/** Pitch-dropping sine body (thud, kick, impact). */
export function thump(
  s: Synth,
  dest: AudioNode,
  t: number,
  f0: number,
  f1: number,
  decay: number,
  amp: number,
): void {
  const o = osc(s, 'sine', f0, t, decay * 2.5);
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + decay * 0.7);
  const g = gain(s, 0);
  perc(g.gain, t, 0.002, decay, amp);
  chain(o, g, dest);
}

/** Short filtered noise burst. */
export function burst(
  s: Synth,
  dest: AudioNode,
  t: number,
  type: BiquadFilterType,
  freq: number,
  q: number,
  decay: number,
  amp: number,
  kind: 'white' | 'pink' | 'brown' = 'white',
): void {
  const n = noise(s, kind, t, decay * 2.5);
  const f = filter(s, type, freq, q);
  const g = gain(s, 0);
  perc(g.gain, t, 0.001, decay, amp);
  chain(n, f, g, dest);
}

/** Crackle buffer through a band — paper fibres. Returns the gain so callers can shape it. */
export function paper(
  s: Synth,
  dest: AudioNode,
  t: number,
  dur: number,
  density: (u: number) => number,
  band: [number, number],
  amp: number,
  burstMs: [number, number] = [0.3, 2.5],
): GainNode {
  const b = crackle(s.ac, dur, s.rng, density, { minMs: burstMs[0], maxMs: burstMs[1] });
  const src = play(s, b, t);
  const hp = filter(s, 'highpass', band[0], 0.7);
  const lp = filter(s, 'lowpass', band[1], 0.7);
  const g = gain(s, amp);
  chain(src, hp, lp, g, dest);
  return g;
}

/**
 * Paper tear "rrrrip": fibre snaps accelerate while the band rises; a thin noise bed glues the
 * snaps into one continuous rip.
 */
export function tear(
  s: Synth,
  dest: AudioNode,
  t: number,
  dur: number,
  lo: number,
  hi: number,
  amp: number,
  density: [number, number] = [500, 2200],
): void {
  const b = crackle(s.ac, dur, s.rng, (u) => density[0] + (density[1] - density[0]) * u ** 0.7, {
    minMs: 0.2,
    maxMs: 1.6,
  });
  const src = play(s, b, t);
  const bp = filter(s, 'bandpass', lo, 0.8);
  env(bp.frequency, t, lo, [[dur, hi, 'exp']]);
  const g = gain(s, 0);
  env(g.gain, t, 0, [
    [0.012, amp],
    [dur * 0.85, amp * 0.9],
    [dur, 0],
  ]);
  chain(src, bp, g, dest);
  // bed
  const n = noise(s, 'white', t, dur);
  const bp2 = filter(s, 'bandpass', lo * 1.4, 1.2);
  env(bp2.frequency, t, lo * 1.4, [[dur, hi * 1.2, 'exp']]);
  const g2 = gain(s, 0);
  env(g2.gain, t, 0, [
    [0.02, amp * 0.18],
    [dur * 0.85, amp * 0.22],
    [dur, 0],
  ]);
  chain(n, bp2, g2, dest);
}

/** Bell partial cluster (crystal magic, rewards). */
export function bell(s: Synth, dest: AudioNode, t: number, f: number, amp: number, decay: number): void {
  const parts: [number, number, number][] = [
    [1, 1, 1],
    [2.756, 0.32, 0.55],
    [5.404, 0.12, 0.3],
  ];
  for (const [ratio, a, d] of parts) {
    const o = osc(s, 'sine', f * ratio, t, decay * d * 2);
    const g = gain(s, 0);
    perc(g.gain, t, 0.002, decay * d, amp * a);
    chain(o, g, dest);
  }
}

/** Brass-ish voice: two detuned warm saws through an opening low-pass. */
export function brass(
  s: Synth,
  dest: AudioNode,
  t: number,
  f: number,
  dur: number,
  amp: number,
  bright = 3200,
  attack = 0.04,
): void {
  const lp = filter(s, 'lowpass', 300, 1.4);
  env(lp.frequency, t, 280, [
    [attack * 1.5, bright, 'exp'],
    [attack * 1.5 + 0.35, bright * 0.45, 'exp'],
  ]);
  const g = gain(s, 0);
  env(g.gain, t, 0, [
    [attack, amp],
    [Math.max(attack + 0.01, dur - 0.08), amp * 0.75],
    [dur + 0.25, 0],
  ]);
  for (const det of [-6, 5]) {
    const o = s.ac.createOscillator();
    o.setPeriodicWave(warmWave(s.ac, 1.05, 40));
    o.frequency.value = f;
    o.detune.value = det;
    // delayed vibrato
    const lfo = osc(s, 'sine', 5.2, t, dur + 0.3);
    const lg = gain(s, 0);
    env(lg.gain, t, 0, [
      [Math.min(0.35, dur * 0.5), 0],
      [dur, 9],
    ]);
    chain(lfo, lg);
    lg.connect(o.detune);
    o.start(t);
    o.stop(t + dur + 0.35);
    o.connect(lp);
  }
  chain(lp, g, dest);
}

/** Back-and-forth graphite strokes. Returns the stroke list for callers that sync layers. */
export function strokes(
  s: Synth,
  dest: AudioNode,
  t: number,
  dur: number,
  opts: { len: [number, number]; gap: [number, number]; band: number; amp: number; grit: number },
): void {
  const n = noise(s, 'white', t, dur);
  const bp = filter(s, 'bandpass', opts.band, 1.1);
  const hs = filter(s, 'highshelf', 6000, 0.7, -6);
  const g = gain(s, 0);
  const grit = crackle(s.ac, dur, s.rng, () => 1800, { minMs: 0.15, maxMs: 0.8 });
  const gs = play(s, grit, t);
  const gg = gain(s, opts.grit);
  chain(gs, gg, bp);
  chain(n, bp, hs, g, dest);
  g.gain.setValueAtTime(0, t);
  bp.frequency.setValueAtTime(opts.band, t);
  let x = t + 0.02;
  const end = t + dur - 0.03;
  let dir = 1;
  while (x < end) {
    const len = Math.min(s.rng.range(opts.len[0], opts.len[1]), end - x);
    if (len < 0.03) break;
    const a = opts.amp * s.rng.range(0.6, 1);
    // stroke: fast in, pressure wobble, fast out; band brightens mid-stroke (speed)
    g.gain.setValueAtTime(0, x);
    g.gain.linearRampToValueAtTime(a, x + 0.012);
    g.gain.linearRampToValueAtTime(a * s.rng.range(0.7, 1), x + len * 0.6);
    g.gain.linearRampToValueAtTime(0, x + len);
    const f0 = opts.band * (dir > 0 ? 0.85 : 1.05);
    bp.frequency.setValueAtTime(f0, x);
    bp.frequency.linearRampToValueAtTime(f0 * 1.35, x + len * 0.5);
    bp.frequency.linearRampToValueAtTime(f0, x + len);
    dir = -dir;
    x += len + s.rng.range(opts.gap[0], opts.gap[1]);
  }
  g.gain.setValueAtTime(0, end);
}

/** Pre-baked granular cloud: Hann-windowed grains of `src` scattered over [t, t+dur]. */
export function grains(
  s: Synth,
  dest: AudioNode,
  src: AudioBuffer,
  t: number,
  dur: number,
  count: number,
  opts: { size: [number, number]; rate: [number, number]; amp: (u: number) => number; stereo?: boolean },
): void {
  for (let i = 0; i < count; i++) {
    const u = i / count;
    const gt = t + u * dur + s.rng.range(-0.01, 0.01);
    const size = s.rng.range(opts.size[0], opts.size[1]);
    const b = s.ac.createBufferSource();
    b.buffer = src;
    b.playbackRate.value = s.rng.range(opts.rate[0], opts.rate[1]);
    const g = gain(s, 0);
    const a = opts.amp(u);
    g.gain.setValueAtTime(0, gt);
    g.gain.linearRampToValueAtTime(a, gt + size * 0.5);
    g.gain.linearRampToValueAtTime(0, gt + size);
    b.start(gt, s.rng.range(0, Math.max(0, src.duration - size * 2)));
    b.stop(gt + size + 0.01);
    if (opts.stereo) chain(b, g, pan(s, s.rng.range(-0.8, 0.8)), dest);
    else chain(b, g, dest);
  }
}
