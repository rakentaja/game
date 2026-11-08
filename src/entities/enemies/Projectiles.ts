/** Fixed pool of scribbler pencil strokes, struct-of-arrays, zero allocation after construction. */
export class Projectiles {
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly dx: Float32Array;
  readonly dz: Float32Array;
  readonly life: Float32Array;
  readonly age: Float32Array;
  readonly active: Uint8Array;
  readonly seed: Float32Array;

  constructor(readonly capacity: number) {
    this.x = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.dx = new Float32Array(capacity);
    this.dz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.active = new Uint8Array(capacity);
    this.seed = new Float32Array(capacity);
  }

  /** Returns slot index or -1 if the pool is full. */
  fire(
    x: number,
    z: number,
    dx: number,
    dz: number,
    life: number,
    seed: number,
    limit = this.capacity,
  ): number {
    const n = Math.min(limit, this.capacity);
    for (let i = 0; i < n; i++) {
      if (this.active[i]) continue;
      this.active[i] = 1;
      this.x[i] = x;
      this.z[i] = z;
      this.dx[i] = dx;
      this.dz[i] = dz;
      this.life[i] = life;
      this.age[i] = 0;
      this.seed[i] = seed;
      return i;
    }
    return -1;
  }

  kill(i: number): void {
    this.active[i] = 0;
  }

  clear(): void {
    this.active.fill(0);
  }
}
