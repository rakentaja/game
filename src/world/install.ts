import * as THREE from 'three';
import type { GameContext, LevelDef, PageId, RevealAPI } from '../core/types';
import { InkRain, type RainRender } from '../render/weather/InkRain';
import { Checkpoints } from '../systems/checkpoints';
import { type CrystalSample, SketchObjects } from '../systems/sketch-objects';
import { Triggers } from '../systems/triggers';
import { InkWells } from './inkWells';
import { type BuildOptions, type BuiltLevel, buildLevel } from './LevelBuilder';
import { getLevel } from './levels';
import type { EditorHand } from './meta/EditorHand';
import { installInkMemory } from './meta/inkMemory';
import { type MisprintTarget, MisprintZones } from './meta/misprint';

export interface LevelRuntime {
  readonly def: LevelDef;
  readonly built: BuiltLevel;
  readonly triggers: Triggers;
  readonly sketches: SketchObjects;
  readonly checkpoints: Checkpoints;
  readonly wells: InkWells;
  /** Page-3 storm (null elsewhere). */
  readonly rain: InkRain | null;
  readonly hands: readonly EditorHand[];
  /**
   * Co-op guest: the host owns triggers and sketch printing (they arrive as replicated events);
   * this page only renders them. Set right after install.
   */
  replica: boolean;
  /**
   * Co-op hook (src/coop/level.ts): feeds every wizard to the triggers (page end needs both)
   * and picks the crystal that's over an unprinted sketch. Null in solo play.
   */
  coop: {
    triggers(t: Triggers): void;
    sample(own: CrystalSample, sketches: SketchObjects, def: LevelDef): CrystalSample;
  } | null;
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
    getPlayers: () => ctx.players ?? [],
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

  // The Ink Remembers / Misprint Zones / Editor's Hand / Ink Rain (world-meta workstream)
  const memory = installInkMemory(ctx, def, (x, z) => built.collision.walkable(x, z));
  const renderAny = ctx.render as unknown as Partial<MisprintTarget> & RainRender;
  const misprints = def.misprints?.length
    ? new MisprintZones(def.misprints, renderAny.misprint ? (renderAny as MisprintTarget) : null)
    : null;
  // the Editor's Hand is a lazy chunk (only page 2 has one; it is triggered well into the page)
  const hands: { trigger: string; hand: EditorHand }[] = [];
  const handList: EditorHand[] = [];
  let disposed = false;
  if (def.editorHands?.length)
    void import('./meta/EditorHand').then((m) => {
      if (disposed) return;
      for (const hd of def.editorHands ?? []) {
        const hand = new m.EditorHand(ctx, hd.path, (x, z) => built.collision.groundHeight(x, z));
        hands.push({ trigger: hd.trigger, hand });
        handList.push(hand);
      }
    });
  const offHands = def.editorHands?.length
    ? ctx.events.on('trigger:fired', (e) => {
        for (const h of hands) if (h.trigger === e.id) h.hand.start();
      })
    : null;
  const rain = def.weather === 'inkRain' ? new InkRain(renderAny, ctx.reveal) : null;

  const sample: CrystalSample = { held: false, x: 0, z: 0, radius: 0 };
  const addEnergy = (n: number) => ctx.player?.addEnergy(n);

  return {
    def,
    built,
    triggers,
    sketches,
    checkpoints,
    wells,
    rain,
    hands: handList,
    replica: false,
    coop: null,
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
      triggers.enabled = !this.replica;
      if (p) {
        const pos = p.position;
        if (this.coop) this.coop.triggers(triggers);
        else triggers.update(pos.x, pos.y, pos.z);
        sample.held = p.crystalHeld && !this.replica;
        sample.x = p.crystalPos.x;
        sample.z = p.crystalPos.z;
        sample.radius = ctx.reveal.radius;
        wells.update(dt, pos.x, pos.z, pos.y, addEnergy);
        misprints?.update(dt, pos.x, pos.z);
      } else {
        sample.held = false;
      }
      sketches.update(dt, this.coop && !this.replica ? this.coop.sample(sample, sketches, def) : sample);
      built.syncWells(wells.wells);
      built.update(dt, ctx.time.simTime);
      memory.update(dt);
      for (const h of hands) h.hand.update(dt);
      rain?.update(dt);
    },
    resize() {
      ctx.render.renderer.getDrawingBufferSize(resolution);
    },
    dispose() {
      disposed = true;
      offCleared();
      offHands?.();
      memory.dispose();
      misprints?.dispose();
      for (const h of hands) h.hand.dispose();
      rain?.dispose();
      for (const h of beaconHandles) ctx.reveal.removeSource(h);
      sketches.dispose();
      checkpoints.dispose();
      built.dispose();
    },
  };
}
