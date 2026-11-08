/**
 * Offline baking: render a synth recipe once into an AudioBuffer and master it.
 * OfflineAudioContext needs no user gesture, so the whole bank can bake during boot/title.
 */
import type { SfxId } from '../../core/types';
import { dbToGain, gainToDb, integratedLoudness, limitInPlace, peak } from '../mix';
import { Rng } from './dsp';
import { SFX, type SfxRecipe } from './sfx';

export interface BakedSfx {
  id: string;
  variant: number;
  buffer: AudioBuffer;
  /** Post-mastering measurements, shown in the dev harness. */
  peakDb: number;
  lufs: number;
  /** Max limiter gain reduction during mastering (dB, ≤ 0). */
  grDb: number;
  renderMs: number;
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineCtor(): OfflineCtor | null {
  const g = globalThis as unknown as {
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext ?? null;
}

export function seedFor(id: string, variant: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h ^ Math.imul(variant + 1, 0x9e3779b1)) >>> 0;
}

/** Render one variant of a recipe. `sampleRate` should match the live context (no resampling). */
export async function bakeRecipe(
  id: string,
  variant: number,
  sampleRate: number,
  recipe: SfxRecipe = SFX[id as SfxId],
): Promise<BakedSfx> {
  const Ctor = offlineCtor();
  if (!Ctor) throw new Error('OfflineAudioContext unavailable');
  const t0 = performance.now();
  const ch = recipe.stereo ? 2 : 1;
  const len = Math.ceil(recipe.dur * sampleRate);
  const ac = new Ctor(ch, len, sampleRate);
  // Hard safety net in the bake graph only (never hit by well-behaved recipes).
  const bus = ac.createGain();
  bus.connect(ac.destination);
  recipe.build({ ac, out: bus, t: 0.002, rng: new Rng(seedFor(id, variant)) }, variant);
  const buffer = await ac.startRendering();
  const chans: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  let pk = 0;
  for (const c of chans) pk = Math.max(pk, peak(c));
  for (const c of chans) sanitize(c);
  if (recipe.loop) loopFade(chans, sampleRate);
  else tailFade(chans, sampleRate);
  // Loudness first, then a lookahead limiter takes at most `maxGrDb` off the transients so
  // punchy sounds reach their target instead of being held back by a single peak.
  let lufs = integratedLoudness(chans, sampleRate);
  let grDb = 0;
  if (pk > 0 && lufs > -96) {
    const maxGr = recipe.maxGrDb ?? 6;
    const g = Math.min(dbToGain(recipe.lufs - lufs), (dbToGain(-1) / pk) * dbToGain(maxGr));
    for (const c of chans) for (let i = 0; i < c.length; i++) c[i]! *= g;
    grDb = limitInPlace(chans, sampleRate, -1);
    lufs = integratedLoudness(chans, sampleRate);
  }
  let outPk = 0;
  for (const c of chans) outPk = Math.max(outPk, peak(c));
  return { id, variant, buffer, peakDb: gainToDb(outPk), lufs, grDb, renderMs: performance.now() - t0 };
}

/** Replace NaN/Inf (from a bad automation) with silence so a broken recipe can't blow the bus. */
function sanitize(c: Float32Array): void {
  for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i]!)) c[i] = 0;
}

/** 8 ms fade-out so truncated tails never click. */
function tailFade(chans: Float32Array[], fs: number): void {
  const n = Math.floor(0.008 * fs);
  for (const c of chans) {
    const L = c.length;
    for (let i = 0; i < n && i < L; i++) c[L - 1 - i]! *= i / n;
  }
}

/** Loops: 4 ms in/out ramps (recipes already return to silence at both ends). */
function loopFade(chans: Float32Array[], fs: number): void {
  const n = Math.floor(0.004 * fs);
  for (const c of chans) {
    const L = c.length;
    for (let i = 0; i < n && i < L; i++) {
      c[i]! *= i / n;
      c[L - 1 - i]! *= i / n;
    }
  }
}
