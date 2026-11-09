/**
 * Pure helpers behind the Idea Ledger audio features (no Web Audio here; unit-tested in
 * tests/unit/audio-ledger.test.ts).
 */
import type { LayerName } from './music/tracks';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Log-domain interpolation for frequencies. */
const lerpLog = (a: number, b: number, t: number) => a * (b / a) ** t;

// ───────────────────────────── Unprinted Mix ─────────────────────────────

export interface RevealMix {
  /** Highpass corner (Hz). */
  hp: number;
  /** Lowpass corner (Hz). */
  lp: number;
  /** Soft-clip wet amount 0..1 (dry = 1 − wet). */
  drive: number;
  /** Crackle bed gain (linear). */
  crackle: number;
}

/**
 * Reveal 0 = 1940s radio (300 Hz–3.2 kHz band, saturated, crackling), 1 = full fidelity.
 * Eased so the first strokes of ink already open the sound up noticeably.
 */
export function revealMix(
  r: number,
  out: RevealMix,
  t: { hpLo: number; lpLo: number; drive: number; crackle: number },
): RevealMix {
  const e = 1 - (1 - clamp01(r)) ** 2;
  out.hp = lerpLog(t.hpLo, 20, e);
  out.lp = lerpLog(t.lpLo, 20000, e);
  out.drive = t.drive * (1 - e);
  out.crackle = t.crackle * (1 - e) ** 1.5;
  return out;
}

/**
 * Proxy reveal when no `reveal:progress` arrives: time spent holding the crystal inks the page.
 * `heldS` = accumulated seconds of crystal hold this page.
 */
export function revealProxy(heldS: number, tauS: number): number {
  return heldS <= 0 ? 0 : 1 - Math.exp(-heldS / Math.max(1e-3, tauS));
}

// ───────────────────────────── Sound only in the light ─────────────────────────────

/**
 * Lowpass cutoff for a spatial voice at distance `d` (m) from the crystal with light `radius`:
 * `inside` Hz within the light, falling (log) to `outside` Hz across a `feather` band beyond it.
 */
export function lightCutoff(
  d: number,
  radius: number,
  feather: number,
  inside: number,
  outside: number,
): number {
  if (!Number.isFinite(d) || !Number.isFinite(radius)) return inside;
  const x = feather > 0 ? clamp01((d - radius) / feather) : d > radius ? 1 : 0;
  return lerpLog(inside, outside, x);
}

// ───────────────────────────── Shepard riser ─────────────────────────────

/**
 * Shepard voice `i` of `n` at print progress `p` (0..1) rising `octaves` octaves over the whole
 * print from `fMin`. Each voice wraps from the top back to the bottom where its window is silent,
 * so the pitch seems to climb forever. Writes [freq, amp] into `out` and returns it.
 */
export function shepardVoice(
  p: number,
  i: number,
  n: number,
  fMin: number,
  span: number,
  climb: number,
  out: [number, number],
): [number, number] {
  const x = (((clamp01(p) * climb + i / n) % 1) + 1) % 1;
  out[0] = fMin * 2 ** (x * span);
  const w = Math.sin(Math.PI * x);
  out[1] = w * w;
  return out;
}

// ───────────────────────────── Leitmotif pickups ─────────────────────────────

/** A A A | D — F E | D  as semitones above the ink-pickup base pitch (A). */
export const LEITMOTIF = [0, 0, 0, 5, 8, 7, 5] as const;
/** Muted-trumpet quote of the same cell (MIDI, D minor) and its 16th positions. */
export const MOTIF_MIDI = [69, 69, 69, 74, 77, 76, 74] as const;
export const MOTIF_STEPS = [0, 2, 4, 6, 12, 14, 16] as const;
export const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19] as const;

/** Picks the semitone for each consecutive pickup: pentatonic ladder, or the leitmotif. */
export class PickupMelody {
  mode: 'penta' | 'motif' = 'penta';
  private idx = -1;
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly comboGapS = 0.7,
    private readonly motifGapS = 2.5,
  ) {}

  next(now: number): number {
    if (this.mode === 'motif') {
      // The tune keeps its place across short gaps so a whole fight spells the theme.
      this.idx = now - this.last < this.motifGapS ? (this.idx + 1) % LEITMOTIF.length : 0;
      this.last = now;
      return LEITMOTIF[this.idx]!;
    }
    this.idx = now - this.last < this.comboGapS ? Math.min(PENTA.length - 1, this.idx + 1) : 0;
    this.last = now;
    return PENTA[this.idx]!;
  }

  reset(): void {
    this.idx = -1;
    this.last = Number.NEGATIVE_INFINITY;
  }
}

