/**
 * Online co-op runtime (2 players) over a NetSession.
 *
 * Authority (docs/COOP.md "Gameplay sync"):
 *  - HOST owns the world: enemies, projectiles, spawner/director, boss FSM, sketches, triggers,
 *    pickups, crit rules. It streams 20 Hz delta snapshots (≤ 12 nearest enemies, boss block,
 *    host wizard) + reliable tick-tagged events.
 *  - EACH CLIENT owns its own wizard (movement/dash/crystal/ink, no reconciliation): the guest
 *    streams its state at 30 Hz with the last 3 states repeated (loss cover).
 *  - Guest bolts: favor the shooter — the guest flashes the hit at once and asks the host, who
 *    validates "alive + revealed" in a 250 ms per-tick history at fireTick − interpDelay and
 *    refunds the ink if it rejects.
 *  - Player damage: favor the victim — scribbler strokes and Editor lanes are simulated on both
 *    machines from spawn params and each tests its own wizard; ghost contact on the host uses the
 *    guest's newest position with a 0.1 m smaller radius.
 *  - Shared panel cuts, boss phase cuts and page turns: host schedules them at tick + 6 and both
 *    play them then. Hit-stop and crit cuts stay local.
 *  - Reveal history is rebuilt locally from the synced crystal positions + events (only sent in
 *    full, RLE-compressed, on a rejoin).
 *  - Partner drop: fades out over 10 s, the run continues solo (scaling eases back over 3 s), the
 *    seat is held for 60 s. Host drop: the guest waits 10 s, then takes over solo from the
 *    replicated page save.
 */
import * as THREE from 'three';
import type { GameEvents } from '../core/events';
import type { DamageSource, EliteAffix, EnemyKind, PageId, PlayerSlot } from '../core/types';
import { PAL } from '../data/palette';
import type { Editor } from '../entities/Editor/Editor';
import type { AttackKind, Hand } from '../entities/Editor/fsm';
import type { Enemy } from '../entities/enemies/Enemy';
import { ELITE_INDEX, KIND_INDEX } from '../entities/enemies/Enemy';
import type { LoadedCharacter } from '../entities/Player';
import type { MessageDef } from '../net/codec';
import { INTERP_DEFAULTS, type InterpSample, SnapshotInterpolator } from '../net/interp';
import type { NetSession } from '../net/session';
import { SnapshotDecoder, SnapshotEncoder } from '../net/snapshot';
import type { RevealSystem } from '../render/reveal/RevealSystem';
import { AiState } from '../systems/ai/fsm';
import { PartnerHud } from '../ui/hud/partner';
import { interceptEmit } from './bus';
import { HitHistory } from './history';
import { levelHooks } from './level';
import { captureRamps } from './look';
import { loadWizardModel } from './model';
import { PickupRouter } from './pickups';
import {
  crystalView,
  EnemyMirror,
  exportHistory,
  fireReplica,
  importHistory,
  installCoopTargeting,
  markSpent,
  spentIds,
} from './puppet';
import { RemotePlayer } from './RemotePlayer';
import { CoopRules, type Member } from './rules';
import type { CoopHost, CoopSession } from './types';
import {
  ATTACK_STAGES,
  BOSS_STATES,
  type BossBlock,
  COOP_MSG,
  type CoopEvent,
  EF,
  ENEMY_SCHEMA,
  type EvtMsg,
  emptyBoss,
  emptyWiz,
  fromB64,
  HP_SCALE,
  MSG_EVT,
  MSG_PSTATE,
  MSG_SNAP,
  MSG_SYNC,
  type PageSave,
  type PStateMsg,
  rleDecode,
  rleEncode,
  type SnapMsg,
  type SyncMsg,
  toB64,
  WF,
  type WizState,
} from './wire';

const KINDS = Object.keys(KIND_INDEX) as EnemyKind[];
const ELITES: (EliteAffix | null)[] = [null, 'firstEdition', 'inkedIn', 'bleedThrough'];
/** Panel-cut reasons that stay on the machine that produced them. */
function localCut(reason: string): boolean {
  return reason.includes('crit') || reason.startsWith('coop:') || reason.startsWith('first-');
}

const _row = new Float64Array(ENEMY_SCHEMA.size);
const _is: InterpSample = { x: 0, y: 0, z: 0, yaw: 0, extrapolated: false };
const _from = new THREE.Vector3();
const I = {
  kind: ENEMY_SCHEMA.idx('kind'),
  state: ENEMY_SCHEMA.idx('state'),
  x: ENEMY_SCHEMA.idx('x'),
  z: ENEMY_SCHEMA.idx('z'),
  yaw: ENEMY_SCHEMA.idx('yaw'),
  hp: ENEMY_SCHEMA.idx('hp'),
  flags: ENEMY_SCHEMA.idx('flags'),
  windup: ENEMY_SCHEMA.idx('windup'),
  lunge: ENEMY_SCHEMA.idx('lunge'),
  drain: ENEMY_SCHEMA.idx('drain'),
  shield: ENEMY_SCHEMA.idx('shield'),
  expose: ENEMY_SCHEMA.idx('expose'),
  align: ENEMY_SCHEMA.idx('align'),
  box: ENEMY_SCHEMA.idx('box'),
};

export interface NetCoopOptions {
  session: NetSession;
  slot: PlayerSlot;
  seed: number;
  heroes: string[];
  /** Resume from a host SYNC (fresh tab rejoining a running issue). */
  sync?: SyncMsg | null;
  /** Expose `window.__net` + `<html data-coop…>` (default: when a DOM exists). */
  expose?: boolean;
}

interface Scheduled {
  at: number;
  run: () => void;
}

export class NetCoop implements CoopSession {
  readonly kind: 'host' | 'guest';
  readonly authority: boolean;
  readonly slot: PlayerSlot;
  readonly partnerSlot: PlayerSlot;
  readonly remote: RemotePlayer;
  readonly rules: CoopRules;
  readonly members: Member[];
  readonly history: HitHistory;
  /** Host sim ticks (host) / local ticks (guest). */
  tick = 0;
  /** Page/respawn generation: events of another epoch wait (or are dropped). */
  epoch = 0;
  /** Partner left and the run went solo. */
  solo = false;
  /** Stats for tests / HUD. */
  readonly stats = { snapsSent: 0, snapsRecv: 0, hitReq: 0, hitOk: 0, hitRejected: 0, refunded: 0 };
  save: PageSave = { page: '1', cp: '', printed: [], spent: [], cleared: [], boss: null };

