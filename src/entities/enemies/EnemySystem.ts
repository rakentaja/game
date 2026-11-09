import * as THREE from 'three';
import type { EventBus, GameEvents } from '../../core/events';
import type {
  BeatAPI,
  CollisionAPI,
  EliteAffix,
  EnemyAPI,
  EnemyKind,
  PlayerAPI,
  RevealAPI,
  RunStats,
  Settings,
  SfxId,
  TargetRegistry,
} from '../../core/types';
import type { Tuning } from '../../data/tuning';
import { AiState, Rng } from '../../systems/ai/fsm';
import { separation, steerToward, type V2 } from '../../systems/ai/steering';
import { BlotBrain } from './Blot';
import type { Brain, BrainWorld } from './brain';
import { type CraneOwner, CranesBrain, CraneTarget } from './Cranes';
import { Enemy, type EnemyOwner } from './Enemy';
import { MarginManBrain } from './MarginMan';
import { MisprintBrain } from './Misprint';
import { PanelWardenBrain } from './PanelWarden';
import { Projectiles } from './Projectiles';
import { RedactorBrain } from './Redactor';
import { ScribblerBrain } from './Scribbler';
import { SmudgeBrain } from './Smudge';

/** Hard pool size: maxActive (tuning, default 8) alive + room for the ones still tearing apart. */
export const ENEMY_POOL = 16;
export const PROJECTILE_POOL = 16;
/** Origami cranes across every live swarm (2 full swarms). */
export const CRANE_POOL = 14;

/** Onomatopoeia keys (`onomatopoeia.<key>` in i18n) for the first-ever reveal panel cut of each kind. */
export const FIRST_REVEAL_WORD: Record<EnemyKind, string> = {
  smudge: 'shff',
  scribbler: 'skritch',
  blot: 'splotch',
  marginMan: 'klik',
  redactor: 'redacted',
  panelWarden: 'thunk',
  misprint: 'misprint',
  cranes: 'swish',
};

export const BRAINS: Record<EnemyKind, Brain> = {
  smudge: SmudgeBrain,
  scribbler: ScribblerBrain,
  blot: BlotBrain,
  marginMan: MarginManBrain,
  redactor: RedactorBrain,
  panelWarden: PanelWardenBrain,
  misprint: MisprintBrain,
  cranes: CranesBrain,
};

/** Kinds whose attacks don't take one of the limited attack tokens (they never "strike"). */
const TOKENLESS: Partial<Record<EnemyKind, true>> = { blot: true, redactor: true, misprint: true };

const AFFIXES: readonly EliteAffix[] = ['firstEdition', 'inkedIn', 'bleedThrough'];

export interface SpawnOptions {
  /** Explicit affix, 'roll' (tuning chance x difficulty) or none (default). */
  elite?: EliteAffix | 'roll' | null;
}

/** Subset of GameContext the enemy system needs (GameContext satisfies it). */
export interface EnemyDeps {
  events: EventBus<GameEvents>;
  tuning: Tuning;
  reveal: RevealAPI;
  targets: TargetRegistry;
  player: PlayerAPI | null;
  stats?: RunStats;
  collision?: CollisionAPI | null;
  /** For difficulty scaling (TUNING.difficulty[settings.difficulty]). Defaults to normal. */
  settings?: Pick<Settings, 'difficulty'>;
  /** Shared beat clock (ctx.beat). Optional: `audio:beat` events are used when it's absent. */
  beat?: BeatAPI | null;
}

/** Visual hooks; the renderer implements these to spawn paper/ink particles. */
export interface EnemyFxSink {
  death(e: Enemy): void;
  hit(e: Enemy, fromX: number, fromZ: number): void;
  projectileEnd(x: number, z: number, hitPlayer: boolean): void;
  /** One crane torn out of a swarm (optional). */
  craneDeath?(c: CraneTarget): void;
}

/**
 * Owns the enemy pool, runs the FSM + steering at the fixed sim rate, handles damage, reveal
 * events and scribbler projectiles. Call `step(dt)` after the player has written
 * `reveal.targetRadius` and before `reveal.update(dt)` (blots suppress the target radius).
 */
