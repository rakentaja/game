/**
 * Adaptive resolution. Feeds on real frame time, steers the pixel ratio within
 * [minPixelRatio, min(devicePixelRatio, maxPixelRatio)] with hysteresis:
 * drop fast (downAfterS over budget), climb slowly (upAfterS comfortably under it).
 * rAF is vsync-capped, so "under budget" means frames land at ≈ target, not below it.
 */
import type { QualityLevel } from '../core/types';
import { TUNING } from '../data/tuning';

export interface QualityProfile {
  msaa: number;
  /** Sobel edges rendered into a half-resolution target. */
  halfResEdges: boolean;
  revealHistory: boolean;
  fxScale: number;
}

export function profileFor(level: QualityLevel, mobile: boolean): QualityProfile {
  if (level === 'low') return { msaa: 0, halfResEdges: true, revealHistory: false, fxScale: 0.5 };
  if (level === 'high') return { msaa: mobile ? 0 : 4, halfResEdges: false, revealHistory: true, fxScale: 1 };
  return { msaa: 0, halfResEdges: mobile, revealHistory: true, fxScale: 1 };
}

export class AdaptiveQuality {
  pixelRatio: number;
  ema = TUNING.quality.targetFrameMs;
  enabled = true;
  private over = 0;
  private under = 0;
  private settle = 0;
  /** Ratio that was too slow recently; don't climb back to it until the memory expires. */
  private ceiling = Number.POSITIVE_INFINITY;
  private ceilingTtl = 0;

  constructor(
    public deviceRatio: number,
    start?: number,
  ) {
    this.pixelRatio = this.clamp(start ?? Math.min(deviceRatio, 1.5));
  }

  get maxRatio(): number {
    return Math.max(TUNING.quality.minPixelRatio, Math.min(this.deviceRatio, TUNING.quality.maxPixelRatio));
  }

  clamp(pr: number): number {
    return Math.min(this.maxRatio, Math.max(TUNING.quality.minPixelRatio, pr));
  }

  /** Feed a frame time (ms). Returns true when the pixel ratio changed. */
  sample(frameMs: number): boolean {
    const Q = TUNING.quality;
    // Ignore hitches (tab switch, GC, shader compile) — they are not a resolution problem.
    if (frameMs <= 0 || frameMs > 250) return false;
    this.ema += (frameMs - this.ema) * 0.08;
    if (!this.enabled) return false;
    const dt = frameMs / 1000;
    if (this.ceilingTtl > 0) {
      this.ceilingTtl -= dt;
      if (this.ceilingTtl <= 0) this.ceiling = Number.POSITIVE_INFINITY;
    }
    if (this.settle > 0) {
      this.settle -= dt;
      return false;
    }
    if (this.ema > Q.targetFrameMs * Q.downRatio) {
      this.over += dt;
      this.under = 0;
    } else if (this.ema < Q.targetFrameMs * Q.upRatio) {
      this.under += dt;
      this.over = 0;
    } else {
      this.over = Math.max(0, this.over - dt);
      this.under = Math.max(0, this.under - dt);
    }
    let next = this.pixelRatio;
    if (this.over >= Q.downAfterS)
      next = this.pixelRatio - Q.prStep * (this.ema > Q.targetFrameMs * 1.6 ? 2 : 1);
    else if (this.under >= Q.upAfterS && this.pixelRatio + Q.prStep < this.ceiling - 1e-6)
      next = this.pixelRatio + Q.prStep;
    next = this.clamp(Math.round(next / Q.prStep) * Q.prStep);
    if (this.over >= Q.downAfterS || this.under >= Q.upAfterS) {
      this.over = this.under = 0;
    }
    if (Math.abs(next - this.pixelRatio) < 1e-6) return false;
    if (next < this.pixelRatio) {
      this.ceiling = this.pixelRatio;
      this.ceilingTtl = 20;
    }
    this.pixelRatio = next;
    // Let the new resolution's frame times arrive before judging again.
    this.settle = 0.5;
    this.ema = Q.targetFrameMs;
    return true;
  }
}
