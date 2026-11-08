import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../../src/core/events';
import {
  type CollisionAPI,
  type Damageable,
  DEFAULT_SETTINGS,
  type InputAPI,
  type InputState,
  type RevealAPI,
  type Settings,
  type TargetRegistry,
} from '../../src/core/types';
import { TUNING } from '../../src/data/tuning';
import { AutoplayBot } from '../../src/debug/autoplay';
import { Player } from '../../src/entities/Player';
import { Combat } from '../../src/systems/combat';
import { InkEnergy, InkPickups } from '../../src/systems/ink-energy';
import { framingDistance, springStep } from '../../src/world/camera';

const DT = 1 / 60;

function fakeInput(): InputAPI & { state: InputState } {
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

function fakeReveal(): RevealAPI & { sources: number[][] } {
  const sources: number[][] = [];
  return {
    sources,
    center: new THREE.Vector3(),
    radius: 3,
    targetRadius: 3,
    blankPage: 0,
    uniforms: {},
    addSource(x, z, r, life) {
      sources.push([x, z, r, life]);
      return sources.length;
    },
    removeSource() {},
    eraseStrip() {},
    revealAt: () => 1,
    isRevealed: () => true,
    update() {},
    reset() {},
  };
}

const openWorld: CollisionAPI = {
  groundHeight: () => 0,
  resolveCircle: () => false,
  walkable: () => true,
  segmentClear: () => true,
};

/** Wall at z = -3 (blocks north). */
const walledWorld: CollisionAPI = {
  groundHeight: () => 0,
  resolveCircle: (x, z, r, out) => {
    if (z - r < -3) {
      out.set(x, -3 + r);
      return true;
    }
    return false;
  },
  walkable: () => true,
  segmentClear: () => true,
};

function rig(opts: { world?: CollisionAPI; settings?: Partial<Settings> } = {}) {
  const events = new EventBus<GameEvents>();
  const input = fakeInput();
  const reveal = fakeReveal();
  const energy = new InkEnergy(events, TUNING);
  const settings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const log: { type: string; payload: unknown }[] = [];
  const orig = events.emit.bind(events);
  events.emit = ((type: keyof GameEvents, payload: never) => {
    log.push({ type, payload: JSON.parse(JSON.stringify(payload)) });
    orig(type, payload);
  }) as typeof events.emit;
  const player = new Player(
    {
      events,
      tuning: TUNING,
      settings,
      input,
      collision: opts.world ?? openWorld,
      reveal,
      render: { createInkMaterial: () => new THREE.ShaderMaterial(), addOutline: () => () => {} },
    },
    energy,
  );
  player.teleport(0, 0, 0, 0);
  const run = (seconds: number, each?: (i: number) => void) => {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      each?.(i);
      player.step(DT);
      input.state.boltPressed = false;
      input.state.dashPressed = false;
    }
  };
  const count = (type: string) => log.filter((e) => e.type === type).length;
  return { events, input, reveal, energy, player, run, log, count, settings };
}

describe('InkEnergy', () => {
  it('spend is all-or-nothing', () => {
    const e = new InkEnergy(null, TUNING);
    e.reset(4);
    expect(e.spend(5)).toBe(false);
    expect(e.value).toBe(4);
    expect(e.spend(4)).toBe(true);
    expect(e.value).toBe(0);
  });

  it('drain and add clamp to bounds', () => {
    const e = new InkEnergy(null, TUNING);
    e.reset(3);
    expect(e.drain(10)).toBe(3);
    expect(e.empty).toBe(true);
    expect(e.add(500)).toBe(TUNING.energy.max);
    expect(e.value).toBe(TUNING.energy.max);
  });

  it('emits energy:changed only when the shown integer changes', () => {
    const ev = new EventBus<GameEvents>();
    const seen: number[] = [];
    ev.on('energy:changed', ({ value }) => seen.push(value));
    const e = new InkEnergy(ev, TUNING);
    seen.length = 0;
    for (let i = 0; i < 60; i++) e.drain(12 / 60); // one second of crystal
    expect(seen.length).toBeLessThanOrEqual(13);
    expect(seen.at(-1)).toBe(88);
  });
});

