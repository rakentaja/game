import type { LevelDef } from '../core/types';

/**
 * Boss — THE EDITOR. The player walks through the printed door into a round clearing of torn
 * pages and broken pillars; the Editor looms at the north (TUNING.boss.pos on the boss branch). Phase 1 erases strips across the
 * arena, phase 2 adds sketch weak points (SketchObjects.add with type 'weakpoint'), phase 3 blanks
 * the page. The fight circle matches TUNING.boss.arena (r = 10.5 m + 1 m margin); pillars stand
 * outside it so they never hide eraser telegraphs.
 */
export const BOSS_ARENA: LevelDef = {
  page: 'boss',
  titleKey: 'page.boss.title',
  seed: 4421,
  path: [
    [0, 26],
    [0, 18],
    [0, 12],
    // the walk continues into the arena so the intro fires well inside the mouth
    [0, 6],
  ],
  pathWidth: 1.8,
  // the fight circle matches the Editor's TUNING.boss.arena ([0, 1, 10.5]) with a 1 m margin
  clearings: [[0, 1, 11.5]],
  playerStart: { at: [0, 0, 23], rotY: 0 },
  checkpoints: [{ id: 'boss_start', at: [0, 0, 23] }],
  spawns: [],
  sketches: [],
  triggers: [
    { id: 'boss_start', rect: [-3, 20, 3, 27], action: { type: 'checkpoint' } },
    { id: 'boss_intro', rect: [-5, 11, 5, 15.5], action: { type: 'music', layer: 'boss', level: 1 } },
  ],
  props: [
    // the Editor's body (TUNING.boss.pos [0, -7], bodyRadius 1.7) blocks like a trunk
    { asset: 'proc:blocker', at: [0, 0, -7], scale: 1.7 },
    { asset: 'proc:pillar', at: [-3.2, 0, 15.5], scale: 1.3 },
    { asset: 'proc:pillar', at: [3.2, 0, 15.5], scale: 1.3 },
    { asset: 'proc:pillar', at: [-12.6, 0, -3.6], rotY: 3.49, scale: 1.2 },
    { asset: 'proc:brokenPillar', at: [-9.0, 0, -9.0], rotY: 3.98, scale: 1.25 },
    { asset: 'proc:pillar', at: [-3.2, 0, -12.0], rotY: 4.47, scale: 1.2 },
    { asset: 'proc:brokenPillar', at: [3.2, 0, -12.0], rotY: 4.96, scale: 1.25 },
    { asset: 'proc:pillar', at: [9.0, 0, -9.0], rotY: 5.45, scale: 1.2 },
    { asset: 'proc:brokenPillar', at: [12.6, 0, -3.6], rotY: 5.93, scale: 1.25 },
    { asset: 'proc:pillar', at: [12.6, 0, 5.6], rotY: 0.35, scale: 1.2 },
    { asset: 'proc:brokenPillar', at: [9.0, 0, 11.0], rotY: 0.84, scale: 1.25 },
    { asset: 'proc:pillar', at: [-9.0, 0, 11.0], rotY: 2.3, scale: 1.2 },
    { asset: 'proc:brokenPillar', at: [-12.6, 0, 5.6], rotY: 2.79, scale: 1.25 },
    { asset: 'proc:arch', at: [0, 0, -14.5], scale: 2.2 },
    { asset: 'proc:page', at: [-6, 0, 4], rotY: 0.5, scale: 1.6 },
    { asset: 'proc:page', at: [6.5, 0, -1], rotY: -0.8, scale: 1.9 },
    { asset: 'proc:page', at: [-3, 0, -3.5], rotY: 2.1, scale: 1.4 },
    { asset: 'proc:page', at: [4, 0, 8], rotY: 1.2, scale: 1.2 },
    { asset: 'proc:inkpool', at: [0, 0, -7], scale: 3 },
    { asset: 'proc:stoneRing', at: [0, 0, 1], scale: 11.8 },
    { asset: 'proc:stoneRing', at: [0, 0, 1], scale: 5.5, rotY: 0.3 },
    { asset: 'proc:lantern', at: [-2.4, 0, 19] },
    { asset: 'proc:lantern', at: [2.4, 0, 19] },
  ],
  treeDensity: 0.7,
  fog: { near: 14, far: 34 },
  inkWells: [
    [-9.6, 4, 25],
    [9.6, 4, 25],
    [-4.5, 10.5, 20],
  ],
  mist: [
    [0, -12, 7],
    [0, 16, 4],
  ],
  mood: { keyDir: [0, 0.85, 0.5], shadow: 0.32 },
  music: 'boss',
  anchors: { boss: [0, 0, -7], arenaCenter: [0, 0, 1], introCam: [0, 6, 18] },
};
