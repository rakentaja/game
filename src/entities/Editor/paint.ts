/**
 * "Blank Page, Reversed" (phase 3): a short memory of where the player's ink has been — crystal
 * trail samples and dash streaks — as a fixed ring of XZ circles. The Editor's body is only drawn
 * where this paint covers it, and weak points can only be hit once painted. The eraser wipes it.
 *
 * Pure logic (no three.js): the Editor copies `slots` into a vec4 uniform array every step.
 * Allocation-free after construction.
 */

export const PAINT_SLOTS = 24;

export class PaintSlot {
  x = 0;
  z = 0;
  r = 0;
  life = 0;
  age = 0;
  get alive(): boolean {
    return this.age < this.life;
  }
  /** 0..1 strength: quick ink-in, slow fade over the last 35 % of its life. */
  get strength(): number {
    if (!this.alive) return 0;
    const inK = Math.min(1, this.age / 0.25);
    const left = 1 - this.age / this.life;
    return inK * Math.min(1, left / 0.35);
  }
}

export class PaintTrail {
  readonly slots: PaintSlot[] = [];
  private lastX = Number.NaN;
  private lastZ = 0;
  private sampleT = 0;
  constructor(readonly size = PAINT_SLOTS) {
    for (let i = 0; i < size; i++) this.slots.push(new PaintSlot());
  }

  clear(): void {
    for (const s of this.slots) s.age = s.life = 0;
    this.lastX = Number.NaN;
    this.sampleT = 0;
  }

  /** Add one circle; recycles the weakest slot. */
  add(x: number, z: number, r: number, life: number): void {
    let best = this.slots[0]!;
    let bs = Number.POSITIVE_INFINITY;
    for (const s of this.slots) {
      const v = s.alive ? s.strength + (1 - s.age / s.life) : -1;
      if (v < bs) {
        bs = v;
        best = s;
      }
    }
    best.x = x;
    best.z = z;
    best.r = r;
    best.life = Math.max(0.05, life);
    best.age = 0;
  }

  /** A dash streak from a to b: a few overlapping circles along the segment. */
  addStreak(ax: number, az: number, bx: number, bz: number, r: number, life: number): void {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.min(4, Math.ceil(len / (r * 1.4))));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.add(ax + (bx - ax) * t, az + (bz - az) * t, r, life);
    }
  }

  /**
   * Crystal trail: call every step with the crystal's ground position. Adds a sample every
   * `every` s once it moved ≥ `minMove`; standing still refreshes the latest sample instead.
   */
  sample(x: number, z: number, r: number, life: number, dt: number, every: number, minMove: number): void {
    this.sampleT -= dt;
    if (this.sampleT > 0) return;
    this.sampleT = every;
    const moved = Number.isNaN(this.lastX) || Math.hypot(x - this.lastX, z - this.lastZ) >= minMove;
    if (moved) {
      this.add(x, z, r, life);
      this.lastX = x;
      this.lastZ = z;
      return;
    }
    // refresh the newest sample near here (keeps a still player's light painted)
    for (const s of this.slots)
      if (s.alive && Math.hypot(s.x - x, s.z - z) < minMove) {
        s.age = Math.min(s.age, 0.25);
        s.r = Math.max(s.r, r);
      }
  }

  step(dt: number): void {
    for (const s of this.slots) if (s.alive) s.age += dt;
  }

  /** Eraser lane: wipes every sample whose centre lies within hw of segment a-b. */
  erase(ax: number, az: number, bx: number, bz: number, hw: number): void {
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    for (const s of this.slots) {
      if (!s.alive) continue;
      let t = l2 > 1e-9 ? ((s.x - ax) * dx + (s.z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : Math.min(t, 1);
      const qx = ax + dx * t - s.x;
      const qz = az + dz * t - s.z;
      if (qx * qx + qz * qz <= hw * hw) s.age = s.life;
    }
  }

  /** 0..1 paint coverage at (x, z) — same falloff as the shader (minus its ragged noise). */
  at(x: number, z: number): number {
    let a = 0;
    for (const s of this.slots) {
      if (!s.alive) continue;
      const d = Math.hypot(x - s.x, z - s.z);
      const e = Math.min(1, Math.max(0, (s.r - d) / 0.8));
      const v = e * s.strength;
      if (v > a) a = v;
    }
    return a;
  }
}
