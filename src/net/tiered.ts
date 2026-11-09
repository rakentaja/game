/**
 * TieredTransport: the connection ladder.
 *
 *   1. WebRTC, Nostr signaling, STUN (+ static TURN if configured — ICE ranks direct pairs first,
 *      so tier 2 is tried automatically inside the same negotiation; tier is read from stats).
 *      Nostr quiet for `signalFallbackMs` → also join the same room over MQTT signaling.
 *   2. (TURN — see above.)
 *   3. ICE reached 'checking' but not 'connected' within `iceTimeoutMs`, or nothing at all within
 *      `connectTimeoutMs` → open the Firebase relay (only when configured).
 *
 * Whichever candidate first produces a peer becomes active; extra WebRTC candidates are closed.
 * A WebRTC peer appearing while on the relay upgrades back to WebRTC.
 * Candidate factories are injectable so the ladder logic can be unit-tested with loopbacks.
 */
import type { NetConfig } from './config';
import { BaseTransport, Emitter, type Transport } from './transport';

export type ConnectPhase = 'signaling' | 'ice' | 'connected' | 'fallback' | 'failed';

/** A WebRTC candidate: a Transport plus ICE progress signals. */
export interface WebRtcCandidate extends Transport {
  iceFailed?: Emitter<[string]>;
  iceChecking?: Emitter<[]>;
}

export interface TierFactories {
  webrtc(strategy: 'nostr' | 'mqtt'): Promise<WebRtcCandidate>;
  /** null when no relay is configured. */
  relay: ((selfId: string) => Promise<Transport>) | null;
}

interface Cand {
  name: 'nostr' | 'mqtt' | 'relay';
  t: Transport;
  offs: (() => void)[];
}

export class TieredTransport extends BaseTransport {
  phase: ConnectPhase = 'signaling';
  readonly phaseEv = new Emitter<[ConnectPhase]>();
  private cands: Cand[] = [];
  private pending = new Set<string>();
  private active: Cand | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  private constructor(
    selfId: string,
    private cfg: NetConfig,
    private f: TierFactories,
    private isHost: boolean,
  ) {
    super(selfId, 'none');
  }

  static async create(cfg: NetConfig, f: TierFactories, isHost: boolean): Promise<TieredTransport> {
    const first = await f.webrtc('nostr');
    const t = new TieredTransport(first.selfId, cfg, f, isHost);
    t.adopt('nostr', first);
    t.timers.push(
      setTimeout(() => {
        if (!t.active) void t.add('mqtt');
      }, cfg.signalFallbackMs),
      setTimeout(() => t.onConnectTimeout(), cfg.connectTimeoutMs),
    );
    return t;
  }

  private setPhase(p: ConnectPhase): void {
    if (p === this.phase) return;
    this.phase = p;
    this.phaseEv.emit(p);
  }

  private onConnectTimeout(): void {
    if (this.active || this.closed) return;
    if (this.f.relay && !this.has('relay')) {
      void this.add('relay');
      this.timers.push(setTimeout(() => this.onConnectTimeout(), this.cfg.connectTimeoutMs));
    } else if (!this.isHost) this.setPhase('failed');
  }

  private has(name: Cand['name']): boolean {
    return this.pending.has(name) || this.cands.some((c) => c.name === name);
  }

  private async add(name: Cand['name']): Promise<void> {
    if (this.closed || this.has(name)) return;
    if (name === 'relay' && !this.f.relay) return;
    this.pending.add(name);
    try {
      const t = name === 'relay' ? await this.f.relay!(this.selfId) : await this.f.webrtc(name);
      this.pending.delete(name);
      if (this.closed) {
        t.close();
        return;
      }
      this.adopt(name, t);
    } catch (e) {
      this.pending.delete(name);
      console.warn(`[net] ${name} unavailable`, e);
    }
  }

  private adopt(name: Cand['name'], t: Transport): void {
    const c: Cand = { name, t, offs: [] };
    this.cands.push(c);
    c.offs.push(
      t.onMessage((d, from, rel) => {
        if (this.active === c) this.deliver(d, from, rel);
      }),
      t.onPeerJoin((id) => this.candJoined(c, id)),
      t.onPeerLeave(() => this.candLeft(c)),
    );
    if (t.onTier)
      c.offs.push(
        t.onTier((tier) => {
          if (this.active === c) this.setTier(tier);
        }),
      );
    const w = t as WebRtcCandidate;
    if (w.iceChecking)
      c.offs.push(
        w.iceChecking.on(() => {
          if (!this.active) this.setPhase('ice');
        }),
      );
    if (w.iceFailed)
      c.offs.push(
        w.iceFailed.on(() => {
          if (this.active && this.active !== c) return;
          if (this.f.relay) {
            this.setPhase('fallback');
            void this.add('relay');
          } else if (!this.active) this.setPhase('signaling');
        }),
      );
    // a candidate that already has peers (e.g. synchronous loopback)
    for (const id of t.peers()) this.candJoined(c, id);
  }

  private candJoined(c: Cand, id: string): void {
    const upgrade = this.active?.name === 'relay' && c.name !== 'relay';
    if (this.active && !upgrade) return;
    const prev = this.active;
    this.active = c;
    this.setTier(c.t.tier);
    this.setPhase('connected');
    if (prev && prev !== c) {
      for (const p of prev.t.peers()) if (p !== id) this.peerLeft(p);
    }
    this.peerJoined(id);
    // keep only the winner (saves relay quota and duplicate peer connections) — except while on
    // the relay, where WebRTC candidates stay up so they can still upgrade us
    for (const o of [...this.cands]) if (o !== c && (c.name !== 'relay' || o.name === 'relay')) this.drop(o);
  }

  private candLeft(c: Cand): void {
    if (this.active !== c || c.t.peers().length) return;
    for (const p of [...this.peerSet]) this.peerLeft(p);
    this.active = null;
    this.setTier('none');
    this.setPhase('signaling');
    // look for another candidate that still has a peer
    const other = this.cands.find((o) => o !== c && o.t.peers().length);
    if (other) this.candJoined(other, other.t.peers()[0]!);
  }

  private drop(c: Cand): void {
    const i = this.cands.indexOf(c);
    if (i >= 0) this.cands.splice(i, 1);
    for (const off of c.offs) off();
    c.t.close();
  }

  /** Name of the active candidate (for debugging/UI). */
  get via(): string {
    return this.active?.name ?? '';
  }

  sendReliable(data: Uint8Array, to?: string): void {
    this.active?.t.sendReliable(data, to);
  }
  sendUnreliable(data: Uint8Array, to?: string): void {
    this.active?.t.sendUnreliable(data, to);
  }
  override rtt(): number {
    return this.active?.t.rtt() ?? Number.NaN;
  }
  override close(): void {
    if (this.closed) return;
    for (const tm of this.timers) clearTimeout(tm);
    for (const c of [...this.cands]) this.drop(c);
    this.phaseEv.clear();
    super.close();
  }
}
