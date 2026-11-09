import * as THREE from 'three';
import type { EliteAffix, EnemyKind } from '../../core/types';
import { PAL } from '../../data/palette';
import { REVEAL_GLSL } from '../../render/reveal/revealMath';
import { AiState } from '../../systems/ai/fsm';
import { BODY_FRAG, BODY_VERT } from './bodyShader';
import { CraneMode, type CraneTarget } from './Cranes';
import type { Enemy } from './Enemy';
import { ELITE_INDEX, KIND_INDEX } from './Enemy';
import { CRANE_POOL, ENEMY_POOL, type EnemyFxSink, type EnemySystem, PROJECTILE_POOL } from './EnemySystem';
import { FX_FRAG, FX_VERT, PARTICLE_FRAG, PARTICLE_VERT } from './fxShader';
import { MASK_GLSL, MASK_TOKEN, renderMaskGlsl } from './glsl';
import { MARGIN_TELL } from './MarginMan';
import { WARDEN_BOX, WARDEN_WINDUP } from './PanelWarden';

/** Body instances: every enemy (misprints draw up to 3 offset plates) + every crane. */
const BODY_CAP = ENEMY_POOL * 3 + CRANE_POOL;
const FX_CAP = ENEMY_POOL * 4 + PROJECTILE_POOL + CRANE_POOL;
/** Elite caption tags on screen at once. */
const TAG_CAP = 4;

