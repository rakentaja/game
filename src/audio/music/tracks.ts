/**
 * The INKWAKE score: four generative-but-composed tracks sharing one leitmotif
 * ("A A A | D — F E | D…", the crystal's call). Minor and modal while the page is unprinted,
 * Phrygian for the Editor, D major once the cover is printed.
 *
 * A track is a step function called once per 16th note with the audio time of that step. It
 * decides what to play from the bar/step position and the live intensities, so stems can fade
 * in and out without ever drifting off the grid.
 */
import { layerLevel } from '../mix';
import type { Instruments } from './instruments';

export type LayerName =
  | 'pad'
  | 'drone'
  | 'texture'
  | 'melody'
  | 'perc'
  | 'bass'
  | 'ostinato'
  | 'choir'
  | 'brass'
  | 'hats';

export const LAYERS: readonly LayerName[] = [
  'pad',
  'drone',
  'texture',
  'melody',
  'perc',
  'bass',
  'ostinato',
  'choir',
  'brass',
  'hats',
];

export interface Intensity {
  explore: number;
  combat: number;
  boss: number;
}

export interface StepCtx {
  /** Audio time of this 16th. */
  t: number;
  /** 16ths since the track started. */
  step: number;
  /** Bar within the loop, and 16th within the bar. */
  bar: number;
  s16: number;
  /** Completed loops. */
  loop: number;
  sec16: number;
  inst: Instruments;
  out: Record<LayerName, AudioNode>;
  int: Intensity;
  rnd(): number;
}

export interface TrackDef {
  bpm: number;
  loopBars: number;
  /** Reverb send per layer (0..1). */
  sends: Partial<Record<LayerName, number>>;
  /** Layers routed through the tempo-synced echo. */
  echo: LayerName[];
  drone?: number[];
  /** Write each layer's target gain for the given intensities (no allocation). */
  levels(i: Intensity, out: Record<LayerName, number>): void;
  step(c: StepCtx): void;
}

interface Chord {
  bar: number;
  bars: number;
  pad: number[];
  root: number;
}

function chordAt(prog: Chord[], bar: number): Chord {
  for (let i = prog.length - 1; i >= 0; i--) if (bar >= prog[i]!.bar) return prog[i]!;
  return prog[0]!;
}

type Phrase = [step: number, midi: number, vel?: number][];

function playPhrase(
  c: StepCtx,
  p: Phrase,
  origin: number,
  dest: AudioNode,
  vel: number,
  transpose = 0,
): void {
  // origin = global 16th at which the phrase started; fire notes that land on this step
  const rel = c.step - origin;
  for (const n of p) {
    if (n[0] === rel) c.inst.musicBox(dest, c.t, n[1] + transpose, vel * (n[2] ?? 1), 2.2);
  }
}

// MIDI helpers (D minor)
const A3 = 57;
const D4 = 62;
const F4 = 65;
const G4 = 67;
const A4 = 69;
const Bb4 = 70;
const B4 = 71;
const C5 = 72;
const Cs5 = 73;
const D5 = 74;
const E5 = 76;
const Eb5 = 75;
const F5 = 77;
const Fs4 = 66;
const Fs5 = 78;
const G5 = 79;

/** The leitmotif, 4 bars in D minor. */
const THEME: Phrase = [
  [0, A4],
  [2, A4, 0.8],
  [4, A4, 0.9],
  [6, D5, 1.1],
  [12, F5],
  [14, E5, 0.85],
  [16, D5, 1.05],
  [24, C5, 0.8],
  [28, A4],
  [32, Bb4],
  [36, A4, 0.8],
  [38, G4, 0.75],
  [40, F4, 0.8],
  [42, G4, 0.75],
  [44, A4, 0.95],
  [48, D4, 1],
];

/** Answer phrase, bars 5–8 of the title (ends on the A-major leading tension). */
const ANSWER: Phrase = [
  [0, D5],
  [4, C5, 0.8],
  [6, Bb4, 0.8],
  [8, A4, 1],
  [16, G4, 0.8],
  [18, A4, 0.8],
  [20, Bb4, 0.9],
  [32, A4],
  [36, Cs5, 0.9],
  [40, E5, 0.9],
  [44, G5, 1],
  [48, F5, 1.05],
  [52, E5, 0.9],
];

