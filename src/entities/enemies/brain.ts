import type { RevealAPI, SfxId } from '../../core/types';
import type { Tuning } from '../../data/tuning';
import type { Rng } from '../../systems/ai/fsm';
import type { V2 } from '../../systems/ai/steering';
import type { CraneTarget } from './Cranes';
import type { Enemy } from './Enemy';

/** What a brain may read/do each sim step. Implemented by EnemySystem. */
export interface BrainWorld {
  readonly tuning: Tuning;
  readonly reveal: RevealAPI;
  readonly rng: Rng;
  /** Player ground position (valid only if hasPlayer). */
  readonly playerX: number;
  readonly playerZ: number;
  readonly playerVX: number;
  readonly playerVZ: number;
  readonly playerRadius: number;
  readonly hasPlayer: boolean;
  /** The player is holding the crystal this step. */
  readonly crystalHeld: boolean;
  /** Base (undrained) reveal target radius this step, before any blot suppression. */
  readonly baseRevealTarget: number;
  /** Difficulty: >1 stretches windups/cooldowns. */
  readonly tempo: number;
  /** Difficulty: movement speed multiplier. */
  readonly speedMul: number;
  /** Difficulty: blot drain multiplier. */
  readonly drainMul: number;
  /** Beats seen since the system started (`audio:beat`), and whether one landed this step. */
  readonly beatCount: number;
  readonly beatNow: boolean;
  /** Seconds per beat of the current track (0 when no beats arrive). */
  readonly beatLen: number;
  /** Ask for one of the limited attack tokens (smudge dart / scribbler shot). */
  requestAttack(e: Enemy): boolean;
  telegraph(e: Enemy, duration: number): void;
  fireProjectile(e: Enemy, dirX: number, dirZ: number): void;
  /** Contact damage attempt; returns true if it landed. */
  touchPlayer(e: Enemy): boolean;
  /** Direct damage from a gimmick (Panel Warden gutter, crane dive). Respects i-frames. */
  damagePlayer(e: Enemy, amount: number, shake: number): void;
  lineClear(ax: number, az: number, bx: number, bz: number): boolean;
  /** Walkable ground (collision); true without collision. */
  walkable(x: number, z: number): boolean;
  /** Multiplicative reveal suppression (blot). 1 = none. */
  suppressReveal(factor: number): void;
  drainPulse(e: Enemy): void;
  sfx(id: SfxId, x: number, y: number, z: number, volume?: number): void;
  /** Request a comic panel cut (`fx:panelCut`). */
  panelCut(word: string, x: number, y: number, z: number, reason: string): void;
  /** Free crane boids (pooled); returns how many were attached to `e.flock`. */
  attachCranes(e: Enemy, n: number): number;
  /** The crane boid pool. */
  readonly cranes: readonly CraneTarget[];
}

export interface Brain {
  /** Called once when the enemy (re)spawns. */
  init(e: Enemy, w: BrainWorld): void;
  /** Called when the FSM enters Stalk (after idle, attack or recoil). */
  stalk(e: Enemy, w: BrainWorld): void;
  /**
   * Per-step behaviour for Idle/Stalk/Attack. Writes desired velocity into `desired` and may
   * change state (via e.setState). Recoil/Die are handled generically by the system.
   */
  update(e: Enemy, w: BrainWorld, dt: number, desired: V2): void;
  /** Optional per-step hook while Idle (cranes keep flying). */
  idle?(e: Enemy, w: BrainWorld, dt: number): void;
  /** Gimmick gate: may bolts hit it right now? Default: always. */
  vulnerable?(e: Enemy, w: BrainWorld): boolean;
  /** An attack in flight was interrupted (hit recoil, stun, respawn calm). */
  interrupt?(e: Enemy, w: BrainWorld): void;
  /** The player dashed along a→b (copied out of the `player:dash` payload). */
  onDash?(e: Enemy, w: BrainWorld, ax: number, az: number, bx: number, bz: number): void;
  /** The brain drives position directly (blink / boid centroid): skip steering + integration. */
  readonly selfMove?: boolean;
  /** Hits put it into recoil (default true). */
  readonly recoils?: boolean;
}

export function distToPlayer(e: Enemy, w: BrainWorld): number {
  const dx = w.playerX - e.position.x;
  const dz = w.playerZ - e.position.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Squared distance from point p to segment a→b (XZ). */
export function distSqToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : Math.min(t, 1);
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}
