/**
 * "The Inker's Deadline" — encounter director layered on top of the authored Spawner.
 *
 * It never replaces authored waves. During explicit arena / ambush *moments* (trigger ids in
 * `tuning.enemies.director.moments`) it reads an intensity 0..1 (recent damage taken, low ink,
 * enemies on screen) and runs a Build → Peak → Relax cycle:
 *   build  — accrues budget and spends it on role-tagged pieces (fodder, zoner, flanker, support,
 *            priority; at most one priority piece alive), never past maxActive − reserve;
 *   peak   — holds: no new pieces;
 *   relax  — no pieces, requests bonus ink near the player (`ink:drop`, bonus), then builds again.
 * Every phase change emits `director:phase`. The cycle scale is the difficulty's `deadline`
 * (story lower, 0 disables). All randomness comes from src/world/rng.ts seeded by the level.
 *
 * Pure logic: everything it needs from the game is behind `DirectorWorld`, so tests drive it
 * with a fake.
 */
import type { EventBus, GameEvents } from '../../core/events';
import type { EnemyKind } from '../../core/types';
import type { Tuning } from '../../data/tuning';
import { makeRng, type Rng } from '../../world/rng';

export type DirectorRole = 'fodder' | 'zoner' | 'flanker' | 'support' | 'priority';
export type DirectorPhase = 'off' | 'build' | 'peak' | 'relax';

export const ROLE_OF: Record<EnemyKind, DirectorRole> = {
  smudge: 'fodder',
  scribbler: 'zoner',
  marginMan: 'flanker',
  cranes: 'flanker',
  blot: 'support',
  misprint: 'support',
  redactor: 'priority',
  panelWarden: 'priority',
};

const ROLES: readonly DirectorRole[] = ['fodder', 'zoner', 'flanker', 'support', 'priority'];

/** What the director reads / does. `directorWorld(system)` adapts an EnemySystem. */
export interface DirectorWorld {
  readonly hasPlayer: boolean;
  readonly playerX: number;
  readonly playerZ: number;
  /** Player ink 0..1. */
  readonly ink01: number;
  /** Alive enemies (all sources). */
  readonly activeCount: number;
  readonly maxActive: number;
  /** Alive enemies within `range` of the player ("on screen"). */
  nearbyCount(range: number): number;
  isAlive(id: number): boolean;
  /** Spawn site check: walkable and in the dark. */
  canSpawnAt(x: number, z: number): boolean;
  spawn(kind: EnemyKind, x: number, z: number): { id: number } | null;
}

export interface DirectorOptions {
  /** Difficulty `deadline` scale (default 1). 0 disables the director. */
  scale?: () => number;
}

/** Recent-damage accumulator with exponential decay (half-life `halfLife` s). */
export function decay(value: number, dt: number, halfLife: number): number {
  return halfLife > 0 ? value * 0.5 ** (dt / halfLife) : 0;
}

/** Raw intensity 0..1 from the three pressure inputs. */
export function intensityOf(
  damage: number,
  ink01: number,
  nearby: number,
  d: Tuning['enemies']['director'],
): number {
  const dmg = Math.min(1, damage / Math.max(1e-3, d.damageNorm));
  const ink = Math.min(1, Math.max(0, (d.lowInk - ink01) / Math.max(1e-3, d.lowInk)));
  const en = Math.min(1, nearby / Math.max(1, d.enemiesNorm));
  return Math.min(1, Math.max(0, d.wDamage * dmg + d.wInk * ink + d.wEnemies * en));
}

export class Director {
  phase: DirectorPhase = 'off';
  /** Smoothed intensity 0..1. */
  intensity = 0;
  budget = 0;
  /** Seconds in the current phase. */
  phaseT = 0;
  /** Moment trigger currently running ('' = none) and seconds left. */
  moment = '';
  momentLeft = 0;
  /** Pieces spawned in this moment. */
  spawned = 0;
  /** Live director pieces (id → role). */
  readonly pieces = new Map<number, DirectorRole>();

  private rng: Rng = makeRng(0xdead1);
  private kinds = new Set<EnemyKind>(['smudge']);
  private damage = 0;
  private spawnCd = 0;
  private relaxDropsLeft = 0;
  private offs: (() => void)[] = [];
  private scale: () => number;

  constructor(
    private events: EventBus<GameEvents>,
    private tuning: Tuning,
    private world: DirectorWorld,
    opts: DirectorOptions = {},
  ) {
    this.scale = opts.scale ?? (() => 1);
    this.offs.push(
      events.on('player:damaged', (e) => {
        this.damage += e.amount;
      }),
      events.on('trigger:fired', (e) => this.onTrigger(e.id)),
      events.on('enemy:died', (e) => {
        this.pieces.delete(e.id);
      }),
    );
  }