const major = (p: Phrase): Phrase =>
  p.map(([s, m, v]) => [s, m === F5 ? Fs5 : m === F4 ? Fs4 : m === C5 ? Cs5 : m === Bb4 ? B4 : m, v]);

// ───────────────────────────── EXPLORE ─────────────────────────────

const EXPLORE_PROG: Chord[] = [
  { bar: 0, bars: 2, pad: [50, 57, 64, 65], root: 38 }, // Dm(add9)
  { bar: 2, bars: 2, pad: [46, 53, 57, 62], root: 34 }, // Bbmaj7
  { bar: 4, bars: 2, pad: [53, 57, 60, 67], root: 41 }, // F(add9)
  { bar: 6, bars: 2, pad: [52, 57, 60, 67], root: 45 }, // Am7
  { bar: 8, bars: 2, pad: [50, 57, 62, 65], root: 38 }, // Dm
  { bar: 10, bars: 2, pad: [46, 50, 57, 62], root: 34 }, // Bbmaj7
  { bar: 12, bars: 2, pad: [55, 58, 62, 69], root: 43 }, // Gm9
  { bar: 14, bars: 1, pad: [57, 62, 64, 69], root: 45 }, // Asus4
  { bar: 15, bars: 1, pad: [57, 61, 64, 67], root: 45 }, // A7
];

const EXPLORE_PHRASES: Record<number, Phrase[]> = {
  0: [
    THEME.slice(0, 7),
    [
      [0, D4 + 12],
      [3, F5],
      [6, A4 + 12],
      [9, D5 + 12, 0.7],
    ],
  ],
  4: [
    [
      [0, F5],
      [3, E5, 0.8],
      [6, D5],
      [10, A4, 0.9],
    ],
    [
      [0, A4],
      [8, D5],
      [20, C5, 0.8],
    ],
  ],
  8: [ANSWER.slice(0, 7), THEME.slice(0, 7)],
  12: [
    [
      [0, A4],
      [8, D5],
      [20, C5, 0.8],
    ],
    [
      [0, G5, 0.8],
      [4, F5, 0.8],
      [8, D5],
      [16, E5, 0.9],
      [24, Cs5],
    ],
  ],
};

const FRAME = [1, 0, 0.4, 0, 0.7, 0, 0.4, 0.5, 0.9, 0, 0.4, 0, 0.7, 0.4, 0.6, 0.3];
const TAIKO_LO = [1, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0.6, 0, 0, 0, 0];
const TAIKO_HI = [0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0.6, 0];
const SHAKER = [0.3, 0.5, 0.35, 0.8, 0.3, 0.5, 0.35, 0.8, 0.3, 0.5, 0.35, 0.8, 0.3, 0.5, 0.35, 0.9];

const phraseState = { origin: -1, phrase: null as Phrase | null };

