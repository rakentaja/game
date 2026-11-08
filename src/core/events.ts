import type { DamageSource, EnemyKind, PageId, SfxId } from './types';

/** All cross-system events. Add new ones here; never emit untyped strings. */
export interface GameEvents {
  'state:change': { from: string; to: string };
  'page:start': { page: PageId };
  'page:complete': { page: PageId };
  'player:damaged': { amount: number; source: DamageSource; pagesLeft: number };
  'player:died': Record<string, never>;
  'player:respawn': { checkpointId: string };
  'player:dash': { from: [number, number, number]; to: [number, number, number] };
  'crystal:hold': { held: boolean };
  'bolt:fire': { targetId: number | null };
  'bolt:hit': { enemyId: number; position: [number, number, number]; critical: boolean };
  'enemy:spawn': { id: number; kind: EnemyKind };
  'enemy:revealed': { id: number; kind: EnemyKind; first: boolean };
  'enemy:died': { id: number; kind: EnemyKind; position: [number, number, number] };
  /** Enemy death drops ink at `position`; ink-energy decides pickup (enemies workstream). */
  'ink:drop': { position: [number, number, number]; amount: number; kind: EnemyKind };
  /** An enemy starts a readable attack windup (sound + UI cue). `duration` = seconds until it lands. */
  'enemy:telegraph': { id: number; kind: EnemyKind; duration: number };
  /** Spawner: every enemy of `wave` in trigger group `trigger` ('' = immediate group) is dead. */
  'wave:cleared': { trigger: string; wave: number; last: boolean };
  'ink:collected': { amount: number; total: number };
  'energy:changed': { value: number; max: number };
  'sketch:progress': { id: string; t: number };
  'sketch:printed': { id: string };
  'checkpoint:reached': { id: string };
  'boss:phase': { phase: 1 | 2 | 3 };
  'boss:weakpoint': { index: number; destroyed: boolean };
  'boss:defeated': Record<string, never>;
  /** Request a comic-panel freeze cut. `word` is an onomatopoeia key in i18n (e.g. 'krak'). */
  'fx:panelCut': { word: string; focus: [number, number, number]; reason: string };
  'fx:shake': { intensity: number; duration: number };
  'fx:hitstop': { duration: number };
  'sfx:play': { id: SfxId; position?: [number, number, number]; volume?: number };
  'music:intensity': { layer: 'explore' | 'combat' | 'boss'; level: number };
  'settings:changed': { key: string };
  'game:pause': { paused: boolean };
  /** Show/hide a wordless tutorial hint (levels' `tutorial` trigger action → UI HUD). */
  'ui:tutorial': { hint: 'move' | 'crystal' | 'bolt' | 'dash' | 'print'; show: boolean };
  /** Optional exact boss health 0..1 for the HUD bar (otherwise derived from weak-point events). */
  'boss:health': { value: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus<E extends object = GameEvents> {
  private map = new Map<keyof E, Set<Handler<never>>>();

  on<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(fn as Handler<never>);
    return () => this.off(type, fn);
  }

  once<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off<K extends keyof E>(type: K, fn: Handler<E[K]>): void {
    this.map.get(type)?.delete(fn as Handler<never>);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of set) (fn as Handler<E[K]>)(payload);
  }

  clear(): void {
    this.map.clear();
  }
}

export const events = new EventBus<GameEvents>();
