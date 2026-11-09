/**
 * NetSession: 2-player lobby + connection lifecycle over any Transport.
 *
 *   host  createRoom()  → waits; on HELLO assigns slot 1, answers WELCOME + ROSTER
 *   guest joinRoom(code) → on transport peer-join sends HELLO {token}; WELCOME → 'connected'
 *
 * - Hero pick (only PLAYABLE_HEROES accepted), ready-up, host-only START (both ready) → 'start'
 *   event on both ends with a shared seed and a host-clock start time.
 * - Clock sync: both sides ping every `pingMs` over the unreliable lane; the guest's ClockSync
 *   converges on host time (`hostNow()`), both get RTT.
 * - Drops: a vanished peer keeps its slot for `rejoinWindowMs` (60 s). `peerLeft` fires with
 *   final:false immediately and final:true when the window closes. A guest coming back with the
 *   same token gets its slot (and hero) back.
 * - iOS Safari tears WebRTC down in the background: on `visibilitychange` → visible after a long
 *   hide (or with no peers) the transport is rebuilt via `connect()` and the handshake re-runs.
 */

import { ClockSync, realScheduler, type Scheduler } from './clock';
import type { MessageDef } from './codec';
import {
  type HeroId,
  MSG,
  NET_REGISTRY,
  PLAYABLE_HEROES,
  type PlayerInfo,
  PROTOCOL_VERSION,
  type StartMsg,
} from './protocol';
import type { ConnectPhase } from './tiered';
import { Emitter, type NetTier, randomId, type Transport } from './transport';

export type Role = 'host' | 'guest';
export type SessionState = 'connecting' | 'waiting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export interface SessionStatus {
  state: SessionState;
  role: Role;
  code: string;
  tier: NetTier;
  /** ms, NaN unknown */
  rtt: number;
  phase: ConnectPhase | null;
  /** Seconds left in the rejoin window while 'reconnecting'. */
  rejoinLeftS: number | null;
  error: string | null;
}

export interface StartInfo {
  seed: number;
  /** Host-clock ms at which to start (convert with session.hostNow()). */
  at: number;
  players: PlayerInfo[];
  /** This client's slot. */
  slot: 0 | 1;
}

export interface SessionOptions {
  role: Role;
  code: string;
  /** Builds (or rebuilds after a background drop) the transport. */
  connect: () => Promise<Transport>;
  scheduler?: Scheduler;
  rejoinWindowMs?: number;
  pingMs?: number;
  /** Stable guest identity for rejoin (persist per tab). */
  token?: string;
  /** Listen to document visibility (default: when `document` exists). */
  watchVisibility?: boolean;
  /** Rebuild the transport after being hidden this long (ms). */
  hiddenRebuildMs?: number;
}

type Ev = {
  state: [SessionState];
  status: [SessionStatus];
  roster: [PlayerInfo[]];
  peerJoined: [string];
  peerLeft: [{ peer: string; final: boolean }];
  start: [StartInfo];
  message: [MessageDef<unknown>, unknown, string];
};

export class NetSession {
  readonly role: Role;
  readonly code: string;
  readonly token: string;
  readonly clock = new ClockSync();
  state: SessionState = 'connecting';
  players: PlayerInfo[] = [];
  error: string | null = null;
  private ev: { [K in keyof Ev]: Emitter<Ev[K]> } = {
    state: new Emitter(),
    status: new Emitter(),
    roster: new Emitter(),
    peerJoined: new Emitter(),
    peerLeft: new Emitter(),
    start: new Emitter(),
    message: new Emitter(),
  };
  private t: Transport | null = null;
  private offs: (() => void)[] = [];
  private sched: Scheduler;
  private rejoinMs: number;
  private pingMs: number;
  private pingTimer: unknown = null;
  private rejoinTimer: unknown = null;
  private rejoinDeadline = 0;
  private guestToken: string | null = null;
  private hostPeer: string | null = null;
  private hostRtt = Number.NaN;
  private rebuilding: Promise<void> | null = null;
  private hiddenAt = 0;
  private hiddenRebuildMs: number;
  private visOff: (() => void) | null = null;
  private connectFn: () => Promise<Transport>;

  constructor(opts: SessionOptions) {
    this.role = opts.role;
    this.code = opts.code;
    this.connectFn = opts.connect;
    this.sched = opts.scheduler ?? realScheduler;
    this.rejoinMs = opts.rejoinWindowMs ?? 60_000;
    this.pingMs = opts.pingMs ?? 1000;
    this.token = opts.token ?? randomId(16);
    this.hiddenRebuildMs = opts.hiddenRebuildMs ?? 5000;
    if (opts.watchVisibility ?? typeof document !== 'undefined') this.watchVisibility();
  }

  on<K extends keyof Ev>(name: K, fn: (...a: Ev[K]) => void): () => void {
    return this.ev[name].on(fn);
  }

