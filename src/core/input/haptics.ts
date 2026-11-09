/** navigator.vibrate wrapper (Android). iOS Safari has no vibrate: silently a no-op. */
export class Haptics {
  /** Bound to `Settings.vibration` by whoever owns settings (read at call time). */
  settings: { vibration: boolean } | null = null;
  private readonly can = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  /** Beat-locked patterns are for phones only (desktop Firefox also exposes vibrate()). */
  private readonly android = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent ?? '');
  private lastAt = 0;
  private lastMusicAt = 0;

  pulse(pattern: number | number[], minGapMs = 30): void {
    if (!this.can || (this.settings && !this.settings.vibration)) return;
    const now = performance.now();
    if (now - this.lastAt < minGapMs) return;
    this.lastAt = now;
    try {
      navigator.vibrate(pattern);
    } catch {
      /* blocked before user activation */
    }
  }

  // ── beat-locked haptics (audio workstream): Android only, own rate limit so a music pulse
  // never swallows a gameplay pulse (and vice versa) beyond the shared 30 ms gap.

  /** Rhythm tick (an action landed on the beat). */
  beatTick(ms = 7, minGapMs = 90): void {
    this.music(ms, minGapMs);
  }

  /** Kill accent: short-gap-long. */
  killPattern(pattern: number[] = [14, 40, 22], minGapMs = 90): void {
    this.music(pattern, minGapMs);
  }

  /** Lub-dub, on the downbeats of the boss's blank page. */
  heartbeat(pattern: number[] = [16, 110, 10], minGapMs = 300): void {
    this.music(pattern, minGapMs);
  }

  private music(pattern: number | number[], minGapMs: number): void {
    if (!this.android) return;
    const now = performance.now();
    if (now - this.lastMusicAt < minGapMs) return;
    this.lastMusicAt = now;
    this.pulse(pattern);
  }
}

export const haptics = new Haptics();
