/**
 * BroadcastChannel transport (`?nettransport=loopback-bc`): two tabs of the same origin talk with
 * no network at all. Used by the offline e2e test and for local dev. Presence is a hello/heartbeat
 * handshake; a peer silent for `timeoutMs` is considered gone.
 */
import { BaseTransport, randomId } from './transport';

interface BcMsg {
  k: 'hi' | 'hey' | 'bye' | 'hb' | 'm';
  from: string;
  to?: string;
  r?: boolean;
  d?: Uint8Array;
  /** 'hi'/'hey' carry the sender's send time for a cheap RTT estimate. */
  ts?: number;
  echo?: number;
}

export class BroadcastTransport extends BaseTransport {
  private ch: BroadcastChannel;
  private seen = new Map<string, number>();
  private hb: ReturnType<typeof setInterval>;

  constructor(
    room: string,
    selfId = randomId(),
    private timeoutMs = 3500,
  ) {
    super(selfId, 'loopback');
    this.ch = new BroadcastChannel(`inkwake-net:${room}`);
    this.ch.onmessage = (e: MessageEvent<BcMsg>) => this.onRaw(e.data);
    this.post({ k: 'hi', from: selfId, ts: performance.now() });
    this.hb = setInterval(() => {
      this.post({ k: 'hb', from: this.selfId, ts: performance.now() });
      const now = performance.now();
      for (const [id, at] of this.seen) {
        if (now - at > this.timeoutMs) {
          this.seen.delete(id);
          this.peerLeft(id);
        }
      }
    }, 1000);
  }

  private post(m: BcMsg): void {
    if (!this.closed) this.ch.postMessage(m);
  }

  private onRaw(m: BcMsg): void {
    if (this.closed || !m || m.from === this.selfId || (m.to && m.to !== this.selfId)) return;
    const now = performance.now();
    this.seen.set(m.from, now);
    switch (m.k) {
      case 'hi':
        this.post({ k: 'hey', from: this.selfId, to: m.from, echo: m.ts });
        this.peerJoined(m.from);
        break;
      case 'hey':
        if (m.echo !== undefined) this.rttMs = now - m.echo;
        this.peerJoined(m.from);
        break;
      case 'hb':
        // a heartbeat from someone we don't know (we joined while they were hidden): handshake
        if (!this.peerSet.has(m.from)) this.post({ k: 'hi', from: this.selfId, ts: now });
        break;
      case 'bye':
        this.seen.delete(m.from);
        this.peerLeft(m.from);
        break;
      case 'm':
        if (m.d) this.deliver(m.d, m.from, !!m.r);
        break;
    }
  }

  sendReliable(data: Uint8Array, to?: string): void {
    this.post({ k: 'm', from: this.selfId, to, r: true, d: data });
  }
  sendUnreliable(data: Uint8Array, to?: string): void {
    this.post({ k: 'm', from: this.selfId, to, r: false, d: data });
  }

  override close(): void {
    if (this.closed) return;
    this.post({ k: 'bye', from: this.selfId });
    clearInterval(this.hb);
    super.close();
    this.ch.close();
  }
}