describe('InkPickups', () => {
  it('drops ink on enemy death and magnets it into the player', () => {
    const events = new EventBus<GameEvents>();
    const pk = new InkPickups({ events, tuning: TUNING });
    events.emit('enemy:died', { id: 1, kind: 'smudge', position: [1, 0, 1] });
    expect(pk.active).toBe(Math.ceil(TUNING.enemies.smudge.inkDrop / TUNING.energy.dropletValue));
    const player = { position: new THREE.Vector3(0, 0, 0), energy: 50 } as never;
    let got = 0;
    let collected = 0;
    events.on('ink:collected', () => collected++);
    const add = (n: number) => {
      got += n;
      return n;
    };
    for (let i = 0; i < 240; i++) pk.step(DT, player, add);
    expect(got).toBe(TUNING.enemies.smudge.inkDrop);
    expect(pk.active).toBe(0);
    expect(collected).toBeGreaterThan(0);
  });

  it('does not pull droplets when the player is full', () => {
    const events = new EventBus<GameEvents>();
    const pk = new InkPickups({ events, tuning: TUNING });
    pk.spawn(0.5, 0, 0.5, 6);
    const player = { position: new THREE.Vector3(), energy: TUNING.energy.max } as never;
    for (let i = 0; i < 120; i++) pk.step(DT, player, (n) => n);
    expect(pk.active).toBe(2);
  });
});

