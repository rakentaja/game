/**
 * Transport contract for co-op networking. Every implementation (Trystero/WebRTC, Firebase relay,
 * in-memory loopback, BroadcastChannel, the LossyTransport test wrapper) speaks raw bytes over two
 * lanes:
 *   - reliable:   ordered, guaranteed (lobby, gameplay events, acks)
 *   - unreliable: unordered, may drop (snapshots, pings). Implementations that cannot do this
 *                 natively fall back to their reliable lane; callers must tolerate either.
 */

/** Which connection tier is carrying the traffic (surfaced to the UI). */
export type NetTier = 'direct' | 'turn' | 'relay' | 'loopback' | 'none';

export type MessageHandler = (data: Uint8Array, from: string, reliable: boolean) => void;
export type PeerHandler = (peerId: string) => void;

export interface Transport {
  readonly selfId: string;
  /** Current carrying tier; may change while connected (e.g. 'direct' after stats resolve). */
  readonly tier: NetTier;
  /** Send to `to` (or every peer). Never throws; drops silently when nobody is connected. */
  sendReliable(data: Uint8Array, to?: string): void;
  sendUnreliable(data: Uint8Array, to?: string): void;
  onMessage(fn: MessageHandler): () => void;
  onPeerJoin(fn: PeerHandler): () => void;
  onPeerLeave(fn: PeerHandler): () => void;
  /** Called when `tier` changes. */
  onTier?(fn: (tier: NetTier) => void): () => void;
  /** Peer ids currently connected. */
  peers(): readonly string[];
  /** Last measured round-trip time in ms (NaN when unknown). */
  rtt(): number;
  close(): void;
}

/** Tiny listener set used by every transport (no per-message allocation). */
export class Emitter<A extends unknown[]> {
  private fns: ((...a: A) => void)[] = [];
  on(fn: (...a: A) => void): () => void {
    this.fns.push(fn);
    return () => {
      const i = this.fns.indexOf(fn);
      if (i >= 0) this.fns.splice(i, 1);
    };
  }
  emit(...a: A): void {
    for (let i = 0; i < this.fns.length; i++) {
      try {
        this.fns[i]!(...a);
      } catch (e) {
        console.error('[net]', e);
      }
    }
  }
  get size(): number {
    return this.fns.length;
  }
  clear(): void {
    this.fns.length = 0;
  }
}

/** Shared bookkeeping for transports: emitters, peer set, tier. */
export abstract class BaseTransport implements Transport {
  protected readonly msg = new Emitter<[Uint8Array, string, boolean]>();
  protected readonly join = new Emitter<[string]>();
  protected readonly leave = new Emitter<[string]>();
  protected readonly tierEv = new Emitter<[NetTier]>();
  protected readonly peerSet = new Set<string>();
  protected rttMs = Number.NaN;
  protected closed = false;
  private _tier: NetTier;

  constructor(
    readonly selfId: string,
    tier: NetTier,
  ) {
    this._tier = tier;
  }

  get tier(): NetTier {
    return this._tier;
  }
  protected setTier(t: NetTier): void {
    if (t === this._tier) return;
    this._tier = t;
    this.tierEv.emit(t);
  }

  abstract sendReliable(data: Uint8Array, to?: string): void;
  abstract sendUnreliable(data: Uint8Array, to?: string): void;

  onMessage(fn: MessageHandler): () => void {
    return this.msg.on(fn);
  }
  onPeerJoin(fn: PeerHandler): () => void {
    return this.join.on(fn);
  }
  onPeerLeave(fn: PeerHandler): () => void {
    return this.leave.on(fn);
  }
  onTier(fn: (tier: NetTier) => void): () => void {
    return this.tierEv.on(fn);
  }
  peers(): readonly string[] {
    return [...this.peerSet];
  }
  rtt(): number {
    return this.rttMs;
  }

  protected peerJoined(id: string): void {
    if (this.closed || this.peerSet.has(id)) return;
    this.peerSet.add(id);
    this.join.emit(id);
  }
  protected peerLeft(id: string): void {
    if (!this.peerSet.delete(id)) return;
    this.leave.emit(id);
  }
  protected deliver(data: Uint8Array, from: string, reliable: boolean): void {
    if (!this.closed) this.msg.emit(data, from, reliable);
  }

  close(): void {
    if (this.closed) return;
    for (const p of [...this.peerSet]) this.peerLeft(p);
    this.closed = true;
    this.msg.clear();
    this.join.clear();
    this.leave.clear();
    this.tierEv.clear();
  }
}

/** Random peer id (not cryptographic; only needs to be unique within a room). */
export function randomId(len = 12): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += a[bytes[i]! % a.length];
  return s;
}
