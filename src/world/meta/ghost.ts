/**
 * Ghost Inker: records the player's XZ + yaw at 12 Hz per page (int16, ≈72 B/s → ~5 KB for a
 * 70 s page) and replays the best page run as a pencil silhouette. Storage is localStorage
 * through core/storage (try/catch inside); missing/corrupt data just means no ghost.
 */
import { load, save } from '../../core/storage';
import type { GameContext, PageId } from '../../core/types';
import { TUNING } from '../../data/tuning';

export interface GhostTrack {
  /** Page time (s) of the recorded run. */
  timeS: number;
  hz: number;
  /** Interleaved x, z, yaw (quantized int16). */
  samples: Int16Array;
}

const YAW_Q = 32767 / Math.PI;

export class GhostRecorder {
  private readonly buf: Int16Array;
  private n = 0;
  private acc = 0;
  time = 0;

  constructor(
    readonly hz: number = TUNING.worldMeta.ghost.hz,
    maxSeconds: number = TUNING.worldMeta.ghost.maxSeconds,
  ) {
    this.buf = new Int16Array(Math.ceil(hz * maxSeconds) * 3);
  }

  reset(): void {
    this.n = 0;
    this.acc = 0;
    this.time = 0;
  }

  get count(): number {
    return this.n;
  }

  /** Per sim step. Samples land exactly on the 1/hz grid of page time. */
  step(dt: number, x: number, z: number, yaw: number): void {
    this.time += dt;
    this.acc += dt;
    const step = 1 / this.hz;
    if (this.n === 0) {
      this.push(x, z, yaw);
      this.acc = 0;
      return;
    }
    while (this.acc >= step) {
      this.acc -= step;
      this.push(x, z, yaw);
    }
  }

  private push(x: number, z: number, yaw: number): void {
    if ((this.n + 1) * 3 > this.buf.length) return;
    const q = TUNING.worldMeta.ghost.quant;
    const k = this.n * 3;
    this.buf[k] = clamp16(Math.round(x / q));
    this.buf[k + 1] = clamp16(Math.round(z / q));
    this.buf[k + 2] = clamp16(Math.round(wrap(yaw) * YAW_Q));
    this.n++;
  }

  track(): GhostTrack {
    return { timeS: this.time, hz: this.hz, samples: this.buf.slice(0, this.n * 3) };
  }
}

const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Sample a track at page time t into `out` (x, z, yaw). Returns false past the end. */
export function sampleTrack(tr: GhostTrack, t: number, out: { x: number; z: number; yaw: number }): boolean {
  const n = tr.samples.length / 3;
  if (n === 0) return false;
  const q = TUNING.worldMeta.ghost.quant;
  const f = Math.max(0, t * tr.hz);
  const i = Math.floor(f);
  if (i >= n - 1) {
    const k = (n - 1) * 3;
    out.x = tr.samples[k]! * q;
    out.z = tr.samples[k + 1]! * q;
    out.yaw = tr.samples[k + 2]! / YAW_Q;
    return i < n;
  }
  const a = i * 3;
  const b = a + 3;
  const u = f - i;
  const s = tr.samples;
  out.x = (s[a]! + (s[b]! - s[a]!) * u) * q;
  out.z = (s[a + 1]! + (s[b + 1]! - s[a + 1]!) * u) * q;
  const ya = s[a + 2]! / YAW_Q;
  let dy = s[b + 2]! / YAW_Q - ya;
  if (dy > Math.PI) dy -= Math.PI * 2;
  if (dy < -Math.PI) dy += Math.PI * 2;
  out.yaw = ya + dy * u;
  return true;
}

// ───────────── codec (base64 of little-endian int16) ─────────────

export function encodeSamples(s: Int16Array): string {
  const bytes = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const v = s[i]! & 0xffff;
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = v >>> 8;
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function decodeSamples(b64: string): Int16Array {
  const bin = atob(b64);
  const out = new Int16Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

interface StoredGhost {
  timeS: number | null;
  hz: number;
  data: string;
}

const storeKey = (slot: string, page: PageId) => `ghost:${slot}:${page}`;

export function loadGhost(slot: string, page: PageId): GhostTrack | null {
  try {
    const g = load<StoredGhost>(storeKey(slot, page), { timeS: null, hz: 12, data: '' });
    if (!g.data || typeof g.timeS !== 'number') return null;
    const samples = decodeSamples(g.data);
    if (samples.length < 6 || samples.length % 3 !== 0) return null;
    return { timeS: g.timeS, hz: g.hz > 0 ? g.hz : 12, samples };
  } catch {
    return null;
  }
}

/** Keep the faster of the stored and the new page run. Returns true if stored. */
export function saveGhostIfBest(slot: string, page: PageId, tr: GhostTrack): boolean {
  if (tr.samples.length < 6) return false;
  const prev = loadGhost(slot, page);
  if (prev && prev.timeS <= tr.timeS) return false;
  try {
    save<StoredGhost>(storeKey(slot, page), { timeS: tr.timeS, hz: tr.hz, data: encodeSamples(tr.samples) });
    return true;
  } catch {
    return false;
  }
}
