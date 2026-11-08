import * as THREE from 'three';
import type { LevelDef, SketchObjectDef } from '../core/types';
import { PAL } from '../data/palette';
import { TUNING } from '../data/tuning';
import type { SketchVisual } from '../systems/sketch-objects';
import { blob, box, lathe, type MaterialFactory, merge, splat, tube } from './geo';
import type { WellState } from './inkWells';
import type { RockSpot, TreeSpot } from './layout';
import { buildLevelData, type LevelData } from './levelData';
import {
  createGlowMaterial,
  createInkSurfaceMaterial,
  createMistMaterial,
  makeShared,
  type SharedLike,
} from './materials';
import { inRect, makeHit, type Rect } from './path';
import { createPencilMaterial, StrokeBuilder } from './pencil';
import { makeRng, type Rng, range } from './rng';
import { createSketchVisual } from './sketchVisual';
import { rectSdf } from './terrain';

export interface BuildOptions {
  /** `ctx.render.createInkMaterial` (or a dev stub). */
  material: MaterialFactory;
  /** Drawing-buffer size in px (pencil ribbons are screen-space). Keep it updated on resize. */
  resolution: THREE.Vector2;
  /** `ctx.render.shared` — uTime / uCrystalPos for level special surfaces. */
  shared?: Record<string, THREE.IUniform>;
  /** Manifest prop resolver (src/world/assets.ts). Return null → procedural fallback. */
  assets?: (id: string) => THREE.Object3D | null;
}

/** A small permanent reveal source the level wants (lanterns, wells). */
export interface Beacon {
  x: number;
  z: number;
  r: number;
}

