import type { LevelDef } from '../core/types';

/**
 * Page 1 — "Ink" (~1:30). The wizard wakes in a blank clearing, learns to walk and to swell the
 * crystal, inks two Smudges in a hollow, then prints the first bridge over an ink chasm while a
 * third Smudge ambushes. Path ≈ 112 m (≈ 35 s of travel at a jog), the rest is play.
 * Coordinates: metres, the walk runs toward −Z (up the portrait screen). rotY 0 faces −Z.
 */
export const LEVEL1: LevelDef = {
  page: 1,
  titleKey: 'page.1.title',
  seed: 1101,
  path: [
    [0, 3],
    [0, -6],
    [3.5, -15],
    [1, -23],
    [-2.5, -31],
    [-4, -40],
    [-1, -48],
    [0, -55],
    [0, -61],
    [1.5, -68],
    [5, -77],
    [2.5, -87],
    [-1.5, -96],
    [0, -106],
  ],
  pathWidth: 1.7,
  widths: [1.2, 1.1, 1, 0.95, 1.2, 1, 1, 1, 0.8, 1, 1, 1, 1, 1.2],
  clearings: [
    [0, 0, 6.5],
    [-2.5, -31.5, 7],
    [0, -107, 6],
  ],
  playerStart: { at: [0, 0, 1.5], rotY: 0 },
  checkpoints: [
    { id: 'p1_start', at: [0, 0, 1.5] },
    { id: 'p1_bridge', at: [-1.2, 0, -47] },
  ],
  spawns: [
    { kind: 'smudge', at: [-8.5, -34], trigger: 'p1_hollow' },
    { kind: 'smudge', at: [4, -36.5], trigger: 'p1_hollow' },
    { kind: 'smudge', at: [-5.5, -50], trigger: 'p1_bridge_ambush' },
  ],
  sketches: [
    {
      id: 'p1_bridge',
      type: 'bridge',
      at: [0, 0, -58],
      rotY: 0,
      size: 8,
      unlocks: [-1.3, -62.4, 1.3, -53.6],
      ambushTrigger: 'p1_bridge_ambush',
    },
  ],
  voids: [{ rect: [-12, -61, 12, -55], kind: 'chasm' }],
  triggers: [
    { id: 'p1_start', rect: [-4, -2, 4, 5], action: { type: 'checkpoint' } },
    { id: 'p1_hint_move', rect: [-4, -2, 4, 5], action: { type: 'tutorial', hint: 'move' } },
    { id: 'p1_hint_crystal', rect: [-3, -22, 6, -18], action: { type: 'tutorial', hint: 'crystal' } },
    { id: 'p1_hollow', rect: [-7, -27, 3, -24], action: { type: 'spawn' } },
    {
      id: 'p1_music_hollow',
      rect: [-7, -27, 3, -24],
      action: { type: 'music', layer: 'combat', level: 0.6 },
    },
    { id: 'p1_hint_bolt', rect: [-6, -33, 1, -29], action: { type: 'tutorial', hint: 'bolt' } },
    { id: 'p1_bridge', rect: [-5, -49, 2, -45], action: { type: 'checkpoint' } },
    { id: 'p1_music_calm', rect: [-6, -46, 2, -43], action: { type: 'music', layer: 'combat', level: 0 } },
    { id: 'p1_hint_print', rect: [-3, -54.5, 3, -52.5], action: { type: 'tutorial', hint: 'print' } },
    { id: 'p1_end', rect: [-4, -111, 4, -104], action: { type: 'pageEnd' } },
  ],
  props: [
    { asset: 'proc:lantern', at: [2.6, 0, -2.2], rotY: 0.4 },
    { asset: 'proc:stump', at: [-3.4, 0, 2.4], scale: 1.1 },
    { asset: 'proc:log', at: [4.4, 0, 2.6], rotY: 1.2, scale: 1 },
    { asset: 'proc:boulder', at: [-5.6, 0, -3.5], scale: 1.4 },
    { asset: 'proc:mushroom', at: [-2.6, 0, 3.4], scale: 1.4 },
    { asset: 'proc:mushroom', at: [-3.0, 0, 3.0], scale: 0.8 },
    { asset: 'proc:tree', at: [1.8, 0, -36.5], scale: 1.15 },
    { asset: 'proc:boulder', at: [-7.2, 0, -28.2], scale: 1.1 },
    { asset: 'proc:gravestone', at: [-6.5, 0, -36.8], rotY: 0.3 },
    { asset: 'proc:lantern', at: [-2.1, 0, -52.6], rotY: -0.3 },
    { asset: 'proc:lantern', at: [2.0, 0, -63.6], rotY: 2.8 },
    { asset: 'proc:boulder', at: [3.4, 0, -53.2], scale: 0.9 },
    { asset: 'proc:log', at: [-2.8, 0, -82], rotY: 0.2, scale: 1.2 },
    { asset: 'proc:stump', at: [4.6, 0, -108.5] },
    { asset: 'proc:lantern', at: [-2.6, 0, -103.6] },
  ],
  treeDensity: 0.62,
  fog: { near: 13, far: 30 },
  inkWells: [
    [-6.8, -30, 40],
    [0.3, -50.6, 40],
  ],
  mist: [
    [1.5, -2.5, 4.5],
    [-2.5, -31.5, 6],
    [0, -58, 9],
  ],
  mood: { keyDir: [-0.5, 0.75, 0.45], shadow: 0.3 },
  music: 'explore',
  anchors: { wake: [0, 0, 1.5], chasm: [0, 0, -58] },
};