/** Paper-ish kinds tear into scraps; ink kinds splat. */
const INK_KIND: Partial<Record<EnemyKind, true>> = { blot: true, redactor: true };
/** Rough body height per kind (FX anchor points, caption tags). */
const KIND_H: Record<EnemyKind, number> = {
  smudge: 0.8,
  scribbler: 1.3,
  blot: 0.35,
  marginMan: 1.4,
  redactor: 0.9,
  panelWarden: 1.2,
  misprint: 0.8,
  cranes: 0.2,
};
const TAG_KEYS: Record<EliteAffix, [string, string]> = {
  firstEdition: ['enemy.elite.firstEdition', '1st Edition'],
  inkedIn: ['enemy.elite.inkedIn', 'Inked In'],
  bleedThrough: ['enemy.elite.bleedThrough', 'Bleed-Through'],
};
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
  /**
   * In-game: render's shared look uniforms + RevealSystem uniforms. Enemies then use the exact
   * reveal field (history map, sources, blank page), the shared key light / shadow / fog, and
   * write ink-class alpha for the post pass, matching InkMaterial. Omit in harnesses.
   */
  inkContext?: { shared: Record<string, THREE.IUniform>; reveal: Record<string, THREE.IUniform> };
  /** i18n lookup for elite caption tags (ctx.t). English fallbacks otherwise. */
  label?: (key: string) => string;
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
  private aE: THREE.InstancedBufferAttribute;
  private readonly tags: THREE.Sprite[] = [];
  private readonly tagMats = new Map<EliteAffix, THREE.SpriteMaterial>();
  private readonly label: ((key: string) => string) | null;
  private fP0: THREE.InstancedBufferAttribute;
  private fP1: THREE.InstancedBufferAttribute;
  private fL: THREE.InstancedBufferAttribute;
  private pQ: THREE.InstancedBufferAttribute;
  private time = 0;
  private readonly ownMask: boolean;
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
      uFogNear: { value: 1e4 },
      uFogFar: { value: 2e4 },
      uEliteW: { value: system.tuning.enemies.elites.outlineMul },
      uTintC: { value: col(PAL.teal[2]) },
      uTintM: { value: col(PAL.red[2]) },
      uTintY: { value: col(PAL.glowCore) },
      uGold: { value: col(PAL.glowCore) },
      uEliteTeal: { value: col(PAL.teal[3]) },
      uEliteRed: { value: col(PAL.red[2]) },
    };
    this.label = opts.label ?? null;
    const ink = opts.inkContext;
    this.ownMask = !ink;
    if (ink) {
      Object.assign(this.uniforms, ink.reveal);
      if (!ink.reveal.uNoise && ink.shared.uNoise) this.uniforms.uNoise = ink.shared.uNoise;
      for (const k of ['uKeyDir', 'uShadow', 'uFogNear', 'uFogFar'] as const)
        if (ink.shared[k]) this.uniforms[k] = ink.shared[k]!;
    }
    const mask = ink ? renderMaskGlsl(REVEAL_GLSL) : MASK_GLSL;
    const withMask = (src: string) => src.split(MASK_TOKEN).join(mask);
    const u = this.uniforms;

    // ── bodies + outlines ──
    const grid = createLatheGrid();
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(BODY_CAP * 4), 4);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(BODY_CAP * 4), 4);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(BODY_CAP * 4), 4);
    this.aD = new THREE.InstancedBufferAttribute(new Float32Array(BODY_CAP * 4), 4);
    this.aE = new THREE.InstancedBufferAttribute(new Float32Array(BODY_CAP * 4), 4);
    for (const a of [this.aA, this.aB, this.aC, this.aD, this.aE]) a.setUsage(THREE.DynamicDrawUsage);
    grid.setAttribute('aA', this.aA);
    grid.setAttribute('aB', this.aB);
    grid.setAttribute('aC', this.aC);
    grid.setAttribute('aD', this.aD);
    grid.setAttribute('aE', this.aE);

    const bodyMat =
      opts.bodyMaterial ??
      new THREE.ShaderMaterial({
        uniforms: { ...u, uOutline: { value: 0 } },
        vertexShader: BODY_VERT,
        fragmentShader: withMask(BODY_FRAG),
        side: THREE.DoubleSide,
      });
    const outlineMat = new THREE.ShaderMaterial({
      uniforms: { ...u, uOutline: { value: 1 } },
      vertexShader: BODY_VERT,
      fragmentShader: withMask(BODY_FRAG),
      side: THREE.BackSide,
    });
    this.body = new THREE.InstancedMesh(grid, bodyMat, BODY_CAP);
    this.outline = new THREE.InstancedMesh(grid, outlineMat, BODY_CAP);
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
      fragmentShader: withMask(FX_FRAG),
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
      fragmentShader: withMask(PARTICLE_FRAG),
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

  // ───────────── elite caption tags ─────────────

  private tagMaterial(a: EliteAffix): THREE.SpriteMaterial | null {
    let m = this.tagMats.get(a);
    if (m) return m;
    if (typeof document === 'undefined') return null;
    const [key, fallback] = TAG_KEYS[a];
    const t = this.label?.(key);
    const text = t && t !== key ? t : fallback;
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const g = c.getContext('2d');
    if (!g) return null;
    const tint = a === 'firstEdition' ? PAL.glowCore : a === 'inkedIn' ? PAL.teal[3] : PAL.red[2];
    g.fillStyle = PAL.ink;
    g.fillRect(6, 10, 244, 44);
    g.fillStyle = PAL.paper;
    g.fillRect(10, 14, 236, 36);
    g.fillStyle = tint;
    g.fillRect(10, 14, 10, 36);
    g.fillStyle = PAL.ink;
    g.font = '900 26px "Bangers", Impact, "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text.toLocaleUpperCase(document.documentElement.lang || 'en'), 133, 33, 220);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace;
    m = new THREE.SpriteMaterial({ map: tex, depthTest: false, alphaTest: 0.5, transparent: false });
    this.tagMats.set(a, m);
    return m;
  }

  /** Language changed: rebuild the caption textures on next use. */
  refreshLabels(): void {
    for (const m of this.tagMats.values()) {
      m.map?.dispose();
      m.dispose();
    }
    this.tagMats.clear();
    for (const s of this.tags) s.visible = false;
  }

  private writeTags(): void {
    let n = 0;
    const pool = this.system.pool;
    for (let i = 0; i < pool.length && n < TAG_CAP; i++) {
      const e = pool[i]!;
      if (!e.alive || !e.elite || e.revealVis < 0.4) continue;
      const mat = this.tagMaterial(e.elite);
      if (!mat) return;
      let s = this.tags[n];
      if (!s) {
        s = new THREE.Sprite(mat);
        s.renderOrder = 5;
        s.frustumCulled = false;
        s.scale.set(1.4, 0.35, 1);
        this.tags.push(s);
        this.root.add(s);
      }
      s.material = mat;
      s.visible = true;
      s.position.set(e.position.x, e.position.y + KIND_H[e.kind] * 1.6 + 0.75, e.position.z);
      n++;
    }
    for (let i = n; i < this.tags.length; i++) this.tags[i]!.visible = false;
  }

  /** Per rendered frame. `dt` should already include hit-stop/time scale. */
  update(dt: number, camera?: THREE.Camera): void {
    this.time += dt;
    const sys = this.system;
    const reveal = sys.reveal;
    const u = this.uniforms;
    u.uTime!.value = this.time;
    if (this.ownMask) {
      (u.uRevealCenter!.value as THREE.Vector3).copy(reveal.center);
      u.uRevealRadius!.value = reveal.radius;
      u.uRevealEdge!.value = sys.tuning.crystal.edgeWidth;
      u.uBlankPage!.value = reveal.blankPage;
    }
    const cp = this.crystalPos();
    (u.uCrystalPos!.value as THREE.Vector3).copy(cp);

    this.writeBodies(cp);
    this.writeFx(cp);
    this.writeTags();
    this.stepParticles(dt, camera);
  }

  private writeBodies(cp: THREE.Vector3): void {
    const pool = this.system.pool;
    const mp = this.system.tuning.enemies.misprintAi;
    let n = 0;
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i]!;
      if (!e.active || e.kind === 'cranes') continue;
      if (e.kind === 'misprint' && e.alive && e.align < 1) {
        // three plates out of register, sliding together as `align` → 1
        const mag = mp.spread * (1 - e.align);
        for (let k = 0; k < 3 && n < BODY_CAP; k++) {
          const a = e.seed * 6.283 + k * 2.094 + this.time * 0.6;
          n = this.putEnemy(n, e, e.position.x + Math.cos(a) * mag, e.position.z + Math.sin(a) * mag, k, cp);
        }
        continue;
      }
      if (n < BODY_CAP) n = this.putEnemy(n, e, e.position.x, e.position.z, 3, cp);
    }
    const cranes = this.system.cranes;
    for (let i = 0; i < cranes.length && n < BODY_CAP; i++) {
      const c = cranes[i]!;
      if (!c.active) continue;
      n = this.putCrane(n, c, cp);
    }
    this.body.count = n;
    this.outline.count = n;
    this.aA.needsUpdate = this.aB.needsUpdate = this.aC.needsUpdate = this.aD.needsUpdate = true;
    this.aE.needsUpdate = true;
    this.body.instanceMatrix.needsUpdate = true;
  }

  private putEnemy(n: number, e: Enemy, x: number, z: number, variant: number, cp: THREE.Vector3): number {
    const o = n * 4;
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const C = this.aC.array as Float32Array;
    const D = this.aD.array as Float32Array;
    const E = this.aE.array as Float32Array;
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
    E[o] = variant;
    E[o + 1] = e.elite ? ELITE_INDEX[e.elite] : 0;
    E[o + 2] =
      e.kind === 'redactor' ? e.expose : e.kind === 'marginMan' ? (e.vulnT > 0 || e.worn ? 1 : 0) : 0;
    E[o + 3] = e.kind === 'redactor' ? e.shield : 0;
    this.writeMatrix(n, x, e.position.y, z, e.yaw, cp, D, o);
    return n + 1;
  }

  private putCrane(n: number, c: CraneTarget, cp: THREE.Vector3): number {
    const o = n * 4;
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const C = this.aC.array as Float32Array;
    const D = this.aD.array as Float32Array;
    const E = this.aE.array as Float32Array;
    const sw = c.swarm;
    A[o] = KIND_INDEX.cranes;
    A[o + 1] = c.seed;
    A[o + 2] = c.revealVis;
    A[o + 3] = sw ? sw.spawnT : 1;
    B[o] = c.hitT;
    B[o + 1] = c.alive ? 0 : Math.max(1e-3, c.dieT);
    B[o + 2] = c.mode === CraneMode.Fold ? c.fold : 0;
    B[o + 3] = 0;
    C[o] = c.mode === CraneMode.Dive ? 1 : 0;
    C[o + 1] = 0;
    C[o + 2] = 0;
    C[o + 3] = 0;
    D[o] = 0;
    D[o + 1] = c.alive ? 1 : 0;
    E[o] = 3;
    E[o + 1] = 0;
    E[o + 2] = c.fold;
    E[o + 3] = 0;
    this.writeMatrix(n, c.position.x, c.position.y, c.position.z, c.yaw, cp, D, o);
    return n + 1;
  }

  /** Yaw-only instance transform (column-major) + local crystal direction into aD.zw. */
  private writeMatrix(
    n: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    cp: THREE.Vector3,
    D: Float32Array,
    o: number,
  ): void {
    const M = this.body.instanceMatrix.array as Float32Array;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    let dx = cp.x - x;
    let dz = cp.z - z;
    const dl = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= dl;
    dz /= dl;
    D[o + 2] = dx * c - dz * s;
    D[o + 3] = dx * s + dz * c;
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
    M[m + 12] = x;
    M[m + 13] = y;
    M[m + 14] = z;
    M[m + 15] = 1;
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
      if (e.kind !== 'cranes') {
        const rk = e.kind === 'blot' ? 1.55 : e.kind === 'redactor' ? 1.7 : 1.2;
        const r = e.radius * rk * (0.3 + 0.7 * e.spawnT);
        const vis = e.revealVis * (1 - dead) * (e.kind === 'smudge' || e.kind === 'misprint' ? 0.85 : 1);
        if (vis > 0.01) this.putFx(x - r, y, z, 2, x + r, y, z, r * 1.5, 0, e.seed, vis);
      }
      if (!e.alive) continue;
      this.writeKindFx(e, y);
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
      const reach = Math.max(e.drain * 1.4, e.windup * 0.75);
      if (e.kind === 'blot' && reach > 0.04) {
        this.putFx(x, y + 0.55, z, 3, cp.x, cp.y - 0.25, cp.z, 0.2, e.windup, e.seed, Math.min(1, reach));
      }
    }
    // crane dive telegraphs: the folding crane scratches its line at the player
    const cranes = sys.cranes;
    for (let i = 0; i < cranes.length; i++) {
      const c = cranes[i]!;
      if (!c.alive) continue;
      const gy = (c.swarm?.position.y ?? 0) + 0.03;
      // a small ground shadow sells the height
      const sr = 0.32;
      if (c.revealVis > 0.01)
        this.putFx(
          c.position.x - sr,
          gy,
          c.position.z,
          2,
          c.position.x + sr,
          gy,
          c.position.z,
          sr * 1.4,
          0,
          c.seed,
          c.revealVis,
        );
      if (c.mode !== CraneMode.Fold) continue;
      this.putFx(c.position.x, gy, c.position.z, 0, c.aimX, gy, c.aimZ, 0.16, c.fold, c.seed, 1);
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

  /** Ground marks for the wave-1 kinds (unmasked pencil/ink lines = fair telegraphs). */
  private writeKindFx(e: Enemy, y: number): void {
    const x = e.position.x;
    const z = e.position.z;
    if (e.kind === 'marginMan' && e.state === AiState.Stalk && e.phase === MARGIN_TELL) {
      const k = Math.min(1, e.timerA / Math.max(1e-3, this.system.tuning.enemies.marginAi.stepTell));
      this.putFx(x, y + 0.01, z, 0, e.bx, y + 0.01, e.bz, 0.14, k, e.seed, 1);
    } else if (e.kind === 'redactor' && e.shield > 0) {
      this.putFx(e.ax, y + 0.01, e.az, 0, e.bx, y + 0.01, e.bz, 0.1, 0.25, e.seed, 1);
    } else if (e.kind === 'panelWarden' && e.state === AiState.Attack) {
      const wa = this.system.tuning.enemies.wardenAi;
      const preview = e.phase === WARDEN_WINDUP;
      const h = preview ? wa.boxSize * 0.5 : e.boxHalf;
      if (h > 0 && (preview || e.phase === WARDEN_BOX)) this.putBox(e.ax, y + 0.015, e.az, h, preview, e);
    }
  }

  private putBox(cx: number, y: number, cz: number, h: number, preview: boolean, e: Enemy): void {
    const w = 0.22;
    const dash = preview ? 1 : 0;
    const x0 = cx - h;
    const x1 = cx + h;
    const z0 = cz - h;
    const z1 = cz + h;
    this.putFx(x0, y, z0, 4, x1, y, z0, w, 0, e.seed, 1, dash);
    this.putFx(x1, y, z0, 4, x1, y, z1, w, 0, e.seed, 1, dash);
    this.putFx(x1, y, z1, 4, x0, y, z1, w, 0, e.seed, 1, dash);
    this.putFx(x0, y, z1, 4, x0, y, z0, w, 0, e.seed, 1, dash);
    if (preview) return;
    // the seam: a dashed cut across one corner — dash through it
    const sx = e.seam & 1 ? 1 : -1;
    const sz = e.seam & 2 ? 1 : -1;
    const qx = cx + sx * h;
    const qz = cz + sz * h;
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 9);
    this.putFx(
      qx - sx * 0.9,
      y + 0.01,
      qz - sz * 0.9,
      0,
      qx + sx * 0.9,
      y + 0.01,
      qz + sz * 0.9,
      0.3,
      pulse,
      e.seed,
      1,
    );
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
    extra = 0,
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
    L[o + 3] = extra;
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
    if (e.kind === 'cranes') return; // each crane tears on its own (craneDeath)
    const paper = !INK_KIND[e.kind];
    const h = KIND_H[e.kind];
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
    if (e.kind === 'cranes') return;
    const paper = !INK_KIND[e.kind];
    const y = e.position.y + KIND_H[e.kind] * 0.85;
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

  craneDeath(c: CraneTarget): void {
    for (let k = 0; k < 7; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = 1.5 + Math.random() * 2;
      this.emit(
        0,
        c.position.x,
        c.position.y,
        c.position.z,
        Math.cos(a) * s,
        1 + Math.random() * 2,
        Math.sin(a) * s,
        0.08 + Math.random() * 0.08,
        0.9,
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
    this.refreshLabels();
    this.root.removeFromParent();
    if (this.system.fx === this) this.system.fx = null;
  }
}