  get transport(): Transport | null {
    return this.t;
  }
  get selfId(): string {
    return this.t?.selfId ?? '';
  }
  get slot(): 0 | 1 {
    return this.role === 'host' ? 0 : 1;
  }
  get me(): PlayerInfo | undefined {
    return this.players.find((p) => p.slot === this.slot);
  }

  /** Connect and start the lobby protocol. */
  async start(): Promise<void> {
    this.setState('connecting');
    try {
      await this.attach(await this.connectFn());
    } catch (e) {
      this.fail(String((e as Error)?.message ?? e));
      return;
    }
    if (this.role === 'host') {
      this.players = [{ slot: 0, peer: this.selfId, hero: 'inker', ready: false, connected: true }];
      this.emitRoster();
      this.setState('waiting');
    } else if (this.state === 'connecting') {
      this.setState('waiting');
    }
    this.schedulePing();
  }

  private async attach(t: Transport): Promise<void> {
    this.detach();
    this.t = t;
    this.offs.push(
      t.onMessage((d, from) => this.onData(d, from)),
      t.onPeerJoin((id) => this.onPeerJoin(id)),
      t.onPeerLeave((id) => this.onPeerLeave(id)),
    );
    if (t.onTier) this.offs.push(t.onTier(() => this.emitStatus()));
    const ph = (t as { phaseEv?: Emitter<[ConnectPhase]> }).phaseEv;
    if (ph)
      this.offs.push(
        ph.on((p) => {
          if (p === 'failed' && this.state !== 'connected') this.fail('timeout');
          else this.emitStatus();
        }),
      );
    for (const id of t.peers()) this.onPeerJoin(id);
  }

