import * as THREE from 'three';
import type { EnemyAPI, EnemyKind } from '../../core/types';
import { AiState } from '../../systems/ai/fsm';

/** Implemented by EnemySystem; the enemy forwards hits so events/FX live in one place. */
export interface EnemyOwner {
  onEnemyHit(e: Enemy, amount: number, from: THREE.Vector3): void;
}

export const KIND_INDEX: Record<EnemyKind, number> = { smudge: 0, scribbler: 1, blot: 2 };

/**
 * One pooled enemy. Pure data + the `hit` entry point; behaviour lives in the per-kind brains
 * (Smudge.ts / Scribbler.ts / Blot.ts) driven by EnemySystem. Never allocated during play.
 */
export class Enemy implements EnemyAPI {
  id = 0;
  kind: EnemyKind = 'smudge';
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  radius = 0.45;
  hp = 0;
  maxHp = 0;
  /** Slot in use (includes the death animation). */
  active = false;
  /** Hittable/targetable: active and not dying. */
  alive = false;
  revealed = false;
  /** Ever revealed during this life (drives outline growth & "first" events). */
  seen = false;

  state: AiState = AiState.Idle;
  stateT = 0;
  stateDur = 0;
  /** Sub-phase inside a state (e.g. smudge windup=0 / dart=1). */
  phase = 0;

  yaw = 0;
  seed = 0;
  orbitDir = 1;

  // Attack bookkeeping
  aimX = 0;
  aimZ = 0;
  fireCd = 0;
  contactCd = 0;
  drainPulseT = 0;
  hitPlayer = false;
  /** Velocity is driven directly by the brain (dart), skip steering this step. */
  ballistic = false;

  // Visual channels (0..1), read by the renderer.
  revealVis = 0;
  spawnT = 0;
  hitT = 0;
  deathT = 0;
  windup = 0;
  lunge = 0;
  recoil = 0;
  drain = 0;
  speed01 = 0;
  /** Smoothed horizontal velocity in local space for cloth lag (x right, z forward). */
  lagX = 0;
  lagZ = 0;

  constructor(private owner: EnemyOwner) {}

  hit(amount: number, from: THREE.Vector3): void {
    if (!this.alive || !this.revealed) return;
    this.owner.onEnemyHit(this, amount, from);
  }

  setState(s: AiState, dur = 0): void {
    this.state = s;
    this.stateT = 0;
    this.stateDur = dur;
    this.phase = 0;
  }
}
