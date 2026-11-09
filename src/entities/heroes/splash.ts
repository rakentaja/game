/**
 * Splash meter (the ultimate). Pure: charged by kills, prints and combos; kill chains add a little
 * extra. Emits `splash:changed` (0..1) when the shown value moves by ≥ 1 % or hits full / empty.
 * A pair combo opens a short double-rate window (`heroes.splash.comboBoostS`) on every meter that
 * hears it: both players charge ×2 for a few seconds.
 */
import type { EventBus, GameEvents } from '../../core/events';
import type { PlayerSlot } from '../../core/types';
import { TUNING } from '../../data/tuning';

export class SplashMeter {
  value = 0;
  /** Seconds of double-rate charging left (after a pair combo). */
  boostT = 0;
  private shown = -1;
  private msg = { pid: 0 as PlayerSlot, value: 0 };

  constructor(
    private events: EventBus<GameEvents> | null,
    private pid: PlayerSlot | (() => PlayerSlot) = 0,
  ) {}

  get full(): boolean {
    return this.value >= 1 - 1e-6;
  }

  get rate(): number {
    return this.boostT > 0 ? 2 : 1;
  }

  add(n: number): void {
    if (!(n > 0)) return;
    this.value = Math.min(1, this.value + n * this.rate);
    this.emit();
  }

  /** Advance the double-rate window. */
  step(dt: number): void {
    if (this.boostT > 0) this.boostT = Math.max(0, this.boostT - dt);
  }

  kill(chain = 1): void {
    const S = TUNING.heroes.splash;
    this.add(S.perKill + Math.max(0, chain - 1) * S.perChain);
  }

  print(): void {
    this.add(TUNING.heroes.splash.perPrint);
  }

  /** A pair combo: charge, then open the double-rate window. */
  combo(): void {
    this.add(TUNING.heroes.splash.perCombo);
    this.boostT = TUNING.heroes.splash.comboBoostS;
  }

  /** Spend a full meter. Returns false (and keeps the charge) when not full. */
  consume(): boolean {
    if (!this.full) return false;
    this.value = 0;
    this.emit();
    return true;
  }

  reset(v = 0): void {
    this.value = Math.max(0, Math.min(1, v));
    this.boostT = 0;
    this.shown = -1;
    this.emit();
  }

  private emit(): void {
    const s = Math.round(this.value * 100);
    if (s === this.shown) return;
    this.shown = s;
    this.msg.pid = typeof this.pid === 'function' ? this.pid() : this.pid;
    this.msg.value = this.value;
    this.events?.emit('splash:changed', this.msg);
  }
}