  private detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.t?.close();
    this.t = null;
  }

  // ── state ────────────────────────────────────────────────────────────────────────────────

  private setState(s: SessionState): void {
    if (this.state === s) return;
    this.state = s;
    this.ev.state.emit(s);
    this.emitStatus();
  }

  private fail(reason: string): void {
    this.error = reason;
    this.setState('failed');
  }

  status(): SessionStatus {
    const ph = (this.t as { phase?: ConnectPhase } | null)?.phase ?? null;
    return {
      state: this.state,
      role: this.role,
      code: this.code,
      tier: this.state === 'connected' ? (this.t?.tier ?? 'none') : 'none',
      rtt: this.rtt(),
      phase: ph,
      rejoinLeftS:
        this.rejoinTimer !== null
          ? Math.max(0, Math.ceil((this.rejoinDeadline - this.sched.now()) / 1000))
          : null,
      error: this.error,
    };
  }

  private emitStatus(): void {
    this.ev.status.emit(this.status());
  }

  rtt(): number {
    const own = this.role === 'guest' ? this.clock.rtt : this.hostRtt;
    return Number.isNaN(own) ? (this.t?.rtt() ?? Number.NaN) : own;
  }

  /** Current host-clock time in ms (host: its own clock). */
  hostNow(): number {
    const now = this.sched.now();
    return this.role === 'host' ? now : this.clock.toHost(now);
  }

  private emitRoster(): void {
    this.ev.roster.emit(this.players.map((p) => ({ ...p })));
  }

  private broadcastRoster(): void {
    this.sendMsg(MSG.roster, { players: this.players });
    this.emitRoster();
  }

  // ── messaging ────────────────────────────────────────────────────────────────────────────

  /** Send any registered message (gameplay uses ids ≥ 32). */
  send<T>(def: MessageDef<T>, msg: T, reliable = true, to?: string): void {
    this.sendMsg(def, msg, reliable, to);
  }

  private sendMsg<T>(def: MessageDef<T>, msg: T, reliable = true, to?: string): void {
    const t = this.t;
    if (!t) return;
    const bytes = NET_REGISTRY.encode(def, msg);
    if (reliable) t.sendReliable(bytes, to);
    else t.sendUnreliable(bytes, to);
  }

  /** The peer this session talks to (host: the guest; guest: the host). */
  private partner(): string | undefined {
    return this.role === 'host' ? this.players.find((p) => p.slot === 1)?.peer : (this.hostPeer ?? undefined);
  }

  private onData(data: Uint8Array, from: string): void {
    const dec = NET_REGISTRY.decode(data);
    if (!dec) return;
    const { def, msg } = dec;
    const now = this.sched.now();
    switch (def.id) {
      case MSG.ping.id: {
        const m = msg as { t0: number };
        this.sendMsg(MSG.pong, { t0: m.t0, t1: now, t2: now }, false, from);
        return;
      }
      case MSG.pong.id: {
        const m = msg as { t0: number; t1: number; t2: number };
        if (this.role === 'guest') {
          if (from === this.hostPeer) this.clock.sample(m.t0, m.t1, m.t2, now);
        } else {
          const r = Math.max(0, now - m.t0 - (m.t2 - m.t1));
          this.hostRtt = Number.isNaN(this.hostRtt) ? r : this.hostRtt + (r - this.hostRtt) * 0.3;
        }
        this.emitStatus();
        return;
      }
    }
    if (this.role === 'host') this.onHostMsg(def, msg, from);
    else this.onGuestMsg(def, msg, from);
  }

  private onHostMsg(def: MessageDef<unknown>, msg: unknown, from: string): void {
    const guest = this.players.find((p) => p.slot === 1);
    switch (def.id) {
      case MSG.hello.id: {
        const m = msg as { v: number; token: string };
        if (m.v !== PROTOCOL_VERSION) {
          this.sendMsg(MSG.reject, { reason: 'version' }, true, from);
          return;
        }
        const sameGuest = guest && this.guestToken === m.token;
        if (guest && !sameGuest && guest.connected && this.t?.peers().includes(guest.peer)) {
          this.sendMsg(MSG.reject, { reason: 'full' }, true, from);
          return;
        }
        const g: PlayerInfo = {
          slot: 1,
          peer: from,
          hero: sameGuest ? guest.hero : 'inker',
          ready: sameGuest ? guest.ready : false,
          connected: true,
        };
        this.guestToken = m.token;
        this.players = [this.players[0]!, g];
        this.clearRejoin();
        this.sendMsg(MSG.welcome, { slot: 1, players: this.players }, true, from);
        this.broadcastRoster();
        this.setState('connected');
        this.ev.peerJoined.emit(from);
        return;
      }
      case MSG.pick.id:
      case MSG.ready.id: {
        if (!guest || guest.peer !== from) return;
        if (def.id === MSG.pick.id) {
          const hero = (msg as { hero: HeroId }).hero;
          if (!PLAYABLE_HEROES.includes(hero)) return;
          guest.hero = hero;
        } else guest.ready = !!(msg as { ready: boolean }).ready;
        this.broadcastRoster();
        return;
      }
      case MSG.bye.id:
        if (guest?.peer === from) this.dropGuest(true);
        return;
      default:
        if (guest?.peer === from) this.ev.message.emit(def, msg, from);
    }
  }

  private onGuestMsg(def: MessageDef<unknown>, msg: unknown, from: string): void {
    if (def.id === MSG.welcome.id) {
      this.hostPeer = from;
      this.players = (msg as { players: PlayerInfo[] }).players;
      this.clearRejoin();
      this.emitRoster();
      this.setState('connected');
      this.ev.peerJoined.emit(from);
      this.ping();
      return;
    }
    if (def.id === MSG.reject.id) {
      this.fail((msg as { reason: string }).reason);
      this.detach();
      return;
    }
    if (from !== this.hostPeer) return;
    switch (def.id) {
      case MSG.roster.id:
        this.players = (msg as { players: PlayerInfo[] }).players;
        this.emitRoster();
        return;
      case MSG.start.id: {
        const m = msg as StartMsg;
        this.players = m.players;
        this.ev.start.emit({ seed: m.seed, at: m.at, players: m.players, slot: 1 });
        return;
      }
      case MSG.bye.id:
        this.clearRejoin();
        this.ev.peerLeft.emit({ peer: from, final: true });
        this.fail('host-left');
        return;
      default:
        this.ev.message.emit(def, msg, from);
    }
  }

  // ── peers ────────────────────────────────────────────────────────────────────────────────

  private onPeerJoin(id: string): void {
    if (this.role === 'guest') this.sendMsg(MSG.hello, { v: PROTOCOL_VERSION, token: this.token }, true, id);
    // host waits for HELLO
  }

  private onPeerLeave(id: string): void {
    if (this.state === 'failed' || this.state === 'closed') return;
    if (this.role === 'host') {
      const g = this.players.find((p) => p.slot === 1);
      if (!g || g.peer !== id) return;
      g.connected = false;
      g.ready = false;
      this.emitRoster();
      this.startRejoin(id, () => this.dropGuest(false));
    } else {
      if (id !== this.hostPeer) return;
      this.startRejoin(id, () => this.fail('host-left'));
    }
  }

  private dropGuest(immediate: boolean): void {
    const g = this.players.find((p) => p.slot === 1);
    this.clearRejoin();
    if (!g) return;
    this.players = this.players.filter((p) => p.slot !== 1);
    this.guestToken = null;
    this.players[0]!.ready = false;
    this.emitRoster();
    if (immediate) this.ev.peerLeft.emit({ peer: g.peer, final: false });
    this.ev.peerLeft.emit({ peer: g.peer, final: true });
    this.setState('waiting');
  }

  private startRejoin(peer: string, onExpire: () => void): void {
    this.clearRejoin();
    this.rejoinDeadline = this.sched.now() + this.rejoinMs;
    this.rejoinTimer = this.sched.setTimeout(() => {
      this.rejoinTimer = null;
      if (this.role === 'guest') this.ev.peerLeft.emit({ peer, final: true });
      onExpire();
    }, this.rejoinMs);
    this.setState('reconnecting');
    this.ev.peerLeft.emit({ peer, final: false });
    this.emitStatus();
  }

  private clearRejoin(): void {
    if (this.rejoinTimer !== null) this.sched.clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
  }

  // ── lobby actions ────────────────────────────────────────────────────────────────────────

  pick(hero: HeroId): boolean {
    if (!PLAYABLE_HEROES.includes(hero)) return false;
    const me = this.me;
    if (me) me.hero = hero;
    if (this.role === 'guest') this.sendMsg(MSG.pick, { hero });
    else this.broadcastRoster();
    return true;
  }

  setReady(ready: boolean): void {
    const me = this.me;
    if (me) me.ready = ready;
    if (this.role === 'guest') this.sendMsg(MSG.ready, { ready });
    else this.broadcastRoster();
  }

  /** Host: both players present + ready. */
  canStart(): boolean {
    return (
      this.role === 'host' &&
      this.state === 'connected' &&
      this.players.length === 2 &&
      this.players.every((p) => p.ready && p.connected)
    );
  }

  /** Host only: broadcast START; both ends emit 'start'. Returns false if not startable. */
  requestStart(leadMs = 500): boolean {
    if (!this.canStart()) return false;
    const seed = (Math.random() * 0x7fffffff) | 0;
    const at = this.hostNow() + leadMs;
    this.sendMsg(MSG.start, { seed, at, players: this.players });
    this.ev.start.emit({ seed, at, players: this.players.map((p) => ({ ...p })), slot: 0 });
    return true;
  }

  // ── keepalive / clock ────────────────────────────────────────────────────────────────────

  private ping(): void {
    const to = this.partner();
    if (to) this.sendMsg(MSG.ping, { t0: this.sched.now() }, false, to);
  }

  private schedulePing(): void {
    if (this.pingTimer !== null || this.state === 'closed') return;
    this.pingTimer = this.sched.setTimeout(() => {
      this.pingTimer = null;
      if (this.state === 'closed' || this.state === 'failed') return;
      this.ping();
      if (this.rejoinTimer !== null) this.emitStatus(); // countdown
      this.schedulePing();
    }, this.pingMs);
  }

  // ── background / reconnect ───────────────────────────────────────────────────────────────

  private watchVisibility(): void {
    if (typeof document === 'undefined') return;
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        this.hiddenAt = this.sched.now();
        return;
      }
      const away = this.sched.now() - this.hiddenAt;
      if (this.hiddenAt && (away > this.hiddenRebuildMs || !this.t?.peers().length)) void this.rebuild();
      this.hiddenAt = 0;
    };
    document.addEventListener('visibilitychange', onVis);
    this.visOff = () => document.removeEventListener('visibilitychange', onVis);
  }

  /** Tear down and rebuild the transport (keeps lobby state; guest re-sends HELLO). */
  rebuild(): Promise<void> {
    if (
      this.state === 'closed' ||
      (this.state === 'failed' && this.error !== 'host-left' && this.error !== 'timeout')
    )
      return Promise.resolve();
    this.rebuilding ??= (async () => {
      const partner = this.partner();
      this.detach();
      if (partner && this.state === 'connected') this.onPeerLeaveForRebuild(partner);
      try {
        await this.attach(await this.connectFn());
        if (this.state === 'failed') this.setState(this.role === 'host' ? 'waiting' : 'reconnecting');
      } catch (e) {
        this.fail(String((e as Error)?.message ?? e));
      } finally {
        this.rebuilding = null;
      }
    })();
    return this.rebuilding;
  }

  private onPeerLeaveForRebuild(partner: string): void {
    // the old transport is gone without firing leave events: run the normal drop path
    if (this.role === 'host') {
      const g = this.players.find((p) => p.slot === 1);
      if (g) {
        g.connected = false;
        g.ready = false;
        this.emitRoster();
        this.startRejoin(partner, () => this.dropGuest(false));
      }
    } else this.startRejoin(partner, () => this.fail('host-left'));
  }

  close(): void {
    if (this.state === 'closed') return;
    this.sendMsg(MSG.bye, {});
    if (this.pingTimer !== null) this.sched.clearTimeout(this.pingTimer);
    this.pingTimer = null;
    this.clearRejoin();
    this.visOff?.();
    this.setState('closed');
    // let the BYE flush before closing the channel
    const t = this.t;
    for (const off of this.offs) off();
    this.offs = [];
    this.t = null;
    this.sched.setTimeout(() => t?.close(), 50);
    for (const e of Object.values(this.ev)) e.clear();
  }
}
