import * as THREE from 'three';
import type { EventBus, GameEvents } from '../../core/events';
import type {
  CollisionAPI,
  EnemyAPI,
  EnemyKind,
  PlayerAPI,
  RevealAPI,
  RunStats,
  TargetRegistry,
} from '../../core/types';
import type { Tuning } from '../../data/tuning';
import { AiState, Rng } from '../../systems/ai/fsm';
import { separation, steerToward, type V2 } from '../../systems/ai/steering';
import { BlotBrain } from './Blot';
import type { Brain, BrainWorld } from './brain';
import { Enemy, type EnemyOwner } from './Enemy';
import { Projectiles } from './Projectiles';
import { ScribblerBrain } from './Scribbler';
import { SmudgeBrain } from './Smudge';

/** Hard pool size: maxActive (tuning, default 8) alive + room for the ones still tearing apart. */
export const ENEMY_POOL = 16;
export const PROJECTILE_POOL = 16;

/** Onomatopoeia i18n keys used for the first-ever reveal panel cut of each kind. */
export const FIRST_REVEAL_WORD: Record<EnemyKind, string> = {
  smudge: 'fx.shff',
  scribbler: 'fx.skritch',
  blot: 'fx.splotch',
};

const BRAINS: Record<EnemyKind, Brain> = { smudge: SmudgeBrain, scribbler: ScribblerBrain, blot: BlotBrain };

/** Subset of GameContext the enemy system needs (GameContext satisfies it). */
export interface EnemyDeps {
  events: EventBus<GameEvents>;
  tuning: Tuning;
  reveal: RevealAPI;
  targets: TargetRegistry;
  player: PlayerAPI | null;
  stats?: RunStats;
  collision?: CollisionAPI | null;
}

/** Visual hooks; the renderer implements these to spawn paper/ink particles. */
export interface EnemyFxSink {
  death(e: Enemy): void;
  hit(e: Enemy, fromX: number, fromZ: number): void;
  projectileEnd(x: number, z: number, hitPlayer: boolean): void;
}

/**
 * Owns the enemy pool, runs the FSM + steering at the fixed sim rate, handles damage, reveal
 * events and scribbler projectiles. Call `step(dt)` after the player has written
 * `reveal.targetRadius` and before `reveal.update(dt)` (blots suppress the target radius).
 */
export class EnemySystem implements EnemyOwner, BrainWorld {
  readonly pool: Enemy[] = [];
  readonly projectiles = new Projectiles(PROJECTILE_POOL);
  readonly rng: Rng;
  fx: EnemyFxSink | null = null;
  /** Kinds revealed at least once this run (first reveal → panel cut). */
  readonly seenKinds = new Set<EnemyKind>();

  // BrainWorld player snapshot (refreshed each step)
  playerX = 0;
  playerZ = 0;
  playerVX = 0;
  playerVZ = 0;
  playerRadius = 0.35;
  hasPlayer = false;
  baseRevealTarget = 0;

  private nextId = 1;
  private aliveN = 0;
  private suppress = 1;
  private readonly desired: V2 = { x: 0, z: 0 };
  private readonly push: V2 = { x: 0, z: 0 };
  private readonly scratch2 = new THREE.Vector2();

  constructor(
    readonly deps: EnemyDeps,
    seed = 1337,
  ) {
    this.rng = new Rng(seed);
    for (let i = 0; i < ENEMY_POOL; i++) this.pool.push(new Enemy(this));
  }

  get tuning(): Tuning {
    return this.deps.tuning;
  }
  get reveal(): RevealAPI {
    return this.deps.reveal;
  }
  /** Alive (hittable) enemies; dying ones don't count against maxActive. */
  get activeCount(): number {
    return this.aliveN;
  }

