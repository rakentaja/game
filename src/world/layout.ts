import type { LevelDef } from '../core/types';
import { TUNING } from '../data/tuning';
import { inRect, makeHit, type PathSampler } from './path';
import { makeRng, range } from './rng';
import { levelBounds, makeOpenDistance, rectSdf } from './terrain';

/** One procedural tree. Pure data so collision/tests can use it without WebGL. */
export interface TreeSpot {
  x: number;
  z: number;
  /** Trunk base radius (also the collision circle). */
  r: number;
  height: number;
  twist: number;
  /** Lean direction (unit XZ) and amount (radians-ish), usually toward the path. */
  leanX: number;
  leanZ: number;
  lean: number;
  /** Short gnarled stump instead of a full tree (camera-side of the path). */
  stump: boolean;
  seed: number;
}

export interface RockSpot {
  x: number;
  z: number;
  r: number;
  /** Squash on Y. */
  sy: number;
  rot: number;
  /** Large rocks block movement and line of sight. */
  blocker: boolean;
}

export interface ScatterSpot {
  x: number;
  z: number;
  s: number;
  rot: number;
}

export interface Blocker {
  x: number;
  z: number;
  r: number;
  los: boolean;
}

export interface Layout {
  trees: TreeSpot[];
  rocks: RockSpot[];
  grass: ScatterSpot[];
  mushrooms: ScatterSpot[];
  blockers: Blocker[];
}

/**
 * Deterministic forest dressing for a LevelDef. Trees grow in a band beside the walkable shape,
 * densest at the edge and thinning into the dark; anything that would stand between the follow
 * camera (+Z, above) and the path becomes a low stump so the player is never hidden.
 */
