/**
 * Shared, pooled hero VFX (lazy chunk: only the non-Inker kits import it). Palette colours only,
 * one draw call per pool, no per-frame allocations:
 *
 *  - GroundLines : pencil / ruler / trace ribbons lying on the ground (dashed or solid)
 *  - Discs       : flat wobbly ink discs (puddles, colour flats with a halftone screen, rings)
 *  - Letters     : a glyph atlas drawn as instanced quads, flat on the ground or camera-facing
 *  - Rods        : a few thin boxes (thrown rulers)
 *
 * Kits create one `HeroFx` lazily when they first have a scene (headless tests never do).
 */
import * as THREE from 'three';
import { PAL } from '../../data/palette';

/** Palette slots shared by every hero shader (index → colour). */
export const C = {
  ink: 0,
  teal: 1,
  salmon: 2,
  gold: 3,
  cream: 4,
  pencil: 5,
  red: 6,
  tealDark: 7,
} as const;
export type ColorSlot = (typeof C)[keyof typeof C];
const PALETTE = [
  PAL.ink,
  PAL.teal[3],
  PAL.red[3],
  PAL.glowCore,
  PAL.ghost[3],
  PAL.staff[3],
  PAL.red[2],
  PAL.teal[2],
].map((c) => new THREE.Color(c));

