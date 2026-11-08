/**
 * Optional recorded-SFX sprite. The shipped build is fully procedural (src/audio/synth), so
 * SPRITE is null and nothing is fetched. To drop in licensed recordings later:
 *   1. pack them into public/audio/sfx.webm (Opus) + public/audio/sfx.m4a (AAC) with identical timing,
 *   2. add each source to assets/licenses.json,
 *   3. fill SPRITE below. Ids present in the sprite override the synth bank; the rest stay procedural.
 */
import type { SfxId } from '../core/types';

export interface SpriteEntry {
  /** Start offset in seconds. */
  start: number;
  /** Duration in seconds. */
  dur: number;
  /** Loop between start and start+dur (sketch_loop, eraser_sweep). */
  loop?: boolean;
}

export interface SpriteManifest {
  files: { webm?: string; m4a?: string };
  sprites: Partial<Record<SfxId, SpriteEntry | SpriteEntry[]>>;
}

export const SPRITE: SpriteManifest | null = null;

export type CanPlay = (mime: string) => string;

export const MIME = {
  webm: 'audio/webm; codecs="opus"',
  m4a: 'audio/mp4; codecs="mp4a.40.2"',
} as const;

/**
 * Pick the sprite container this browser decodes. Opus/WebM first (smaller, Chrome/Firefox/
 * Android), AAC/M4A otherwise (iOS Safari < 17 has no WebM Opus in decodeAudioData).
 * Returns an ordered list so a failed decode can retry with the next format.
 */
export function pickFormats(files: SpriteManifest['files'], canPlay: CanPlay): string[] {
  const out: string[] = [];
  const rank = (m: string) => (m === 'probably' ? 2 : m === 'maybe' ? 1 : 0);
  const cands: [string, number][] = [];
  if (files.webm) cands.push([files.webm, rank(canPlay(MIME.webm)) * 2]);
  if (files.m4a) cands.push([files.m4a, rank(canPlay(MIME.m4a)) * 2 - 1]);
  cands.sort((a, b) => b[1] - a[1]);
  for (const [f, r] of cands) if (r > 0) out.push(f);
  // Nothing claimed support: still try everything (canPlayType lies on some WebViews).
  if (out.length === 0) for (const [f] of cands) out.push(f);
  return out;
}

/** Flatten a manifest into validated per-id variant lists; throws on bad ranges. */
export function normalizeSprites(m: SpriteManifest, totalDur: number): Map<SfxId, SpriteEntry[]> {
  const map = new Map<SfxId, SpriteEntry[]>();
  for (const [id, raw] of Object.entries(m.sprites) as [SfxId, SpriteEntry | SpriteEntry[]][]) {
    const list = Array.isArray(raw) ? raw : [raw];
    for (const e of list) {
      if (!(e.start >= 0 && e.dur > 0 && e.start + e.dur <= totalDur + 1e-3)) {
        throw new Error(`sprite ${id}: range ${e.start}+${e.dur} outside 0..${totalDur}`);
      }
    }
    if (list.length) map.set(id, list);
  }
  return map;
}
