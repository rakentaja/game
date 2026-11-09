import type { LevelDef } from '../core/types';

/**
 * Page 3 — "Blot" (~1:15). Ink-starved: Blots shrink the crystal, so wells are spaced to keep the
 * player hungry. One Blot on the trail, then a two-wave arena in a ring of ruins; the boss door
 * at its north rim can only be printed once the arena is clear. Path ≈ 85 m.
 */
export const LEVEL3: LevelDef = {
  page: 3,
  titleKey: 'page.3.title',
  seed: 3313,
  path: [
    [0, 3],
    [0, -6],
    [3, -14],
    [0.5, -23],
    [-2.5, -30],
    [-1, -38],
    [0, -50],
    [0, -61],
    [0, -67],
    [0, -76],
  ],
  pathWidth: 1.7,
  widths: [1.1, 1, 1, 1.1, 1, 1, 1, 1, 0.9, 1.2],
  clearings: [
    [0, 0, 5],
    [0.5, -24, 5],
    [0, -50, 11.5],
    [0, -76, 5],
  ],
  playerStart: { at: [0, 0, 1.5], rotY: 0 },
  checkpoints: [
    { id: 'p3_start', at: [0, 0, 1.5] },
    { id: 'p3_arena_gate', at: [-1, 0, -35] },
  ],
  spawns: [
    { kind: 'blot', at: [5, -26], trigger: 'p3_trail' },
    { kind: 'blot', at: [-8, -55], trigger: 'p3_arena', wave: 1 },
    { kind: 'smudge', at: [8, -47], trigger: 'p3_arena', wave: 1 },
    { kind: 'smudge', at: [-7, -44], trigger: 'p3_arena', wave: 1 },
    // wave 2 closes in from the flanks of the north rim (within aggro of the door, never on its line)
    { kind: 'blot', at: [7, -53], trigger: 'p3_arena', wave: 2 },
    { kind: 'scribbler', at: [-8.5, -52], trigger: 'p3_arena', wave: 2 },
    { kind: 'smudge', at: [-5.5, -56.5], trigger: 'p3_arena', wave: 2 },
  ],
  sketches: [
    {
      id: 'p3_door',
      type: 'bossDoor',
      at: [0, 0, -63.4],
      rotY: 0,
      size: 4.2,
      unlocks: [-2.2, -65, 2.2, -62],
      requires: 'p3_arena_cleared',
    },
  ],
  voids: [{ rect: [-9, -64, 9, -62.6], kind: 'wall' }],
  terrain: { amp: 0.3, bank: 1.6 },
  triggers: [
    { id: 'p3_start', rect: [-3, -2, 3, 5], action: { type: 'checkpoint' } },
    { id: 'p3_trail', rect: [-1, -16, 5, -13], action: { type: 'spawn' } },
    { id: 'p3_music_trail', rect: [-1, -16, 5, -13], action: { type: 'music', layer: 'combat', level: 0.5 } },
    { id: 'p3_arena_gate', rect: [-4, -37, 2, -33], action: { type: 'checkpoint' } },
    { id: 'p3_arena', rect: [-3, -42, 3, -39], action: { type: 'spawn' } },
    { id: 'p3_arena_cut', rect: [-3, -42, 3, -39], action: { type: 'panelCut', word: 'blot' } },
    { id: 'p3_music_arena', rect: [-3, -42, 3, -39], action: { type: 'music', layer: 'combat', level: 1 } },
    { id: 'p3_end', rect: [-3, -80, 3, -71], action: { type: 'pageEnd' } },
  ],
  props: [
    { asset: 'proc:lantern', at: [2.4, 0, -2.4] },
    { asset: 'proc:inkpool', at: [-2.4, 0, -9], scale: 1.1 },
    { asset: 'proc:inkpool', at: [3.8, 0, -24.5], scale: 1.4 },
    { asset: 'proc:stump', at: [-3.6, 0, -27.5] },
    { asset: 'proc:boulder', at: [-4.2, 0, -33.5], scale: 1 },
    // ring of ruined pillars around the arena (also cover from Scribblers)
    { asset: 'proc:brokenPillar', at: [-9.8, 0, -44], rotY: 0.3, scale: 1.1 },
    { asset: 'proc:pillar', at: [-11.2, 0, -51], rotY: 0.8 },
    { asset: 'proc:brokenPillar', at: [-8.4, 0, -57.6], rotY: 1.9 },
    { asset: 'proc:brokenPillar', at: [9.6, 0, -43.6], rotY: 2.2 },
    { asset: 'proc:pillar', at: [11.3, 0, -50.4], rotY: 0.1, scale: 1.05 },
    { asset: 'proc:brokenPillar', at: [8.6, 0, -57.2], rotY: 3.1, scale: 0.95 },
    { asset: 'proc:boulder', at: [-4.5, 0, -48.5], scale: 0.8 },
    { asset: 'proc:boulder', at: [5, 0, -52.5], scale: 0.75 },
    { asset: 'proc:inkpool', at: [0.5, 0, -50.5], scale: 1.7 },
    { asset: 'proc:stoneRing', at: [0, 0, -50], scale: 9.2 },
    { asset: 'proc:pillar', at: [-4.3, 0, -63.3], scale: 1.25 },
    { asset: 'proc:pillar', at: [4.3, 0, -63.3], scale: 1.25 },
    { asset: 'proc:lantern', at: [-2.6, 0, -60.6] },
    { asset: 'proc:lantern', at: [2.6, 0, -60.6] },
  ],
  treeDensity: 0.55,
  fog: { near: 12.5, far: 27 },
  inkWells: [
    [-2.8, -21.5, 35],
    [-9.4, -47.5, 40],
    [9.2, -54, 40],
    // on the walk line just before the door: Blots leave you dry right when the print needs ink
    [0, -61.2, 45],
  ],
  mist: [
    [0, -50, 9],
    [0, -70, 5],
  ],
  mood: { keyDir: [-0.2, 0.8, 0.55], shadow: 0.34 },
  music: 'explore',
  anchors: { arena: [0, 0, -50], door: [0, 0, -63.4] },
  // Ink Rain: drops ink the page for a blink, lightning prints the whole frame in two tones
  weather: 'inkRain',
  // the ink pools on the trail smear the plates
  misprints: [{ rect: [-6, -30, 7, -18], misreg: 3, halftone: 1.4 }],
};