const PAL_GLSL = /* glsl */ `
uniform vec3 uPal[8];
vec3 pal(float i){ int k = int(i + 0.5); vec3 c = uPal[0];
  for (int j = 0; j < 8; j++) if (j == k) c = uPal[j];
  return c; }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;

function palUniform(): THREE.IUniform {
  return { value: PALETTE };
}

// ───────────────────────────── Ground lines ─────────────────────────────

const LINES = 14;
const PTS = 72;

interface Line {
  active: boolean;
  col: number;
  width: number;
  life: number;
  age: number;
  dashed: number;
  n: number;
  xs: Float32Array;
  zs: Float32Array;
  ys: Float32Array;
}

export class GroundLines {
  readonly mesh: THREE.Mesh;
  private lines: Line[] = [];
  private pos: Float32Array;
  private attr: Float32Array; // col, fade, u (along), side
  private geo: THREE.BufferGeometry;
  private dirty = true;

  constructor() {
    for (let i = 0; i < LINES; i++)
      this.lines.push({
        active: false,
        col: 0,
        width: 0.06,
        life: 1,
        age: 0,
        dashed: 0,
        n: 0,
        xs: new Float32Array(PTS),
        zs: new Float32Array(PTS),
        ys: new Float32Array(PTS),
      });
    const verts = LINES * PTS * 2;
    this.pos = new Float32Array(verts * 3);
    this.attr = new Float32Array(verts * 4);
    const idx: number[] = [];
    for (let l = 0; l < LINES; l++)
      for (let i = 0; i < PTS - 1; i++) {
        const a = (l * PTS + i) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geo.setAttribute('aL', new THREE.BufferAttribute(this.attr, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uPal: palUniform() },
      vertexShader: /* glsl */ `
        attribute vec4 aL; varying vec4 vL;
        void main(){ vL = aL; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `${PAL_GLSL}
        varying vec4 vL;
        void main(){
          if (vL.y < 0.0) discard;
          float dashed = step(10.0, vL.x);
          float col = vL.x - dashed * 10.0;
          if (dashed > 0.5 && fract(vL.z * 1.6) > 0.55) discard;
          // graphite grain + dry-out as the line ages
          float n = hash(floor(gl_FragCoord.xy * 0.5));
          if (n < vL.y * vL.y * 0.85) discard;
          float edge = abs(vL.w - 0.5) * 2.0;
          vec3 c = pal(col);
          if (edge > 0.75) c = uPal[0];
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.layers.set(1);
    this.mesh.userData.noOutline = true;
    this.attr.fill(-1);
  }

  /** Start a line; returns its id (oldest recycled when full). */
  begin(col: number, width: number, life: number, dashed = false): number {
    let best = 0;
    let bestK = -1;
    for (let i = 0; i < LINES; i++) {
      const l = this.lines[i]!;
      if (!l.active) {
        best = i;
        bestK = 2;
        break;
      }
      const k = l.age / l.life;
      if (k > bestK) {
        bestK = k;
        best = i;
      }
    }
    const l = this.lines[best]!;
    l.active = true;
    l.col = col;
    l.width = width;
    l.life = life;
    l.age = 0;
    l.dashed = dashed ? 1 : 0;
    l.n = 0;
    this.dirty = true;
    return best;
  }

  push(id: number, x: number, y: number, z: number): void {
    const l = this.lines[id];
    if (!l?.active) return;
    if (l.n >= PTS) {
      l.xs.copyWithin(0, 1);
      l.zs.copyWithin(0, 1);
      l.ys.copyWithin(0, 1);
      l.n = PTS - 1;
    }
    l.xs[l.n] = x;
    l.ys[l.n] = y;
    l.zs[l.n++] = z;
    this.dirty = true;
  }

  /** Straight line a→b (rulers, panel grid). */
  segment(
    col: number,
    width: number,
    life: number,
    ax: number,
    az: number,
    bx: number,
    bz: number,
    y: number,
    dashed = false,
  ): number {
    const id = this.begin(col, width, life, dashed);
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.min(PTS, Math.max(2, Math.ceil(len / 0.6) + 1));
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      this.push(id, ax + (bx - ax) * t, y, az + (bz - az) * t);
    }
    return id;
  }

  /** Keep a line alive (refresh age) — used while the trace is still being drawn. */
  hold(id: number): void {
    const l = this.lines[id];
    if (l) l.age = 0;
  }

  end(id: number): void {
    const l = this.lines[id];
    if (l) l.active = false;
    this.dirty = true;
  }

  update(dt: number): void {
    for (const l of this.lines) {
      if (!l.active) continue;
      l.age += dt;
      if (l.age >= l.life) l.active = false;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const P = this.pos;
    const A = this.attr;
    for (let li = 0; li < LINES; li++) {
      const l = this.lines[li]!;
      const base = li * PTS * 2;
      const fade = l.active ? l.age / l.life : -1;
      let u = 0;
      for (let i = 0; i < PTS; i++) {
        const v = base + i * 2;
        if (!l.active || i >= l.n || l.n < 2) {
          A[v * 4 + 1] = A[v * 4 + 5] = -1;
          continue;
        }
        const j0 = Math.max(0, i - 1);
        const j1 = Math.min(l.n - 1, i + 1);
        let dx = l.xs[j1]! - l.xs[j0]!;
        let dz = l.zs[j1]! - l.zs[j0]!;
        const dl = Math.hypot(dx, dz) || 1;
        dx /= dl;
        dz /= dl;
        if (i > 0) u += Math.hypot(l.xs[i]! - l.xs[i - 1]!, l.zs[i]! - l.zs[i - 1]!);
        const w = l.width;
        const x = l.xs[i]!;
        const y = l.ys[i]! + 0.04;
        const z = l.zs[i]!;
        P[v * 3] = x - dz * w;
        P[v * 3 + 1] = y;
        P[v * 3 + 2] = z + dx * w;
        P[v * 3 + 3] = x + dz * w;
        P[v * 3 + 4] = y;
        P[v * 3 + 5] = z - dx * w;
        const col = l.col + l.dashed * 10;
        A[v * 4] = A[v * 4 + 4] = col;
        A[v * 4 + 1] = A[v * 4 + 5] = fade;
        A[v * 4 + 2] = A[v * 4 + 6] = u;
        A[v * 4 + 3] = 0;
        A[v * 4 + 7] = 1;
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aL as THREE.BufferAttribute).needsUpdate = true;
  }
}

// ───────────────────────────── Discs ─────────────────────────────

/** Disc looks. */
export const DISC = { solid: 0, halftone: 1, ring: 2, balloon: 3, dots: 4 } as const;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class Discs {
  readonly mesh: THREE.InstancedMesh;
  private data: THREE.InstancedBufferAttribute; // col, style, fade, seed
  private life: Float32Array;
  private age: Float32Array;
  private r: Float32Array;
  private x: Float32Array;
  private y: Float32Array;
  private z: Float32Array;
  private next = 0;

  constructor(readonly pool = 24) {
    const geo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.data = new THREE.InstancedBufferAttribute(new Float32Array(pool * 4), 4).setUsage(
      THREE.DynamicDrawUsage,
    );
    geo.setAttribute('aD', this.data);
    this.life = new Float32Array(pool);
    this.age = new Float32Array(pool).fill(1);
    this.r = new Float32Array(pool);
    this.x = new Float32Array(pool);
    this.y = new Float32Array(pool);
    this.z = new Float32Array(pool);
    this.life.fill(1);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uPal: palUniform() },
      vertexShader: /* glsl */ `
        attribute vec4 aD; varying vec4 vD; varying vec2 vP;
        void main(){ vD = aD; vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `${PAL_GLSL}
        varying vec4 vD; varying vec2 vP;
        void main(){
          float k = vD.z; if (k < 0.0 || k > 1.0) discard;
          float a = atan(vP.y, vP.x); float r = length(vP);
          float wob = 0.9 + 0.05 * sin(a * 5.0 + vD.w * 6.28) + 0.03 * sin(a * 11.0 - vD.w * 3.0);
          float grow = min(1.0, k * 8.0);
          float R = wob * (0.35 + 0.65 * grow) * (1.0 - smoothstep(0.85, 1.0, k) * 0.6);
          if (r > R) discard;
          float style = vD.y; vec3 c = pal(vD.x);
          float rim = step(R - 0.07, r);
          if (style > 0.5 && style < 1.5) {
            // colour flat: halftone screen with an ink rim
            vec2 g = fract(vP * 9.0) - 0.5;
            if (length(g) > 0.44 && r < R - 0.12) discard;
          } else if (style > 1.5 && style < 2.5) {
            if (r < R - 0.12) discard;
          } else if (style > 2.5 && style < 3.5) {
            c = uPal[4];
          } else if (style > 3.5) {
            vec2 g = fract(vP * 4.0) - 0.5; if (length(g) > 0.22) discard;
          }
          if (rim > 0.5 && style < 3.5) c = uPal[0];
          if (style > 2.5 && style < 3.5 && rim > 0.5) c = uPal[0];
          if (hash(floor(gl_FragCoord.xy * 0.5)) < smoothstep(0.7, 1.0, k)) discard;
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, pool);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.layers.set(1);
    this.mesh.userData.noOutline = true;
    for (let i = 0; i < pool; i++) this.data.setXYZW(i, 0, 0, -1, 0);
  }

  spawn(x: number, y: number, z: number, r: number, col: number, style: number, life: number): number {
    const i = this.next;
    this.next = (this.next + 1) % this.pool;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.r[i] = r;
    this.life[i] = Math.max(0.05, life);
    this.age[i] = 0;
    this.data.setXYZW(i, col, style, 0, (i * 0.618) % 1);
    this.place(i);
    return i;
  }

  move(i: number, x: number, y: number, z: number, r?: number): void {
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    if (r !== undefined) this.r[i] = r;
    this.place(i);
  }

  /** Refresh a disc's life (keep it alive). */
  refresh(i: number, life?: number): void {
    this.age[i] = 0;
    if (life !== undefined) this.life[i] = life;
  }

  kill(i: number): void {
    this.age[i] = this.life[i]!;
    this.data.setZ(i, -1);
    this.data.needsUpdate = true;
  }

  private place(i: number): void {
    _q.setFromAxisAngle(_up, i * 1.3);
    _s.set(this.r[i]!, 1, this.r[i]!);
    _p.set(this.x[i]!, this.y[i]! + 0.03 + (i % 5) * 0.004, this.z[i]!);
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.pool; i++) {
      if (this.age[i]! >= this.life[i]!) continue;
      this.age[i]! += dt;
      const k = this.age[i]! / this.life[i]!;
      this.data.setZ(i, k >= 1 ? -1 : k);
      any = true;
    }
    if (any) this.data.needsUpdate = true;
  }
}

// ───────────────────────────── Letters ─────────────────────────────

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ!-.?';
let atlasTex: THREE.CanvasTexture | null = null;

function drawAtlas(cv: HTMLCanvasElement): void {
  const g = cv.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, 512, 512);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '52px Bangers, Impact, "Arial Black", sans-serif';
  g.lineJoin = 'round';
  for (let i = 0; i < GLYPHS.length; i++) {
    const cx = (i % 8) * 64 + 32;
    const cy = Math.floor(i / 8) * 64 + 34;
    const ch = GLYPHS[i]!;
    g.lineWidth = 10;
    g.strokeStyle = '#00ff00';
    g.strokeText(ch, cx, cy);
    g.fillStyle = '#ff0000';
    g.fillText(ch, cx, cy);
  }
}

function atlas(): THREE.Texture {
  if (atlasTex) return atlasTex;
  // headless (co-op sims / tests): a blank texture; nothing is drawn there anyway
  if (typeof document === 'undefined') return new THREE.Texture();
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  drawAtlas(cv);
  const tex = new THREE.CanvasTexture(cv);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  atlasTex = tex;
  // the comic font may still be loading: redraw once it is
  void document.fonts
    ?.load('52px Bangers')
    .then(() => {
      drawAtlas(cv);
      tex.needsUpdate = true;
    })
    .catch(() => {});
  return tex;
}

export function glyphIndex(ch: string): number {
  const i = GLYPHS.indexOf(ch.toUpperCase());
  return i < 0 ? -1 : i;
}

/** Instanced glyph quads. `upright` = camera-facing (in flight); else lying flat on the ground. */
export class Letters {
  readonly mesh: THREE.InstancedMesh;
  private data: THREE.InstancedBufferAttribute; // glyph, col, fade, size
  private life: Float32Array;
  private age: Float32Array;
  private next = 0;

  constructor(
    readonly pool: number,
    readonly upright: boolean,
  ) {
    const geo = upright ? new THREE.PlaneGeometry(1, 1) : new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.data = new THREE.InstancedBufferAttribute(new Float32Array(pool * 4), 4).setUsage(
      THREE.DynamicDrawUsage,
    );
    geo.setAttribute('aG', this.data);
    this.life = new Float32Array(pool).fill(1);
    this.age = new Float32Array(pool).fill(1);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uPal: palUniform(), uAtlas: { value: atlas() } },
      vertexShader: upright
        ? /* glsl */ `
        attribute vec4 aG; varying vec4 vG; varying vec2 vUv;
        void main(){
          vG = aG; vUv = uv;
          vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec4 mv = viewMatrix * vec4(c, 1.0);
          mv.xy += position.xy * aG.w;
          gl_Position = projectionMatrix * mv;
        }`
        : /* glsl */ `
        attribute vec4 aG; varying vec4 vG; varying vec2 vUv;
        void main(){ vG = aG; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `${PAL_GLSL}
        uniform sampler2D uAtlas; varying vec4 vG; varying vec2 vUv;
        void main(){
          if (vG.z < 0.0 || vG.x < 0.0) discard;
          float gi = vG.x; vec2 cell = vec2(mod(gi, 8.0), floor(gi / 8.0));
          vec2 uv = (cell + vec2(vUv.x, 1.0 - vUv.y)) / 8.0; uv.y = 1.0 - uv.y;
          vec4 t = texture2D(uAtlas, uv);
          if (t.r < 0.5 && t.g < 0.5) discard;
          if (hash(floor(gl_FragCoord.xy * 0.5)) < smoothstep(0.75, 1.0, vG.z)) discard;
          gl_FragColor = vec4(t.r >= 0.5 ? pal(vG.y) : uPal[0], 1.0);
        }`,
      depthWrite: !upright,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, pool);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.mesh.layers.set(1);
    this.mesh.userData.noOutline = true;
    for (let i = 0; i < pool; i++) this.data.setXYZW(i, -1, 0, -1, 1);
  }

  spawn(
    ch: string,
    x: number,
    y: number,
    z: number,
    size: number,
    col: number,
    life: number,
    yaw = 0,
  ): number {
    const g = glyphIndex(ch);
    const i = this.next;
    this.next = (this.next + 1) % this.pool;
    this.life[i] = Math.max(0.05, life);
    this.age[i] = 0;
    this.data.setXYZW(i, g, col, 0, size);
    this.place(i, x, y, z, size, yaw);
    return i;
  }

  place(i: number, x: number, y: number, z: number, size: number, yaw = 0): void {
    _q.setFromAxisAngle(_up, yaw);
    if (this.upright) _s.set(1, 1, 1);
    else _s.set(size, 1, size);
    _p.set(x, y + (this.upright ? 0 : 0.05), z);
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setColor(i: number, col: number): void {
    this.data.setY(i, col);
    this.data.needsUpdate = true;
  }

  kill(i: number): void {
    this.age[i] = this.life[i]!;
    this.data.setZ(i, -1);
    this.data.needsUpdate = true;
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.pool; i++) {
      if (this.age[i]! >= this.life[i]!) continue;
      this.age[i]! += dt;
      const k = this.age[i]! / this.life[i]!;
      this.data.setZ(i, k >= 1 ? -1 : k);
      any = true;
    }
    if (any) this.data.needsUpdate = true;
  }
}