  private readonly mirror: EnemyMirror;
  private readonly s: NetSession;
  private readonly host: CoopHost;
  private readonly offs: (() => void)[] = [];
  private readonly queue: CoopEvent[] = [];
  private readonly later: EvtMsg[] = [];
  private readonly sched: Scheduled[] = [];
  private readonly filter: ReturnType<typeof interceptEmit>;
  private hud: PartnerHud | null = null;
  private router: PickupRouter | null = null;
  // host
  private enc = new SnapshotEncoder(ENEMY_SCHEMA);
  private lastSeq = -1;
  private suppBase = 0;
  private supp = 1;
  private fadeT = -1;
  // guest
  private dec = new SnapshotDecoder(ENEMY_SCHEMA);
  private readonly enemyInterp = new SnapshotInterpolator({ ...INTERP_DEFAULTS });
  private readonly rows = new Map<number, Float64Array>();
  private boss: BossBlock | null = null;
  private lastSnapTick = 0;
  private lastSnapTime = Number.NaN;
  private recvSupp = 1;
  private readonly myStates: { seq: number; time: number; s: WizState }[] = [];
  private seq = 0;
  private hitSeq = 0;
  private readonly pendingHits = new Map<number, number>();
  private hostLostT = -1;
  private castSerial = 0;
  private bossState = 0;
  private readonly dv = [
    { pos: new THREE.Vector3(), revive: 0, on: false },
    { pos: new THREE.Vector3(), revive: 0, on: false },
  ];
  private readonly expose: boolean;
  private pendingSync: SyncMsg | null;
  private disposed = false;

  constructor(host: CoopHost, model: LoadedCharacter | null, o: NetCoopOptions) {
    this.host = host;
    this.s = o.session;
    this.kind = o.session.role;
    this.authority = this.kind === 'host';
    this.slot = o.slot;
    this.partnerSlot = (1 - o.slot) as PlayerSlot;
    this.expose = o.expose ?? typeof document !== 'undefined';
    this.pendingSync = o.sync ?? null;
    const ctx = host.ctx;
    const T = ctx.tuning;
    this.history = new HitHistory(Math.max(4, Math.ceil(T.coop.net.historyMs / (1000 / T.sim.hz))));
    (ctx.reveal as RevealSystem).setDual(true);
    host.player.slot = this.slot;
    captureRamps(host.player.object);
    this.remote = new RemotePlayer(ctx, this.partnerSlot, model, PAL.teal);
    this.remote.hooks = {
      damage: (a, src) => this.push({ k: 'dmg', a, src }),
      grant: (n) => this.push({ k: 'claim', n }),
    };
    const local: Member = {
      api: host.player,
      body: host.player,
      slot: this.slot,
      addInk: (n) => host.energy.add(n),
    };
    const partner: Member = { api: this.remote, body: null, slot: this.partnerSlot, addInk: () => {} };
    this.members = this.slot === 0 ? [local, partner] : [partner, local];
    this.setPlayers(true);
    this.rules = new CoopRules(ctx, this.members, {
      authority: this.authority,
      path: () => host.level()?.def.path ?? null,
      triggers: () => host.level()?.triggers ?? null,
      spread: () => {
        const f = host.editor()?.fsm;
        return f ? { on: f.spread, x: f.gutterX } : null;
      },
      onDown: (m) => {
        const p = m.api.position;
        this.push({ k: 'down', pid: m.slot, x: p.x, z: p.z });
      },
      onUp: (m) => this.push({ k: 'up', pid: m.slot }),
    });
    if (this.authority) {
      this.router = new PickupRouter(ctx, host.pickups, [
        { api: host.player, add: (n) => host.energy.add(n) },
        {
          api: this.remote,
          add: (n) => {
            this.remote.addEnergy(n);
            return n;
          },
        },
      ]);
    }
    // world authority
    this.mirror = new EnemyMirror(host.enemies);
    const dep = host.enemies.deps;
    dep.getPlayers = () => ctx.players ?? [];
    dep.crystals = [ctx.reveal, crystalView(ctx.reveal as RevealSystem)];
    // favor the victim: strokes only test the wizard simulated on this machine
    dep.victims = () => [host.player];
    installCoopTargeting(host.enemies);
    this.mirror.enable(!this.authority);
    host.enemies.net = this.authority
      ? { onFire: (x, z, dx, dz, l, sd) => this.push({ k: 'fire', x, z, dx, dz, l, s: sd }) }
      : { onHit: (e, d, from, crane) => this.requestHit(e, d, from, crane) };
    this.filter = interceptEmit(ctx.events, (type, p) => this.onEmit(type, p));
    this.wireBus();
    this.wireSession();
    if (typeof document !== 'undefined') {
      this.hud = new PartnerHud((k, v) => ctx.t(k, v), document.getElementById('ui-root') ?? document.body);
    }
    ctx.events.emit('coop:players', { count: 2 });
    host.enemies.setPlayerCount(2, true);
    this.publish();
    // background tabs get no rAF (and ~1 Hz timers): an online page must keep ticking, since the
    // partner shares it. Catch the sim up without drawing; FX clocks don't run without frames,
    // so the hit-stop / panel-cut time scale is ignored here.
    if (typeof setInterval !== 'undefined' && this.expose) {
      const iv = setInterval(() => {
        if (this.disposed || host.mode() === 'boot' || host.mode() === 'title') return;
        const now = performance.now();
        const gap = now - Math.max(host.lastFrameAt(), this.watchdogAt);
        if (gap < 250) return;
        const dt = 1 / ctx.tuning.sim.hz;
        const n = Math.min(90, Math.round(gap / 1000 / dt));
        for (let i = 0; i < n; i++) host.stepSim(dt);
        this.watchdogAt = now;
      }, 100);
      this.offs.push(() => clearInterval(iv));
    }
  }

  /** Last hidden-tab catch-up (debug). */
  watchdogAt = 0;

  // ───────────────────────────── players ─────────────────────────────

  private setPlayers(two: boolean): void {
    const ctx = this.host.ctx;
    ctx.players = two ? this.members.map((m) => m.api) : [this.host.player];
    (ctx.reveal as RevealSystem).setDual(two);
  }

  private goSolo(): void {
    if (this.solo) return;
    this.solo = true;
    const i = this.members.findIndex((m) => m.api === this.remote);
    if (i >= 0) this.members.splice(i, 1);
    this.setPlayers(false);
    this.remote.object.visible = false;
    this.host.ctx.events.emit('coop:players', { count: 1 });
    this.host.ctx.events.emit('coop:peer', { state: 'left', pid: this.partnerSlot });
    this.hud?.banner(this.host.ctx.t('coop.run.solo'), 3);
    this.publish();
  }

