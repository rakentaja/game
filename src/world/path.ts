import type { Vec2T } from '../core/types';

export type Rect = [number, number, number, number];

export const inRect = (r: Rect, x: number, z: number): boolean =>
  x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];

/** Result slot for nearest-point queries (reused by callers — no allocations). */
export interface PathHit {
  dist: number;
  /** Arc length at the nearest point. */
  s: number;
  /** Walkable half width at the nearest point. */
  halfW: number;
  px: number;
  pz: number;
  /** Unit tangent at the nearest point. */
  tx: number;
  tz: number;
}

export const makeHit = (): PathHit => ({ dist: 0, s: 0, halfW: 0, px: 0, pz: 0, tx: 1, tz: 0 });

const STEP = 0.5;
const CELL = 4;
/** Nearest queries are exact up to this distance beyond the widest half width; farther returns Infinity. */
export const PATH_REACH = 24;

/**
 * The level's walkable spine: a uniform Catmull-Rom through `path`, resampled every 0.5 m into a
 * polyline with per-sample half widths, plus a bucket grid of segments for O(1) nearest queries.
 */
export class PathSampler {
  readonly xs: Float32Array;
  readonly zs: Float32Array;
  readonly hw: Float32Array;
  readonly cum: Float32Array;
  readonly count: number;
  readonly length: number;
  readonly maxHalfW: number;
  private readonly gx0: number;
  private readonly gz0: number;
  private readonly gnx: number;
  private readonly gnz: number;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;

  constructor(ctrl: readonly Vec2T[], halfWidth: number, widths?: readonly number[]) {
    if (ctrl.length < 2) throw new Error('path needs at least 2 points');
    const xs: number[] = [];
    const zs: number[] = [];
    const hw: number[] = [];
    const n = ctrl.length;
    const P = (i: number): Vec2T => ctrl[Math.max(0, Math.min(n - 1, i))]!;
    const W = (i: number): number => halfWidth * (widths?.[Math.max(0, Math.min(n - 1, i))] ?? 1);
    for (let i = 0; i < n - 1; i++) {
      const p0 = P(i - 1);
      const p1 = P(i);
      const p2 = P(i + 1);
      const p3 = P(i + 2);
      const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const k = Math.max(2, Math.ceil(segLen / STEP));
      for (let j = 0; j < k; j++) {
        const t = j / k;
        const t2 = t * t;
        const t3 = t2 * t;
        const cr = (a: number, b: number, c: number, d: number) =>
          0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        xs.push(cr(p0[0], p1[0], p2[0], p3[0]));
        zs.push(cr(p0[1], p1[1], p2[1], p3[1]));
        const e = t * t * (3 - 2 * t);
        hw.push(W(i) + (W(i + 1) - W(i)) * e);
      }
    }
    const last = P(n - 1);
    xs.push(last[0]);
    zs.push(last[1]);
    hw.push(W(n - 1));

    this.count = xs.length;
    this.xs = Float32Array.from(xs);
    this.zs = Float32Array.from(zs);
    this.hw = Float32Array.from(hw);
    this.cum = new Float32Array(this.count);
    let L = 0;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let mw = 0;
    for (let i = 0; i < this.count; i++) {
      if (i > 0) L += Math.hypot(xs[i]! - xs[i - 1]!, zs[i]! - zs[i - 1]!);
      this.cum[i] = L;
      minX = Math.min(minX, xs[i]!);
      maxX = Math.max(maxX, xs[i]!);
      minZ = Math.min(minZ, zs[i]!);
      maxZ = Math.max(maxZ, zs[i]!);
      mw = Math.max(mw, hw[i]!);
    }
    this.length = L;
    this.maxHalfW = mw;

    // bucket grid: every segment is registered in each cell its (inflated) bbox touches
    const pad = mw + PATH_REACH + CELL;
    this.gx0 = minX - pad;
    this.gz0 = minZ - pad;
    this.gnx = Math.ceil((maxX - minX + 2 * pad) / CELL) + 1;
    this.gnz = Math.ceil((maxZ - minZ + 2 * pad) / CELL) + 1;
    const buckets: number[][] = Array.from({ length: this.gnx * this.gnz }, () => []);
    for (let i = 0; i < this.count - 1; i++) {
      const rr = mw + PATH_REACH;
      const ax = Math.min(xs[i]!, xs[i + 1]!) - rr;
      const bx = Math.max(xs[i]!, xs[i + 1]!) + rr;
      const az = Math.min(zs[i]!, zs[i + 1]!) - rr;
      const bz = Math.max(zs[i]!, zs[i + 1]!) + rr;
      for (let cz = this.cz(az); cz <= this.cz(bz); cz++)
        for (let cx = this.cx(ax); cx <= this.cx(bx); cx++) buckets[cz * this.gnx + cx]!.push(i);
    }
    this.cellStart = new Int32Array(buckets.length + 1);
    let total = 0;
    for (let c = 0; c < buckets.length; c++) {
      this.cellStart[c] = total;
      total += buckets[c]!.length;
    }
    this.cellStart[buckets.length] = total;
    this.cellItems = new Int32Array(total);
    let o = 0;
    for (const b of buckets) for (const it of b) this.cellItems[o++] = it;
  }

