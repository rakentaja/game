/** In-memory transport pair for tests: whatever one end sends, the other receives on the next tick. */
import { realScheduler, type Scheduler } from './clock';
import { BaseTransport, type NetTier } from './transport';

export class LoopbackTransport extends BaseTransport {
  other: LoopbackTransport | null = null;

  constructor(
    selfId: string,
    private sched: Scheduler = realScheduler,
    /** One-way latency added to each packet (ms). */
    private latency = 0,
    tier: NetTier = 'loopback',
  ) {
    super(selfId, tier);
    this.rttMs = latency * 2;
  }

  /** Connect two ends; both see a peer join on the next tick. */
  static pair(
    a = 'host',
    b = 'guest',
    sched: Scheduler = realScheduler,
    latency = 0,
  ): [LoopbackTransport, LoopbackTransport] {
    const ta = new LoopbackTransport(a, sched, latency);
    const tb = new LoopbackTransport(b, sched, latency);
    ta.other = tb;
    tb.other = ta;
    sched.setTimeout(() => {
      ta.peerJoined(b);
      tb.peerJoined(a);
    }, 0);
    return [ta, tb];
  }

  private send(data: Uint8Array, reliable: boolean, to?: string): void {
    const o = this.other;
    if (this.closed || !o || (to && to !== o.selfId) || !this.peerSet.has(o.selfId)) return;
    const copy = data.slice();
    this.sched.setTimeout(() => o.deliver(copy, this.selfId, reliable), this.latency);
  }
  sendReliable(data: Uint8Array, to?: string): void {
    this.send(data, true, to);
  }
  sendUnreliable(data: Uint8Array, to?: string): void {
    this.send(data, false, to);
  }

  /** Simulate the link dropping (both ends see peer-leave). */
  disconnect(): void {
    const o = this.other;
    if (!o) return;
    this.peerLeft(o.selfId);
    o.peerLeft(this.selfId);
  }
  /** Re-establish after `disconnect()`. */
  reconnect(): void {
    const o = this.other;
    if (!o || this.closed || o.closed) return;
    this.sched.setTimeout(() => {
      this.peerJoined(o.selfId);
      o.peerJoined(this.selfId);
    }, this.latency);
  }

  override close(): void {
    const o = this.other;
    super.close();
    if (o) o.peerLeft(this.selfId);
  }
}