export class EnemySystem implements EnemyOwner, CraneOwner, BrainWorld {
  readonly pool: Enemy[] = [];
  readonly cranes: CraneTarget[] = [];
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
  crystalHeld = false;
  baseRevealTarget = 0;
  beatCount = 0;
  beatNow = false;
  beatLen = 0;
  private beatPending = false;
  private beatAge = 99;
  private lastBeatPhase = -1;
  private dashPending = false;
  private readonly dashSeg = new Float32Array(4);
  tempo = 1;
  speedMul = 1;
  drainMul = 1;
  private maxAttackers = 2;
  private attackers = 0;

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
    for (let i = 0; i < CRANE_POOL; i++) this.cranes.push(new CraneTarget(this));
    const ev = deps.events;
    this.offs.push(
      ev.on('player:dash', (d) => {
        // the payload is reused by the player: copy it out
        this.dashSeg[0] = d.from[0];
        this.dashSeg[1] = d.from[2];
        this.dashSeg[2] = d.to[0];
        this.dashSeg[3] = d.to[2];
        this.dashPending = true;
      }),
      ev.on('audio:beat', (b) => {
        if (b.bpm > 0) this.beatLen = 60 / b.bpm;
        this.beatPending = true;
      }),
      // The Editor's summoned ghosts tear apart with it.
      ev.on('boss:death', (e) => {
        if (e.stage === 'inked') this.killAll();
      }),
      // Respawn grace: nobody attacks the instant the player is back on their feet.
      ev.on('player:respawn', () => this.calm()),
    );
  }

  private readonly offs: (() => void)[] = [];

  /** Cancel every attack in flight and restart the first-attack grace (respawn, cutscenes). */
  calm(): void {
    for (const e of this.pool) {
      if (!e.alive) continue;
      e.age = 0;
      e.ballistic = false;
      e.windup = e.lunge = e.drain = 0;
      if (e.state === AiState.Attack) {
        BRAINS[e.kind].interrupt?.(e, this);
        BRAINS[e.kind].stalk(e, this);
      }
    }
    this.projectiles.clear();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.clear();
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
  spawn(kind: EnemyKind, x: number, z: number, opts?: SpawnOptions): Enemy | null {
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
    e.age = 0;
    e.fireCd = 0;
    e.ballistic = false;
    e.hitPlayer = false;
    e.inked = false;
    e.vulnerable = true;
    e.attacking = false;
    e.stunT = e.vulnT = 0;
    e.shield = e.expose = e.align = 0;
    e.cycleT = e.timerA = e.timerB = 0;
    e.boxHalf = 0;
    e.seam = 0;
    e.worn = false;
    e.inkHoldT = 0;
    e.speedBuff = 1;
    e.flock.length = 0;
    e.elite = null;
    BRAINS[kind].init(e, this);
    if (kind === 'cranes' && e.flock.length === 0) {
      // crane pool exhausted: refuse rather than spawn an empty swarm
      e.active = e.alive = false;
      return null;
    }
    this.applyElite(e, opts?.elite ?? null);
    e.setState(AiState.Idle, this.rng.range(ai.idleMin, ai.idleMax));
    this.aliveN++;
    this.deps.targets.add(e);
    this.deps.events.emit('enemy:spawn', { id: e.id, kind });
    return e;
  }

  private applyElite(e: Enemy, want: EliteAffix | 'roll' | null): void {
    if (!want || e.kind === 'cranes') return;
    let affix: EliteAffix | null = null;
    if (want === 'roll') {
      const el = this.tuning.enemies.elites;
      const chance = el.chance * (this.diff().eliteMul ?? 1);
      if (this.rng.next() < chance)
        affix = AFFIXES[Math.floor(this.rng.next() * AFFIXES.length) % AFFIXES.length]!;
    } else affix = want;
    if (!affix) return;
    e.elite = affix;
    if (affix === 'firstEdition') {
      e.hp += this.tuning.enemies.elites.firstEditionHp;
      e.maxHp = e.hp;
    }
  }

  private diff() {
    const t = this.tuning.difficulty;
    return t[this.deps.settings?.difficulty ?? 'normal'] ?? t.normal;
  }

  /** Free crane boids -> `e.flock`, laid out around the swarm's spawn point. */
  attachCranes(e: Enemy, n: number): number {
    const a = this.tuning.enemies.craneAi;
    for (let i = 0; i < this.cranes.length && e.flock.length < n; i++) {
      const c = this.cranes[i]!;
      if (c.active) continue;
      const k = e.flock.length;
      const ang = (k / n) * Math.PI * 2 + this.rng.range(-0.3, 0.3);
      c.id = this.nextId++;
      c.swarm = e;
      c.active = c.alive = true;
      c.inked = false;
      c.radius = a.radius;
      c.mode = 0;
      c.t = this.rng.range(0, 3);
      c.dur = 0;
      c.vx = c.vz = 0;
      c.fold = 0;
      c.seed = this.rng.next();
      c.height = a.flyHeight;
      c.dieT = 0;
      c.revealVis = 0;
      c.hitT = 0;
      c.position.set(e.position.x + Math.cos(ang) * 1.2, e.position.y, e.position.z + Math.sin(ang) * 1.2);
      c.yaw = ang;
      e.flock.push(c);
      this.deps.targets.add(c);
    }
    return e.flock.length;
  }

  /** Remove everything instantly (page change / respawn). No events. */
  clear(): void {
    for (const e of this.pool) {
      if (e.active) this.deps.targets.remove(e);
      e.active = false;
      e.alive = false;
      e.flock.length = 0;
      e.boxHalf = 0;
    }
    for (const c of this.cranes) {
      if (c.active) this.deps.targets.remove(c);
      c.active = c.alive = false;
      c.swarm = null;
    }
    this.aliveN = 0;
    this.projectiles.clear();
    this.dashPending = false;
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
    this.crystalHeld = !!p?.crystalHeld;
    this.playerRadius = this.tuning.player.radius;
    this.baseRevealTarget = d.reveal.targetRadius;
    this.suppress = 1;
    this.stepBeat(dt);
    const diff = this.diff();
    const fallback = diff.gimmickFallback ?? 18;
    this.tempo = diff.enemyTempo ?? 1;
    if (p && p.energy < this.tuning.bolt.cost) this.tempo *= ai.mercyTempo;
    this.speedMul = diff.enemySpeed ?? 1;
    this.drainMul = diff.drainMul ?? 1;
    this.maxAttackers = Math.min(ai.maxAttackers, diff.maxAttackers ?? ai.maxAttackers);
    this.attackers = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[i]!;
      if (e.alive && e.state === AiState.Attack && !TOKENLESS[e.kind]) this.attackers++;
    }
    const dash = this.dashPending;
    this.dashPending = false;

    const pool = this.pool;
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i]!;
      if (!e.active) continue;
      e.stateT += dt;
      e.age += dt;
      e.hitT = Math.max(0, e.hitT - dt / ai.hitFlash);
      e.contactCd = Math.max(0, e.contactCd - dt);
      e.spawnT = Math.min(1, e.spawnT + dt / ai.spawnTime);

      if (e.state === AiState.Die) {
        this.stepDying(e, dt);
        continue;
      }

      const brain = BRAINS[e.kind];
      e.vulnT = Math.max(0, e.vulnT - dt);
      if (!e.worn && brain.vulnerable && e.age >= fallback) e.worn = true;
      this.updateReveal(e, dt);
      if (dash && brain.onDash) {
        const s = this.dashSeg;
        brain.onDash(e, this, s[0]!, s[1]!, s[2]!, s[3]!);
        if (!e.alive) continue;
      }

      const desired = this.desired;
      desired.x = 0;
      desired.z = 0;
      if (e.stunT > 0) {
        // Stunned: AI frozen, drifts to a stop, hittable whatever its gimmick.
        e.stunT = Math.max(0, e.stunT - dt);
        e.windup = e.lunge = 0;
        const k = Math.exp(-ai.recoilDrag * dt);
        e.velocity.x *= k;
        e.velocity.z *= k;
        if (e.stunT <= 0) brain.stalk(e, this);
      } else if (e.state === AiState.Idle) {
        brain.idle?.(e, this, dt);
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
        if (e.speedBuff !== 1) {
          desired.x *= e.speedBuff;
          desired.z *= e.speedBuff;
        }
      }
      if (!e.alive) continue;
      e.vulnerable = !brain.vulnerable || e.worn || brain.vulnerable(e, this);
      e.attacking = e.stunT <= 0 && ((e.state === AiState.Attack && e.phase === 0) || e.windup > 0.02);

      if (brain.selfMove) {
        e.position.y = this.groundY(e.position.x, e.position.z);
        continue;
      }
      if (e.state !== AiState.Recoil && e.stunT <= 0 && !e.ballistic && e.alive) {
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
      // Floor keeps a latched blot lit & shootable; never raises a radius that's already lower.
      const base = this.baseRevealTarget;
      const floor = Math.min(base, Math.max(t.blotAi.minRadius, base * t.blotAi.minRadiusFactor));
      d.reveal.targetRadius = Math.max(floor, base * this.suppress);
    }

    this.stepProjectiles(dt);
    this.stepCranes(dt);
  }

  private stepBeat(dt: number): void {
    // Prefer the shared beat clock: a wrap of phase() is a beat.
    const b = this.deps.beat;
    if (b && b.bpm > 0) {
      const ph = b.phase();
      if (this.lastBeatPhase >= 0 && ph < this.lastBeatPhase - 0.5) this.beatPending = true;
      this.lastBeatPhase = ph;
      this.beatLen = 60 / b.bpm;
    }
    this.beatNow = this.beatPending;
    this.beatPending = false;
    if (this.beatNow) {
      this.beatCount++;
      this.beatAge = 0;
    } else this.beatAge += dt;
    // no beats for a while (music stopped): drop back to the free-running clocks
    if (this.beatAge > 3) this.beatLen = 0;
  }

  private stepCranes(dt: number): void {
    const ai = this.tuning.enemies.ai;
    const rv = this.deps.reveal;
    for (let i = 0; i < this.cranes.length; i++) {
      const c = this.cranes[i]!;
      if (!c.active) continue;
      c.hitT = Math.max(0, c.hitT - dt / ai.hitFlash);
      if (!c.alive) {
        c.dieT = Math.min(1, c.dieT + dt / 0.7);
        c.height = Math.max(0.05, c.height - dt * 2.2);
        c.position.x += c.vx * dt;
        c.position.z += c.vz * dt;
        c.position.y = c.height;
        c.vx *= Math.exp(-3 * dt);
        c.vz *= Math.exp(-3 * dt);
        if (c.dieT >= 1) {
          c.active = false;
          c.swarm = null;
        }
        continue;
      }
      const sw = c.swarm;
      c.position.y = (sw ? sw.position.y : 0) + c.height;
      const r = rv.revealAt(c.position.x, c.position.z);
      c.inked = c.inked ? r > ai.revealOff : r > ai.revealOn;
      if (c.inked) c.revealVis = Math.min(1, c.revealVis + dt * ai.revealFadeIn);
      else c.revealVis = Math.max(0, c.revealVis - dt * ai.revealFadeOut);
    }
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
    let rv: number;
    if (e.kind === 'cranes') {
      // the swarm is "seen" when any crane is
      rv = 0;
      for (const c of e.flock) if (c.alive && c.inked) rv = 1;
    } else rv = this.deps.reveal.revealAt(e.position.x, e.position.z);
    const was = e.inked;
    let now = was ? rv > ai.revealOff : rv > ai.revealOn;
    if (e.elite === 'inkedIn') {
      // Inked In: the ink holds on it for a beat after it slips out of the light
      if (now) e.inkHoldT = this.tuning.enemies.elites.inkedInHold;
      else if (e.inkHoldT > 0) {
        e.inkHoldT = Math.max(0, e.inkHoldT - dt);
        now = true;
      }
    }
    e.inked = now;
    if (e.inked) e.revealVis = Math.min(1, e.revealVis + dt * ai.revealFadeIn);
    else e.revealVis = Math.max(0, e.revealVis - dt * ai.revealFadeOut);
    if (e.inked && !was) {
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

  requestAttack(e: Enemy): boolean {
    if (e.age < this.tuning.enemies.ai.firstAttackDelay) return false;
    if (this.attackers >= this.maxAttackers) return false;
    this.attackers++;
    return true;
  }

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

  damagePlayer(e: Enemy, amount: number, shake: number): void {
    const p = this.deps.player;
    if (!p || p.invulnerable || !e.alive) return;
    p.damage(amount, e.kind);
    if (shake > 0) this.deps.events.emit('fx:shake', { intensity: shake, duration: 0.2 });
  }

  walkable(x: number, z: number): boolean {
    const col = this.deps.collision;
    return col ? col.walkable(x, z) : true;
  }

  sfx(id: SfxId, x: number, y: number, z: number, volume = 1): void {
    this.deps.events.emit('sfx:play', { id, position: [x, y, z], volume });
  }

  panelCut(word: string, x: number, y: number, z: number, reason: string): void {
    this.deps.events.emit('fx:panelCut', { word, focus: [x, y, z], reason });
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
    const brain = BRAINS[e.kind];
    brain.interrupt?.(e, this);
    if (brain.recoils === false) return;
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

  onEnemyStun(e: Enemy, seconds: number): void {
    if (!e.alive) return;
    const brain = BRAINS[e.kind];
    if (e.state === AiState.Attack) brain.interrupt?.(e, this);
    e.stunT = Math.max(e.stunT, seconds);
    e.ballistic = false;
    e.windup = e.lunge = e.drain = 0;
    e.attacking = false;
    if (e.state === AiState.Attack) e.setState(AiState.Stalk, 0);
  }

  onCraneHit(c: CraneTarget, _amount: number, from: THREE.Vector3): void {
    const e = c.swarm;
    if (!c.alive || !e?.alive) return;
    c.alive = false;
    c.dieT = 0;
    c.hitT = 1;
    let dx = c.position.x - from.x;
    let dz = c.position.z - from.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= d;
    dz /= d;
    c.vx = dx * 3;
    c.vz = dz * 3;
    this.deps.targets.remove(c);
    this.fx?.craneDeath?.(c);
    this.sfx('ghost_die', c.position.x, c.position.y, c.position.z, 0.55);
    e.hp--;
    e.hitT = 1;
    if (e.hp <= 0) this.die(e, from.x, from.z);
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
    e.attacking = false;
    e.boxHalf = 0;
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
    if (e.elite === 'firstEdition') {
      // a first edition is worth a full well
      ev.emit('ink:drop', {
        position: [pos[0], pos[1], pos[2]],
        amount: this.tuning.energy.max,
        kind: e.kind,
        bonus: true,
      });
    } else if (e.elite === 'bleedThrough') this.bleedThrough(e);
    ev.emit('sfx:play', { id: 'ghost_die', position: [pos[0], pos[1] + 1, pos[2]] });
    ev.emit('fx:shake', { intensity: 0.28, duration: 0.16 });
    ev.emit('fx:hitstop', { duration: 0.06 });
    this.fx?.death(e);
  }

  /** Bleed-Through: the ink soaks into the nearest other ghost (+HP, faster). */
  private bleedThrough(src: Enemy): void {
    const el = this.tuning.enemies.elites;
    let best: Enemy | null = null;
    let bestD = Infinity;
    for (const o of this.pool) {
      if (!o.alive || o === src) continue;
      const d = (o.position.x - src.position.x) ** 2 + (o.position.z - src.position.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (!best) return;
    if (best.kind !== 'cranes') {
      best.hp += el.bleedHp;
      best.maxHp += el.bleedHp;
    }
    best.speedBuff = el.bleedSpeed;
    best.hitT = 1;
    this.deps.events.emit('sfx:play', {
      id: 'blot_drain',
      position: [best.position.x, best.position.y + 0.6, best.position.z],
    });
  }

  private groundY(x: number, z: number): number {
    const col = this.deps.collision;
    return col ? col.groundHeight(x, z) : 0;
  }
}