export interface BuiltLevel {
  def: LevelDef;
  data: LevelData;
  root: THREE.Group;
  collision: LevelData['collision'];
  beacons: Beacon[];
  /** Factory for SketchObjects (`visuals` option). */
  sketchVisual: (def: SketchObjectDef) => SketchVisual;
  /** Sync well ink levels (InkWells.wells). */
  syncWells(wells: readonly WellState[]): void;
  update(dt: number, time: number): void;
  readonly stats: { meshes: number; triangles: number };
  dispose(): void;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Meshes tagged `userData.noOutline` (pencil strokes, mist) should be skipped by edge passes.
 *
 * Builds a page from its LevelDef: heightfield ground with a trodden path, procedural twisted
 * forest merged per spatial chunk, instanced rocks/grass/mushrooms, procedural props, void
 * dressing (chasm ink, cliff boulders, walls), ink wells, mist and the sketch visual factory.
 * Everything is deterministic from `def.seed`.
 */
export function buildLevel(def: LevelDef, opts: BuildOptions): BuiltLevel {
  const data = buildLevelData(def);
  const { height, layout, path } = data;
  const root = new THREE.Group();
  root.name = `level:${def.page}`;
  const shared = makeShared(opts.shared);
  const rnd = makeRng(def.seed ^ 0x5bd1e995);
  const owned: THREE.Material[] = [];
  const mat = (o: Parameters<MaterialFactory>[0]) => {
    const m = opts.material(o);
    owned.push(m);
    return m;
  };
  const gy = (x: number, z: number) => height.sample(x, z);
  const voids = def.voids ?? [];
  const lockRects = def.sketches.filter((s) => s.unlocks).map((s) => s.unlocks!);
  const updaters: ((dt: number, t: number) => void)[] = [];
  const add = (m: THREE.Object3D, name: string) => {
    m.name = name;
    root.add(m);
    return m;
  };

  // ───────────── ground ─────────────
  {
    const { nx, nz, x0, z0, cell } = height;
    const pos = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = (j * nx + i) * 3;
        pos[k] = x0 + i * cell;
        pos[k + 1] = height.h[j * nx + i]!;
        pos[k + 2] = z0 + j * cell;
      }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let o = 0;
    for (let j = 0; j < nz - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        // (a,c,b) + (c,d,b): matches Heightfield.sample's split
        idx[o++] = a;
        idx[o++] = c;
        idx[o++] = b;
        idx[o++] = c;
        idx[o++] = d;
        idx[o++] = b;
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    add(new THREE.Mesh(g, mat({ ramp: 'teal', ground: true, keyAmt: 0.7, glowAmt: 0.9 })), 'ground');
  }

  // ───────────── trodden path + clearings ─────────────
  {
    const pos: number[] = [];
    const n2 = makeRng(def.seed + 99);
    const edgeN = Array.from({ length: path.count }, () => [n2(), n2()] as const);
    const skip = (x: number, z: number) =>
      voids.some((v) => v.kind !== 'wall' && rectSdf(v.rect, x, z) < 0.15) ||
      lockRects.some(
        (r) => inRect(r, x, z) && voids.some((v) => v.kind !== 'wall' && rectSdf(v.rect, x, z) < 1),
      );
    const L: [number, number][] = [];
    const R: [number, number][] = [];
    for (let i = 0; i < path.count; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(path.count - 1, i + 1);
      let tx = path.xs[i1]! - path.xs[i0]!;
      let tz = path.zs[i1]! - path.zs[i0]!;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const e = edgeN[i]!;
      const smoothE = (k: 0 | 1) => {
        let s = 0;
        for (let d = -2; d <= 2; d++) s += edgeN[Math.max(0, Math.min(path.count - 1, i + d))]![k];
        return s / 5;
      };
      const wl = path.hw[i]! * (0.82 + smoothE(0) * 0.35) + (e[0] - 0.5) * 0.08;
      const wr = path.hw[i]! * (0.82 + smoothE(1) * 0.35) + (e[1] - 0.5) * 0.08;
      L.push([path.xs[i]! - tz * wl, path.zs[i]! + tx * wl]);
      R.push([path.xs[i]! + tz * wr, path.zs[i]! - tx * wr]);
    }
    const lift = 0.04;
    for (let i = 0; i < path.count - 1; i++) {
      const cx = (path.xs[i]! + path.xs[i + 1]!) / 2;
      const cz = (path.zs[i]! + path.zs[i + 1]!) / 2;
      if (skip(cx, cz)) continue;
      const a = L[i]!;
      const b = R[i]!;
      const c = L[i + 1]!;
      const d = R[i + 1]!;
      const P = (p: [number, number]) => [p[0], gy(p[0], p[1]) + lift, p[1]];
      pos.push(...P(a), ...P(c), ...P(b), ...P(b), ...P(c), ...P(d));
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pg.computeVertexNormals();
    const parts: THREE.BufferGeometry[] = [pg];
    for (const c of def.clearings) {
      const b = blob(c[0], 0, c[1], c[2] * 0.86, rnd, 72, 0.12);
      const p = b.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) p.setY(i, gy(p.getX(i), p.getZ(i)) + lift * 0.8);
      b.computeVertexNormals();
      // subdivide coarse fan by building a second, smaller ring for the slope (keeps it hugging the ground)
      parts.push(b);
    }
    const m = mat({ ramp: 'staff', ground: true, keyAmt: 1.25, glowAmt: 1.3 });
    (m as THREE.ShaderMaterial).polygonOffset = true;
    (m as THREE.ShaderMaterial).polygonOffsetFactor = -1;
    (m as THREE.ShaderMaterial).polygonOffsetUnits = -1;
    add(new THREE.Mesh(merge(parts)!, m), 'path');
  }

  // ───────────── forest (merged per chunk) ─────────────
  const treeMat = mat({ ramp: 'teal', keyAmt: 0.75, glowAmt: 0.35 });
  const chunk = TUNING.world.chunkSize;
  const chunks = new Map<string, THREE.BufferGeometry[]>();
  const toChunk = (x: number, z: number, g: THREE.BufferGeometry) => {
    const key = `${Math.floor(x / chunk)},${Math.floor(z / chunk)}`;
    let l = chunks.get(key);
    if (!l) {
      l = [];
      chunks.set(key, l);
    }
    l.push(g);
  };
  for (const t of layout.trees) {
    const tr = makeRng(t.seed);
    for (const g of treeGeometry(t, gy(t.x, t.z), tr)) toChunk(t.x, t.z, g);
  }

  // ───────────── props ─────────────
  const staffParts: THREE.BufferGeometry[] = [];
  const ghostParts: THREE.BufferGeometry[] = [];
  const redParts: THREE.BufferGeometry[] = [];
  const glowParts: THREE.BufferGeometry[] = [];
  const inkParts: THREE.BufferGeometry[] = [];
  const beacons: Beacon[] = [];
  const extraRocks: RockSpot[] = [];
  for (const pr of def.props) {
    const [x, , z] = pr.at;
    const y = gy(x, z);
    const s = pr.scale ?? 1;
    const ry = pr.rotY ?? 0;
    const pr2 = makeRng(Math.floor(x * 131 + z * 71 + def.seed));
    if (!pr.asset.startsWith('proc:') && opts.assets) {
      const obj = opts.assets(pr.asset);
      if (obj) {
        obj.position.set(x, y, z);
        obj.rotation.y = ry;
        obj.scale.setScalar(s);
        add(obj, `prop:${pr.asset}`);
        continue;
      }
    }
    const kind = procKind(pr.asset);
    switch (kind) {
      case 'lantern': {
        const parts = lanternGeometry(x, y, z, ry, s, pr2);
        staffParts.push(...parts.frame);
        glowParts.push(parts.glow);
        beacons.push({ x, z, r: 1.8 * s });
        break;
      }
      case 'gravestone':
        staffParts.push(...gravestoneGeometry(x, y, z, ry, s, pr2));
        break;
      case 'log':
        toChunk(x, z, logGeometry(x, y, z, ry, s, pr2));
        break;
      case 'stump':
        for (const g of treeGeometry(
          {
            x,
            z,
            r: 0.42 * s,
            height: 1.1 * s,
            twist: ry,
            leanX: 0,
            leanZ: 1,
            lean: 0,
            stump: true,
            detail: 1,
            seed: 7,
          },
          y,
          pr2,
        ))
          toChunk(x, z, g);
        break;
      case 'pillar':
        staffParts.push(...pillarGeometry(x, y, z, ry, s, pr2, false));
        break;
      case 'brokenPillar':
        staffParts.push(...pillarGeometry(x, y, z, ry, s, pr2, true));
        break;
      case 'arch':
        staffParts.push(...archGeometry(x, y, z, ry, s, pr2));
        break;
      case 'page': {
        const pg = pageGeometry(x, z, ry, s, pr2, gy);
        ghostParts.push(pg.sheet);
        inkParts.push(...pg.lines);
        break;
      }
      case 'inkpool': {
        // pool + satellite droplets, like a nib flick
        for (const b of splat(x, 0, z, 1.1 * s, pr2)) {
          const p = b.attributes.position as THREE.BufferAttribute;
          for (let i = 0; i < p.count; i++) p.setY(i, gy(p.getX(i), p.getZ(i)) + 0.05);
          inkParts.push(b);
        }
        break;
      }
      case 'stoneRing': {
        // flush paving slabs around an arena rim (scale = radius), a few tilted or missing
        const R = s;
        const n = Math.round(R * 2.6);
        for (let k = 0; k < n; k++) {
          if (pr2() < 0.12) continue;
          const a = (k / n) * Math.PI * 2 + ry;
          const rr = R + (pr2() - 0.5) * 0.3;
          const sx = x + Math.cos(a) * rr;
          const sz = z + Math.sin(a) * rr;
          const len = ((Math.PI * 2 * R) / n) * (0.82 + pr2() * 0.12);
          const slab = box(0, 0, 0, len, 0.16, 0.9 + pr2() * 0.3, 0, pr2, 0.04);
          slab.rotateZ((pr2() - 0.5) * 0.08);
          slab.rotateY(-a + Math.PI / 2);
          slab.translate(sx, gy(sx, sz) - 0.08, sz);
          staffParts.push(slab);
        }
        break;
      }
      case 'blocker':
      case 'mushroom':
      case 'tree':
      case 'rock':
        break; // handled by layout (instanced / forest)
      default:
        // unknown manifest id with no asset: a mossy boulder keeps the spot dressed
        extraRocks.push({ x, z, r: 0.6 * s, sy: 0.7, rot: ry, blocker: false });
    }
  }

  // ───────────── void dressing ─────────────
  for (const v of voids) {
    const r = v.rect;
    const along: 'x' | 'z' = r[2] - r[0] >= r[3] - r[1] ? 'x' : 'z';
    const lo = along === 'x' ? r[0] : r[1];
    const hi = along === 'x' ? r[2] : r[3];
    const gap = (p: number) =>
      lockRects.some((u) =>
        along === 'x' ? p > u[0] - 0.2 && p < u[2] + 0.2 : p > u[1] - 0.2 && p < u[3] + 0.2,
      );
    if (v.kind === 'chasm') {
      // ink river at the bottom + jagged rim rocks
      const iw = new THREE.PlaneGeometry(r[2] - r[0] + 2, r[3] - r[1] - 0.6, 1, 1);
      iw.rotateX(-Math.PI / 2);
      const cy = gy((r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
      iw.translate((r[0] + r[2]) / 2, cy + 0.9, (r[1] + r[3]) / 2);
      const inkRiver = new THREE.Mesh(iw, createInkSurfaceMaterial(shared, 1));
      owned.push(inkRiver.material as THREE.Material);
      add(inkRiver, 'chasm-ink');
      for (let p = lo; p <= hi; p += 0.9) {
        if (gap(p)) continue;
        for (const edge of along === 'x' ? [r[1], r[3]] : [r[0], r[2]]) {
          if (rnd() < 0.35) continue;
          const x = along === 'x' ? p + range(rnd, -0.3, 0.3) : edge + range(rnd, -0.3, 0.3);
          const z = along === 'x' ? edge + range(rnd, -0.3, 0.3) : p + range(rnd, -0.3, 0.3);
          extraRocks.push({
            x,
            z,
            r: range(rnd, 0.25, 0.6),
            sy: range(rnd, 0.6, 1.1),
            rot: rnd() * 6,
            blocker: false,
          });
        }
      }
    } else if (v.kind === 'cliff') {
      // stone retaining wall up the scarp (stairs leave the gap) + tumbled boulders at its foot
      const dLo = along === 'x' ? r[1] : r[0];
      const dHi = along === 'x' ? r[3] : r[2];
      const at = (p: number, d: number): [number, number] => (along === 'x' ? [p, d] : [d, p]);
      const hA = gy(...at((lo + hi) / 2, dLo));
      const hB = gy(...at((lo + hi) / 2, dHi));
      const lowSide = hA < hB ? dLo : dHi;
      const highSide = hA < hB ? dHi : dLo;
      const line = lowSide + (highSide - lowSide) * 0.62;
      for (let p = lo; p < hi; ) {
        const w = range(rnd, 0.7, 1.25);
        const mid = p + w / 2;
        if (!gap(mid)) {
          const [lx, lz] = at(mid, lowSide);
          const [hx, hz] = at(mid, highSide);
          const yLow = gy(lx, lz) - 0.4;
          const yTop = gy(hx, hz) + 0.25 + rnd() * 0.15;
          const rows = Math.max(2, Math.round((yTop - yLow) / 0.55));
          const rh = (yTop - yLow) / rows;
          for (let row = 0; row < rows; row++) {
            const off = row % 2 ? w * 0.3 : 0;
            const [x, z] = at(mid + off - w * 0.15, line + (lowSide - highSide) * 0.04 * (rows - row));
            staffParts.push(
              box(
                x,
                yLow + row * rh,
                z,
                along === 'x' ? w * 0.94 : 1.1,
                rh * 0.95,
                along === 'x' ? 1.1 : w * 0.94,
                range(rnd, -0.05, 0.05),
                rnd,
                0.07,
              ),
            );
          }
          if (rnd() < 0.6) {
            const [x, z] = at(
              mid + range(rnd, -0.3, 0.3),
              lowSide + (lowSide - highSide) * range(rnd, -0.05, 0.12),
            );
            extraRocks.push({
              x,
              z,
              r: range(rnd, 0.35, 0.8),
              sy: range(rnd, 0.6, 0.9),
              rot: rnd() * 6,
              blocker: false,
            });
          }
        }
        p += w;
      }
    } else {
      // dry-stone wall with the opening left for the sketch
      const across = along === 'x' ? (r[1] + r[3]) / 2 : (r[0] + r[2]) / 2;
      const hasDoor = def.sketches.some(
        (s) => s.type === 'bossDoor' && s.unlocks && inRectLoose(s.unlocks, r),
      );
      const H = hasDoor ? 2.4 : 1.2;
      for (let p = lo; p < hi; ) {
        const w = range(rnd, 0.6, 1.1);
        const mid = p + w / 2;
        if (!gap(mid)) {
          for (let row = 0; row < (hasDoor ? 4 : 2); row++) {
            const hh = H / (hasDoor ? 4 : 2);
            const x = along === 'x' ? mid : across;
            const z = along === 'x' ? across : mid;
            staffParts.push(
              box(
                x + (row % 2) * 0.15,
                gy(x, z) - 0.2 + row * hh,
                z,
                along === 'x' ? w * 0.96 : 0.9,
                hh * 0.97 + 0.2 * +(row === 0),
                along === 'x' ? 0.9 : w * 0.96,
                range(rnd, -0.06, 0.06),
                rnd,
                0.06,
              ),
            );
          }
        }
        p += w;
      }
    }
  }

  // merge chunked forest
  for (const [key, list] of chunks) {
    const g = merge(list);
    if (!g) continue;
    g.computeBoundingSphere();
    add(new THREE.Mesh(g, treeMat), `forest:${key}`);
  }
  if (staffParts.length)
    add(new THREE.Mesh(merge(staffParts)!, mat({ ramp: 'staff', keyAmt: 0.8, glowAmt: 1.1 })), 'props-stone');
  if (ghostParts.length)
    add(
      new THREE.Mesh(
        merge(ghostParts)!,
        mat({ ramp: 'ghost', keyAmt: 0.7, glowAmt: 1.0, side: THREE.DoubleSide }),
      ),
      'props-paper',
    );
  if (redParts.length) add(new THREE.Mesh(merge(redParts)!, mat({ ramp: 'red' })), 'props-red');
  const inkStill = createInkSurfaceMaterial(shared, 0);
  owned.push(inkStill);
  if (inkParts.length) add(new THREE.Mesh(merge(inkParts)!, inkStill), 'props-ink');
  const glowMat = createGlowMaterial(shared);
  owned.push(glowMat);
  if (glowParts.length) add(new THREE.Mesh(merge(glowParts)!, glowMat), 'props-glow');

  // ───────────── rocks (instanced, two silhouettes) ─────────────
  {
    const all = [...layout.rocks, ...extraRocks];
    const variants = [rockGeometry(makeRng(def.seed + 1)), rockGeometry(makeRng(def.seed + 2))];
    const rockMat = mat({ ramp: 'staff', keyAmt: 0.85, glowAmt: 0.8, instancing: true });
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (let vi = 0; vi < 2; vi++) {
      const list = all.filter((_, i) => i % 2 === vi);
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(variants[vi]!, rockMat, list.length);
      list.forEach((r, i) => {
        e.set(rnd() * 0.3, r.rot, rnd() * 0.3);
        q.setFromEuler(e);
        m4.compose(
          v3(r.x, gy(r.x, r.z) - r.r * r.sy * 0.25, r.z),
          q,
          v3(r.r, r.r * r.sy, r.r * (0.8 + rnd() * 0.3)),
        );
        im.setMatrixAt(i, m4);
      });
      im.computeBoundingSphere();
      add(im, `rocks:${vi}`);
    }
  }

  // ───────────── grass tufts + mushrooms (instanced) ─────────────
  {
    const tuft = tuftGeometry(makeRng(def.seed + 5));
    const gm = mat({ ramp: 'teal', keyAmt: 0.9, glowAmt: 1.2, instancing: true, side: THREE.DoubleSide });
    const im = new THREE.InstancedMesh(tuft, gm, Math.max(1, layout.grass.length));
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    layout.grass.forEach((s, i) => {
      q.setFromAxisAngle(v3(0, 1, 0), s.rot);
      m4.compose(v3(s.x, gy(s.x, s.z) - 0.02, s.z), q, v3(s.s, s.s * (0.8 + (i % 5) * 0.1), s.s));
      im.setMatrixAt(i, m4);
    });
    im.count = layout.grass.length;
    im.computeBoundingSphere();
    add(im, 'grass');

    const mush = mushroomGeometry();
    const mm = mat({ ramp: 'red', keyAmt: 0.8, glowAmt: 1.6, instancing: true });
    const im2 = new THREE.InstancedMesh(mush, mm, Math.max(1, layout.mushrooms.length));
    layout.mushrooms.forEach((s, i) => {
      q.setFromAxisAngle(v3(Math.sin(s.rot) * 0.2, 1, Math.cos(s.rot) * 0.2).normalize(), s.rot);
      m4.compose(v3(s.x, gy(s.x, s.z) - 0.01, s.z), q, v3(s.s, s.s * (0.7 + (i % 4) * 0.15), s.s));
      im2.setMatrixAt(i, m4);
    });
    im2.count = layout.mushrooms.length;
    im2.computeBoundingSphere();
    add(im2, 'mushrooms');
  }

  // ───────────── ink wells ─────────────
  const wellSurfaces: THREE.Mesh[] = [];
  {
    const basins: THREE.BufferGeometry[] = [];
    const wellRims: THREE.BufferGeometry[] = [];
    for (const [x, z] of def.inkWells) {
      const y = gy(x, z);
      const b = lathe(
        [
          [0.0, 0.0],
          [0.62, 0.0],
          [0.7, 0.18],
          [0.6, 0.32],
          [0.52, 0.5],
          [0.58, 0.58],
          [0.46, 0.6],
          [0.4, 0.3],
          [0.0, 0.28],
        ],
        9,
      );
      b.translate(x, y - 0.05, z);
      basins.push(b);
      const rim = new THREE.TorusGeometry(0.5, 0.035, 3, 14);
      rim.rotateX(Math.PI / 2);
      rim.translate(x, y + 0.6, z);
      wellRims.push(rim);
      const surf = new THREE.Mesh(
        new THREE.CircleGeometry(0.42, 14).rotateX(-Math.PI / 2),
        createWellInk(shared),
      );
      surf.position.set(x, y + 0.52, z);
      owned.push(surf.material as THREE.Material);
      add(surf, 'well-ink');
      wellSurfaces.push(surf);
      beacons.push({ x, z, r: TUNING.world.wellRevealRadius });
    }
    if (basins.length)
      add(new THREE.Mesh(merge(basins)!, mat({ ramp: 'staff', keyAmt: 0.8, glowAmt: 1.4 })), 'wells');
    if (wellRims.length) add(new THREE.Mesh(merge(wellRims)!, glowMat), 'well-rims');
  }

  // ───────────── mist ─────────────
  if (def.mist?.length) {
    const mm = createMistMaterial(shared);
    owned.push(mm);
    // camera-facing fog banks standing on the ground (instance scale = half width, height)
    const sheets: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    for (const [x, z, r] of def.mist) {
      const n = Math.max(4, Math.round(r * 1.6));
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const d = Math.sqrt(rnd()) * r * 0.85;
        const px = x + Math.cos(a) * d;
        const pz = z + Math.sin(a) * d;
        const pr = range(rnd, 0.9, 1.9);
        sheets.push(new THREE.Matrix4().compose(v3(px, gy(px, pz) + pr * 0.8, pz), q, v3(pr * 1.4, pr, 1)));
      }
    }
    const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), mm, sheets.length);
    sheets.forEach((m, i) => {
      im.setMatrixAt(i, m);
    });
    im.computeBoundingSphere();
    im.renderOrder = 3;
    im.userData.noOutline = true;
    add(im, 'mist');
  }