  /** New page: roster = kinds the page itself introduces (+ smudge fodder). */
  load(level: { seed?: number; spawns: readonly { kind: EnemyKind }[] } | null): void {
    this.reset();
    this.kinds.clear();
    this.kinds.add('smudge');
    if (!level) return;
    for (const s of level.spawns) this.kinds.add(s.kind);
    this.rng = makeRng(((level.seed ?? 1) * 2654435761) ^ 0xd1ec7);
  }

  reset(): void {
    this.setPhase('off');
    this.moment = '';
    this.momentLeft = 0;
    this.budget = 0;
    this.spawned = 0;
    this.damage = 0;
    this.intensity = 0;
    this.pieces.clear();
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
  }

  /** Start a moment by hand (debug / scripted ambush). */
  begin(id: string, seconds: number): void {
    if (this.scale() <= 0) return;
    this.moment = id;
    this.momentLeft = seconds;
    this.spawned = 0;
    this.budget = Math.max(this.budget, this.tuning.enemies.director.cost.fodder);
    this.setPhase('build');
  }

  private onTrigger(id: string): void {
    const d = this.tuning.enemies.director;
    const dur = d.moments[id];
    if (dur !== undefined) {
      this.begin(id, dur);
      return;
    }
    // the authored fight it was layered on is over → wind down
    if (this.moment && id === `${this.moment}_cleared`) this.momentLeft = Math.min(this.momentLeft, 0);
  }

  get roster(): ReadonlySet<EnemyKind> {
    return this.kinds;
  }

  get priorityAlive(): number {
    let n = 0;
    for (const [id, r] of this.pieces) if (r === 'priority' && this.world.isAlive(id)) n++;
    return n;
  }

  step(dt: number): void {
    const d = this.tuning.enemies.director;
    const w = this.world;
    this.damage = decay(this.damage, dt, d.damageHalfLife);
    const raw = intensityOf(this.damage, w.ink01, w.nearbyCount(d.nearRange), d);
    this.intensity += (raw - this.intensity) * Math.min(1, dt * d.smooth);
    for (const id of this.pieces.keys()) if (!w.isAlive(id)) this.pieces.delete(id);
    if (this.phase === 'off') return;
    this.phaseT += dt;
    this.momentLeft -= dt;
    const scale = Math.max(0, this.scale());

    if (this.phase === 'build') {
      this.budget = Math.min(d.budgetMax * Math.max(0.5, scale), this.budget + d.budgetPerSec * scale * dt);
      this.spawnCd -= dt;
      if (this.momentLeft <= 0 || scale <= 0) {
        this.setPhase('relax');
        return;
      }
      if (this.spawnCd <= 0) this.trySpend(scale);
      if (this.intensity >= d.peakAt || this.phaseT >= d.buildMaxS) this.setPhase('peak');
      return;
    }
    if (this.phase === 'peak') {
      if (this.phaseT >= d.peakS || this.momentLeft <= 0) this.setPhase('relax');
      return;
    }
    // relax
    if (this.relaxDropsLeft > 0 && w.hasPlayer) {
      this.relaxDropsLeft--;
      const a = this.rng() * Math.PI * 2;
      const r = 1.5 + this.rng() * 1.5;
      this.events.emit('ink:drop', {
        position: [w.playerX + Math.cos(a) * r, 0, w.playerZ + Math.sin(a) * r],
        amount: d.relaxDropAmount,
        kind: 'smudge',
        bonus: true,
      });
    }
    if (this.phaseT >= d.relaxS && (this.intensity <= d.relaxBelow || this.phaseT >= d.relaxS * 2)) {
      if (this.momentLeft > 0) this.setPhase('build');
      else {
        this.moment = '';
        this.setPhase('off');
      }
    }
  }

  /** Spend budget on one piece if anything fits. Returns the kind spawned (tests). */
  trySpend(scale = 1): EnemyKind | null {
    const d = this.tuning.enemies.director;
    const w = this.world;
    this.spawnCd = d.spawnEvery;
    if (this.spawned >= Math.round(d.maxSpawns * scale)) return null;
    if (w.activeCount >= w.maxActive - d.reserve) return null;
    // weighted role pick among affordable roles that have a kind on this page
    let total = 0;
    const prio = this.priorityAlive;
    for (const r of ROLES) if (this.roleOk(r, prio)) total += d.weight[r];
    if (total <= 0) return null;
    let pick = this.rng() * total;
    let role: DirectorRole | null = null;
    for (const r of ROLES) {
      if (!this.roleOk(r, prio)) continue;
      pick -= d.weight[r];
      if (pick <= 0) {
        role = r;
        break;
      }
    }
    if (!role) return null;
    const kind = this.kindFor(role);
    if (!kind) return null;
    const at = this.site();
    if (!at) return null;
    const e = w.spawn(kind, at[0], at[1]);
    if (!e) return null;
    this.budget -= d.cost[role];
    this.spawned++;
    this.pieces.set(e.id, role);
    return kind;
  }

