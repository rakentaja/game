/**
 * Paper tear particles: torn triangular shards with inked edges, CPU-simulated (flutter, drag,
 * gravity, settle on the ground), drawn as one InstancedMesh. Fixed pool, zero allocations.
 */
import * as THREE from 'three';
import { PAL } from '../data/palette';

const VERT = /* glsl */ `
attribute vec3 aBary;
attribute float aTint;
varying vec3 vB;
varying float vTint;
varying float vFace;
void main() {
  vB = aBary;
  vTint = aTint;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
  vFace = dot(n, normalize(vec3(-0.5, 0.75, 0.45)));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uInk, uC1, uC2, uC3;
varying vec3 vB;
varying float vTint;
varying float vFace;
void main() {
  float e = min(min(vB.x, vB.y), vB.z);
  float f = gl_FrontFacing ? vFace : -vFace;
  vec3 col = f > 0.25 ? uC3 : (f > -0.2 ? uC2 : uC1);
  if (vTint > 0.66) col = f > 0.0 ? uC2 : uC1;
  if (e < 0.07) col = uInk;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class PaperTear {
  readonly mesh: THREE.InstancedMesh;
  groundY = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly tint: THREE.InstancedBufferAttribute;
  private next = 0;
  private live = 0;
  private seed = 1;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(readonly pool: number) {
    // an irregular torn shard: 2 triangles, barycentrics for the inked edge
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([
          -0.5, -0.4, 0, 0.55, -0.3, 0, 0.1, 0.6, 0, 0.55, -0.3, 0, 0.5, 0.35, 0, 0.1, 0.6, 0,
        ]),
        3,
      ),
    );
    geo.setAttribute(
      'aBary',
      new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1]), 3),
    );
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(pool), 1);
    geo.setAttribute('aTint', this.tint);
    const mat = new THREE.ShaderMaterial({
      name: 'PaperTear',
      uniforms: {
        uInk: { value: new THREE.Color(PAL.ink) },
        uC1: { value: new THREE.Color(PAL.ghost[1]) },
        uC2: { value: new THREE.Color(PAL.ghost[2]) },
        uC3: { value: new THREE.Color(PAL.ghost[3]) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, pool);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.userData.noOutline = true;
    this.mesh.name = 'fx:paperTear';
    this.mesh.count = 0;
    this.pos = new Float32Array(pool * 3);
    this.vel = new Float32Array(pool * 3);
    this.rot = new Float32Array(pool * 3);
    this.spin = new Float32Array(pool * 3);
    this.age = new Float32Array(pool).fill(1e9);
    this.life = new Float32Array(pool).fill(1);
    this.size = new Float32Array(pool);
  }

  private rnd(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /**
   * Spray `count` shards. Optional (dirX, dirZ, bias 0..1) throws them along a direction (a bolt
   * tearing through the paper) instead of evenly around.
   */
  burst(
    x: number,
    y: number,
    z: number,
    count: number,
    speed: number,
    life: number,
    size = 0.16,
    dirX = 0,
    dirZ = 0,
    bias = 0,
  ): void {
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.pool;
      const a = this.rnd() * Math.PI * 2;
      const up = 0.35 + this.rnd() * 0.9;
      const sp = speed * (0.4 + this.rnd() * 0.8);
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = Math.cos(a) * sp * (1 - bias) + dirX * sp * bias * 1.6;
      this.vel[i * 3 + 1] = up * sp * 1.2;
      this.vel[i * 3 + 2] = Math.sin(a) * sp * (1 - bias) + dirZ * sp * bias * 1.6;
      for (let k = 0; k < 3; k++) {
        this.rot[i * 3 + k] = this.rnd() * 6.28;
        this.spin[i * 3 + k] = (this.rnd() - 0.5) * 14;
      }
      this.age[i] = 0;
      this.life[i] = life * (0.7 + this.rnd() * 0.6);
      this.size[i] = size * (0.5 + this.rnd());
      this.tint.setX(i, this.rnd());
    }
    this.tint.needsUpdate = true;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    let maxLive = 0;
    for (let i = 0; i < this.pool; i++) {
      const alive = this.age[i]! < this.life[i]!;
      if (alive) {
        this.age[i]! += dt;
        const o = i * 3;
        const grounded = this.pos[o + 1]! <= this.groundY + 0.01;
        if (!grounded) {
          const drag = Math.exp(-dt * 2.6);
          this.vel[o] = this.vel[o]! * drag + Math.sin(this.age[i]! * 9 + i) * 1.6 * dt;
          this.vel[o + 1] = this.vel[o + 1]! * drag - 7.5 * dt;
          this.vel[o + 2] = this.vel[o + 2]! * drag + Math.cos(this.age[i]! * 7 + i) * 1.6 * dt;
          this.vel[o + 1] = Math.max(this.vel[o + 1]!, -2.2); // paper falls slowly
          for (let k = 0; k < 3; k++) {
            this.pos[o + k]! += this.vel[o + k]! * dt;
            this.rot[o + k]! += this.spin[o + k]! * dt;
          }
          if (this.pos[o + 1]! < this.groundY + 0.01) {
            this.pos[o + 1] = this.groundY + 0.01;
            this.rot[o] = -Math.PI / 2;
            this.rot[o + 1] = 0;
          }
        }
      }
      const k = this.age[i]! / this.life[i]!;
      const sc = alive ? this.size[i]! * (k > 0.8 ? (1 - k) / 0.2 : 1) : 0;
      if (alive) maxLive = i + 1;
      this.e.set(this.rot[i * 3]!, this.rot[i * 3 + 1]!, this.rot[i * 3 + 2]!);
      this.q.setFromEuler(this.e);
      this.p.set(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
      this.s.setScalar(sc);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.live = maxLive;
    this.mesh.count = this.live;
    this.mesh.instanceMatrix.needsUpdate = this.live > 0;
  }
}
