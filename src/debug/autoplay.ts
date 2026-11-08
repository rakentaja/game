/**
 * ?autoplay=1 bot (PLAN §12): walks the level path, holds the crystal at unprinted sketch objects
 * until they print, shoots revealed targets, kites and dashes out of contact, and unsticks itself.
 * It drives the real InputAPI state right after each poll, so every downstream system sees
 * exactly what a player would produce.
 */
import * as THREE from 'three';
import type { EventBus, GameEvents } from '../core/events';
import type {
  GameContext,
  InputAPI,
  InputState,
  PlayerAPI,
  TargetRegistry,
  Vec2T,
  Vec3T,
} from '../core/types';
import type { Tuning } from '../data/tuning';

export interface AutoplayLevel {
  path: Vec2T[];
  sketches?: { id: string; at: Vec3T }[];
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
}

const _dir = new THREE.Vector3();

export class AutoplayBot {
  /** Path finished. */
  done = false;
  /** Current mode, for the debug overlay / e2e logs. */
  mode: 'walk' | 'fight' | 'print' | 'unstick' | 'idle' = 'idle';
  loop = false;

  private pts: Float32Array;
  private n: number;
  private progress = 0;
  private time = 0;
  private fireT = 0;
  private holdT = 0;
  private printing: string | null = null;
  private printT = 0;
  private printed = new Set<string>();
  private retryAt = new Map<string, number>();
  private stuckT = 0;
  private stuckX = 0;
  private stuckZ = 0;
  private unstickT = 0;
  private unstickSide = 1;
  private offs: (() => void)[] = [];
  private unpatch: (() => void) | null = null;

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
    this.offs.push(
      deps.events.on('sketch:printed', ({ id }) => {
        this.printed.add(id);
        if (this.printing === id) this.printing = null;
      }),
      deps.events.on('player:respawn', () => {
        this.stuckT = 0;
        this.printing = null;
        this.progress = this.nearestIndex();
      }),
    );
  }

  /** Hook into input.poll so the bot drives state every sim step. */
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
    if (!p || p.pages <= 0) {
      this.mode = 'idle';
      return;
    }
    const T = this.deps.tuning;
    const px = p.position.x;
    const pz = p.position.z;

    // ── advance along the path
    for (let k = 0; k < 6 && this.progress < this.n - 1; k++) {
      const i = this.progress;
      const dx = this.pts[i * 2]! - px;
      const dz = this.pts[i * 2 + 1]! - pz;
      if (dx * dx + dz * dz < 1.6 * 1.6) this.progress++;
      else break;
    }
    if (this.progress >= this.n - 1) {
      const ex = this.pts[(this.n - 1) * 2]! - px;
      const ez = this.pts[(this.n - 1) * 2 + 1]! - pz;
      if (ex * ex + ez * ez < 1.5 * 1.5) {
        if (this.loop) this.progress = 0;
        else this.done = true;
      }
    }
    const look = Math.min(this.n - 1, this.progress + 4);
    _dir.set(this.pts[look * 2]! - px, 0, this.pts[look * 2 + 1]! - pz);
    let wantMove = this.done ? 0 : 1;

    // ── sketch objects: stand near and hold the crystal until printed
    if (!this.printing) {
      for (const sk of this.level.sketches ?? []) {
        if (this.printed.has(sk.id) || (this.retryAt.get(sk.id) ?? 0) > this.time) continue;
        if (this.level.canPrint && !this.level.canPrint(sk.id)) continue;
        const dx = sk.at[0] - px;
        const dz = sk.at[2] - pz;
        if (dx * dx + dz * dz < 6 * 6) {
          this.printing = sk.id;
          this.printT = 0;
          break;
        }
      }
    }
    let hold = false;
    if (this.printing) {
      const sk = this.level.sketches?.find((k) => k.id === this.printing);
      this.printT += dt;
      if (!sk || this.printT > 8) {
        // not printable yet (dormant door, out of ink): fight/refill, then come back and retry
        if (sk) this.retryAt.set(sk.id, this.time + 5);
        this.printing = null;
      } else {
        const dx = sk.at[0] - px;
        const dz = sk.at[2] - pz;
        const d = Math.hypot(dx, dz);
        if (d > 3) _dir.set(dx, 0, dz);
        else wantMove = 0;
        hold = p.energy > 1;
        this.mode = 'print';
      }
    }

    // ── combat
    const tgt = this.deps.targets.nearest(p.position, T.bolt.maxRange * 0.9);
    if (tgt) {
      this.mode = this.printing ? 'print' : 'fight';
      this.fireT -= dt;
      if (this.fireT <= 0 && p.energy >= T.bolt.cost) {
        s.boltPressed = true;
        this.fireT = 0.32;
      }
      const dx = tgt.position.x - px;
      const dz = tgt.position.z - pz;
      const d = Math.hypot(dx, dz);
      if (d < 2.2) {
        // too close: back off, dash out if it's on top of us
        _dir.set(-dx, 0, -dz);
        wantMove = 1;
        if (d < 1.4 && (p.dashCooldown01 ?? 0) <= 0) {
          this.toScreen(-dx, -dz, s.dashDir);
          s.dashPressed = true;
        }
      } else if (!this.printing) wantMove = d > 6 ? 0.8 : 0.35;
    } else if (!this.printing) {
      this.mode = this.done ? 'idle' : 'walk';
      // periodically flare the crystal to flush out lurkers
      this.holdT += dt;
      if (p.energy > 45 && this.holdT % 7 < 1.2) hold = true;
    }
    s.crystalHeld = hold;

    // ── stuck detection
    this.stuckT += dt;
    if (this.stuckT > 1.5) {
      const moved = Math.hypot(px - this.stuckX, pz - this.stuckZ);
      if (moved < 0.4 && wantMove > 0 && !this.done) {
        this.unstickT = 0.6;
        this.unstickSide = -this.unstickSide;
        if ((p.dashCooldown01 ?? 1) <= 0) {
          this.toScreen(_dir.x, _dir.z, s.dashDir);
          s.dashPressed = true;
        }
      }
      this.stuckT = 0;
      this.stuckX = px;
      this.stuckZ = pz;
    }
    if (this.unstickT > 0) {
      this.unstickT -= dt;
      // sidestep perpendicular, then rejoin
      _dir.set(-_dir.z * this.unstickSide + _dir.x * 0.3, 0, _dir.x * this.unstickSide + _dir.z * 0.3);
      this.mode = 'unstick';
      wantMove = 1;
    }

    if (wantMove > 0 && _dir.lengthSq() > 1e-6) {
      _dir.normalize();
      this.toScreen(_dir.x, _dir.z, s.move);
      s.move.multiplyScalar(wantMove);
    }
    s.device = 'touch';
  }

  private toScreen(wx: number, wz: number, out: THREE.Vector2): void {
    const v = this.deps.view;
    const l = Math.hypot(wx, wz) || 1;
    out.set((wx * v.right.x + wz * v.right.z) / l, (wx * v.forward.x + wz * v.forward.z) / l);
  }

  private nearestIndex(): number {
    const p = this.deps.getPlayer();
    if (!p) return 0;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const dx = this.pts[i * 2]! - p.position.x;
      const dz = this.pts[i * 2 + 1]! - p.position.z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
}

/** main.ts wiring (only when FLAGS.autoplay): `installAutoplay(ctx, level, cameraRig)`. */
export function installAutoplay(
  ctx: GameContext,
  level: AutoplayLevel,
  view: AutoplayDeps['view'],
): AutoplayBot {
  return new AutoplayBot(
    {
      input: ctx.input,
      events: ctx.events,
      tuning: ctx.tuning,
      targets: ctx.targets,
      getPlayer: () => ctx.player as (PlayerAPI & { dashCooldown01?: number }) | null,
      view,
    },
    level,
  ).attach();
}
