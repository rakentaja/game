/**
 * Pure action-side gesture classifier (PLAN §6). One instance per pointer; no DOM, no allocs.
 *
 *  tap   : released before `tapMaxMs` having travelled less than `tapMaxPx`
 *  hold  : still down after `holdMinMs` and steady (or after `swipeMaxMs` whatever the drift)
 *  swipe : travelled `swipeMinPx` within `swipeMaxMs` of touch-down. While holding, a quick flick
 *          (same distance inside a sliding `swipeMaxMs` window) also swipes — dash without
 *          dropping the crystal.
 *
 * Times are milliseconds, positions CSS pixels (y down). Output goes to `sink(kind, dx, dy)`;
 * for swipes (dx, dy) is the unit direction, otherwise zero.
 */
export type GestureKind = 'tap' | 'holdStart' | 'holdEnd' | 'swipe' | 'cancel';
export type GesturePhase = 'idle' | 'pending' | 'holding' | 'swiped';

export interface GestureConfig {
  tapMaxMs: number;
  tapMaxPx: number;
  holdMinMs: number;
  swipeMinPx: number;
  swipeMaxMs: number;
}

export type GestureSink = (kind: GestureKind, dx: number, dy: number) => void;

const RING = 16;

export class GestureClassifier {
  phase: GesturePhase = 'idle';
  /** Diagnostics for the debug overlay. */
  t0 = 0;
  x0 = 0;
  y0 = 0;
  maxTravel = 0;
  lastKind: GestureKind | null = null;

  private ts = new Float64Array(RING);
  private xs = new Float32Array(RING);
  private ys = new Float32Array(RING);
  private head = 0;
  private count = 0;

  constructor(
    private cfg: GestureConfig,
    private sink: GestureSink,
  ) {}

  get active(): boolean {
    return this.phase !== 'idle';
  }

  down(t: number, x: number, y: number): void {
    this.phase = 'pending';
    this.t0 = t;
    this.x0 = x;
    this.y0 = y;
    this.maxTravel = 0;
    this.count = 0;
    this.push(t, x, y);
  }

  move(t: number, x: number, y: number): void {
    if (this.phase === 'idle') return;
    this.update(t);
    this.push(t, x, y);
    const dx = x - this.x0;
    const dy = y - this.y0;
    const travel = Math.hypot(dx, dy);
    if (travel > this.maxTravel) this.maxTravel = travel;
    const c = this.cfg;
    if (this.phase === 'pending') {
      if (travel >= c.swipeMinPx && t - this.t0 <= c.swipeMaxMs) {
        this.phase = 'swiped';
        this.emit('swipe', dx / travel, dy / travel);
      }
    } else if (this.phase === 'holding') {
      // Flick while holding: oldest sample still inside the window is the anchor.
      const n = this.count;
      for (let i = n - 1; i >= 1; i--) {
        const k = (this.head - 1 - i + RING * 2) % RING;
        if (t - this.ts[k]! > c.swipeMaxMs) continue;
        const fx = x - this.xs[k]!;
        const fy = y - this.ys[k]!;
        const d = Math.hypot(fx, fy);
        if (d >= c.swipeMinPx) {
          this.emit('swipe', fx / d, fy / d);
          // Re-arm: the next flick must be measured from here.
          this.count = 0;
          this.push(t, x, y);
        }
        break;
      }
    }
  }

  /** Call every frame with the current time so holds start without pointer movement. */
  update(t: number): void {
    if (this.phase !== 'pending') return;
    const dt = t - this.t0;
    const c = this.cfg;
    if ((dt >= c.holdMinMs && this.maxTravel < c.tapMaxPx) || dt > c.swipeMaxMs) {
      this.phase = 'holding';
      this.emit('holdStart', 0, 0);
    }
  }

  up(t: number, x: number, y: number): void {
    if (this.phase === 'idle') return;
    if (this.phase === 'pending') this.move(t, x, y);
    const c = this.cfg;
    switch (this.phase) {
      case 'pending':
        if (t - this.t0 < c.tapMaxMs && this.maxTravel < c.tapMaxPx) this.emit('tap', 0, 0);
        else this.emit('cancel', 0, 0);
        break;
      case 'holding':
        this.emit('holdEnd', 0, 0);
        break;
      default:
        break;
    }
    this.phase = 'idle';
  }

  /** pointercancel / blur / disable. */
  cancel(): void {
    if (this.phase === 'holding') this.emit('holdEnd', 0, 0);
    else if (this.phase === 'pending') this.emit('cancel', 0, 0);
    this.phase = 'idle';
  }

  private push(t: number, x: number, y: number): void {
    this.ts[this.head] = t;
    this.xs[this.head] = x;
    this.ys[this.head] = y;
    this.head = (this.head + 1) % RING;
    if (this.count < RING) this.count++;
  }

  private emit(kind: GestureKind, dx: number, dy: number): void {
    this.lastKind = kind;
    this.sink(kind, dx, dy);
  }
}