  private unSolo(): void {
    this.fadeT = -1;
    this.remote.presence = 1;
    this.remote.object.visible = true;
    if (!this.solo) return;
    this.solo = false;
    if (!this.members.includes(this.members.find((m) => m.api === this.remote)!)) {
      const m: Member = { api: this.remote, body: null, slot: this.partnerSlot, addInk: () => {} };
      if (this.slot === 0) this.members.push(m);
      else this.members.unshift(m);
    }
    this.setPlayers(true);
    this.host.ctx.events.emit('coop:players', { count: 2 });
    this.host.ctx.events.emit('coop:peer', { state: 'rejoined', pid: this.partnerSlot });
    this.hud?.banner(this.host.ctx.t('coop.run.rejoined'), 2.5);
    this.publish();
  }

  // ───────────────────────────── wiring ─────────────────────────────

  private wireSession(): void {
    const s = this.s;
    this.offs.push(
      s.on('message', (def, msg) => this.onMessage(def, msg)),
      s.on('peerJoined', () => {
        if (this.authority) {
          this.unSolo();
          this.sendSync();
        } else {
          this.hostLostT = -1;
          this.hud?.banner(null);
        }
        this.publish();
      }),
      s.on('peerLeft', ({ final }) => {
        if (this.authority) {
          if (this.fadeT < 0 && !this.solo) this.fadeT = 0;
          if (final && !this.solo) this.goSolo();
        } else if (this.hostLostT < 0) this.hostLostT = 0;
        this.publish();
      }),
    );
  }

  private wireBus(): void {
    const ev = this.host.ctx.events;
    const on = <K extends keyof GameEvents>(k: K, fn: (p: GameEvents[K]) => void) =>
      this.offs.push(ev.on(k, fn));
    on('bolt:fire', () => {
      this.castSerial++;
    });
    on('player:dash', (e) =>
      this.push({ k: 'dash', ax: e.from[0], az: e.from[2], bx: e.to[0], bz: e.to[2] }),
    );
    on('hero:action', (e) => {
      if (e.pid === this.slot) this.push({ k: 'hero', p: e });
    });
    if (!this.authority) return;
    const en = this.host.enemies;
    on('enemy:spawn', (e) => {
      const x = en.byId(e.id);
      if (x) this.push({ k: 'spawn', id: e.id, kind: e.kind, x: x.position.x, z: x.position.z, el: x.elite });
    });
    on('enemy:died', (e) => this.push({ k: 'die', id: e.id, x: e.position[0], z: e.position[2] }));
    on('bolt:hit', (e) => {
      if (e.enemyId < 9000) this.push({ k: 'hit', id: e.enemyId, x: e.position[0], z: e.position[2] });
    });
    on('trigger:fired', ({ id }) => {
      const def = this.host.level()?.def.triggers.find((t) => t.id === id);
      if (def?.action?.type === 'pageEnd') return;
      this.push({ k: 'trig', id });
      if (id.endsWith('_cleared') && !this.save.cleared.includes(id)) this.save.cleared.push(id);
      this.dirtySave = true;
    });
    on('sketch:printed', ({ id }) => {
      this.push({ k: 'sketch', id });
      this.dirtySave = true;
    });
    on('checkpoint:reached', () => {
      this.dirtySave = true;
    });
    on('boss:phase', (e) => {
      this.push({ k: 'bossPhase', p: e.phase });
      this.dirtySave = true;
    });
    on('boss:weakpoint', (e) => {
      this.push({ k: 'bossWp', i: e.index, d: e.destroyed });
      this.dirtySave = true;
    });
    on('boss:rewrite', (e) => this.push({ k: 'bossRewrite', verb: e.verb, cut: e.cut }));
  }

  private dirtySave = false;

  /** Host: hook the Editor once it exists (boss page). */
  private hookEditor(ed: Editor): void {
    ed.coop = this.authority
      ? {
          onAttack: (i, a, stage) => {
            if (stage === 'telegraph')
              this.push({
                k: 'bossAtk',
                i,
                kind: a.kind,
                hand: a.hand,
                g: [a.ax, a.az, a.bx, a.bz, a.hw],
                tm: [a.telegraph, a.travel, a.recover],
                at: this.tick,
              });
            else if (stage === 'end') this.push({ k: 'bossAtkEnd', i });
          },
          onStet: (st, tg) => this.push({ k: 'stet', st, tg }),
          onSpread: (on) => this.push({ k: 'spread', on }),
        }
      : {
          onHit: (index, amount) => {
            const seq = ++this.hitSeq;
            this.pendingHits.set(seq, this.boltCost());
            this.stats.hitReq++;
            this.push({ k: 'wpReq', seq, i: index, d: amount });
          },
        };
    ed.puppet = !this.authority;
  }

  private boltCost(): number {
    const T = this.host.ctx.tuning;
    return T.bolt.cost * (T.difficulty[this.host.ctx.settings.difficulty]?.energyCost ?? 1);
  }

  /** Bus filter: shared panel cuts are scheduled by the host for both machines. */
  private onEmit<K extends keyof GameEvents>(type: K, p: GameEvents[K]): boolean {
    if (type !== 'fx:panelCut' || this.solo) return false;
    const c = p as GameEvents['fx:panelCut'];
    if (localCut(c.reason)) return false;
    if (!this.authority) return true; // the host sends its own copy
    const at = this.tick + this.host.ctx.tuning.coop.net.leadTicks;
    const f: [number, number, number] = [c.focus[0], c.focus[1], c.focus[2]];
    this.push({ k: 'cut', w: c.word, f, r: c.reason, at });
    this.schedule(at, () => this.replayCut(c.word, f, c.reason));
    return true;
  }

  private replayCut(word: string, focus: [number, number, number], reason: string): void {
    this.filter.bypass(() => this.host.ctx.events.emit('fx:panelCut', { word, focus, reason }));
  }

  private schedule(at: number, run: () => void): void {
    this.sched.push({ at, run });
  }

  private runDue(now: number): void {
    for (let i = 0; i < this.sched.length; ) {
      const s = this.sched[i]!;
      if (s.at <= now) {
        this.sched.splice(i, 1);
        s.run();
      } else i++;
    }
  }

  // ───────────────────────────── messages ─────────────────────────────

