/**
 * Hero kit factories. The Inker ships in the initial bundle; the other three are lazy chunks
 * fetched when a player picks them (hero select / lobby / `?hero=`).
 */
import { FLAGS } from '../../core/flags';
import { load, save } from '../../core/storage';
import type { HeroId } from '../../core/types';
import type { HeroKit } from './HeroKit';
import { InkerKit } from './inker';
import { isHeroId } from './perks';

export type KitFactory = () => HeroKit;

const cache = new Map<HeroId, Promise<KitFactory>>();

export function loadKit(id: HeroId): Promise<KitFactory> {
  let p = cache.get(id);
  if (!p) {
    switch (id) {
      case 'penciller':
        p = import('./penciller').then((m) => () => new m.PencillerKit());
        break;
      case 'letterer':
        p = import('./letterer').then((m) => () => new m.LettererKit());
        break;
      case 'colorist':
        p = import('./colorist').then((m) => () => new m.ColoristKit());
        break;
      default:
        p = Promise.resolve(() => new InkerKit());
    }
    // a failed chunk fetch (offline) must not poison the cache: fall back to the Inker
    p = p.catch((e) => {
      console.warn('hero kit failed to load', id, e);
      cache.delete(id);
      return () => new InkerKit();
    });
    cache.set(id, p);
  }
  return p;
}

const KEY = 'hero';

/** `?hero=` flag, else the last pick (storage), else the Inker. */
export function selectedHero(): HeroId {
  if (isHeroId(FLAGS.hero)) return FLAGS.hero;
  const v = load<{ id: string }>(KEY, { id: 'inker' }).id;
  return isHeroId(v) ? v : 'inker';
}

export function rememberHero(id: HeroId): void {
  save(KEY, { id });
}
