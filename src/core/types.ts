/**
 * INKWAKE module contracts.
 *
 * Every workstream (render, player, enemies, levels, boss, audio, ui) implements or consumes
 * these interfaces. Change them only additively; if a breaking change is needed, update every
 * implementer in the same commit and note it in docs/DECISIONS.md.
 *
 * Conventions: world units = metres, Y up, ground plane XZ. Vectors crossing module boundaries
 * are three.js Vector3 owned by the producer (read, don't keep or mutate) to avoid per-frame allocs.
 */
import type * as THREE from 'three';
import type { RampName } from '../data/palette';
import type { Tuning } from '../data/tuning';
import type { EventBus, GameEvents } from './events';

export type PageId = 1 | 2 | 3 | 'boss';
export type EnemyKind =
  | 'smudge'
  | 'scribbler'
  | 'blot'
  // Idea Ledger wave 1 (enemies workstream)
  | 'marginMan'
  | 'redactor'
  | 'panelWarden'
  | 'misprint'
  | 'cranes';
/** Elite affixes (enemies workstream): outline tint + caption tag. */
export type EliteAffix = 'firstEdition' | 'inkedIn' | 'bleedThrough';
export type DamageSource = EnemyKind | 'editor' | 'eraser' | 'hazard';
export type Difficulty = 'story' | 'normal';
export type Lang = 'tr' | 'en';
export type QualityLevel = 'auto' | 'low' | 'high';
/** Ghost Inker playback: only in Daily Issues (default), every run, or never. */
export type GhostMode = 'daily' | 'always' | 'off';
/** Playable hero classes (wave 2). 'inker' is the original wizard. */
export type HeroId = 'inker' | 'penciller' | 'letterer' | 'colorist';
/** Player slot: 0 = local/host, 1 = second player (co-op). */
export type PlayerSlot = 0 | 1;
/** Verbs the Editor can cut from the issue (boss "Rewrites"). */
export type PlayerVerb = 'bolt' | 'dash' | 'crystal' | 'print';
/** Narration caption effects ("AND THEN THE CRYSTAL WENT OUT"). */
export type CaptionEffect = 'crystalOut' | 'fogIn' | 'ghostsHaste' | 'inkDrought';

/** Shared beat clock (audio workstream implements; anyone reads). Audio-clock based. */
export interface BeatAPI {
  /** Current BPM (0 when no track is playing). */
  readonly bpm: number;
  /** Signed ms from now to the nearest 8th-note grid line (negative = just passed). */
  offsetMs(): number;
  /** True if now is within ±windowMs of an 8th note. Default window comes from tuning. */
  onBeat(windowMs?: number): boolean;
  /** 0..1 phase within the current beat (for visual pulses). */
  phase(): number;
}

/** SFX catalogue (PLAN §7). Audio implements every id; missing files fall back to procedural synth. */
export type SfxId =
  | 'crystal_on'
  | 'crystal_off'
  | 'bolt_fire'
  | 'bolt_hit'
  | 'dash'
  | 'ghost_reveal'
  | 'ghost_die'
  | 'player_hurt'
  | 'ink_pickup'
  | 'sketch_loop'
  | 'sketch_done'
  | 'page_turn'
  | 'step_grass'
  | 'step_stone'
  | 'eraser_sweep'
  | 'boss_roar'
  | 'panel_stinger'
  | 'ui_click'
  | 'ui_hover'
  | 'fanfare'
  | 'scribble_fire'
  | 'blot_drain';

// ───────────────────────────── Input ─────────────────────────────

/** Sampled once per sim step by the player. Edge-triggered flags are true for exactly one step. */
export interface InputState {
  /** Analog move, length 0..1, screen-relative (x right, y up on screen). */
  move: THREE.Vector2;
  crystalHeld: boolean;
  /** Tap on the action side / mouse left. */
  boltPressed: boolean;
  /** Swipe / Space. `dashDir` is screen-relative unit vector (falls back to move or facing). */
  dashPressed: boolean;
  dashDir: THREE.Vector2;
  pausePressed: boolean;
  /** Two-finger tap / F / gamepad Y: snuff the crystal to 0 m (Snuff & Flare). Optional, edge. */
  snuffPressed?: boolean;
  /** Double-tap on the action side / Q / gamepad LB: fire the hero ultimate (Splash meter). Optional, edge. */
  ultimatePressed?: boolean;
  /** Last device used, for prompt icons. */
  device: 'touch' | 'keyboard' | 'gamepad';
}

export interface InputAPI {
  readonly state: InputState;
  /** Called by the loop at the start of each sim step; clears edge flags afterwards. */
  poll(): void;
  setLeftHanded(v: boolean): void;
  setEnabled(v: boolean): void;
  dispose(): void;
}