  private send<T>(def: MessageDef<T>, msg: T, reliable: boolean): void {
    this.s.send(def, msg, reliable);
  }

  private push(e: CoopEvent): void {
    if (this.disposed) return;
    this.queue.push(e);
  }

  /** Send everything queued (reliable, tagged with the current epoch + tick). */
  flush(): void {
    if (!this.queue.length) return;
    this.send(COOP_MSG.evt, { epoch: this.epoch, tick: this.tick, ev: this.queue.splice(0) }, true);
  }

  private onMessage(def: MessageDef<unknown>, msg: unknown): void {
    if (this.disposed) return;
    switch (def.id) {
      case MSG_SNAP:
        if (!this.authority) this.onSnap(msg as SnapMsg);
        return;
      case MSG_PSTATE:
        if (this.authority) this.onPState(msg as PStateMsg);
        return;
      case MSG_EVT: {
        const m = msg as EvtMsg;
        if (m.epoch > this.epoch) this.later.push(m);
        else if (m.epoch === this.epoch) this.onEvents(m);
        else if (this.authority) this.onEvents(m, true); // late guest requests: still answer them
        return;
      }
      case MSG_SYNC:
        if (!this.authority) this.onSync(msg as SyncMsg);
        return;
    }
  }

  private drainLater(): void {
    for (let i = 0; i < this.later.length; ) {
      const m = this.later[i]!;
      if (m.epoch === this.epoch) {
        this.later.splice(i, 1);
        this.onEvents(m);
      } else if (m.epoch < this.epoch) this.later.splice(i, 1);
      else i++;
    }
  }

  private onEvents(m: EvtMsg, stale = false): void {
    for (const e of m.ev) {
      if (stale && e.k !== 'hitReq' && e.k !== 'wpReq') continue;
      this.onEvent(e);
    }
  }

  private onEvent(e: CoopEvent): void {
    const host = this.host;
    const ctx = host.ctx;
    const en = host.enemies;
    const lvl = host.level();
    const ed = host.editor();
    switch (e.k) {
      // ── both directions
      case 'dash':
        this.rules.partnerDash(this.partnerSlot, e.ax, e.az, e.bx, e.bz);
        return;
      case 'hero':
        ctx.events.emit('hero:action', e.p as GameEvents['hero:action']);
        return;
      case 'down':
      case 'up':
      case 'cast':
        return;
      // ── host side (from the guest)
      case 'hitReq':
        if (this.authority) this.resolveHit(e);
        return;
      case 'wpReq': {
        if (!this.authority) return;
        const w = ed?.fsm.wps[e.i];
        const ok = !!ed && !!w && w.alive && w.exposed && ed.fsm.state === 'phase';
        if (ok) ed!.boltHit(e.i, Math.min(e.d, this.maxDamage()), _from.set(w!.x, w!.y, w!.z + 1));
        this.ackHit(e.seq, ok);
        return;
      }
    }
    if (this.authority) return;
    // ── guest side (from the host)
    switch (e.k) {
      case 'spawn':
        this.mirror.spawn(e.id, e.kind as EnemyKind, e.x, e.z, (e.el as EliteAffix) ?? null);
        return;
      case 'die':
        this.mirror.die(e.id, e.x, e.z + 1);
        this.enemyInterp.remove(e.id);
        this.rows.delete(e.id);
        return;
      case 'clear':
        en.clear();
        return;
      case 'hit': {
        const x = en.byId(e.id);
        if (x) {
          x.hitT = 1;
          en.fx?.hit(x, e.x, e.z);
        }
        return;
      }
      case 'fire':
        this.mirror.fire(e.x, e.z, e.dx, e.dz, e.l, e.s);
        return;
      case 'hitAck': {
        const cost = this.pendingHits.get(e.seq);
        this.pendingHits.delete(e.seq);
        if (e.ok) this.stats.hitOk++;
        else {
          this.stats.hitRejected++;
          if (cost) {
            host.energy.add(cost);
            this.stats.refunded += cost;
          }
        }
        return;
      }
      case 'sketch':
        lvl?.sketches.printNow(e.id);
        return;
      case 'trig':
        if (lvl) fireReplica(lvl.triggers, ctx.events, e.id);
        return;
      case 'respawn':
        if (lvl) {
          lvl.checkpoints.current = e.cp || lvl.checkpoints.current;
          void lvl.checkpoints.respawn();
        }
        return;
      case 'cut':
        this.schedule(e.at, () => this.replayCut(e.w, e.f, e.r));
        return;
      case 'turn':
        this.schedule(e.at, () => void host.turnTo(e.page === 'boss' ? 'boss' : (Number(e.page) as PageId)));
        return;
      case 'save':
        this.save = e.save;
        return;
      case 'dmg':
        host.player.damage(e.a, e.src as DamageSource);
        return;
      case 'claim':
        host.energy.add(e.n);
        return;
      case 'bossPhase':
        if (ed) {
          ed.fsm.phase = e.p as 1 | 2 | 3;
          ed.onPhase(e.p as 1 | 2 | 3);
        }
        return;
      case 'bossAtk':
        if (ed) {
          const late = Math.max(0, (this.estHostTick() - e.at) / ctx.tuning.sim.hz);
          ed.fsm.startRemoteAttack(
            e.i,
            e.kind as AttackKind,
            e.hand as Hand,
            { ax: e.g[0], az: e.g[1], bx: e.g[2], bz: e.g[3], hw: e.g[4] },
            { telegraph: e.tm[0], travel: e.tm[1], recover: e.tm[2] },
            late,
          );
        }
        return;
      case 'bossAtkEnd':
        ed?.fsm.endRemoteAttack(e.i);
        return;
      case 'bossWp': {
        const w = ed?.fsm.wps[e.i];
        if (ed && w) {
          if (e.d) {
            w.alive = false;
            w.exposed = false;
            w.hp = 0;
          }
          ed.onWeakpointHit(w, e.d);
        }
        return;
      }
      case 'bossRewrite':
        ctx.events.emit('boss:rewrite', { verb: e.verb as never, cut: e.cut });
        return;
      case 'stet':
        ed?.onStet(e.st as 'start', e.tg);
        return;
      default:
        return;
    }
  }

  private maxDamage(): number {
    const B = this.host.ctx.tuning.bolt;
    return B.damage * B.critDamageMul * 2;
  }

