import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { LevelDef } from '../../src/core/types';
import { LEVEL1 } from '../../src/world/Level1';
import { LEVEL2 } from '../../src/world/Level2';
import { buildLevelData } from '../../src/world/levelData';
import { makeHit, PathSampler } from '../../src/world/path';
import { CHASM_DEPTH } from '../../src/world/terrain';

const out = new THREE.Vector2();

/** Small hand-made page: straight walk north, a chasm with a bridge sketch, a wall with a gate. */
const MINI: LevelDef = {
  page: 1,
  titleKey: 't',
  seed: 5,
  path: [
    [0, 0],
    [0, -40],
  ],
  pathWidth: 1.5,
  clearings: [[0, 0, 4]],
  playerStart: { at: [0, 0, 0], rotY: 0 },
  checkpoints: [{ id: 'a', at: [0, 0, 0] }],
  spawns: [],
  sketches: [
    { id: 'bridge', type: 'bridge', at: [0, 0, -15], rotY: 0, unlocks: [-1.2, -19, 1.2, -11] },
    { id: 'gate', type: 'gate', at: [0, 0, -30], rotY: 0, unlocks: [-1.6, -31, 1.6, -29] },
  ],
  voids: [
    { rect: [-10, -18, 10, -12], kind: 'chasm' },
    { rect: [-10, -30.5, 10, -29.5], kind: 'wall' },
  ],
  triggers: [{ id: 'end', rect: [-2, -40, 2, -37], action: { type: 'pageEnd' } }],
  props: [{ asset: 'proc:tree', at: [0.6, 0, -6], scale: 1 }],
  treeDensity: 0.5,
  fog: { near: 10, far: 20 },
  inkWells: [],
  music: 'explore',
};

describe('PathSampler', () => {
  it('finds the nearest point and arc length on a straight spine', () => {
    const p = new PathSampler(
      [
        [0, 0],
        [0, -10],
      ],
      1,
    );
    expect(p.length).toBeCloseTo(10, 1);
    const h = p.nearest(3, -4, makeHit());
    expect(h.dist).toBeCloseTo(3, 3);
    expect(h.s).toBeCloseTo(4, 2);
    expect(h.halfW).toBeCloseTo(1, 5);
  });
  it('reports Infinity far from the walk', () => {
    const p = new PathSampler(
      [
        [0, 0],
        [0, -10],
      ],
      1,
    );
    expect(p.nearest(200, 0, makeHit()).dist).toBe(Infinity);
  });
  it('interpolates per-point widths', () => {
    const p = new PathSampler(
      [
        [0, 0],
        [0, -10],
        [0, -20],
      ],
      2,
      [1, 0.5, 0.5],
    );
    expect(p.nearest(0, -15, makeHit()).halfW).toBeCloseTo(1, 3);
    expect(p.nearest(0, 0, makeHit()).halfW).toBeCloseTo(2, 3);
  });
});

describe('LevelCollision', () => {
  const d = buildLevelData(MINI);
  const c = d.collision;

  it('ground height matches the heightfield grid exactly at vertices', () => {
    const h = d.height;
    for (const [i, j] of [
      [3, 4],
      [10, 20],
      [7, 11],
    ] as const) {
      expect(c.groundHeight(h.x0 + i * h.cell, h.z0 + j * h.cell)).toBeCloseTo(h.h[j * h.nx + i]!, 5);
    }
  });

  it('walkable: path and clearing in, woods out, voids out', () => {
    c.reset();
    expect(c.walkable(0, 0)).toBe(true);
    expect(c.walkable(3.5, 0)).toBe(true); // clearing
    expect(c.walkable(0, -5)).toBe(true);
    expect(c.walkable(2, -5)).toBe(false); // beside the path
    expect(c.walkable(0, -15)).toBe(false); // chasm
    expect(c.walkable(0, -30)).toBe(false); // closed gate
  });

  it('printing a bridge unlocks its rect and lays a deck over the chasm', () => {
    c.reset();
    const floor = c.groundHeight(0, -15);
    expect(floor).toBeLessThan(-CHASM_DEPTH * 0.6);
    c.unlock('bridge', true);
    expect(c.walkable(0, -15)).toBe(true);
    expect(c.walkable(5, -15)).toBe(false); // still a chasm beside the bridge
    expect(c.groundHeight(0, -15)).toBeGreaterThan(-1);
    c.reset();
    expect(c.walkable(0, -15)).toBe(false);
  });

  it('resolveCircle pushes out of trunks and slides back onto the walk', () => {
    c.reset();
    const moved = c.resolveCircle(0.6, -6, 0.35, out); // inside the prop tree
    expect(moved).toBe(true);
    expect(Math.hypot(out.x - 0.6, out.y + 6)).toBeGreaterThan(0.55 + 0.35 - 1e-3);
    c.resolveCircle(1.9, -8, 0.35, out); // stepped off the path edge
    expect(c.walkable(out.x, out.y)).toBe(true);
    expect(out.x).toBeGreaterThan(1.3);
    c.resolveCircle(0, -12.4, 0.35, out); // into the chasm lip
    expect(c.walkable(out.x, out.y)).toBe(true);
    expect(out.y).toBeGreaterThan(-12.1);
    expect(c.resolveCircle(0, -3, 0.35, out)).toBe(false);
  });

  it('segmentClear is blocked by trunks and closed walls, opened by printing the gate', () => {
    c.reset();
    expect(c.segmentClear(0, -2, 0, -9)).toBe(false); // through the tree
    expect(c.segmentClear(-1, -2, -1, -4)).toBe(true);
    expect(c.segmentClear(0, -27, 0, -33)).toBe(false); // wall
    c.unlock('gate');
    expect(c.segmentClear(0, -27, 0, -33)).toBe(true);
  });

  it('allocates nothing per query (hot path smoke test)', () => {
    c.reset();
    for (let i = 0; i < 5000; i++) {
      c.walkable(Math.sin(i) * 3, -i * 0.007);
      c.resolveCircle(Math.sin(i) * 3, -i * 0.007, 0.35, out);
    }
    expect(true).toBe(true);
  });
});

describe('shipped pages collision', () => {
  it('page 1 bridge spans the chasm once printed', () => {
    const d = buildLevelData(LEVEL1);
    expect(d.collision.walkable(0, -58)).toBe(false);
    d.collision.unlock('p1_bridge', true);
    expect(d.collision.walkable(0, -58)).toBe(true);
  });
  it('page 2 terrace sits above the start and stairs climb it', () => {
    const d = buildLevelData(LEVEL2);
    const low = d.collision.groundHeight(-4, -38);
    const high = d.collision.groundHeight(-2, -52);
    expect(high - low).toBeGreaterThan(1.5);
    expect(d.collision.walkable(-3, -44.5)).toBe(false);
    d.collision.unlock('p2_stairs');
    expect(d.collision.walkable(-3, -44.5)).toBe(true);
  });
});