export const EXPLORE: TrackDef = {
  bpm: 70,
  loopBars: 16,
  sends: { pad: 0.35, melody: 0.6, texture: 0.25, ostinato: 0.25, perc: 0.15, choir: 0.4 },
  echo: ['melody'],
  drone: [38, 45],
  levels(i, o) {
    const c = i.combat;
    o.pad = 0.55 + 0.35 * i.explore - 0.2 * c;
    o.drone = 0.35 + 0.15 * c;
    o.texture = 0.4 + 0.6 * i.explore;
    o.melody = (0.5 + 0.5 * i.explore) * (1 - 0.8 * layerLevel(c, 0.2, 0.7));
    o.perc = layerLevel(c, 0.01, 0.3);
    o.bass = layerLevel(c, 0.3, 0.6);
    o.ostinato = layerLevel(c, 0.55, 0.9);
    o.choir = 0;
    o.brass = 0;
    o.hats = layerLevel(c, 0.5, 0.8);
  },
  step(c) {
    const { inst, out, t, bar, s16, sec16, int } = c;
    const ch = chordAt(EXPLORE_PROG, bar);
    if (s16 === 0 && bar === ch.bar) {
      inst.pad(out.pad, t, ch.pad, ch.bars * 16 * sec16, 0.24, 800 + 900 * int.explore);
      if (int.combat > 0.3) inst.bass(out.bass, t, ch.root - 12, 16 * sec16, 0.18);
    }
    // pencil-hatching texture: the world being drawn around you
    if (c.rnd() < 0.05 + 0.12 * int.explore) {
      inst.hit(out.texture, 'pencil', t, 0.05 + 0.1 * c.rnd(), 0.9 + 0.25 * c.rnd(), c.rnd() * 1.6 - 0.8);
    }
    if (s16 === 6 && bar % 2 === 1 && c.rnd() < 0.35 + 0.3 * int.explore) {
      inst.hit(out.texture, 'hatch', t, 0.12, 0.95 + 0.1 * c.rnd(), c.rnd() * 1.2 - 0.6);
    }
    if (s16 === 0 && bar % 4 === 2 && c.rnd() < 0.5)
      inst.hit(out.texture, 'rustle', t, 0.1, 1, c.rnd() - 0.5);

    // melody: one phrase per 4-bar group, picked to fit the group's harmony
    if (s16 === 0 && bar % 4 === 0) {
      phraseState.phrase = null;
      if (int.combat < 0.6 && c.rnd() < 0.55 + 0.35 * int.explore) {
        const opts = EXPLORE_PHRASES[bar]!;
        phraseState.phrase = opts[Math.floor(c.rnd() * opts.length)]!;
        phraseState.origin = c.step;
      }
    }
    if (phraseState.phrase) playPhrase(c, phraseState.phrase, phraseState.origin, out.melody, 0.13);

    // combat percussion — enters in tiers as combat intensity rises
    const cb = int.combat;
    if (cb > 0.02) {
      const fill = bar % 4 === 3;
      inst.hit(out.perc, 'frame', t, FRAME[s16]! * 0.3 * layerLevel(cb, 0.02, 0.3), 1, -0.2);
      if (cb > 0.25) {
        const lv = layerLevel(cb, 0.25, 0.55);
        if (TAIKO_LO[s16]) inst.hit(out.perc, 'taikoLow', t, TAIKO_LO[s16]! * 0.6 * lv);
        const hi = fill && s16 >= 12 ? 0.8 : TAIKO_HI[s16]!;
        if (hi) inst.hit(out.perc, 'taikoHi', t, hi * 0.42 * lv, 1, 0.25);
      }
      if (cb > 0.5) inst.hit(out.hats, 'shaker', t, SHAKER[s16]! * 0.16, 1, 0.35);
      if (cb > 0.75 && s16 === 0 && bar % 4 === 0) inst.hit(out.perc, 'boom', t, 0.45);
      if (cb > 0.75 && fill && s16 === 6) inst.hit(out.perc, 'swell', t, 0.25);
      if (cb > 0.3 && s16 % 2 === 0) {
        const n = s16 % 8 === 6 ? ch.root : ch.root - 12;
        inst.bass(out.bass, t, n, sec16 * 1.6, 0.22);
      }
      if (cb > 0.55) {
        const tones = ch.pad;
        const idx = [0, 2, 1, 3][s16 % 4]!;
        inst.pluck(out.ostinato, t, tones[idx % tones.length]! + 12, sec16 * 0.9, 0.07, 2600);
      }
    }
  },
};

// ───────────────────────────── BOSS ─────────────────────────────