  forEachAlive(fn: (e: EnemyAPI) => void): void {
    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[i]!;
      if (e.alive) fn(e);
    }
  }

  /** Spawn one enemy at (x,z). Returns null if maxActive alive enemies already exist. */
  spawn(kind: EnemyKind, x: number, z: number): Enemy | null {
    if (this.aliveN >= this.tuning.enemies.maxActive) return null;
    let e: Enemy | null = null;
    for (let i = 0; i < this.pool.length; i++) {
      if (!this.pool[i]!.active) {
        e = this.pool[i]!;
        break;
      }
    }
    if (!e) return null;
    const ai = this.tuning.enemies.ai;
    e.id = this.nextId++;
    e.kind = kind;
    e.position.set(x, this.groundY(x, z), z);
    e.velocity.set(0, 0, 0);
    e.active = true;
    e.alive = true;
    e.revealed = false;
    e.seen = false;
    e.seed = this.rng.next();
    e.yaw = this.rng.range(-Math.PI, Math.PI);
    e.revealVis = 0;
    e.spawnT = 0;
    e.hitT = 0;
    e.deathT = 0;
    e.windup = 0;
    e.lunge = 0;
    e.recoil = 0;
    e.drain = 0;
    e.speed01 = 0;
    e.lagX = e.lagZ = 0;
    e.contactCd = 0;
    e.fireCd = 0;
    e.ballistic = false;
    e.hitPlayer = false;
    BRAINS[kind].init(e, this);
    e.setState(AiState.Idle, this.rng.range(ai.idleMin, ai.idleMax));
    this.aliveN++;
    this.deps.targets.add(e);
    this.deps.events.emit('enemy:spawn', { id: e.id, kind });
    return e;
  }

  /** Remove everything instantly (page change / respawn). No events. */
  clear(): void {
    for (const e of this.pool) {
      if (e.active) this.deps.targets.remove(e);
      e.active = false;
      e.alive = false;
    }
    this.aliveN = 0;
    this.projectiles.clear();
  }

  /** Kill every alive enemy with full death FX (debug / boss phase wipe). */
  killAll(): void {
    for (const e of this.pool) if (e.alive) this.die(e, e.position.x, e.position.z + 1);
  }

  // ───────────── sim ─────────────

  step(dt: number): void {
    const d = this.deps;
    const t = this.tuning.enemies;
    const ai = t.ai;
    const p = d.player;
    this.hasPlayer = !!p;
    if (p) {
      this.playerX = p.position.x;
      this.playerZ = p.position.z;
      this.playerVX = p.velocity.x;
      this.playerVZ = p.velocity.z;
    }
    this.playerRadius = this.tuning.player.radius;
    this.baseRevealTarget = d.reveal.targetRadius;
    this.suppress = 1;

    const pool = this.pool;
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i]!;
      if (!e.active) continue;
      e.stateT += dt;
      e.hitT = Math.max(0, e.hitT - dt / ai.hitFlash);
      e.contactCd = Math.max(0, e.contactCd - dt);
      e.spawnT = Math.min(1, e.spawnT + dt / ai.spawnTime);

      if (e.state === AiState.Die) {
        this.stepDying(e, dt);
        continue;
      }

      this.updateReveal(e, dt);

      const desired = this.desired;
      desired.x = 0;
      desired.z = 0;
      const brain = BRAINS[e.kind];
      if (e.state === AiState.Idle) {
        if (e.stateT >= e.stateDur && this.hasPlayer) {
          const dx = this.playerX - e.position.x;
          const dz = this.playerZ - e.position.z;
          if (dx * dx + dz * dz <= ai.aggroRange * ai.aggroRange) brain.stalk(e, this);
        }
      } else if (e.state === AiState.Recoil) {
        e.recoil = Math.max(0, 1 - e.stateT / Math.max(1e-3, e.stateDur));
        const k = Math.exp(-ai.recoilDrag * dt);
        e.velocity.x *= k;
        e.velocity.z *= k;
        if (e.stateT >= e.stateDur) {
          e.recoil = 0;
          brain.stalk(e, this);
        }
      } else {
        brain.update(e, this, dt, desired);
      }

      if (e.state !== AiState.Recoil && !e.ballistic && e.alive) {
        const push = this.push;
        push.x = 0;
        push.z = 0;
        separation(push, e, pool, pool.length, ai.separationRadius, ai.separationForce);
        desired.x += push.x;
        desired.z += push.z;
        steerToward(e.velocity, desired, ai.steerAccel, dt);
      }
      if (e.alive) this.integrate(e, dt);
    }

    if (this.suppress < 1) {
      const floor = this.baseRevealTarget * t.blotAi.minRadiusFactor;
      d.reveal.targetRadius = Math.max(floor, this.baseRevealTarget * this.suppress);
    }

    this.stepProjectiles(dt);
  }

  private integrate(e: Enemy, dt: number): void {
    const v = e.velocity;
    let nx = e.position.x + v.x * dt;
    let nz = e.position.z + v.z * dt;
    const col = this.deps.collision;
    if (col) {
      const r = this.scratch2;
      if (col.resolveCircle(nx, nz, e.radius, r)) {
        nx = r.x;
        nz = r.y;
      }
    }
    e.position.x = nx;
    e.position.z = nz;
    e.position.y = this.groundY(nx, nz);

    // Face movement, or the target while winding up.
    const sp = Math.sqrt(v.x * v.x + v.z * v.z);
    let want = e.yaw;
    if (e.state === AiState.Attack && e.phase === 0) {
      want = Math.atan2(e.aimX - e.position.x, e.aimZ - e.position.z);
    } else if (e.ballistic) {
      want = Math.atan2(e.aimX, e.aimZ);
    } else if (e.state === AiState.Recoil && this.hasPlayer) {
      want = Math.atan2(this.playerX - e.position.x, this.playerZ - e.position.z);
    } else if (sp > 0.25) {
      want = Math.atan2(v.x, v.z);
    } else if (this.hasPlayer && e.state !== AiState.Idle) {
      want = Math.atan2(this.playerX - e.position.x, this.playerZ - e.position.z);
    }
    let dy = want - e.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    e.yaw += dy * Math.min(1, dt * (e.ballistic ? 20 : 7));

    const kindSpeed = this.tuning.enemies[e.kind].speed;
    e.speed01 = Math.min(1.5, sp / kindSpeed);
    // Local-space velocity (x right, z forward) smoothed for cloth lag.
    const c = Math.cos(e.yaw);
    const s = Math.sin(e.yaw);
    const lx = v.x * c - v.z * s;
    const lz = v.x * s + v.z * c;
    const k = Math.min(1, dt * 6);
    e.lagX += (lx - e.lagX) * k;
    e.lagZ += (lz - e.lagZ) * k;
  }

  private updateReveal(e: Enemy, dt: number): void {
    const ai = this.tuning.enemies.ai;
    const rv = this.deps.reveal.revealAt(e.position.x, e.position.z);
    const was = e.revealed;
    e.revealed = was ? rv > ai.revealOff : rv > ai.revealOn;
    if (e.revealed) e.revealVis = Math.min(1, e.revealVis + dt * ai.revealFadeIn);
    else e.revealVis = Math.max(0, e.revealVis - dt * ai.revealFadeOut);
    if (e.revealed && !was) {
      const ev = this.deps.events;
      const first = !this.seenKinds.has(e.kind);
      this.seenKinds.add(e.kind);
      if (!e.seen) {
        e.seen = true;
        ev.emit('sfx:play', { id: 'ghost_reveal', position: [e.position.x, e.position.y + 1, e.position.z] });
      }
      ev.emit('enemy:revealed', { id: e.id, kind: e.kind, first });
      if (first) {
        ev.emit('fx:panelCut', {
          word: FIRST_REVEAL_WORD[e.kind],
          focus: [e.position.x, e.position.y + 1, e.position.z],
          reason: `first-${e.kind}`,
        });
      }
    }
  }

  private stepDying(e: Enemy, dt: number): void {
    const ai = this.tuning.enemies.ai;
    e.deathT = Math.min(1, e.deathT + dt / ai.deathTime);
    const k = Math.exp(-4 * dt);
    e.velocity.x *= k;
    e.velocity.z *= k;
    e.position.x += e.velocity.x * dt;
    e.position.z += e.velocity.z * dt;
    e.revealVis = Math.min(1, e.revealVis + dt * ai.revealFadeIn);
    if (e.deathT >= 1) {
      e.active = false;
      this.deps.targets.remove(e);
    }
  }

  private stepProjectiles(dt: number): void {
    const pr = this.projectiles;
    const a = this.tuning.enemies.scribblerAi;
    const p = this.deps.player;
    const hitR = a.projectileRadius + this.playerRadius;
    const col = this.deps.collision;
    for (let i = 0; i < pr.capacity; i++) {
      if (!pr.active[i]) continue;
      pr.age[i]! += dt;
      const sp = a.projectileSpeed * dt;
      const ox = pr.x[i]!;
      const oz = pr.z[i]!;
      pr.x[i] = ox + pr.dx[i]! * sp;
      pr.z[i] = oz + pr.dz[i]! * sp;
      if (pr.age[i]! >= pr.life[i]!) {
        pr.kill(i);
        this.fx?.projectileEnd(pr.x[i]!, pr.z[i]!, false);
        continue;
      }
      if (col && !col.segmentClear(ox, oz, pr.x[i]!, pr.z[i]!)) {
        pr.kill(i);
        this.fx?.projectileEnd(pr.x[i]!, pr.z[i]!, false);
        continue;
      }
      if (p && !p.invulnerable) {
        const dx = p.position.x - pr.x[i]!;
        const dz = p.position.z - pr.z[i]!;
        if (dx * dx + dz * dz <= hitR * hitR) {
          pr.kill(i);
          p.damage(this.tuning.enemies.scribbler.damage, 'scribbler');
          this.deps.events.emit('fx:shake', { intensity: 0.35, duration: 0.2 });
          this.fx?.projectileEnd(pr.x[i]!, pr.z[i]!, true);
        }
      }
    }
  }

  // ───────────── BrainWorld ─────────────

  telegraph(e: Enemy, duration: number): void {
    this.deps.events.emit('enemy:telegraph', { id: e.id, kind: e.kind, duration });
  }

  fireProjectile(e: Enemy, dirX: number, dirZ: number): void {
    const a = this.tuning.enemies.scribblerAi;
    const ox = e.position.x + dirX * (e.radius + 0.35);
    const oz = e.position.z + dirZ * (e.radius + 0.35);
    // Pool full → shot dropped silently (maxProjectiles is a perf budget, not a rule).
    this.projectiles.fire(ox, oz, dirX, dirZ, a.projectileLife, this.rng.next(), a.maxProjectiles);
    this.deps.events.emit('sfx:play', { id: 'scribble_fire', position: [ox, 1.2, oz] });
  }

  touchPlayer(e: Enemy): boolean {
    const p = this.deps.player;
    if (!p || e.contactCd > 0 || !e.alive) return false;
    const dx = this.playerX - e.position.x;
    const dz = this.playerZ - e.position.z;
    const r = e.radius + this.playerRadius;
    if (dx * dx + dz * dz > r * r) return false;
    e.contactCd = this.tuning.enemies.ai.contactCooldown;
    if (!p.invulnerable) {
      p.damage(this.tuning.enemies[e.kind].damage, e.kind);
      this.deps.events.emit('fx:shake', { intensity: 0.45, duration: 0.22 });
    }
    return true;
  }

  lineClear(ax: number, az: number, bx: number, bz: number): boolean {
    const col = this.deps.collision;
    return col ? col.segmentClear(ax, az, bx, bz) : true;
  }

  suppressReveal(factor: number): void {
    this.suppress *= factor;
  }

  drainPulse(e: Enemy): void {
    this.deps.events.emit('sfx:play', { id: 'blot_drain', position: [e.position.x, 0.5, e.position.z] });
  }

  // ───────────── damage ─────────────

  onEnemyHit(e: Enemy, amount: number, from: THREE.Vector3): void {
    const ai = this.tuning.enemies.ai;
    e.hp -= amount;
    e.hitT = 1;
    this.fx?.hit(e, from.x, from.z);
    if (e.hp <= 0) {
      this.die(e, from.x, from.z);
      return;
    }
    // Interrupts any windup/telegraph: hitting a charging enemy is the skill expression.
    let dx = e.position.x - from.x;
    let dz = e.position.z - from.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= d;
    dz /= d;
    e.ballistic = false;
    e.windup = 0;
    e.lunge = 0;
    e.drain = 0;
    e.setState(AiState.Recoil, ai.recoilTime);
    e.recoil = 1;
    const imp = ai.recoilImpulse * (e.kind === 'blot' ? 0.6 : 1);
    e.velocity.x = dx * imp;
    e.velocity.z = dz * imp;
    this.deps.events.emit('fx:shake', { intensity: 0.12, duration: 0.08 });
  }

  private die(e: Enemy, fromX: number, fromZ: number): void {
    const ev = this.deps.events;
    const t = this.tuning.enemies;
    let dx = e.position.x - fromX;
    let dz = e.position.z - fromZ;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= d;
    dz /= d;
    e.alive = false;
    e.ballistic = false;
    e.windup = e.lunge = e.drain = 0;
    e.setState(AiState.Die, t.ai.deathTime);
    e.deathT = 0;
    e.velocity.x = dx * 2.5;
    e.velocity.z = dz * 2.5;
    this.aliveN--;
    if (this.deps.stats) this.deps.stats.ghostsInked++;
    const pos: [number, number, number] = [e.position.x, e.position.y, e.position.z];
    ev.emit('enemy:died', { id: e.id, kind: e.kind, position: pos });
    ev.emit('ink:drop', { position: [pos[0], pos[1], pos[2]], amount: t[e.kind].inkDrop, kind: e.kind });
    ev.emit('sfx:play', { id: 'ghost_die', position: [pos[0], pos[1] + 1, pos[2]] });
    ev.emit('fx:shake', { intensity: 0.28, duration: 0.16 });
    ev.emit('fx:hitstop', { duration: 0.06 });
    this.fx?.death(e);
  }

  private groundY(x: number, z: number): number {
    const col = this.deps.collision;
    return col ? col.groundHeight(x, z) : 0;
  }
}