describe('camera math', () => {
  it('critically damped spring converges without overshoot', () => {
    const s = { x: 0, v: 0 };
    let max = 0;
    for (let i = 0; i < 240; i++) {
      springStep(s, 1, 6, DT);
      max = Math.max(max, s.x);
    }
    expect(s.x).toBeCloseTo(1, 3);
    expect(max).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('is stable at huge dt', () => {
    const s = { x: 0, v: 0 };
    springStep(s, 10, 30, 1);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Math.abs(s.x)).toBeLessThan(20);
  });

  it('portrait framing pushes the boom back to keep the minimum width', () => {
    const wide = framingDistance(16 / 9, 50, 9, 7.5, 15);
    const tall = framingDistance(390 / 844, 50, 9, 7.5, 15);
    expect(wide).toBe(9);
    expect(tall).toBeGreaterThan(9);
    expect(tall).toBeLessThanOrEqual(15);
  });
});

describe('Player controller', () => {
  it('accelerates to run speed on full stick and to walk speed on a light push', () => {
    const r = rig();
    r.input.state.move.set(0, 1);
    r.run(1);
    expect(Math.hypot(r.player.velocity.x, r.player.velocity.z)).toBeCloseTo(TUNING.player.runSpeed, 1);
    // screen up = world -Z with the default view
    expect(r.player.position.z).toBeLessThan(-2);
    r.input.state.move.set(0, TUNING.player.walkThreshold);
    r.run(1);
    expect(Math.hypot(r.player.velocity.x, r.player.velocity.z)).toBeCloseTo(TUNING.player.walkSpeed, 1);
  });

  it('stops faster than it starts (snappy decel)', () => {
    const r = rig();
    r.input.state.move.set(1, 0);
    r.run(1);
    r.input.state.move.set(0, 0);
    let frames = 0;
    r.run(1, () => {
      if (Math.hypot(r.player.velocity.x, r.player.velocity.z) > 0.01) frames++;
    });
    expect(frames * DT).toBeLessThan(TUNING.player.runSpeed / TUNING.player.decel + 0.05);
  });

  it('turns to face the move direction', () => {
    const r = rig();
    r.input.state.move.set(1, 0);
    r.run(0.5);
    expect(r.player.facing.x).toBeGreaterThan(0.95);
  });

  it('is blocked by collision', () => {
    const r = rig({ world: walledWorld });
    r.input.state.move.set(0, 1);
    r.run(2);
    expect(r.player.position.z).toBeGreaterThanOrEqual(-3 + TUNING.player.radius - 1e-6);
  });

  it('dash covers ~4 m with i-frames, leaves a reveal trail, then cools down', () => {
    const r = rig();
    r.input.state.dashPressed = true;
    r.input.state.dashDir.set(1, 0);
    r.run(DT);
    expect(r.player.invulnerable).toBe(true);
    expect(r.player.dashing).toBe(true);
    r.run(TUNING.dash.duration + 0.05);
    expect(r.player.position.x).toBeGreaterThan(TUNING.dash.distance * 0.95);
    expect(r.player.position.x).toBeLessThan(TUNING.dash.distance + 0.6);
    expect(r.reveal.sources.length).toBeGreaterThanOrEqual(4);
    expect(r.count('player:dash')).toBe(1);
    // second dash during cooldown does nothing
    const x = r.player.position.x;
    r.input.state.dashPressed = true;
    r.input.state.dashDir.set(1, 0);
    r.run(0.3);
    expect(r.count('player:dash')).toBe(1);
    expect(r.player.position.x - x).toBeLessThan(1.5);
    expect(r.player.dashCooldown01).toBeGreaterThan(0);
  });

  it('dash with no direction goes where the wizard faces', () => {
    const r = rig();
    r.player.teleport(0, 0, 0, Math.PI / 2); // facing +X
    r.input.state.dashPressed = true;
    r.input.state.dashDir.set(0, 0);
    r.run(0.4);
    expect(r.player.position.x).toBeGreaterThan(3.5);
  });

  it('crystal: grows 3→7 m over ~0.6 s, drains 12/s, dims at 0, shrinks back', () => {
    const r = rig();
    r.input.state.crystalHeld = true;
    r.run(0.3);
    expect(r.reveal.targetRadius).toBeGreaterThan(TUNING.crystal.radiusIdle);
    expect(r.reveal.targetRadius).toBeLessThan(TUNING.crystal.radiusHeld);
    r.run(0.35);
    expect(r.reveal.targetRadius).toBeCloseTo(TUNING.crystal.radiusHeld, 1);
    expect(r.player.crystalHeld).toBe(true);
    expect(r.energy.value).toBeCloseTo(100 - 12 * 0.65, 0);
    expect(r.count('crystal:hold')).toBe(1);
    r.run(10);
    expect(r.energy.value).toBe(0);
    expect(r.player.crystalHeld).toBe(false);
    expect(r.reveal.targetRadius).toBeCloseTo(TUNING.crystal.radiusDim, 1);
    r.input.state.crystalHeld = false;
    r.energy.add(50);
    r.run(2);
    expect(r.reveal.targetRadius).toBeCloseTo(TUNING.crystal.radiusIdle, 1);
  });

  it('story difficulty halves damage and crystal cost', () => {
    const r = rig({ settings: { difficulty: 'story' } });
    r.player.damage(1, 'smudge');
    expect(r.player.pages).toBe(TUNING.player.maxPages - 0.5);
    r.input.state.crystalHeld = true;
    r.run(1);
    expect(r.energy.value).toBeCloseTo(100 - 12 * TUNING.difficulty.story.energyCost, 0);
  });

  it('damage: i-frames, knockback away from the source, events', () => {
    const r = rig();
    r.player.damage(1, 'smudge', new THREE.Vector3(-1, 0, 0));
    expect(r.player.pages).toBe(4);
    expect(r.player.invulnerable).toBe(true);
    r.player.damage(1, 'smudge');
    expect(r.player.pages).toBe(4);
    r.run(0.3);
    expect(r.player.position.x).toBeGreaterThan(0.3);
    const ev = r.log.find((e) => e.type === 'player:damaged')!.payload as { pagesLeft: number };
    expect(ev.pagesLeft).toBe(4);
    expect(r.count('fx:hitstop')).toBe(1);
    r.run(TUNING.player.iFramesOnHit);
    expect(r.player.invulnerable).toBe(false);
  });

  it('dies at 0 pages, emits player:died after the death beat, revives on respawn', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      r.player.damage(1, 'smudge');
      r.run(TUNING.player.iFramesOnHit + 0.05);
    }
    expect(r.player.pages).toBe(0);
    expect(r.player.isAlive).toBe(false);
    expect(r.count('player:died')).toBe(0); // death beat plays first
    r.run(TUNING.player.deathDelay);
    expect(r.count('player:died')).toBe(1);
    r.input.state.move.set(1, 0);
    const x = r.player.position.x;
    r.run(0.5);
    expect(r.player.position.x).toBeCloseTo(x, 3);
    r.events.emit('player:respawn', { checkpointId: 'a' });
    expect(r.player.isAlive).toBe(true);
    expect(r.player.pages).toBe(TUNING.player.maxPages);
  });

  it('setControllable(false) ignores input', () => {
    const r = rig();
    r.player.setControllable(false);
    r.input.state.move.set(1, 0);
    r.run(0.5);
    expect(r.player.position.length()).toBeLessThan(1e-6);
  });

  it('writes the reveal centre at the crystal every step', () => {
    const r = rig();
    r.input.state.move.set(1, 0);
    r.run(0.5);
    expect(r.reveal.center.x).toBeCloseTo(r.player.crystalPos.x, 5);
    expect(r.reveal.center.y).toBeGreaterThan(1.5);
  });
});

class Target implements Damageable {
  static next = 1;
  readonly id = Target.next++;
  readonly position: THREE.Vector3;
  readonly radius = 0.45;
  alive = true;
  revealed = true;
  hp = 2;
  hits = 0;
  constructor(x: number, z: number) {
    this.position = new THREE.Vector3(x, 0, z);
  }
  hit(n: number): void {
    this.hits++;
    this.hp -= n;
    if (this.hp <= 0) this.alive = false;
  }
}

