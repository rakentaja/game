import type { EventBus, GameEvents } from '../core/events';
import type { EliteAffix, EnemyKind, LevelDef, SpawnDef } from '../core/types';

/** What the spawner needs from the enemy system (EnemySystem satisfies it). */
export interface SpawnSink {
  readonly activeCount: number;
  spawn(
    kind: EnemyKind,
    x: number,
    z: number,
    opts?: { elite?: EliteAffix | 'roll' | null },
  ): { id: number } | null;
}

/** Optional layer on top of the authored waves (the encounter director). */
export interface SpawnLayer {
  load(level: Pick<LevelDef, 'spawns'> & { seed?: number }): void;
  reset(): void;
  step(dt: number): void;
  dispose(): void;
}

export interface SpawnerOptions {
  /** Seconds between individual spawns inside a wave (stagger reads better than a pop). */
  stagger?: number;
  /** Pause between a cleared wave and the next one. */
  waveDelay?: number;
  /** Max alive enemies (defaults to TUNING.enemies.maxActive via the sink refusing spawns). */
  maxActive?: () => number;
}

interface Group {
  trigger: string;
  /** Waves sorted ascending; each is the list of spawn defs for that wave number. */
  waves: { wave: number; defs: SpawnDef[] }[];
  started: boolean;
  waveIdx: number;
  /** Next def index to spawn within the current wave. */
  cursor: number;
  /** Ids alive from the current wave. */
  alive: Set<number>;
  cooldown: number;
  done: boolean;
}

/**
 * Data-driven spawner for `LevelDef.spawns`. Spawns without a trigger form the '' group and
 * start immediately on `load`; others start on `fireTrigger(id)` (levels' trigger system calls
 * it). Inside a group, waves run in ascending `wave` order; the next wave starts once every
 * enemy of the previous one died. Respects maxActive by retrying refused spawns.
 * Emits `wave:cleared` per wave (last=true on the group's final wave).
 */
export class Spawner {
  private groups = new Map<string, Group>();
  private offDied: () => void;
  private stagger: number;
  private waveDelay: number;
  private maxActive: (() => number) | null;
  /** Encounter director layered on the authored waves (src/systems/ai/director.ts). */
  director: SpawnLayer | null = null;

  constructor(
    private events: EventBus<GameEvents>,
    private sink: SpawnSink,
    opts: SpawnerOptions = {},
  ) {
    this.stagger = opts.stagger ?? 0.22;
    this.waveDelay = opts.waveDelay ?? 1.2;
    this.maxActive = opts.maxActive ?? null;
    this.offDied = events.on('enemy:died', (e) => this.onDied(e.id));
  }

  load(level: (Pick<LevelDef, 'spawns'> & { seed?: number }) | null): void {
    this.groups.clear();
    if (!level) {
      this.director?.reset();
      return;
    }
    this.director?.load(level);
    for (const def of level.spawns) {
      const key = def.trigger ?? '';
      let g = this.groups.get(key);
      if (!g) {
        g = {
          trigger: key,
          waves: [],
          started: false,
          waveIdx: 0,
          cursor: 0,
          alive: new Set(),
          cooldown: 0,
          done: false,
        };
        this.groups.set(key, g);
      }
      const w = def.wave ?? 0;
      let bucket = g.waves.find((b) => b.wave === w);
      if (!bucket) {
        bucket = { wave: w, defs: [] };
        g.waves.push(bucket);
      }
      bucket.defs.push(def);
    }
    for (const g of this.groups.values()) g.waves.sort((a, b) => a.wave - b.wave);
    this.fireTrigger('');
  }

  /** Start a trigger group (idempotent). Returns false if no spawns use this trigger. */
  fireTrigger(id: string): boolean {
    const g = this.groups.get(id);
    if (!g || g.started) return false;
    g.started = true;
    g.cooldown = 0;
    return true;
  }

  /** True when every group that has started has cleared all its waves. */
  get allStartedCleared(): boolean {
    for (const g of this.groups.values()) if (g.started && !g.done) return false;
    return true;
  }

  isCleared(trigger: string): boolean {
    return this.groups.get(trigger)?.done ?? false;
  }

  /** Number of enemies still waiting to spawn across started groups. */
  get pending(): number {
    let n = 0;
    for (const g of this.groups.values()) {
      if (!g.started || g.done) continue;
      const w = g.waves[g.waveIdx];
      if (w) n += w.defs.length - g.cursor;
    }
    return n;
  }

  step(dt: number): void {
    this.director?.step(dt);
    for (const g of this.groups.values()) {
      if (!g.started || g.done) continue;
      const wave = g.waves[g.waveIdx];
      if (!wave) {
        g.done = true;
        continue;
      }
      g.cooldown -= dt;
      if (g.cursor < wave.defs.length) {
        if (g.cooldown > 0) continue;
        if (this.maxActive && this.sink.activeCount >= this.maxActive()) continue;
        const def = wave.defs[g.cursor]!;
        const e = this.sink.spawn(def.kind, def.at[0], def.at[1], { elite: def.elite ?? 'roll' });
        if (!e) continue; // full: retry next step
        g.alive.add(e.id);
        g.cursor++;
        g.cooldown = this.stagger;
        continue;
      }
      if (g.alive.size > 0) continue;
      // Wave fully spawned and fully dead.
      const last = g.waveIdx >= g.waves.length - 1;
      this.events.emit('wave:cleared', { trigger: g.trigger, wave: wave.wave, last });
      g.waveIdx++;
      g.cursor = 0;
      g.cooldown = this.waveDelay;
      if (last) g.done = true;
    }
  }

  reset(): void {
    this.groups.clear();
    this.director?.reset();
  }

  dispose(): void {
    this.offDied();
    this.groups.clear();
    this.director?.dispose();
  }

  private onDied(id: number): void {
    for (const g of this.groups.values()) if (g.alive.delete(id)) return;
  }
}
