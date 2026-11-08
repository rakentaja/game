/** navigator.vibrate wrapper (Android). iOS Safari has no vibrate: silently a no-op. */
export class Haptics {
  /** Bound to `Settings.vibration` by whoever owns settings (read at call time). */
  settings: { vibration: boolean } | null = null;
  private readonly can = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  private lastAt = 0;

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
}

export const haptics = new Haptics();
