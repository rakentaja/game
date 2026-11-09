/**
 * Editor-owned visuals that are not the body: lane/circle telegraph decals, weak-point blobs,
 * a pooled instanced particle system (eraser crumbs, ink, paper shreds) and the full-screen
 * ink cover for the death sequence. All pooled, allocation-free per frame.
 */
import * as THREE from 'three';
import { PAL } from '../../data/palette';
import type { Attack, EditorFSM, WeakPointState } from './fsm';
import {
  createIconSketchMaterial,
  createInkCoverMaterial,
  createParticleMaterial,
  createTelegraphMaterial,
  createWeakPointMaterial,
  type EditorUniforms,
} from './materials';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ───────────────────────────── Telegraphs ─────────────────────────────

class TelegraphView {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.ShaderMaterial;
  serial = -1;
  fade = 1;
  constructor(geo: THREE.PlaneGeometry, u: EditorUniforms) {
    this.mat = createTelegraphMaterial(u);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = 'Editor.telegraph';
  }

  sync(a: Attack, dt: number): void {
    const U = this.mat.uniforms;
    if (a.active) {
      if (a.serial !== this.serial) {
        this.serial = a.serial;
        this.fade = 0;
        const m = this.mesh;
        if (a.kind === 'drag') {
          const dx = a.bx - a.ax;
          const dz = a.bz - a.az;
          const len = Math.hypot(dx, dz) || 1;
          m.position.set((a.ax + a.bx) / 2, 0.04, (a.az + a.bz) / 2);
          m.rotation.set(0, Math.atan2(-dx / len, -dz / len), 0);
          m.scale.set(a.hw * 2, 1, len);
          U.uKind!.value = 0;
          U.uLen!.value = len;
          U.uWidthM!.value = a.hw * 2;
        } else {
          m.position.set(a.ax, 0.045, a.az);
          m.rotation.set(0, 0, 0);
          m.scale.set(a.hw * 2, 1, a.hw * 2);
          U.uKind!.value = 1;
        }
      }
      this.mesh.visible = true;
      if (a.stage === 'telegraph') {
        U.uProg!.value = a.kind === 'drag' ? smooth(0, 1, a.p) : a.p;
        U.uStrike!.value = 0;
        U.uFade!.value = 0;
      } else {
        U.uStrike!.value = 1;
        U.uProg!.value = a.kind === 'drag' ? (a.stage === 'strike' ? a.p : 1) : 1;
        this.fade = Math.min(1, this.fade + dt * (a.stage === 'recover' ? 1.2 : 0.3));
        U.uFade!.value = a.kind === 'drag' ? this.fade * 0.8 : Math.min(1, this.fade * 3);
      }
    } else if (this.mesh.visible) {
      this.fade = Math.min(1, this.fade + dt * 3);
      U.uFade!.value = Math.max(U.uFade!.value as number, this.fade);
      if (this.fade >= 1) this.mesh.visible = false;
    }
  }
}

export class Telegraphs {
  readonly group = new THREE.Group();
  private views: TelegraphView[] = [];
  private geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  constructor(u: EditorUniforms, count: number) {
    for (let i = 0; i < count; i++) {
      const v = new TelegraphView(this.geo, u);
      this.views.push(v);
      this.group.add(v.mesh);
    }
    this.group.name = 'Editor.telegraphs';
  }
  update(fsm: EditorFSM, dt: number): void {
    for (let i = 0; i < this.views.length; i++) this.views[i]!.sync(fsm.attacks[i]!, dt);
  }
  hideAll(): void {
    for (const v of this.views) {
      v.mesh.visible = false;
      v.serial = -1;
    }
  }
  dispose(): void {
    this.geo.dispose();
    for (const v of this.views) v.mat.dispose();
  }
}

// ───────────────────────────── Icon sketch decals ─────────────────────────────

/**
 * A flat pencil icon on the arena floor: the cut verb's sketch (print it to restore the verb) or
 * the scribble where the Editor's left hand draws a summon. One mesh, icon swapped by uniform.
 */
