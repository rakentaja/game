import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../../src/core/events';
import type { DamageSource, PlayerAPI, RevealAPI } from '../../src/core/types';
import { TUNING } from '../../src/data/tuning';
import { EnemySystem } from '../../src/entities/enemies/EnemySystem';
import { AiState, canTransition } from '../../src/systems/ai/fsm';
import { orbit, separation, steerToward } from '../../src/systems/ai/steering';
import { Spawner } from '../../src/systems/spawner';
import { Targets } from '../../src/systems/targets';

const DT = 1 / 60;

class FakeReveal implements RevealAPI {
  center = new THREE.Vector3();
  radius = 3;
  targetRadius = 3;
  blankPage = 0;
  uniforms = {};
  addSource() {
    return 0;
  }
  removeSource() {}
  eraseStrip() {}
  revealAt(x: number, z: number) {
    return Math.hypot(x - this.center.x, z - this.center.z) < this.radius ? 1 : 0;
  }
  isRevealed(x: number, z: number) {
    return this.revealAt(x, z) > 0.5;
  }
  update() {}
  reset() {}
}

class FakePlayer implements PlayerAPI {
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  facing = new THREE.Vector3(0, 0, 1);
  crystalPos = new THREE.Vector3(0, 2, 0);
  pages = 5;
  energy = 100;
  invulnerable = false;
  crystalHeld = false;
  object = new THREE.Object3D();
  hits: DamageSource[] = [];
  damage(_a: number, s: DamageSource) {
    this.hits.push(s);
  }
  addEnergy() {}
  teleport() {}
  setControllable() {}
  playClip() {}
}

function setup(difficulty: 'story' | 'normal' = 'normal') {
  const events = new EventBus<GameEvents>();
  const reveal = new FakeReveal();
  const player = new FakePlayer();
  const targets = new Targets();
  const stats = { ghostsInked: 0 } as never;
  const sys = new EnemySystem(
    { events, tuning: TUNING, reveal, targets, player, stats, settings: { difficulty } },
    42,
  );
  const log: { type: keyof GameEvents; p: unknown }[] = [];
  for (const t of [
    'enemy:revealed',
    'enemy:died',
    'ink:drop',
    'fx:panelCut',
    'enemy:telegraph',
    'wave:cleared',
  ] as const)
    events.on(t, (p) => log.push({ type: t, p }));
  return { events, reveal, player, targets, sys, log };
}

function run(sys: EnemySystem, seconds: number, each?: () => void) {
  for (let t = 0; t < seconds; t += DT) {
    sys.step(DT);
    each?.();
  }
}

describe('fsm', () => {
  it('only allows legal transitions', () => {
    expect(canTransition(AiState.Idle, AiState.Stalk)).toBe(true);
    expect(canTransition(AiState.Stalk, AiState.Attack)).toBe(true);
    expect(canTransition(AiState.Attack, AiState.Recoil)).toBe(true);
    expect(canTransition(AiState.Die, AiState.Stalk)).toBe(false);
    expect(canTransition(AiState.Idle, AiState.Attack)).toBe(false);
  });

  it('idle → stalk once the player is in aggro range', () => {
    const { sys } = setup();
    const e = sys.spawn('smudge', 6, 0)!;
    expect(e.state).toBe(AiState.Idle);
    run(sys, 1.5);
    expect(e.state).not.toBe(AiState.Idle);
  });

  it('stays idle without a player', () => {
    const { sys } = setup();
    sys.deps.player = null;
    const e = sys.spawn('smudge', 6, 0)!;
    run(sys, 3);
    expect(e.state).toBe(AiState.Idle);
  });

  it('smudge stalks outside the reveal edge, then darts and hits the player', () => {
    const { sys, player, log } = setup();
    const e = sys.spawn('smudge', 6, 0)!;
    let sawAttack = false;
    let minOutside = Number.POSITIVE_INFINITY;
    run(sys, 8, () => {
      if (!sawAttack && e.state === AiState.Stalk && e.stateT > 1)
        minOutside = Math.min(minOutside, e.position.length());
      if (e.state === AiState.Attack) sawAttack = true;
    });
    expect(minOutside).toBeGreaterThan(3); // lurks beyond radius 3
    expect(sawAttack).toBe(true);
    expect(log.some((l) => l.type === 'enemy:telegraph')).toBe(true);
    expect(player.hits).toContain('smudge');
  });

  it('scribbler telegraphs 0.8 s then fires a projectile that hurts', () => {
    const { sys, player, log } = setup();
    const e = sys.spawn('scribbler', 6, 0)!;
    let attackStart = -1;
    let fired = -1;
    let t = 0;
    run(sys, 6, () => {
      t += DT;
      if (attackStart < 0 && e.state === AiState.Attack) attackStart = t;
      if (fired < 0 && sys.projectiles.active.some((a) => a === 1)) fired = t;
    });
    expect(log.some((l) => l.type === 'enemy:telegraph')).toBe(true);
    expect(fired - attackStart).toBeCloseTo(TUNING.enemies.scribbler.telegraph, 1);
    expect(player.hits).toContain('scribbler');
  });

  it('blot drains the reveal radius near the crystal', () => {
    const { sys, reveal } = setup();
    sys.spawn('blot', 2, 0);
    let minTarget = 99;
    run(sys, 4, () => {
      minTarget = Math.min(minTarget, reveal.targetRadius);
      reveal.targetRadius = 3; // player rewrites it every step
    });
    expect(minTarget).toBeLessThan(3);
    expect(minTarget).toBeGreaterThanOrEqual(3 * TUNING.enemies.blotAi.minRadiusFactor - 1e-6);
  });
});

