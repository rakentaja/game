/**
 * Per-page perk picks (pick 1 of 2, run-scoped). Ids double as i18n keys:
 * `heroes.perk.<id>` (name) and `heroes.perkDesc.<id>` (one line).
 */
import type { HeroId, PageId } from '../../core/types';

export const PERKS: Record<HeroId, readonly (readonly [string, string])[]> = {
  inker: [
    ['bleed', 'drybrush'],
    ['chiaroscuro', 'wetEdge'],
    ['spotBlack', 'india'],
  ],
  penciller: [
    ['ricochet', 'longLead'],
    ['crosshatch', 'perspective'],
    ['kirbyDots', 'blueline'],
  ],
  letterer: [
    ['boldFace', 'italics'],
    ['kerning', 'offBeat'],
    ['allCaps', 'ellipsis'],
  ],
  colorist: [
    ['gradient', 'overspray'],
    ['trapping', 'colorHold'],
    ['duotone', 'goldLeaf'],
  ],
};

/** The two options offered when `page` starts (boss page: none). */
export function perkOptions(hero: HeroId, page: PageId): readonly [string, string] | null {
  if (page === 'boss') return null;
  return PERKS[hero][page - 1] ?? null;
}

export const HERO_IDS: readonly HeroId[] = ['inker', 'penciller', 'letterer', 'colorist'];

export function isHeroId(v: unknown): v is HeroId {
  return typeof v === 'string' && (HERO_IDS as readonly string[]).includes(v);
}
