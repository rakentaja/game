/**
 * GPU ↔ CPU reveal-mirror probe (dev / e2e only). Evaluates the *shader* `revealField` at N world
 * points (one GL point per pixel of an N×1 RGBA8 target, 16-bit encoded) and returns the values,
 * so tests can assert RevealSystem.fieldAt matches what players see.
 */
import * as THREE from 'three';
import type { RevealSystem } from './RevealSystem';
import { REVEAL_GLSL } from './revealMath';

const LO = -2;
const SPAN = 5;

export function probeRevealGPU(
  renderer: THREE.WebGLRenderer,
  reveal: RevealSystem,
  xz: Float32Array,
): Float32Array {
  const n = xz.length / 2;
  const idx = new Float32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1));
  geo.setAttribute('aXZ', new THREE.BufferAttribute(xz, 2));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...reveal.uniforms, uN: { value: n } },
    vertexShader: /* glsl */ `
      attribute float aIdx; attribute vec2 aXZ; uniform float uN; varying vec2 vXZ;
      void main() { vXZ = aXZ; gl_PointSize = 1.0; gl_Position = vec4((aIdx + 0.5) / uN * 2.0 - 1.0, 0.0, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      ${REVEAL_GLSL}
      varying vec2 vXZ;
      void main() {
        float v = clamp((revealField(vXZ) - (${LO.toFixed(1)})) / ${SPAN.toFixed(1)}, 0.0, 1.0) * 65535.0;
        float hi = floor(v / 256.0);
        gl_FragColor = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(pts);
  const rt = new THREE.WebGLRenderTarget(n, 1, { depthBuffer: false, generateMipmaps: false });
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, new THREE.Camera());
  const px = new Uint8Array(n * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, n, 1, px);
  renderer.setRenderTarget(prev);
  rt.dispose();
  geo.dispose();
  mat.dispose();
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = LO + ((px[i * 4]! * 256 + px[i * 4 + 1]!) / 65535) * SPAN;
  return out;
}