describe('damage', () => {
  it('ignores hits while unrevealed', () => {
    const { sys } = setup();
    sys.deps.player = null;
    const e = sys.spawn('smudge', 10, 0)!;
    run(sys, 0.1);
    e.hit(1, new THREE.Vector3());
    expect(e.hp).toBe(TUNING.enemies.smudge.hp);
  });

  it('hit → recoil, lethal hit → die with events, ink drop and first-reveal panel cut', () => {
    const { sys, log, targets } = setup();
    sys.deps.player = null;
    const e = sys.spawn('scribbler', 1, 0)!;
    run(sys, 0.1);
    expect(e.revealed).toBe(true);
    expect(log.filter((l) => l.type === 'enemy:revealed')).toHaveLength(1);
    expect(log.filter((l) => l.type === 'fx:panelCut')).toHaveLength(1);
    e.hit(1, new THREE.Vector3());
    expect(e.state).toBe(AiState.Recoil);
    expect(e.hp).toBe(2);
    e.hit(5, new THREE.Vector3());
    expect(e.alive).toBe(false);
    expect(e.state).toBe(AiState.Die);
    expect(log.some((l) => l.type === 'enemy:died')).toBe(true);
    const drop = log.find((l) => l.type === 'ink:drop')!.p as { amount: number };
    expect(drop.amount).toBe(TUNING.enemies.scribbler.inkDrop);
    expect(targets.nearest(new THREE.Vector3(), 20)).toBeNull();
    run(sys, TUNING.enemies.ai.deathTime + 0.1);
    expect(e.active).toBe(false);
    expect(targets.size).toBe(0);
  });

  it('second reveal of the same kind is not "first"', () => {
    const { sys, log } = setup();
    sys.deps.player = null;
    sys.spawn('smudge', 1, 0);
    sys.spawn('smudge', -1, 0);
    run(sys, 0.1);
    const rev = log.filter((l) => l.type === 'enemy:revealed').map((l) => (l.p as { first: boolean }).first);
    expect(rev).toEqual([true, false]);
  });
});