function registry(list: Target[]): TargetRegistry {
  return {
    add: (t) => list.push(t as Target),
    remove: () => {},
    nearest(p, max) {
      let best: Target | null = null;
      let bd = max;
      for (const t of list) {
        if (!t.alive || !t.revealed) continue;
        const d = Math.hypot(t.position.x - p.x, t.position.z - p.z);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      return best;
    },
    forEach: (fn) => list.forEach(fn),
  };
}

describe('Combat', () => {
  function combatRig(targets: Target[]) {
    const r = rig();
    const combat = new Combat(
      {
        events: r.events,
        tuning: TUNING,
        settings: r.settings,
        input: r.input,
        targets: registry(targets),
        collision: openWorld,
        seed: 3,
      },
      r.player,
      r.energy,
    );
    const step = (seconds: number) => {
      const n = Math.round(seconds / DT);
      for (let i = 0; i < n; i++) {
        r.player.step(DT);
        combat.step(DT);
        r.input.state.boltPressed = false;
      }
    };
    return { ...r, combat, step };
  }

  it('fires at the nearest revealed target, costs ink, hits, and the first kill is a panel cut', () => {
    const near = new Target(0, -4);
    const far = new Target(0, -9);
    const c = combatRig([far, near]);
    c.input.state.boltPressed = true;
    c.step(1);
    expect(c.energy.value).toBe(100 - TUNING.bolt.cost);
    expect(near.hits).toBe(1);
    expect(far.hits).toBe(0);
    expect(c.count('bolt:hit')).toBe(1);
    c.input.state.boltPressed = true;
    c.step(1);
    expect(near.alive).toBe(false);
    const panel = c.log.filter((e) => e.type === 'fx:panelCut');
    expect(panel.length).toBe(1);
    const hit = c.log.filter((e) => e.type === 'bolt:hit').at(-1)!.payload as { critical: boolean };
    expect(hit.critical).toBe(true);
  });

  it('never targets unrevealed enemies', () => {
    const hidden = new Target(0, -3);
    hidden.revealed = false;
    const c = combatRig([hidden]);
    c.input.state.boltPressed = true;
    c.step(1.2);
    expect(hidden.hits).toBe(0);
    const fire = c.log.find((e) => e.type === 'bolt:fire')!.payload as { targetId: number | null };
    expect(fire.targetId).toBeNull();
  });

  it('respects cooldown and fizzles without ink', () => {
    const c = combatRig([]);
    c.input.state.boltPressed = true;
    c.step(DT);
    c.input.state.boltPressed = true;
    c.step(DT);
    expect(c.count('bolt:fire')).toBe(1);
    c.energy.reset(2);
    c.step(0.5);
    c.input.state.boltPressed = true;
    c.step(0.5);
    expect(c.count('bolt:fire')).toBe(1);
    expect(c.energy.value).toBe(2);
  });

  it('buffers a tap pressed slightly before the cooldown ends', () => {
    const c = combatRig([]);
    c.input.state.boltPressed = true;
    c.step(DT);
    c.step(TUNING.bolt.cooldown - 0.08);
    c.input.state.boltPressed = true;
    c.step(0.2);
    expect(c.count('bolt:fire')).toBe(2);
  });
});

describe('AutoplayBot', () => {
  it('walks the path, shoots revealed targets, holds the crystal at sketches', () => {
    const r = rig();
    const t = new Target(1, -10);
    const view = { forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0) };
    const bot = new AutoplayBot(
      {
        input: r.input,
        events: r.events,
        tuning: TUNING,
        targets: registry([t]),
        getPlayer: () => r.player,
        view,
      },
      {
        path: [
          [0, 0],
          [0, -10],
          [0, -20],
        ],
        sketches: [{ id: 'b', at: [0, 0, -18] }],
      },
    );
    const combat = new Combat(
      {
        events: r.events,
        tuning: TUNING,
        settings: r.settings,
        input: r.input,
        targets: registry([t]),
        collision: openWorld,
      },
      r.player,
      r.energy,
    );
    let held = 0;
    for (let i = 0; i < 60 * 14; i++) {
      bot.drive(r.input.state, DT);
      if (r.input.state.crystalHeld && bot.mode === 'print') held++;
      r.player.step(DT);
      combat.step(DT);
      if (i === 60 * 11) r.events.emit('sketch:printed', { id: 'b' });
    }
    expect(t.hits).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(30);
    expect(r.player.position.z).toBeLessThan(-17);
    bot.dispose();
  });
});
