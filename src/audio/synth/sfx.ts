/**
 * Procedural SFX bank — one recipe per SfxId. Recipes build a node graph on any
 * BaseAudioContext; the engine bakes each variant once through OfflineAudioContext, masters it
 * (peak ≤ -1 dBFS, loudness to `lufs`) and plays the buffers from a voice pool.
 *
 * Sound language: everything in INKWAKE is paper, graphite and wet ink. Paper = crackle
 * (impulsive micro-bursts), ink = resonant droplets + low-passed splats, magic = soft bell partials
 * in D (the score's key), so SFX sit inside the music instead of on top of it.
 */
import type { SfxId } from '../../core/types';
import { bell, brass, burst, droplet, grains, paper, strokes, tear, thump } from './blocks';
import {
  chain,
  crackle,
  env,
  filter,
  gain,
  makeBuffer,
  midiToHz,
  noise,
  osc,
  pan,
  perc,
  type Rng,
  type Synth,
  shaper,
  warmWave,
} from './dsp';

export interface SfxRecipe {
  /** Rendered length in seconds (tail included). */
  dur: number;
  /** Bake in stereo (non-spatial showcase sounds). Mono otherwise. */
  stereo?: boolean;
  /** Distinct baked takes; the engine round-robins with random rate jitter on top. */
  variants: number;
  /** Integrated loudness target (LUFS); peak ceiling -1 dBFS always wins. */
  lufs: number;
  /** Max transient gain reduction the mastering limiter may apply (dB, default 6). */
  maxGrDb?: number;
  /** Seamless loop (envelope reaches zero at both ends). */
  loop?: boolean;
  /** Voice-steal priority 0..10 (higher survives). */
  priority: number;
  /** Max simultaneous voices of this id. */
  maxVoices: number;
  /** Drop re-triggers closer than this (ms) — stops machine-gun phasing. */
  minGapMs: number;
  /** ± playback rate jitter applied per play. */
  rateJitter: number;
  /** Duck the music bus by this many dB while it plays (big moments). */
  duckDb?: number;
  build(s: Synth, variant: number): void;
}

export const D = (oct: number, semis = 0) => midiToHz(14 + oct * 12 + semis); // D in octave `oct`

// ───────────────────────────── recipes ─────────────────────────────

