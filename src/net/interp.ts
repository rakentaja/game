/**
 * SnapshotInterpolator: buffers per-entity samples stamped with *host* time and renders remote
 * entities at `hostNow − D`, where D = clamp(snapshotInterval + 2·jitter, 80, 250) ms.
 * Between samples it uses cubic Hermite with the sampled velocities (smooth at 12–20 Hz); past the
 * newest sample it extrapolates linearly for at most 150 ms, then holds.
 * Fixed-capacity typed arrays per entity: no per-frame allocation.
 */

export interface InterpOptions {
  minDelayMs: number;
  maxDelayMs: number;
  maxExtrapolateMs: number;
  /** Samples kept per entity. */
  capacity: number;
  /** EWMA factor for the interval/jitter estimates. */
  alpha: number;
}

export const INTERP_DEFAULTS: InterpOptions = {
  minDelayMs: 80,
  maxDelayMs: 250,
  maxExtrapolateMs: 150,
  capacity: 32,
  alpha: 0.1,
};

export interface InterpSample {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** True when past the newest sample (extrapolated or held). */
  extrapolated: boolean;
}

class Track {
  n = 0;
  readonly t: Float64Array;
  readonly p: Float64Array;
  readonly v: Float64Array;
  readonly yaw: Float64Array;
  readonly hasV: Uint8Array;
  constructor(readonly cap: number) {
    this.t = new Float64Array(cap);
    this.p = new Float64Array(cap * 3);
    this.v = new Float64Array(cap * 3);
    this.yaw = new Float64Array(cap);
    this.hasV = new Uint8Array(cap);
  }

  private move(from: number, to: number): void {
    this.t[to] = this.t[from]!;
    this.yaw[to] = this.yaw[from]!;
    this.hasV[to] = this.hasV[from]!;
    for (let k = 0; k < 3; k++) {
      this.p[to * 3 + k] = this.p[from * 3 + k]!;
      this.v[to * 3 + k] = this.v[from * 3 + k]!;
    }
  }

  /** Insert keeping time order; returns the index (−1 if duplicate/too old). */
  insert(t: number): number {
    if (this.n === this.cap) {
      if (t <= this.t[0]!) return -1;
      for (let i = 1; i < this.n; i++) this.move(i, i - 1);
      this.n--;
    }
    let i = this.n;
    while (i > 0 && this.t[i - 1]! > t) i--;
    if (i > 0 && this.t[i - 1] === t) return -1;
    for (let j = this.n; j > i; j--) this.move(j - 1, j);
    this.n++;
    this.t[i] = t;
    return i;
  }

  /** Fill in velocities for samples that arrived without one (finite differences). */
  deriveVel(i: number): void {
    for (let j = Math.max(0, i - 1); j <= Math.min(this.n - 1, i + 1); j++) {
      if (this.hasV[j]) continue;
      const a = j > 0 ? j - 1 : j;
      const b = j < this.n - 1 ? j + 1 : j;
      const dt = (this.t[b]! - this.t[a]!) / 1000;
      for (let k = 0; k < 3; k++)
        this.v[j * 3 + k] = dt > 0 ? (this.p[b * 3 + k]! - this.p[a * 3 + k]!) / dt : 0;
    }
  }
}

const TAU = Math.PI * 2;
function lerpAngle(a: number, b: number, s: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return a + d * s;
}

export class SnapshotInterpolator {
  readonly opts: InterpOptions;
  private tracks = new Map<number, Track>();
  private lastSnapTime = Number.NaN;
  /** EWMA of the host-time interval between snapshots (ms). */
  interval = 1000 / 12;
  /** EWMA of arrival jitter (ms); also settable from ClockSync. */
  jitter = 0;
  private transitMean = Number.NaN;

  constructor(opts: Partial<InterpOptions> = {}) {
    this.opts = { ...INTERP_DEFAULTS, ...opts };
  }

  /** Render delay D in ms. */
  delay(): number {
    const d = this.interval + 2 * this.jitter;
    return Math.min(this.opts.maxDelayMs, Math.max(this.opts.minDelayMs, d));
  }

  /**
   * Note a whole snapshot arriving (once per packet, not per entity). `localArrival` and
   * `localToHost` (both optional) feed the arrival-jitter estimate.
   */
  noteSnapshot(hostTime: number, localArrivalInHostTime?: number): void {
    const a = this.opts.alpha;
    if (!Number.isNaN(this.lastSnapTime) && hostTime > this.lastSnapTime) {
      const dt = hostTime - this.lastSnapTime;
      if (dt < 1000) this.interval += (dt - this.interval) * a;
    }
    if (hostTime > this.lastSnapTime || Number.isNaN(this.lastSnapTime)) this.lastSnapTime = hostTime;
    if (localArrivalInHostTime !== undefined) {
      const transit = localArrivalInHostTime - hostTime;
      if (Number.isNaN(this.transitMean)) this.transitMean = transit;
      else {
        this.jitter += (Math.abs(transit - this.transitMean) - this.jitter) * a;
        this.transitMean += (transit - this.transitMean) * a;
      }
    }
  }