  // ───────────── wordless pencil hints on the ground ─────────────
  {
    const sb = new StrokeBuilder(def.seed + 17);
    const hh = makeHit();
    for (const t of def.triggers) {
      const a = t.action;
      if (a?.type !== 'tutorial' || (a.hint !== 'move' && a.hint !== 'dash')) continue;
      const cx = (t.rect[0] + t.rect[2]) / 2;
      const cz = (t.rect[1] + t.rect[3]) / 2;
      path.nearest(cx, cz, hh);
      const s0 = hh.s + (a.hint === 'move' ? 1.5 : 0);
      // chevrons marching up the walk (dash: tighter, doubled, with speed lines)
      const n = a.hint === 'move' ? 3 : 2;
      for (let k = 0; k < n; k++) {
        path.at(s0 + k * (a.hint === 'move' ? 1.1 : 0.55), hh);
        const w = a.hint === 'move' ? 0.55 : 0.7;
        const fx = hh.tx;
        const fz = hh.tz;
        const tipx = hh.px + fx * 0.4;
        const tipz = hh.pz + fz * 0.4;
        const lx = hh.px - fz * w - fx * 0.15;
        const lz = hh.pz + fx * w - fz * 0.15;
        const rx = hh.px + fz * w - fx * 0.15;
        const rz = hh.pz - fx * w - fz * 0.15;
        const y = (x: number, z: number) => gy(x, z) + 0.07;
        sb.poly([lx, y(lx, lz), lz, tipx, y(tipx, tipz), tipz, rx, y(rx, rz), rz], false, 2);
      }
      if (a.hint === 'dash') {
        for (const side of [-0.35, 0, 0.35]) {
          path.at(s0 - 1.4, hh);
          const ax = hh.px - hh.tz * side;
          const az = hh.pz + hh.tx * side;
          path.at(s0 - 0.4, hh);
          const bx = hh.px - hh.tz * side;
          const bz = hh.pz + hh.tx * side;
          sb.line(ax, gy(ax, az) + 0.07, az, bx, gy(bx, bz) + 0.07, bz, 1);
        }
      }
    }
    if (sb.segmentCount) {
      const pm = createPencilMaterial(opts.resolution, { width: 2.6, lead: PAL.ghost[3] });
      pm.uniforms.uDash.value = 0.9;
      owned.push(pm.mat);
      const hints = new THREE.Mesh(sb.build(), pm.mat);
      hints.userData.noOutline = true;
      hints.frustumCulled = false;
      add(hints, 'hints');
      updaters.push((_dt, time) => {
        pm.uniforms.uBoil.value = Math.floor(time * TUNING.boil.hz) * 0.37;
      });
    }
  }

