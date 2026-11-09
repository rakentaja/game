/**
 * Shared co-op rules, independent of how the second wizard is driven (local 2P or online):
 *
 *  - Downed ("UNFINISHED"): a lethal hit leaves the wizard a crawling pencil sketch at 40 % speed
 *    that can't act and can't be targeted. The partner reprints it by holding the crystal on it
 *    for 2 s while it sits inside the reveal → `player:revived`. Each machine runs this for its
 *    OWN wizards (favor the victim); both down → the authority emits `player:died` (checkpoint
 *    reprint for everyone).
 *  - Tether: past `soft` m the page edge curls (HUD vignette) and a soft leash pulls back; past
 *    `hard` m the lagging wizard (less path progress) is pulled to the partner with a
 *    "MEANWHILE…" panel cut.
 *  - Dash through your partner: they get `dashThroughInk` ink.
 *  - Two-Page Spread (boss P2): each local wizard stays on its own side of the gutter.
 */
import type { GameEvents } from '../core/events';
import type { GameContext, PlayerAPI, PlayerSlot, Vec2T } from '../core/types';
import type { Player } from '../entities/Player';
import type { Triggers } from '../systems/triggers';
import { setSketchLook } from './look';

export interface Member {
  /** The PlayerAPI in ctx.players (a Player for local wizards, a RemotePlayer otherwise). */
  api: PlayerAPI;
  /** Local, controllable body (null for a replica). */
  body: Player | null;
  slot: PlayerSlot;
  addInk(n: number): void;
}

interface DownState {
  saved: { bolt: boolean; dash: boolean; crystal: boolean };
  revive: number;
}

export interface RulesEnv {
  /** This machine may decide "everyone is down" (host / local 2P). */
  authority: boolean;
  /** Level path (tether "lagging" = less progress along it). */
  path: () => readonly Vec2T[] | null;
  triggers: () => Triggers | null;
  /** Boss Spread state (gutter X, on) or null. */
  spread: () => { on: boolean; x: number } | null;
  /** Local wizard went down / got up (net replication). */
  onDown?(m: Member): void;
  onUp?(m: Member): void;
}

export class CoopRules {
  readonly down = new Map<PlayerSlot, DownState>();
  /** 0..1 tether strain for the HUD (local view), and the last "MEANWHILE" time. */
  strain = 0;
  /** Revive progress (0..1) per slot, for the HUD ring. */
  readonly revive = new Float32Array(2);
  private allDown = false;
  private spreadSide = new Int8Array(2);
  private spreadWas = false;
  private offs: (() => void)[] = [];
  private pullCd = 0;

  constructor(
    private readonly ctx: GameContext,
    readonly members: Member[],
    private readonly env: RulesEnv,
  ) {
    for (const m of members) if (m.body) this.hook(m);
    this.offs.push(
      ctx.events.on('player:respawn', () => {
        this.allDown = false;
        for (const m of this.members) if (m.body && this.down.has(m.slot)) this.getUp(m, false);
      }),
    );
  }

  /** Install the downed hook on a local wizard. */
  hook(m: Member): void {
    const b = m.body;
    if (!b) return;
    b.slot = m.slot;
    b.downedHook = () => {
      // the last wizard standing still dies normally when nobody can reprint it
      if (this.members.length < 2) return false;
      this.goDown(m);
      return true;
    };
  }

  isDown(slot: PlayerSlot): boolean {
    return this.down.has(slot) || !!this.members.find((m) => m.slot === slot)?.api.downed;
  }

  goDown(m: Member): void {
    const b = m.body;
    if (!b || this.down.has(m.slot)) return;
    const v = b.verbCut;
    this.down.set(m.slot, { saved: { bolt: v.bolt, dash: v.dash, crystal: v.crystal }, revive: 0 });
    v.bolt = v.dash = v.crystal = true;
    b.downed = true;
    b.godMode = true;
    b.speedMul = this.ctx.tuning.coop.downed.speedMul;
    setSketchLook(b.object, true);
    const p = b.position;
    this.ctx.events.emit('player:downed', { pid: m.slot, position: [p.x, p.y, p.z] });
    this.ctx.events.emit('fx:shake', { intensity: 0.6, duration: 0.4 });
    this.env.onDown?.(m);
  }

  /** Reprint a downed local wizard (partner revive, or the checkpoint respawn). */
  getUp(m: Member, revived: boolean): void {
    const b = m.body;
    const st = this.down.get(m.slot);
    if (!b || !st) return;
    this.down.delete(m.slot);
    this.revive[m.slot] = 0;
    b.downed = false;
    b.godMode = false;
    b.speedMul = 1;
    const v = b.verbCut;
    v.bolt = st.saved.bolt;
    v.dash = st.saved.dash;
    v.crystal = st.saved.crystal;
    setSketchLook(b.object, false);
    if (revived) {
      b.revive();
      b.pages = Math.max(1, Math.ceil(this.ctx.tuning.player.maxPages / 2));
      this.ctx.events.emit('player:revived', { pid: m.slot });
      this.ctx.events.emit('sfx:play', {
        id: 'sketch_done',
        position: [b.position.x, b.position.y, b.position.z],
      });
    }
    this.env.onUp?.(m);
  }

