/**
 * Render workstream entry. Integration (main.ts):
 *
 *   const render = new InkRenderer({ canvas });
 *   ctx.render = render; ctx.reveal = render.reveal;
 *   installRender(ctx, render);           // settings + fx:panelCut
 *   installFx(ctx, render);               // from '@/fx'
 *   step(dt):   ctx.reveal.update(dt)     // sim (reveal is gameplay state)
 *   render(dt): render.render(frameDt)
 *   loop.timeScale = ctx.time.scale       // hit-stop / panel-cut freeze
 */
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { TUNING } from '../data/tuning';
import { TimeFreeze } from '../fx/shake';
import { WORDS } from './post/lettering';
import type { InkRenderer } from './renderer';

export { BoilClock, SteppedMixer } from './boil';
export { createInkMaterial, createSharedUniforms } from './materials/InkMaterial';
export { attachHulls, ensureHullNormals } from './outline/hull';
export { WORDS } from './post/lettering';
export { AdaptiveQuality, profileFor } from './quality';
export { InkRenderer, type OutlineMode } from './renderer';
export { RevealSystem } from './reveal/RevealSystem';

/** Display text for an onomatopoeia key: i18n `fx.<key>` if present, else built-in, else KEY!. */
export function wordFor(ctx: Pick<GameContext, 't'> | null, key: string): string {
  // a full i18n key (e.g. lazily loaded `heroes.combo.overprint`)
  if (key.includes('.')) {
    const t0 = ctx?.t(key);
    if (t0 && t0 !== key) return t0;
  }
  const k = `fx.${key}`;
  const t = ctx?.t(k);
  if (t && t !== k) return t;
  const k2 = `onomatopoeia.${key}`; // UI i18n namespace
  const t2 = ctx?.t(k2);
  if (t2 && t2 !== k2) return t2;
  return WORDS[key.toLowerCase()] ?? `${key.toUpperCase()}!`;
}

export function installRender(ctx: GameContext, render: InkRenderer): () => void {
  const freeze = new TimeFreeze();
  const focus = new THREE.Vector3();
  const apply = () => {
    render.setReduceMotion(ctx.settings.reduceMotion);
    render.setMisregistration(ctx.settings.misregistration);
    render.setQuality(ctx.settings.quality);
  };
  apply();
  const offs = [
    render.onFrame((dt) => freeze.update(dt, ctx.time)),
    ctx.events.on('settings:changed', (e) => {
      if (e.key === 'reduceMotion' || e.key === 'misregistration' || e.key === 'quality' || e.key === '*')
        apply();
    }),
    ctx.events.on('fx:panelCut', (e) => {
      focus.set(e.focus[0], e.focus[1], e.focus[2]);
      const d = TUNING.panelCut.duration;
      render.beginPanelCut(wordFor(ctx, e.word), focus, d);
      freeze.hold(d, ctx.time);
    }),
  ];
  return () => {
    for (const o of offs) o();
  };
}
