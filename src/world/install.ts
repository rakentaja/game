import * as THREE from 'three';
import type { GameContext, LevelDef, PageId, RevealAPI } from '../core/types';
import { Checkpoints } from '../systems/checkpoints';
import { type CrystalSample, SketchObjects } from '../systems/sketch-objects';
import { Triggers } from '../systems/triggers';
import { InkWells } from './inkWells';
import { type BuildOptions, type BuiltLevel, buildLevel } from './LevelBuilder';
import { getLevel } from './levels';

export interface LevelRuntime {
  readonly def: LevelDef;
  readonly built: BuiltLevel;
  readonly triggers: Triggers;
  readonly sketches: SketchObjects;
  readonly checkpoints: Checkpoints;
  readonly wells: InkWells;
  /** Teleport the player to the page start (or a saved checkpoint) and announce the page. */
  start(checkpointId?: string): void;
  /** Once per sim step, after the player moved. */
  update(dt: number): void;
  /** Call on renderer resize (pencil strokes are screen-space). */
  resize(): void;
  dispose(): void;
}

/**
 * Builds a page into `ctx.render.scene` and wires its systems: collision → ctx.collision,
 * triggers, sketch printing, ink wells, checkpoints/respawn and permanent reveal beacons.
 * Usage (main.ts): `level?.dispose(); level = installLevel(ctx, page); level.start();`
 * and inside `render.pageTurn(swap)` for page changes.
 */
export function installLevel(
  ctx: GameContext,
  page: PageId | LevelDef,
  extra: Pick<BuildOptions, 'assets'> = {},
): LevelRuntime {
  const def = typeof page === 'object' ? page : getLevel(page);
  const resolution = new THREE.Vector2();
  ctx.render.renderer.getDrawingBufferSize(resolution);
  const built = buildLevel(def, {
    material: (o) => ctx.render.createInkMaterial(o),
    resolution,
    shared: ctx.render.shared,
    assets: extra.assets,
  });
  ctx.render.scene.add(built.root);
  ctx.collision = built.collision;

  // fresh reveal history sized to this page; fog + mood from the LevelDef
  ctx.reveal.reset();
  const hf = built.data.height;
  const size = Math.max(hf.maxX - hf.x0, hf.maxZ - hf.z0);
  (
    ctx.reveal as RevealAPI & { setHistoryBounds?: (x: number, z: number, s: number) => void }
  ).setHistoryBounds?.(hf.x0, hf.z0, size);
  const sh = ctx.render.shared;
  if (sh.uFogNear) sh.uFogNear.value = def.fog.near;
  if (sh.uFogFar) sh.uFogFar.value = def.fog.far;
  if (def.mood?.keyDir && sh.uKeyDir) (sh.uKeyDir.value as THREE.Vector3).set(...def.mood.keyDir).normalize();
  if (def.mood?.shadow !== undefined && sh.uShadow) sh.uShadow.value = def.mood.shadow;

  const beaconHandles = built.beacons.map((b) => ctx.reveal.addSource(b.x, b.z, b.r, 1e9));
  const triggers = new Triggers(def.triggers, ctx.events, def.page);
  const sketches = new SketchObjects(ctx.events, {
    collision: built.collision,
    reveal: ctx.reveal,
    visuals: built.sketchVisual,
    groundY: (x, z) => built.collision.groundHeight(x, z),
  });
  for (const s of def.sketches) sketches.add(s);
  const wells = new InkWells(def.inkWells, ctx.events);
  const checkpoints = new Checkpoints(def, ctx.events, () => ctx.player, {
    reprint: (swap, d) => ctx.render.pageTurn(swap, d),
    groundY: (x, z) => built.collision.groundHeight(x, z),
    onRespawn: () => {
      triggers.rearmEncounters();
      sketches.resetUnprinted();
      wells.refillAll();
    },
  });

  // a fully cleared encounter fires `<trigger>_cleared` (gates SketchObjectDef.requires, e.g. the boss door)
  const offCleared = ctx.events.on('wave:cleared', (e) => {
    if (e.last && e.trigger) ctx.events.emit('trigger:fired', { id: `${e.trigger}_cleared` });
  });

  const sample: CrystalSample = { held: false, x: 0, z: 0, radius: 0 };
  const addEnergy = (n: number) => ctx.player?.addEnergy(n);

  return {
    def,
    built,
    triggers,
    sketches,
    checkpoints,
    wells,
    start(checkpointId) {
      const id = checkpointId ?? def.checkpoints[0]?.id;
      if (id) checkpoints.current = id;
      const [x, , z] = checkpoints.position(id);
      ctx.player?.teleport(x, built.collision.groundHeight(x, z), z, def.playerStart.rotY);
      ctx.events.emit('page:start', { page: def.page });
      if (id) checkpoints.reach(id);
    },
    update(dt) {
      const p = ctx.player;
      if (p) {
        const pos = p.position;
        triggers.update(pos.x, pos.y, pos.z);
        sample.held = p.crystalHeld;
        sample.x = p.crystalPos.x;
        sample.z = p.crystalPos.z;
        sample.radius = ctx.reveal.radius;
        wells.update(dt, pos.x, pos.z, pos.y, addEnergy);
      } else {
        sample.held = false;
      }
      sketches.update(dt, sample);
      built.syncWells(wells.wells);
      built.update(dt, ctx.time.simTime);
    },
    resize() {
      ctx.render.renderer.getDrawingBufferSize(resolution);
    },
    dispose() {
      offCleared();
      for (const h of beaconHandles) ctx.reveal.removeSource(h);
      sketches.dispose();
      checkpoints.dispose();
      built.dispose();
    },
  };
}
