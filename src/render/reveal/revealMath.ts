/**
 * Reveal mask math, shared verbatim by the CPU mirror (RevealSystem.revealAt) and the GLSL in
 * REVEAL_GLSL below. Change both together; tests/unit/reveal.test.ts pins the behaviour.
 *
 * Model: every ink source contributes a *field* value t (pre-smoothstep, unclamped):
 *   circle   t = (r - |p - c| - n) / edge                (1 at edge metres inside, 0 at r - n)
 *   history  t = 3 v - 1 - n / edge                      (v ∈ 0..1 stamped, see stampValue)
 * n is the paper's local "absorbency" — one fbm value per world point, identical for every
 * source, so overlapping circles merge with one coherent ragged edge.
 *   F = max(primary, (1 - blank) · max(sources, history)) - 4 · erase
 *   mask = smoothstep01(F);  revealed ⇔ F > 0.5
 */
import { NOISE_GLSL, sampleNoise } from '../noise';

/** Rotation used between fbm octaves (column-major in GLSL: mat2(0.8, 0.6, -0.6, 0.8)). */
const RC = 0.8;
const RS = 0.6;
const OCT_SCALE = 2.03;
const OCT_OFF_X = 13.7;
const OCT_OFF_Y = 7.1;
const DRIFT_X = 0.71;
const DRIFT_Y = 0.37;
const OCTAVES = 4;
const AMP_SUM = 0.9375;

export interface RevealNoiseParams {
  scale: number;
  amp: number;
  seep: number;
  time: number;
  /** 0..1 — how fast the primary radius is currently growing. */
  growth: number;
  fingers: number;
}

/** fbm of noise channel R, 0..1. */
export function revealFbm(data: Uint8Array, x: number, z: number, p: RevealNoiseParams): number {
  let qx = x * p.scale + p.time * p.seep * DRIFT_X;
  let qy = z * p.scale + p.time * p.seep * DRIFT_Y;
  let a = 0.5;
  let f = 0;
  for (let i = 0; i < OCTAVES; i++) {
    f += a * sampleNoise(data, qx, qy, 0);
    const nx = (RC * qx - RS * qy) * OCT_SCALE + OCT_OFF_X;
    const ny = (RS * qx + RC * qy) * OCT_SCALE + OCT_OFF_Y;
    qx = nx;
    qy = ny;
    a *= 0.5;
  }
  return f / AMP_SUM;
}

/** Edge displacement in metres (positive pushes the edge inwards). */
export function revealOffset(data: Uint8Array, x: number, z: number, p: RevealNoiseParams): number {
  return (revealFbm(data, x, z, p) - 0.5) * 2 * p.amp * (1 + p.fingers * p.growth);
}

export function circleField(dx: number, dz: number, r: number, n: number, edge: number): number {
  return (r - Math.sqrt(dx * dx + dz * dz) - n) / edge;
}

export function historyField(v: number, n: number, edge: number): number {
  return 3 * v - 1 - n / edge;
}

/** Value stamped into the history map for a texel at distance d from a circle of radius r. */
export function stampValue(d: number, r: number, edge: number): number {
  const v = ((r - d) / edge + 1) / 3;
  return v < 0 ? 0 : Math.min(v, 1);
}

export function combineField(primary: number, secondary: number, blank: number, erase: number): number {
  return Math.max(primary, (1 - blank) * secondary + blank * -1) - 4 * erase;
}

export function smooth01(t: number): number {
  const x = t < 0 ? 0 : Math.min(t, 1);
  return x * x * (3 - 2 * x);
}

export const MAX_SOURCES_GLSL = 16;

/** Fragment-side reveal chunk. Needs `vec3 vWPos` (or any world XZ) passed by the caller. */
export const REVEAL_GLSL = /* glsl */ `
${NOISE_GLSL}
#ifndef INK_REVEAL_CHUNK
#define INK_REVEAL_CHUNK
uniform vec3 uRevealCenter;
uniform float uRevealRadius, uRevealEdge, uRevealAmp, uRevealScale, uRevealTime, uRevealSeep;
uniform float uRevealGrowth, uRevealFingers, uRevealBlank;
uniform sampler2D uRevealHist;
uniform vec4 uRevealHistRect; // minX, minZ, 1/size, enabled
uniform vec4 uRevealSources[${MAX_SOURCES_GLSL}];
uniform int uRevealSourceCount;

float revealFbm(vec2 p) {
  vec2 q = p * uRevealScale + uRevealTime * uRevealSeep * vec2(${DRIFT_X}, ${DRIFT_Y});
  float a = 0.5, f = 0.0;
  for (int i = 0; i < ${OCTAVES}; i++) {
    f += a * inkNoiseR(q);
    q = mat2(${RC}, ${RS}, -${RS}, ${RC}) * q * ${OCT_SCALE} + vec2(${OCT_OFF_X}, ${OCT_OFF_Y});
    a *= 0.5;
  }
  return f / ${AMP_SUM};
}

/** Pre-smoothstep reveal field at world xz. >0.5 = revealed. */
float revealField(vec2 p) {
  float n = (revealFbm(p) - 0.5) * 2.0 * uRevealAmp * (1.0 + uRevealFingers * uRevealGrowth);
  float prim = (uRevealRadius - length(p - uRevealCenter.xz) - n) / uRevealEdge;
  float sec = -1.0;
  for (int i = 0; i < ${MAX_SOURCES_GLSL}; i++) {
    if (i >= uRevealSourceCount) break;
    vec4 s = uRevealSources[i];
    sec = max(sec, (s.z - length(p - s.xy) - n) / uRevealEdge);
  }
  float erase = 0.0;
  if (uRevealHistRect.w > 0.5) {
    vec2 huv = (p - uRevealHistRect.xy) * uRevealHistRect.z;
    vec2 h = texture2D(uRevealHist, huv).rg;
    sec = max(sec, 3.0 * h.r - 1.0 - n / uRevealEdge);
    erase = h.g;
  }
  return max(prim, (1.0 - uRevealBlank) * sec + uRevealBlank * -1.0) - 4.0 * erase;
}
#endif
`;
