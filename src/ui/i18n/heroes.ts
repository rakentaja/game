/**
 * Hero strings (`heroes.*`): picker, perk card, Splash HUD, Letterer captions. They are only read
 * by lazy chunks, so they live outside en.json / tr.json to keep the initial bundle in budget.
 * Importing this module registers them.
 */

import en from './heroes.en.json';
import tr from './heroes.tr.json';
import { type Dict, extendDictionaries } from './index';

export const HERO_DICTS: { en: Dict; tr: Dict } = { en, tr };
extendDictionaries('heroes', HERO_DICTS);
