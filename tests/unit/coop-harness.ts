/**
 * Headless two-machine co-op harness: two independent sims (own bus, reveal, enemies, wizard,
 * page triggers/checkpoints) connected by NetSessions over Loopback (+ Lossy) transports on one
 * ManualScheduler. Mirrors Game.step's call order for the co-op hooks.
 */
import * as THREE from 'three';
import { NetCoop } from '../../src/coop/net';
import type { CoopHost } from '../../src/coop/types';
import { EventBus, type GameEvents } from '../../src/core/events';
import {
  type CollisionAPI,
  DEFAULT_SETTINGS,
  type GameContext,
  type InputAPI,
  type InputState,
  type LevelDef,
  type PageId,
  type RunStats,
} from '../../src/core/types';
import { TUNING } from '../../src/data/tuning';
import { EnemySystem } from '../../src/entities/enemies/EnemySystem';
import { Player } from '../../src/entities/Player';
import { ManualScheduler } from '../../src/net/clock';
import { LoopbackTransport } from '../../src/net/loopback';
import { LossyTransport } from '../../src/net/lossy';
import { NetSession } from '../../src/net/session';
import type { Transport } from '../../src/net/transport';
import { RevealSystem } from '../../src/render/reveal/RevealSystem';
import { Checkpoints } from '../../src/systems/checkpoints';
import { InkEnergy, InkPickups } from '../../src/systems/ink-energy';
import { SketchObjects } from '../../src/systems/sketch-objects';
import { Spawner } from '../../src/systems/spawner';
import { createTargets } from '../../src/systems/targets';
import { Triggers } from '../../src/systems/triggers';
import type { LevelRuntime } from '../../src/world/install';

export const DT = 1 / 60;

export function fakeInput(): InputAPI & { state: InputState } {
  return {
    state: {
      move: new THREE.Vector2(),
      crystalHeld: false,
      boltPressed: false,
      dashPressed: false,
      dashDir: new THREE.Vector2(),
      pausePressed: false,
      device: 'touch',
    },
    poll() {},
    setLeftHanded() {},
    setEnabled() {},
    dispose() {},
  };
}

export const flat: CollisionAPI = {
  groundHeight: () => 0,
  resolveCircle(x, z, _r, out) {
    out.set(x, z);
    return false;
  },
  walkable: () => true,
  segmentClear: () => true,
};

export const TEST_LEVEL: LevelDef = {
  page: 1,
  titleKey: 'page.1',
  seed: 1,
  path: [
    [0, 0],
    [0, -20],
    [0, -40],
  ],
  pathWidth: 4,
  clearings: [],
  playerStart: { at: [0, 0, 0], rotY: Math.PI },
  checkpoints: [{ id: 'start', at: [0, 0, 0] }],
  spawns: [],
  sketches: [],
  triggers: [{ id: 'exit', rect: [-4, -44, 4, -36], action: { type: 'pageEnd' } }],
  props: [],
  treeDensity: 0,
  fog: { near: 9, far: 26 },
  inkWells: [],
  music: 'explore',
};

function freshStats(): RunStats {
  return {
    timeS: 0,
    ghostsInked: 0,
    inkCollected: 0,
    pagesTorn: 0,
    deaths: 0,
    boltsFired: 0,
    boltsHit: 0,
    bestPanel: null,
  };
}

export interface Side {
  ctx: GameContext;
  host: CoopHost;
  player: Player;
  input: InputAPI & { state: InputState };
  energy: InkEnergy;
  enemies: EnemySystem;
  level: LevelRuntime;
  coop: NetCoop | null;
  page: PageId;
  turned: PageId[];
  ev: EventBus<GameEvents>;
}

