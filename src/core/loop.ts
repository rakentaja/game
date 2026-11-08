/**
 * Fixed-step simulation (TUNING.sim.hz) + variable render with interpolation alpha.
 * `step(dt)` is deterministic sim; `render(alpha, frameDt)` draws.
 */
export interface LoopCallbacks {
  step(dt: number): void;
  render(alpha: number, frameDt: number): void;
}

export class FixedLoop {
  private acc = 0;
  private last = -1;
  private raf = 0;
  running = false;
  /** Global time scale (hit-stop, panel cuts set this to 0). */
  timeScale = 1;
  simTime = 0;

  constructor(
    private cb: LoopCallbacks,
    private hz = 60,
    private maxSteps = 5,
  ) {}

  get stepDt(): number {
    return 1 / this.hz;
  }

  /** Advance by a real frame delta (seconds). Exposed for tests and the bench harness. */
  tick(frameDt: number): number {
    const dt = 1 / this.hz;
    const clamped = Math.min(frameDt, dt * this.maxSteps);
    this.acc += clamped * this.timeScale;
    let steps = 0;
    while (this.acc >= dt && steps < this.maxSteps) {
      this.cb.step(dt);
      this.simTime += dt;
      this.acc -= dt;
      steps++;
    }
    if (steps === this.maxSteps) this.acc = 0;
    this.cb.render(this.acc / dt, frameDt);
    return steps;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = -1;
    const frame = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(frame);
      const now = t / 1000;
      const frameDt = this.last < 0 ? 0 : now - this.last;
      this.last = now;
      this.tick(frameDt);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
