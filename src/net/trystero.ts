/**
 * TrysteroTransport: serverless WebRTC. Signaling goes over public Nostr relays (default) or MQTT
 * brokers (fallback); media never touches them, and SDP is encrypted with the room code as the
 * Trystero room password.
 *
 * Lanes:
 *   reliable   → a Trystero action ('r'), which rides Trystero's ordered+reliable data channel.
 *   unreliable → our own *negotiated* RTCDataChannel (id 99, {ordered:false, maxRetransmits:0})
 *                on the same RTCPeerConnection. Trystero has no unreliable actions, so we hand it
 *                an RTCPeerConnection subclass (`rtcPolyfill`) that adds the channel and lets us
 *                watch ICE state. If the channel can't be opened, unreliable traffic falls back
 *                to a second Trystero action ('u') — still reliable/ordered, just a separate lane.
 *
 * ICE servers = STUN + configured static TURN. ICE itself prefers host/srflx candidate pairs over
 * relay ones, so "direct first, TURN second" happens inside one negotiation; the tier we report
 * comes from getStats() (selected pair's local candidate type === 'relay' → 'turn').
 *
 * This module is only ever reached through dynamic import (solo players never download it).
 */
import type { NetConfig } from './config';
import { BaseTransport, Emitter } from './transport';

type TrysteroRoom = import('trystero').Room;
type JoinRoomFn = (
  config: Record<string, unknown>,
  roomId: string,
  callbacks?: Record<string, unknown>,
) => TrysteroRoom;

export type SignalStrategy = 'nostr' | 'mqtt';

const UNRELIABLE_ID = 99;
const UNRELIABLE_OPTS: RTCDataChannelInit = {
  negotiated: true,
  id: UNRELIABLE_ID,
  ordered: false,
  maxRetransmits: 0,
};

async function loadStrategy(s: SignalStrategy): Promise<{ joinRoom: JoinRoomFn; selfId: string }> {
  // separate chunks: MQTT (and its ~60 KB client) is only fetched if Nostr signaling stalls
  const mod = s === 'mqtt' ? await import('@trystero-p2p/mqtt') : await import('trystero');
  return mod as unknown as { joinRoom: JoinRoomFn; selfId: string };
}

export interface TrysteroOptions {
  room: string;
  strategy: SignalStrategy;
  config: NetConfig;
}

export class TrysteroTransport extends BaseTransport {
  /** Fired when a peer connection got as far as ICE checking but did not connect in time. */
  readonly iceFailed = new Emitter<[string]>();
  /** Fired once ICE checking starts for some peer (signaling worked). */
  readonly iceChecking = new Emitter<[]>();
  readonly strategy: SignalStrategy;
  private room!: TrysteroRoom;
  private sendR!: (d: Uint8Array, opts?: { target?: string }) => Promise<void>;
  private sendUFallback!: (d: Uint8Array, opts?: { target?: string }) => Promise<void>;
  private channels = new WeakMap<RTCPeerConnection, RTCDataChannel>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private iceTimers = new Set<ReturnType<typeof setTimeout>>();

  private constructor(selfId: string, strategy: SignalStrategy) {
    super(selfId, 'direct');
    this.strategy = strategy;
  }

  static async create(opts: TrysteroOptions): Promise<TrysteroTransport> {
    const { joinRoom, selfId } = await loadStrategy(opts.strategy);
    const t = new TrysteroTransport(selfId, opts.strategy);
    t.init(joinRoom, opts);
    return t;
  }

