/**
 * Guest-side mirrors of host-owned systems (kept out of the initial bundle):
 *  - EnemyMirror: the EnemySystem in puppet mode (no AI; spawn / death / strokes come from the
 *    host, positions from snapshots; only reveal visibility, dying FX and local projectile hits
 *    run here).
 *  - crystalView: RevealAPI facade for the partner crystal (RevealSystem crystal 1).
 */
import type { EventBus, GameEvents } from '../core/events';
import type { EliteAffix, EnemyKind, PlayerAPI, RevealAPI } from '../core/types';
import type { Enemy } from '../entities/enemies/Enemy';
import type { EnemySystem } from '../entities/enemies/EnemySystem';
import type { RevealSystem } from '../render/reveal/RevealSystem';
import { AiState } from '../systems/ai/fsm';
import type { Triggers } from '../systems/triggers';

export class EnemyMirror {
  constructor(readonly sys: EnemySystem) {}

  /** Switch the system into (or out of) puppet mode. */
  enable(on: boolean): void {
    const s = this.sys;
    s.puppet = on;
    s.puppetStep = on ? (dt) => this.step(dt) : null;
  }

  /** Create the host's enemy `id` locally (no cap). */
  spawn(id: number, kind: EnemyKind, x: number, z: number, elite: EliteAffix | null): Enemy | null {
    const s = this.sys;
    const have = s.byId(id);
    if (have) return have;
    const keep = s.nextId;
    const e = s.spawnAt(kind, x, z, elite ? { elite } : undefined, true, id);
    s.nextId = keep;
    return e;
  }

  /** The host says `id` died (death FX + drop events run locally). */
  die(id: number, fromX: number, fromZ: number): void {
    const e = this.sys.byId(id);
    if (e?.alive) this.sys.die(e, fromX, fromZ);
  }

  /** A host-fired scribbler stroke (simulated here so this client tests its own wizard). */
  fire(ox: number, oz: number, dx: number, dz: number, life: number, seed: number): void {
    const s = this.sys;
    s.projectiles.fire(ox, oz, dx, dz, life, seed, s.tuning.enemies.scribblerAi.maxProjectiles);
    s.deps.events.emit('sfx:play', { id: 'scribble_fire', position: [ox, 1.2, oz] });
  }

  step(dt: number): void {
    const s = this.sys;
    const ai = s.tuning.enemies.ai;
    for (let i = 0; i < s.pool.length; i++) {
      const e = s.pool[i]!;
      if (!e.active) continue;
      e.stateT += dt;
      e.age += dt;
      e.hitT = Math.max(0, e.hitT - dt / ai.hitFlash);
      e.spawnT = Math.min(1, e.spawnT + dt / ai.spawnTime);
      if (e.state === AiState.Die) {
        s.stepDying(e, dt);
        continue;
      }
      s.updateReveal(e, dt);
      const v = e.velocity;
      e.speed01 = Math.min(1.5, Math.sqrt(v.x * v.x + v.z * v.z) / s.tuning.enemies[e.kind].speed);
    }
    s.stepProjectiles(dt);
    s.stepCranes(dt);
  }
}

const standing = (p: PlayerAPI | null | undefined): p is PlayerAPI => !!p && !p.downed;

/**
 * Co-op enemy targeting: nearest standing wizard with hysteresis (switch only when the other one
 * is `targetHysteresis` m closer); Blots go for the larger reveal (more ink to drink). The
 * attacker cap stays shared (EnemySystem.requestAttack counts every attack in flight).
 */