  // ───────────── sketches ─────────────
  const sketchRoot = add(new THREE.Group(), 'sketches');
  const sketchVisual = (s: SketchObjectDef) =>
    createSketchVisual(s, {
      parent: sketchRoot,
      material: mat,
      resolution: opts.resolution,
      ground: gy,
      inkMat: inkStill,
    });

  const stats = { meshes: 0, triangles: 0 };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    stats.meshes++;
    const g = m.geometry;
    const tris = (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
    stats.triangles +=
      tris * ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1);
  });

  return {
    def,
    data,
    root,
    collision: data.collision,
    beacons,
    sketchVisual,
    syncWells(wells) {
      for (let i = 0; i < wells.length && i < wellSurfaces.length; i++) {
        const w = wells[i]!;
        const s = wellSurfaces[i]!;
        s.position.y = gy(w.x, w.z) + 0.2 + 0.32 * w.charge;
        s.scale.setScalar(0.75 + 0.25 * w.charge);
        (s.material as THREE.ShaderMaterial).uniforms.uCharge!.value = w.charge;
      }
    },
    update(dt, time) {
      for (const u of updaters) u(dt, time);
    },
    stats,
    dispose() {
      root.removeFromParent();
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const m of owned) m.dispose();
      owned.length = 0;
    },
  };
}

