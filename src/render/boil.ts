/**
 * Line boil (PLAN §2.2.5): a seed that re-rolls at TUNING.boil.hz, and an AnimationMixer stepper
 * that applies animation in 1/animHz chunks (characters move "on twos"; camera / VFX stay 60 fps).
 */
import type * as THREE from 'three';
import { TUNING } from '../data/tuning';

export class BoilClock {
  /** Current seed (fed to uBoilSeed). Constant while `enabled` is false. */
  seed = 0;
  enabled = true;
  private acc = 0;
  private step = 0;

  /** Advance by real time. Returns true when the seed changed this call. */
  update(dt: number): boolean {
    if (!this.enabled) return false;
    const period = 1 / Math.max(1, TUNING.boil.hz);
    this.acc += dt;
    if (this.acc < period) return false;
    const n = Math.floor(this.acc / period);
    this.acc -= n * period;
    this.step = (this.step + n) % 997;
    // Golden-ratio walk: consecutive seeds are far apart in noise space, never repeats visibly.
    this.seed = ((this.step * 0.618034) % 1) * 61.7;
    return true;
  }
}

/**
 * Wraps an AnimationMixer so it only advances in whole 1/animHz steps.
 * `stepped = false` makes it a pass-through (reduce motion keeps animation smooth, no boil).
 */
export class SteppedMixer {
  stepped = true;
  private acc = 0;
  constructor(readonly mixer: THREE.AnimationMixer) {}

  /** Returns the dt actually applied to the mixer this call (0 between steps). */
  update(dt: number): number {
    if (!this.stepped) {
      this.mixer.update(dt);
      return dt;
    }
    const step = 1 / Math.max(1, TUNING.boil.animHz);
    this.acc += dt;
    if (this.acc < step) return 0;
    const n = Math.floor(this.acc / step);
    const applied = n * step;
    this.acc -= applied;
    this.mixer.update(applied);
    return applied;
  }
}
