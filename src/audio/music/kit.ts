/**
 * Music percussion & texture kit, baked once per context. Peak-normalised (-1 dBFS); tracks set
 * the balance through note velocities.
 */

import { bakeRecipe } from '../synth/bake';
import { burst, paper, strokes, thump } from '../synth/blocks';
import { chain, env, filter, gain, noise, osc, perc } from '../synth/dsp';
import type { SfxRecipe } from '../synth/sfx';

export type KitId =
  | 'taikoLow'
  | 'taikoHi'
  | 'frame'
  | 'shaker'
  | 'stick'
  | 'boom'
  | 'pencil'
  | 'hatch'
  | 'rustle'
  | 'swell'
  | 'pin';

const base = { lufs: 0, priority: 0, maxVoices: 0, minGapMs: 0, rateJitter: 0 } as const;

export const KIT: Record<KitId, SfxRecipe> = {
  taikoLow: {
    ...base,
    dur: 1.1,
    variants: 2,
    build(s) {
      const { t, out } = s;
      thump(s, out, t, 95, 52, 0.75, 1);
      burst(s, out, t, 'lowpass', 600, 1, 0.09, 0.55, 'pink');
      // skin slap
      burst(s, out, t, 'bandpass', 1800, 1.2, 0.012, 0.25);
    },
  },
  taikoHi: {
    ...base,
    dur: 0.6,
    variants: 2,
    build(s) {
      const { t, out } = s;
      thump(s, out, t, 210, 140, 0.32, 0.9);
      burst(s, out, t, 'bandpass', 900, 1.4, 0.05, 0.45, 'pink');
      burst(s, out, t, 'highpass', 2500, 0.7, 0.008, 0.3);
    },
  },
  frame: {
    ...base,
    dur: 0.4,
    variants: 3,
    build(s) {
      const { t, out } = s;
      thump(s, out, t, 160, 115, 0.18, 0.7);
      burst(s, out, t, 'bandpass', s.rng.range(500, 700), 1.5, 0.08, 0.5, 'pink');
      // jingles of a riq, very faint
      const j = paper(s, out, t, 0.12, (u) => 2500 * (1 - u), [5000, 12000], 0.12, [0.2, 0.8]);
      env(j.gain, t, 0.12, [[0.12, 0]]);
    },
  },
  shaker: {
    ...base,
    dur: 0.14,
    variants: 3,
    build(s) {
      const { t, out } = s;
      const n = noise(s, 'white', t, 0.12);
      const hp = filter(s, 'bandpass', s.rng.range(6500, 8000), 0.9);
      const g = gain(s, 0);
      env(g.gain, t, 0, [
        [0.025, 0.7],
        [0.11, 0],
      ]);
      chain(n, hp, g, out);
    },
  },
  stick: {
    ...base,
    dur: 0.12,
    variants: 2,
    build(s) {
      const { t, out } = s;
      burst(s, out, t, 'bandpass', 2400, 4, 0.03, 0.8);
      const o = osc(s, 'triangle', 820, t, 0.06);
      const g = gain(s, 0);
      perc(g.gain, t, 0.001, 0.03, 0.4);
      chain(o, g, out);
    },
  },
  boom: {
    ...base,
    dur: 2.6,
    variants: 1,
    build(s) {
      const { t, out } = s;
      thump(s, out, t, 70, 33, 2.2, 1);
      burst(s, out, t, 'lowpass', 350, 0.9, 0.5, 0.5, 'brown');
      const n = noise(s, 'pink', t, 2.4);
      const lp = filter(s, 'lowpass', 2200, 0.7);
      env(lp.frequency, t, 3000, [[2.2, 300, 'exp']]);
      const g = gain(s, 0);
      perc(g.gain, t, 0.005, 2.2, 0.25);
      chain(n, lp, g, out);
    },
  },
  /** One pencil scratch — the score's hi-hat. */
  pencil: {
    ...base,
    dur: 0.16,
    variants: 6,
    build(s) {
      strokes(s, s.out, s.t, 0.15, {
        len: [0.06, 0.11],
        gap: [0.2, 0.3],
        band: s.rng.range(3000, 4800),
        amp: 0.9,
        grit: 0.3,
      });
    },
  },
  /** Fast hatching phrase (4–6 strokes). */
  hatch: {
    ...base,
    dur: 0.62,
    variants: 3,
    build(s) {
      strokes(s, s.out, s.t, 0.6, {
        len: [0.05, 0.09],
        gap: [0.005, 0.03],
        band: 3600,
        amp: 0.8,
        grit: 0.25,
      });
    },
  },
  rustle: {
    ...base,
    dur: 1.6,
    variants: 2,
    build(s) {
      const r = paper(s, s.out, s.t, 1.5, (u) => 15 + 160 * Math.sin(Math.PI * u) ** 2, [1500, 8000], 0.8);
      r.gain.setValueAtTime(0.8, s.t);
    },
  },
  /** Reverse-cymbal style swell, 1.6 s, peaks at the end (lands on a downbeat). */
  swell: {
    ...base,
    dur: 1.7,
    variants: 1,
    build(s) {
      const { t, out } = s;
      const n = noise(s, 'white', t, 1.65);
      const hp = filter(s, 'highpass', 3000, 0.7);
      env(hp.frequency, t, 1500, [[1.6, 6000, 'exp']]);
      const g = gain(s, 0);
      env(g.gain, t, 0.0001, [
        [1.55, 0.8, 'exp'],
        [1.62, 0],
      ]);
      chain(n, hp, g, out);
    },
  },
  /** Music-box pin pluck transient (layered under music-box notes). */
  pin: {
    ...base,
    dur: 0.03,
    variants: 2,
    build(s) {
      burst(s, s.out, s.t, 'highpass', 4000, 0.7, 0.004, 0.6);
    },
  },
};

export type Kit = Record<KitId, AudioBuffer[]>;

/** Bake the whole kit (≈ 30 short buffers). */
export async function bakeKit(sampleRate: number): Promise<Kit> {
  const out = {} as Kit;
  for (const id of Object.keys(KIT) as KitId[]) {
    const r = KIT[id];
    const list: AudioBuffer[] = [];
    for (let v = 0; v < r.variants; v++) list.push((await bakeRecipe(`kit:${id}`, v, sampleRate, r)).buffer);
    out[id] = list;
  }
  return out;
}
