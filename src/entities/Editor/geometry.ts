/**
 * Tiny procedural modelling kit: append transformed primitives into one merged geometry per bone,
 * tagging every vertex with ramp / part / cloth attributes (see materials.ts).
 * Build-time only (allocations here are fine).
 */
import * as THREE from 'three';

export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private ramp: number[] = [];
  private part: number[] = [];
  private cloth: number[] = [];
  private idx: number[] = [];
  private m = new THREE.Matrix4();
  private nm = new THREE.Matrix3();
  private v = new THREE.Vector3();

  /**
   * Append `g` transformed by position/rotation(euler XYZ)/scale.
   * `cloth` may be a number or a function of the transformed vertex (local to this builder).
   */
  add(
    g: THREE.BufferGeometry,
    o: {
      p?: [number, number, number];
      r?: [number, number, number];
      s?: [number, number, number] | number;
      ramp: number;
      part: number;
      cloth?: number | ((x: number, y: number, z: number) => number);
    },
  ): this {
    const s = typeof o.s === 'number' ? [o.s, o.s, o.s] : (o.s ?? [1, 1, 1]);
    this.m.compose(
      new THREE.Vector3(...(o.p ?? [0, 0, 0])),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.r ?? [0, 0, 0]))),
      new THREE.Vector3(s[0], s[1], s[2]),
    );
    this.nm.getNormalMatrix(this.m);
    const base = this.pos.length / 3;
    const P = g.getAttribute('position');
    const N = g.getAttribute('normal');
    const U = g.getAttribute('uv');
    for (let i = 0; i < P.count; i++) {
      this.v.fromBufferAttribute(P, i).applyMatrix4(this.m);
      this.pos.push(this.v.x, this.v.y, this.v.z);
      const cl = typeof o.cloth === 'function' ? o.cloth(this.v.x, this.v.y, this.v.z) : (o.cloth ?? 0);
      this.v.fromBufferAttribute(N, i).applyMatrix3(this.nm).normalize();
      this.nor.push(this.v.x, this.v.y, this.v.z);
      this.uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
      this.ramp.push(o.ramp);
      this.part.push(o.part);
      this.cloth.push(cl);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
    // flip winding for mirrored transforms
    if (this.m.determinant() < 0) {
      for (let i = this.idx.length - (index ? index.count : P.count); i < this.idx.length; i += 3) {
        const t = this.idx[i + 1]!;
        this.idx[i + 1] = this.idx[i + 2]!;
        this.idx[i + 2] = t;
      }
    }
    g.dispose();
    return this;
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aRamp', new THREE.Float32BufferAttribute(this.ramp, 1));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aCloth', new THREE.Float32BufferAttribute(this.cloth, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Lathe from [radius, y] pairs, with optional per-point z-squash done via scale later. */
export function lathe(profile: [number, number][], segs = 20, phiStart = 0, phiLength = Math.PI * 2) {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    segs,
    phiStart,
    phiLength,
  );
}

/** Tapered cylinder along +Y from 0..len (base at origin). */
export function limb(r0: number, r1: number, len = 1, radial = 10, hs = 4): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, hs, false);
  g.translate(0, len / 2, 0);
  return g;
}

export function ball(r: number, w = 12, h = 9): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, w, h);
}

/** Wobble existing vertices a little so primitives read hand-made, not CAD. */
export function wobble(g: THREE.BufferGeometry, amt: number, freq = 2.3, seed = 1): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const n =
      Math.sin(x * freq + seed) * Math.cos(y * freq * 1.3 + seed * 2) * Math.sin(z * freq * 0.7 + seed * 3);
    p.setXYZ(i, x * (1 + n * amt), y, z * (1 + n * amt));
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Pencil-sketch construction strokes as one ribbon mesh (screen-space width in the shader).
 * Each polyline gets `aNext` (next point), `aSide` ±1, `aAlong` (metres along), `aSeed`.
 */
export function strokeGeometry(lines: THREE.Vector3[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const next: number[] = [];
  const side: number[] = [];
  const along: number[] = [];
  const seed: number[] = [];
  const idx: number[] = [];
  let li = 0;
  for (const line of lines) {
    const s = (li++ * 0.6180339) % 1;
    let acc = 0;
    for (let i = 0; i < line.length; i++) {
      const a = line[i]!;
      const b = line[Math.min(i + 1, line.length - 1)]!;
      const prev = line[Math.max(i - 1, 0)]!;
      const nb = i === line.length - 1 ? a.clone().multiplyScalar(2).sub(prev) : b;
      if (i > 0) acc += a.distanceTo(prev);
      for (const sd of [-1, 1]) {
        pos.push(a.x, a.y, a.z);
        next.push(nb.x, nb.y, nb.z);
        side.push(sd);
        along.push(acc);
        seed.push(s);
      }
      if (i < line.length - 1) {
        const k = pos.length / 3 - 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aNext', new THREE.Float32BufferAttribute(next, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Loose hand-drawn ellipse (overshoots its start like a real pencil loop). */
export function sketchEllipse(
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  rz: number,
  seed: number,
  turns = 1.12,
  tilt = 0,
): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2 * turns + seed;
    const w = 1 + Math.sin(t * 3 + seed * 5) * 0.04 + (i / n) * 0.05;
    pts.push(
      new THREE.Vector3(cx + Math.cos(t) * rx * w, cy + Math.sin(t) * tilt, cz + Math.sin(t) * rz * w),
    );
  }
  return pts;
}

/** Slightly bowed line with overshoot ends. */
export function sketchLine(a: THREE.Vector3, b: THREE.Vector3, bow: number, seed: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const d = b.clone().sub(a);
  const ext = 0.08 + (seed % 0.1);
  const perp = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(bow);
  if (perp.lengthSq() === 0) perp.set(bow, 0, 0);
  for (let i = 0; i <= 12; i++) {
    const t = -ext + (i / 12) * (1 + ext * 2);
    const s = Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
    pts.push(a.clone().addScaledVector(d, t).addScaledVector(perp, s));
  }
  return pts;
}