// ───────────────────────────── Drummer ring buffer ─────────────────────────────

/** Kit pieces the drummer may queue (indices into DRUM_KIT). */
export const DRUM_KIT = ['snare', 'stick', 'crash', 'frame', 'taikoHi'] as const;
export type DrumPiece = (typeof DRUM_KIT)[number];

/**
 * Fixed-capacity FIFO of pending hits (no allocation after construction). `div` is the grid in
 * 16ths the hit must land on (1 = next 16th, 2 = next 8th). `minStep` = earliest step allowed.
 */
export class HitRing {
  readonly piece: Uint8Array;
  readonly vel: Float32Array;
  readonly div: Uint8Array;
  readonly offset: Float32Array;
  readonly rate: Float32Array;
  private head = 0;
  private len = 0;

  constructor(readonly capacity = 32) {
    this.piece = new Uint8Array(capacity);
    this.vel = new Float32Array(capacity);
    this.div = new Uint8Array(capacity);
    this.offset = new Float32Array(capacity);
    this.rate = new Float32Array(capacity);
  }

  get size(): number {
    return this.len;
  }

  /** Queue a hit; `offset16` shifts it inside the slot (e.g. −0.5 = a 32nd early grace note). Oldest is dropped when full. */
  push(piece: number, vel: number, div: number, offset16 = 0, rate = 1): void {
    if (this.len === this.capacity) {
      this.head = (this.head + 1) % this.capacity;
      this.len--;
    }
    const i = (this.head + this.len) % this.capacity;
    this.piece[i] = piece;
    this.vel[i] = vel;
    this.div[i] = Math.max(1, div);
    this.offset[i] = offset16;
    this.rate[i] = rate;
    this.len++;
  }

  /**
   * Hand every hit whose grid matches `step` to `play(piece, vel, offset16, rate)`; others stay
   * queued in order. Allocation-free.
   */
  drain(step: number, play: (piece: number, vel: number, offset16: number, rate: number) => void): number {
    let fired = 0;
    const n = this.len;
    const cap = this.capacity;
    let w = this.head;
    for (let k = 0; k < n; k++) {
      const i = (this.head + k) % cap;
      if (step % this.div[i]! === 0) {
        play(this.piece[i]!, this.vel[i]!, this.offset[i]!, this.rate[i]!);
        fired++;
      } else {
        if (w !== i) {
          this.piece[w] = this.piece[i]!;
          this.vel[w] = this.vel[i]!;
          this.div[w] = this.div[i]!;
          this.offset[w] = this.offset[i]!;
          this.rate[w] = this.rate[i]!;
        }
        w = (w + 1) % cap;
      }
    }
    this.len -= fired;
    return fired;
  }

  clear(): void {
    this.len = 0;
  }
}

/**
 * Density gate for the drummer: which flourishes a hit gets at a given combat heat (0..1).
 * Returns a bitmask: 1 = main hit, 2 = grace notes / drag, 4 = follow-up fill.
 */
export function drumDensity(heat: number, base: number): number {
  const h = clamp01(heat);
  if (h < base) return 0;
  let m = 1;
  if (h >= lerp(base, 1, 0.35)) m |= 2;
  if (h >= lerp(base, 1, 0.7)) m |= 4;
  return m;
}

// ───────────────────────────── Editor erases stems ─────────────────────────────

/** Order in which the Editor erases the boss score (stem index → layer). Melody & pad go last. */
export const ERASE_ORDER: readonly LayerName[] = [
  'brass',
  'choir',
  'hats',
  'ostinato',
  'bass',
  'perc',
  'melody',
  'pad',
  'texture',
  'drone',
];

export function stemLayer(stem: number): LayerName | null {
  return Number.isInteger(stem) && stem >= 0 && stem < ERASE_ORDER.length ? ERASE_ORDER[stem]! : null;
}