function inRectLoose(inner: Rect, outer: Rect): boolean {
  const cx = (inner[0] + inner[2]) / 2;
  const cz = (inner[1] + inner[3]) / 2;
  return cx >= outer[0] - 1 && cx <= outer[2] + 1 && cz >= outer[1] - 1 && cz <= outer[3] + 1;
}

function procKind(id: string): string {
  if (id.startsWith('proc:')) return id.slice(5);
  const s = id.toLowerCase();
  for (const k of [
    'lantern',
    'gravestone',
    'log',
    'stump',
    'pillar',
    'arch',
    'page',
    'mushroom',
    'tree',
    'rock',
  ]) {
    if (s.includes(k)) return k;
  }
  if (s.includes('grave') || s.includes('tomb')) return 'gravestone';
  return 'unknown';
}

/** Ink surface of a well: brimming wells shimmer with slow gold ripples; drained ones go flat. */
function createWellInk(shared: SharedLike): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uCharge: { value: 1 },
      uInk: { value: new THREE.Color(PAL.ink) },
      uSheen: { value: new THREE.Color(PAL.teal[1]) },
      uGlint: { value: new THREE.Color(PAL.glowCore) },
      uEdge: { value: new THREE.Color(PAL.glowEdge) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vL;
      void main(){ vL = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uCharge; uniform vec3 uInk, uSheen, uGlint, uEdge;
      varying vec2 vL;
      void main(){
        float r = length(vL) / 0.42;
        float w = fract(r * 2.2 - uTime * 0.45);
        float ring = step(0.82, w) * step(r, 0.92);
        vec3 c = mix(uInk, uSheen, step(0.6, fract(r * 3.0 + sin(atan(vL.y, vL.x) * 3.0) * 0.08)) * 0.5);
        c = mix(c, uEdge, ring * uCharge);
        c = mix(c, uGlint, step(r, 0.16 + 0.05 * sin(uTime * 3.0)) * uCharge);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

// ───────────── procedural geometry ─────────────

/** POC twisted trunk, improved: lean toward the walk, root flare, crooked claw branches, roots. */
export function treeGeometry(t: TreeSpot, y0: number, rnd: Rng): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const base = v3(t.x, y0 - 0.15, t.z);
  if (t.stump) {
    const h = t.height;
    const g = new THREE.CylinderGeometry(t.r * 0.8, t.r * 1.15, h, 8, 2, false);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y > h / 2 - 1e-3)
        p.setY(i, y + (rnd() - 0.3) * h * 0.45); // splintered top
      else if (y < -h / 2 + 1e-3) {
        p.setX(i, p.getX(i) * 1.25);
        p.setZ(i, p.getZ(i) * 1.25);
      }
    }
    g.computeVertexNormals();
    g.translate(base.x, base.y + h / 2, base.z);
    out.push(g);
    for (let k = 0; k < 3; k++) out.push(rootGeometry(base, t.r, rnd, k / 3));
    return out;
  }
  const n = 7;
  const pts: THREE.Vector3[] = [];
  const H = t.height;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const lean = t.lean * H * s * s;
    pts.push(
      v3(
        base.x + Math.sin(s * 3 + t.twist) * 0.38 * s + (rnd() - 0.5) * 0.14 + t.leanX * lean,
        base.y + s * H,
        base.z + Math.cos(s * 2.3 + t.twist) * 0.32 * s + (rnd() - 0.5) * 0.14 + t.leanZ * lean,
      ),
    );
  }
  const radii: number[] = [];
  for (let i = 0; i <= 10; i++) {
    const s = i / 10;
    radii.push(t.r * (1 - 0.72 * s) * (1 + 1.7 * (Math.max(0, 0.13 - s) / 0.13) ** 2));
  }
  out.push(tube(pts, radii, t.detail ? 7 : 5, t.detail ? 12 : 9));
  const curve = new THREE.CatmullRomCurve3(pts);
  // branches: crooked, reaching outward and over the walk
  const nb = t.detail ? 2 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 2);
  for (let b = 0; b < nb; b++) {
    const s = 0.42 + rnd() * 0.45;
    const p = curve.getPointAt(s);
    const toward = rnd() < 0.55;
    const ang = rnd() * Math.PI * 2;
    const dir = toward
      ? v3(t.leanX + (rnd() - 0.5) * 0.8, 0.35 + rnd() * 0.4, t.leanZ + (rnd() - 0.5) * 0.8).normalize()
      : v3(Math.cos(ang), 0.5 + rnd() * 0.5, Math.sin(ang)).normalize();
    const L = (1.1 + rnd() * 1.6) * (H / 7.5);
    const bp = [p.clone()];
    let cur = p.clone();
    for (let k = 1; k <= 3; k++) {
      cur = cur
        .clone()
        .addScaledVector(dir, L / 3)
        .add(v3((rnd() - 0.5) * 0.35, (rnd() - 0.4) * 0.3, (rnd() - 0.5) * 0.35));
      bp.push(cur);
    }
    const r0 = Math.max(0.035, t.r * (1 - 0.72 * s) * 0.55);
    out.push(tube(bp, [r0, r0 * 0.6, r0 * 0.35, 0.012], t.detail ? 5 : 4, t.detail ? 6 : 4));
    // a twig fork near the tip
    if (t.detail && rnd() < 0.7) {
      const fp = bp[2]!.clone();
      const fd = dir
        .clone()
        .add(v3((rnd() - 0.5) * 1.4, 0.4, (rnd() - 0.5) * 1.4))
        .normalize();
      out.push(
        tube(
          [
            fp,
            fp.clone().addScaledVector(fd, L * 0.3),
            fp
              .clone()
              .addScaledVector(fd, L * 0.5)
              .add(v3(0, 0.1, 0)),
          ],
          [r0 * 0.35, r0 * 0.2, 0.01],
          4,
          4,
        ),
      );
    }
  }
  // crown fork so tops aren't spikes
  const top = pts[n]!;
  for (let k = 0; k < 2; k++) {
    const a = t.twist + k * Math.PI + rnd();
    const d = v3(Math.cos(a), 0.9, Math.sin(a)).normalize();
    out.push(
      tube(
        [
          top.clone().add(v3(0, -0.3, 0)),
          top.clone().addScaledVector(d, 0.9),
          top
            .clone()
            .addScaledVector(d, 1.6)
            .add(v3(0, 0.2, 0)),
        ],
        [t.r * 0.3, t.r * 0.15, 0.012],
        3,
        4,
      ),
    );
  }
  const nr = t.detail ? 3 + Math.floor(rnd() * 2) : 0;
  for (let k = 0; k < nr; k++) out.push(rootGeometry(base, t.r, rnd, k / nr));
  return out;
}

