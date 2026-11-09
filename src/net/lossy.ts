/**
 * LossyTransport: wraps any Transport and degrades its *outgoing* traffic with seeded latency,
 * jitter, loss and reordering. Wrap both ends to simulate a symmetric link (rtt is split in half
 * per direction). Reliable traffic is delayed but never dropped or reordered, like an SCTP stream.
 *
 * `?netsim=rtt150,jit40,loss3,ro5,seed9` → parseNetsim() → LossyOptions.
 */
import { realScheduler, type Scheduler } from './clock';
import { mulberry32 } from './rng';
import type { MessageHandler, NetTier, PeerHandler, Transport } from './transport';

export interface LossyOptions {
  /** Round-trip time to add (ms); each direction gets half. */
  rtt: number;
  /** ± jitter per packet (ms, uniform). */
  jitter: number;
  /** Unreliable drop probability 0..1. */
  loss: number;
  /** Probability 0..1 an unreliable packet is held back an extra rtt/2 (arrives out of order). */
  reorder: number;
  seed: number;
}

export const NETSIM_DEFAULTS: LossyOptions = { rtt: 0, jitter: 0, loss: 0, reorder: 0, seed: 1 };

/** Parse a `?netsim=` value like "rtt150,jit40,loss3" (loss/reorder in percent). null if empty. */
export function parseNetsim(spec: string | null | undefined): LossyOptions | null {
  if (!spec) return null;
  const o: LossyOptions = { ...NETSIM_DEFAULTS };
  let any = false;
  for (const tok of spec.split(/[,;\s]+/)) {
    const m = /^([a-z]+)(-?\d+(?:\.\d+)?)$/i.exec(tok.trim());
    if (!m) continue;
    const v = Number(m[2]);
    switch (m[1]!.toLowerCase()) {
      case 'rtt':
        o.rtt = Math.max(0, v);
        break;
      case 'jit':
      case 'jitter':
        o.jitter = Math.max(0, v);
        break;
      case 'loss':
        o.loss = Math.min(1, Math.max(0, v / 100));
        break;
      case 'ro':
      case 'reorder':
        o.reorder = Math.min(1, Math.max(0, v / 100));
        break;
      case 'seed':
        o.seed = v | 0;
        break;
      default:
        continue;
    }
    any = true;
  }
  return any ? o : null;
}

export class LossyTransport implements Transport {
  readonly opts: LossyOptions;
  private rand: () => number;
  /** Last scheduled delivery time per lane, to keep reliable traffic ordered. */
  private lastReliableAt = 0;
  private timers = new Set<unknown>();
  /** Counters for tests/HUD. */
  stats = { sent: 0, dropped: 0, reordered: 0 };

  constructor(
    readonly inner: Transport,
    opts: Partial<LossyOptions>,
    private sched: Scheduler = realScheduler,
  ) {
    this.opts = { ...NETSIM_DEFAULTS, ...opts };
    this.rand = mulberry32(this.opts.seed);
  }

  get selfId(): string {
    return this.inner.selfId;
  }
  get tier(): NetTier {
    return this.inner.tier;
  }

  private delay(): number {
    const j = this.opts.jitter ? (this.rand() * 2 - 1) * this.opts.jitter : 0;
    return Math.max(0, this.opts.rtt / 2 + j);
  }

  private later(fn: () => void, ms: number): void {
    const h = this.sched.setTimeout(() => {
      this.timers.delete(h);
      fn();
    }, ms);
    this.timers.add(h);
  }

  sendReliable(data: Uint8Array, to?: string): void {
    this.stats.sent++;
    const now = this.sched.now();
    const at = Math.max(now + this.delay(), this.lastReliableAt);
    this.lastReliableAt = at;
    const copy = data.slice();
    this.later(() => this.inner.sendReliable(copy, to), at - now);
  }

  sendUnreliable(data: Uint8Array, to?: string): void {
    this.stats.sent++;
    // always consume the same number of random draws per packet → deterministic regardless of path
    const rLoss = this.rand();
    const rRe = this.rand();
    let d = this.delay();
    if (rLoss < this.opts.loss) {
      this.stats.dropped++;
      return;
    }
    if (rRe < this.opts.reorder) {
      this.stats.reordered++;
      d += Math.max(10, this.opts.rtt / 2 + this.opts.jitter);
    }
    const copy = data.slice();
    this.later(() => this.inner.sendUnreliable(copy, to), d);
  }

  onMessage(fn: MessageHandler): () => void {
    return this.inner.onMessage(fn);
  }
  onPeerJoin(fn: PeerHandler): () => void {
    return this.inner.onPeerJoin(fn);
  }
  onPeerLeave(fn: PeerHandler): () => void {
    return this.inner.onPeerLeave(fn);
  }
  onTier(fn: (tier: NetTier) => void): () => void {
    return this.inner.onTier?.(fn) ?? (() => {});
  }
  peers(): readonly string[] {
    return this.inner.peers();
  }
  rtt(): number {
    const r = this.inner.rtt();
    return (Number.isNaN(r) ? 0 : r) + this.opts.rtt;
  }
  close(): void {
    for (const h of this.timers) this.sched.clearTimeout(h);
    this.timers.clear();
    this.inner.close();
  }
}