const BOSS_PROG: Chord[] = [
  { bar: 0, bars: 2, pad: [50, 57, 62, 65], root: 38 }, // Dm
  { bar: 2, bars: 2, pad: [51, 58, 63, 67], root: 39 }, // Eb (Phrygian bII)
  { bar: 4, bars: 2, pad: [50, 57, 62, 65], root: 38 }, // Dm
  { bar: 6, bars: 2, pad: [48, 55, 60, 64], root: 36 }, // C
  { bar: 8, bars: 2, pad: [46, 53, 58, 62], root: 34 }, // Bb
  { bar: 10, bars: 2, pad: [51, 55, 58, 63], root: 39 }, // Eb
  { bar: 12, bars: 2, pad: [50, 55, 58, 62], root: 43 }, // Gm
  { bar: 14, bars: 2, pad: [49, 52, 57, 61], root: 45 }, // A (harmonic V)
];
const OST = [0, 0, 1, 0, 3, 0, 1, 0];
const BOSS_LO = [
  [0, 10],
  [0, 6, 10],
  [0, 3, 6, 10, 11],
];
const BOSS_HI = [[8], [4, 12, 14], [4, 8, 12, 13, 14, 15]];
const BOSS_THEME: Phrase = [
  [0, A3 + 12],
  [2, A3 + 12, 0.8],
  [4, A3 + 12, 0.9],
  [6, D5],
  [12, F5],
  [14, Eb5, 0.9],
  [16, D5],
];
const bossPhrase = { origin: -1, on: false, brass: false };

export function bossPhase(level: number): 0 | 1 | 2 | 3 {
  return level <= 0.01 ? 0 : level < 0.5 ? 1 : level < 0.84 ? 2 : 3;
}

export const BOSS: TrackDef = {
  bpm: 96,
  loopBars: 16,
  sends: { pad: 0.3, choir: 0.5, brass: 0.35, melody: 0.6, perc: 0.18, ostinato: 0.15, hats: 0.15 },
  echo: ['melody'],
  drone: [26, 38],
  levels(i, o) {
    const b = Math.max(0.34, i.boss);
    o.pad = 0.5;
    o.drone = 0.5;
    o.texture = 0.3;
    o.melody = 0.7;
    o.ostinato = 0.6 + 0.4 * b;
    o.perc = 0.6 + 0.4 * b;
    o.bass = layerLevel(b, 0.4, 0.6);
    o.choir = layerLevel(b, 0.45, 0.65);
    o.hats = layerLevel(b, 0.45, 0.65);
    o.brass = layerLevel(b, 0.8, 0.95);
  },
  step(c) {
    const { inst, out, t, bar, s16, sec16 } = c;
    const ph = Math.max(1, bossPhase(c.int.boss));
    const ch = chordAt(BOSS_PROG, bar);
    const chordStart = s16 === 0 && bar === ch.bar;
    if (chordStart) {
      inst.pad(out.pad, t, ch.pad, 32 * sec16, 0.2, 650 + ph * 150);
      if (ph >= 2)
        inst.choir(
          out.choir,
          t,
          ch.pad.map((n) => n + 12),
          32 * sec16,
          0.14,
        );
    }
    // ostinato: Phrygian cell on the chord root — 8ths, 16ths in phase 3
    if (ph === 3 || s16 % 2 === 0) {
      const cell = OST[(s16 >> 1) % 8]!;
      const acc = s16 % 4 === 0 ? 1 : 0.7;
      inst.pluck(out.ostinato, t, ch.root + 12 + cell, sec16 * 1.2, 0.13 * acc, 1500 + ph * 600);
    }
    // percussion tiers
    const lo = BOSS_LO[ph - 1]!;
    const hi = BOSS_HI[ph - 1]!;
    if (lo.includes(s16)) inst.hit(out.perc, 'taikoLow', t, s16 === 0 ? 0.7 : 0.5);
    if (hi.includes(s16)) inst.hit(out.perc, 'taikoHi', t, 0.38, 1, s16 % 2 ? 0.3 : -0.3);
    if (ph >= 2 && s16 % 2 === 0) inst.hit(out.perc, 'frame', t, s16 % 4 === 0 ? 0.25 : 0.14, 1, -0.25);
    if (ph === 3) inst.hit(out.hats, 'shaker', t, SHAKER[s16]! * 0.14, 1, 0.4);
    // pencil hats: the Editor's scribbling, on the off-beats
    if (ph >= 2 && (s16 % 4 === 2 || (ph === 3 && s16 % 2 === 1))) {
      inst.hit(
        out.hats,
        'pencil',
        t,
        s16 % 4 === 2 ? 0.16 : 0.08,
        1.05 + 0.15 * c.rnd(),
        c.rnd() * 1.4 - 0.7,
      );
    }
    if (ph >= 2 && s16 % 4 === 0) inst.bass(out.bass, t, ch.root - 12, sec16 * 3.5, 0.26);
    const boomEvery = ph === 3 ? 2 : 4;
    if (s16 === 0 && bar % boomEvery === 0) inst.hit(out.perc, 'boom', t, 0.5);
    if (ph === 3 && bar % 4 === 3 && s16 === 6) inst.hit(out.perc, 'swell', t, 0.3);
    // brass stabs (phase 3)
    if (ph === 3 && bar === ch.bar) {
      if (s16 === 0) inst.brass(out.brass, t, ch.pad, sec16 * 2.5, 0.3, 0.02);
      if (s16 === 3) inst.brass(out.brass, t, ch.pad, sec16 * 1.2, 0.22, 0.015);
      if (s16 === 6) inst.brass(out.brass, t, ch.pad, sec16 * 3, 0.26, 0.02);
    }
    // the leitmotif, corrupted (b9) — music box in phase 1, brass in phase 3
    if (s16 === 0 && bar % 8 === 0) {
      bossPhrase.on = ph <= 2;
      bossPhrase.brass = false;
      bossPhrase.origin = c.step;
    }
    if (s16 === 0 && bar % 8 === 4 && ph === 3) {
      bossPhrase.on = true;
      bossPhrase.brass = true;
      bossPhrase.origin = c.step;
    }
    if (bossPhrase.on) {
      const rel = c.step - bossPhrase.origin;
      for (const n of BOSS_THEME) {
        if (n[0] !== rel) continue;
        if (bossPhrase.brass) inst.brass(out.brass, t, [n[1], n[1] - 12], sec16 * (rel === 6 ? 5 : 1.6), 0.2);
        else inst.musicBox(out.melody, t, n[1] - 12, 0.15 * (n[2] ?? 1), 2.4);
      }
      if (rel > 20) bossPhrase.on = false;
    }
  },
};

