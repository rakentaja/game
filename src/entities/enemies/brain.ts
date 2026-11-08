import type { RevealAPI } from '../../core/types';
import type { Tuning } from '../../data/tuning';
import type { Rng } from '../../systems/ai/fsm';
import type { V2 } from '../../systems/ai/steering';
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
  /** Base (undrained) reveal target radius this step, before any blot suppression. */
  readonly baseRevealTarget: number;
  /** Difficulty: >1 stretches windups/cooldowns. */
  readonly tempo: number;
  /** Difficulty: movement speed multiplier. */
  readonly speedMul: number;
  /** Difficulty: blot drain multiplier. */
  readonly drainMul: number;
  /** Ask for one of the limited attack tokens (smudge dart / scribbler shot). */
  requestAttack(e: Enemy): boolean;
  telegraph(e: Enemy, duration: number): void;
  fireProjectile(e: Enemy, dirX: number, dirZ: number): void;
  /** Contact damage attempt; returns true if it landed. */
  touchPlayer(e: Enemy): boolean;
  lineClear(ax: number, az: number, bx: number, bz: number): boolean;
  /** Multiplicative reveal suppression (blot). 1 = none. */
  suppressReveal(factor: number): void;
  drainPulse(e: Enemy): void;
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
}

export function distToPlayer(e: Enemy, w: BrainWorld): number {
  const dx = w.playerX - e.position.x;
  const dz = w.playerZ - e.position.z;
  return Math.sqrt(dx * dx + dz * dz);
}
