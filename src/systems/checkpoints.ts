import type { EventBus, GameEvents } from '../core/events';
import { load, save } from '../core/storage';
import type { LevelDef, PageId, PlayerAPI, SaveData } from '../core/types';
import { TUNING } from '../data/tuning';

export const SAVE_KEY = 'save';
export const EMPTY_SAVE: SaveData = { lastCheckpoint: null, bestTimeS: null, completed: false };

export interface CheckpointHooks {
  /** Respawn presentation (mini page turn). Resolve after `swap` ran. Defaults to an immediate swap. */
  reprint?: (swap: () => void, durationS: number) => Promise<void>;
  /** Called during the reprint swap, after teleport (re-arm triggers, reset sketches/wells...). */
  onRespawn?: (checkpointId: string) => void;
  /** Ground height for respawn placement. */
  groundY?: (x: number, z: number) => number;
  /** Timer source; tests inject a manual one. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

/**
 * Page-start + pre-boss checkpoints. Reaching one (its trigger id fires) saves progress and emits
 * `checkpoint:reached` (player refills pages on it). On `player:died` waits respawnDelay, plays the
 * "page reprinted" turn, teleports to the last checkpoint and emits `player:respawn`.
 */
export class Checkpoints {
  current: string;
  private readonly offs: (() => void)[] = [];
  private respawning = false;

  constructor(
    private readonly def: LevelDef,
    private readonly events: EventBus<GameEvents>,
    private readonly getPlayer: () => PlayerAPI | null,
    private readonly hooks: CheckpointHooks = {},
  ) {
    this.current = def.checkpoints[0]?.id ?? 'start';
    this.offs.push(
      events.on('trigger:fired', ({ id }) => {
        if (def.checkpoints.some((c) => c.id === id)) this.reach(id);
      }),
      events.on('player:died', () => this.scheduleRespawn()),
    );
  }

  static loadSave(): SaveData {
    return { ...load<SaveData>(SAVE_KEY, EMPTY_SAVE) };
  }

  /** Where a "Continue" should start: the saved checkpoint, if it belongs to a known page. */
  static resumePoint(): { page: PageId; id: string } | null {
    return Checkpoints.loadSave().lastCheckpoint;
  }

  reach(id: string): void {
    if (!this.def.checkpoints.some((c) => c.id === id)) return;
    const first = this.current !== id;
    this.current = id;
    const s = Checkpoints.loadSave();
    s.lastCheckpoint = { page: this.def.page, id };
    save(SAVE_KEY, s);
    if (first || id === this.def.checkpoints[0]?.id) this.events.emit('checkpoint:reached', { id });
  }

  position(id = this.current): [number, number, number] {
    const c = this.def.checkpoints.find((k) => k.id === id) ?? this.def.checkpoints[0];
    return c ? c.at : this.def.playerStart.at;
  }

  private scheduleRespawn(): void {
    if (this.respawning) return;
    this.respawning = true;
    const st = this.hooks.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    st(() => void this.respawn(), TUNING.checkpoint.respawnDelay * 1000);
  }

  async respawn(): Promise<void> {
    const id = this.current;
    const swap = () => {
      const p = this.getPlayer();
      const [x, y0, z] = this.position(id);
      const y = this.hooks.groundY ? this.hooks.groundY(x, z) : y0;
      p?.teleport(x, y, z, this.def.playerStart.rotY);
      this.hooks.onRespawn?.(id);
      this.events.emit('player:respawn', { checkpointId: id });
      this.events.emit('checkpoint:reached', { id });
    };
    const reprint = this.hooks.reprint;
    if (reprint) await reprint(swap, TUNING.checkpoint.reprintTurn);
    else swap();
    this.respawning = false;
  }

  /** Persist a finished run (best time, completed flag). */
  static recordCompletion(timeS: number): SaveData {
    const s = Checkpoints.loadSave();
    s.completed = true;
    s.bestTimeS = s.bestTimeS == null ? timeS : Math.min(s.bestTimeS, timeS);
    s.lastCheckpoint = null;
    save(SAVE_KEY, s);
    return s;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