export const SFX: Record<SfxId, SfxRecipe> = {
  crystal_on: {
    dur: 1.3,
    variants: 2,
    lufs: -17,
    priority: 8,
    maxVoices: 2,
    minGapMs: 120,
    rateJitter: 0.02,
    build(s, v) {
      const { t, out } = s;
      // wet ink "shhhh" blooming outwards
      const n = noise(s, 'pink', t, 1.2);
      const bp = filter(s, 'bandpass', 900, 0.9);
      env(bp.frequency, t, 900, [
        [0.18, 3600, 'exp'],
        [1.1, 2200, 'exp'],
      ]);
      const g = gain(s, 0);
      env(g.gain, t, 0, [[0.07, 0.75]]);
      g.gain.setTargetAtTime(0, t + 0.12, 0.28);
      chain(n, bp, g, out);
      const sss = noise(s, 'white', t, 0.9);
      const hp = filter(s, 'highpass', 6500, 0.7);
      const g2 = gain(s, 0);
      env(g2.gain, t, 0, [[0.05, 0.12]]);
      g2.gain.setTargetAtTime(0, t + 0.08, 0.18);
      chain(sss, hp, g2, out);
      // ink gurgle — droplets spreading
      for (let i = 0; i < 6; i++)
        droplet(s, out, t + 0.02 + s.rng.range(0, 0.4), s.rng.range(500, 1100), 0.16);
      // magic shimmer: D-A-D-F# bell partials, gentle tremolo
      const notes = v === 0 ? [D(6), D(6, 7), D(7), D(7, 4)] : [D(6), D(6, 7), D(7), D(7, 7)];
      const sh = gain(s, 0.5);
      const trem = osc(s, 'sine', 7.5, t, 1.3);
      const tg = gain(s, 0.25);
      chain(trem, tg);
      tg.connect(sh.gain);
      notes.forEach((f, i) => {
        bell(s, sh, t + 0.03 + i * 0.045, f, 0.2, 0.9);
      });
      sh.connect(out);
      // activation whomp (rising)
      const w = osc(s, 'sine', 70, t, 0.5);
      w.frequency.setValueAtTime(70, t);
      w.frequency.exponentialRampToValueAtTime(150, t + 0.25);
      const wg = gain(s, 0);
      env(wg.gain, t, 0, [
        [0.06, 0.5],
        [0.35, 0],
      ]);
      chain(w, wg, out);
    },
  },

  crystal_off: {
    dur: 0.8,
    variants: 2,
    lufs: -19,
    priority: 7,
    maxVoices: 2,
    minGapMs: 120,
    rateJitter: 0.02,
    build(s) {
      const { t, out } = s;
      const n = noise(s, 'pink', t, 0.7);
      const bp = filter(s, 'bandpass', 3200, 1);
      env(bp.frequency, t, 3200, [[0.5, 500, 'exp']]);
      const g = gain(s, 0);
      env(g.gain, t, 0, [[0.02, 0.6]]);
      g.gain.setTargetAtTime(0, t + 0.04, 0.12);
      chain(n, bp, g, out);
      for (const [f, d] of [
        [D(7), 0],
        [D(6, 7), 0.04],
      ] as const) {
        const o = osc(s, 'sine', f, t + d, 0.6);
        o.frequency.setValueAtTime(f, t + d);
        o.frequency.exponentialRampToValueAtTime(f * 0.5, t + d + 0.45);
        const og = gain(s, 0);
        perc(og.gain, t + d, 0.004, 0.4, 0.14);
        chain(o, og, out);
      }
      thump(s, out, t + 0.03, 170, 70, 0.12, 0.35);
    },
  },

  bolt_fire: {
    dur: 0.32,
    variants: 4,
    lufs: -18,
    maxGrDb: 9,
    priority: 6,
    maxVoices: 4,
    minGapMs: 40,
    rateJitter: 0.06,
    build(s) {
      const { t, out } = s;
      // ink flick "fwip"
      const n = noise(s, 'white', t, 0.2);
      const bp = filter(s, 'bandpass', 6500, 1.6);
      env(bp.frequency, t, 6500, [[0.11, 1100, 'exp']]);
      const g = gain(s, 0);
      perc(g.gain, t, 0.004, 0.12, 0.55);
      chain(n, bp, g, out);
      // tonal zap
      const o = osc(s, 'triangle', 1300, t, 0.15);
      o.frequency.setValueAtTime(s.rng.range(1200, 1450), t);
      o.frequency.exponentialRampToValueAtTime(330, t + 0.08);
      const og = gain(s, 0);
      perc(og.gain, t, 0.002, 0.08, 0.22);
      chain(o, og, out);
      // wet release — tiny droplets trailing the bolt
      droplet(s, out, t + 0.025, s.rng.range(900, 1300), 0.1, 0.05);
      droplet(s, out, t + 0.06, s.rng.range(1300, 1900), 0.06, 0.04);
      thump(s, out, t, 220, 90, 0.05, 0.25);
    },
  },

  bolt_hit: {
    dur: 0.5,
    variants: 4,
    lufs: -16,
    priority: 6,
    maxVoices: 4,
    minGapMs: 35,
    rateJitter: 0.07,
    build(s) {
      const { t, out } = s;
      thump(s, out, t, 190, 52, 0.13, 0.85);
      // splat: dense wet crackle + low-passed burst
      const sp = paper(s, out, t, 0.12, (u) => 4500 * (1 - u), [500, 5000], 0.0, [0.2, 1]);
      env(sp.gain, t, 0.55, [[0.1, 0]]);
      burst(s, out, t, 'lowpass', 2400, 0.8, 0.09, 0.55, 'pink');
      // paper crunch of the ghost
      const cr = paper(s, out, t + 0.01, 0.12, () => 900, [1800, 7000], 0.3, [0.3, 2]);
      env(cr.gain, t + 0.01, 0.35, [[0.12, 0]]);
      // spray droplets
      const k = s.rng.int(3, 5);
      for (let i = 0; i < k; i++)
        droplet(s, out, t + s.rng.range(0.03, 0.22), s.rng.range(900, 2300), 0.09, 0.04);
    },
  },

  dash: {
    dur: 0.55,
    variants: 3,
    lufs: -18,
    priority: 6,
    maxVoices: 2,
    minGapMs: 80,
    rateJitter: 0.05,
    build(s) {
      const { t, out } = s;
      const n = noise(s, 'pink', t, 0.5);
      const bp = filter(s, 'bandpass', 350, 1.4);
      env(bp.frequency, t, 350, [
        [0.14, s.rng.range(1700, 2200), 'exp'],
        [0.45, 500, 'exp'],
      ]);
      const g = gain(s, 0);
      env(g.gain, t, 0, [
        [0.1, 0.9],
        [0.42, 0],
      ]);
      chain(n, bp, g, out);
      const air = noise(s, 'white', t, 0.4);
      const hp = filter(s, 'highpass', 4200, 0.7);
      const ag = gain(s, 0);
      env(ag.gain, t, 0, [
        [0.08, 0.14],
        [0.3, 0],
      ]);
      chain(air, hp, ag, out);
      // cloak flap — fabric/paper flutter
      const fl = paper(s, out, t + 0.04, 0.25, (u) => 260 * Math.sin(Math.PI * u) + 20, [900, 5000], 0.35);
      env(fl.gain, t + 0.04, 0.35, [[0.25, 0]]);
      // ink smear trail
      droplet(s, out, t + 0.18, s.rng.range(500, 700), 0.08, 0.06);
    },
  },

  ghost_reveal: {
    dur: 1.0,
    variants: 3,
    lufs: -19,
    priority: 5,
    maxVoices: 3,
    minGapMs: 90,
    rateJitter: 0.05,
    build(s) {
      const { t, out } = s;
      // paper rustle: crinkles swelling and settling
      const r = paper(
        s,
        out,
        t,
        0.9,
        (u) => 30 + 420 * Math.sin(Math.PI * Math.min(1, u * 1.4)) ** 2,
        [1500, 9000],
        0.55,
      );
      r.gain.setValueAtTime(0.55, t);
      const bed = noise(s, 'pink', t, 0.9);
      const bp = filter(s, 'bandpass', 2600, 0.8);
      const bg = gain(s, 0);
      env(bg.gain, t, 0, [
        [0.2, 0.09],
        [0.85, 0],
      ]);
      chain(bed, bp, bg, out);
      // ghostly "ooo" breath, descending
      const w = noise(s, 'pink', t, 0.95);
      const f1 = filter(s, 'bandpass', 480, 9);
      const f2 = filter(s, 'bandpass', 900, 9);
      const base = s.rng.range(0.9, 1.15);
      env(f1.frequency, t, 520 * base, [[0.9, 360 * base, 'exp']]);
      env(f2.frequency, t, 980 * base, [[0.9, 700 * base, 'exp']]);
      const wg = gain(s, 0);
      env(wg.gain, t, 0, [
        [0.3, 1.1],
        [0.9, 0],
      ]);
      w.connect(f1);
      w.connect(f2);
      f1.connect(wg);
      f2.connect(wg);
      wg.connect(out);
    },
  },

  ghost_die: {
    dur: 0.9,
    variants: 3,
    lufs: -16,
    priority: 6,
    maxVoices: 3,
    minGapMs: 60,
    rateJitter: 0.05,
    build(s) {
      const { t, out } = s;
      const len = s.rng.range(0.28, 0.4);
      tear(s, out, t, len, 1300, 4200, 0.7);
      // ink poof as the ghost collapses
      thump(s, out, t, 140, 60, 0.15, 0.55);
      burst(s, out, t + 0.01, 'lowpass', 1300, 0.7, 0.18, 0.45, 'brown');
      // crumple settle
      const c = paper(s, out, t + len, 0.35, (u) => 300 * (1 - u) + 10, [1200, 7000], 0.35);
      c.gain.setValueAtTime(0.35, t + len);
    },
  },

  player_hurt: {
    dur: 0.8,
    variants: 3,
    lufs: -15,
    maxGrDb: 9,
    priority: 9,
    maxVoices: 1,
    minGapMs: 150,
    rateJitter: 0.03,
    duckDb: 4,
    build(s) {
      const { t, out } = s;
      // a page of the hero tears — lower, heavier than a ghost
      tear(s, out, t + 0.01, s.rng.range(0.3, 0.38), 750, 2600, 0.85, [700, 2600]);
      thump(s, out, t, 120, 45, 0.18, 0.9);
      burst(s, out, t, 'bandpass', 900, 1.2, 0.05, 0.4);
      // dissonant sting (minor 2nd) — damage reads by ear, not only colour
      for (const f of [D(5), D(5, 1)]) {
        const o = osc(s, 'triangle', f, t + 0.02, 0.45);
        const g = gain(s, 0);
        perc(g.gain, t + 0.02, 0.005, 0.35, 0.12);
        chain(o, g, out);
      }
    },
  },

  ink_pickup: {
    dur: 0.45,
    variants: 2,
    lufs: -19,
    priority: 4,
    maxVoices: 4,
    minGapMs: 25,
    rateJitter: 0,
    build(s, v) {
      const { t, out } = s;
      droplet(s, out, t, 620, 0.5, 0.06);
      droplet(s, out, t + 0.05, 930, 0.32, 0.05);
      bell(s, out, t + 0.03, v === 0 ? D(6) : D(6, 7), 0.22, 0.32);
    },
  },

  sketch_loop: {
    dur: 2.4,
    variants: 1,
    lufs: -21,
    loop: true,
    priority: 5,
    maxVoices: 2,
    minGapMs: 0,
    rateJitter: 0,
    build(s) {
      const { t, out } = s;
      strokes(s, out, t, 2.4, { len: [0.07, 0.17], gap: [0.005, 0.04], band: 3800, amp: 0.7, grit: 0.25 });
      // paper friction under the tip
      const n = noise(s, 'pink', t, 2.4);
      const bp = filter(s, 'bandpass', 900, 0.8);
      const g = gain(s, 0);
      env(g.gain, t, 0, [
        [0.05, 0.06],
        [2.33, 0.06],
        [2.38, 0],
      ]);
      chain(n, bp, g, out);
    },
  },

  sketch_done: {
    dur: 1.2,
    variants: 2,
    lufs: -15,
    priority: 8,
    maxVoices: 1,
    minGapMs: 200,
    rateJitter: 0.02,
    duckDb: 3,
    build(s, v) {
      const { t, out } = s;
      // stamp mechanism click, then the rubber lands
      burst(s, out, t, 'highpass', 3000, 0.7, 0.006, 0.5);
      thump(s, out, t + 0.012, 150, 52, 0.2, 1);
      burst(s, out, t + 0.012, 'bandpass', 320, 2, 0.07, 0.8, 'pink');
      const body = osc(s, 'triangle', 230, t + 0.012, 0.15);
      const bg = gain(s, 0);
      perc(bg.gain, t + 0.012, 0.002, 0.08, 0.25);
      chain(body, bg, out);
      // ink suction on lift "schlup"
      const n = noise(s, 'pink', t + 0.2, 0.15);
      const bp = filter(s, 'bandpass', 600, 3);
      env(bp.frequency, t + 0.2, 600, [[0.08, 2200, 'exp']]);
      const ng = gain(s, 0);
      perc(ng.gain, t + 0.2, 0.01, 0.08, 0.35);
      chain(n, bp, ng, out);
      // reward: perfect fifth, bright
      bell(s, out, t + 0.1, D(6), 0.2, 0.9);
      bell(s, out, t + 0.16, v === 0 ? D(6, 7) : D(7), 0.16, 0.9);
    },
  },

  page_turn: {
    dur: 1.1,
    stereo: true,
    variants: 2,
    lufs: -17,
    priority: 8,
    maxVoices: 1,
    minGapMs: 300,
    rateJitter: 0.02,
    build(s) {
      const { t, out } = s;
      const p = pan(s, 0.6);
      if ('pan' in p) env((p as StereoPannerNode).pan, t, 0.6, [[0.75, -0.6]]);
      p.connect(out);
      // lift: crinkle at the corner
      const lift = paper(s, p, t, 0.2, (u) => 400 * (1 - u) + 50, [1500, 8000], 0.5);
      lift.gain.setValueAtTime(0.5, t);
      // swoosh with flutter
      const n = noise(s, 'pink', t + 0.08, 0.65);
      const bp = filter(s, 'bandpass', 800, 1.1);
      env(bp.frequency, t + 0.08, 800, [
        [0.3, 2600, 'exp'],
        [0.6, 700, 'exp'],
      ]);
      const g = gain(s, 0);
      env(g.gain, t + 0.08, 0, [
        [0.22, 0.8],
        [0.58, 0],
      ]);
      const fl = osc(s, 'sine', 16, t + 0.08, 0.6);
      env(fl.frequency, t + 0.08, 22, [[0.55, 9]]);
      const fg = gain(s, 0.35);
      chain(fl, fg);
      fg.connect(g.gain);
      chain(n, bp, g, p);
      // flap down
      burst(s, p, t + 0.62, 'lowpass', 1400, 0.8, 0.08, 0.6, 'pink');
      thump(s, p, t + 0.62, 110, 60, 0.07, 0.3);
      const settle = paper(s, p, t + 0.64, 0.4, (u) => 220 * (1 - u) + 5, [1500, 7000], 0.3);
      settle.gain.setValueAtTime(0.3, t + 0.64);
    },
  },

  step_grass: {
    dur: 0.18,
    variants: 6,
    lufs: -25,
    priority: 2,
    maxVoices: 3,
    minGapMs: 70,
    rateJitter: 0.08,
    build(s) {
      const { t, out } = s;
      const c = paper(s, out, t, 0.1, (u) => 1400 * (1 - u), [700, 4200], 0.5, [0.3, 1.5]);
      env(c.gain, t, 0.5, [[0.1, 0]]);
      burst(s, out, t, 'bandpass', s.rng.range(1200, 1900), 0.9, 0.05, 0.3, 'pink');
      thump(s, out, t, 95, 60, 0.04, 0.35);
    },
  },

  step_stone: {
    dur: 0.15,
    variants: 6,
    lufs: -25,
    priority: 2,
    maxVoices: 3,
    minGapMs: 70,
    rateJitter: 0.08,
    build(s) {
      const { t, out } = s;
      burst(s, out, t, 'highpass', 1800, 0.7, 0.004, 0.6);
      burst(s, out, t, 'bandpass', s.rng.range(2200, 3200), 3, 0.02, 0.3);
      thump(s, out, t, 130, 75, 0.045, 0.55);
      const g = paper(s, out, t + 0.005, 0.05, () => 1500, [2500, 9000], 0.22, [0.15, 0.6]);
      env(g.gain, t + 0.005, 0.22, [[0.05, 0]]);
    },
  },

  eraser_sweep: {
    dur: 1.8,
    variants: 1,
    lufs: -16,
    loop: true,
    priority: 8,
    maxVoices: 1,
    minGapMs: 0,
    rateJitter: 0,
    build(s) {
      const { t, out } = s;
      const dur = 1.8;
      // two big rubbing strokes; stick-slip AM gives the rubbery judder
      const n = noise(s, 'pink', t, dur);
      const bp = filter(s, 'bandpass', 520, 1.1);
      const am = gain(s, 0.55);
      const ss = osc(s, 'sawtooth', 32, t, dur);
      env(ss.frequency, t, 28, [
        [0.45, 41],
        [0.9, 26],
        [1.35, 43],
        [1.8, 28],
      ]);
      const ssg = gain(s, 0.45);
      chain(ss, ssg);
      ssg.connect(am.gain);
      const g = gain(s, 0);
      env(g.gain, t, 0, [
        [0.08, 0.9],
        [0.8, 0.75],
        [0.9, 0.35],
        [1.0, 0.9],
        [1.7, 0.75],
        [1.79, 0],
      ]);
      env(bp.frequency, t, 420, [
        [0.45, 700, 'exp'],
        [0.9, 430, 'exp'],
        [1.35, 720, 'exp'],
        [1.8, 420, 'exp'],
      ]);
      chain(n, bp, am, g, out);
      // rubber squeal resonance
      const sq = noise(s, 'white', t, dur);
      const r = filter(s, 'bandpass', 1150, 14);
      const rg = gain(s, 0.0);
      env(rg.gain, t, 0, [
        [0.4, 0.5],
        [0.88, 0],
        [1.3, 0.55],
        [1.78, 0],
      ]);
      chain(sq, r, rg, out);
      // weight of a giant eraser
      const w = noise(s, 'brown', t, dur);
      const lp = filter(s, 'lowpass', 160, 0.9);
      const wg = gain(s, 0);
      env(wg.gain, t, 0, [
        [0.1, 0.9],
        [1.7, 0.9],
        [1.79, 0],
      ]);
      chain(w, lp, wg, out);
      // crumbs of erased graphite
      const cr = paper(s, out, t + 0.05, dur - 0.12, () => 160, [2000, 8000], 0.3);
      cr.gain.setValueAtTime(0.3, t + 0.05);
    },
  },

  boss_roar: {
    dur: 2.9,
    stereo: true,
    variants: 2,
    lufs: -13,
    priority: 10,
    maxVoices: 1,
    minGapMs: 800,
    rateJitter: 0.03,
    duckDb: 8,
    build(s, v) {
      const { t, out } = s;
      const L = 2.5;
      const pitch = v === 0 ? 1 : 0.89;
      // growl: detuned fifth through a drive and a moving vowel
      const pre = gain(s, 0.6);
      const roughness = osc(s, 'sine', 23, t, L);
      env(roughness.frequency, t, 18, [[L, 31]]);
      const rgn = gain(s, 0.45);
      chain(roughness, rgn);
      const am = gain(s, 0.6);
      rgn.connect(am.gain);
      for (const [f, det] of [
        [55, 0],
        [55, 14],
        [82.4, -8],
      ] as const) {
        const o = s.ac.createOscillator();
        o.setPeriodicWave(warmWave(s.ac, 0.9, 48));
        o.detune.value = det;
        const fp = f * pitch;
        env(o.frequency, t, fp * 0.8, [
          [0.35, fp * 1.3, 'exp'],
          [1.8, fp * 1.2, 'exp'],
          [L, fp * 0.7, 'exp'],
        ]);
        const vib = osc(s, 'sine', 5.5, t, L);
        const vg = gain(s, fp * 0.05);
        chain(vib, vg);
        vg.connect(o.frequency);
        o.start(t);
        o.stop(t + L + 0.1);
        o.connect(pre);
      }
      const drive = shaper(s, 3.5);
      chain(pre, am, drive);
      const vowel = gain(s, 0);
      env(vowel.gain, t, 0, [
        [0.25, 1],
        [1.9, 0.9],
        [L, 0],
      ]);
      const formants: [number, number, number, number][] = [
        [730, 420, 6, 1],
        [1090, 820, 7, 0.6],
        [2440, 2300, 8, 0.25],
      ];
      for (const [fa, fo, q, a] of formants) {
        const bp = filter(s, 'bandpass', fa, q);
        env(bp.frequency, t, fa * 0.9, [
          [0.5, fa, 'exp'],
          [L, fo, 'exp'],
        ]);
        const g = gain(s, a * 2.2);
        chain(drive, bp, g, vowel);
      }
      const low = filter(s, 'lowpass', 400, 0.7);
      const lg = gain(s, 0.55);
      chain(drive, low, lg, vowel);
      const growlPan = pan(s, 0);
      chain(vowel, growlPan, out);
      // granular layer: torn-paper / breath grains thrown across the stereo field
      const tearBuf = crackle(s.ac, 0.6, s.rng, () => 1600, { minMs: 0.2, maxMs: 2 });
      const tb = tearBuf.getChannelData(0);
      const nb = makeBuffer(
        s.ac,
        0.6,
        (i) => tb[i]! * 0.8 + (Math.sin(i * 0.013) * 0.5 + 0.5) * (s.rng.next() * 2 - 1) * 0.25,
      );
      const gbus = gain(s, 1);
      const gbp = filter(s, 'bandpass', 1800, 0.6);
      chain(gbus, gbp, out);
      grains(s, gbus, nb, t + 0.05, L - 0.2, 140, {
        size: [0.04, 0.12],
        rate: [0.45, 1.2],
        amp: (u) => 0.5 * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.7,
        stereo: true,
      });
      // breath / exhale
      const br = noise(s, 'pink', t, L);
      const brf = filter(s, 'lowpass', 1100, 0.7);
      const brg = gain(s, 0);
      env(brg.gain, t, 0, [
        [0.3, 0.4],
        [L, 0],
      ]);
      chain(br, brf, brg, out);
      // sub
      const sub = osc(s, 'sine', 38 * pitch, t, L);
      const sg = gain(s, 0);
      env(sg.gain, t, 0, [
        [0.3, 0.7],
        [1.9, 0.6],
        [L, 0],
      ]);
      chain(sub, sg, out);
    },
  },

  panel_stinger: {
    dur: 1.9,
    stereo: true,
    variants: 2,
    lufs: -14,
    priority: 9,
    maxVoices: 1,
    minGapMs: 300,
    rateJitter: 0,
    duckDb: 7,
    build(s, v) {
      const { t, out } = s;
      // orchestral hit: D minor (v0) / D sus with b6 colour (v1)
      const chord =
        v === 0 ? [D(3), D(3, 7), D(4), D(4, 3), D(4, 7)] : [D(3), D(3, 7), D(4), D(4, 5), D(4, 8)];
      const hit = gain(s, 1);
      chord.forEach((f, i) => {
        const p = pan(s, (i / (chord.length - 1)) * 1.2 - 0.6);
        brass(s, p, t, f, 0.18, 0.2, 4800, 0.006);
        p.connect(hit);
      });
      const hitEnv = gain(s, 1);
      env(hitEnv.gain, t, 1, [[0.2, 0.7]]);
      hitEnv.gain.setTargetAtTime(0, t + 0.2, 0.25);
      chain(hit, hitEnv, out);
      // timpani
      thump(s, out, t, D(2) * 1.04, D(2), 1.3, 0.8);
      burst(s, out, t, 'lowpass', 900, 1, 0.12, 0.4, 'pink');
      // crash cymbal: metallic square cluster + noise
      const cym = gain(s, 0);
      perc(cym.gain, t, 0.002, 1.6, 0.18);
      const hp = filter(s, 'highpass', 6000, 0.7);
      for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) {
        const o = osc(s, 'square', f * 1.7, t, 1.8);
        o.connect(hp);
      }
      const cn = noise(s, 'white', t, 1.8);
      const cng = gain(s, 2);
      chain(cn, cng, hp);
      const cp = pan(s, 0.35);
      chain(hp, cym, cp, out);
      // ink splash on the panel
      const sp = paper(s, out, t, 0.1, (u) => 5000 * (1 - u), [600, 6000], 0.45, [0.2, 1]);
      env(sp.gain, t, 0.45, [[0.1, 0]]);
      burst(s, out, t, 'highpass', 2500, 0.7, 0.008, 0.6);
    },
  },

  ui_click: {
    dur: 0.1,
    variants: 3,
    lufs: -23,
    priority: 7,
    maxVoices: 2,
    minGapMs: 30,
    rateJitter: 0.03,
    build(s) {
      const { t, out } = s;
      burst(s, out, t, 'bandpass', s.rng.range(2800, 3500), 1.6, 0.012, 0.7);
      const o = osc(s, 'sine', 1500, t, 0.06);
      o.frequency.setValueAtTime(s.rng.range(1450, 1600), t);
      o.frequency.exponentialRampToValueAtTime(1000, t + 0.03);
      const g = gain(s, 0);
      perc(g.gain, t, 0.001, 0.035, 0.35);
      chain(o, g, out);
      thump(s, out, t, 300, 160, 0.02, 0.2);
    },
  },

  ui_hover: {
    dur: 0.06,
    variants: 3,
    lufs: -30,
    priority: 1,
    maxVoices: 1,
    minGapMs: 45,
    rateJitter: 0.04,
    build(s) {
      const { t, out } = s;
      const o = osc(s, 'sine', 2400, t, 0.04);
      o.frequency.setValueAtTime(s.rng.range(2300, 2600), t);
      const g = gain(s, 0);
      perc(g.gain, t, 0.002, 0.02, 0.3);
      chain(o, g, out);
      burst(s, out, t, 'highpass', 5000, 0.7, 0.006, 0.15);
    },
  },

  fanfare: {
    dur: 4.6,
    stereo: true,
    variants: 1,
    lufs: -15,
    priority: 10,
    maxVoices: 1,
    minGapMs: 1000,
    rateJitter: 0,
    duckDb: 18,
    build(s) {
      const { t, out } = s;
      // the INKWAKE motif, now in D major: A A A | D — F# E | A (held over the tonic)
      const mel: [number, number, number][] = [
        [0, D(4, 7), 0.13],
        [0.16, D(4, 7), 0.13],
        [0.32, D(4, 7), 0.13],
        [0.48, D(5), 0.42],
        [0.95, D(5, 4), 0.2],
        [1.18, D(5, 2), 0.2],
        [1.42, D(5, 7), 2.4],
      ];
      const lead = pan(s, 0.12);
      lead.connect(out);
      for (const [dt, f, d] of mel) {
        brass(s, lead, t + dt, f, d, 0.32, 4200, 0.03);
        bell(s, out, t + dt, f * 2, 0.08, 0.8);
      }
      // harmony: second trumpet a third below on the climb, then the full chord
      const harm = pan(s, -0.3);
      harm.connect(out);
      brass(s, harm, t + 0.48, D(4, 9), 0.42, 0.2, 3000);
      brass(s, harm, t + 0.95, D(5), 0.2, 0.18, 3000);
      brass(s, harm, t + 1.18, D(4, 11), 0.2, 0.18, 3000);
      const chord = [D(2), D(3), D(3, 7), D(4), D(4, 4)];
      chord.forEach((f, i) => {
        const p = pan(s, (i / (chord.length - 1)) * 1.4 - 0.7);
        p.connect(out);
        brass(s, p, t + 1.42, f, 2.4, 0.16, 2200, 0.12);
      });
      // timpani roll into the downbeat
      for (let k = 0; k < 14; k++) {
        const kt = t + 0.85 + k * 0.04;
        thump(s, out, kt, D(2) * 1.02, D(2), 0.12, 0.12 + k * 0.025);
      }
      thump(s, out, t + 1.42, D(2) * 1.04, D(2), 1.6, 0.9);
      // cymbal bloom
      const n = noise(s, 'white', t + 1.42, 2.8);
      const hp = filter(s, 'highpass', 7000, 0.7);
      const cg = gain(s, 0);
      perc(cg.gain, t + 1.42, 0.01, 2.4, 0.22);
      chain(n, hp, cg, out);
      // pencil flourish: the artist signs the cover
      const sig = gain(s, 0.5);
      sig.connect(out);
      strokes(s, sig, t + 2.3, 0.7, { len: [0.05, 0.12], gap: [0, 0.02], band: 4200, amp: 0.4, grit: 0.2 });
    },
  },

  scribble_fire: {
    dur: 0.5,
    variants: 3,
    lufs: -18,
    maxGrDb: 9,
    priority: 6,
    maxVoices: 3,
    minGapMs: 60,
    rateJitter: 0.05,
    build(s) {
      const { t, out } = s;
      // frantic angry scribble
      strokes(s, out, t, 0.32, { len: [0.025, 0.05], gap: [0, 0.008], band: 3000, amp: 0.85, grit: 0.4 });
      // launched graphite dart
      const o = osc(s, 'triangle', 900, t + 0.28, 0.15);
      o.frequency.setValueAtTime(950, t + 0.28);
      o.frequency.exponentialRampToValueAtTime(320, t + 0.38);
      const g = gain(s, 0);
      perc(g.gain, t + 0.28, 0.003, 0.09, 0.3);
      chain(o, g, out);
      burst(s, out, t + 0.28, 'bandpass', 4200, 1.5, 0.05, 0.4);
    },
  },

  blot_drain: {
    dur: 1.1,
    variants: 2,
    lufs: -18,
    priority: 6,
    maxVoices: 2,
    minGapMs: 200,
    rateJitter: 0.04,
    build(s) {
      const { t, out } = s;
      // slurp: resonant low-pass sweeping down over brown noise
      const n = noise(s, 'brown', t, 1);
      const lp = filter(s, 'lowpass', 900, 9);
      env(lp.frequency, t, 1100, [[0.85, 170, 'exp']]);
      const g = gain(s, 0);
      env(g.gain, t, 0, [
        [0.08, 0.8],
        [0.7, 0.6],
        [0.95, 0],
      ]);
      chain(n, lp, g, out);
      // bubbles, sinking in pitch
      for (let i = 0; i < 9; i++) {
        const u = i / 9;
        droplet(s, out, t + u * 0.8 + s.rng.range(0, 0.06), 520 - u * 300 + s.rng.range(-40, 40), 0.22, 0.07);
      }
      const sub = osc(s, 'sine', 70, t, 1);
      env(sub.frequency, t, 80, [[0.9, 42, 'exp']]);
      const sg = gain(s, 0);
      env(sg.gain, t, 0, [
        [0.2, 0.45],
        [0.95, 0],
      ]);
      chain(sub, sg, out);
    },
  },
};

export const SFX_IDS = Object.keys(SFX) as SfxId[];

/** Order the boot bake works in: what the first seconds of play need, first. */
export const BAKE_ORDER: SfxId[] = [
  'ui_click',
  'ui_hover',
  'crystal_on',
  'crystal_off',
  'step_grass',
  'step_stone',
  'bolt_fire',
  'bolt_hit',
  'ghost_reveal',
  'ghost_die',
  'ink_pickup',
  'dash',
  'player_hurt',
  'panel_stinger',
  'scribble_fire',
  'sketch_loop',
  'sketch_done',
  'page_turn',
  'blot_drain',
  'eraser_sweep',
  'boss_roar',
  'fanfare',
];

export type { Rng };
