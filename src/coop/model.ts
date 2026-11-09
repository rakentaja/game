/** Co-op helpers that reach into the main bundle's loaders (no extra initial bytes). */
import { FLAGS } from '../core/flags';
import type { InputAPI } from '../core/types';
import { installAutoplay } from '../debug/autoplay';
import type { LoadedCharacter, Player } from '../entities/Player';
import { loadAsset } from '../world/assets';
import type { CoopHost } from './types';

/** A fresh wizard model (deep clone) for a second body, or null if it can't load. */
export async function loadWizardModel(): Promise<LoadedCharacter | null> {
  try {
    return await loadAsset('wizard');
  } catch {
    return null;
  }
}

/** ?autoplay=1: drive a second local wizard (slot 1) with its own bot. */
export function autoplayFor(host: CoopHost, input: InputAPI, player: Player): { dispose(): void } | null {
  const lvl = host.level();
  if (!FLAGS.autoplay || !lvl) return null;
  return installAutoplay(
    host.ctx,
    {
      path: lvl.def.path,
      sketches: lvl.def.sketches.map((s) => ({ id: s.id, at: s.at })),
      inkWells: lvl.def.inkWells,
      canPrint: (id) => host.level()?.sketches.isEnabled(id) ?? true,
    },
    host.rig,
    { projectiles: host.enemies.projectiles },
    { input, player },
  );
}
