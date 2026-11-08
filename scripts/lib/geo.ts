/**
 * Tiny procedural geometry kit for original low-poly assets (eraser, stump, visor, pencil).
 * Faceted (flat-shaded) triangles: every triangle owns its vertices so the toon ramp reads the
 * planes crisply, like the POC models.
 */
import type { Document, Material, Mesh } from '@gltf-transform/core';
import { Matrix4, Vector3 } from 'three';

export class Geo {
  pos: number[] = [];
  uv: number[] = [];

  tri(a: Vector3, b: Vector3, c: Vector3, ua = [0, 0], ub = [1, 0], uc = [0, 1]): this {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.uv.push(...ua, ...ub, ...uc);
    return this;
  }
  quad(a: Vector3, b: Vector3, c: Vector3, d: Vector3): this {
    return this.tri(a, b, c, [0, 0], [1, 0], [1, 1]).tri(a, c, d, [0, 0], [1, 1], [0, 1]);
  }
  /** Append another geo, optionally transformed. */
  add(g: Geo, m?: Matrix4): this {
    const v = new Vector3();
    for (let i = 0; i < g.pos.length; i += 3) {
      v.fromArray(g.pos, i);
      if (m) v.applyMatrix4(m);
      this.pos.push(v.x, v.y, v.z);
    }
    this.uv.push(...g.uv);
    return this;
  }
  apply(m: Matrix4): this {
    const v = new Vector3();
    for (let i = 0; i < this.pos.length; i += 3) {
      v.fromArray(this.pos, i).applyMatrix4(m);
      v.toArray(this.pos, i);
    }
    return this;
  }
  /** Displace every vertex by fn(position). Shared corners move together (positions hashed). */
  displace(fn: (p: Vector3) => Vector3): this {
    const cache = new Map<string, Vector3>();
    const v = new Vector3();
    for (let i = 0; i < this.pos.length; i += 3) {
      v.fromArray(this.pos, i);
      const k = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
      let d = cache.get(k);
      if (!d) {
        d = fn(v.clone());
        cache.set(k, d);
      }
      d.toArray(this.pos, i);
    }
    return this;
  }
  /** Drop zero-area triangles (they would get zero-length normals). */
  clean(eps = 1e-24): this {
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const pos: number[] = [];
    const uv: number[] = [];
    for (let t = 0; t < this.pos.length / 9; t++) {
      a.fromArray(this.pos, t * 9);
      b.fromArray(this.pos, t * 9 + 3);
      c.fromArray(this.pos, t * 9 + 6);
      if (b.sub(a).cross(c.sub(a)).lengthSq() <= eps) continue;
      pos.push(...this.pos.slice(t * 9, t * 9 + 9));
      uv.push(...this.uv.slice(t * 6, t * 6 + 6));
    }
    this.pos = pos;
    this.uv = uv;
    return this;
  }
  get triangles(): number {
    return this.pos.length / 9;
  }
  normals(): Float32Array<ArrayBuffer> {
    const n = new Float32Array(this.pos.length);
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    for (let i = 0; i < this.pos.length; i += 9) {
      a.fromArray(this.pos, i);
      b.fromArray(this.pos, i + 3);
      c.fromArray(this.pos, i + 6);
      const f = b.sub(a).cross(c.sub(a)).normalize();
      for (let k = 0; k < 3; k++) f.toArray(n, i + k * 3);
    }
    return n;
  }
}

/** Closed prism along Y: polygon ring `ring(i)` at each y-level, with caps. */
export function loft(rings: Vector3[][], capBottom = true, capTop = true): Geo {
  const g = new Geo();
  for (let r = 0; r < rings.length - 1; r++) {
    const A = rings[r]!;
    const B = rings[r + 1]!;
    for (let i = 0; i < A.length; i++) {
      const j = (i + 1) % A.length;
      g.quad(A[i]!, A[j]!, B[j]!, B[i]!);
    }
  }
  const cap = (ring: Vector3[], flip: boolean) => {
    const c = ring.reduce((s, v) => s.add(v), new Vector3()).multiplyScalar(1 / ring.length);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      if (flip) g.tri(c, ring[j]!, ring[i]!);
      else g.tri(c, ring[i]!, ring[j]!);
    }
  };
  if (capBottom) cap(rings[0]!, true);
  if (capTop) cap(rings[rings.length - 1]!, false);
  return g;
}

/** Regular n-gon ring at height y (counter-clockwise seen from +Y). */
export function ring(
  n: number,
  r: number | ((i: number, a: number) => number),
  y: number | ((i: number) => number),
  phase = 0,
): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase - (i / n) * Math.PI * 2;
    const rr = typeof r === 'number' ? r : r(i, a);
    out.push(new Vector3(Math.cos(a) * rr, typeof y === 'number' ? y : y(i), Math.sin(a) * rr));
  }
  return out;
}

/**
 * Box with chamfered long edges and chamfered ends: sx along X (long axis), sy along Y, sz along Z.
 * Built as an octagonal prism lofted along Y, then turned so the loft axis becomes +X.
 */
export function chamferBox(sx: number, sy: number, sz: number, b: number): Geo {
  const hy = sy / 2;
  const hz = sz / 2;
  // octagon in the loft's XZ plane: its X is the final Y (height), its Z the final Z (depth)
  const oct = (y: number, inset: number) => {
    const ax = hy - inset;
    const az = hz - inset;
    const c = Math.min(b, ax, az);
    const pts: [number, number][] = [
      [ax, -az + c],
      [ax, az - c],
      [ax - c, az],
      [-ax + c, az],
      [-ax, az - c],
      [-ax, -az + c],
      [-ax + c, -az],
      [ax - c, -az],
    ];
    // same winding as ring(): clockwise seen from +Y
    return pts.reverse().map(([x, z]) => new Vector3(x, y, z));
  };
  const hx = sx / 2;
  const g = loft([oct(-hx, b), oct(-hx + b, 0), oct(hx - b, 0), oct(hx, b)]);
  // loft axis Y → X; loft X (height) → Y
  return g.apply(new Matrix4().makeRotationZ(-Math.PI / 2));
}

export interface PrimOptions {
  /** Skin all vertices rigidly to this joint index (requires the mesh to be on a skinned node). */
  joint?: number;
}

/** Add `geo` as a primitive (non-indexed → indexed by gltf-transform weld later). */
export function addPrimitive(
  doc: Document,
  mesh: Mesh,
  geo: Geo,
  material: Material,
  opt: PrimOptions = {},
): void {
  const buf = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  geo.clean();
  const n = geo.pos.length / 3;
  const prim = doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(geo.pos)).setBuffer(buf),
    )
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(geo.normals()).setBuffer(buf))
    .setAttribute(
      'TEXCOORD_0',
      doc.createAccessor().setType('VEC2').setArray(new Float32Array(geo.uv)).setBuffer(buf),
    );
  if (opt.joint !== undefined) {
    const j = new Uint8Array(n * 4);
    const w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      j[i * 4] = opt.joint;
      w[i * 4] = 1;
    }
    prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(j).setBuffer(buf));
    prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(w).setBuffer(buf));
  }
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buf));
  mesh.addPrimitive(prim);
}

/** Deterministic PRNG (mulberry32) so procedural assets are reproducible byte-for-byte. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
