/**
 * Splash meter (the ultimate). Pure: charged by kills, prints and combos; kill chains add a little
 * extra. Emits `splash:changed` (0..1) when the shown value moves by ≥ 1 % or hits full / empty.
 */
import type { EventBus, GameEvents } from '../../core/events';
import type { PlayerSlot } from '../../core/types';
import { TUNING } from '../../data/tuning';

export class SplashMeter {
  value = 0;
  private shown = -1;
  private msg = { pid: 0 as PlayerSlot, value: 0 };

  constructor(
    private events: EventBus<GameEvents> | null,
    private pid: PlayerSlot = 0,
  ) {}

  get full(): boolean {
    return this.value >= 1 - 1e-6;
  }

  add(n: number): void {
    if (!(n > 0)) return;
    this.value = Math.min(1, this.value + n);
    this.emit();
  }

  kill(chain = 1): void {
    const S = TUNING.heroes.splash;
    this.add(S.perKill + Math.max(0, chain - 1) * S.perChain);
  }

  print(): void {
    this.add(TUNING.heroes.splash.perPrint);
  }

  combo(): void {
    this.add(TUNING.heroes.splash.perCombo);
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
    this.shown = -1;
    this.emit();
  }

  private emit(): void {
    const s = Math.round(this.value * 100);
    if (s === this.shown) return;
    this.shown = s;
    this.msg.pid = this.pid;
    this.msg.value = this.value;
    this.events?.emit('splash:changed', this.msg);
  }
}