// ───────────────────────────── TITLE ─────────────────────────────

const TITLE_PROG: Chord[] = [
  { bar: 0, bars: 2, pad: [50, 57, 64, 65], root: 38 },
  { bar: 2, bars: 2, pad: [46, 53, 57, 62], root: 34 },
  { bar: 4, bars: 2, pad: [55, 58, 62, 69], root: 43 },
  { bar: 6, bars: 1, pad: [57, 62, 64, 69], root: 45 },
  { bar: 7, bars: 1, pad: [57, 61, 64, 67], root: 45 },
];

export const TITLE: TrackDef = {
  bpm: 60,
  loopBars: 8,
  sends: { pad: 0.4, melody: 0.65, texture: 0.3, bass: 0.1 },
  echo: ['melody'],
  drone: [38, 45],
  levels(_i, o) {
    o.pad = 0.85;
    o.drone = 0.4;
    o.texture = 0.6;
    o.melody = 0.9;
    o.bass = 0.6;
    o.perc = 0;
    o.ostinato = 0;
    o.choir = 0;
    o.brass = 0;
    o.hats = 0;
  },
  step(c) {
    const { inst, out, t, bar, s16, sec16 } = c;
    const ch = chordAt(TITLE_PROG, bar);
    if (s16 === 0 && bar === ch.bar) {
      inst.pad(out.pad, t, ch.pad, ch.bars * 16 * sec16, 0.26, 1100);
      inst.bass(out.bass, t, ch.root - 12, ch.bars * 16 * sec16, 0.12);
    }
    const origin = c.step - (bar * 16 + s16);
    const up = c.loop % 2 === 1 ? 12 : 0;
    if (bar < 4) playPhrase(c, THEME, origin, out.melody, 0.15, up);
    else playPhrase(c, ANSWER, origin + 64, out.melody, 0.14, up);
    if (c.rnd() < 0.035) inst.hit(out.texture, 'pencil', t, 0.06, 0.9 + 0.2 * c.rnd(), c.rnd() * 1.6 - 0.8);
    if (s16 === 8 && bar % 4 === 1) inst.hit(out.texture, 'rustle', t, 0.12, 0.9, c.rnd() - 0.5);
  },
};

// ───────────────────────────── COVER ─────────────────────────────