  step(dt: number): void {
    const T = this.ctx.tuning.coop;
    const ms = this.members;
    if (ms.length < 2) {
      this.strain = 0;
      return;
    }
    // ── revive own downed wizards
    for (const m of ms) {
      const st = this.down.get(m.slot);
      if (!st || !m.body) continue;
      const partner = ms.find((o) => o !== m);
      const p = m.body.position;
      let ok = false;
      if (partner && !partner.api.downed && partner.api.crystalHeld) {
        const c = partner.api.crystalPos;
        ok = Math.hypot(c.x - p.x, c.z - p.z) <= T.downed.reviveRange && this.ctx.reveal.isRevealed(p.x, p.z);
      }
      st.revive = ok
        ? Math.min(1, st.revive + dt / T.downed.reviveHoldS)
        : Math.max(0, st.revive - dt * T.downed.reviveDecay);
      this.revive[m.slot] = st.revive;
      if (st.revive >= 1) this.getUp(m, true);
    }
    // ── everyone down → checkpoint reprint (authority only)
    if (this.env.authority && !this.allDown && ms.every((m) => m.api.downed || this.down.has(m.slot))) {
      this.allDown = true;
      this.ctx.events.emit('player:died', {});
    }
    // ── tether
    const a = ms[0]!.api.position;
    const b = ms[1]!.api.position;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    this.strain = Math.max(0, Math.min(1, (d - T.tether.soft) / (T.tether.hard - T.tether.soft)));
    this.pullCd = Math.max(0, this.pullCd - dt);
    if (d > T.tether.soft)
      for (const m of ms) {
        if (!m.body || m.api.downed) continue;
        const o = ms.find((x) => x !== m)!.api.position;
        const p = m.body.position;
        const ux = (o.x - p.x) / (d || 1);
        const uz = (o.z - p.z) / (d || 1);
        // soft leash: cancel the outward part of the motion, plus a gentle pull
        const away = -(m.body.velocity.x * ux + m.body.velocity.z * uz);
        const pull = T.tether.pullBack * this.strain * dt + Math.max(0, away) * this.strain * dt;
        p.x += ux * pull;
        p.z += uz * pull;
      }
    if (d > T.tether.hard && this.pullCd <= 0) {
      this.pullCd = 2;
      const lag = this.lagging();
      if (lag?.body) {
        const o = ms.find((x) => x !== lag)!.api.position;
        const p = lag.body.position;
        const ux = (p.x - o.x) / (d || 1);
        const uz = (p.z - o.z) / (d || 1);
        const x = o.x + ux * 1.6;
        const z = o.z + uz * 1.6;
        lag.body.teleport(x, this.ctx.collision.groundHeight(x, z), z);
        this.ctx.events.emit('fx:panelCut', {
          word: 'meanwhile',
          focus: [x, 1, z],
          reason: 'coop:meanwhile',
        });
      }
    }
    // ── Two-Page Spread: stay on your side of the gutter
    const sp = this.env.spread();
    const on = !!sp?.on;
    if (on && !this.spreadWas) {
      const s0 = a.x < sp!.x ? -1 : 1;
      this.spreadSide[ms[0]!.slot] = s0;
      this.spreadSide[ms[1]!.slot] = -s0;
    }
    this.spreadWas = on;
    if (on) {
      const hw = this.ctx.tuning.coop.spread.gutterHalfWidth + this.ctx.tuning.player.radius;
      for (const m of ms) {
        if (!m.body) continue;
        const side = this.spreadSide[m.slot]!;
        const p = m.body.position;
        if (side < 0 && p.x > sp!.x - hw) p.x = sp!.x - hw;
        else if (side > 0 && p.x < sp!.x + hw) p.x = sp!.x + hw;
      }
    }
  }

  /** Which wizard trails along the page path (the one pulled in by the hard tether). */
  lagging(): Member | null {
    const path = this.env.path();
    const ms = this.members;
    if (ms.length < 2) return null;
    if (!path || path.length < 2) return ms[1]!;
    const prog = (p: { x: number; z: number }) => {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < path.length; i++) {
        const q = path[i]!;
        const dd = (q[0] - p.x) ** 2 + (q[1] - p.z) ** 2;
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      }
      return best;
    };
    return prog(ms[0]!.api.position) <= prog(ms[1]!.api.position) ? ms[0]! : ms[1]!;
  }

  /**
   * A partner's dash went a→b: any OTHER local wizard it passed through gets ink. `from` is the
   * dasher's slot.
   */
  partnerDash(from: PlayerSlot, ax: number, az: number, bx: number, bz: number): void {
    const T = this.ctx.tuning.coop;
    for (const m of this.members) {
      if (m.slot === from || !m.body || this.down.has(m.slot)) continue;
      const p = m.body.position;
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1e-6;
      let t = ((p.x - ax) * dx + (p.z - az) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + dx * t - p.x;
      const qz = az + dz * t - p.z;
      if (qx * qx + qz * qz <= T.dashThroughRadius ** 2) {
        m.addInk(T.dashThroughInk);
        this.ctx.events.emit('sfx:play', { id: 'ink_pickup', position: [p.x, p.y + 1, p.z] });
      }
    }
  }

  /** Who's at the exit (HUD "waiting for your partner"). */
  atExit(slot: PlayerSlot): boolean {
    return (this.env.triggers()?.atExit[slot] ?? 0) === 1;
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
    for (const m of this.members) {
      if (m.body) {
        if (this.down.has(m.slot)) this.getUp(m, false);
        m.body.downedHook = null;
      }
    }
  }
}

export type { GameEvents };