// ───────────────────────────── Reveal (core mechanic) ─────────────────────────────

/**
 * The ink reveal mask. Owned by render/reveal/RevealSystem.ts. Gameplay reads `isRevealed`
 * (CPU-side mirror of the shader math — must match it) to decide visibility/targetability.
 */
export interface RevealAPI {
  /** Primary source: crystal. Set every frame by the player. */
  readonly center: THREE.Vector3;
  /** Current animated radius (metres). Player/Blot write `targetRadius`; system eases `radius`. */
  radius: number;
  targetRadius: number;
  /** Temporary reveal circles (dash trail, ink wells, printed sketch objects). Returns handle. */
  addSource(x: number, z: number, radius: number, life: number): number;
  removeSource(handle: number): void;
  /** Permanently erase a strip on the history map (boss eraser). Segment a→b with half width. */
  eraseStrip(ax: number, az: number, bx: number, bz: number, halfWidth: number): void;
  /** 0..1 — how inked world point (x,z) is right now. >0.5 counts as visible. */
  revealAt(x: number, z: number): number;
  isRevealed(x: number, z: number): boolean;
  /** Global override for boss phase 3 "Blank Page": everything but the crystal goes to paper. */
  blankPage: number;
  /** Shader uniforms to merge into any material that participates in reveal. */
  readonly uniforms: Record<string, THREE.IUniform>;
  update(dt: number): void;
  reset(): void;
}

// ───────────────────────────── Rendering ─────────────────────────────

export interface InkMaterialOptions {
  ramp: RampName;
  /** Participates in reveal mask (default true). Characters/crystal usually false. */
  reveal?: boolean;
  skinning?: boolean;
  instancing?: boolean;
  keyAmt?: number;
  glowAmt?: number;
  map?: THREE.Texture | null;
  albedoMix?: number;
  /** Procedural scratchy-grass albedo (POC ground). */
  ground?: boolean;
  /** Paper-ghost crumple vertex deform amount (enemies). */
  crumple?: number;
  /** Draw as dashed pencil sketch until printed (sketch objects). 0 = pencil, 1 = inked. */
  printed?: number;
  /** Pencil-sketch strength while unrevealed, 0..1 (default 1; ghosts ~0.2 so they barely show). */
  sketch?: number;
  side?: THREE.Side;
}

export interface RenderAPI {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Shared uniforms (uTime, uBoilSeed, uKeyDir, uCrystalPos, uShadow, fog...). */
  readonly shared: Record<string, THREE.IUniform>;
  createInkMaterial(opts: InkMaterialOptions): THREE.ShaderMaterial;
  /** Inverted-hull outline for a (skinned) mesh hierarchy. Returns a disposer. */
  addOutline(root: THREE.Object3D, widthPx?: number): () => void;
  /** Draw the frame (scene + post). Pass extra cameras for panel cuts via `panels`. */
  render(frameDt: number): void;
  /** Panel cut: freeze is handled by caller (loop.timeScale); this lays out panels and word. */
  beginPanelCut(word: string, focus: THREE.Vector3, durationS: number): void;
  /** Page turn: captures current frame, calls `swap` to build next scene, animates curl. */
  pageTurn(swap: () => void | Promise<void>, durationS: number): Promise<void>;
  /** Capture the current composited frame as PNG data URL (cover/share). */
  snapshot(width?: number, height?: number): string;
  setQuality(level: QualityLevel): void;
  setMisregistration(on: boolean): void;
  setReduceMotion(on: boolean): void;
  resize(): void;
  readonly stats: { drawCalls: number; triangles: number; frameMs: number; pixelRatio: number };
}

// ───────────────────────────── World / collision ─────────────────────────────

export interface CollisionAPI {
  groundHeight(x: number, z: number): number;
  /** Push a circle (x,z,r) out of blockers; writes result into `out`. Returns true if it moved. */
  resolveCircle(x: number, z: number, r: number, out: THREE.Vector2): boolean;
  /** Is (x,z) inside the walkable area (path + arenas + printed bridges)? */
  walkable(x: number, z: number): boolean;
  /** Line of sight for scribbler fire / bolt targeting. */
  segmentClear(ax: number, az: number, bx: number, bz: number): boolean;
}

// ───────────────────────────── Entities ─────────────────────────────

