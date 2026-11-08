import * as THREE from 'three';
import { PAL } from '../../data/palette';
import { AiState } from '../../systems/ai/fsm';
import { BODY_FRAG, BODY_VERT } from './bodyShader';
import type { Enemy } from './Enemy';
import { KIND_INDEX } from './Enemy';
import { ENEMY_POOL, type EnemyFxSink, type EnemySystem, PROJECTILE_POOL } from './EnemySystem';
import { FX_FRAG, FX_VERT, PARTICLE_FRAG, PARTICLE_VERT } from './fxShader';

const FX_CAP = ENEMY_POOL * 3 + PROJECTILE_POOL;
const PROJ_LEN = 1.25;

/** Shard blocks the death tear splits the body into (must match bodyShader). */
export const SHARD_U = 7;
export const SHARD_V = 5;

/**
 * Lathe parameter grid: position = (u, v, 0); the vertex shader builds the actual surface.
 * Vertices are duplicated along shard-block borders (aCell = block index) so the death tear
 * separates cleanly instead of stretching triangles between flying pieces.
 */
export function createLatheGrid(perU = 6, perV = 7): THREE.BufferGeometry {
  const nu = SHARD_U * perU;
  const nv = SHARD_V * perV;
  const pos: number[] = [];
  const cell: number[] = [];
  const idx: number[] = [];
  for (let bv = 0; bv < SHARD_V; bv++) {
    for (let bu = 0; bu < SHARD_U; bu++) {
      const base = pos.length / 3;
      for (let j = 0; j <= perV; j++) {
        for (let i = 0; i <= perU; i++) {
          pos.push((bu * perU + i) / nu, (bv * perV + j) / nv, 0);
          cell.push(bu, bv);
        }
      }
      for (let j = 0; j < perV; j++) {
        for (let i = 0; i < perU; i++) {
          const a = base + j * (perU + 1) + i;
          const b = a + 1;
          const c = a + perU + 1;
          const d = c + 1;
          idx.push(a, b, d, a, d, c);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aCell', new THREE.Float32BufferAttribute(cell, 2));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

function col(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

export interface EnemyRendererOptions {
  /** Light direction (defaults to POC moonlight). */
  keyDir?: THREE.Vector3;
  /** Override for the body material (e.g. render's createInkMaterial({crumple, instancing})).
   *  Must consume the aA..aD instance attributes documented in bodyShader.ts. */
  bodyMaterial?: THREE.ShaderMaterial;
  /** Crystal light position source; defaults to reveal.center + 1.9 m. */
  crystalPos?: () => THREE.Vector3;
}

/**
 * Draws every enemy with 4 draw calls total regardless of count: bodies (1 instanced lathe),
 * ink outlines (inverted hull sharing the same instance buffers), FX ribbons (telegraphs,
 * pencil projectiles, shadows, drain tendrils) and particles (paper scraps, ink, shavings).
 */
export class EnemyRenderer implements EnemyFxSink {
  readonly root = new THREE.Group();
  readonly uniforms: Record<string, THREE.IUniform>;
  readonly body: THREE.InstancedMesh;
  readonly outline: THREE.InstancedMesh;
  readonly fx: THREE.InstancedMesh;
  readonly particles: THREE.InstancedMesh;

  private aA: THREE.InstancedBufferAttribute;
  private aB: THREE.InstancedBufferAttribute;
  private aC: THREE.InstancedBufferAttribute;
  private aD: THREE.InstancedBufferAttribute;
  private fP0: THREE.InstancedBufferAttribute;
  private fP1: THREE.InstancedBufferAttribute;
  private fL: THREE.InstancedBufferAttribute;
  private pQ: THREE.InstancedBufferAttribute;
  private time = 0;
  private crystalPos: () => THREE.Vector3;
  private readonly crystalScratch = new THREE.Vector3();

  // particle pool (struct of arrays)
  private readonly pCap: number;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly rx: Float32Array;
  private readonly ry: Float32Array;
  private readonly rz: Float32Array;
  private readonly wx: Float32Array;
  private readonly wy: Float32Array;
  private readonly wz: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly ptype: Uint8Array;
  private readonly pseed: Float32Array;
  private readonly ptone: Float32Array;
  private readonly landed: Uint8Array;
  private pNext = 0;

  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();

  constructor(
    private system: EnemySystem,
    opts: EnemyRendererOptions = {},
  ) {
    const ramp = PAL.ghost;
    const reveal = system.reveal;
    this.crystalPos =
      opts.crystalPos ??
      (() => this.crystalScratch.set(reveal.center.x, reveal.center.y + 1.9, reveal.center.z));
    this.uniforms = {
      uTime: { value: 0 },
      uRevealCenter: { value: new THREE.Vector3() },
      uRevealRadius: { value: 3 },
      uRevealEdge: { value: system.tuning.crystal.edgeWidth },
      uBlankPage: { value: 0 },
      uKeyDir: { value: (opts.keyDir ?? new THREE.Vector3(-0.5, 0.75, 0.45)).clone().normalize() },
      uCrystalPos: { value: new THREE.Vector3() },
      uShadow: { value: 0.3 },
      uRamp0: { value: col(ramp[0]) },
      uRamp1: { value: col(ramp[1]) },
      uRamp2: { value: col(ramp[2]) },
      uRamp3: { value: col(ramp[3]) },
      uOutlineW: { value: 0.035 },
    };
    const u = this.uniforms;

    // ── bodies + outlines ──
    const grid = createLatheGrid();
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(ENEMY_POOL * 4), 4);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(ENEMY_POOL * 4), 4);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(ENEMY_POOL * 4), 4);
    this.aD = new THREE.InstancedBufferAttribute(new Float32Array(ENEMY_POOL * 4), 4);
    for (const a of [this.aA, this.aB, this.aC, this.aD]) a.setUsage(THREE.DynamicDrawUsage);
    grid.setAttribute('aA', this.aA);
    grid.setAttribute('aB', this.aB);
    grid.setAttribute('aC', this.aC);
    grid.setAttribute('aD', this.aD);

    const bodyMat =
      opts.bodyMaterial ??
      new THREE.ShaderMaterial({
        uniforms: { ...u, uOutline: { value: 0 } },
        vertexShader: BODY_VERT,
        fragmentShader: BODY_FRAG,
        side: THREE.DoubleSide,
      });
    const outlineMat = new THREE.ShaderMaterial({
      uniforms: { ...u, uOutline: { value: 1 } },
      vertexShader: BODY_VERT,
      fragmentShader: BODY_FRAG,
      side: THREE.BackSide,
    });
    this.body = new THREE.InstancedMesh(grid, bodyMat, ENEMY_POOL);
    this.outline = new THREE.InstancedMesh(grid, outlineMat, ENEMY_POOL);
    this.outline.instanceMatrix = this.body.instanceMatrix;
    this.body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (const m of [this.body, this.outline]) {
      m.frustumCulled = false;
      m.count = 0;
      m.name = m === this.body ? 'enemies.body' : 'enemies.outline';
    }
    this.outline.renderOrder = -1;

    // ── FX ribbons ──
    const quad = new THREE.PlaneGeometry(1, 1, 24, 1);
    this.fP0 = new THREE.InstancedBufferAttribute(new Float32Array(FX_CAP * 4), 4);
    this.fP1 = new THREE.InstancedBufferAttribute(new Float32Array(FX_CAP * 4), 4);
    this.fL = new THREE.InstancedBufferAttribute(new Float32Array(FX_CAP * 4), 4);
    for (const a of [this.fP0, this.fP1, this.fL]) a.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('aP0', this.fP0);
    quad.setAttribute('aP1', this.fP1);
    quad.setAttribute('aL', this.fL);
    const fxMat = new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: FX_VERT,
      fragmentShader: FX_FRAG,
      side: THREE.DoubleSide,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.fx = new THREE.InstancedMesh(quad, fxMat, FX_CAP);
    this.fx.frustumCulled = false;
    this.fx.count = 0;
    this.fx.name = 'enemies.fx';

    // ── particles ──
    this.pCap = system.tuning.enemies.fx.maxParticles;
    const n = this.pCap;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.rx = new Float32Array(n);
    this.ry = new Float32Array(n);
    this.rz = new Float32Array(n);
    this.wx = new Float32Array(n);
    this.wy = new Float32Array(n);
    this.wz = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size = new Float32Array(n);
    this.ptype = new Uint8Array(n);
    this.pseed = new Float32Array(n);
    this.ptone = new Float32Array(n);
    this.landed = new Uint8Array(n);
    const pquad = new THREE.PlaneGeometry(1, 1);
    this.pQ = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.pQ.setUsage(THREE.DynamicDrawUsage);
    pquad.setAttribute('aQ', this.pQ);
    const pMat = new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      side: THREE.DoubleSide,
    });
    this.particles = new THREE.InstancedMesh(pquad, pMat, n);
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particles.frustumCulled = false;
    this.particles.count = 0;
    this.particles.name = 'enemies.particles';

    this.root.name = 'enemies';
    this.root.add(this.outline, this.body, this.fx, this.particles);
    system.fx = this;
  }

  /** Per rendered frame. `dt` should already include hit-stop/time scale. */
  update(dt: number, camera?: THREE.Camera): void {
    this.time += dt;
    const sys = this.system;
    const reveal = sys.reveal;
    const u = this.uniforms;
    u.uTime!.value = this.time;
    (u.uRevealCenter!.value as THREE.Vector3).copy(reveal.center);
    u.uRevealRadius!.value = reveal.radius;
    u.uRevealEdge!.value = sys.tuning.crystal.edgeWidth;
    u.uBlankPage!.value = reveal.blankPage;
    const cp = this.crystalPos();
    (u.uCrystalPos!.value as THREE.Vector3).copy(cp);

    this.writeBodies(cp);
    this.writeFx(cp);
    this.stepParticles(dt, camera);
  }

  private writeBodies(cp: THREE.Vector3): void {
    const pool = this.system.pool;
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const C = this.aC.array as Float32Array;
    const D = this.aD.array as Float32Array;
    const M = this.body.instanceMatrix.array as Float32Array;
    let n = 0;
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i]!;
      if (!e.active) continue;
      const o = n * 4;
      A[o] = KIND_INDEX[e.kind];
      A[o + 1] = e.seed;
      A[o + 2] = e.revealVis;
      A[o + 3] = e.spawnT;
      B[o] = e.hitT;
      B[o + 1] = e.state === AiState.Die ? Math.max(1e-3, e.deathT) : 0;
      B[o + 2] = e.windup;
      B[o + 3] = e.recoil;
      C[o] = e.lunge;
      C[o + 1] = e.drain;
      C[o + 2] = e.lagX;
      C[o + 3] = e.lagZ;
      D[o] = Math.min(1.2, e.speed01);
      D[o + 1] = e.alive ? Math.max(0, e.hp / e.maxHp) : 0;
      const c = Math.cos(e.yaw);
      const s = Math.sin(e.yaw);
      let dx = cp.x - e.position.x;
      let dz = cp.z - e.position.z;
      const dl = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= dl;
      dz /= dl;
      D[o + 2] = dx * c - dz * s;
      D[o + 3] = dx * s + dz * c;
      // yaw-only transform, column-major
      const m = n * 16;
      M[m] = c;
      M[m + 1] = 0;
      M[m + 2] = -s;
      M[m + 3] = 0;
      M[m + 4] = 0;
      M[m + 5] = 1;
      M[m + 6] = 0;
      M[m + 7] = 0;
      M[m + 8] = s;
      M[m + 9] = 0;
      M[m + 10] = c;
      M[m + 11] = 0;
      M[m + 12] = e.position.x;
      M[m + 13] = e.position.y;
      M[m + 14] = e.position.z;
      M[m + 15] = 1;
      n++;
    }
    this.body.count = n;
    this.outline.count = n;
    this.aA.needsUpdate = this.aB.needsUpdate = this.aC.needsUpdate = this.aD.needsUpdate = true;
    this.body.instanceMatrix.needsUpdate = true;
  }

  private writeFx(cp: THREE.Vector3): void {
    const sys = this.system;
    const t = sys.tuning.enemies;
    this.fxN = 0;
    const pool = sys.pool;
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i]!;
      if (!e.active) continue;
      const x = e.position.x;
      const y = e.position.y + 0.025;
      const z = e.position.z;
      // shadow
      const dead = e.state === AiState.Die ? e.deathT : 0;
      const r = e.radius * (e.kind === 'blot' ? 1.55 : 1.2) * (0.3 + 0.7 * e.spawnT);
      const vis = e.revealVis * (1 - dead) * (e.kind === 'smudge' ? 0.85 : 1);
      if (vis > 0.01) this.putFx(x - r, y, z, 2, x + r, y, z, r * 1.5, 0, e.seed, vis);
      if (!e.alive) continue;
      // scribbler telegraph
      if (e.kind === 'scribbler' && e.state === AiState.Attack && e.phase === 0) {
        let dx = e.aimX - x;
        let dz = e.aimZ - z;
        const d = Math.sqrt(dx * dx + dz * dz) || 1;
        dx /= d;
        dz /= d;
        const len = t.scribbler.range + 1.5;
        this.putFx(
          x + dx * 0.45,
          y + 0.01,
          z + dz * 0.45,
          0,
          x + dx * len,
          y + 0.01,
          z + dz * len,
          0.22,
          e.windup,
          e.seed,
          1,
        );
      }
      // blot drain tendril
      if (e.kind === 'blot' && e.drain > 0.04) {
        this.putFx(x, y + 0.55, z, 3, cp.x, cp.y - 0.25, cp.z, 0.2, 0, e.seed, Math.min(1, e.drain * 1.4));
      }
    }
    const pr = sys.projectiles;
    for (let i = 0; i < pr.capacity; i++) {
      if (!pr.active[i]) continue;
      const x = pr.x[i]!;
      const z = pr.z[i]!;
      const dx = pr.dx[i]!;
      const dz = pr.dz[i]!;
      const grow = Math.min(1, pr.age[i]! * 8);
      this.putFx(
        x - dx * PROJ_LEN * grow,
        1.1,
        z - dz * PROJ_LEN * grow,
        1,
        x,
        1.1,
        z,
        0.16,
        0,
        pr.seed[i]!,
        1,
      );
    }
    this.fx.count = this.fxN;
    this.fP0.needsUpdate = this.fP1.needsUpdate = this.fL.needsUpdate = true;
  }

  private fxN = 0;
  private putFx(
    ax: number,
    ay: number,
    az: number,
    type: number,
    bx: number,
    by: number,
    bz: number,
    w: number,
    prog: number,
    seed: number,
    vis: number,
  ): void {
    if (this.fxN >= FX_CAP) return;
    const P0 = this.fP0.array as Float32Array;
    const P1 = this.fP1.array as Float32Array;
    const L = this.fL.array as Float32Array;
    const o = this.fxN * 4;
    P0[o] = ax;
    P0[o + 1] = ay;
    P0[o + 2] = az;
    P0[o + 3] = type;
    P1[o] = bx;
    P1[o + 1] = by;
    P1[o + 2] = bz;
    P1[o + 3] = w;
    L[o] = prog;
    L[o + 1] = seed;
    L[o + 2] = vis;
    L[o + 3] = 0;
    this.fxN++;
  }

  // ───────────── particles ─────────────

  private emit(
    type: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    life: number,
    tone: number,
  ): void {
    const i = this.pNext;
    this.pNext = (this.pNext + 1) % this.pCap;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.rx[i] = Math.random() * 6.28;
    this.ry[i] = Math.random() * 6.28;
    this.rz[i] = Math.random() * 6.28;
    this.wx[i] = (Math.random() - 0.5) * 14;
    this.wy[i] = (Math.random() - 0.5) * 14;
    this.wz[i] = (Math.random() - 0.5) * 14;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.ptype[i] = type;
    this.pseed[i] = Math.random();
    this.ptone[i] = tone;
    this.landed[i] = 0;
  }

  death(e: Enemy): void {
    const f = this.system.tuning.enemies.fx;
    const x = e.position.x;
    const z = e.position.z;
    const paper = e.kind !== 'blot';
    const h = e.kind === 'scribbler' ? 1.3 : e.kind === 'smudge' ? 0.8 : 0.35;
    const n = paper ? f.scraps : 4;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = f.scrapSpeed * (0.4 + Math.random() * 0.8);
      this.emit(
        0,
        x,
        e.position.y + h * Math.random() + 0.2,
        z,
        Math.cos(a) * s,
        2 + Math.random() * 3.5,
        Math.sin(a) * s,
        0.12 + Math.random() * 0.16,
        f.particleLife * (0.8 + Math.random() * 0.8),
        Math.random(),
      );
    }
    const dn = paper ? f.droplets : f.droplets * 2.4;
    for (let k = 0; k < dn; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = (paper ? 2.5 : 4) * (0.4 + Math.random() * 0.9);
      this.emit(
        1,
        x,
        e.position.y + 0.4 + Math.random() * 0.4,
        z,
        Math.cos(a) * s,
        2 + Math.random() * 3,
        Math.sin(a) * s,
        0.08 + Math.random() * 0.12,
        f.particleLife * 1.4,
        Math.random() < 0.25 ? 1 : 0,
      );
    }
  }

  hit(e: Enemy, fromX: number, fromZ: number): void {
    let dx = e.position.x - fromX;
    let dz = e.position.z - fromZ;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= d;
    dz /= d;
    const paper = e.kind !== 'blot';
    const y = e.position.y + (e.kind === 'scribbler' ? 1.1 : 0.6);
    for (let k = 0; k < 6; k++) {
      const s = 2 + Math.random() * 2.5;
      const j = (Math.random() - 0.5) * 1.6;
      this.emit(
        paper ? 0 : 1,
        e.position.x - dx * e.radius,
        y,
        e.position.z - dz * e.radius,
        (-dx + -dz * j) * s,
        1.5 + Math.random() * 2,
        (-dz + dx * j) * s,
        paper ? 0.07 + Math.random() * 0.08 : 0.07,
        0.8,
        Math.random(),
      );
    }
  }

  projectileEnd(x: number, z: number, hitPlayer: boolean): void {
    for (let k = 0; k < 6; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = 1 + Math.random() * 2;
      this.emit(
        2,
        x,
        1.1,
        z,
        Math.cos(a) * s,
        1 + Math.random() * 2,
        Math.sin(a) * s,
        0.09 + Math.random() * 0.06,
        0.9,
        0,
      );
    }
    if (hitPlayer) {
      for (let k = 0; k < 5; k++) {
        const a = Math.random() * Math.PI * 2;
        this.emit(1, x, 1.1, z, Math.cos(a) * 2.5, 2.5, Math.sin(a) * 2.5, 0.1, 1.2, 0);
      }
    }
  }

  private stepParticles(dt: number, camera?: THREE.Camera): void {
    const g = this.system.tuning.enemies.fx.gravity;
    const M = this.particles.instanceMatrix.array as Float32Array;
    const Q = this.pQ.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.pCap; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) continue;
      const type = this.ptype[i]!;
      let flat = false;
      if (!this.landed[i]) {
        const drag = type === 0 ? 2.6 : type === 2 ? 1.5 : 0.4;
        const k = Math.exp(-drag * dt);
        this.vx[i]! *= k;
        this.vz[i]! *= k;
        this.vy[i]! -= g * (type === 0 ? 0.32 : type === 2 ? 0.5 : 1) * dt;
        if (type === 0) {
          // paper flutter: side-slip and a falling-leaf terminal velocity
          const tt = this.time * 7 + this.pseed[i]! * 40;
          this.vx[i]! += Math.sin(tt) * dt * 4;
          this.vz[i]! += Math.cos(tt * 0.8) * dt * 4;
          if (this.vy[i]! < -1.3) this.vy[i] = -1.3;
        }
        this.px[i]! += this.vx[i]! * dt;
        this.py[i]! += this.vy[i]! * dt;
        this.pz[i]! += this.vz[i]! * dt;
        this.rx[i]! += this.wx[i]! * dt;
        this.ry[i]! += this.wy[i]! * dt;
        this.rz[i]! += this.wz[i]! * dt;
        if (this.py[i]! <= 0.03) {
          this.py[i] = 0.03 + (i % 7) * 0.002;
          this.landed[i] = 1;
          if (type === 1) this.size[i]! *= 1.9; // splat
        }
      } else flat = true;

      const lifeK = this.life[i]! / this.maxLife[i]!;
      const fade = Math.min(1, lifeK / 0.3);
      const sz = this.size[i]! * fade;
      this._p.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      if (flat) {
        this._e.set(-Math.PI / 2, 0, this.rz[i]!);
        this._q.setFromEuler(this._e);
      } else if (type === 1 && camera) {
        this._q.copy(camera.quaternion);
      } else {
        this._e.set(this.rx[i]!, this.ry[i]!, this.rz[i]!);
        this._q.setFromEuler(this._e);
      }
      this._s.set(sz, sz, sz);
      this._m.compose(this._p, this._q, this._s);
      this._m.toArray(M, n * 16);
      const o = n * 4;
      Q[o] = type;
      Q[o + 1] = this.pseed[i]!;
      Q[o + 2] = lifeK;
      Q[o + 3] = this.ptone[i]!;
      n++;
    }
    this.particles.count = n;
    this.particles.instanceMatrix.needsUpdate = true;
    this.pQ.needsUpdate = true;
  }

  /** Live particle count (debug). */
  get particleCount(): number {
    return this.particles.count;
  }

  dispose(): void {
    for (const m of [this.body, this.fx, this.particles]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    (this.outline.material as THREE.Material).dispose();
    this.root.removeFromParent();
    if (this.system.fx === this) this.system.fx = null;
  }
}