export function makeSide(sched: ManualScheduler): Side {
  const ev = new EventBus<GameEvents>();
  const reveal = new RevealSystem(64);
  reveal.setHistoryBounds(-60, -60, 120);
  const scene = new THREE.Scene();
  const render = {
    scene,
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: { clientWidth: 100, clientHeight: 100 } },
    shared: {},
    createInkMaterial: () => new THREE.ShaderMaterial(),
    addOutline: () => () => {},
  } as unknown as GameContext['render'];
  const input = fakeInput();
  const ctx: GameContext = {
    events: ev,
    tuning: TUNING,
    settings: { ...DEFAULT_SETTINGS },
    render,
    reveal,
    input,
    audio: { play() {}, loop: () => () => {} } as unknown as GameContext['audio'],
    collision: flat,
    targets: createTargets(),
    player: null,
    stats: freshStats(),
    time: { scale: 1, simTime: 0 },
    t: (k) => k,
  };
  const energy = new InkEnergy(ev, TUNING);
  const player = new Player(
    {
      events: ev,
      tuning: TUNING,
      settings: ctx.settings,
      input,
      collision: flat,
      reveal,
      render,
      targets: ctx.targets,
      scene: () => null,
      playerCount: () => ctx.players?.length ?? 1,
    },
    energy,
  );
  ctx.player = player;
  ctx.players = [player];
  const enemies = new EnemySystem(
    {
      events: ev,
      tuning: TUNING,
      reveal,
      targets: ctx.targets,
      player,
      collision: flat,
      settings: ctx.settings,
    },
    7,
  );
  const spawner = new Spawner(ev, enemies);
  const pickups = new InkPickups({ events: ev, tuning: TUNING });
  const def = TEST_LEVEL;
  const triggers = new Triggers(def.triggers, ev, 1);
  const sketches = new SketchObjects(ev);
  const checkpoints = new Checkpoints(def, ev, () => ctx.player, {
    getPlayers: () => ctx.players ?? [],
    setTimeout: (fn, ms) => sched.setTimeout(fn, ms),
  });
  const level = {
    def,
    built: { collision: flat },
    triggers,
    sketches,
    checkpoints,
    replica: false,
    coop: null,
  } as unknown as LevelRuntime;
  const side: Side = {
    ctx,
    player,
    input,
    energy,
    enemies,
    level,
    coop: null,
    page: 1,
    turned: [],
    ev,
    host: null as unknown as CoopHost,
  };
  side.host = {
    ctx,
    player,
    energy,
    combat: {} as CoopHost['combat'],
    enemies,
    spawner,
    pickups,
    rig: {
      forward: new THREE.Vector3(0, 0, -1),
      right: new THREE.Vector3(1, 0, 0),
    } as unknown as CoopHost['rig'],
    level: () => level,
    page: () => side.page,
    editor: () => null,
    mode: () => 'playing',
    startRun: async () => {},
    startPage: async () => {},
    turnTo: async (p) => {
      side.turned.push(p);
      side.coop?.onPageTeardown();
      side.page = p;
      enemies.clear();
      side.coop?.onPageStart(p);
    },
    session: () => side.coop,
    stepSim: () => {},
    lastFrameAt: () => 0,
    setSession: (c) => {
      side.coop = c as NetCoop | null;
    },
    endCoop: () => {
      side.coop?.dispose();
      side.coop = null;
    },
  };
  ev.on('page:complete', ({ page }) => {
    if (!side.coop?.handlePageComplete(page)) void side.host.turnTo(((page as number) + 1) as PageId);
  });
  return side;
}

/** One fixed step in Game.step order (co-op hooks included). */
export function stepSide(s: Side, dt = DT): void {
  s.player.step(dt);
  s.coop?.stepPlayers(dt);
  s.coop?.stepPickups(dt);
  s.coop?.preWorld(dt);
  s.enemies.step(dt);
  const lvl = s.level;
  lvl.triggers.enabled = !lvl.replica;
  if (lvl.coop) lvl.coop.triggers(lvl.triggers);
  else lvl.triggers.update(s.player.position.x, 0, s.player.position.z);
  s.coop?.postStep(dt);
  s.ctx.reveal.update(dt);
}

export interface Pair {
  sched: ManualScheduler;
  host: Side;
  guest: Side;
  hs: NetSession;
  gs: NetSession;
  links: [LoopbackTransport, LoopbackTransport];
  /** Advance both sims (and the network) by `seconds`. */
  run(seconds: number, each?: () => void): void;
}

export async function makePair(
  netsim: { rtt: number; jitter: number; loss: number; seed?: number } | null,
  heroes: string[] = ['inker', 'inker'],
): Promise<Pair> {
  const sched = new ManualScheduler();
  const [a, b] = LoopbackTransport.pair('host', 'guest', sched);
  const wrap = (t: Transport, seed: number): Transport =>
    netsim ? new LossyTransport(t, { ...netsim, reorder: 0, seed }, sched) : t;
  const ta = wrap(a, (netsim?.seed ?? 3) + 1);
  const tb = wrap(b, (netsim?.seed ?? 3) + 2);
  const hs = new NetSession({
    role: 'host',
    code: 'TEST22',
    connect: async () => ta,
    scheduler: sched,
    watchVisibility: false,
    token: 'h',
  });
  const gs = new NetSession({
    role: 'guest',
    code: 'TEST22',
    connect: async () => tb,
    scheduler: sched,
    watchVisibility: false,
    token: 'g',
  });
  await hs.start();
  await gs.start();
  for (let i = 0; i < 40 && (hs.state !== 'connected' || gs.state !== 'connected'); i++) {
    sched.advance(50);
    await Promise.resolve();
  }
  // let the clock sync settle
  for (let i = 0; i < 5; i++) sched.advance(1000);
  const host = makeSide(sched);
  const guest = makeSide(sched);
  host.coop = new NetCoop(host.host, null, {
    session: hs,
    slot: 0,
    seed: 1,
    heroes,
    expose: false,
  });
  guest.coop = new NetCoop(guest.host, null, {
    session: gs,
    slot: 1,
    seed: 1,
    heroes,
    expose: false,
  });
  for (const s of [host, guest]) s.coop!.onPageTeardown();
  for (const s of [host, guest]) s.coop!.onPageStart(1);
  guest.player.teleport(1.4, 0, 0);
  const pair: Pair = {
    sched,
    host,
    guest,
    hs,
    gs,
    links: [a, b],
    run(seconds, each) {
      const n = Math.round(seconds / DT);
      for (let i = 0; i < n; i++) {
        sched.advance(1000 * DT);
        stepSide(host);
        stepSide(guest);
        each?.();
      }
    },
  };
  return pair;
}