describe('steering', () => {
  it('separation pushes stacked agents apart', () => {
    const a = { position: { x: 0, z: 0 }, radius: 0.4, alive: true };
    const b = { position: { x: 0.2, z: 0 }, radius: 0.4, alive: true };
    const out = { x: 0, z: 0 };
    separation(out, a, [a, b], 2, 1.4, 6);
    expect(out.x).toBeLessThan(0);
  });

  it('orbit converges onto the ring', () => {
    const p = { x: 6, z: 0 };
    const v = { x: 0, z: 0 };
    const d = { x: 0, z: 0 };
    for (let i = 0; i < 600; i++) {
      orbit(d, p.x, p.z, 0, 0, 4, 2, 1);
      steerToward(v, d, 10, DT);
      p.x += v.x * DT;
      p.z += v.z * DT;
    }
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(4, 0);
  });

  it('enemies spawned on one point spread out', () => {
    const { sys } = setup();
    const a = sys.spawn('blot', 5, 5)!;
    const b = sys.spawn('blot', 5, 5)!;
    run(sys, 2);
    expect(a.position.distanceTo(b.position)).toBeGreaterThan(0.6);
  });
});

describe('limits', () => {
  it('never exceeds maxActive alive enemies', () => {
    const { sys } = setup();
    let n = 0;
    for (let i = 0; i < 20; i++) if (sys.spawn('smudge', i, 10)) n++;
    expect(n).toBe(TUNING.enemies.maxActive);
    expect(sys.activeCount).toBe(TUNING.enemies.maxActive);
  });

  it('targets.nearest is allocation-free-ish and range limited', () => {
    const t = new Targets();
    const mk = (x: number) => ({
      id: x,
      position: new THREE.Vector3(x, 0, 0),
      radius: 0.4,
      alive: true,
      revealed: true,
      hit() {},
    });
    const a = mk(2);
    const b = mk(5);
    t.add(a);
    t.add(b);
    expect(t.nearest(new THREE.Vector3(), 10)).toBe(a);
    t.remove(a);
    expect(t.nearest(new THREE.Vector3(), 3)).toBeNull();
    expect(t.nearest(new THREE.Vector3(), 10)).toBe(b);
  });
});

describe('spawner', () => {
  let events: EventBus<GameEvents>;
  let alive: Set<number>;
  let nextId: number;
  let max: number;
  const sink = {
    get activeCount() {
      return alive.size;
    },
    spawn() {
      if (alive.size >= max) return null;
      const id = nextId++;
      alive.add(id);
      return { id };
    },
  };
  const kill = (id: number) => {
    alive.delete(id);
    events.emit('enemy:died', { id, kind: 'smudge', position: [0, 0, 0] });
  };
  beforeEach(() => {
    events = new EventBus<GameEvents>();
    alive = new Set();
    nextId = 1;
    max = 8;
  });

  it('spawns immediate group, waits for trigger groups, respects maxActive', () => {
    const sp = new Spawner(events, sink, { stagger: 0 });
    max = 3;
    sp.load({
      spawns: [
        ...Array.from({ length: 5 }, () => ({ kind: 'smudge' as const, at: [0, 0] as [number, number] })),
        { kind: 'blot', at: [0, 0], trigger: 'arena' },
      ],
    });
    for (let i = 0; i < 30; i++) sp.step(DT);
    expect(alive.size).toBe(3);
    expect(sp.pending).toBe(2);
    kill(1);
    kill(2);
    for (let i = 0; i < 30; i++) sp.step(DT);
    expect(alive.size).toBe(3);
    expect(sp.pending).toBe(0);
    expect(sp.fireTrigger('arena')).toBe(true);
    expect(sp.fireTrigger('arena')).toBe(false);
  });

  it('runs waves in order and emits wave:cleared', () => {
    const sp = new Spawner(events, sink, { stagger: 0, waveDelay: 0.1 });
    const cleared: { wave: number; last: boolean }[] = [];
    events.on('wave:cleared', (e) => cleared.push({ wave: e.wave, last: e.last }));
    sp.load({
      spawns: [
        { kind: 'smudge', at: [0, 0], trigger: 't', wave: 1 },
        { kind: 'smudge', at: [0, 0], trigger: 't', wave: 0 },
        { kind: 'smudge', at: [0, 0], trigger: 't', wave: 0 },
      ],
    });
    sp.fireTrigger('t');
    for (let i = 0; i < 10; i++) sp.step(DT);
    expect(alive.size).toBe(2);
    for (const id of [...alive]) kill(id);
    for (let i = 0; i < 30; i++) sp.step(DT);
    expect(cleared).toEqual([{ wave: 0, last: false }]);
    expect(alive.size).toBe(1);
    for (const id of [...alive]) kill(id);
    for (let i = 0; i < 5; i++) sp.step(DT);
    expect(cleared).toEqual([
      { wave: 0, last: false },
      { wave: 1, last: true },
    ]);
    expect(sp.isCleared('t')).toBe(true);
    expect(sp.allStartedCleared).toBe(true);
  });
});

