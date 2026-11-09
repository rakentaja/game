/**
 * Tiny i18n: flat dotted keys over nested JSON, `{var}` interpolation, EN fallback.
 * English is bundled; Turkish is a lazy chunk (≈4.5 KB gzip, precached by the service worker so it
 * still works offline) fetched on boot / on switch — until it lands, lookups fall back to English
 * and listeners fire once more when it arrives. `loadLang()` awaits it.
 */
import type { Lang } from '../../core/types';
import en from './en.json';

export type Dict = { [k: string]: string | Dict };
export type Vars = Record<string, string | number>;

const DICTS: Record<Lang, Dict> = { en, tr: {} };

/** Flatten nested dict to dotted keys (used by tests and for O(1) lookups). */
export function flatten(d: Dict, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
  for (const k of Object.keys(d)) {
    const v = d[k]!;
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else flatten(v, key, out);
  }
  return out;
}

const FLAT: Record<Lang, Map<string, string>> = { en: flatten(en), tr: new Map() };

const loaded: Partial<Record<Lang, Promise<void>>> = { en: Promise.resolve() };
let loadedTr = false;

/** Load a language's main dictionary (idempotent). Lazily loaded extras stay merged. */
export function loadLang(lang: Lang): Promise<void> {
  let p = loaded[lang];
  if (!p) {
    p = import('./tr.json')
      .then((m) => {
        const d = (m as { default: Dict }).default;
        DICTS.tr = d;
        flatten(d, '', FLAT.tr);
        loadedTr = true;
      })
      .catch((e) => {
        console.warn('dictionary failed to load', lang, e);
        delete loaded[lang];
      });
    loaded[lang] = p;
  }
  return p;
}

/** True once `lang`'s main dictionary is in memory. */
export function langReady(lang: Lang): boolean {
  return lang === 'en' || loadedTr;
}

export function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export class I18n {
  private listeners = new Set<(lang: Lang) => void>();
  constructor(public lang: Lang = 'en') {
    this.ensure(lang);
  }

  /** Resolves when the current language's dictionary is loaded. */
  ready(): Promise<void> {
    return loadLang(this.lang);
  }

  private ensure(lang: Lang): void {
    if (langReady(lang)) return;
    void loadLang(lang).then(() => {
      if (this.lang === lang) for (const fn of this.listeners) fn(lang);
    });
  }

  /** Translate `key`. Missing keys fall back to English, then to the key itself. */
  readonly t = (key: string, vars?: Vars): string => {
    const s = FLAT[this.lang].get(key) ?? FLAT.en.get(key) ?? key;
    return interpolate(s, vars);
  };

  has(key: string): boolean {
    return FLAT[this.lang].has(key);
  }

  /** Locale-correct upper case (Turkish dotted/dotless i). */
  upper(s: string): string {
    return s.toLocaleUpperCase(this.lang === 'tr' ? 'tr-TR' : 'en-US');
  }

  setLang(lang: Lang): void {
    if (lang === this.lang) return;
    this.lang = lang;
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
    this.ensure(lang);
    for (const fn of this.listeners) fn(lang);
  }

  onChange(fn: (lang: Lang) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Best guess for first launch: Turkish browsers get Turkish. */
export function detectLang(): Lang {
  const langs = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  return langs.some((l) => l?.toLowerCase().startsWith('tr')) ? 'tr' : 'en';
}

export const DICTIONARIES = DICTS;
export const FLAT_DICTIONARIES = FLAT;

/**
 * Merge a lazily loaded dictionary pair under `prefix` (hero strings ship with the hero chunks, see
 * ./heroes.ts). Existing keys are overwritten; parity is unit-tested like the main dictionaries.
 */
export function extendDictionaries(prefix: string, add: Record<Lang, Dict>): void {
  for (const l of Object.keys(add) as Lang[]) flatten(add[l], prefix, FLAT[l]);
}