export function installCoopTargeting(sys: EnemySystem, on = true): void {
  if (!on) {
    sys.chooseTarget = null;
    return;
  }
  sys.chooseTarget = (i: number, e: Enemy, fresh: boolean) => {
    const pl = sys.pl;
    const x = e.position.x;
    const z = e.position.z;
    const d = (p: PlayerAPI) => Math.hypot(p.position.x - x, p.position.z - z);
    if (fresh) {
      const a = pl[0];
      const b = pl[1];
      if (!standing(b)) return 0;
      if (!standing(a)) return 1;
      return d(b) < d(a) ? 1 : 0;
    }
    const cur = sys.tgt[i]! & 1;
    const o = 1 - cur;
    const pc = pl[cur];
    const po = pl[o];
    let next = cur;
    if (!standing(pc)) next = standing(po) ? o : cur;
    else if (standing(po)) {
      const cr = sys.deps.crystals;
      if (e.kind === 'blot' && cr) {
        if ((cr[o]?.radius ?? 0) > (cr[cur]?.radius ?? 0) + 0.5) next = o;
      } else if (d(po) + sys.tuning.coop.targetHysteresis < d(pc)) next = o;
    }
    sys.tgt[i] = next;
    return next;
  };
}

const views = new WeakMap<RevealSystem, RevealAPI>();

/** RevealAPI facade for crystal 1 (center2 / radius2 / targetRadius2); the rest is shared. */
export function crystalView(sys: RevealSystem): RevealAPI {
  const have = views.get(sys);
  if (have) return have;
  const v: RevealAPI = {
    get center() {
      return sys.center2;
    },
    get radius() {
      return sys.radius2;
    },
    set radius(r: number) {
      sys.radius2 = r;
    },
    get targetRadius() {
      return sys.targetRadius2;
    },
    set targetRadius(r: number) {
      sys.targetRadius2 = r;
    },
    get blankPage() {
      return sys.blankPage;
    },
    set blankPage(b: number) {
      sys.blankPage = b;
    },
    get uniforms() {
      return sys.uniforms;
    },
    addSource: (x, z, r, life) => sys.addSource(x, z, r, life),
    removeSource: (h) => sys.removeSource(h),
    eraseStrip: (ax, az, bx, bz, hw) => sys.eraseStrip(ax, az, bx, bz, hw),
    revealAt: (x, z) => sys.revealAt(x, z),
    isRevealed: (x, z) => sys.isRevealed(x, z),
    // the owning system updates / resets both crystals
    update: () => {},
    reset: () => {},
  };
  views.set(sys, v);
  return v;
}

// ───────────────────────────── page save / replicas ─────────────────────────────

/** Ids of every spent trigger (co-op page save). */
export function spentIds(t: Triggers): string[] {
  const out: string[] = [];
  for (let i = 0; i < t.defs.length; i++) if (t.spent[i]) out.push(t.defs[i]!.id);
  return out;
}

/** Mark triggers spent without firing them (page save restore). */
export function markSpent(t: Triggers, ids: readonly string[]): void {
  for (let i = 0; i < t.defs.length; i++) if (ids.includes(t.defs[i]!.id)) t.spent[i] = 1;
}

/** Guest: play a host trigger locally (its action + `trigger:fired`), marking it spent. */
export function fireReplica(t: Triggers, events: EventBus<GameEvents>, id: string): void {
  const i = t.defs.findIndex((d) => d.id === id);
  if (i < 0) {
    events.emit('trigger:fired', { id });
    return;
  }
  t.spent[i] = 1;
  t.fire(t.defs[i]!);
}

/**
 * Rejoin: the reveal history map as bytes (R = ink, G = erased, then one byte of permanence per
 * texel). Mostly zeros: rleEncode on the wire.
 */
export function exportHistory(rv: RevealSystem): Uint8Array {
  const n = rv.size * rv.size;
  const out = new Uint8Array(n * 3);
  out.set(rv.bytes, 0);
  out.set(rv.perm, n * 2);
  return out;
}

/** Rejoin: restore `exportHistory()` output (false if the map size doesn't match). */
export function importHistory(rv: RevealSystem, data: Uint8Array): boolean {
  const n = rv.size * rv.size;
  if (data.length !== n * 3) return false;
  rv.bytes.set(data.subarray(0, n * 2));
  rv.perm.set(data.subarray(n * 2));
  for (let k = 0; k < n; k++) rv.hist[k] = rv.bytes[k * 2]! / 255;
  rv.regionLast.fill(rv.time);
  rv.histTex.needsUpdate = true;
  return true;
}