  // ── host: guest hit validation ("favor the shooter")
  private resolveHit(e: Extract<CoopEvent, { k: 'hitReq' }>): void {
    const en = this.host.enemies;
    const t = en.byId(e.id);
    const ok = !!t && t.alive && (this.history.wasHittable(e.id, e.ft) || t.revealed);
    if (ok) {
      _from.set(e.x, t!.position.y, e.z);
      if (e.crane && t!.kind === 'cranes') {
        const c = t!.flock.find((k) => k.alive);
        if (c) en.onCraneHit(c, e.d, _from);
      } else en.onEnemyHit(t!, Math.min(e.d, this.maxDamage()), _from);
      this.stats.hitOk++;
    } else this.stats.hitRejected++;
    this.ackHit(e.seq, ok);
  }

  private ackHit(seq: number, ok: boolean): void {
    this.push({ k: 'hitAck', seq, ok });
  }

  // ── guest: local bolt hit a replicated enemy
  private requestHit(e: Enemy, d: number, from: THREE.Vector3, crane: number): void {
    const seq = ++this.hitSeq;
    this.pendingHits.set(seq, this.boltCost());
    this.stats.hitReq++;
    const delayTicks = (this.enemyInterp.delay() / 1000) * this.host.ctx.tuning.sim.hz;
    this.push({
      k: 'hitReq',
      seq,
      id: e.id,
      d,
      ft: Math.round(this.estHostTick() - delayTicks),
      x: from.x,
      z: from.z,
      crane,
    });
  }

  /** Guest: best guess of the host's current sim tick. */
  estHostTick(): number {
    if (this.authority) return this.tick;
    if (Number.isNaN(this.lastSnapTime)) return this.lastSnapTick;
    const ms = this.s.hostNow() - this.lastSnapTime;
    return this.lastSnapTick + Math.max(0, ms) / (1000 / this.host.ctx.tuning.sim.hz);
  }

  // ───────────────────────────── snapshots ─────────────────────────────

  private wiz(out: WizState): WizState {
    const p = this.host.player;
    const ctx = this.host.ctx;
    out.x = p.position.x;
    out.y = p.position.y;
    out.z = p.position.z;
    out.yaw = Math.atan2(p.facing.x, p.facing.z);
    out.vx = p.velocity.x;
    out.vz = p.velocity.z;
    out.cx = p.crystalPos.x;
    out.cy = p.crystalPos.y;
    out.cz = p.crystalPos.z;
    out.cr = ctx.reveal.radius;
    out.flags =
      (p.crystalHeld ? WF.held : 0) |
      (p.dashing ? WF.dashing : 0) |
      (p.downed ? WF.downed : 0) |
      (p.isAlive ? WF.alive : 0) |
      (p.invulnerable ? WF.invuln : 0);
    out.pages = p.pages;
    out.energy = p.energy;
    out.dashSerial = p.dashSerial;
    out.castSerial = this.castSerial;
    return out;
  }

  private readonly hostWiz = emptyWiz();
  private readonly bossOut = emptyBoss();
  private readonly near: Enemy[] = [];

  private sendSnap(): void {
    const ctx = this.host.ctx;
    const en = this.host.enemies;
    const now = this.s.hostNow();
    this.enc.begin(this.tick, now);
    // ≤ maxEnemies nearest to either wizard
    const near = this.near;
    near.length = 0;
    for (const e of en.pool) if (e.active && e.alive) near.push(e);
    if (near.length > ctx.tuning.coop.net.maxEnemies) {
      const a = this.host.player.position;
      const b = this.remote.position;
      const dist = (e: Enemy) =>
        Math.min(
          (e.position.x - a.x) ** 2 + (e.position.z - a.z) ** 2,
          (e.position.x - b.x) ** 2 + (e.position.z - b.z) ** 2,
        );
      near.sort((p, q) => dist(p) - dist(q));
      near.length = ctx.tuning.coop.net.maxEnemies;
    }
    for (const e of near) {
      const r = _row;
      r[I.kind] = KIND_INDEX[e.kind] | ((e.elite ? ELITE_INDEX[e.elite] : 0) << 4);
      r[I.state] = e.state | (e.phase << 3);
      r[I.x] = e.position.x;
      r[I.z] = e.position.z;
      r[I.yaw] = e.yaw;
      r[I.hp] = e.hp * HP_SCALE;
      r[I.flags] =
        (e.vulnerable ? EF.vulnerable : 0) |
        (e.attacking ? EF.attacking : 0) |
        (e.stunT > 0 ? EF.stunned : 0) |
        (e.worn ? EF.worn : 0) |
        (e.inked ? EF.inked : 0) |
        (e.recoil > 0 ? EF.recoil : 0);
      r[I.windup] = Math.min(1, e.windup);
      r[I.lunge] = Math.min(1, e.lunge);
      r[I.drain] = Math.min(1, e.drain);
      r[I.shield] = Math.min(1, e.shield);
      r[I.expose] = Math.min(1, e.expose);
      r[I.align] = Math.min(1, e.align);
      r[I.box] = e.boxHalf * 20;
      this.enc.set(e.id, r);
    }
    const enemies = this.enc.end();
    const ed = this.host.editor();
    this.send(
      COOP_MSG.snap,
      {
        tick: this.tick,
        time: now,
        epoch: this.epoch,
        supp: this.supp,
        host: this.wiz(this.hostWiz),
        boss: ed && ed.fsm.state !== 'dormant' ? this.bossBlock(ed) : null,
        enemies,
      },
      false,
    );
    this.stats.snapsSent++;
  }

  private bossBlock(ed: Editor): BossBlock {
    const f = ed.fsm;
    const b = this.bossOut;
    b.state = BOSS_STATES.indexOf(f.state);
    b.phase = f.phase;
    b.blank = f.blank;
    b.bowT = f.bowT;
    b.staggerT = f.staggerT;
    b.p2Active = f.p2Active;
    b.health = f.health;
    for (let i = 0; i < f.wps.length; i++) {
      const w = f.wps[i]!;
      const o = b.wps[i]!;
      o.flags = (w.alive ? 1 : 0) | (w.exposed ? 2 : 0) | (w.printed ? 4 : 0);
      o.hp = w.hp;
      o.drawIn = w.drawIn;
      o.print = w.print;
    }
    for (let i = 0; i < f.attacks.length && i < b.attacks.length; i++) {
      const a = f.attacks[i]!;
      const o = b.attacks[i]!;
      o.active = a.active;
      o.stage = ATTACK_STAGES.indexOf(a.stage);
      o.t = a.t;
      o.headX = a.headX;
      o.headZ = a.headZ;
    }
    b.spread = f.spread;
    b.gutterX = f.gutterX;
    const s = f.stet;
    Object.assign(b.stet, {
      active: s.active,
      target: s.target,
      t: s.t,
      erase: s.erase,
      held: s.held,
      x: s.x,
      z: s.z,
    });
    return b;
  }

