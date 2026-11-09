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
  /** Freezes overlap (panel cut + hit-stop); time resumes only when the last one releases. */
  private static holders = 0;
  /** Scale restored when the last freeze releases (SlowMo lowers it). */
  static base = 1;

  /** Any freeze currently holding time at 0. */
  static get held(): boolean {
    return TimeFreeze.holders > 0;
  }
  remaining = 0;
  private frozen = false;

  hold(seconds: number, time: { scale: number }): void {
    if (seconds <= 0) return;
    if (!this.frozen) {
      this.frozen = true;
      TimeFreeze.holders++;
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
      TimeFreeze.holders = Math.max(0, TimeFreeze.holders - 1);
      if (TimeFreeze.holders === 0) time.scale = TimeFreeze.base;
    }
  }

  get active(): boolean {
    return this.frozen;
  }
}

/**
 * Real-time slow motion (Ink Parry "Blot Out"): lowers the scale freezes restore to, and eases
 * back to 1 over the last 25% of the window. Never fights an active freeze.
 */
export class SlowMo {
  remaining = 0;
  private total = 0;
  private scale = 1;

  start(scale: number, seconds: number, time: { scale: number }): void {
    if (seconds <= 0) return;
    this.scale = Math.max(0.05, Math.min(1, scale));
    this.total = seconds;
    this.remaining = seconds;
    this.apply(time);
  }

  update(realDt: number, time: { scale: number }): void {
    if (this.remaining <= 0) return;
    this.remaining = Math.max(0, this.remaining - realDt);
    this.apply(time);
  }

  get active(): boolean {
    return this.remaining > 0;
  }

  private apply(time: { scale: number }): void {
    const k = this.total > 0 ? this.remaining / (this.total * 0.25) : 0;
    const s = this.remaining <= 0 ? 1 : this.scale + (1 - this.scale) * (1 - Math.min(1, k));
    TimeFreeze.base = s;
    if (!TimeFreeze.held) time.scale = s;
  }
}
