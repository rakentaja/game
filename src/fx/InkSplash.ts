/**
 * Ink splash: instanced camera-facing quads; each draws an SDF metaball blob (main splat + flung
 * droplets) whose life is stepped at 12 fps — a hand-drawn flipbook, no textures.
 */
import * as THREE from 'three';
import { PAL } from '../data/palette';

const VERT = /* glsl */ `
attribute vec4 aData; // birth, life, seed, size
uniform float uTime, uBoilAmt;
varying vec2 vP;
varying float vK;
varying float vSeed;
void main() {
  vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float age = uTime - aData.x;
  float stepped = mix(age, floor(age * 12.0) / 12.0, uBoilAmt);
  vK = stepped / max(aData.y, 1e-3);
  vSeed = aData.z;
  vP = position.xy * 2.0;
  float alive = step(0.0, age) * step(vK, 1.0);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  mv.xy += position.xy * aData.w * alive;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uInk, uWet, uRed;
varying vec2 vP;
varying float vK;
varying float vSeed;
float h1(float n) { return fract(sin(n * 91.345 + vSeed * 17.13) * 43758.5453); }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
void main() {
  if (vK < 0.0 || vK > 1.0) discard;
  float k = vK;
  float grow = 1.0 - (1.0 - k) * (1.0 - k) * (1.0 - k);
  float ang = atan(vP.y, vP.x);
  float wob = sin(ang * 5.0 + vSeed * 6.28) * 0.08 + sin(ang * 9.0 - vSeed * 3.1) * 0.05;
  float d = length(vP) - (0.22 + 0.2 * grow) * (1.0 + wob);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float a = h1(fi) * 6.2832;
    float dist = (0.25 + h1(fi + 9.0) * 0.45) * (0.35 + 0.95 * grow);
    vec2 c = vec2(cos(a), sin(a)) * dist - vec2(0.0, k * k * 0.18);
    float r = (0.05 + h1(fi + 4.0) * 0.07) * (1.0 - k * 0.85);
    d = smin(d, length(vP - c) - r, 0.09 * (1.0 - k));
  }
  d += k * k * k * 0.32; // dries / soaks in
  if (d > 0.0) discard;
  vec3 col = uInk;
  if (k < 0.2 && d > -0.035) col = uWet;
  else if (d < -0.18 && k < 0.5) col = uRed;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class InkSplash {
  readonly mesh: THREE.InstancedMesh;
  private readonly data: THREE.InstancedBufferAttribute;
  private next = 0;
  private readonly m = new THREE.Matrix4();

  constructor(
    private readonly shared: Record<string, THREE.IUniform>,
    readonly pool: number,
  ) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.data = new THREE.InstancedBufferAttribute(new Float32Array(pool * 4), 4);
    for (let i = 0; i < pool; i++) this.data.setXYZW(i, -1e6, 0.001, 0, 0);
    this.data.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aData', this.data);
    const mat = new THREE.ShaderMaterial({
      name: 'InkSplash',
      uniforms: {
        uTime: shared.uTime!,
        uBoilAmt: shared.uBoilAmt!,
        uInk: { value: new THREE.Color(PAL.ink) },
        uWet: { value: new THREE.Color(PAL.glowEdge) },
        uRed: { value: new THREE.Color(PAL.red[1]) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, pool);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.userData.noOutline = true;
    this.mesh.name = 'fx:inkSplash';
  }

  /** Spawn one splat at (x,y,z), world size in metres. */
  spawn(x: number, y: number, z: number, size: number, life: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.pool;
    this.m.makeTranslation(x, y, z);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
    const now = this.shared.uTime!.value as number;
    this.data.setXYZW(i, now, life, (i * 0.61803 + now * 3.7) % 1, size);
    this.data.needsUpdate = true;
  }

  /** A burst: one big splat + a few satellites. */
  burst(x: number, y: number, z: number, size: number, life: number, count = 3): void {
    this.spawn(x, y, z, size, life);
    for (let i = 1; i < count; i++) {
      const a = (i / count) * 6.283 + size * 3.1;
      const r = size * 0.45;
      this.spawn(x + Math.cos(a) * r, y + 0.1 * i, z + Math.sin(a) * r, size * 0.45, life * 0.8);
    }
  }
}