const COVER_PROG: Chord[] = [
  { bar: 0, bars: 2, pad: [50, 57, 64, 66], root: 38 }, // D(add9)
  { bar: 2, bars: 2, pad: [49, 57, 61, 64], root: 37 }, // A/C#
  { bar: 4, bars: 2, pad: [47, 54, 57, 62], root: 35 }, // Bm7
  { bar: 6, bars: 2, pad: [55, 59, 62, 66], root: 43 }, // Gmaj7
  { bar: 8, bars: 2, pad: [54, 57, 62, 66], root: 42 }, // D/F#
  { bar: 10, bars: 2, pad: [55, 59, 62, 66], root: 43 }, // Gmaj7
  { bar: 12, bars: 2, pad: [52, 55, 59, 62], root: 40 }, // Em7
  { bar: 14, bars: 1, pad: [57, 62, 64, 69], root: 45 }, // Asus4
  { bar: 15, bars: 1, pad: [57, 61, 64, 69], root: 45 }, // A
];
const THEME_MAJOR = major(THEME);
const ANSWER_MAJOR: Phrase = [
  [0, D5],
  [4, Cs5, 0.8],
  [6, B4, 0.8],
  [8, A4, 1],
  [16, G4 + 0, 0.8],
  [18, A4, 0.8],
  [20, B4, 0.9],
  [24, D5, 1],
  [32, Fs5, 1],
  [36, E5, 0.9],
  [40, D5, 0.9],
  [48, E5, 1],
];
const HEART = [0.22, 0, 0, 0, 0, 0, 0.13, 0, 0, 0, 0, 0, 0, 0, 0, 0];

export const COVER: TrackDef = {
  bpm: 76,
  loopBars: 16,
  sends: { pad: 0.35, melody: 0.6, brass: 0.4, perc: 0.15, bass: 0.1 },
  echo: ['melody'],
  drone: [38],
  levels(_i, o) {
    o.pad = 0.85;
    o.drone = 0.25;
    o.texture = 0.4;
    o.melody = 0.9;
    o.bass = 0.6;
    o.perc = 0.6;
    o.hats = 0.5;
    o.brass = 0.6;
    o.ostinato = 0;
    o.choir = 0;
  },
  step(c) {
    const { inst, out, t, bar, s16, sec16 } = c;
    const ch = chordAt(COVER_PROG, bar);
    if (s16 === 0 && bar === ch.bar) {
      inst.pad(out.pad, t, ch.pad, ch.bars * 16 * sec16, 0.24, 1700);
      inst.bass(out.bass, t, ch.root - 12, ch.bars * 16 * sec16 * 0.95, 0.16);
    }
    const origin = c.step - (bar * 16 + s16);
    const half = bar >= 8 ? 128 : 0;
    const rel = bar % 8;
    if (rel < 4) playPhrase(c, THEME_MAJOR, origin + half, out.melody, half ? 0.08 : 0.15, half ? 12 : 0);
    else playPhrase(c, ANSWER_MAJOR, origin + half + 64, out.melody, half ? 0.08 : 0.14, half ? 12 : 0);
    if (half) {
      // second half: the theme sung by warm brass under the music box
      const p = rel < 4 ? THEME_MAJOR : ANSWER_MAJOR;
      const r = c.step - (origin + half + (rel < 4 ? 0 : 64));
      for (let i = 0; i < p.length; i++) {
        const n = p[i]!;
        if (n[0] !== r) continue;
        const next = p[i + 1]?.[0] ?? n[0] + 8;
        inst.brass(out.brass, t, [n[1] - 12], (next - n[0]) * sec16 * 0.95, 0.12 * (n[2] ?? 1), 0.08);
      }
    }
    if (HEART[s16]) inst.hit(out.perc, 'frame', t, HEART[s16]!, 0.9);
    if (s16 % 4 === 2) inst.hit(out.hats, 'shaker', t, 0.06, 1, 0.3);
    if (bar === 15 && s16 === 6) inst.hit(out.perc, 'swell', t, 0.18);
  },
};

export const TRACKS = { title: TITLE, explore: EXPLORE, boss: BOSS, cover: COVER } as const;
export type TrackName = keyof typeof TRACKS;