  private init(joinRoom: JoinRoomFn, { room, strategy, config }: TrysteroOptions): void {
    const self = this;
    const Native = globalThis.RTCPeerConnection;
    class TrackedPeerConnection extends Native {
      constructor(cfg?: RTCConfiguration) {
        super(cfg);
        try {
          const ch = this.createDataChannel('u', UNRELIABLE_OPTS);
          ch.binaryType = 'arraybuffer';
          self.wireChannel(this, ch);
        } catch {
          /* fall back to the reliable 'u' action */
        }
        let timer: ReturnType<typeof setTimeout> | null = null;
        this.addEventListener('iceconnectionstatechange', () => {
          const st = this.iceConnectionState;
          if (st === 'checking' && !timer) {
            self.iceChecking.emit();
            timer = setTimeout(() => {
              if (timer) self.iceTimers.delete(timer);
              const s = this.iceConnectionState;
              if (s !== 'connected' && s !== 'completed' && !self.closed) self.iceFailed.emit(s);
            }, config.iceTimeoutMs);
            self.iceTimers.add(timer);
          } else if (st === 'connected' || st === 'completed') {
            if (timer) {
              clearTimeout(timer);
              self.iceTimers.delete(timer);
            }
          } else if (st === 'failed' && !self.closed) {
            self.iceFailed.emit(st);
          }
        });
      }
    }

    const iceServers: RTCIceServer[] = [{ urls: config.stun }, ...config.turn];
    const relayUrls = strategy === 'mqtt' ? config.mqttRelays : config.nostrRelays;
    this.room = joinRoom(
      {
        appId: config.appId,
        password: `inkwake:${room}`,
        rtcConfig: { iceServers },
        rtcPolyfill: TrackedPeerConnection,
        relayConfig: {
          ...(relayUrls.length ? { urls: relayUrls } : {}),
          ...(strategy === 'nostr' ? { redundancy: config.nostrRedundancy } : {}),
          warnOnRelayFailure: false,
        },
      },
      room,
      {
        onJoinError: (e: { error: string }) => {
          if (/could not connect/i.test(e.error)) this.iceFailed.emit(e.error);
        },
      },
    );

    const r = this.room.makeAction<Uint8Array>('r');
    const u = this.room.makeAction<Uint8Array>('u');
    this.sendR = (d, o) => r.send(d, o);
    this.sendUFallback = (d, o) => u.send(d, o);
    r.onMessage = (data, ctx) => this.deliver(toBytes(data), ctx.peerId, true);
    u.onMessage = (data, ctx) => this.deliver(toBytes(data), ctx.peerId, false);

    this.room.onPeerJoin = (id) => {
      this.peerJoined(id);
      void this.refreshStats();
    };
    this.room.onPeerLeave = (id) => this.peerLeft(id);
    this.statsTimer = setInterval(() => void this.refreshStats(), 2000);
  }

  private wireChannel(pc: RTCPeerConnection, ch: RTCDataChannel): void {
    this.channels.set(pc, ch);
    ch.onmessage = (e) => {
      const id = this.peerIdOf(pc);
      if (id) this.deliver(toBytes(e.data), id, false);
    };
  }

  private peerIdOf(pc: RTCPeerConnection): string | null {
    const peers = this.room?.getPeers() ?? {};
    for (const id in peers) if (peers[id] === pc) return id;
    return null;
  }

  sendReliable(data: Uint8Array, to?: string): void {
    if (this.closed || !this.peerSet.size) return;
    this.sendR(data, to ? { target: to } : undefined).catch(() => {});
  }

  sendUnreliable(data: Uint8Array, to?: string): void {
    if (this.closed || !this.peerSet.size) return;
    const peers = this.room.getPeers();
    for (const id of this.peerSet) {
      if (to && id !== to) continue;
      const pc = peers[id];
      const ch = pc && this.channels.get(pc);
      if (ch && ch.readyState === 'open') {
        // drop rather than queue when congested: stale snapshots are worthless
        if (ch.bufferedAmount < 64 * 1024) ch.send(data as Uint8Array<ArrayBuffer>);
      } else {
        this.sendUFallback(data, { target: id }).catch(() => {});
      }
    }
  }

  /** Selected candidate pair → tier + RTT. */
  private async refreshStats(): Promise<void> {
    if (this.closed) return;
    const peers = this.room.getPeers();
    for (const id of this.peerSet) {
      const pc = peers[id];
      if (!pc) continue;
      try {
        const stats = await pc.getStats();
        let pair: RTCIceCandidatePairStats | undefined;
        stats.forEach((s) => {
          if (s.type === 'transport' && s.selectedCandidatePairId)
            pair = stats.get(s.selectedCandidatePairId);
        });
        if (!pair)
          stats.forEach((s) => {
            if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || !pair)) pair = s;
          });
        if (!pair) continue;
        const local = stats.get(pair.localCandidateId) as { candidateType?: string } | undefined;
        this.setTier(local?.candidateType === 'relay' ? 'turn' : 'direct');
        if (pair.currentRoundTripTime !== undefined) this.rttMs = pair.currentRoundTripTime * 1000;
        else this.rttMs = await this.room.ping(id);
      } catch {
        /* peer went away mid-query */
      }
      return; // 2-player game: first peer is the one that matters
    }
  }

  override close(): void {
    if (this.closed) return;
    if (this.statsTimer) clearInterval(this.statsTimer);
    for (const t of this.iceTimers) clearTimeout(t);
    this.iceTimers.clear();
    this.iceFailed.clear();
    this.iceChecking.clear();
    super.close();
    void this.room?.leave().catch(() => {});
  }
}

function toBytes(d: unknown): Uint8Array {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return new Uint8Array(0);
}
