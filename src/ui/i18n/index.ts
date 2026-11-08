/**
 * Tiny i18n: flat dotted keys over nested JSON, `{var}` interpolation, EN fallback.
 * Both dictionaries are bundled (≈6 KB) so language switching is instant and offline.
 */
import type { Lang } from '../../core/types';
import en from './en.json';
import tr from './tr.json';

export type Dict = { [k: string]: string | Dict };
export type Vars = Record<string, string | number>;

const DICTS: Record<Lang, Dict> = { en, tr };

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

const FLAT: Record<Lang, Map<string, string>> = { en: flatten(en), tr: flatten(tr) };

export function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export class I18n {
  private listeners = new Set<(lang: Lang) => void>();
  constructor(public lang: Lang = 'en') {}

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