describe('fairness', () => {
  it('caps simultaneous smudge/scribbler attacks (2 normal, 1 story)', () => {
    for (const [diff, cap] of [
      ['normal', 2],
      ['story', 1],
    ] as const) {
      const { sys, player } = setup(diff);
      player.invulnerable = true;
      for (let i = 0; i < 6; i++) sys.spawn(i % 2 ? 'smudge' : 'scribbler', Math.cos(i) * 6, Math.sin(i) * 6);
      let maxAtk = 0;
      run(sys, 12, () => {
        let n = 0;
        for (const e of sys.pool) if (e.alive && e.state === AiState.Attack) n++;
        maxAtk = Math.max(maxAtk, n);
      });
      expect(maxAtk).toBeGreaterThan(0);
      expect(maxAtk).toBeLessThanOrEqual(cap);
    }
  });

  it('story stretches the scribbler telegraph', () => {
    const { sys, log } = setup('story');
    sys.spawn('scribbler', 6, 0);
    run(sys, 6);
    const tel = log.find((l) => l.type === 'enemy:telegraph')!.p as { duration: number };
    expect(tel.duration).toBeCloseTo(
      TUNING.enemies.scribbler.telegraph * TUNING.difficulty.story.enemyTempo,
      5,
    );
  });

  it('blot telegraphs its latch before draining and never chokes the light below the floor', () => {
    const { sys, reveal, log } = setup();
    const b = sys.spawn('blot', 2.5, 0)!;
    let firstDrainT = -1;
    let teleT = -1;
    let t = 0;
    let minTarget = 99;
    log.length = 0;
    run(sys, 6, () => {
      t += DT;
      if (teleT < 0 && log.some((l) => l.type === 'enemy:telegraph')) teleT = t;
      if (firstDrainT < 0 && reveal.targetRadius < 3 - 1e-6) firstDrainT = t;
      minTarget = Math.min(minTarget, reveal.targetRadius);
      reveal.targetRadius = 3;
    });
    expect(teleT).toBeGreaterThan(0);
    expect(firstDrainT - teleT).toBeGreaterThanOrEqual(TUNING.enemies.blotAi.latchTime - DT);
    expect(minTarget).toBeGreaterThanOrEqual(TUNING.enemies.blotAi.minRadius - 1e-6);
    // a latched blot stays revealed (shootable)
    expect(b.revealed).toBe(true);
  });

  it('hitting a draining blot knocks it off and resets the drain', () => {
    const { sys, reveal } = setup();
    const b = sys.spawn('blot', 2.5, 0)!;
    run(sys, 5, () => {
      reveal.targetRadius = 3;
    });
    expect(b.drain).toBeGreaterThan(0.5);
    b.hit(1, new THREE.Vector3());
    expect(b.drain).toBe(0);
    expect(b.state).toBe(AiState.Recoil);
  });

  it('respawn calms everyone; boss death tears summoned ghosts apart', () => {
    const { sys, events } = setup();
    const e = sys.spawn('smudge', 5, 0)!;
    run(sys, 6, () => {
      if (e.state === AiState.Attack) events.emit('player:respawn', { checkpointId: 'x' });
    });
    expect(e.age).toBeLessThan(6);
    sys.spawn('scribbler', -5, 0);
    events.emit('boss:death', { stage: 'inked' });
    expect(sys.activeCount).toBe(0);
  });
});

describe('mercy', () => {
  it('stretches enemy tempo while the player is out of ink', () => {
    const { sys, player } = setup();
    sys.step(DT);
    expect(sys.tempo).toBe(1);
    player.energy = 0;
    sys.step(DT);
    expect(sys.tempo).toBeCloseTo(TUNING.enemies.ai.mercyTempo, 5);
  });
});
