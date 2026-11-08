/**
 * Settings persistence. The store mutates the shared `Settings` object in place (ctx.settings),
 * saves through core/storage and emits `settings:changed` with the key (or 'all' on load/reset).
 */
import type { EventBus, GameEvents } from '../core/events';
import { load, save } from '../core/storage';
import { DEFAULT_SETTINGS, type Settings } from '../core/types';
import { detectLang } from './i18n';

const KEY = 'settings';
const SEEN = 'settings-seen';

export type SettingKey = keyof Settings;

export class SettingsStore {
  readonly value: Settings;

  constructor(
    private bus: EventBus<GameEvents> | null,
    target?: Settings,
  ) {
    this.value = target ?? { ...DEFAULT_SETTINGS };
    const firstRun = !load<{ v: boolean }>(SEEN, { v: false }).v;
    const defaults: Settings = { ...DEFAULT_SETTINGS };
    if (firstRun) {
      defaults.lang = detectLang();
      if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
        defaults.reduceMotion = true;
      }
    }
    Object.assign(this.value, sanitize(load<Settings>(KEY, defaults)));
  }

  get<K extends SettingKey>(k: K): Settings[K] {
    return this.value[k];
  }

  set<K extends SettingKey>(k: K, v: Settings[K]): void {
    if (this.value[k] === v) return;
    this.value[k] = v;
    this.persist();
    this.bus?.emit('settings:changed', { key: k });
  }

  reset(): void {
    Object.assign(this.value, DEFAULT_SETTINGS);
    this.persist();
    this.bus?.emit('settings:changed', { key: 'all' });
  }

  private persist(): void {
    save(KEY, this.value);
    save(SEEN, { v: true });
  }
}

const clamp01 = (n: unknown, d: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T =>
  opts.includes(v as T) ? (v as T) : d;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Defend against hand-edited / older storage. */
export function sanitize(s: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS;
  return {
    master: clamp01(s.master, d.master),
    music: clamp01(s.music, d.music),
    sfx: clamp01(s.sfx, d.sfx),
    vibration: bool(s.vibration, d.vibration),
    leftHanded: bool(s.leftHanded, d.leftHanded),
    reduceMotion: bool(s.reduceMotion, d.reduceMotion),
    misregistration: bool(s.misregistration, d.misregistration),
    quality: oneOf(s.quality, ['auto', 'low', 'high'] as const, d.quality),
    lang: oneOf(s.lang, ['en', 'tr'] as const, d.lang),
    difficulty: oneOf(s.difficulty, ['story', 'normal'] as const, d.difficulty),
  };
}