export interface PlayerAPI {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly facing: THREE.Vector3;
  /** World position of the crystal tip. */
  readonly crystalPos: THREE.Vector3;
  readonly pages: number;
  readonly energy: number;
  readonly invulnerable: boolean;
  readonly crystalHeld: boolean;
  damage(amount: number, source: DamageSource): void;
  addEnergy(amount: number): void;
  teleport(x: number, y: number, z: number, facingY?: number): void;
  setControllable(v: boolean): void;
  /** Cinematic animation request (victory, look_around, kneel). */
  playClip(name: string, loop?: boolean): void;
  readonly object: THREE.Object3D;
  /** Co-op (wave 2): player slot (0 when absent). */
  readonly slot?: PlayerSlot;
  /** Co-op: downed ("UNFINISHED") — never targeted by enemies or the Editor. */
  readonly downed?: boolean;
  /** Co-op: contact tests against this player use a radius this much smaller (remote wizard). */
  readonly contactShrink?: number;
  /** Co-op: a replicated wizard simulated on the partner's machine. */
  readonly remote?: boolean;
}

export interface Damageable {
  readonly id: number;
  readonly position: THREE.Vector3;
  readonly radius: number;
  readonly alive: boolean;
  /** Only revealed targets may be hit or targeted. */
  readonly revealed: boolean;
  /** True while the target is winding up / telegraphing an attack (Close-Up Crits). Optional. */
  readonly attacking?: boolean;
  hit(amount: number, from: THREE.Vector3): void;
  /** Optional: freeze the target's AI for `seconds` (Snuff & Flare, Frame Lasso). */
  stun?(seconds: number): void;
}

export interface EnemyAPI extends Damageable {
  readonly kind: EnemyKind;
  readonly hp: number;
}

/** Registry of everything bolts can hit (enemies + boss weak points). */
export interface TargetRegistry {
  add(t: Damageable): void;
  remove(t: Damageable): void;
  /** Nearest alive & revealed target within range of p, or null. Allocation-free. */
  nearest(p: THREE.Vector3, maxRange: number): Damageable | null;
  forEach(fn: (t: Damageable) => void): void;
}

// ───────────────────────────── Levels (data-driven) ─────────────────────────────

export type Vec2T = [number, number];
export type Vec3T = [number, number, number];

export interface SpawnDef {
  kind: EnemyKind;
  at: Vec2T;
  /** Spawns when the player enters this trigger id (or immediately if omitted). */
  trigger?: string;
  wave?: number;
  /** Authored elite affix (otherwise elites are rolled from tuning × difficulty). */
  elite?: EliteAffix;
}

export interface SketchObjectDef {
  id: string;
  type: 'bridge' | 'stairs' | 'gate' | 'bossDoor' | 'weakpoint';
  at: Vec3T;
  rotY: number;
  /** Size hint (length for bridge, height for stairs...). */
  size?: number;
  /** When printed, makes this rect walkable/unblocks: [minX,minZ,maxX,maxZ]. */
  unlocks?: [number, number, number, number];
  /** Spawn group triggered while printing (tension). */
  ambushTrigger?: string;
  /** Printing stays disabled until `trigger:fired` with this id (e.g. arena cleared). */
  requires?: string;
}

export interface TriggerDef {
  id: string;
  /** Axis-aligned rect [minX,minZ,maxX,maxZ]. */
  rect: [number, number, number, number];
  once?: boolean;
  /** Built-in actions; levels can also listen for `trigger:<id>` in code. */
  action?:
    | { type: 'checkpoint' }
    | { type: 'spawn' }
    | { type: 'panelCut'; word: string }
    | { type: 'tutorial'; hint: 'move' | 'crystal' | 'bolt' | 'dash' | 'print' }
    | { type: 'pageEnd' }
    | { type: 'music'; layer: 'explore' | 'combat' | 'boss'; level: number };
}

export interface PropDef {
  /** Asset id in public/assets/manifest.json, or 'proc:tree' | 'proc:rock' | 'proc:mushroom'. */
  asset: string;
  at: Vec3T;
  rotY?: number;
  scale?: number;
  ramp?: RampName;
}

