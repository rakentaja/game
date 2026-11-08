import * as THREE from 'three';
import type { GameContext } from '../../core/types';
import { Spawner } from '../../systems/spawner';
import { EnemyRenderer, type EnemyRendererOptions } from './EnemyRenderer';
import { EnemySystem } from './EnemySystem';

export { Enemy } from './Enemy';
export { EnemyRenderer } from './EnemyRenderer';
export { EnemySystem, FIRST_REVEAL_WORD } from './EnemySystem';

export interface EnemiesHandle {
  system: EnemySystem;
  renderer: EnemyRenderer;
  spawner: Spawner;
  /** Fixed sim step. Call after the player step, before reveal.update (blot drain). */
  step(dt: number): void;
  /** Per frame, with time-scaled dt. */
  render(dt: number): void;
  dispose(): void;
}

/**
 * Wire enemies into the game: adds the renderer root to `ctx.render.scene`, registers enemies
 * in `ctx.targets`, and returns a handle. Load levels with `handle.spawner.load(level)` and
 * forward trigger entries with `handle.spawner.fireTrigger(id)`.
 */
export function install(ctx: GameContext, opts: EnemyRendererOptions = {}): EnemiesHandle {
  const system = new EnemySystem(ctx);
  const fallback = new THREE.Vector3();
  const renderer = new EnemyRenderer(system, {
    crystalPos: () =>
      ctx.player
        ? ctx.player.crystalPos
        : fallback.set(ctx.reveal.center.x, ctx.reveal.center.y + 1.9, ctx.reveal.center.z),
    ...opts,
  });
  ctx.render.scene.add(renderer.root);
  const spawner = new Spawner(ctx.events, system);
  const offPage = ctx.events.on('page:start', () => {
    system.clear();
    spawner.reset();
  });
  return {
    system,
    renderer,
    spawner,
    step(dt) {
      spawner.step(dt);
      system.step(dt);
    },
    render(dt) {
      renderer.update(dt, ctx.render.camera);
    },
    dispose() {
      offPage();
      spawner.dispose();
      system.clear();
      renderer.dispose();
    },
  };
}
