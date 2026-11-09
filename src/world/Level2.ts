import type { LevelDef } from '../core/types';

/**
 * Page 2 — "Hollow" (~1:45). Scribblers in a glade teach dashing through telegraphed lines, ink
 * wells teach topping up, printed stairs climb a root-cliff onto the terrace, a narrow trunk
 * corridor funnels Scribbler fire, a rotating gate prints under ambush, and the page ends in a
 * misty clearing. Path ≈ 150 m.
 */
export const LEVEL2: LevelDef = {
  page: 2,
  titleKey: 'page.2.title',
  seed: 2207,
  path: [
    [0, 3],
    [0, -7],
    [-4, -17],
    [-6, -27],
    [-4.5, -37],
    [-3, -44.5],
    [-2, -51],
    [2, -58],
    [1, -66],
    [3, -74],
    [0, -82],
    [-1, -88],
    [-1, -95],
    [1.5, -103],
    [2, -113],
    [3, -126],
  ],
  pathWidth: 1.7,
  widths: [1.1, 1, 1, 1.1, 1, 0.8, 1, 0.6, 0.5, 0.5, 0.55, 0.85, 0.85, 1, 1.1, 1.1],
  clearings: [
    [0, 0, 5.5],
    [-6, -27, 7.5],
    [2, -113, 9.5],
    [3, -127, 4.5],
  ],
  playerStart: { at: [0, 0, 1.5], rotY: 0 },
  checkpoints: [
    { id: 'p2_start', at: [0, 0, 1.5] },
    { id: 'p2_terrace', at: [-2, 2.2, -51] },
    { id: 'p2_gate', at: [-0.8, 2.2, -97] },
  ],
  spawns: [
    { kind: 'scribbler', at: [-11, -31], trigger: 'p2_glade' },
    { kind: 'scribbler', at: [-1, -32.5], trigger: 'p2_glade' },
    { kind: 'smudge', at: [-10, -22], trigger: 'p2_glade' },
    // the dash lesson pays off: Margin Man only takes bolts after a dash trail crosses him
    { kind: 'marginMan', at: [-12, -28], trigger: 'p2_glade', wave: 1 },
    { kind: 'scribbler', at: [0.5, -84], trigger: 'p2_corridor' },
    // the ambush comes from the near side: nothing may shoot over a closed gate it can't be hit through
    { kind: 'smudge', at: [-4.5, -87], trigger: 'p2_gate_ambush' },
    { kind: 'smudge', at: [3.8, -88.5], trigger: 'p2_gate_ambush' },
    { kind: 'scribbler', at: [3.6, -82.5], trigger: 'p2_gate_ambush' },
    { kind: 'scribbler', at: [7, -117], trigger: 'p2_mist' },
    { kind: 'smudge', at: [-4, -115], trigger: 'p2_mist' },
    { kind: 'smudge', at: [6, -109], trigger: 'p2_mist' },
    { kind: 'cranes', at: [3, -119], trigger: 'p2_mist', wave: 1 },
  ],
  sketches: [
    {
      id: 'p2_stairs',
      type: 'stairs',
      at: [-3, 0, -44.2],
      rotY: 0,
      size: 2.2,
      unlocks: [-4.3, -47.3, -1.7, -41.9],
    },
    {
      id: 'p2_gate',
      type: 'gate',
      at: [-1, 2.2, -91.5],
      rotY: 0,
      size: 3.2,
      unlocks: [-2.6, -93, 0.6, -90],
      ambushTrigger: 'p2_gate_ambush',
    },
  ],
  voids: [
    { rect: [-14, -46.6, 8, -42.4], kind: 'cliff' },
    { rect: [-8, -92.2, 6, -90.8], kind: 'wall' },
  ],
  terrain: {
    amp: 0.4,
    bank: 2.2,
    plateaus: [{ rect: [-60, -260, 60, -46.4], h: 2.2, falloff: 3.6 }],
  },
  triggers: [
    { id: 'p2_start', rect: [-3, -2, 3, 5], action: { type: 'checkpoint' } },
    { id: 'p2_glade', rect: [-7, -21, 0, -18], action: { type: 'spawn' } },
    { id: 'p2_music_glade', rect: [-7, -21, 0, -18], action: { type: 'music', layer: 'combat', level: 0.7 } },
    { id: 'p2_hint_dash', rect: [-10, -26, -2, -22], action: { type: 'tutorial', hint: 'dash' } },
    { id: 'p2_music_calm', rect: [-7, -40, -2, -38], action: { type: 'music', layer: 'combat', level: 0 } },
    { id: 'p2_hint_print', rect: [-6, -41, 0, -38.5], action: { type: 'tutorial', hint: 'print' } },
    { id: 'p2_terrace', rect: [-4.5, -53, 0, -49], action: { type: 'checkpoint' } },
    { id: 'p2_corridor', rect: [-0.5, -62, 3, -59], action: { type: 'spawn' } },
    {
      id: 'p2_music_corridor',
      rect: [-0.5, -62, 3, -59],
      action: { type: 'music', layer: 'combat', level: 0.5 },
    },
    { id: 'p2_gate', rect: [-3, -99, 2, -95.5], action: { type: 'checkpoint' } },
    { id: 'p2_mist', rect: [-1, -105.5, 4, -102.5], action: { type: 'spawn' } },
    {
      id: 'p2_music_mist',
      rect: [-1, -105.5, 4, -102.5],
      action: { type: 'music', layer: 'combat', level: 0.8 },
    },
    { id: 'p2_end', rect: [0, -131, 6, -124], action: { type: 'pageEnd' } },
  ],
  props: [
    { asset: 'proc:lantern', at: [-2.2, 0, -3.5] },
    { asset: 'proc:log', at: [3.4, 0, 1.4], rotY: 0.6, scale: 1.1 },
    { asset: 'proc:tree', at: [-6.5, 0, -28.5], scale: 1.1 },
    { asset: 'proc:boulder', at: [-2.4, 0, -25.6], scale: 0.9 },
    { asset: 'proc:boulder', at: [-9.2, 0, -26], scale: 0.8 },
    { asset: 'proc:gravestone', at: [-11.5, 0, -24], rotY: 0.5 },
    { asset: 'proc:gravestone', at: [-12.3, 0, -26.4], rotY: -0.2 },
    { asset: 'proc:lantern', at: [-1.4, 0, -40.8] },
    { asset: 'proc:log', at: [-1.6, 0, -66], rotY: 0.1, scale: 1.4 },
    { asset: 'proc:log', at: [4.8, 0, -72], rotY: -0.2, scale: 1.3 },
    { asset: 'proc:lantern', at: [-3.2, 0, -89.4] },
    { asset: 'proc:lantern', at: [1.2, 0, -89.4] },
    { asset: 'proc:tree', at: [-1.5, 0, -116], scale: 1.2 },
    { asset: 'proc:tree', at: [6, 0, -111.5], scale: 1 },
    { asset: 'proc:gravestone', at: [-6.2, 0, -110], rotY: 0.2 },
    { asset: 'proc:mushroom', at: [-1.0, 0, -115.2], scale: 1.5 },
    { asset: 'proc:mushroom', at: [-2.1, 0, -116.6], scale: 1 },
  ],
  treeDensity: 0.78,
  fog: { near: 12.5, far: 28 },
  inkWells: [
    [-1.5, -23, 35],
    [-3.6, -39.4, 45],
    [3.6, -57.2, 30],
    [0.6, -86.8, 40],
  ],
  mist: [
    [-6, -27, 5],
    [1, -70, 6],
    [2, -113, 11],
    [-3, -106, 6],
    [7, -119, 6],
    [3, -127, 5],
  ],
  mood: { keyDir: [0.45, 0.7, 0.55], shadow: 0.33 },
  music: 'explore',
  anchors: { cliff: [-3, 0, -44], gate: [-1, 2.2, -91.5], mist: [2, 2.2, -113] },
  // the glade fight is over: the Editor's hand rubs out the inked panel the reader just made
  editorHands: [
    {
      trigger: 'p2_glade_cleared',
      path: [
        [-14, -22.5],
        [-9.5, -28.5],
        [-4, -31.5],
        [1.5, -29.5],
      ],
    },
  ],
  // the narrow trunk corridor is printed off-register: plates slip, the screen coarsens
  misprints: [{ rect: [-3, -84, 6.5, -56], misreg: 4.5, halftone: 1.7 }],
};
