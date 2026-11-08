/**
 * InkMaterial — the one toon/posterize material of INKWAKE (PLAN §2.2.1).
 * Own ShaderMaterial + three's chunk includes (skinning / instancing come from three's defines,
 * selected automatically per object type). Alpha carries the *ink class* read by the post pass:
 *   1.0 inked (line screen + ink edges) · 0.5 wet rim (ink edges, no screen) · 0.0 paper (pencil)
 */
import * as THREE from 'three';
import type { InkMaterialOptions } from '../../core/types';
import { PAL } from '../../data/palette';
import { NOISE_GLSL, NOISE_PERIOD } from '../noise';
import { REVEAL_GLSL } from '../reveal/revealMath';

export const INK_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
uniform float uBoilSeed;
#ifdef INK_CRUMPLE
uniform float uCrumple;
uniform sampler2D uNoise;
#endif
varying vec3 vWN;
varying vec3 vWPos;
varying vec2 vUv;
varying float vViewZ;
void main() {
  vUv = uv;
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #ifdef INK_CRUMPLE
    // Paper-ghost crumple: faceted fold noise, re-rolled with the line boil.
    vec3 cp = transformed * 3.1;
    vec2 cq = cp.xy + cp.z * 1.7 + uBoilSeed * 5.3;
    float c1 = texture(uNoise, cq / ${NOISE_PERIOD}.0).g;
    float c2 = texture(uNoise, (cq * 2.3 + 9.1) / ${NOISE_PERIOD}.0).b;
    transformed += normalize(objectNormal) * ((c1 - 0.5) + (c2 - 0.5) * 0.5) * uCrumple;
  #endif
  vec4 wp = vec4(transformed, 1.0);
  vec3 wn = objectNormal;
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
    wn = mat3(instanceMatrix) * wn;
  #endif
  wp = modelMatrix * wp;
  vWPos = wp.xyz;
  vWN = normalize(mat3(modelMatrix) * wn);
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const INK_SHARED_FRAG = /* glsl */ `
uniform vec3 uKeyDir, uCrystalPos;
uniform float uShadow, uTime, uFogNear, uFogFar, uBoilSeed, uDpr;
uniform vec3 uPaper, uInk, uPencil, uPencilDark, uGlowEdge, uGlowCore;
uniform float uRimPx, uWetPx, uSketchAmt;
`;

const INK_FRAG = /* glsl */ `
${INK_SHARED_FRAG}
uniform vec3 ramp0, ramp1, ramp2, ramp3;
uniform float keyAmt, glowAmt, albedoMix, uSketch;
#ifdef INK_MAP
uniform sampler2D map;
#endif
#ifdef INK_PRINTED
uniform float uPrinted;
#endif
${NOISE_GLSL}
#ifdef INK_REVEAL
${REVEAL_GLSL}
#endif
varying vec3 vWN;
varying vec3 vWPos;
varying vec2 vUv;
varying float vViewZ;

vec3 ramp4(float t) {
  vec3 c = ramp0;
  if (t > uShadow) c = ramp1;
  if (t > uShadow + 0.20) c = ramp2;
  if (t > uShadow + 0.48) c = ramp3;
  return c;
}

void main() {
  vec3 N = normalize(vWN) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 V = normalize(cameraPosition - vWPos);
  float alb = 0.75;
  #ifdef INK_MAP
    vec3 tx = texture2D(map, vUv).rgb;
    alb = mix(0.75, dot(tx, vec3(0.3, 0.59, 0.11)) * 1.25, albedoMix);
  #endif
  float streak = 0.0;
  float tuft = 0.0;
  #ifdef INK_GROUND
    float g = inkFbmG(vWPos.xz * vec2(6.0, 2.2));
    streak = smoothstep(0.55, 0.75, inkNoiseB(vWPos.xz * vec2(40.0, 9.0)));
    // sketch-side grass: sparse tufts clustered in patches, not an all-over texture
    tuft = smoothstep(0.7, 0.8, inkNoiseB(vWPos.xz * vec2(34.0, 7.0) + 3.1)) * smoothstep(0.55, 0.75, inkNoiseA(vWPos.xz * 0.45));
    alb = 0.85 - smoothstep(0.5, 0.8, g) * 0.52 - streak * 0.22;
  #endif
  float key = clamp(dot(N, normalize(uKeyDir)) * 0.6 + 0.4, 0.0, 1.0) * keyAmt;
  vec3 L = uCrystalPos - vWPos;
  float d2 = dot(L, L);
  float pl = max(dot(N, normalize(L)), 0.0) * glowAmt / (1.0 + d2 * 1.6);
  float lit = alb * (0.18 + key + pl);
  float fog = smoothstep(uFogNear, uFogFar, vViewZ);
  float tone = lit * (1.0 - fog);
  tone += (inkFbmG(vWPos.xy * 5.0 + vWPos.z * 3.0 + uBoilSeed * 7.31) - 0.5) * 0.07;

  // ── reveal / print field (pre-smoothstep, >0.5 = inked) ──
  float F = 2.0;
  #ifdef INK_REVEAL
    F = revealField(vWPos.xz);
  #endif
  bool unprinted = false;
  #ifdef INK_PRINTED
    float pn = inkFbmG(vWPos.xz * 1.7 + vWPos.y * 2.1);
    float Fp = (uPrinted * 1.3 - 0.15 - pn) / 0.08 + 0.5;
    unprinted = Fp < 0.5;
    F = min(F, Fp);
  #endif
  float fw = max(fwidth(F), 1e-4);
  float dpx = (F - 0.5) / fw; // screen pixels from the ink front, + inside

  // ── inked: posterized ramp, darker while wet near the front ──
  float wet = 1.0 - smoothstep(0.5, 1.15, F);
  vec3 inkCol = ramp4(tone - wet * 0.2);

  // ── paper: pencil sketch (screen-space hatch, contour, scratchy ground) ──
  vec2 fc = gl_FragCoord.xy / uDpr;
  float along = dot(fc, vec2(0.7071, -0.7071));
  float across = dot(fc, vec2(0.7071, 0.7071));
  float strokes = step(0.38, inkNoiseB(vec2(along * 0.045, floor(across / 4.5) * 3.7) + uBoilSeed * 3.1));
  #ifdef INK_GROUND
    float dark = 1.0 - smoothstep(0.05, 0.34, lit);
  #else
    float dark = 1.0 - smoothstep(0.12, 0.62, lit);
  #endif
  if (unprinted) dark = max(dark, 0.42);
  float h1 = abs(fract(across / 4.5 + (inkNoiseB(fc * 0.03 + uBoilSeed) - 0.5) * 0.5) - 0.5) * 2.0;
  float hatch = (1.0 - smoothstep(dark * 0.55, dark * 0.55 + 0.22, h1)) * strokes * step(0.06, dark);
  float dark2 = 1.0 - smoothstep(0.04, 0.26, lit);
  float h2 = abs(fract(along / 5.2) - 0.5) * 2.0;
  float hatch2 = (1.0 - smoothstep(dark2 * 0.5, dark2 * 0.5 + 0.22, h2)) * step(0.06, dark2);
  float rimv = 1.0 - abs(dot(N, V));
  float contour = smoothstep(0.7, 0.86, rimv) * strokes;
  float sk = uSketch * uSketchAmt * (1.0 - fog * 0.85);
  vec3 paperCol = uPaper;
  paperCol = mix(paperCol, uPencil, step(0.5, clamp(hatch + hatch2 + tuft, 0.0, 1.0) * sk));
  float contourK = unprinted ? 1.0 : 0.85;
  paperCol = mix(paperCol, uPencilDark, step(0.5, contour * sk * contourK));

  // spatter: ink droplets thrown just past the front (world cells, stable under camera motion)
  vec2 cell = vWPos.xz * 7.0;
  float hc = inkHash(cell);
  float drop = step(length(fract(cell) - 0.5), (hc - 0.88) * 2.6) * step(0.88, hc);
  bool spat = drop > 0.5 && F > 0.5 - (hc - 0.88) * 3.2 && F < 0.5 && !unprinted;

  vec3 col;
  float cls;
  if (dpx > 0.0 || spat) {
    col = inkCol;
    cls = 1.0;
    if (spat) col = uInk;
    if (dpx > 0.0 && dpx < uWetPx) { col = uInk; cls = 0.5; }
  } else {
    col = paperCol;
    cls = 0.0;
    if (dpx > -uRimPx && !unprinted) {
      float hot = step(0.68, inkNoiseA(vWPos.xz * 2.3 + uBoilSeed * 2.7));
      col = mix(uGlowEdge, uGlowCore, hot);
      cls = 0.5;
    }
  }
  gl_FragColor = vec4(col, cls);
}
`;

/** Shared look uniforms created once by the renderer (`shared`). */
export function createSharedUniforms(): Record<string, THREE.IUniform> {
  return {
    uTime: { value: 0 },
    uBoilSeed: { value: 0 },
    uKeyDir: { value: new THREE.Vector3(-0.5, 0.75, 0.45).normalize() },
    uCrystalPos: { value: new THREE.Vector3(0, 2, 0) },
    uShadow: { value: 0.3 },
    uFogNear: { value: 9 },
    uFogFar: { value: 26 },
    uDpr: { value: 1 },
    uPaper: { value: new THREE.Color(PAL.paper) },
    uInk: { value: new THREE.Color(PAL.ink) },
    uPencil: { value: new THREE.Color(PAL.ghost[1]) },
    uPencilDark: { value: new THREE.Color(PAL.staff[3]) },
    uGlowEdge: { value: new THREE.Color(PAL.glowEdge) },
    uGlowCore: { value: new THREE.Color(PAL.glowCore) },
    uRimPx: { value: 1.6 },
    uWetPx: { value: 2.5 },
    uSketchAmt: { value: 1 },
  };
}

export interface InkMaterialExtra {
  /** Strength of the pencil sketch while unrevealed (0 hides it, e.g. ghosts). Default 1. */
  sketch?: number;
}

export function createInkMaterial(
  shared: Record<string, THREE.IUniform>,
  reveal: Record<string, THREE.IUniform>,
  rampColors: Record<string, readonly string[]>,
  opts: InkMaterialOptions & InkMaterialExtra,
): THREE.ShaderMaterial {
  const ramp = rampColors[opts.ramp]!;
  const useReveal = opts.reveal ?? true;
  const defines: Record<string, string> = {};
  if (useReveal) defines.INK_REVEAL = '';
  if (opts.ground) defines.INK_GROUND = '';
  if (opts.map) defines.INK_MAP = '';
  if (opts.crumple !== undefined) defines.INK_CRUMPLE = '';
  if (opts.printed !== undefined) defines.INK_PRINTED = '';
  const uniforms: Record<string, THREE.IUniform> = {
    ...shared,
    ...reveal,
    ramp0: { value: new THREE.Color(ramp[0]) },
    ramp1: { value: new THREE.Color(ramp[1]) },
    ramp2: { value: new THREE.Color(ramp[2]) },
    ramp3: { value: new THREE.Color(ramp[3]) },
    keyAmt: { value: opts.keyAmt ?? 0.55 },
    glowAmt: { value: opts.glowAmt ?? 1.3 },
    albedoMix: { value: opts.albedoMix ?? 0.6 },
    map: { value: opts.map ?? null },
    uCrumple: { value: opts.crumple ?? 0 },
    uPrinted: { value: opts.printed ?? 1 },
    uSketch: { value: opts.sketch ?? 1 },
  };
  if (!reveal.uNoise) uniforms.uNoise = shared.uNoise!;
  const mat = new THREE.ShaderMaterial({
    name: `Ink:${opts.ramp}`,
    uniforms,
    defines,
    vertexShader: INK_VERT,
    fragmentShader: INK_FRAG,
    side: opts.side ?? THREE.DoubleSide,
  });
  mat.userData.ink = true;
  return mat;
}
