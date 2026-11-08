import type { LevelDef } from '../core/types';
import { TUNING } from '../data/tuning';
import { makeHit, type PathSampler, type Rect } from './path';
import { fbm2, valueNoise2 } from './rng';

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Signed distance (outside > 0) from a point to an axis-aligned rect. */
export function rectSdf(r: Rect, x: number, z: number): number {
  const cx = (r[0] + r[2]) * 0.5;
  const cz = (r[1] + r[3]) * 0.5;
  const dx = Math.abs(x - cx) - (r[2] - r[0]) * 0.5;
  const dz = Math.abs(z - cz) - (r[3] - r[1]) * 0.5;
  const ox = Math.max(dx, 0);
  const oz = Math.max(dz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(dx, dz), 0);
}

export const CHASM_DEPTH = 2.8;

/**
 * Ground heights on a regular grid. `sample` interpolates over the exact triangles the ground
 * mesh is built from, so feet never float or sink.
 */
export class Heightfield {
  readonly x0: number;
  readonly z0: number;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  readonly h: Float32Array;

  constructor(x0: number, z0: number, cell: number, nx: number, nz: number, h: Float32Array) {
    this.x0 = x0;
    this.z0 = z0;
    this.cell = cell;
    this.nx = nx;
    this.nz = nz;
    this.h = h;
  }

  get maxX(): number {
    return this.x0 + (this.nx - 1) * this.cell;
  }
  get maxZ(): number {
    return this.z0 + (this.nz - 1) * this.cell;
  }

  sample(x: number, z: number): number {
    let fx = (x - this.x0) / this.cell;
    let fz = (z - this.z0) / this.cell;
    const mx = this.nx - 1.0001;
    const mz = this.nz - 1.0001;
    fx = Math.min(mx, Math.max(0, fx));
    fz = Math.min(mz, Math.max(0, fz));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const k = j * this.nx + i;
    const a = this.h[k]!;
    const b = this.h[k + 1]!;
    const c = this.h[k + this.nx]!;
    const d = this.h[k + this.nx + 1]!;
    // triangles (a,c,b) and (c,d,b) — split along the b–c diagonal
    if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
    return d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }
}

/** Distance from (x,z) to the edge of the open walkable shape (path ∪ clearings); <0 inside. */
export function makeOpenDistance(def: LevelDef, path: PathSampler): (x: number, z: number) => number {
  const hit = makeHit();
  return (x, z) => {
    path.nearest(x, z, hit);
    let d = hit.dist - hit.halfW;
    for (const c of def.clearings) d = Math.min(d, Math.hypot(x - c[0], z - c[1]) - c[2]);
    return d;
  };
}

export function levelBounds(def: LevelDef, path: PathSampler, margin: number): Rect {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < path.count; i++) {
    minX = Math.min(minX, path.xs[i]!);
    maxX = Math.max(maxX, path.xs[i]!);
    minZ = Math.min(minZ, path.zs[i]!);
    maxZ = Math.max(maxZ, path.zs[i]!);
  }
  for (const c of def.clearings) {
    minX = Math.min(minX, c[0] - c[2]);
    maxX = Math.max(maxX, c[0] + c[2]);
    minZ = Math.min(minZ, c[1] - c[2]);
    maxZ = Math.max(maxZ, c[1] + c[2]);
  }
  return [minX - margin, minZ - margin, maxX + margin, maxZ + margin];
}

export function buildHeightfield(def: LevelDef, path: PathSampler): Heightfield {
  const W = TUNING.world;
  const cell = W.groundCell;
  const b = levelBounds(def, path, W.groundMargin);
  const nx = Math.ceil((b[2] - b[0]) / cell) + 1;
  const nz = Math.ceil((b[3] - b[1]) / cell) + 1;
  const h = new Float32Array(nx * nz);
  const noise = valueNoise2(def.seed * 31 + 7);
  const amp = def.terrain?.amp ?? 0.35;
  const bank = def.terrain?.bank ?? 1.8;
  const openD = makeOpenDistance(def, path);
  const chasms = (def.voids ?? []).filter((v) => v.kind === 'chasm');
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = b[0] + i * cell;
      const z = b[1] + j * cell;
      const d = openD(x, z);
      const n = fbm2(noise, x * 0.07, z * 0.07, 4);
      let y = (n - 0.5) * 2 * amp * (d < 0 ? 0.45 : 1);
      // banks rise away from the path: the forest floor wraps the walk like a hollow
      y += bank * smooth(0.4, 10, d) * (0.55 + 0.9 * fbm2(noise, x * 0.045 + 13, z * 0.045 - 5, 3));
      for (const p of def.terrain?.plateaus ?? []) {
        const sd = rectSdf(p.rect, x, z);
        y += p.h * (1 - smooth(0, p.falloff, sd));
      }
      for (const c of chasms) {
        const sd = rectSdf(c.rect, x, z);
        y -= CHASM_DEPTH * (1 - smooth(-0.9, 0.05, sd));
      }
      h[j * nx + i] = y;
    }
  }
  return new Heightfield(b[0], b[1], cell, nx, nz, h);
}