export class IconDecal {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.ShaderMaterial;
  private fade = 1;
  constructor(geo: THREE.PlaneGeometry, u: EditorUniforms, name: string) {
    this.mat = createIconSketchMaterial(u, 0);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = name;
  }
  /** show=false fades it out. draw/print 0..1. */
  sync(
    show: boolean,
    icon: number,
    x: number,
    z: number,
    size: number,
    draw: number,
    print: number,
    dt: number,
  ): void {
    const U = this.mat.uniforms;
    this.fade += ((show ? 0 : 1) - this.fade) * (1 - Math.exp(-(show ? 10 : 5) * dt));
    if (show) {
      this.mesh.position.set(x, 0.05, z);
      this.mesh.scale.set(size * 2, 1, size * 2);
      U.uIcon!.value = icon;
      U.uDraw!.value = draw;
      U.uPrint!.value = print;
    }
    U.uFade!.value = this.fade;
    this.mesh.visible = this.fade < 0.98;
  }
  hide(): void {
    this.fade = 1;
    this.mesh.visible = false;
  }
  dispose(): void {
    this.mat.dispose();
  }
}

// ───────────────────────────── Particles ─────────────────────────────

export const Shape = { Blob: 0, Crumb: 1, Shred: 2 } as const;
export type Shape = (typeof Shape)[keyof typeof Shape];

export class InkParticles {
  readonly mesh: THREE.InstancedMesh;
  private readonly n: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private ttl: Float32Array;
  private grav: Float32Array;
  private spin: Float32Array;
  private data: THREE.InstancedBufferAttribute;
  private color: THREE.InstancedBufferAttribute;
  private cursor = 0;
  private mat: THREE.ShaderMaterial;
  readonly colors = {
    ink: new THREE.Color(PAL.ink),
    paper: new THREE.Color(PAL.paper),
    pink: new THREE.Color(PAL.red[3]),
    salmon: new THREE.Color(PAL.red[2]),
    ghost: new THREE.Color(PAL.ghost[2]),
    graphite: new THREE.Color(PAL.staff[2]),
    glow: new THREE.Color(PAL.glowEdge),
    core: new THREE.Color(PAL.glowCore),
    red: new THREE.Color(PAL.red[1]),
  };

  constructor(u: EditorUniforms, count = 480) {
    this.n = count;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.data = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.data.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aData', this.data);
    geo.setAttribute('aColor', this.color);
    this.mat = createParticleMaterial(u);
    this.mesh = new THREE.InstancedMesh(geo, this.mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'Editor.particles';
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.ttl = new Float32Array(count);
    this.grav = new Float32Array(count);
    this.spin = new Float32Array(count);
    const m = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < count; i++) {
      m[i * 16] = 1;
      m[i * 16 + 5] = 1;
      m[i * 16 + 10] = 1;
      m[i * 16 + 15] = 1;
    }
  }

  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    shape: Shape,
    size: number,
    col: THREE.Color,
    ttl: number,
    gravity = 9,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = ttl;
    this.ttl[i] = ttl;
    this.grav[i] = gravity;
    this.spin[i] = (Math.random() - 0.5) * 14;
    const d = this.data.array as Float32Array;
    d[i * 4] = shape;
    d[i * 4 + 1] = Math.random() * 6.28;
    d[i * 4 + 2] = size;
    d[i * 4 + 3] = 1;
    const c = this.color.array as Float32Array;
    c[i * 3] = col.r;
    c[i * 3 + 1] = col.g;
    c[i * 3 + 2] = col.b;
    this.color.needsUpdate = true;
  }

  /** Radial burst helper. */
  burst(
    x: number,
    y: number,
    z: number,
    count: number,
    speed: number,
    up: number,
    shape: Shape,
    size: number,
    col: THREE.Color,
    ttl: number,
    gravity = 9,
  ): void {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.spawn(
        x,
        y,
        z,
        Math.cos(a) * s,
        up * (0.4 + Math.random() * 0.8),
        Math.sin(a) * s,
        shape,
        size * (0.6 + Math.random() * 0.8),
        col,
        ttl * (0.6 + Math.random() * 0.6),
        gravity,
      );
    }
  }

  update(dt: number): void {
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const d = this.data.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) {
        if (d[i * 4 + 2] !== 0) d[i * 4 + 2] = 0;
        continue;
      }
      this.life[i]! -= dt;
      const j = i * 3;
      this.vel[j + 1]! -= this.grav[i]! * dt;
      // paper shreds flutter
      if (d[i * 4] === Shape.Shred) {
        this.vel[j]! *= 1 - dt * 1.5;
        this.vel[j + 2]! *= 1 - dt * 1.5;
        this.vel[j + 1] = Math.max(this.vel[j + 1]!, -2.2);
      }
      this.pos[j]! += this.vel[j]! * dt;
      this.pos[j + 1]! += this.vel[j + 1]! * dt;
      this.pos[j + 2]! += this.vel[j + 2]! * dt;
      if (this.pos[j + 1]! < 0.03) {
        this.pos[j + 1] = 0.03;
        this.vel[j]! *= 0.4;
        this.vel[j + 1] = 0;
        this.vel[j + 2]! *= 0.4;
      }
      m[i * 16 + 12] = this.pos[j]!;
      m[i * 16 + 13] = this.pos[j + 1]!;
      m[i * 16 + 14] = this.pos[j + 2]!;
      d[i * 4 + 1]! += this.spin[i]! * dt;
      d[i * 4 + 3] = Math.max(0, this.life[i]! / this.ttl[i]!);
      if (this.life[i]! <= 0) d[i * 4 + 2] = 0;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.data.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ───────────────────────────── Weak points ─────────────────────────────