  private onSnap(m: SnapMsg): void {
    if (m.epoch !== this.epoch) return;
    const d = this.dec.decode(m.enemies);
    if (!d) return;
    this.stats.snapsRecv++;
    if (d.stale) return;
    this.lastSnapTick = m.tick;
    this.lastSnapTime = m.time;
    this.recvSupp = m.supp;
    this.enemyInterp.noteSnapshot(m.time, this.s.hostNow());
    this.remote.push(m.host, m.time);
    this.boss = m.boss;
    const en = this.host.enemies;
    for (const [id] of d.snap.ents) {
      let row = this.rows.get(id);
      if (!row) {
        row = new Float64Array(ENEMY_SCHEMA.size);
        this.rows.set(id, row);
      }
      d.snap.read(ENEMY_SCHEMA, id, row);
      this.enemyInterp.push(id, m.time, row[I.x]!, 0, row[I.z]!, row[I.yaw]!);
      if (!en.byId(id)) {
        const k = row[I.kind]!;
        this.mirror.spawn(id, KINDS[k & 15] ?? 'smudge', row[I.x]!, row[I.z]!, ELITES[k >> 4] ?? null);
      }
    }
  }

  private onPState(m: PStateMsg): void {
    if (m.ack !== 0xffffffff && m.epoch === this.epoch) this.enc.ack(m.ack);
    const sorted = m.states.slice().sort((a, b) => a.seq - b.seq);
    for (const st of sorted) {
      if (st.seq <= this.lastSeq) continue;
      this.lastSeq = st.seq;
      this.remote.push(st.s, st.time);
    }
  }

  private sendPState(): void {
    const st = { seq: ++this.seq, time: this.s.hostNow(), s: this.wiz(emptyWiz()) };
    this.myStates.push(st);
    while (this.myStates.length > 3) this.myStates.shift();
    this.send(
      COOP_MSG.pstate,
      {
        ack: this.dec.newestTick < 0 ? 0xffffffff : this.dec.newestTick,
        epoch: this.epoch,
        states: this.myStates,
      },
      false,
    );
  }

  /** Guest: write the newest replicated rows + interpolated positions into the puppets. */
  private applyEnemies(): void {
    const en = this.host.enemies;
    const now = this.s.hostNow();
    for (const e of en.pool) {
      if (!e.active || !e.alive) continue;
      const row = this.rows.get(e.id);
      if (!row) continue;
      if (this.enemyInterp.sample(e.id, now, _is)) {
        const nx = _is.x;
        const nz = _is.z;
        const dt = 1 / this.host.ctx.tuning.sim.hz;
        e.velocity.set((nx - e.position.x) / dt, 0, (nz - e.position.z) / dt);
        e.position.set(nx, this.host.ctx.collision.groundHeight(nx, nz), nz);
        e.yaw = _is.yaw;
      }
      e.hp = row[I.hp]! / HP_SCALE;
      if (e.hp > e.maxHp) e.maxHp = e.hp;
      const st = row[I.state]!;
      const s = (st & 7) as AiState;
      if (s !== e.state && s !== AiState.Die) {
        e.state = s;
        e.stateT = 0;
      }
      e.phase = st >> 3;
      const fl = row[I.flags]!;
      e.vulnerable = (fl & EF.vulnerable) !== 0;
      e.attacking = (fl & EF.attacking) !== 0;
      e.stunT = fl & EF.stunned ? Math.max(e.stunT, 0.1) : 0;
      e.worn = (fl & EF.worn) !== 0;
      e.recoil = fl & EF.recoil ? 0.6 : 0;
      e.windup = row[I.windup]!;
      e.lunge = row[I.lunge]!;
      e.drain = row[I.drain]!;
      e.shield = row[I.shield]!;
      e.expose = row[I.expose]!;
      e.align = row[I.align]!;
      e.boxHalf = row[I.box]! / 20;
    }
  }

  /** Guest: mirror the host's boss block into the puppet FSM. */
  private applyBoss(ed: Editor): void {
    const b = this.boss;
    if (!b) return;
    const f = ed.fsm;
    const st = BOSS_STATES[b.state] ?? 'phase';
    if (b.state !== this.bossState) {
      const prev = BOSS_STATES[this.bossState];
      this.bossState = b.state;
      if (st === 'dying' && prev !== 'dying') {
        f.t = 0;
        ed.onDeathStart();
      } else if (st === 'dead' && prev !== 'dead') ed.onDefeated();
      else if (st === 'phase' || st === 'transition') f.t = 0;
    }
    f.state = st;
    f.phase = b.phase as 1 | 2 | 3;
    f.blank = b.blank;
    f.bowT = b.bowT;
    f.staggerT = b.staggerT;
    f.p2Active = b.p2Active;
    for (let i = 0; i < f.wps.length; i++) {
      const w = f.wps[i]!;
      const o = b.wps[i];
      if (!o) continue;
      w.alive = (o.flags & 1) !== 0;
      w.exposed = (o.flags & 2) !== 0;
      w.printed = (o.flags & 4) !== 0;
      w.hp = o.hp;
      w.drawIn = o.drawIn;
      w.print = o.print;
    }
    for (let i = 0; i < f.attacks.length; i++) {
      const a = f.attacks[i]!;
      const o = b.attacks[i];
      if (a.active && o && !o.active && a.stage === 'recover') f.endRemoteAttack(i);
    }
    f.spread = b.spread;
    f.gutterX = b.gutterX;
    const s = f.stet;
    s.active = b.stet.active;
    s.target = b.stet.target;
    s.erase = b.stet.erase;
    s.held = b.stet.held;
    s.x = b.stet.x;
    s.z = b.stet.z;
  }

  private sendSync(): void {
    const ctx = this.host.ctx;
    this.refreshSave();
    let hist = '';
    const rv = ctx.reveal as RevealSystem;
    if (rv.size) hist = toB64(rleEncode(exportHistory(rv)));
    this.flush();
    this.enc = new SnapshotEncoder(ENEMY_SCHEMA);
    this.send(
      COOP_MSG.sync,
      { epoch: this.epoch, tick: this.tick, seed: 0, heroes: ['inker', 'inker'], save: this.save, hist },
      true,
    );
  }

