/**
 * Outline (A): inverted hull. Back faces pushed out along a *smoothed* normal in clip space so the
 * width is constant in screen pixels; works with SkinnedMesh / InstancedMesh (three picks the
 * right program variant). Width breathes with the 12 Hz line boil.
 */
import * as THREE from 'three';
import { INK_SHARED_FRAG } from '../materials/InkMaterial';
import { NOISE_GLSL } from '../noise';
import { REVEAL_GLSL } from '../reveal/revealMath';

const HULL_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
attribute vec3 hullNormal;
uniform float uHullPx, uBoilSeed, uDpr, uBoilAmt;
uniform vec2 uResolution;
uniform sampler2D uNoise;
varying vec3 vWPos;
void main() {
  vec3 objectNormal = hullNormal;
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 wp = vec4(transformed, 1.0);
  vec3 wn = objectNormal;
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
    wn = mat3(instanceMatrix) * wn;
  #endif
  wp = modelMatrix * wp;
  wn = normalize(mat3(modelMatrix) * wn);
  vWPos = wp.xyz;
  vec4 clip = projectionMatrix * viewMatrix * wp;
  vec4 clipN = projectionMatrix * viewMatrix * vec4(wn, 0.0);
  vec2 dir = clipN.xy;
  float l = length(dir);
  dir = l > 1e-5 ? dir / l : vec2(0.0);
  // brush pressure: slow along the contour, re-rolled at 12 Hz
  float boil = texture(uNoise, (position.xy * 2.7 + position.z * 1.9 + uBoilSeed * 4.1) / 32.0).g;
  float px = uHullPx * mix(1.0, 0.55 + boil * 0.9, uBoilAmt) * uDpr;
  clip.xy += dir * px * 2.0 / uResolution * clip.w;
  gl_Position = clip;
}
`;

const HULL_FRAG = /* glsl */ `
${INK_SHARED_FRAG}
${NOISE_GLSL}
#ifdef INK_REVEAL
${REVEAL_GLSL}
#endif
#ifdef INK_PRINTED
uniform float uPrinted;
#endif
varying vec3 vWPos;
void main() {
  float cls = 1.0;
  vec3 col = uInk;
  float F = 2.0;
  #ifdef INK_REVEAL
    F = revealField(vWPos.xz);
  #endif
  #ifdef INK_PRINTED
    float pn = inkFbmG(vWPos.xz * 1.7 + vWPos.y * 2.1);
    F = min(F, (uPrinted * 1.3 - 0.15 - pn) / 0.08 + 0.5);
  #endif
  {
    if (F <= 0.5) {
      // unrevealed: broken graphite contour
      vec2 fc = gl_FragCoord.xy / uDpr;
      if (inkNoiseB(fc * 0.09 + uBoilSeed * 2.0) < 0.42) discard;
      col = uPencilDark;
      cls = 0.0;
    }
  }
  gl_FragColor = vec4(col, cls);
}
`;

const smoothed = new WeakMap<THREE.BufferGeometry, true>();

/** Adds a `hullNormal` attribute: normals averaged over coincident positions (no cracks). */
export function ensureHullNormals(geo: THREE.BufferGeometry): void {
  if (smoothed.has(geo) || geo.getAttribute('hullNormal')) return;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  let nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!nrm) {
    geo.computeVertexNormals();
    nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  }
  const map = new Map<string, number[]>();
  const q = 1e4;
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`;
    let a = map.get(k);
    if (!a) {
      a = [0, 0, 0];
      map.set(k, a);
    }
    a[0]! += nrm.getX(i);
    a[1]! += nrm.getY(i);
    a[2]! += nrm.getZ(i);
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`;
    const a = map.get(k)!;
    const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
    out[i * 3] = a[0]! / l;
    out[i * 3 + 1] = a[1]! / l;
    out[i * 3 + 2] = a[2]! / l;
  }
  geo.setAttribute('hullNormal', new THREE.BufferAttribute(out, 3));
  smoothed.set(geo, true);
}

export function createHullMaterial(
  shared: Record<string, THREE.IUniform>,
  reveal: Record<string, THREE.IUniform>,
  widthPx: number,
  useReveal: boolean,
  printed: THREE.IUniform | null = null,
): THREE.ShaderMaterial {
  const defines: Record<string, string> = {};
  if (useReveal) defines.INK_REVEAL = '';
  if (printed) defines.INK_PRINTED = '';
  const mat = new THREE.ShaderMaterial({
    name: 'InkHull',
    uniforms: { ...shared, ...reveal, uHullPx: { value: widthPx }, uPrinted: printed ?? { value: 1 } },
    defines,
    vertexShader: HULL_VERT,
    fragmentShader: HULL_FRAG,
    side: THREE.BackSide,
  });
  mat.userData.inkHull = true;
  return mat;
}

/** True if any material on the mesh participates in reveal. */
function meshUsesReveal(m: THREE.Mesh): boolean {
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  return mats.some((x) => (x as THREE.ShaderMaterial).defines?.INK_REVEAL !== undefined);
}

/** The `uPrinted` uniform of a printed (sketch-object) InkMaterial, shared with its hull. */
function meshPrinted(m: THREE.Mesh): THREE.IUniform | null {
  const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.ShaderMaterial;
  return mat?.defines?.INK_PRINTED !== undefined ? (mat.uniforms.uPrinted ?? null) : null;
}

/**
 * Attach hull children to every mesh under `root`. Returns a disposer that removes them.
 * `getMaterial(reveal)` supplies a cached hull material.
 */
export function attachHulls(
  root: THREE.Object3D,
  getMaterial: (reveal: boolean, printed: THREE.IUniform | null) => THREE.Material,
): () => void {
  const added: THREE.Mesh[] = [];
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !m.userData.inkHullOf && !m.userData.noOutline) targets.push(m);
  });
  for (const m of targets) {
    ensureHullNormals(m.geometry);
    const mat = getMaterial(meshUsesReveal(m), meshPrinted(m));
    let hull: THREE.Mesh;
    const sk = m as THREE.SkinnedMesh;
    const im = m as THREE.InstancedMesh;
    if (sk.isSkinnedMesh) {
      const h = new THREE.SkinnedMesh(m.geometry, mat);
      h.bindMode = sk.bindMode;
      h.bind(sk.skeleton, sk.bindMatrix);
      hull = h;
    } else if (im.isInstancedMesh) {
      const h = new THREE.InstancedMesh(m.geometry, mat, im.count);
      h.instanceMatrix = im.instanceMatrix;
      h.onBeforeRender = () => {
        h.count = im.count;
      };
      hull = h;
    } else {
      hull = new THREE.Mesh(m.geometry, mat);
    }
    hull.name = `${m.name}:hull`;
    hull.userData.inkHullOf = m;
    hull.frustumCulled = m.frustumCulled;
    hull.renderOrder = m.renderOrder;
    hull.layers.mask = m.layers.mask;
    hull.castShadow = hull.receiveShadow = false;
    hull.raycast = () => {};
    m.add(hull);
    added.push(hull);
  }
  return () => {
    for (const h of added) h.removeFromParent();
    added.length = 0;
  };
}
