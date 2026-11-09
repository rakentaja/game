/**
 * ?autoplay=1 bot (PLAN §12). Drives the real InputAPI state right after each poll, so every
 * downstream system sees exactly what a thumb would produce. It is allowed to "know" things a
 * player would infer (positions of unrevealed ghosts, the boss FSM's attack lanes), but it can
 * only act through move / crystal / tap / swipe.
 *
 * Priorities each step:
 *   1. boss danger (telegraphed / striking eraser lanes and slam circles) → step or dash out
 *   2. contact → dash away
 *   3. combat → keep a distance band, strafe, reveal with the crystal, tap at revealed targets
 *   4. ink → detour to an ink well when low
 *   5. sketches → stand near, hold the crystal until printed (retries if it wasn't printable yet)
 *   6. boss → hold a ring around the Editor, print P2 weak points, light the P3 core in bows
 *   7. path → walk the centreline (only advances when the area is clear)
 */
import * as THREE from 'three';
import type { EventBus, GameEvents } from '../core/events';
import type {
  CollisionAPI,
  Damageable,
  GameContext,
  InputAPI,
  InputState,
  PlayerAPI,
  TargetRegistry,
  Vec2T,
  Vec3T,
} from '../core/types';
import type { Tuning } from '../data/tuning';

/** The slice of the Editor FSM the bot reads (structural, so there's no import cycle). */
export interface BossView {
  state: string;
  phase: number;
  bowT: number;
  p2Active: number;
  readonly attacks: readonly {
    active: boolean;
    stage: string;
    kind: string;
    ax: number;
    az: number;
    bx: number;
    bz: number;
    hw: number;
    t: number;
    telegraph: number;
  }[];
  readonly wps: readonly {
    index: number;
    print: number;
    phase: number;
    alive: boolean;
    exposed: boolean;
    printed: boolean;
    drawIn: number;
    x: number;
    y: number;
    z: number;
  }[];
}

export interface AutoplayLevel {
  path: Vec2T[];
  sketches?: { id: string; at: Vec3T }[];
  /** [x, z, energy] — the bot detours here when low on ink. */
  inkWells?: Vec3T[];
  /** False while a sketch is dormant (e.g. boss door before the arena is cleared): don't burn ink on it. */
  canPrint?: (id: string) => boolean;
}

export interface AutoplayDeps {
  input: InputAPI;
  events: EventBus<GameEvents>;
  tuning: Tuning;
  targets: TargetRegistry;
  getPlayer: () => (PlayerAPI & { dashCooldown01?: number }) | null;
  view: { forward: THREE.Vector3; right: THREE.Vector3 };
  collision?: CollisionAPI;
  /** Live boss state on the boss page. */
  boss?: () => BossView | null;
  /** Scribbler pencil strokes in flight (EnemySystem.projectiles). */
  projectiles?: ProjectileView;
  /** Co-op partner: when it's downed, walk over and hold the crystal on it (reprint). */
  partner?: () => PlayerAPI | null;
}

export interface ProjectileView {
  readonly capacity: number;
  readonly x: ArrayLike<number>;
  readonly z: ArrayLike<number>;
  readonly dx: ArrayLike<number>;
  readonly dz: ArrayLike<number>;
  readonly active: ArrayLike<number>;
}

type Mode = 'walk' | 'fight' | 'print' | 'ink' | 'dodge' | 'boss' | 'unstick' | 'idle';

/** The slice of a hero kit the bot reads (structural; kits are lazy chunks). */
interface KitView {
  id: string;
  isPinned?(id: number): boolean;
}

const _dir = new THREE.Vector3();
const WELL_RADIUS = 1.3;

function distSqToSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}

export class AutoplayBot {
  /** Path finished. */
  done = false;
  /** Current mode, for the debug overlay / e2e logs. */
  mode: Mode = 'idle';
  loop = false;

  private pts: Float32Array;
  private n: number;
  private progress = 0;
  private placed = false;
  private time = 0;
  private fireT = 0;
  private holdT = 0;
  private strafeT = 0;
  private strafeSign = 1;
  private printing: string | null = null;
  private printT = 0;
  private printed = new Set<string>();
  private retryAt = new Map<string, number>();
  private wellUsed: number[];
  private wellBad: number[];
  private stuckT = 0;
  private stuckX = 0;
  private stuckZ = 0;
  private unstickT = 0;
  private unstickSide = 1;
  private bossAngle = 0;
  private holdOut = false;
  private drops = new Float64Array(12).fill(-1e9);
  private dropIdx = 0;
  private offs: (() => void)[] = [];
  private unpatch: (() => void) | null = null;