// ───────────────────────────── Rods (rulers) / figures (decoys) ─────────────────────────────

export function rod(col: number, len = 0.9): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.03, len),
    new THREE.MeshBasicMaterial({ color: PALETTE[col] }),
  );
  m.visible = false;
  m.frustumCulled = false;
  m.userData.noOutline = true;
  return m;
}

/** A flat-colour paper cut-out of the hero (Colorist decoys). */
export function figure(col: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 1.0, 2, 8),
    new THREE.MeshBasicMaterial({ color: PALETTE[col] }),
  );
  m.visible = false;
  m.frustumCulled = false;
  m.userData.noOutline = true;
  return m;
}

/** One bundle per kit. */
export class HeroFx {
  readonly root = new THREE.Group();
  readonly lines = new GroundLines();
  readonly discs = new Discs(28);
  readonly flat = new Letters(48, false);
  readonly air = new Letters(32, true);

  constructor(parent: THREE.Object3D) {
    this.root.name = 'hero-fx';
    this.root.add(this.lines.mesh, this.discs.mesh, this.flat.mesh, this.air.mesh);
    parent.add(this.root);
  }

  update(dt: number): void {
    this.lines.update(dt);
    this.discs.update(dt);
    this.flat.update(dt);
    this.air.update(dt);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
  }
}
