import type { CaptionEffect, DamageSource, EnemyKind, PageId, PlayerVerb, SfxId } from './types';

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
  'ink:drop': {
    position: [number, number, number];
    amount: number;
    kind: EnemyKind;
    /** Extra ink on top of the regular death drop (elite refill, director relax). Game spawns pickups for these. */
    bonus?: boolean;
  };
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
  /** Ask the enemy spawner for a spawn (boss erased lanes / scribbles). Spawner enforces maxActive. */
  'spawn:request': { kind: EnemyKind; x: number; z: number; source: string };
  /** Boss attack lifecycle, for UI/audio/camera (telegraph → strike → end). */
  'boss:attack': { kind: 'drag' | 'press' | 'stab'; stage: 'telegraph' | 'strike' | 'end' };
  /** Death cinematic progress: 'inked' (flood), 'torn' (shreds), 'black' (page full ink, cover can show). */
  'boss:death': { stage: 'inked' | 'torn' | 'black' };
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
  /** A level trigger rect was entered (spawner listens for SpawnDef.trigger / ambushTrigger ids). */
  'trigger:fired': { id: string };
  /** Wordless tutorial hint request (UI draws the glyph). `show:false` hides it. */
  'tutorial:hint': { hint: 'move' | 'crystal' | 'bolt' | 'dash' | 'print'; show: boolean };

  // ── Idea Ledger contracts (wave 1). Producers named in brackets; additive only. ──
  /** [audio] Fired on every beat of the current music track (audio clock, not frame clock). */
  'audio:beat': { beat: number; bar: number; bpm: number };
  /** [player] An action landed inside the on-beat window (Ink Rhythm bonus). */
  'combat:onBeat': { action: 'bolt' | 'dash' | 'print' };
  /** [player] Dash through a hazard in the last moments before impact (Ink Parry). */
  'combat:parry': { position: [number, number, number] };
  /** [player] Ink lines closed a loop (Frame Lasso). `ids` = enemies caught. */
  'combat:lasso': { ids: number[]; center: [number, number, number]; area: number };
  /** [player] Crystal snuffed to 0 m / flared back out (Snuff & Flare). */
  'crystal:snuff': { snuffed: boolean };
  'crystal:flare': { caught: number };
  /** [player] Editor's Red Pen style grade changed. */
  'style:grade': { grade: 'D' | 'C' | 'B' | 'A' | 'S' | 'P'; score: number };
  /** [world] Fraction of the current page that is inked, 0..1 (throttled ~4 Hz). */
  'reveal:progress': { t: number };
  /** [world/ui] A narration caption appears; `effect` (optional) is applied after `delay` s unless cancelled. */
  'caption:show': { id: string; key: string; effect?: CaptionEffect; delay?: number };
  'caption:cancel': { id: string };
  /** [world] A caption effect actually fired (game systems react: crystal out, fog...). */
  'caption:effect': { id: string; effect: CaptionEffect };
  /** [boss] The Editor cut (or restored) a player verb. Player obeys; UI shows it. */
  'boss:rewrite': { verb: PlayerVerb; cut: boolean };
  /** [boss] The Editor erased / restored a music stem (audio reacts). */
  'boss:eraseStem': { stem: number; erased: boolean };
  /** [enemies] Encounter director intensity 0..1 and beat. */
  'director:phase': { phase: 'build' | 'peak' | 'relax'; intensity: number };
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
