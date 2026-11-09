/**
 * The seam between the game shell (src/game/Game.ts) and the lazily loaded co-op runtime.
 * Type-only imports: nothing here pulls co-op code into the initial bundle.
 */
import type * as THREE from 'three';
import type { GameContext, PageId } from '../core/types';
import type { Editor } from '../entities/Editor/Editor';
import type { EnemySystem } from '../entities/enemies/EnemySystem';
import type { HeroRuntime } from '../entities/heroes/runtime';
import type { Player } from '../entities/Player';
import type { Combat } from '../systems/combat';
import type { InkEnergy, InkPickups } from '../systems/ink-energy';
import type { Spawner } from '../systems/spawner';
import type { CameraRig } from '../world/camera';
import type { LevelRuntime } from '../world/install';

/** What Game exposes to the co-op runtime. */
export interface CoopHost {
  readonly ctx: GameContext;
  readonly player: Player;
  readonly energy: InkEnergy;
  readonly combat: Combat;
  readonly enemies: EnemySystem;
  readonly spawner: Spawner;
  readonly pickups: InkPickups;
  readonly rig: CameraRig;
  level(): LevelRuntime | null;
  page(): PageId | null;
  editor(): Editor | null;
  mode(): string;
  /** Start a run (stats reset, full ink) on `page` / checkpoint. */
  startRun(page: PageId, checkpoint?: string): Promise<void>;
  /** Build `page` right now (no curl) at a checkpoint — host takeover. */
  startPage(page: PageId, checkpoint?: string): Promise<void>;
  /** Page-turn curl into `page` (co-op schedules it for both machines). */
  turnTo(page: PageId): Promise<void>;
  /** The game's current co-op session. */
  session(): CoopSession | null;
  setSession(c: CoopSession | null): void;
  /** One fixed sim step (no draw) — the hidden-tab watchdog. */
  stepSim(dt: number): void;
  /** performance.now() of the last drawn frame. */
  lastFrameAt(): number;
  /** Dispose the online session and close the network room (solo from here on). */
  endCoop(): void;
  /** Hero runtime (perk cards); absent in headless tests. */
  readonly heroes?: HeroRuntime;
}

/** What Game calls on the co-op runtime. */
export interface CoopSession {
  readonly kind: 'local' | 'host' | 'guest';
  /** This machine simulates the world (enemies, spawner, triggers, sketches, boss FSM). */
  readonly authority: boolean;
  /** Right after the local wizard stepped: step the partner (body / replica). */
  stepPlayers(dt: number): void;
  /** Right after the local combat stepped. */
  stepCombat(dt: number): void;
  /** Replaces InkPickups.step (decides who the ink flies to). */
  stepPickups(dt: number): void;
  /** Before the enemy sim (crystal 1 → reveal, guest snapshot apply). */
  preWorld(dt: number): void;
  /** After every sim system stepped (rules, replication). */
  postStep(dt: number): void;
  frame(alpha: number, frameDt: number): void;
  /** Camera focus override (local 2P frames both wizards). */
  cameraFocus(out: THREE.Vector3): number | null;
  onPageStart(page: PageId): void;
  onPageTeardown(): void;
  /** A checkpoint reprint happened (both machines). */
  onRespawn?(): void;
  /** Page end trigger fired: true when co-op schedules the turn itself. */
  handlePageComplete(page: PageId): boolean;
  /** HUD visibility (title / cover hide it). */
  setHudVisible(v: boolean): void;
  /** A Penciller plays on this screen (local 2P player 2): unlit ghosts drawn as silhouettes. */
  sight?(): boolean;
  dispose(): void;
}