function rootGeometry(base: THREE.Vector3, r: number, rnd: Rng, frac: number): THREE.BufferGeometry {
  const a = frac * Math.PI * 2 + rnd() * 0.8;
  const L = r * (2.4 + rnd() * 2.6);
  const d = v3(Math.cos(a), 0, Math.sin(a));
  const pts = [
    base
      .clone()
      .add(v3(0, 0.35 + r * 0.6, 0))
      .addScaledVector(d, r * 0.4),
    base
      .clone()
      .add(v3(0, 0.2, 0))
      .addScaledVector(d, L * 0.45),
    base
      .clone()
      .add(v3((rnd() - 0.5) * 0.3, 0.05, (rnd() - 0.5) * 0.3))
      .addScaledVector(d, L * 0.8),
    base
      .clone()
      .add(v3(0, -0.08, 0))
      .addScaledVector(d, L),
  ];
  return tube(pts, [r * 0.5, r * 0.32, r * 0.16, 0.02], 4, 4);
}

function rockGeometry(rnd: Rng): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const ng = g.toNonIndexed();
  g.dispose();
  const p = ng.attributes.position as THREE.BufferAttribute;
  const offs = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(2)},${p.getY(i).toFixed(2)},${p.getZ(i).toFixed(2)}`;
    let k = offs.get(key);
    if (k === undefined) {
      k = 0.72 + rnd() * 0.5;
      offs.set(key, k);
    }
    p.setXYZ(i, p.getX(i) * k, Math.max(-0.3, p.getY(i)) * k, p.getZ(i) * k);
  }
  ng.computeVertexNormals();
  return ng;
}

function tuftGeometry(rnd: Rng): THREE.BufferGeometry {
  const pos: number[] = [];
  const blades = 7;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + rnd() * 0.6;
    const lean = 0.08 + rnd() * 0.16;
    const h = 0.22 + rnd() * 0.26;
    const w = 0.025 + rnd() * 0.02;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const bx = cx * 0.05;
    const bz = cz * 0.05;
    const px = -cz * w;
    const pz = cx * w;
    pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, bx + cx * lean * 2.2, h, bz + cz * lean * 2.2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function mushroomGeometry(): THREE.BufferGeometry {
  const stem = new THREE.CylinderGeometry(0.022, 0.032, 0.14, 5);
  stem.translate(0, 0.07, 0);
  const cap = lathe(
    [
      [0.0, 0.2],
      [0.05, 0.195],
      [0.095, 0.16],
      [0.105, 0.12],
      [0.03, 0.13],
    ],
    7,
  );
  return merge([stem, cap])!;
}

function lanternGeometry(x: number, y: number, z: number, ry: number, s: number, rnd: Rng) {
  const frame: THREE.BufferGeometry[] = [];
  const H = 1.7 * s;
  const tilt = (rnd() - 0.5) * 0.12;
  const post = box(0, 0, 0, 0.1 * s, H, 0.1 * s);
  post.rotateZ(tilt);
  post.translate(x, y - 0.1, z);
  frame.push(post);
  const ax = Math.cos(ry) * 0.42 * s;
  const az = -Math.sin(ry) * 0.42 * s;
  const tx = x - Math.sin(tilt) * H;
  frame.push(box(tx + ax / 2, y + H - 0.12, z + az / 2, Math.abs(ax) + 0.07, 0.06, Math.abs(az) + 0.07));
  const lx = tx + ax;
  const lz = z + az;
  const ly = y + H - 0.62 * s;
  // cage: top cap, base, 4 bars
  frame.push(box(lx, ly + 0.4 * s, lz, 0.28 * s, 0.07 * s, 0.28 * s, ry));
  frame.push(box(lx, ly - 0.02, lz, 0.24 * s, 0.05 * s, 0.24 * s, ry));
  for (const [dx, dz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    frame.push(box(lx + dx * 0.1 * s, ly, lz + dz * 0.1 * s, 0.03 * s, 0.4 * s, 0.03 * s));
  }
  frame.push(box(lx, ly + 0.4 * s, lz, 0.04, 0.22 * s, 0.04));
  const glow = new THREE.OctahedronGeometry(0.11 * s, 0);
  glow.scale(0.8, 1.35, 0.8);
  glow.translate(lx, ly + 0.2 * s, lz);
  return { frame, glow };
}

function gravestoneGeometry(x: number, y: number, z: number, ry: number, s: number, rnd: Rng) {
  const tilt = (rnd() - 0.5) * 0.25;
  const slab = box(0, 0, 0, 0.62 * s, 0.85 * s, 0.17 * s, 0, rnd, 0.025);
  const top = new THREE.CylinderGeometry(0.31 * s, 0.31 * s, 0.17 * s, 9, 1, false, 0, Math.PI);
  top.rotateX(Math.PI / 2);
  top.rotateZ(Math.PI / 2);
  top.translate(0, 0.85 * s, 0);
  const g = merge([slab, top])!;
  g.rotateX(tilt);
  g.rotateY(ry);
  g.translate(x, y - 0.12, z);
  const mound = box(x, y - 0.25, z + 0.35 * s, 0.7 * s, 0.32, 0.9 * s, ry, rnd, 0.08);
  return [g, mound];
}

function logGeometry(x: number, y: number, z: number, ry: number, s: number, rnd: Rng) {
  const L = 3 * s;
  const c = Math.cos(ry);
  const sn = Math.sin(ry);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 4; i++) {
    const u = (i / 4 - 0.5) * L;
    pts.push(
      v3(
        x + u * c + (rnd() - 0.5) * 0.12,
        y + 0.22 * s + (rnd() - 0.5) * 0.08,
        z - u * sn + (rnd() - 0.5) * 0.12,
      ),
    );
  }
  const parts = [tube(pts, [0.3 * s, 0.34 * s, 0.32 * s, 0.28 * s, 0.24 * s], 7, 10)];
  for (let k = 0; k < 2; k++) {
    const p = pts[1 + k * 2]!;
    parts.push(
      tube(
        [p.clone(), p.clone().add(v3((rnd() - 0.5) * 0.4, 0.55 * s, (rnd() - 0.5) * 0.4))],
        [0.08 * s, 0.02],
        4,
        3,
      ),
    );
  }
  return merge(parts)!;
}

function pillarGeometry(x: number, y: number, z: number, ry: number, s: number, rnd: Rng, broken: boolean) {
  const out: THREE.BufferGeometry[] = [];
  const H = (broken ? 1.2 + rnd() * 0.8 : 3.2) * s;
  const R = 0.42 * s;
  out.push(box(x, y - 0.25, z, R * 2.6, 0.45, R * 2.6, ry, rnd, 0.05));
  const shaft = new THREE.CylinderGeometry(R * 0.92, R, H, 8, 3, false);
  const p = shaft.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (broken && p.getY(i) > H / 2 - 1e-3) p.setY(i, p.getY(i) - rnd() * 0.5 * s);
    const k = 1 + (rnd() - 0.5) * 0.06;
    p.setX(i, p.getX(i) * k);
    p.setZ(i, p.getZ(i) * k);
  }
  shaft.computeVertexNormals();
  const lean = (rnd() - 0.5) * 0.08;
  shaft.translate(0, H / 2, 0);
  shaft.rotateZ(lean);
  shaft.rotateY(ry);
  shaft.translate(x, y + 0.15, z);
  out.push(shaft);
  if (!broken) {
    out.push(box(x - Math.sin(lean) * H, y + H + 0.1, z, R * 2.5, 0.32 * s, R * 2.5, ry + 0.1, rnd, 0.04));
  } else {
    // fallen drum beside it
    const a = ry + 1.2 + rnd();
    const drum = new THREE.CylinderGeometry(R * 0.9, R * 0.9, 0.9 * s, 8);
    drum.rotateZ(Math.PI / 2);
    drum.rotateY(a);
    drum.translate(x + Math.cos(a) * 1.3 * s, y + R * 0.7, z + Math.sin(a) * 1.3 * s);
    out.push(drum);
  }
  return out;
}

function archGeometry(x: number, y: number, z: number, ry: number, s: number, rnd: Rng) {
  const out: THREE.BufferGeometry[] = [];
  const c = Math.cos(ry);
  const sn = Math.sin(ry);
  for (const k of [-1, 1]) {
    out.push(...pillarGeometry(x + k * 2.2 * s * c, y, z - k * 2.2 * s * sn, ry, s * 0.95, rnd, false));
  }
  out.push(box(x, y + 3.4 * s, z, 5.8 * s, 0.6 * s, 0.9 * s, ry, rnd, 0.05));
  out.push(box(x, y + 4.0 * s, z, 1.2 * s, 0.5 * s, 0.8 * s, ry, rnd, 0.05));
  return out;
}

function pageGeometry(
  x: number,
  z: number,
  ry: number,
  s: number,
  rnd: Rng,
  gy: (x: number, z: number) => number,
) {
  const W = 1.6 * s;
  const H = 2.2 * s;
  const g = new THREE.PlaneGeometry(W, H, 6, 8);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const c = Math.cos(ry);
  const sn = Math.sin(ry);
  const curl = rnd() * 0.3 + 0.15;
  const world = (lx: number, lz: number, lift: number): [number, number, number] => {
    const wx = x + lx * c + lz * sn;
    const wz = z - lx * sn + lz * c;
    return [wx, gy(wx, wz) + 0.06 + lift, wz];
  };
  for (let i = 0; i < p.count; i++) {
    let lx = p.getX(i);
    let lz = p.getZ(i);
    const edge = Math.abs(lx) > W / 2 - 1e-3 || Math.abs(lz) > H / 2 - 1e-3;
    if (edge) {
      lx += (rnd() - 0.5) * 0.12 * s;
      lz += (rnd() - 0.5) * 0.12 * s;
    }
    const u = (lx / W + 0.5) ** 3;
    const [wx, wy, wz] = world(lx, lz, u * curl + Math.sin(lz * 2) * 0.03);
    p.setXYZ(i, wx, wy, wz);
  }
  g.computeVertexNormals();
  // printed "text": rows of ink dashes
  const lines: THREE.BufferGeometry[] = [];
  for (let row = 0; row < 9; row++) {
    const lz = -H / 2 + 0.28 * s + row * 0.2 * s;
    let lx = -W / 2 + 0.18 * s;
    const end = W / 2 - 0.25 * s - (row === 8 ? W * 0.4 : 0);
    while (lx < end) {
      const wlen = (0.08 + rnd() * 0.22) * s;
      const a = world(lx, lz, (lx / W + 0.5) ** 3 * curl + 0.012);
      const b = world(Math.min(end, lx + wlen), lz, ((lx + wlen) / W + 0.5) ** 3 * curl + 0.012);
      const q = new THREE.BufferGeometry();
      const hw = 0.025 * s;
      const nx = -(b[2] - a[2]);
      const nz = b[0] - a[0];
      const nl = Math.hypot(nx, nz) || 1;
      const ox = (nx / nl) * hw;
      const oz = (nz / nl) * hw;
      q.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          [
            a[0] - ox,
            a[1],
            a[2] - oz,
            b[0] - ox,
            b[1],
            b[2] - oz,
            a[0] + ox,
            a[1],
            a[2] + oz,
            a[0] + ox,
            a[1],
            a[2] + oz,
            b[0] - ox,
            b[1],
            b[2] - oz,
            b[0] + ox,
            b[1],
            b[2] + oz,
          ],
          3,
        ),
      );
      q.computeVertexNormals();
      lines.push(q);
      lx += wlen + 0.06 * s;
    }
  }
  return { sheet: g, lines };
}