  /** Add a sample. Velocity (m/s) is optional; derived from neighbours if omitted. */
  push(
    id: number,
    hostTime: number,
    x: number,
    y: number,
    z: number,
    yaw = 0,
    vel?: ArrayLike<number>,
  ): void {
    let tr = this.tracks.get(id);
    if (!tr) {
      tr = new Track(this.opts.capacity);
      this.tracks.set(id, tr);
    }
    const i = tr.insert(hostTime);
    if (i < 0) return;
    tr.p[i * 3] = x;
    tr.p[i * 3 + 1] = y;
    tr.p[i * 3 + 2] = z;
    tr.yaw[i] = yaw;
    if (vel) {
      tr.hasV[i] = 1;
      tr.v[i * 3] = vel[0] ?? 0;
      tr.v[i * 3 + 1] = vel[1] ?? 0;
      tr.v[i * 3 + 2] = vel[2] ?? 0;
    } else {
      tr.hasV[i] = 0;
    }
    tr.deriveVel(i);
  }

  remove(id: number): void {
    this.tracks.delete(id);
  }
  clear(): void {
    this.tracks.clear();
    this.lastSnapTime = Number.NaN;
  }
  has(id: number): boolean {
    return (this.tracks.get(id)?.n ?? 0) > 0;
  }
  ids(): IterableIterator<number> {
    return this.tracks.keys();
  }

  /** Sample entity `id` for display at `hostNow − delay()`. */
  sample(id: number, hostNow: number, out: InterpSample): boolean {
    return this.sampleAt(id, hostNow - this.delay(), out);
  }

  /** Sample at an explicit host render time. */
  sampleAt(id: number, rt: number, out: InterpSample): boolean {
    const tr = this.tracks.get(id);
    if (!tr || tr.n === 0) return false;
    const n = tr.n;
    const { t, p, v } = tr;
    if (rt <= t[0]! || n === 1) {
      if (n === 1 && rt > t[0]!) return this.extrapolate(tr, 0, rt, out);
      out.x = p[0]!;
      out.y = p[1]!;
      out.z = p[2]!;
      out.yaw = tr.yaw[0]!;
      out.extrapolated = false;
      return true;
    }
    if (rt >= t[n - 1]!) return this.extrapolate(tr, n - 1, rt, out);
    let b = 1;
    while (b < n - 1 && t[b]! < rt) b++;
    const a = b - 1;
    const dtMs = t[b]! - t[a]!;
    const s = dtMs > 0 ? (rt - t[a]!) / dtMs : 1;
    const dt = dtMs / 1000;
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    const ia = a * 3;
    const ib = b * 3;
    out.x = h00 * p[ia]! + h10 * dt * v[ia]! + h01 * p[ib]! + h11 * dt * v[ib]!;
    out.y = h00 * p[ia + 1]! + h10 * dt * v[ia + 1]! + h01 * p[ib + 1]! + h11 * dt * v[ib + 1]!;
    out.z = h00 * p[ia + 2]! + h10 * dt * v[ia + 2]! + h01 * p[ib + 2]! + h11 * dt * v[ib + 2]!;
    out.yaw = lerpAngle(tr.yaw[a]!, tr.yaw[b]!, s);
    out.extrapolated = false;
    // drop samples the render clock has passed (keep one before rt for the next segment)
    if (a > 1) this.trim(tr, a - 1);
    return true;
  }

  private extrapolate(tr: Track, i: number, rt: number, out: InterpSample): boolean {
    const dt = Math.min(rt - tr.t[i]!, this.opts.maxExtrapolateMs) / 1000;
    out.x = tr.p[i * 3]! + tr.v[i * 3]! * dt;
    out.y = tr.p[i * 3 + 1]! + tr.v[i * 3 + 1]! * dt;
    out.z = tr.p[i * 3 + 2]! + tr.v[i * 3 + 2]! * dt;
    out.yaw = tr.yaw[i]!;
    out.extrapolated = true;
    return true;
  }

  private trim(tr: Track, count: number): void {
    for (let i = count; i < tr.n; i++) {
      tr.t[i - count] = tr.t[i]!;
      tr.yaw[i - count] = tr.yaw[i]!;
      tr.hasV[i - count] = tr.hasV[i]!;
      for (let k = 0; k < 3; k++) {
        tr.p[(i - count) * 3 + k] = tr.p[i * 3 + k]!;
        tr.v[(i - count) * 3 + k] = tr.v[i * 3 + k]!;
      }
    }
    tr.n -= count;
  }
}