export function buildLayout(def: LevelDef, path: PathSampler): Layout {
  const W = TUNING.world;
  const rnd = makeRng(def.seed);
  const openD = makeOpenDistance(def, path);
  const bounds = levelBounds(def, path, W.treeBand);
  const trees: TreeSpot[] = [];
  const rocks: RockSpot[] = [];
  const grass: ScatterSpot[] = [];
  const mushrooms: ScatterSpot[] = [];
  const hit = makeHit();
  const voids = def.voids ?? [];
  const lockRects = def.sketches.filter((s) => s.unlocks).map((s) => s.unlocks!);

  const inVoidish = (x: number, z: number, pad: number): boolean => {
    for (const v of voids) if (rectSdf(v.rect, x, z) < pad) return true;
    for (const r of lockRects) if (rectSdf(r, x, z) < pad) return true;
    return false;
  };

  /**
   * Would a tall trunk at (x,z) hide the walk from the follow camera (behind at +Z, above)?
   * Only the column straight "north" of the trunk matters: trees beside the walk frame it.
   */
  const occludes = (x: number, z: number, r: number): boolean => {
    const depth = W.cameraOcclusionDepth;
    for (let k = 1; k <= depth; k += 1) {
      for (let lx = -r - 0.4; lx <= r + 0.4; lx += r + 0.4) if (openD(x + lx, z - k) < -0.2) return true;
    }
    return false;
  };

  // jittered grid → organic but evenly spread trunks
  const sp = W.treeSpacing;
  const density = Math.max(0.05, def.treeDensity);
  for (let z = bounds[1]; z <= bounds[3]; z += sp) {
    for (let x = bounds[0]; x <= bounds[2]; x += sp) {
      const tx = x + range(rnd, -0.45, 0.45) * sp;
      const tz = z + range(rnd, -0.45, 0.45) * sp;
      const roll = rnd();
      const d = openD(tx, tz);
      if (d < W.edgeClearance + W.trunkRadius || d > W.treeBand) continue;
      if (inVoidish(tx, tz, 1.2)) continue;
      // wall of trunks near the edge, thinning outward
      const p = Math.min(1, density * (1.15 - 0.75 * (d / W.treeBand)));
      if (roll > p) continue;
      path.nearest(tx, tz, hit);
      // lean toward the walk so canopies arch over it
      let lx = hit.px - tx;
      let lz = hit.pz - tz;
      const ll = Math.hypot(lx, lz) || 1;
      lx /= ll;
      lz /= ll;
      const stump = occludes(tx, tz, 0.5);
      const near = 1 - Math.min(1, d / W.treeBand);
      trees.push({
        x: tx,
        z: tz,
        r: stump ? range(rnd, 0.28, 0.5) : range(rnd, 0.3, 0.52) * (0.8 + near * 0.45),
        height: stump ? range(rnd, 0.6, 1.3) : range(rnd, 5.5, 9.5),
        twist: range(rnd, 0, Math.PI * 2),
        leanX: lx,
        leanZ: lz,
        lean: stump ? 0 : range(rnd, 0.05, 0.3) * (0.5 + near),
        stump,
        seed: Math.floor(rnd() * 1e9),
      });
    }
  }

  // edge rows: trunks that wall the walk in (dense where the path narrows into a corridor)
  const tooClose = (x: number, z: number, d: number) =>
    trees.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < d * d);
  for (let a = 0; a < path.length; a += 1.7) {
    path.at(a, hit);
    const narrow = hit.halfW < 1.2;
    for (const side of [-1, 1]) {
      if (rnd() > (narrow ? 0.92 : 0.38) * Math.min(1.2, density + 0.3)) continue;
      const off = hit.halfW + W.edgeClearance + W.trunkRadius + range(rnd, 0.1, narrow ? 0.7 : 1.6);
      const tx = hit.px - hit.tz * off * side + range(rnd, -0.3, 0.3);
      const tz = hit.pz + hit.tx * off * side + range(rnd, -0.3, 0.3);
      if (openD(tx, tz) < W.edgeClearance + 0.3 || inVoidish(tx, tz, 1.2) || tooClose(tx, tz, 1.5)) continue;
      const stump = occludes(tx, tz, 0.5);
      trees.push({
        x: tx,
        z: tz,
        r: stump ? range(rnd, 0.28, 0.5) : range(rnd, 0.32, 0.55),
        height: stump ? range(rnd, 0.6, 1.3) : range(rnd, 6, 9.5),
        twist: range(rnd, 0, Math.PI * 2),
        leanX: (hit.px - tx) / off,
        leanZ: (hit.pz - tz) / off,
        lean: stump ? 0 : range(rnd, 0.08, 0.3),
        stump,
        seed: Math.floor(rnd() * 1e9),
      });
    }
  }

  // explicit props that are procedural trees (cover inside clearings etc.)
  for (const pr of def.props) {
    if (pr.asset !== 'proc:tree') continue;
    const s = pr.scale ?? 1;
    trees.push({
      x: pr.at[0],
      z: pr.at[2],
      r: 0.55 * s,
      height: range(rnd, 7, 9.5) * s,
      twist: pr.rotY ?? range(rnd, 0, 6.28),
      leanX: 0,
      leanZ: 1,
      lean: range(rnd, 0.02, 0.12),
      stump: false,
      seed: Math.floor(rnd() * 1e9),
    });
  }

  // rocks: pebbles hugging the path edge + occasional boulders out in the band
  const edgeRocks = Math.floor(path.length / 3.2);
  for (let i = 0; i < edgeRocks; i++) {
    path.at(rnd() * path.length, hit);
    const side = rnd() < 0.5 ? -1 : 1;
    const off = hit.halfW + range(rnd, 0.35, 1.6);
    const x = hit.px - hit.tz * off * side;
    const z = hit.pz + hit.tx * off * side;
    if (openD(x, z) < 0.25 || inVoidish(x, z, 0.4)) continue;
    rocks.push({
      x,
      z,
      r: range(rnd, 0.12, 0.38),
      sy: range(rnd, 0.35, 0.7),
      rot: rnd() * 6.28,
      blocker: false,
    });
  }
  for (let i = 0; i < Math.floor(path.length / 9); i++) {
    path.at(rnd() * path.length, hit);
    const side = rnd() < 0.5 ? -1 : 1;
    const off = hit.halfW + range(rnd, 1.4, 6);
    const x = hit.px - hit.tz * off * side;
    const z = hit.pz + hit.tx * off * side;
    if (openD(x, z) < 0.9 || inVoidish(x, z, 0.8)) continue;
    rocks.push({
      x,
      z,
      r: range(rnd, 0.6, 1.3),
      sy: range(rnd, 0.45, 0.75),
      rot: rnd() * 6.28,
      blocker: true,
    });
  }
  for (const pr of def.props) {
    if (pr.asset !== 'proc:rock' && pr.asset !== 'proc:boulder') continue;
    const s = pr.scale ?? 1;
    rocks.push({
      x: pr.at[0],
      z: pr.at[2],
      r: 0.9 * s,
      sy: 0.65,
      rot: pr.rotY ?? rnd() * 6.28,
      blocker: true,
    });
  }

  // grass tufts: thick along the edges, sparse in the walk
  const tufts = Math.floor(path.length * 4.5);
  for (let i = 0; i < tufts; i++) {
    path.at(rnd() * path.length, hit);
    const u = rnd();
    const off =
      (u < 0.25 ? range(rnd, 0, 0.8) : range(rnd, 0.75, 1.5)) * hit.halfW + (u < 0.25 ? 0 : rnd() * 2.5);
    const side = rnd() < 0.5 ? -1 : 1;
    const x = hit.px - hit.tz * off * side;
    const z = hit.pz + hit.tx * off * side;
    if (inVoidish(x, z, 0.2)) continue;
    grass.push({ x, z, s: range(rnd, 0.5, 1.15) * (u < 0.25 ? 0.6 : 1), rot: rnd() * 6.28 });
  }
  for (const c of def.clearings) {
    const n = Math.floor(c[2] * c[2] * 0.35);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283;
      const rr = c[2] * Math.sqrt(0.35 + 0.65 * rnd()) * 1.05;
      const x = c[0] + Math.cos(a) * rr;
      const z = c[1] + Math.sin(a) * rr;
      if (inVoidish(x, z, 0.2)) continue;
      grass.push({ x, z, s: range(rnd, 0.5, 1.1), rot: rnd() * 6.28 });
    }
  }

  // mushroom clusters at tree roots: warm accents in the teal wood
  for (const t of trees) {
    if (t.stump ? rnd() > 0.35 : rnd() > 0.12) continue;
    const k = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < k; i++) {
      const a = rnd() * 6.283;
      const rr = t.r + range(rnd, 0.1, 0.55);
      mushrooms.push({
        x: t.x + Math.cos(a) * rr,
        z: t.z + Math.sin(a) * rr,
        s: range(rnd, 0.5, 1.3),
        rot: rnd() * 6.28,
      });
    }
  }
  for (const pr of def.props) {
    if (pr.asset !== 'proc:mushroom') continue;
    mushrooms.push({ x: pr.at[0], z: pr.at[2], s: pr.scale ?? 1, rot: pr.rotY ?? 0 });
  }

  const blockers: Blocker[] = [];
  for (const t of trees) blockers.push({ x: t.x, z: t.z, r: t.r + 0.05, los: !t.stump });
  for (const r of rocks)
    if (r.blocker) blockers.push({ x: r.x, z: r.z, r: r.r * 0.9, los: r.sy * r.r > 0.5 });
  for (const pr of def.props) {
    if (!pr.asset.startsWith('proc:') || pr.asset === 'proc:mushroom') continue;
    if (pr.asset === 'proc:tree' || pr.asset === 'proc:rock' || pr.asset === 'proc:boulder') continue;
    const r = PROP_BLOCK_RADIUS[pr.asset];
    if (r) blockers.push({ x: pr.at[0], z: pr.at[2], r: r * (pr.scale ?? 1), los: r > 0.4 });
  }

  // never let dressing block the walk itself (explicit props excepted)
  return {
    trees,
    rocks,
    grass,
    mushrooms,
    blockers: blockers.filter((b) => !lockRects.some((r) => inRect(r, b.x, b.z))),
  };
}

/** Collision radius for procedural props by id (unknown ids don't block). */
export const PROP_BLOCK_RADIUS: Record<string, number> = {
  'proc:pillar': 0.7,
  'proc:brokenPillar': 0.75,
  'proc:gravestone': 0.4,
  'proc:lantern': 0.18,
  'proc:stump': 0.5,
  'proc:log': 0.5,
  'proc:page': 0,
  'proc:arch': 0.6,
};
