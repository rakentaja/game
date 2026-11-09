/**
 * The Ink Remembers: kills, dash trails and printed sketches leave permanent stamps in the reveal
 * history; long-unvisited regions are slowly reclaimed by blank paper (gentle on Story). Emits
 * `reveal:progress` (fraction of the walkable page inked) at ~4 Hz.
 *
 * Low quality has no history map: stamps are skipped there (the reveal sources of dash trails and
 * printed sketches still show), which is the documented fallback.
 */
import type { GameContext, LevelDef } from '../../core/types';
import { TUNING } from '../../data/tuning';
import type { RevealSystem } from '../../render/reveal/RevealSystem';
import { RUN_MODS } from './mods';

type MemoryReveal = Pick<
  RevealSystem,
  'stampPermanent' | 'stampSegmentPermanent' | 'inkedFraction' | 'setProgressMask' | 'reclaimMul'
>;

function hasMemory(r: unknown): r is MemoryReveal {
  return typeof (r as MemoryReveal).stampPermanent === 'function';
}

export interface InkMemory {
  update(dt: number): void;
  dispose(): void;
}

export function installInkMemory(
  ctx: GameContext,
  def: LevelDef,
  walkable: (x: number, z: number) => boolean,
): InkMemory {
  const reveal = ctx.reveal;
  if (!hasMemory(reveal)) return { update() {}, dispose() {} };
  const M = TUNING.worldMeta.inkMemory;
  const applyReclaim = () => {
    const story = ctx.settings.difficulty === 'story';
    reveal.reclaimMul = (story ? M.storyReclaimMul : 1) * RUN_MODS.reclaimMul;
  };
  applyReclaim();
  reveal.setProgressMask(walkable);
  const sketchAt = new Map(def.sketches.map((s) => [s.id, s.at] as const));
  const ev = ctx.events;
  const offs = [
    ev.on('enemy:died', (e) => {
      reveal.stampPermanent(e.position[0], e.position[2], M.killRadius * RUN_MODS.killStampMul);
    }),
    ev.on('player:dash', (e) => {
      reveal.stampSegmentPermanent(e.from[0], e.from[2], e.to[0], e.to[2], M.dashRadius);
    }),
    ev.on('sketch:printed', (e) => {
      const at = sketchAt.get(e.id);
      if (at) reveal.stampPermanent(at[0], at[2], M.printRadius);
    }),
    ev.on('settings:changed', (e) => {
      if (e.key === 'difficulty' || e.key === 'all' || e.key === '*') applyReclaim();
    }),
  ];
  let acc = 0;
  let last = -1;
  const payload = { t: 0 };
  return {
    update(dt) {
      acc += dt;
      if (acc < 1 / M.progressHz) return;
      acc = 0;
      const t = reveal.inkedFraction();
      if (Math.abs(t - last) < 1e-4) return;
      last = t;
      payload.t = t;
      ev.emit('reveal:progress', payload);
    },
    dispose() {
      for (const o of offs) o();
    },
  };
}