  private onSync(m: SyncMsg): void {
    const host = this.host;
    const page = host.page();
    const want = m.save.page;
    this.save = m.save;
    const apply = () => {
      this.epoch = m.epoch;
      this.dec = new SnapshotDecoder(ENEMY_SCHEMA);
      this.rows.clear();
      this.enemyInterp.clear();
      host.enemies.clear();
      this.later.length = 0;
      this.lastSnapTick = m.tick;
      applySave(host, m.save, false);
      const rv = host.ctx.reveal as RevealSystem;
      if (m.hist && rv.size) importHistory(rv, rleDecode(fromB64(m.hist), rv.size * rv.size * 3));
    };
    if (page !== null && String(page) === want) apply();
    else {
      const p = want === 'boss' ? 'boss' : (Number(want) as PageId);
      void host.startRun(p, m.save.cp || undefined).then(apply);
    }
  }

  /** Host: rebuild the page save from the live page. */
  private refreshSave(): void {
    const lvl = this.host.level();
    const page = this.host.page();
    if (!lvl || page === null) return;
    const ed = this.host.editor();
    let boss: PageSave['boss'] = null;
    if (ed && ed.fsm.state !== 'dormant') {
      let mask = 0;
      for (const w of ed.fsm.wps) if (w.hp > 0) mask |= 1 << w.index;
      boss = { phase: ed.fsm.phase, mask };
    }
    this.save = {
      page: String(page),
      cp: lvl.checkpoints.current,
      printed: lvl.def.sketches.filter((s) => lvl.sketches.isPrinted(s.id)).map((s) => s.id),
      spent: spentIds(lvl.triggers),
      cleared: this.save.page === String(page) ? this.save.cleared : [],
      boss,
    };
  }

  /** Guest resuming a running issue: apply the SYNC that started it. Returns false if none. */
  resume(): boolean {
    const m = this.pendingSync;
    this.pendingSync = null;
    if (!m) return false;
    this.onSync(m);
    return true;
  }

  // ───────────────────────────── CoopSession ─────────────────────────────

  stepPlayers(dt: number): void {
    this.remote.step(dt, this.s.hostNow());
    if (this.fadeT >= 0 && !this.solo) {
      this.fadeT += dt;
      this.remote.presence = Math.max(0, 1 - this.fadeT / this.host.ctx.tuning.coop.net.fadeS);
      if (this.remote.presence <= 0) this.goSolo();
    }
  }

  stepCombat(_dt: number): void {}

  stepPickups(dt: number): void {
    if (this.router && !this.solo) this.router.step(dt);
    else
      this.host.pickups.step(
        dt,
        this.host.player,
        this.authority || this.solo ? (n) => this.host.energy.add(n) : (n) => n,
      );
  }

  preWorld(_dt: number): void {
    const rv = this.host.ctx.reveal as RevealSystem;
    const r = this.remote;
    if (!this.solo) {
      rv.center2.copy(r.crystalPos);
      rv.radius2 = rv.targetRadius2 = r.presence < 1 ? r.crystalRadius * r.presence : r.crystalRadius;
    }
    this.suppBase = rv.targetRadius2;
    if (this.authority) return;
    // guest: the host's blots choke our crystal too; positions/boss come from the snapshot
    if (this.recvSupp < 0.995) rv.targetRadius *= this.recvSupp;
    this.applyEnemies();
    const ed = this.host.editor();
    if (ed) this.applyBoss(ed);
  }

  postStep(dt: number): void {
    if (this.disposed) return;
    const T = this.host.ctx.tuning;
    this.tick++;
    const ed = this.host.editor();
    if (ed && !ed.coop) this.hookEditor(ed);
    this.rules.step(dt);
    if (this.authority) {
      const rv = this.host.ctx.reveal as RevealSystem;
      this.supp = this.suppBase > 0.01 ? Math.min(1, rv.targetRadius2 / this.suppBase) : 1;
      this.history.begin(this.tick);
      for (const e of this.host.enemies.pool) if (e.active) this.history.add(e.id, e.alive, e.revealed);
      this.runDue(this.tick);
      if (this.dirtySave) {
        this.dirtySave = false;
        this.refreshSave();
        this.push({ k: 'save', save: this.save });
      }
      const every = Math.max(1, Math.round(T.sim.hz / T.coop.net.snapshotHz));
      if (!this.solo && this.tick % every === 0) this.sendSnap();
    } else {
      this.drainLater();
      this.runDue(this.estHostTick());
      const every = Math.max(1, Math.round(T.sim.hz / T.coop.net.playerStateHz));
      if (this.tick % every === 0) this.sendPState();
      if (this.hostLostT >= 0) {
        this.hostLostT += dt;
        const left = Math.ceil(T.coop.net.hostReconnectS - this.hostLostT);
        this.hud?.banner(this.host.ctx.t('coop.run.hostLost', { s: Math.max(0, left) }), 1);
        if (this.hostLostT >= T.coop.net.hostReconnectS) {
          this.hostLostT = -1;
          void takeOver(this.host, this.save);
          return;
        }
      }
    }
    this.flush();
    if (this.expose && this.tick % 15 === 0) this.publish();
  }

  frame(alpha: number, frameDt: number): void {
    const host = this.host;
    const cam = host.ctx.render.camera;
    if (!this.solo) this.remote.render(alpha, frameDt, cam);
    const hud = this.hud;
    if (!hud) return;
    this.stetHint(hud);
    const r = host.ctx.render.renderer.domElement;
    const T = host.ctx.tuning;
    const st = this.s.status();
    const t = host.ctx.t;
    let status: string | null = null;
    if (this.solo) status = t('coop.run.soloShort');
    else if (this.fadeT >= 0) status = t('coop.run.dropped');
    else if (this.remote.downed) status = t('coop.run.downed');
    else if (this.rules.atExit(this.slot) && !this.rules.atExit(this.partnerSlot))
      status = t('coop.run.waitExit');
    for (let k = 0; k < 2; k++) {
      const d = this.dv[k]!;
      const m = this.members.find((x) => x.slot === k);
      d.on = !!m && (this.rules.down.has(k as PlayerSlot) || !!m.api.downed) && !this.solo;
      d.revive = this.rules.revive[k]!;
      if (m) d.pos.copy(m.api === this.remote ? this.remote.renderPosition : m.api.position);
    }
    hud.update(
      frameDt,
      {
        name: t('coop.partner'),
        pages: this.remote.pages,
        maxPages: T.player.maxPages,
        ink: this.remote.energy,
        inkMax: T.energy.max,
        tier: t(`coop.tier.${st.tier}`),
        rtt: st.rtt,
        status,
        partner: this.solo ? null : this.remote.renderPosition,
        downed: this.dv,
        strain: this.solo ? 0 : this.rules.strain,
        reduceMotion: host.ctx.settings.reduceMotion,
      },
      cam,
      r.clientWidth || innerWidth,
      r.clientHeight || innerHeight,
    );
  }