export class WeakPointView {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.ShaderMaterial;
  private exposedV = 0;
  private scaleV = 0;
  private lit = 1;
  constructor(
    readonly state: WeakPointState,
    geo: THREE.BufferGeometry,
    u: EditorUniforms,
  ) {
    this.mat = createWeakPointMaterial(u, state.index * 3.7);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = `Editor.weakpoint${state.index}`;
    this.mesh.visible = false;
  }

  update(fsm: EditorFSM, dt: number, radius: number, crystalLit: boolean): void {
    const w = this.state;
    const U = this.mat.uniforms;
    let show = false;
    let target = 0;
    const inPhase =
      fsm.phase === w.phase && (fsm.state === 'phase' || fsm.state === 'transition' || fsm.state === 'intro');
    if (inPhase) {
      if (w.phase === 1) {
        show = w.alive || fsm.state !== 'phase';
        target = w.exposed ? 1.15 : 0.7;
      } else if (w.phase === 2) {
        show = w.alive && fsm.state === 'phase';
        target = 1.25 + (w.printed ? 0.1 : 0);
      } else {
        show = w.alive || fsm.state !== 'phase';
        target = 0.55 + fsm.bowAmt * 0.7;
      }
    }
    if (!show) target = 0;
    this.scaleV += (target - this.scaleV) * (1 - Math.exp(-10 * dt));
    this.exposedV += ((w.exposed ? 1 : 0) - this.exposedV) * (1 - Math.exp(-12 * dt));
    this.lit += ((w.phase === 3 ? (crystalLit ? 1 : 0) : 1) - this.lit) * (1 - Math.exp(-8 * dt));
    const pulse = 1 + Math.sin(fsm.fightTime * 9 + w.index) * 0.06 * this.exposedV;
    const s = this.scaleV * radius * 0.45 * pulse * (1 + w.flash * 0.8);
    this.mesh.visible = s > 0.02;
    this.mesh.scale.setScalar(Math.max(0.001, s));
    this.mesh.position.set(w.x, w.y, w.z);
    U.uExposed!.value = this.exposedV;
    U.uFlash!.value = Math.min(1, w.flash * 3);
    U.uSketch!.value = w.phase === 2 ? (w.printed ? 0 : 1) : 0;
    U.uPrint!.value = w.phase === 2 ? w.print : 1;
    U.uDraw!.value = w.phase === 2 ? w.drawIn * 1.15 : 1.2;
    U.uLit!.value = this.lit;
    U.uWobble!.value = 0.12 + this.exposedV * 0.12 + w.flash * 0.5;
  }

  dispose(): void {
    this.mat.dispose();
  }
}

// ───────────────────────────── Ink cover ─────────────────────────────

export class InkCover {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.ShaderMaterial;
  constructor(u: EditorUniforms) {
    this.mat = createInkCoverMaterial(u);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1e6;
    this.mesh.visible = false;
    this.mesh.name = 'Editor.inkCover';
  }
  set(amount: number, cx: number, cy: number, aspect: number): void {
    const U = this.mat.uniforms;
    U.uAmt!.value = amount;
    (U.uCenter!.value as THREE.Vector2).set(cx, cy);
    U.uAspect!.value = aspect;
    this.mesh.visible = amount > 0.001;
  }
  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
