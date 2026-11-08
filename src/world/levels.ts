import type { LevelDef, PageId } from '../core/types';
import { BOSS_ARENA } from './BossArena';
import { LEVEL1 } from './Level1';
import { LEVEL2 } from './Level2';
import { LEVEL3 } from './Level3';

export const LEVELS: Record<string, LevelDef> = {
  '1': LEVEL1,
  '2': LEVEL2,
  '3': LEVEL3,
  boss: BOSS_ARENA,
};

export const PAGE_ORDER: readonly PageId[] = [1, 2, 3, 'boss'];

export function getLevel(page: PageId): LevelDef {
  const def = LEVELS[String(page)];
  if (!def) throw new Error(`unknown page ${page}`);
  return def;
}

export function nextPage(page: PageId): PageId | null {
  const i = PAGE_ORDER.indexOf(page);
  return PAGE_ORDER[i + 1] ?? null;
}
