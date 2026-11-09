import * as THREE from 'three';
import type { EliteAffix, EnemyAPI, EnemyKind } from '../../core/types';
import { AiState } from '../../systems/ai/fsm';
import type { CraneTarget } from './Cranes';

/** Implemented by EnemySystem; the enemy forwards hits so events/FX live in one place. */
export interface EnemyOwner {
  onEnemyHit(e: Enemy, amount: number, from: THREE.Vector3): void;
  onEnemyStun(e: Enemy, seconds: number): void;
}

export const KIND_INDEX: Record<EnemyKind, number> = {
  smudge: 0,
  scribbler: 1,
  blot: 2,
  marginMan: 3,
  redactor: 4,
  panelWarden: 5,
  misprint: 6,
  cranes: 7,
};

/** Outline tint index per elite affix (0 = none), read by the renderer. */
export const ELITE_INDEX: Record<EliteAffix, number> = { firstEdition: 1, inkedIn: 2, bleedThrough: 3 };

/**
 * One pooled enemy. Pure data + the `hit` entry point; behaviour lives in the per-kind brains
 * (Smudge.ts / Scribbler.ts / Blot.ts / MarginMan.ts ...) driven by EnemySystem. Never
 * allocated during play.
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
  /** Raw reveal state (inside the ink mask, with hysteresis / Inked In hold). */
  inked = false;
  /**
   * The brain's gimmick allows hits right now (Margin Man dash window, Redactor shield down,
   * Misprint aligned...). Refreshed every sim step; stun and the gimmick fallback force it.
   */
  vulnerable = true;
  /** Ever revealed during this life (drives outline growth & "first" events). */
  seen = false;
  /** Winding up / telegraphing an attack (Close-Up Crits). Refreshed every sim step. */
  attacking = false;

  state: AiState = AiState.Idle;
  stateT = 0;
  /** Seconds since spawn. */
  age = 0;
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
  /** Smudge: distance to the aim point when the dart launched. */
  dartDist = 0;

  // ── wave-1 gimmicks / affixes ──
  /** Seconds left frozen by `stun()`. */
  stunT = 0;
  /** Seconds left in a brain-granted hittable window (Margin Man after a dash crossing). */
  vulnT = 0;
  /** Redactor shield (1 = immune) and crystal exposure 0..1. Misprint: alignment 0..1. */
  shield = 0;
  expose = 0;
  align = 0;
  /** Misprint cycle clock / generic brain timers. */
  cycleT = 0;
  timerA = 0;
  timerB = 0;
  /** Generic brain anchors (Redactor lane, Panel Warden box centre, Margin Man blink target). */
  ax = 0;
  az = 0;
  bx = 0;
  bz = 0;
  /** Panel Warden box half-size (0 = none) and telegraphed seam corner (0..3). */
  boxHalf = 0;
  seam = 0;
  /** Gimmick fallback reached: plain bolts work from now on (keeps every fight finishable). */
  worn = false;
  elite: EliteAffix | null = null;
  /** Inked In: seconds left of the post-mask reveal hold. */
  inkHoldT = 0;
  /** Bleed-Through buff on movement. */
  speedBuff = 1;
  /** Origami Crane Swarm members (references into the system's crane pool). */
  readonly flock: CraneTarget[] = [];

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

  /** Only revealed *and* currently vulnerable enemies can be targeted or hit. */
  get revealed(): boolean {
    return (this.inked || this.stunT > 0) && (this.vulnerable || this.stunT > 0);
  }

  hit(amount: number, from: THREE.Vector3): void {
    if (!this.alive || !this.revealed) return;
    this.owner.onEnemyHit(this, amount, from);
  }

  stun(seconds: number): void {
    if (!this.alive || !(seconds > 0)) return;
    this.owner.onEnemyStun(this, seconds);
  }

  setState(s: AiState, dur = 0): void {
    this.state = s;
    this.stateT = 0;
    this.stateDur = dur;
    this.phase = 0;
  }
}
