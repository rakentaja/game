import type { LevelDef } from '../core/types';

/**
 * Boss — THE EDITOR. The player walks through the printed door into a round clearing of torn
 * pages and broken pillars; the Editor looms at the north rim. Phase 1 erases strips across the
 * arena, phase 2 adds sketch weak points (SketchObjects.add with type 'weakpoint'), phase 3 blanks
 * the page. The arena is wide (r = 15 m) so dashing has room; pillars stay at the rim so they never
 * hide eraser telegraphs.
 */
export const BOSS_ARENA: LevelDef = {
  page: 'boss',
  titleKey: 'page.boss.title',
  seed: 4421,
  path: [
    [0, 26],
    [0, 18],
    [0, 12],
  ],
  pathWidth: 1.8,
  clearings: [[0, 0, 15]],
  playerStart: { at: [0, 0, 23], rotY: 0 },
  checkpoints: [{ id: 'boss_start', at: [0, 0, 23] }],
  spawns: [],
  sketches: [],
  triggers: [
    { id: 'boss_start', rect: [-3, 20, 3, 27], action: { type: 'checkpoint' } },
    { id: 'boss_intro', rect: [-4, 11, 4, 14], action: { type: 'music', layer: 'boss', level: 1 } },
  ],
  props: [
    { asset: 'proc:pillar', at: [-6.5, 0, 16], scale: 1.3 },
    { asset: 'proc:pillar', at: [6.5, 0, 16], scale: 1.3 },
    { asset: 'proc:brokenPillar', at: [-13.2, 0, 10.5], rotY: 0.4, scale: 1.2 },
    { asset: 'proc:pillar', at: [-16.4, 0, 2.5], rotY: 1.2, scale: 1.25 },
    { asset: 'proc:brokenPillar', at: [-15.4, 0, -6.6], rotY: 2.1, scale: 1.3 },
    { asset: 'proc:pillar', at: [-10.8, 0, -13.2], rotY: 0.2, scale: 1.4 },
    { asset: 'proc:brokenPillar', at: [13.4, 0, 10.2], rotY: 2.7, scale: 1.2 },
    { asset: 'proc:brokenPillar', at: [16.3, 0, 1.6], rotY: 1.3, scale: 1.3 },
    { asset: 'proc:pillar', at: [15.2, 0, -7.2], rotY: 0.6, scale: 1.25 },
    { asset: 'proc:pillar', at: [10.6, 0, -13.6], rotY: 2.9, scale: 1.4 },
    { asset: 'proc:arch', at: [0, 0, -17.5], scale: 2.2 },
    { asset: 'proc:page', at: [-6, 0, 4], rotY: 0.5, scale: 1.6 },
    { asset: 'proc:page', at: [7, 0, -2], rotY: -0.8, scale: 1.9 },
    { asset: 'proc:page', at: [-2, 0, -7], rotY: 2.1, scale: 1.4 },
    { asset: 'proc:page', at: [4, 0, 8], rotY: 1.2, scale: 1.2 },
    { asset: 'proc:inkpool', at: [0, 0, -4], scale: 3.2 },
    { asset: 'proc:stoneRing', at: [0, 0, 0], scale: 13.2 },
    { asset: 'proc:stoneRing', at: [0, 0, 0], scale: 6.5, rotY: 0.3 },
    { asset: 'proc:lantern', at: [-2.4, 0, 19] },
    { asset: 'proc:lantern', at: [2.4, 0, 19] },
  ],
  treeDensity: 0.7,
  fog: { near: 14, far: 34 },
  inkWells: [
    [-12.5, 0, 25],
    [12.5, 0, 25],
    [-5.5, 9.5, 20],
  ],
  mist: [
    [0, 0, 14],
    [0, -14, 8],
  ],
  mood: { keyDir: [0, 0.85, 0.5], shadow: 0.32 },
  music: 'boss',
  anchors: { boss: [0, 0, -11], arenaCenter: [0, 0, 0], introCam: [0, 6, 18] },
};
