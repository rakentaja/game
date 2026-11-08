import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { InkMaterialOptions } from '../core/types';
import type { Rng } from './rng';

export type MaterialFactory = (opts: InkMaterialOptions) => THREE.Material;

/** Strip to position+normal (uniform attribute sets merge cleanly; no maps on world geometry). */
export function clean(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(ng.attributes)) if (k !== 'position' && k !== 'normal') ng.deleteAttribute(k);
  if (ng !== g) g.dispose();
  if (!ng.attributes.normal) ng.computeVertexNormals();
  return ng;
}

export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!list.length) return null;
  const m = mergeGeometries(list.map(clean), false);
  for (const g of list) g.dispose();
  return m;
}

/** Box with its base at y (not centred), yaw rotation, hand-cut vertex wobble. */
export function box(
  cx: number,
  y: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  rotY = 0,
  rnd?: Rng,
  wobble = 0.03,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz, 1, 1, 1);
  g.translate(0, sy / 2, 0);
  if (rnd) {
    const p = g.attributes.position as THREE.BufferAttribute;
    // weld-aware wobble: same corner → same offset
    const seen = new Map<string, [number, number, number]>();
    for (let i = 0; i < p.count; i++) {
      const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
      let o = seen.get(key);
      if (!o) {
        o = [(rnd() - 0.5) * wobble * 2, (rnd() - 0.5) * wobble, (rnd() - 0.5) * wobble * 2];
        seen.set(key, o);
      }
      p.setXYZ(i, p.getX(i) + o[0], p.getY(i) + o[1], p.getZ(i) + o[2]);
    }
  }
  g.rotateY(rotY);
  g.translate(cx, y, cz);
  return g;
}

/** Tube along points with radius per point (taper). Low radial count for the inked look. */
export function tube(pts: THREE.Vector3[], radii: number[], radial = 6, segs = 0): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts);
  const s = segs || Math.max(3, pts.length * 2);
  const g = new THREE.TubeGeometry(curve, s, 1, radial, false);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const c = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const ring = Math.floor(i / (radial + 1));
    const t = ring / s;
    curve.getPointAt(t, c);
    const f = t * (radii.length - 1);
    const k = Math.min(radii.length - 2, Math.floor(f));
    const r = radii[k]! + (radii[k + 1]! - radii[k]!) * (f - k);
    v.fromBufferAttribute(pos, i).sub(c).multiplyScalar(r).add(c);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Flat ragged blob (ink stains, pools) lying at y, outline wobbled by noise. */
export function blob(cx: number, y: number, cz: number, r: number, rnd: Rng, seg = 28, ragged = 0.28) {
  const pos: number[] = [];
  const pts: [number, number][] = [];
  const ph = rnd() * 10;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const k =
      1 +
      Math.sin(a * 3 + ph) * ragged * 0.4 +
      Math.sin(a * 7 + ph * 2) * ragged * 0.25 +
      (rnd() - 0.5) * ragged * 0.6;
    pts.push([Math.cos(a) * r * k, Math.sin(a) * r * k * 0.85]);
  }
  for (let i = 0; i < seg; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % seg]!;
    pos.push(cx, y, cz, cx + b[0], y, cz + b[1], cx + a[0], y, cz + a[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function lathe(profile: [number, number][], seg = 10): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
  );
}

/** Ink splat: ragged pool plus satellite droplets (geometries at y, caller drapes them). */
export function splat(cx: number, y: number, cz: number, r: number, rnd: Rng): THREE.BufferGeometry[] {
  const out = [blob(cx, y, cz, r, rnd, 48, 0.3)];
  const n = 4 + Math.floor(rnd() * 5);
  for (let k = 0; k < n; k++) {
    const a = rnd() * Math.PI * 2;
    const d = r * (1.15 + rnd() * 0.8);
    out.push(blob(cx + Math.cos(a) * d, y, cz + Math.sin(a) * d, r * (0.07 + rnd() * 0.16), rnd, 10, 0.2));
  }
  return out;
}