  // per-step threat scan (filled by `scan`, allocation-free)
  private px = 0;
  private pz = 0;
  private nearD = Infinity;
  private nearX = 0;
  private nearZ = 0;
  private blotD = Infinity;
  private threats = 0;
  private repX = 0;
  private repZ = 0;
  private readonly scan = (t: Damageable) => {
    if (!t.alive || !('kind' in t)) return;
    const dx = t.position.x - this.px;
    const dz = t.position.z - this.pz;
    const d = Math.hypot(dx, dz);
    if (d < this.huntD) {
      this.huntD = d;
      this.huntX = t.position.x;
      this.huntZ = t.position.z;
    }
    if (d > 14) return;
    // ghosts behind a wall / the gate can't be fought from here: ignore unless on top of us
    const C = this.deps.collision;
    if (d > 4 && C && !C.segmentClear(this.px, this.pz, t.position.x, t.position.z)) return;
    this.threats++;
    if (d < this.nearD) {
      this.nearD = d;
      this.nearX = t.position.x;
      this.nearZ = t.position.z;
    }
    const e = t as Damageable & { kind?: string; windup?: number; aimX?: number; aimZ?: number };
    if (e.kind === 'blot' && d < this.blotD) this.blotD = d;
    // a scribbler winding up: its aim is locked, so stepping off the line always works
    if (e.kind === 'scribbler' && (e.windup ?? 0) > 0.05 && e.aimX !== undefined && e.aimZ !== undefined)
      this.avoidRay(t.position.x, t.position.z, e.aimX - t.position.x, e.aimZ - t.position.z, 1.3);
    if (d < 5 && d > 1e-3) {
      const w = 1 / (d * d);
      this.repX -= (dx / d) * w;
      this.repZ -= (dz / d) * w;
    }
  };

  private dodgeX = 0;
  private dodgeZ = 0;
  // nearest live ghost at any range / through walls (hunting stragglers that block a print)
  private huntD = Infinity;
  private huntX = 0;
  private huntZ = 0;
  private huntUntil = -1;
  private lastProgress = new Map<string, { t: number; at: number }>();
  // hero kits (?hero=): nearest live ghost at any reveal state
  private kit: KitView | null = null;
  private gD = Infinity;
  private gX = 0;
  private gZ = 0;
  private gPinned = false;
  private flatT = -1e9;
  private orbiting = false;
  private readonly ghostScan = (t: Damageable) => {
    if (!t.alive || !('kind' in t)) return;
    const d = Math.hypot(t.position.x - this.px, t.position.z - this.pz);
    if (d >= this.gD) return;
    const C = this.deps.collision;
    if (d > 4 && C && !C.segmentClear(this.px, this.pz, t.position.x, t.position.z)) return;
    this.gD = d;
    this.gX = t.position.x;
    this.gZ = t.position.z;
    this.gPinned = !!this.kit?.isPinned?.(t.id);
  };

