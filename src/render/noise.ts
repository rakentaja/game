/**
 * Shared tileable value-noise texture. Four independent channels:
 *   R — reveal edge (paper "wicking"), mirrored on the CPU by RevealSystem.revealAt
 *   G — band wobble / crumple
 *   B — stroke breaks (pencil dashes, hatch gaps)
 *   A — fine grain / spatter
 *
 * The GPU samples it with LINEAR + REPEAT; `sampleNoise` reproduces that filter exactly on the
 * CPU (texel centres at (i+0.5)/N, wrap), so CPU and shader read identical 8-bit data.
 * Lookups are in lattice units: one noise cell == 1.0, texture repeats every NOISE_PERIOD cells.
 */
import * as THREE from 'three';

export const NOISE_SIZE = 256;
export const NOISE_PERIOD = 32;
const CELL = NOISE_SIZE / NOISE_PERIOD;

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const P = NOISE_PERIOD;
  const x0 = ((ix % P) + P) % P;
  const y0 = ((iy % P) + P) % P;
  const x1 = (x0 + 1) % P;
  const y1 = (y0 + 1) % P;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** RGBA8 data, row-major, row 0 = v 0. Deterministic. */
export function buildNoiseData(): Uint8Array {
  const N = NOISE_SIZE;
  const out = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / CELL;
      const y = (j + 0.5) / CELL;
      const o = (j * N + i) * 4;
      out[o] = Math.round(valueNoise(x, y, 11) * 255);
      out[o + 1] = Math.round(valueNoise(x, y, 23) * 255);
      out[o + 2] = Math.round(valueNoise(x, y, 37) * 255);
      out[o + 3] = Math.round(valueNoise(x, y, 51) * 255);
    }
  }
  return out;
}

let cached: Uint8Array | null = null;
export function noiseData(): Uint8Array {
  if (!cached) cached = buildNoiseData();
  return cached;
}

/** Bilinear REPEAT sample of channel `ch` at lattice coords (qx, qy), 0..1. Mirrors GL LINEAR. */
export function sampleNoise(data: Uint8Array, qx: number, qy: number, ch: number): number {
  const N = NOISE_SIZE;
  const x = (qx / NOISE_PERIOD) * N - 0.5;
  const y = (qy / NOISE_PERIOD) * N - 0.5;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const x0 = ((ix % N) + N) % N;
  const y0 = ((iy % N) + N) % N;
  const x1 = (x0 + 1) % N;
  const y1 = (y0 + 1) % N;
  const a = data[(y0 * N + x0) * 4 + ch]!;
  const b = data[(y0 * N + x1) * 4 + ch]!;
  const c = data[(y1 * N + x0) * 4 + ch]!;
  const d = data[(y1 * N + x1) * 4 + ch]!;
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return (top + (bot - top) * fy) / 255;
}

let tex: THREE.DataTexture | null = null;
export function noiseTexture(): THREE.DataTexture {
  if (tex) return tex;
  tex = new THREE.DataTexture(noiseData(), NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** GLSL helpers matching the CPU functions above. Requires `uniform sampler2D uNoise;`. */
export const NOISE_GLSL = /* glsl */ `
#ifndef INK_NOISE
#define INK_NOISE
uniform sampler2D uNoise;
vec4 inkNoise4(vec2 q) { return texture2D(uNoise, q * ${(1 / NOISE_PERIOD).toFixed(8)}); }
float inkNoiseR(vec2 q) { return inkNoise4(q).r; }
float inkNoiseG(vec2 q) { return inkNoise4(q).g; }
float inkNoiseB(vec2 q) { return inkNoise4(q).b; }
float inkNoiseA(vec2 q) { return inkNoise4(q).a; }
float inkFbmG(vec2 q) {
  return inkNoiseG(q) * 0.57 + inkNoiseG(mat2(0.8, 0.6, -0.6, 0.8) * q * 2.03 + 5.3) * 0.29
    + inkNoiseG(mat2(0.8, 0.6, -0.6, 0.8) * q * 4.1 + 1.7) * 0.14;
}
float inkHash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + 32768);
  uint h = q.x * 0x27d4eb2du ^ q.y * 0x165667b1u;
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  h ^= h >> 16u;
  return float(h) / 4294967295.0;
}
#endif
`;
