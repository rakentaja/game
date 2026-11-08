/**
 * DEV HARNESS ONLY — boss arena dressing (POC-style forest ring, ground, rocks), target registry,
 * collision. Stand-ins for the levels / enemies workstreams.
 */
import * as THREE from 'three';
import type { CollisionAPI, Damageable, TargetRegistry } from '../../core/types';
import { TUNING } from '../../data/tuning';
import type { StubRender } from './render';

export class StubTargets implements TargetRegistry {
  private list: Damageable[] = [];
  add(t: Damageable): void {
    if (!this.list.includes(t)) this.list.push(t);
  }
  remove(t: Damageable): void {
    const i = this.list.indexOf(t);
    if (i >= 0) this.list.splice(i, 1);
  }
  nearest(p: THREE.Vector3, maxRange: number): Damageable | null {
    let best: Damageable | null = null;
    let bd = maxRange * maxRange;
    for (const t of this.list) {
      if (!t.alive || !t.revealed) continue;
      const d = t.position.distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }
  forEach(fn: (t: Damageable) => void): void {
    for (const t of this.list) fn(t);
  }
}

export class StubCollision implements CollisionAPI {
  groundHeight(): number {
    return 0;
  }
  resolveCircle(x: number, z: number, r: number, out: THREE.Vector2): boolean {
    const [cx, cz, R] = TUNING.boss.arena;
    let nx = x;
    let nz = z;
    const dx = nx - cx;
    const dz = nz - cz;
    const d = Math.hypot(dx, dz);
    if (d > R - r) {
      nx = cx + (dx / d) * (R - r);
      nz = cz + (dz / d) * (R - r);
    }
    const [bx, bz] = TUNING.boss.pos;
    const ex = nx - bx;
    const ez = nz - bz;
    const e = Math.hypot(ex, ez);
    const br = TUNING.boss.bodyRadius + r;
    if (e < br) {
      nx = bx + (ex / (e || 1)) * br;
      nz = bz + (ez / (e || 1)) * br;
    }
    out.set(nx, nz);
    return nx !== x || nz !== z;
  }
  walkable(x: number, z: number): boolean {
    const [cx, cz, R] = TUNING.boss.arena;
    return Math.hypot(x - cx, z - cz) <= R;
  }
  segmentClear(): boolean {
    return true;
  }
}

let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

export function buildArena(render: StubRender): THREE.Group {
  const g = new THREE.Group();
  g.name = 'arena';
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80, 1, 1).rotateX(-Math.PI / 2),
    render.createInkMaterial({ ramp: 'teal', ground: true, keyAmt: 0.7, glowAmt: 0.9 }),
  );
  g.add(ground);
  const treeMat = render.createInkMaterial({ ramp: 'teal', keyAmt: 0.75, glowAmt: 0.35 });
  const trunk = (x: number, z: number, h: number, r0: number, tw: number) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push(
        new THREE.Vector3(
          x + Math.sin(t * 3 + tw) * 0.5 * t + (rnd() - 0.5) * 0.15,
          t * h,
          z + Math.cos(t * 2.3 + tw) * 0.4 * t + (rnd() - 0.5) * 0.15,
        ),
      );
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curve, 30, 1, 9, false);
    const pos = geo.attributes.position!;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const ring = Math.floor(i / 10);
      const t = ring / 30;
      const c = curve.getPointAt(Math.min(1, t));
      const r = r0 * (1 - 0.65 * t) * (1 + 1.6 * (Math.max(0, 0.12 - t) / 0.12) ** 2);
      v.fromBufferAttribute(pos, i).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, treeMat));
    for (let b = 0; b < 2; b++) {
      const p = curve.getPointAt(0.45 + rnd() * 0.35);
      const dir = new THREE.Vector3(rnd() - 0.5, 0.6, rnd() - 0.5).normalize();
      const bp = [
        p.clone(),
        p
          .clone()
          .addScaledVector(dir, 1.1)
          .add(new THREE.Vector3((rnd() - 0.5) * 0.5, 0.3, 0)),
        p
          .clone()
          .addScaledVector(dir, 2.3)
          .add(new THREE.Vector3((rnd() - 0.5) * 0.8, 0.7, 0)),
      ];
      g.add(
        new THREE.Mesh(
          new THREE.TubeGeometry(new THREE.CatmullRomCurve3(bp), 10, 0.07 + rnd() * 0.04, 6),
          treeMat,
        ),
      );
    }
  };
  const [cx, cz, R] = TUNING.boss.arena;
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rnd() * 0.15;
    const rr = R + 2.2 + rnd() * 4.5;
    const x = cx + Math.sin(a) * rr;
    const z = cz + Math.cos(a) * rr;
    // keep the camera side (south) sparse so trees don't block the view
    if (z > cz + R * 0.55 && Math.abs(x) < R * 0.9) continue;
    trunk(x, z, 7 + rnd() * 4, 0.3 + rnd() * 0.25, rnd() * 6);
  }
  for (let i = 0; i < 16; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = R * (0.65 + rnd() * 0.4);
    const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.2 + rnd() * 0.35, 0), treeMat);
    r.position.set(cx + Math.sin(a) * rr, 0.05, cz + Math.cos(a) * rr);
    r.scale.y = 0.5;
    r.rotation.set(rnd(), rnd(), rnd());
    g.add(r);
  }
  return g;
}
