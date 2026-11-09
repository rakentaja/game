/**
 * Time sources. `Scheduler` lets loopback/lossy transports and the session run on a fake clock in
 * unit tests (deterministic) and on performance.now()/setTimeout in the browser.
 */
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Manually advanced clock for tests: timers fire in time order inside `advance()`. */
export class ManualScheduler implements Scheduler {
  private t = 0;
  private seq = 0;
  private timers: { at: number; seq: number; fn: () => void; dead?: boolean }[] = [];

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { at: this.t + Math.max(0, ms), seq: this.seq++, fn };
    this.timers.push(timer);
    return timer;
  }
  clearTimeout(h: unknown): void {
    if (h && typeof h === 'object') (h as { dead?: boolean }).dead = true;
  }
  /** Advance by `ms`, firing every due timer (including ones scheduled while firing). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.timers.length; i++) {
        const tm = this.timers[i]!;
        if (tm.dead || tm.at > end) continue;
        const b = best >= 0 ? this.timers[best]! : null;
        if (!b || tm.at < b.at || (tm.at === b.at && tm.seq < b.seq)) best = i;
      }
      if (best < 0) break;
      const tm = this.timers.splice(best, 1)[0]!;
      this.t = Math.max(this.t, tm.at);
      tm.fn();
    }
    this.timers = this.timers.filter((tm) => !tm.dead);
    this.t = end;
  }
  /** Run until no timers remain (bounded). */
  flush(maxMs = 60_000): void {
    this.advance(maxMs);
  }
}

/**
 * NTP-style clock sync. The client sends `t0` (its clock); the host answers with `t1` (host clock
 * at receive) and `t2` (host clock at send); the client stamps `t3` on arrival.
 *   offset = ((t1 − t0) + (t2 − t3)) / 2      (host − local)
 *   rtt    = (t3 − t0) − (t2 − t1)
 * Offset is smoothed with an EWMA that trusts low-RTT samples more (they have less asymmetric
 * queueing); jitter is an EWMA of |rtt − mean rtt|.
 */
export class ClockSync {
  offset = 0;
  rtt = Number.NaN;
  jitter = 0;
  samples = 0;
  private minRtt = Number.POSITIVE_INFINITY;

  constructor(
    private alpha = 0.15,
    /** First N samples converge faster (plain running average). */
    private warmup = 4,
  ) {}

  /** Feed one ping/pong exchange. Returns the rtt of this sample. */
  sample(t0: number, t1: number, t2: number, t3: number): number {
    const rtt = Math.max(0, t3 - t0 - (t2 - t1));
    const off = (t1 - t0 + (t2 - t3)) / 2;
    this.minRtt = Math.min(this.minRtt, rtt);
    if (this.samples === 0) {
      this.offset = off;
      this.rtt = rtt;
    } else {
      // samples far above the best RTT seen carry queueing asymmetry: weight them down
      const quality = this.minRtt / Math.max(rtt, 1e-3);
      const w = this.samples < this.warmup ? 1 / (this.samples + 1) : this.alpha * Math.max(0.15, quality);
      this.offset += (off - this.offset) * w;
      this.jitter += (Math.abs(rtt - this.rtt) - this.jitter) * Math.min(1, this.alpha * 2);
      this.rtt += (rtt - this.rtt) * this.alpha * 2;
    }
    this.samples++;
    return rtt;
  }

  /** Host clock estimate for a local timestamp. */
  toHost(local: number): number {
    return local + this.offset;
  }
  toLocal(host: number): number {
    return host - this.offset;
  }
  get synced(): boolean {
    return this.samples >= 3;
  }
}
