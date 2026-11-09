/**
 * Daily Issue: one shared variation per calendar day. The date hash seeds spawn variety (each
 * spawn nudged inside a valid slot, checked against the level's reach grid) and picks one daily
 * rule. Pure: no DOM, no storage — tests pin the selection.
 */
import type { LevelDef } from '../../core/types';
import { TUNING } from '../../data/tuning';
import { makeRng } from '../rng';

export const DAILY_RULES = ['doubleGhosts', 'inkPuddles', 'thickFog', 'longMemory'] as const;
export type DailyRule = (typeof DAILY_RULES)[number];

export interface DailyInfo {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** YYYYMMDD, storage key. */
  key: string;
  /** Issue number (days since the first Daily, 2026-01-01 = #1). */
  number: number;
  hash: number;
  rule: DailyRule;
}

const EPOCH = Date.UTC(2026, 0, 1);
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** FNV-1a 32-bit. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // final avalanche so neighbouring dates land far apart
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse a `?daily=` value: YYYY-MM-DD (validated) or anything truthy → today. Null if absent. */
export function parseDailyFlag(v: string | null, now: Date = new Date()): string | null {
  if (v == null || v === '' || v === '0') return null;
  const m = ISO.exec(v);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d) return v;
  }
  return isoDate(now);
}

export function dailyInfo(date: string): DailyInfo {
  const m = ISO.exec(date);
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [2026, 1, 1];
  const key = `${y}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  const hash = hashString(key);
  const number = Math.max(1, Math.round((Date.UTC(y, mo - 1, d) - EPOCH) / 86_400_000) + 1);
  const rng = makeRng(hash ^ 0x2545f491);
  const rule = DAILY_RULES[Math.floor(rng() * DAILY_RULES.length) % DAILY_RULES.length]!;
  return { date, key, number, hash, rule };
}

/** Seed for a page of a Daily Issue: date hash XOR the level's own seed. */
export function dailySeed(info: DailyInfo, def: LevelDef): number {
  return (info.hash ^ def.seed) >>> 0;
}
