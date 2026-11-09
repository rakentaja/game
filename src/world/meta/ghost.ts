/**
 * Ghost Inker: records the player's XZ + yaw at 12 Hz per page (int16, ≈72 B/s → ~5 KB for a
 * 70 s page) and replays the best page run as a pencil silhouette. Storage is localStorage
 * through core/storage (try/catch inside); missing/corrupt data just means no ghost.
 */
import * as THREE from 'three';
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

// ───────────── playback silhouette ─────────────

/** Translucent-reading pencil wizard: robe cone, head, hat, staff — dashed pencil, never inked. */
export class GhostInker {
  readonly object = new THREE.Group();
  private track: GhostTrack | null = null;
  private readonly mat: THREE.ShaderMaterial;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly s = { x: 0, z: 0, yaw: 0 };
  private disposeOutline: (() => void) | null = null;

  constructor(private readonly ctx: GameContext) {
    this.mat = ctx.render.createInkMaterial({ ramp: 'staff', reveal: false, printed: 0, sketch: 0.7 });
    const part = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, rz = 0) => {
      this.geos.push(g);
      const m = new THREE.Mesh(g, this.mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, 0, rz);
      this.object.add(m);
    };
    part(new THREE.ConeGeometry(0.42, 1.15, 9, 1, true), 0, 0.58, 0);
    part(new THREE.SphereGeometry(0.2, 10, 8), 0, 1.3, 0);
    part(new THREE.ConeGeometry(0.3, 0.6, 9), 0, 1.68, 0, 0, -0.18);
    part(new THREE.CylinderGeometry(0.025, 0.03, 1.7, 5), 0.38, 0.85, 0.1, 0.05, -0.08);
    this.object.name = 'ghost-inker';
    this.object.visible = false;
    ctx.render.scene.add(this.object);
    try {
      this.disposeOutline = ctx.render.addOutline(this.object, 1.2);
    } catch {
      this.disposeOutline = null;
    }
  }

  setTrack(tr: GhostTrack | null): void {
    this.track = tr;
    this.object.visible = false;
  }

  get active(): boolean {
    return this.track !== null;
  }

  /** Page time t (s). Hides the ghost once its run ended or it's right on top of the player. */
  update(t: number, px: number, pz: number): void {
    const tr = this.track;
    if (!tr) return;
    const live = sampleTrack(tr, t, this.s);
    const near = (this.s.x - px) ** 2 + (this.s.z - pz) ** 2 < 0.5;
    this.object.visible = live && !near;
    if (!this.object.visible) return;
    const y = this.ctx.collision.groundHeight(this.s.x, this.s.z);
    this.object.position.set(this.s.x, y, this.s.z);
    this.object.rotation.y = this.s.yaw;
  }

  dispose(): void {
    this.disposeOutline?.();
    this.object.removeFromParent();
    for (const g of this.geos) g.dispose();
    this.mat.dispose();
  }
}