  private roleOk(r: DirectorRole, prioAlive: number): boolean {
    const d = this.tuning.enemies.director;
    if (d.cost[r] > this.budget + 1e-9) return false;
    if (r === 'priority' && prioAlive >= 1) return false;
    for (const k of this.kinds) if (ROLE_OF[k] === r) return true;
    return false;
  }

  private kindFor(role: DirectorRole): EnemyKind | null {
    let n = 0;
    for (const k of this.kinds) if (ROLE_OF[k] === role) n++;
    if (n === 0) return null;
    let i = Math.floor(this.rng() * n);
    for (const k of this.kinds) if (ROLE_OF[k] === role && i-- === 0) return k;
    return null;
  }

  private readonly siteOut: [number, number] = [0, 0];
  /** A ring site around the player, walkable and dark. */
  private site(): [number, number] | null {
    const d = this.tuning.enemies.director;
    const w = this.world;
    if (!w.hasPlayer) return null;
    const a0 = this.rng() * Math.PI * 2;
    for (let k = 0; k < 8; k++) {
      const a = a0 + k * 0.785;
      const r = d.spawnMin + this.rng() * (d.spawnMax - d.spawnMin);
      const x = w.playerX + Math.cos(a) * r;
      const z = w.playerZ + Math.sin(a) * r;
      if (w.canSpawnAt(x, z)) {
        this.siteOut[0] = x;
        this.siteOut[1] = z;
        return this.siteOut;
      }
    }
    return null;
  }

  private setPhase(p: DirectorPhase): void {
    if (p === this.phase) return;
    this.phase = p;
    this.phaseT = 0;
    if (p === 'relax') this.relaxDropsLeft = this.tuning.enemies.director.relaxDrops;
    if (p === 'build') this.spawnCd = 0;
    if (p !== 'off') this.events.emit('director:phase', { phase: p, intensity: this.intensity });
  }
}

/** Adapter: an EnemySystem-like source → DirectorWorld. */
export function directorWorld(sys: {
  readonly activeCount: number;
  readonly tuning: Tuning;
  readonly pool: readonly { id: number; alive: boolean; position: { x: number; z: number } }[];
  readonly deps: {
    player: { position: { x: number; z: number }; energy: number } | null;
    reveal: { isRevealed(x: number, z: number): boolean };
    collision?: {
      walkable(x: number, z: number): boolean;
      segmentClear(ax: number, az: number, bx: number, bz: number): boolean;
    } | null;
  };
  spawn(kind: EnemyKind, x: number, z: number, opts?: { elite?: 'roll' }): { id: number } | null;
}): DirectorWorld {
  return {
    get hasPlayer() {
      return !!sys.deps.player;
    },
    get playerX() {
      return sys.deps.player?.position.x ?? 0;
    },
    get playerZ() {
      return sys.deps.player?.position.z ?? 0;
    },
    get ink01() {
      const p = sys.deps.player;
      return p ? p.energy / sys.tuning.energy.max : 1;
    },
    get activeCount() {
      return sys.activeCount;
    },
    get maxActive() {
      return sys.tuning.enemies.maxActive;
    },
    nearbyCount(range) {
      const p = sys.deps.player;
      if (!p) return 0;
      let n = 0;
      for (const e of sys.pool) {
        if (!e.alive) continue;
        const dx = e.position.x - p.position.x;
        const dz = e.position.z - p.position.z;
        if (dx * dx + dz * dz <= range * range) n++;
      }
      return n;
    },
    isAlive(id) {
      for (const e of sys.pool) if (e.id === id) return e.alive;
      return false;
    },
    canSpawnAt(x, z) {
      const col = sys.deps.collision;
      if (col && !col.walkable(x, z)) return false;
      // never behind a closed gate / wall: what spawns must be fightable from here
      const p = sys.deps.player;
      if (col && p && !col.segmentClear(p.position.x, p.position.z, x, z)) return false;
      return !sys.deps.reveal.isRevealed(x, z);
    },
    spawn(kind, x, z) {
      return sys.spawn(kind, x, z, { elite: 'roll' });
    },
  };
}
