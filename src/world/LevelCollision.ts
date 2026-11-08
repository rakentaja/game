import type * as THREE from 'three';
import type { CollisionAPI, LevelDef } from '../core/types';
import type { Blocker } from './layout';
import { inRect, makeHit, type PathSampler, type Rect } from './path';
import type { Heightfield } from './terrain';

const BCELL = 2;
const EPS = 0.02;

interface Deck {
  rect: Rect;
  /** Long axis: 0 = x, 1 = z. */
  axis: 0 | 1;
  h0: number;
  h1: number;
}

interface VoidRt {
  rect: Rect;
  kind: 'chasm' | 'cliff' | 'wall';
  open: boolean;
}

/**
 * Walkability + blockers for one page. Pure math (no WebGL) so it runs in unit tests.
 * Walkable = (path ∪ clearings ∪ printed rects) − (voids ∪ locked sketch rects), where printed
 * rects override voids. Positions are circle *centres*; the visual walk edge is halfW + radius.
 */
export class LevelCollision implements CollisionAPI {
  private readonly hit = makeHit();
  private readonly unlocked: Rect[] = [];
  private readonly locked = new Map<string, Rect>();
  private readonly voids: VoidRt[];
  private readonly decks: Deck[] = [];
  private readonly blockers: Blocker[];
  private readonly bx0: number;
  private readonly bz0: number;
  private readonly bnx: number;
  private readonly bnz: number;
  private readonly bStart: Int32Array;
  private readonly bItems: Int32Array;
  private readonly maxBlockR: number;

  constructor(
    readonly def: LevelDef,
    readonly path: PathSampler,
    readonly height: Heightfield,
    blockers: Blocker[],
  ) {
    this.voids = (def.voids ?? []).map((v) => ({ rect: v.rect, kind: v.kind, open: false }));
    for (const s of def.sketches) if (s.unlocks) this.locked.set(s.id, s.unlocks);
    this.blockers = blockers;
    this.bx0 = height.x0;
    this.bz0 = height.z0;
    this.bnx = Math.ceil((height.maxX - height.x0) / BCELL) + 1;
    this.bnz = Math.ceil((height.maxZ - height.z0) / BCELL) + 1;
    let mr = 0;
    const buckets: number[][] = Array.from({ length: this.bnx * this.bnz }, () => []);
    blockers.forEach((b, i) => {
      mr = Math.max(mr, b.r);
      const c = this.cellOf(b.x, b.z);
      if (c >= 0) buckets[c]!.push(i);
    });
    this.maxBlockR = mr;
    this.bStart = new Int32Array(buckets.length + 1);
    let t = 0;
    buckets.forEach((b, i) => {
      this.bStart[i] = t;
      t += b.length;
    });
    this.bStart[buckets.length] = t;
    this.bItems = new Int32Array(t);
    let o = 0;
    for (const b of buckets) for (const i of b) this.bItems[o++] = i;
  }

  private cellOf(x: number, z: number): number {
    const cx = Math.floor((x - this.bx0) / BCELL);
    const cz = Math.floor((z - this.bz0) / BCELL);
    if (cx < 0 || cz < 0 || cx >= this.bnx || cz >= this.bnz) return -1;
    return cz * this.bnx + cx;
  }

  /** Called by SketchObjects when a sketch prints. Bridges also get a flat deck height. */
  unlock(id: string, deck = false): void {
    const r = this.locked.get(id);
    if (!r) return;
    this.locked.delete(id);
    this.unlocked.push(r);
    for (const v of this.voids) {
      const cx = (v.rect[0] + v.rect[2]) * 0.5;
      const cz = (v.rect[1] + v.rect[3]) * 0.5;
      if (inRect(r, cx, cz)) v.open = true;
    }
    if (deck) {
      const axis: 0 | 1 = r[2] - r[0] >= r[3] - r[1] ? 0 : 1;
      const mid = axis === 0 ? (r[1] + r[3]) * 0.5 : (r[0] + r[2]) * 0.5;
      const h0 = axis === 0 ? this.height.sample(r[0], mid) : this.height.sample(mid, r[1]);
      const h1 = axis === 0 ? this.height.sample(r[2], mid) : this.height.sample(mid, r[3]);
      this.decks.push({ rect: r, axis, h0, h1 });
    }
  }

  isLocked(id: string): boolean {
    return this.locked.has(id);
  }

  /** Re-lock everything (fresh page). */
  reset(): void {
    this.unlocked.length = 0;
    this.decks.length = 0;
    this.locked.clear();
    for (const s of this.def.sketches) if (s.unlocks) this.locked.set(s.id, s.unlocks);
    for (const v of this.voids) v.open = false;
  }

  groundHeight(x: number, z: number): number {
    for (const d of this.decks) {
      if (!inRect(d.rect, x, z)) continue;
      const t =
        d.axis === 0 ? (x - d.rect[0]) / (d.rect[2] - d.rect[0]) : (z - d.rect[1]) / (d.rect[3] - d.rect[1]);
      // gentle hump like a plank bridge
      return d.h0 + (d.h1 - d.h0) * t + Math.sin(t * Math.PI) * 0.25;
    }
    return this.height.sample(x, z);
  }

  walkable(x: number, z: number): boolean {
    for (const r of this.unlocked) if (inRect(r, x, z)) return true;
    for (const v of this.voids) if (inRect(v.rect, x, z)) return false;
    for (const r of this.locked.values()) if (inRect(r, x, z)) return false;
    for (const c of this.def.clearings) {
      const dx = x - c[0];
      const dz = z - c[1];
      if (dx * dx + dz * dz <= c[2] * c[2]) return true;
    }
    const h = this.path.nearest(x, z, this.hit);
    return h.dist <= h.halfW;
  }