export interface LevelDef {
  page: PageId;
  /** i18n key for the page title ("Ink", "Hollow", "Blot"). */
  titleKey: string;
  seed: number;
  /** Walkable path centreline (CatmullRom in XZ) and half width. */
  path: Vec2T[];
  pathWidth: number;
  /** Extra walkable circles (clearings, arenas): [x, z, r]. */
  clearings: Vec3T[];
  playerStart: { at: Vec3T; rotY: number };
  checkpoints: { id: string; at: Vec3T }[];
  spawns: SpawnDef[];
  sketches: SketchObjectDef[];
  triggers: TriggerDef[];
  props: PropDef[];
  /** Procedural forest density along the path edges (trees / metre). */
  treeDensity: number;
  fog: { near: number; far: number };
  /** Ink wells: [x, z, energy]. */
  inkWells: Vec3T[];
  music: 'explore' | 'combat' | 'boss';
  /** Optional per-path-point half-width multipliers (narrow corridors). Same length as `path`. */
  widths?: number[];
  /** Non-walkable rects overriding path/clearings (ink chasms, cliffs, closed gates) unless a printed sketch unlocks them. */
  voids?: { rect: [number, number, number, number]; kind: 'chasm' | 'cliff' | 'wall' }[];
  /** Ground shaping: noise amplitude, bank rise beside the path, raised plateaus (stairs targets). */
  terrain?: {
    amp?: number;
    bank?: number;
    plateaus?: { rect: [number, number, number, number]; h: number; falloff: number }[];
  };
  /** Low ground-mist patches [x, z, r]. */
  mist?: Vec3T[];
  /** Key light / shadow threshold hints for the page's mood (render may apply). */
  mood?: { keyDir?: Vec3T; shadow?: number };
  /** Named world anchors (boss spawn, cinematic camera points...). */
  anchors?: Record<string, Vec3T>;
  /** Ambient weather (render): 'inkRain' = Ink Rain storm with lightning flashes. */
  weather?: 'inkRain';
  /** Misprint zones: rects where plate misregistration / halftone screen are boosted (multipliers). */
  misprints?: { rect: [number, number, number, number]; misreg: number; halftone: number }[];
  /** The Editor's Hand: when trigger `trigger` fires, a giant pencil hand wipes the XZ spline `path`. */
  editorHands?: { trigger: string; path: Vec2T[] }[];
}

// ───────────────────────────── Audio ─────────────────────────────

export interface AudioAPI {
  /** Must be called from a user gesture (first touch). Idempotent. */
  unlock(): Promise<void>;
  play(id: SfxId, opts?: { position?: THREE.Vector3; volume?: number; rate?: number }): void;
  /** Start/stop a looping sfx (sketch_loop, eraser_sweep). Returns stop fn. */
  loop(id: SfxId, opts?: { volume?: number }): () => void;
  setMusic(track: 'title' | 'explore' | 'boss' | 'cover' | null): void;
  /** Crossfade stem intensity 0..1 per layer (explore pad, combat percussion, boss phase). */
  setIntensity(layer: 'explore' | 'combat' | 'boss', level: number): void;
  setListener(pos: THREE.Vector3, forward: THREE.Vector3): void;
  setVolumes(v: { master: number; music: number; sfx: number }): void;
  suspend(): void;
  resume(): void;
}

// ───────────────────────────── Settings / save ─────────────────────────────

export interface Settings {
  master: number;
  music: number;
  sfx: number;
  vibration: boolean;
  leftHanded: boolean;
  reduceMotion: boolean;
  misregistration: boolean;
  quality: QualityLevel;
  lang: Lang;
  difficulty: Difficulty;
  ghost: GhostMode;
}

export const DEFAULT_SETTINGS: Settings = {
  master: 0.9,
  music: 0.7,
  sfx: 0.9,
  vibration: true,
  leftHanded: false,
  reduceMotion: false,
  misregistration: true,
  quality: 'auto',
  lang: 'en',
  difficulty: 'normal',
  ghost: 'daily',
};

export interface SaveData {
  lastCheckpoint: { page: PageId; id: string } | null;
  bestTimeS: number | null;
  completed: boolean;
}

export interface RunStats {
  timeS: number;
  ghostsInked: number;
  inkCollected: number;
  pagesTorn: number;
  deaths: number;
  boltsFired: number;
  boltsHit: number;
  /** Best panel-cut moment snapshot (data URL) for the cover. */
  bestPanel: string | null;
  /** Editor's Red Pen: total style points this run, and the best grade reached. Optional. */
  styleScore?: number;
  styleGrade?: 'D' | 'C' | 'B' | 'A' | 'S' | 'P';
}

// ───────────────────────────── Game context ─────────────────────────────

/**
 * Service locator handed to every system. Built in main.ts. Fields are filled in order during
 * boot; any system may assume all fields exist once `playing` state is entered.
 */
export interface GameContext {
  events: EventBus<GameEvents>;
  tuning: Tuning;
  settings: Settings;
  render: RenderAPI;
  reveal: RevealAPI;
  input: InputAPI;
  audio: AudioAPI;
  collision: CollisionAPI;
  targets: TargetRegistry;
  player: PlayerAPI | null;
  /**
   * Co-op (wave 2): every wizard on the page, indexed by slot. `player` stays the local one.
   * Absent / length 1 in solo play.
   */
  players?: PlayerAPI[];
  /** Beat clock; null until audio boots. */
  beat?: BeatAPI | null;
  stats: RunStats;
  /** Loop control (time scale for hit-stop / panel cuts). */
  time: { scale: number; simTime: number };
  t(key: string, vars?: Record<string, string | number>): string;
}
