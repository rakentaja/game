/**
 * Host-side lag compensation for guest bolts ("favor the shooter"): a ring of the last
 * `ticks` host ticks, each holding which enemy ids were alive and revealed. A guest hit tagged
 * with fire tick F is accepted if the target was alive + revealed around F − interpDelay (the
 * guest sees the world that far in the past). Allocation-free after construction.
 */
export class HitHistory {
  private readonly tick: Int32Array;
  private readonly ids: Int32Array;
  private readonly flags: Uint8Array;
  private readonly count: Uint8Array;
  private newest = -1;

  constructor(
    readonly ticks: number,
    readonly perTick = 16,
  ) {
    this.tick = new Int32Array(ticks).fill(-1);
    this.ids = new Int32Array(ticks * perTick);
    this.flags = new Uint8Array(ticks * perTick);
    this.count = new Uint8Array(ticks);
  }

  /** Start recording host tick `t` (overwrites the oldest slot). */
  begin(t: number): void {
    const s = ((t % this.ticks) + this.ticks) % this.ticks;
    this.tick[s] = t;
    this.count[s] = 0;
    this.newest = t;
  }

  /** Record one enemy for the tick passed to `begin`. */
  add(id: number, alive: boolean, revealed: boolean): void {
    const s = ((this.newest % this.ticks) + this.ticks) % this.ticks;
    const n = this.count[s]!;
    if (n >= this.perTick) return;
    this.ids[s * this.perTick + n] = id;
    this.flags[s * this.perTick + n] = (alive ? 1 : 0) | (revealed ? 2 : 0);
    this.count[s] = n + 1;
  }

  /** Oldest tick still in the ring (or -1). */
  get oldest(): number {
    let o = -1;
    for (let i = 0; i < this.ticks; i++) {
      const t = this.tick[i]!;
      if (t >= 0 && (o < 0 || t < o)) o = t;
    }
    return o;
  }

  private stateAt(t: number, id: number): number {
    const s = ((t % this.ticks) + this.ticks) % this.ticks;
    if (this.tick[s] !== t) return -1;
    const n = this.count[s]!;
    for (let k = 0; k < n; k++)
      if (this.ids[s * this.perTick + k] === id) return this.flags[s * this.perTick + k]!;
    return 0;
  }

  /**
   * Was `id` alive and revealed at host tick `t` (± `slack` ticks)? Ticks older than the ring
   * clamp to the oldest recorded one; future ticks clamp to the newest.
   */
  wasHittable(id: number, t: number, slack = 2): boolean {
    if (this.newest < 0) return false;
    const lo = Math.max(this.oldest, Math.min(this.newest, t) - slack);
    const hi = Math.min(this.newest, Math.max(lo, t) + slack);
    for (let k = lo; k <= hi; k++) if ((this.stateAt(k, id) & 3) === 3) return true;
    return false;
  }
}