  private stetWas = false;
  /** "Hold your crystal on the red circle!" when the Editor's red pencil circles someone. */
  private stetHint(hud: PartnerHud): void {
    const on = !!this.host.editor()?.fsm.stet.active;
    if (on && !this.stetWas) hud.banner(this.host.ctx.t('coop.run.stetHint'), 3);
    this.stetWas = on;
  }

  cameraFocus(): number | null {
    return null;
  }

  onPageStart(page: PageId): void {
    const host = this.host;
    const lvl = host.level();
    if (lvl) {
      lvl.replica = !this.authority;
      lvl.coop = levelHooks(host.ctx);
      // side by side at the page start: the guest stands one step to the right
      const p = host.player;
      if (this.slot === 1) {
        const x = p.position.x + 1.4;
        p.teleport(x, lvl.built.collision.groundHeight(x, p.position.z), p.position.z);
      }
    }
    if (!this.authority) host.spawner.load(null);
    this.later.sort((a, b) => a.epoch - b.epoch);
    this.drainLater();
    if (this.authority) {
      this.save = {
        page: String(page),
        cp: lvl?.checkpoints.current ?? '',
        printed: [],
        spent: [],
        cleared: [],
        boss: null,
      };
      this.dirtySave = true;
    }
    this.bossState = 0;
    this.boss = null;
    this.publish();
  }

  /** Called at the start of every page build and on every checkpoint respawn (both machines). */
  onPageTeardown(): void {
    this.bumpEpoch();
  }

  onRespawn(): void {
    if (this.authority) this.push({ k: 'respawn', cp: this.host.level()?.checkpoints.current ?? '' });
    this.bumpEpoch();
  }

  private bumpEpoch(): void {
    this.flush();
    this.epoch++;
    this.enc = new SnapshotEncoder(ENEMY_SCHEMA);
    this.dec = new SnapshotDecoder(ENEMY_SCHEMA);
    this.rows.clear();
    this.enemyInterp.clear();
  }

  handlePageComplete(page: PageId): boolean {
    if (!this.authority) return true; // the host decides
    if (this.solo) return false;
    const next = page === 1 ? 2 : page === 2 ? 3 : page === 3 ? 'boss' : null;
    if (next === null) return false;
    const at = this.tick + this.host.ctx.tuning.coop.net.leadTicks;
    this.push({ k: 'turn', page: String(next), at });
    this.flush();
    this.schedule(at, () => void this.host.turnTo(next));
    return true;
  }

  setHudVisible(v: boolean): void {
    this.hud?.setVisible(v);
  }

  /** `window.__net` + `<html data-coop…>` (e2e hooks). */
  private publish(): void {
    if (!this.expose || typeof document === 'undefined') return;
    const de = document.documentElement;
    de.dataset.coop = this.solo ? 'solo' : this.kind;
    de.dataset.coopPeers = String(this.host.ctx.players?.length ?? 1);
    (window as unknown as { __net?: unknown }).__net = {
      role: this.kind,
      slot: this.slot,
      solo: this.solo,
      epoch: this.epoch,
      page: this.host.page(),
      tick: this.tick,
      players: this.host.ctx.players?.length ?? 1,
      partner: this.solo ? 'gone' : this.fadeT >= 0 ? 'fading' : 'here',
      rtt: this.s.rtt(),
      stats: { ...this.stats },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const ctx = this.host.ctx;
    for (const o of this.offs) o();
    this.offs.length = 0;
    this.filter.undo();
    this.rules.dispose();
    this.router?.dispose();
    this.remote.dispose();
    this.hud?.dispose();
    this.mirror.enable(false);
    const dep = this.host.enemies.deps;
    dep.getPlayers = dep.crystals = dep.victims = undefined;
    installCoopTargeting(this.host.enemies, false);
    this.host.enemies.net = null;
    const ed = this.host.editor();
    if (ed) {
      ed.coop = null;
      ed.puppet = false;
    }
    const lvl = this.host.level();
    if (lvl) lvl.replica = false;
    (ctx.reveal as RevealSystem).setDual(false);
    ctx.players = [this.host.player];
    ctx.events.emit('coop:players', { count: 1 });
    if (this.expose && typeof document !== 'undefined') {
      document.documentElement.dataset.coop = 'solo';
      document.documentElement.dataset.coopPeers = '1';
      const w = window as unknown as { __net?: { solo?: boolean; partner?: string } };
      if (w.__net) {
        w.__net.solo = true;
        w.__net.partner = 'gone';
      }
    }
  }
}

/** Rebuild a page from a replicated save (rejoin or host takeover). */
export function applySave(host: CoopHost, save: PageSave, silent = true): void {
  const lvl = host.level();
  if (!lvl) return;
  for (const id of save.printed) lvl.sketches.printNow(id, silent);
  markSpent(lvl.triggers, save.spent);
  for (const id of save.cleared) host.ctx.events.emit('trigger:fired', { id });
  if (save.cp) lvl.checkpoints.current = save.cp;
  const ed = host.editor();
  if (save.boss && ed) {
    if (ed.fsm.state === 'dormant') ed.start();
    ed.jumpTo(save.boss.phase as 1 | 2 | 3);
    for (const w of ed.fsm.wps)
      if (w.phase === save.boss.phase && !(save.boss.mask & (1 << w.index))) {
        w.hp = 0;
        w.alive = false;
      }
  }
}

export async function startNetCoop(host: CoopHost, o: NetCoopOptions): Promise<NetCoop> {
  const model = await loadWizardModel();
  return new NetCoop(host, model, o);
}

/** Host gone for good: this guest becomes a solo host and reloads the replicated page save. */
export async function takeOver(host: CoopHost, save: PageSave | null): Promise<void> {
  host.endCoop();
  if (!save) return;
  const page: PageId = save.page === 'boss' ? 'boss' : (Number(save.page) as PageId);
  await host.startPage(page, save.cp || undefined);
  applySave(host, save);
}
