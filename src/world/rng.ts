/** Deterministic PRNG (mulberry32). Every procedural placement derives from LevelDef.seed. */
export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const range = (r: Rng, a: number, b: number): number => a + (b - a) * r();

/** Hash-based value noise in 2D, deterministic for a seed. Range ~[0,1]. */
export function valueNoise2(seed: number): (x: number, z: number) => number {
  const h = (ix: number, iz: number): number => {
    let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  return (x, z) => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    let fx = x - ix;
    let fz = z - iz;
    fx = fx * fx * (3 - 2 * fx);
    fz = fz * fz * (3 - 2 * fz);
    const a = h(ix, iz);
    const b = h(ix + 1, iz);
    const c = h(ix, iz + 1);
    const d = h(ix + 1, iz + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  };
}

export function fbm2(noise: (x: number, z: number) => number, x: number, z: number, oct = 4): number {
  let amp = 0.5;
  let sum = 0;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise(x * f, z * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return sum / (1 - 0.5 ** oct);
}