  private cx(x: number): number {
    return Math.max(0, Math.min(this.gnx - 1, Math.floor((x - this.gx0) / CELL)));
  }
  private cz(z: number): number {
    return Math.max(0, Math.min(this.gnz - 1, Math.floor((z - this.gz0) / CELL)));
  }

  /**
   * Nearest point on the spine. Exact within `maxHalfW + PATH_REACH` of the path; farther away
   * `dist` is Infinity (callers treat that as "deep in the woods").
   */
  nearest(x: number, z: number, out: PathHit): PathHit {
    out.dist = Infinity;
    const gx = Math.floor((x - this.gx0) / CELL);
    const gz = Math.floor((z - this.gz0) / CELL);
    if (gx >= 0 && gz >= 0 && gx < this.gnx && gz < this.gnz) {
      const c = gz * this.gnx + gx;
      for (let k = this.cellStart[c]!; k < this.cellStart[c + 1]!; k++)
        this.testSeg(this.cellItems[k]!, x, z, out);
    }
    return out;
  }

  private testSeg(i: number, x: number, z: number, out: PathHit): void {
    const ax = this.xs[i]!;
    const az = this.zs[i]!;
    const dx = this.xs[i + 1]! - ax;
    const dz = this.zs[i + 1]! - az;
    const l2 = dx * dx + dz * dz || 1e-9;
    let t = ((x - ax) * dx + (z - az) * dz) / l2;
    t = Math.min(1, Math.max(0, t));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < out.dist) {
      const l = Math.sqrt(l2);
      out.dist = d;
      out.px = px;
      out.pz = pz;
      out.s = this.cum[i]! + l * t;
      out.halfW = this.hw[i]! + (this.hw[i + 1]! - this.hw[i]!) * t;
      out.tx = dx / l;
      out.tz = dz / l;
    }
  }

  /** Point + tangent at arc length s (clamped). */
  at(s: number, out: PathHit): PathHit {
    const L = this.length;
    const ss = Math.min(L, Math.max(0, s));
    let lo = 0;
    let hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid]! <= ss) lo = mid;
      else hi = mid;
    }
    const seg = this.cum[hi]! - this.cum[lo]! || 1e-9;
    const t = (ss - this.cum[lo]!) / seg;
    const dx = this.xs[hi]! - this.xs[lo]!;
    const dz = this.zs[hi]! - this.zs[lo]!;
    const l = Math.hypot(dx, dz) || 1e-9;
    out.px = this.xs[lo]! + dx * t;
    out.pz = this.zs[lo]! + dz * t;
    out.tx = dx / l;
    out.tz = dz / l;
    out.s = ss;
    out.dist = 0;
    out.halfW = this.hw[lo]! + (this.hw[hi]! - this.hw[lo]!) * t;
    return out;
  }
}