  resolveCircle(x: number, z: number, r: number, out: THREE.Vector2): boolean {
    let px = x;
    let pz = z;
    // 1) slide back into the walkable shape
    if (!this.walkable(px, pz)) {
      this.best = Infinity;
      this.bx = px;
      this.bz = pz;
      const h = this.path.nearest(px, pz, this.hit);
      const hpx = h.px;
      const hpz = h.pz;
      if (h.dist > 1e-6) {
        const k = Math.max(0, h.halfW - EPS) / h.dist;
        this.consider(x, z, hpx + (px - hpx) * k, hpz + (pz - hpz) * k);
      }
      for (const c of this.def.clearings) {
        const dx = px - c[0];
        const dz = pz - c[1];
        const d = Math.hypot(dx, dz) || 1e-6;
        const k = (c[2] - EPS) / d;
        this.consider(x, z, c[0] + dx * k, c[1] + dz * k);
      }
      for (const u of this.unlocked) {
        this.consider(
          x,
          z,
          Math.min(u[2] - EPS, Math.max(u[0] + EPS, px)),
          Math.min(u[3] - EPS, Math.max(u[1] + EPS, pz)),
        );
      }
      for (const v of this.voids) this.exits(x, z, v.rect);
      for (const q of this.locked.values()) this.exits(x, z, q);
      if (this.best === Infinity) this.consider(x, z, hpx, hpz);
      px = this.bx;
      pz = this.bz;
    }
    // 2) push out of trunks / boulders (two relaxation passes handle wedges between trunks)
    for (let pass = 0; pass < 2; pass++) {
      const reach = r + this.maxBlockR;
      const c0x = Math.max(0, Math.floor((px - reach - this.bx0) / BCELL));
      const c1x = Math.min(this.bnx - 1, Math.floor((px + reach - this.bx0) / BCELL));
      const c0z = Math.max(0, Math.floor((pz - reach - this.bz0) / BCELL));
      const c1z = Math.min(this.bnz - 1, Math.floor((pz + reach - this.bz0) / BCELL));
      let any = false;
      for (let cz = c0z; cz <= c1z; cz++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const c = cz * this.bnx + cx;
          for (let k = this.bStart[c]!; k < this.bStart[c + 1]!; k++) {
            const b = this.blockers[this.bItems[k]!]!;
            const dx = px - b.x;
            const dz = pz - b.z;
            const min = b.r + r;
            const d2 = dx * dx + dz * dz;
            if (d2 >= min * min) continue;
            const d = Math.sqrt(d2);
            if (d < 1e-6) {
              px += min; // dead centre: pick a side
            } else {
              const push = min - d;
              px += (dx / d) * push;
              pz += (dz / d) * push;
            }
            any = true;
          }
        }
      }
      if (!any) break;
    }
    out.set(px, pz);
    return px !== x || pz !== z;
  }

  private best = Infinity;
  private bx = 0;
  private bz = 0;

  private consider(x: number, z: number, cx: number, cz: number): void {
    const d = (cx - x) * (cx - x) + (cz - z) * (cz - z);
    if (d < this.best && this.walkable(cx, cz)) {
      this.best = d;
      this.bx = cx;
      this.bz = cz;
    }
  }

  private exits(x: number, z: number, q: Rect): void {
    if (!inRect(q, x, z)) return;
    this.consider(x, z, q[0] - EPS, z);
    this.consider(x, z, q[2] + EPS, z);
    this.consider(x, z, x, q[1] - EPS);
    this.consider(x, z, x, q[3] + EPS);
  }

  segmentClear(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    for (const v of this.voids) {
      if (v.kind !== 'wall' || v.open) continue;
      if (segRect(ax, az, bx, bz, v.rect)) return false;
    }
    const pad = this.maxBlockR;
    const c0x = Math.max(0, Math.floor((Math.min(ax, bx) - pad - this.bx0) / BCELL));
    const c1x = Math.min(this.bnx - 1, Math.floor((Math.max(ax, bx) + pad - this.bx0) / BCELL));
    const c0z = Math.max(0, Math.floor((Math.min(az, bz) - pad - this.bz0) / BCELL));
    const c1z = Math.min(this.bnz - 1, Math.floor((Math.max(az, bz) + pad - this.bz0) / BCELL));
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const c = cz * this.bnx + cx;
        for (let k = this.bStart[c]!; k < this.bStart[c + 1]!; k++) {
          const b = this.blockers[this.bItems[k]!]!;
          if (!b.los) continue;
          let t = l2 > 0 ? ((b.x - ax) * dx + (b.z - az) * dz) / l2 : 0;
          t = Math.min(1, Math.max(0, t));
          const qx = ax + dx * t - b.x;
          const qz = az + dz * t - b.z;
          if (qx * qx + qz * qz < b.r * b.r) return false;
        }
      }
    }
    return true;
  }
}

/** Segment vs AABB (slab test), allocation-free. */
function segRect(ax: number, az: number, bx: number, bz: number, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const slab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    let ta = (lo - o) / d;
    let tb = (hi - o) / d;
    if (ta > tb) {
      const t = ta;
      ta = tb;
      tb = t;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    return t0 <= t1;
  };
  return slab(ax, bx - ax, r[0], r[2]) && slab(az, bz - az, r[1], r[3]);
}