  /** Add a sidestep away from the ray (ox,oz)+t·(dx,dz) if the player is close to it, ahead. */
  private avoidRay(ox: number, oz: number, dx: number, dz: number, width: number): void {
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) return;
    const ux = dx / l;
    const uz = dz / l;
    const rx = this.px - ox;
    const rz = this.pz - oz;
    const along = rx * ux + rz * uz;
    if (along < -0.5 || along > 12) return;
    const side = rx * -uz + rz * ux;
    if (Math.abs(side) > width) return;
    const sgn = side >= 0 ? 1 : -1;
    this.dodgeX += -uz * sgn;
    this.dodgeZ += ux * sgn;
  }

  constructor(
    private deps: AutoplayDeps,
    private level: AutoplayLevel,
  ) {
    // Resample the centreline every ~0.5 m.
    const src = level.path.map(([x, z]) => new THREE.Vector3(x, 0, z));
    if (src.length < 2) src.push(src[0]?.clone() ?? new THREE.Vector3());
    const curve = new THREE.CatmullRomCurve3(src, false, 'centripetal');
    this.n = Math.max(2, Math.ceil(curve.getLength() / 0.5));
    this.pts = new Float32Array(this.n * 2);
    const v = new THREE.Vector3();
    for (let i = 0; i < this.n; i++) {
      curve.getPointAt(i / (this.n - 1), v);
      this.pts[i * 2] = v.x;
      this.pts[i * 2 + 1] = v.z;
    }
    this.wellUsed = (level.inkWells ?? []).map(() => -1e9);
    this.wellBad = (level.inkWells ?? []).map(() => -1e9);
    this.offs.push(
      deps.events.on('sketch:printed', ({ id }) => {
        this.printed.add(id);
        if (this.printing === id) this.printing = null;
      }),
      deps.events.on('sketch:progress', ({ id, t }) => {
        const lp = this.lastProgress.get(id);
        if (!lp) this.lastProgress.set(id, { t, at: this.time });
        else if (t > lp.t + 1e-4) {
          lp.t = t;
          lp.at = this.time;
        }
      }),
      deps.events.on('enemy:died', ({ position }) => {
        const k = this.dropIdx++ % 4;
        this.drops[k * 3] = position[0];
        this.drops[k * 3 + 1] = position[2];
        this.drops[k * 3 + 2] = this.time;
      }),
      deps.events.on('player:respawn', () => {
        this.stuckT = 0;
        this.printing = null;
        this.placed = false;
        this.done = false;
      }),
    );
  }

  /** Hook into input.poll so the bot drives state every sim step. Don't also call drive(). */
  attach(): this {
    const input = this.deps.input;
    const orig = input.poll.bind(input);
    input.poll = () => {
      orig();
      this.drive(input.state, 1 / this.deps.tuning.sim.hz);
    };
    this.unpatch = () => {
      input.poll = orig;
    };
    return this;
  }

  dispose(): void {
    this.unpatch?.();
    this.unpatch = null;
    for (const o of this.offs) o();
    this.offs.length = 0;
  }

  drive(s: InputState, dt: number): void {
    this.time += dt;
    const p = this.deps.getPlayer();
    s.boltPressed = false;
    s.dashPressed = false;
    s.crystalHeld = false;
    s.move.set(0, 0);
    s.device = 'touch';
    if (!p || p.pages <= 0) {
      this.mode = 'idle';
      return;
    }
    const T = this.deps.tuning;
    const px = p.position.x;
    const pz = p.position.z;
    const dashReady = (p.dashCooldown01 ?? 1) <= 0;
    this.px = px;
    this.pz = pz;
    // start from wherever this wizard stands (a co-op partner spawns beside the path start)
    if (!this.placed) {
      this.placed = true;
      this.progress = this.nearestIndex();
    }
    this.nearD = Infinity;
    this.blotD = Infinity;
    this.threats = 0;
    this.repX = this.repZ = 0;
    this.dodgeX = this.dodgeZ = 0;
    this.huntD = Infinity;
    this.deps.targets.forEach(this.scan);
    const pr = this.deps.projectiles;
    if (pr) {
      for (let i = 0; i < pr.capacity; i++) {
        if (!pr.active[i]) continue;
        this.avoidRay(pr.x[i]!, pr.z[i]!, pr.dx[i]!, pr.dz[i]!, 1.1);
      }
    }
    const boss = this.deps.boss?.() ?? null;
    const bossLive =
      !!boss && (boss.state === 'intro' || boss.state === 'phase' || boss.state === 'transition');

    this.advancePath(px, pz);
    let mode: Mode = this.done ? 'idle' : 'walk';
    let speed = this.done ? 0 : 1;
    let hold = false;
    // default goal: look-ahead point on the path
    const look = Math.min(this.n - 1, this.progress + 4);
    _dir.set(this.pts[look * 2]! - px, 0, this.pts[look * 2 + 1]! - pz);

    // ── shooting: any revealed target in range (combat picks it; Blots are preferred there)
    const tgt = this.deps.targets.nearest(p.position, T.bolt.maxRange * 0.95);
    this.fireT -= dt;
    this.kit = (p as PlayerAPI & { kit?: KitView }).kit ?? null;
    this.orbiting = false;
    const hero = this.kit?.id ?? 'inker';
    if (hero !== 'inker') this.fireT = Math.max(this.fireT, -1); // own cadence below
    // ink discipline: weak points always; minions only when flush or close (prints need ~31 ink)
    const isMinion = !!tgt && 'kind' in tgt;
    const tgtD = tgt ? Math.hypot(tgt.position.x - px, tgt.position.z - pz) : 99;
    const C = this.deps.collision;
    const blocked = !!tgt && isMinion && !!C && !C.segmentClear(px, pz, tgt.position.x, tgt.position.z);
    const thrifty = bossLive && isMinion && p.energy < 45 && tgtD > 4.5;
    if (hero === 'inker' && tgt && !thrifty && !blocked && this.fireT <= 0 && p.energy >= T.bolt.cost) {
      s.boltPressed = true;
      this.fireT = T.bolt.cooldown + 0.05;
    }

    // ── ink wells when low and nothing is on top of us
    const lowInk = p.energy < (bossLive ? 30 : 22);
    const well = lowInk && this.nearD > 4 ? this.nearestWell(px, pz, bossLive ? 16 : 30) : -1;
    // nearly dry mid-fight: a well (kiting toward it) beats standing there unable to shoot
    const dryWell = p.energy < T.bolt.cost * 2 ? this.nearestWell(px, pz, 30) : -1;
    const drop = this.nearD > 3 && p.energy < T.energy.max - 8 ? this.recentDrop(px, pz) : -1;

    const keepPrinting =
      !bossLive && this.printing && this.nearD > 4.5 ? this.sketchGoal(px, pz, p.energy) : null;
    if (boss && boss.state === 'dormant' && this.done) {
      // walk on into the fight circle — the Editor wakes on the arena trigger
      const [cx, cz] = this.deps.tuning.boss.arena;
      mode = 'walk';
      speed = 1;
      _dir.set(cx - px, 0, cz + 4 - pz);
    } else if (bossLive) {
      mode = 'boss';
      this.holdOut = false;
      speed = this.bossGoal(boss!, p, px, pz);
      hold = this.holdOut;
    } else if (keepPrinting !== null) {
      // a print in progress wins over fighting at range: ambushes spawn *because* we're printing,
      // often behind the very wall the print opens. Bolts and sidesteps keep running meanwhile.
      mode = 'print';
      hold = keepPrinting;
      speed = _dir.lengthSq() > 0.01 ? 1 : 0;
    } else if (drop >= 0) {
      // walk through the ink a ghost just dropped (magnet does the rest)
      mode = 'ink';
      _dir.set(this.drops[drop * 3]! - px, 0, this.drops[drop * 3 + 1]! - pz);
    } else if (dryWell >= 0 && this.threats > 0) {
      mode = 'ink';
      const w = this.level.inkWells![dryWell]!;
      _dir.set(w[0] - px + this.repX * 6, 0, w[1] - pz + this.repZ * 6);
    } else if (this.threats > 0 && this.nearD < 12) {
      // ── combat: hold a band around the nearest ghost, strafe, reveal it with the crystal
      mode = 'fight';
      const dx = this.nearX - px;
      const dz = this.nearZ - pz;
      const d = this.nearD;
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = 1.2 + (this.time % 0.7);
        this.strafeSign = -this.strafeSign;
      }
      const ux = dx / (d || 1);
      const uz = dz / (d || 1);
      const want = this.blotD < 6 ? 3.2 : 4.6;
      const radial = d < want - 0.8 ? -1 : d > want + 2.5 ? 0.7 : 0;
      _dir.set(ux * radial - uz * this.strafeSign * 0.6, 0, uz * radial + ux * this.strafeSign * 0.6);
      _dir.x += this.repX * 6;
      _dir.z += this.repZ * 6;
      speed = d < 2.5 ? 1 : 0.75;
      // reveal: the ghost isn't targetable yet, or a blot is choking the light
      if (hero !== 'inker') hold = this.heroFight(s, hero, p, px, pz, tgt);
      else if ((!tgt && d < 8.5 && p.energy > 35) || (!tgt && this.blotD < 4 && p.energy > 15)) hold = true;
    } else if (this.huntUntil > this.time && this.huntD < 80) {
      // a print is blocked on a straggler somewhere: go and find it
      mode = 'fight';
      _dir.set(this.huntX - px, 0, this.huntZ - pz);
      if (!tgt && this.huntD < 8 && p.energy > 30) hold = true;
    } else if (well >= 0) {
      mode = 'ink';
      const w = this.level.inkWells![well]!;
      _dir.set(w[0] - px, 0, w[1] - pz);
    } else {
      const printing = this.sketchGoal(px, pz, p.energy);
      if (printing !== null) {
        hold = printing;
        mode = 'print';
      }
      if (mode !== 'print' && this.threats === 0) {
        // periodically flare the crystal on the trail to flush out lurkers
        this.holdT += dt;
        if (p.energy > 60 && this.holdT % 8 < 1) hold = true;
      }
      if (mode === 'print') speed = _dir.lengthSq() > 0.01 ? 1 : 0;
    }

    // ── co-op: a downed partner gets reprinted (hold the crystal on it)
    const mate = this.deps.partner?.() ?? null;
    // co-op: never lag far behind the partner on a side errand (the page edge leashes them,
    // so a bot stuck on a detour would hold both wizards up)
    if (mate && !mate.downed && !bossLive && !this.done) {
      const dx = mate.position.x - px;
      const dz = mate.position.z - pz;
      if (dx * dx + dz * dz > 18 * 18 && mode !== 'print') {
        mode = 'walk';
        _dir.set(dx, 0, dz);
        speed = 1;
      }
    }
    if (mate?.downed && !bossLive) {
      const dx = mate.position.x - px;
      const dz = mate.position.z - pz;
      const d = Math.hypot(dx, dz);
      if (d < 40) {
        mode = 'walk';
        _dir.set(dx, 0, dz);
        speed = d > 1.2 ? 1 : 0;
        hold = d < 3 && p.energy > 1;
      }
    }

    // ── contact: dash out
    if (this.nearD < 1.7 && dashReady && !this.orbiting) {
      this.dashAway(s, px, pz, this.nearX, this.nearZ);
    }

    // ── pencil strokes / scribbler aim lines: sidestep (keeps the crystal held)
    if (this.dodgeX || this.dodgeZ) {
      _dir.set(this.dodgeX * 3 + _dir.x * 0.2, 0, this.dodgeZ * 3 + _dir.z * 0.2);
      speed = 1;
      if (mode !== 'print') mode = 'dodge';
    }

    // ── boss danger overrides everything that moves us
    if (boss && boss.state !== 'dormant') {
      const esc = this.dangerEscape(boss, px, pz, s, dashReady);
      if (esc) {
        mode = 'dodge';
        speed = 1;
      }
    }

    // ── stay on walkable ground: if the step ahead isn't walkable, bend toward the path
    if (!bossLive) this.keepWalkable(px, pz);

    // ── stuck detection
    this.stuckT += dt;
    if (this.stuckT > 1.5) {
      const moved = Math.hypot(px - this.stuckX, pz - this.stuckZ);
      if (moved < 0.4 && speed > 0.3 && mode !== 'boss') {
        // pushing against something next to a well → it's out of reach; skip it for a cycle
        const wells = this.level.inkWells;
        if (wells)
          for (let i = 0; i < wells.length; i++)
            if (Math.hypot(wells[i]![0] - px, wells[i]![1] - pz) < 6) {
              this.wellUsed[i] = this.time;
              this.wellBad[i] = this.time;
            }
        this.unstickT = 0.7;
        this.unstickSide = -this.unstickSide;
        if (dashReady) {
          this.toScreen(_dir.x, _dir.z, s.dashDir);
          s.dashPressed = true;
        }
      }
      this.stuckT = 0;
      this.stuckX = px;
      this.stuckZ = pz;
    }
    if (this.unstickT > 0 && mode !== 'dodge') {
      this.unstickT -= dt;
      _dir.set(-_dir.z * this.unstickSide + _dir.x * 0.3, 0, _dir.x * this.unstickSide + _dir.z * 0.3);
      mode = 'unstick';
      speed = 1;
    }

    s.crystalHeld = hold && p.energy > 0.5;
    this.mode = mode;
    if (speed > 0 && _dir.lengthSq() > 1e-6) {
      _dir.normalize();
      this.toScreen(_dir.x, _dir.z, s.move);
      s.move.multiplyScalar(Math.min(1, speed));
    }
  }

  /**
   * Non-Inker heroes in a fight (only reached in 'fight' mode). Writes taps into `s`, may bend
   * `_dir`, returns whether to hold the channel verb.
   *  - Penciller: ruler-pin the nearest ghost, then trace a tight loop around it (Thumbnail Crush).
   *  - Letterer : throw words at the nearest ghost; balloon only when something is on top of us.
   *  - Colorist : spray revealed ghosts; fill a flat on the ground when they crowd in.
   */
  private heroFight(
    s: InputState,
    hero: string,
    p: PlayerAPI,
    px: number,
    pz: number,
    tgt: Damageable | null,
  ): boolean {
    this.gD = Infinity;
    this.deps.targets.forEach(this.ghostScan);
    const H = this.deps.tuning.heroes;
    if (this.gD === Infinity) return false;
    const dx = this.gX - px;
    const dz = this.gZ - pz;
    const d = this.gD || 1;
    if (hero === 'penciller') {
      if (!this.gPinned) {
        if (this.fireT <= 0 && d < H.penciller.ruler.range && p.energy >= H.penciller.ruler.cost) {
          s.boltPressed = true;
          this.fireT = 0.45;
        }
        return false;
      }
      // orbit the pinned ghost at ~1.4 m while tracing: the loop closes in under the pin time
      this.orbiting = true;
      const R = 1.4;
      const radial = (d - R) * 1.4;
      _dir.set((dx / d) * radial - (dz / d) * 1.2, 0, (dz / d) * radial + (dx / d) * 1.2);
      return true;
    }
    if (hero === 'letterer') {
      if (this.fireT <= 0 && d < H.letterer.throwRange && p.energy >= H.letterer.cost) {
        s.boltPressed = true;
        this.fireT = 0.32;
      }
      return this.nearD < 1.6 && p.energy > 20;
    }
    // colorist
    if (tgt && this.fireT <= 0 && p.energy >= H.colorist.cost) {
      s.boltPressed = true;
      this.fireT = H.colorist.cooldown + 0.04;
    }
    // close in: her light is short
    if (!tgt) _dir.set(dx, 0, dz);
    if (d < 3 && this.time - this.flatT > 7 && p.energy > 30) {
      this.flatT = this.time;
    }
    return this.time - this.flatT < H.colorist.bucket.charge + 0.15;
  }

  // ───────────────────────────── goals ─────────────────────────────

  private advancePath(px: number, pz: number): void {
    // don't run ahead while ghosts are close: fight first (arenas, door requirements)
    if (this.threats > 0 && this.nearD < 12) return;
    for (let k = 0; k < 8 && this.progress < this.n - 1; k++) {
      const i = this.progress;
      const dx = this.pts[i * 2]! - px;
      const dz = this.pts[i * 2 + 1]! - pz;
      if (dx * dx + dz * dz < 1.8 * 1.8) this.progress++;
      else break;
    }
    // a fight can carry us past the next point without touching it: catch up to any point a few
    // metres ahead that we're standing on (otherwise the look-ahead keeps us circling here)
    for (let i = Math.min(this.n - 2, this.progress + 12); i > this.progress; i--) {
      const dx = this.pts[i * 2]! - px;
      const dz = this.pts[i * 2 + 1]! - pz;
      if (dx * dx + dz * dz < 1.8 * 1.8) {
        this.progress = i + 1;
        break;
      }
    }
    if (this.progress >= this.n - 1) {
      const ex = this.pts[(this.n - 1) * 2]! - px;
      const ez = this.pts[(this.n - 1) * 2 + 1]! - pz;
      if (ex * ex + ez * ez < 1.6 * 1.6) {
        if (this.loop) this.progress = 0;
        else this.done = true;
      }
    }
  }

  /** null = not printing; otherwise whether to hold the crystal this step. */
  private sketchGoal(px: number, pz: number, energy: number): boolean | null {
    if (!this.printing) {
      for (const sk of this.level.sketches ?? []) {
        if (this.printed.has(sk.id) || (this.retryAt.get(sk.id) ?? 0) > this.time) continue;
        if (this.level.canPrint && !this.level.canPrint(sk.id)) continue;
        const dx = sk.at[0] - px;
        const dz = sk.at[2] - pz;
        if (dx * dx + dz * dz < 7 * 7) {
          this.printing = sk.id;
          this.printT = 0;
          break;
        }
      }
    }
    if (!this.printing) return null;
    let sk: { id: string; at: Vec3T } | null = null;
    for (const k of this.level.sketches ?? []) if (k.id === this.printing) sk = k;
    if (!sk) {
      this.printing = null;
      return null;
    }
    const dx = sk.at[0] - px;
    const dz = sk.at[2] - pz;
    const d = Math.hypot(dx, dz);
    // too little ink for a 2 s print: fetch some first if a well is around
    // a full print costs ~31 ink (0.6 s ramp + 2 s hold); top up first unless it's already filling
    const lp0 = this.lastProgress.get(sk.id);
    const filling = !!lp0 && this.time - lp0.at < 0.5;
    if (energy < 32 && !filling) {
      // fetch ink; if every nearby well is still refilling, wait inside the closest one
      const wi = this.nearestWell(px, pz, 30);
      const wj = wi >= 0 ? wi : this.nearestWellAny(px, pz, 40);
      if (wj >= 0) {
        const w = this.level.inkWells![wj]!;
        const wd = Math.hypot(w[0] - px, w[1] - pz);
        if (wd > WELL_RADIUS * 0.75) _dir.set(w[0] - px, 0, w[1] - pz);
        else _dir.set(0, 0, 0);
        this.printT = 0;
        return false;
      }
    }
    this.printT += 1 / this.deps.tuning.sim.hz;
    // holding but the sketch isn't filling: it has a precondition (e.g. "clear the arena")
    const lp = this.lastProgress.get(sk.id);
    if (this.printT > 2.5 && (!lp || this.time - lp.at > 1.5)) {
      this.retryAt.set(sk.id, this.time + 6);
      this.printing = null;
      this.huntUntil = this.time + 10;
      return null;
    }
    if (this.printT > 9) {
      // not printable yet (e.g. door waiting for the arena) — try again shortly
      this.retryAt.set(sk.id, this.time + 4);
      this.printing = null;
      return null;
    }
    if (d > 3.2) _dir.set(dx, 0, dz);
    else _dir.set(0, 0, 0);
    // don't burn ink on the walk in: hold only once the sketch is inside the full light
    if (d > 4.5) {
      this.printT = 0;
      return false;
    }
    return energy > 1;
  }

  /** Boss positioning. Returns move speed; calls onHold(true) when the crystal should be held. */
  private bossGoal(b: BossView, p: PlayerAPI, px: number, pz: number): number {
    const B = this.deps.tuning.boss;
    const [bx, bz] = B.pos;
    const [cx, cz, cr] = B.arena;
    const energy = p.energy;
    // a P2 print needs ~31 ink uninterrupted: top up before starting one
    const act = b.phase === 2 && b.p2Active >= 0 ? b.wps[b.p2Active]! : null;
    const wpPending = !!act && !act.printed && act.print < 0.05;
    const printing = !!act && !act.printed && act.print >= 0.05;
    // low ink: drink first (wells sit at the arena rim) — but never abandon a print in progress
    if (!printing && (energy < 30 || (wpPending && energy < 36))) {
      const w = this.nearestWell(px, pz, 30);
      if (w >= 0) {
        const wl = this.level.inkWells![w]!;
        _dir.set(wl[0] - px, 0, wl[1] - pz);
        return 1;
      }
    }
    let gx: number;
    let gz: number;
    let hold = false;
    if (b.phase === 2 && b.p2Active >= 0) {
      const w = b.wps[b.p2Active]!;
      // stand ~4 m in front of the sketched point (arena side) so the crystal is within 7 m
      const ox = w.x - bx;
      const oz = w.z - bz;
      const ol = Math.hypot(ox, oz) || 1;
      gx = w.x + (ox / ol) * 3.5 + (cx - bx) * 0.15;
      gz = w.z + (oz / ol) * 3.5 + (cz - bz) * 0.15;
      if (w.drawIn >= 1 && !w.printed && energy > 1 && (w.print > 0.05 || energy >= 36)) {
        const d3 = Math.hypot(w.x - p.crystalPos.x, w.y - p.crystalPos.y, w.z - p.crystalPos.z);
        hold = d3 < B.phase2.printRadius + 1.5;
      }
    } else if (b.phase === 3) {
      const core = b.wps[b.wps.length - 1]!;
      if (b.bowT > 0 || b.state !== 'phase') {
        // bow window: step in so the core sits inside the crystal light, and light it up
        gx = core.x + (cx - core.x) * 0.35;
        gz = core.z + (cz - core.z) * 0.35;
        hold = energy > 3 && Math.hypot(core.x - px, core.z - pz) < 8;
      } else {
        this.bossAngle += 0.004;
        gx = bx + Math.sin(Math.sin(this.bossAngle) * 0.9) * 8.5;
        gz = bz + Math.cos(Math.sin(this.bossAngle) * 0.9) * 8.5;
      }
    } else {
      // phase 1 / intro / transitions: orbit at ~8.5 m, weak points come within bolt range
      this.bossAngle += 0.004;
      const a = Math.sin(this.bossAngle) * 0.9;
      gx = bx + Math.sin(a) * 8.5;
      gz = bz + Math.cos(a) * 8.5;
    }
    // keep the goal inside the fight circle
    const ox = gx - cx;
    const oz = gz - cz;
    const ol = Math.hypot(ox, oz);
    if (ol > cr - 1.2) {
      gx = cx + (ox / ol) * (cr - 1.2);
      gz = cz + (oz / ol) * (cr - 1.2);
    }
    // ghosts the Editor spawned: back off a little
    _dir.set(gx - px + this.repX * 5, 0, gz - pz + this.repZ * 5);
    this.holdOut = hold;
    const d = Math.hypot(gx - px, gz - pz);
    return d < 0.4 ? 0 : Math.min(1, 0.35 + d * 0.3);
  }

  /** Step (or dash) out of any boss lane / circle that is telegraphing or striking. */
  private dangerEscape(b: BossView, px: number, pz: number, s: InputState, dashReady: boolean): boolean {
    const r = this.deps.tuning.player.radius;
    let ex = 0;
    let ez = 0;
    let urgent = false;
    let any = false;
    for (const a of b.attacks) {
      if (!a.active || (a.stage !== 'telegraph' && a.stage !== 'strike')) continue;
      const margin = a.hw + r + 0.9;
      const late = a.stage === 'strike' || a.t > a.telegraph * 0.55;
      if (a.kind === 'drag') {
        if (distSqToSeg(px, pz, a.ax, a.az, a.bx, a.bz) > margin * margin) continue;
        // perpendicular to the lane, toward the side we're already on
        const lx = a.bx - a.ax;
        const lz = a.bz - a.az;
        const ll = Math.hypot(lx, lz) || 1;
        let nx = -lz / ll;
        let nz = lx / ll;
        const side = (px - a.ax) * nx + (pz - a.az) * nz;
        if (side < 0) {
          nx = -nx;
          nz = -nz;
        }
        // prefer the side closer to the arena centre so we don't pin ourselves on the rim
        const [cx, cz] = this.deps.tuning.boss.arena;
        if (Math.abs(side) < 0.6 && (cx - px) * nx + (cz - pz) * nz < 0) {
          nx = -nx;
          nz = -nz;
        }
        ex += nx;
        ez += nz;
      } else {
        const dx = px - a.ax;
        const dz = pz - a.az;
        const d = Math.hypot(dx, dz);
        if (d > margin) continue;
        // pick the best of 8 escape headings: out of the circle, inside the arena, off the body
        const B = this.deps.tuning.boss;
        const [cx, cz, cr] = B.arena;
        const [bx, bz] = B.pos;
        const gx = _dir.x;
        const gz = _dir.z;
        const gl = Math.hypot(gx, gz) || 1;
        let best = -Infinity;
        let bdx = 1;
        let bdz = 0;
        for (let k = 0; k < 8; k++) {
          const ang = (k / 8) * Math.PI * 2;
          const ux = Math.cos(ang);
          const uz = Math.sin(ang);
          const qx = px + ux * 3;
          const qz = pz + uz * 3;
          let sc = Math.hypot(qx - a.ax, qz - a.az) - margin;
          if (Math.hypot(qx - cx, qz - cz) > cr - 0.8) sc -= 100;
          if (Math.hypot(qx - bx, qz - bz) < 3.2) sc -= 50;
          if (this.deps.collision && !this.deps.collision.walkable(qx, qz)) sc -= 100;
          sc += ((ux * gx + uz * gz) / gl) * 0.8;
          if (sc > best) {
            best = sc;
            bdx = ux;
            bdz = uz;
          }
        }
        ex += bdx + (d > 1e-3 ? (dx / d) * 0.2 : 0);
        ez += bdz + (d > 1e-3 ? (dz / d) * 0.2 : 0);
      }
      any = true;
      if (late) urgent = true;
    }
    if (!any) return false;
    _dir.set(ex, 0, ez);
    if (urgent && dashReady) {
      this.toScreen(ex, ez, s.dashDir);
      s.dashPressed = true;
    }
    return true;
  }

  private dashAway(s: InputState, px: number, pz: number, tx: number, tz: number): void {
    let ax = px - tx;
    let az = pz - tz;
    // bias toward the path so the dash doesn't slam into the forest edge
    const i = Math.min(this.n - 1, this.progress);
    ax += (this.pts[i * 2]! - px) * 0.25;
    az += (this.pts[i * 2 + 1]! - pz) * 0.25;
    this.toScreen(ax, az, s.dashDir);
    s.dashPressed = true;
  }

  private keepWalkable(px: number, pz: number): void {
    const C = this.deps.collision;
    if (!C || _dir.lengthSq() < 1e-6) return;
    const l = Math.hypot(_dir.x, _dir.z);
    const ax = px + (_dir.x / l) * 1.2;
    const az = pz + (_dir.z / l) * 1.2;
    if (C.walkable(ax, az)) return;
    // bend toward the nearest centreline point
    const i = this.nearestIndex();
    const cx = this.pts[i * 2]! - px;
    const cz = this.pts[i * 2 + 1]! - pz;
    const cl = Math.hypot(cx, cz) || 1;
    _dir.set(_dir.x / l + (cx / cl) * 1.5, 0, _dir.z / l + (cz / cl) * 1.5);
  }

  private nearestWell(px: number, pz: number, maxD: number): number {
    const wells = this.level.inkWells;
    if (!wells) return -1;
    const refill = (this.deps.tuning as Tuning & { world?: { wellRefill?: number } }).world?.wellRefill ?? 22;
    let best = -1;
    let bd = maxD;
    for (let i = 0; i < wells.length; i++) {
      const w = wells[i]!;
      const d = Math.hypot(w[0] - px, w[1] - pz);
      if (d < WELL_RADIUS) this.wellUsed[i] = this.time;
      if (this.time - this.wellUsed[i]! < refill + 0.5) continue;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  private nearestWellAny(px: number, pz: number, maxD: number): number {
    const wells = this.level.inkWells;
    if (!wells) return -1;
    let best = -1;
    let bd = maxD;
    for (let i = 0; i < wells.length; i++) {
      if (this.time - this.wellBad[i]! < 30) continue;
      const d = Math.hypot(wells[i]![0] - px, wells[i]![1] - pz);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  /** Index of a kill drop < 3 s old within 9 m, or -1. Consumed once reached. */
  private recentDrop(px: number, pz: number): number {
    for (let k = 0; k < 4; k++) {
      if (this.time - this.drops[k * 3 + 2]! > 3) continue;
      const d = Math.hypot(this.drops[k * 3]! - px, this.drops[k * 3 + 1]! - pz);
      if (d < 1.2) {
        this.drops[k * 3 + 2] = -1e9;
        continue;
      }
      if (d < 9) return k;
    }
    return -1;
  }

  private toScreen(wx: number, wz: number, out: THREE.Vector2): void {
    const v = this.deps.view;
    const l = Math.hypot(wx, wz) || 1;
    out.set((wx * v.right.x + wz * v.right.z) / l, (wx * v.forward.x + wz * v.forward.z) / l);
  }

  private nearestIndex(): number {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const dx = this.pts[i * 2]! - this.px;
      const dz = this.pts[i * 2 + 1]! - this.pz;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
}

/** Wiring (FLAGS.autoplay): `installAutoplay(ctx, level, rig, { boss: () => editor?.fsm, projectiles })`. */
export function installAutoplay(
  ctx: GameContext,
  level: AutoplayLevel,
  view: AutoplayDeps['view'],
  extra: Pick<AutoplayDeps, 'boss' | 'projectiles'> = {},
  /** Co-op: drive another local wizard (slot 1) through its own input instead of ctx.input/player. */
  who?: { input: InputAPI; player: PlayerAPI },
): AutoplayBot {
  return new AutoplayBot(
    {
      input: who?.input ?? ctx.input,
      events: ctx.events,
      tuning: ctx.tuning,
      targets: ctx.targets,
      getPlayer: () => (who?.player ?? ctx.player) as (PlayerAPI & { dashCooldown01?: number }) | null,
      partner: () => ctx.players?.find((q) => q !== (who?.player ?? ctx.player)) ?? null,
      view,
      collision: ctx.collision,
      ...extra,
    },
    level,
  ).attach();
}
