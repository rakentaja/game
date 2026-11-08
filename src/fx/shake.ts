/**
 * Screen shake (trauma², smooth multi-sine noise — no RNG, no allocs) and time freeze
 * (hit-stop / panel-cut hold on real time). Both respect reduce-motion via `enabled`.
 */
import * as THREE from 'three';
import { TUNING } from '../data/tuning';

function wave(t: number, seed: number): number {
  return (
    Math.sin(t * 1.0 + seed) * 0.5 +
    Math.sin(t * 2.31 + seed * 1.7) * 0.3 +
    Math.sin(t * 4.97 + seed * 2.9) * 0.2
  );
}

export class ScreenShake {
  enabled = true;
  trauma = 0;
  readonly offset = new THREE.Vector3();
  roll = 0;
  private decay: number = TUNING.fx.shakeDecayPerSec;
  private t = 0;
  private readonly saved = new THREE.Vector3();
  private readonly savedQ = new THREE.Quaternion();
  private applied = false;

  add(intensity: number, duration = 0.4): void {
    if (!this.enabled) return;
    this.trauma = Math.min(1, this.trauma + Math.max(0, intensity));
    this.decay = Math.max(TUNING.fx.shakeDecayPerSec * 0.5, 1 / Math.max(0.05, duration));
  }

  update(dt: number): void {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - this.decay * dt);
    if (!this.enabled) this.trauma = 0;
    const s = this.trauma * this.trauma * TUNING.fx.shakeMax;
    const f = this.t * TUNING.fx.shakeFreq;
    this.offset.set(wave(f, 1.3) * s, wave(f, 7.7) * s * 0.8, wave(f, 4.1) * s * 0.5);
    this.roll = wave(f * 0.7, 11.1) * this.trauma * this.trauma * 0.035;
  }

  /** Offset the camera for this frame's draw. Always pair with `restore`. */
  apply(cam: THREE.Camera): void {
    this.applied = this.trauma > 0;
    if (!this.applied) return;
    this.saved.copy(cam.position);
    this.savedQ.copy(cam.quaternion);
    cam.translateX(this.offset.x);
    cam.translateY(this.offset.y);
    cam.translateZ(this.offset.z);
    cam.rotateZ(this.roll);
    cam.updateMatrixWorld();
  }

  restore(cam: THREE.Camera): void {
    if (!this.applied) return;
    cam.position.copy(this.saved);
    cam.quaternion.copy(this.savedQ);
    cam.updateMatrixWorld();
    this.applied = false;
  }
}

/** Real-time hold that drives `time.scale` to 0 and restores the previous value afterwards. */
export class TimeFreeze {
  remaining = 0;
  private saved = 1;
  private frozen = false;

  hold(seconds: number, time: { scale: number }): void {
    if (seconds <= 0) return;
    if (!this.frozen) {
      this.saved = time.scale;
      this.frozen = true;
      time.scale = 0;
    }
    this.remaining = Math.max(this.remaining, seconds);
  }

  update(realDt: number, time: { scale: number }): void {
    if (!this.frozen) return;
    this.remaining -= realDt;
    if (this.remaining <= 0) {
      this.frozen = false;
      this.remaining = 0;
      time.scale = this.saved;
    }
  }

  get active(): boolean {
    return this.frozen;
  }
}
