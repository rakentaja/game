import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../../src/core/events';
import type { DamageSource, EnemyKind, PlayerAPI, RevealAPI } from '../../src/core/types';
import { TUNING } from '../../src/data/tuning';
import { CraneMode } from '../../src/entities/enemies/Cranes';
import type { Enemy } from '../../src/entities/enemies/Enemy';
import { EnemySystem } from '../../src/entities/enemies/EnemySystem';
import { MARGIN_TELL } from '../../src/entities/enemies/MarginMan';
import { misprintAlign, misprintAligned, misprintStep } from '../../src/entities/enemies/Misprint';
import { inGutter, seamCorner, WARDEN_BOX } from '../../src/entities/enemies/PanelWarden';
import { Director, type DirectorWorld, intensityOf, ROLE_OF } from '../../src/systems/ai/director';
import { AiState } from '../../src/systems/ai/fsm';
import { Spawner } from '../../src/systems/spawner';
import { Targets } from '../../src/systems/targets';

const DT = 1 / 60;
const ORIGIN = new THREE.Vector3();

class FakeReveal implements RevealAPI {
  center = new THREE.Vector3();
  radius = 3;
  targetRadius = 3;
  blankPage = 0;
  uniforms = {};
  erased = 0;
  addSource() {
    return 0;
  }
  removeSource() {}
  eraseStrip() {
    this.erased++;
  }
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
    7,
  );
  const log: { type: keyof GameEvents; p: unknown }[] = [];
  for (const t of [
    'enemy:died',
    'ink:drop',
    'fx:panelCut',
    'enemy:telegraph',
    'director:phase',
    'sfx:play',
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

function ctxPlayer(sys: EnemySystem) {
  return { player: sys.deps.player as FakePlayer };
}

function dash(events: EventBus<GameEvents>, ax: number, az: number, bx: number, bz: number) {
  events.emit('player:dash', { from: [ax, 0, az], to: [bx, 0, bz] });
}

describe('Close-Up Crits & stun', () => {
  it('attacking is true during a smudge windup and false otherwise', () => {
    const { sys } = setup();
    const e = sys.spawn('smudge', 6, 0)!;
    let sawAttacking = false;
    let attackingOutsideWindup = false;
    run(sys, 8, () => {
      const windup = e.state === AiState.Attack && e.phase === 0;
      if (e.attacking) sawAttacking = true;
      if (e.attacking && !windup) attackingOutsideWindup = true;
    });
    expect(sawAttacking).toBe(true);
    expect(attackingOutsideWindup).toBe(false);
  });

  it('stun freezes the AI and makes even a shielded redactor hittable', () => {
    const { sys, reveal } = setup();
    reveal.radius = 20;
    const e = sys.spawn('redactor', 3, 0)!;
    run(sys, 0.2);
    expect(e.revealed).toBe(false); // shielded: bolts pass through
    e.stun(1);
    run(sys, 0.1);
    const x = e.position.x;
    expect(e.revealed).toBe(true);
    run(sys, 0.5);
    expect(Math.abs(e.position.x - x)).toBeLessThan(0.2);
    e.hit(1, ORIGIN);
    expect(e.hp).toBe(TUNING.enemies.redactor.hp - 1);
    run(sys, 1);
    expect(e.stunT).toBe(0);
    expect(e.revealed).toBe(false);
  });
});

describe('Margin Man', () => {
  it('is frozen inside the reveal and blinks toward the player outside it', () => {
    const { sys, reveal } = setup();
    reveal.radius = 20;
    const e = sys.spawn('marginMan', 8, 0)!;
    run(sys, 4);
    expect(e.position.x).toBeCloseTo(8, 3);
    reveal.radius = 2;
    let told = false;
    run(sys, 4, () => {
      if (e.phase === MARGIN_TELL && e.state === AiState.Stalk) told = true;
    });
    expect(told).toBe(true);
    expect(e.position.x).toBeLessThan(7);
  });

  it('ignores bolts until a dash trail crosses it, then is hittable for 2 s', () => {
    const { sys, reveal, events } = setup();
    reveal.radius = 20;
    sys.deps.player = null;
    const e = sys.spawn('marginMan', 4, 0)!;
    run(sys, 0.2);
    e.hit(1, ORIGIN);
    expect(e.hp).toBe(TUNING.enemies.marginMan.hp);
    dash(events, 4, -2, 4, 2);
    run(sys, 0.1);
    expect(e.revealed).toBe(true);
    e.hit(1, ORIGIN);
    expect(e.hp).toBe(TUNING.enemies.marginMan.hp - 1);
    run(sys, TUNING.enemies.marginAi.vulnerableS + 0.1);
    expect(e.revealed).toBe(false);
  });

  it('gimmick fallback: plain bolts work after the difficulty timeout', () => {
    const { sys, reveal } = setup('story');
    reveal.radius = 20;
    sys.deps.player = null;
    const e = sys.spawn('marginMan', 4, 0)!;
    run(sys, TUNING.difficulty.story.gimmickFallback + 0.2);
    expect(e.worn).toBe(true);
    expect(e.revealed).toBe(true);
  });

  it('strikes from just outside the light after a telegraphed windup', () => {
    const { sys, player, reveal, log } = setup();
    reveal.radius = 2;
    const e = sys.spawn('marginMan', 9, 0)!;
    run(sys, 10);
    expect(log.some((l) => l.type === 'enemy:telegraph' && (l.p as { id: number }).id === e.id)).toBe(true);
    expect(player.hits).toContain('marginMan');
  });
});

describe('Redactor', () => {
  it('cracks after ~1 s under the held crystal, then dies to 2 hits', () => {
    const { sys, reveal, player, log } = setup();
    sys.deps.player = null;
    reveal.radius = 20;
    const e = sys.spawn('redactor', 3, 0)!;
    run(sys, 1.5);
    expect(e.shield).toBe(1); // lit but not held
    sys.deps.player = player;
    player.crystalHeld = true;
    player.position.set(-9, 0, 0); // in aggro range, out of contact
    let brokeAt = -1;
    let t = 0;
    run(sys, 2, () => {
      t += DT;
      if (brokeAt < 0 && e.shield === 0) brokeAt = t;
    });
    expect(brokeAt).toBeGreaterThan(0.8);
    expect(brokeAt).toBeLessThan(1.3);
    expect(log.some((l) => l.type === 'fx:panelCut')).toBe(true);
    e.hit(1, ORIGIN);
    run(sys, 0.5);
    e.hit(1, ORIGIN);
    expect(e.alive).toBe(false);
  });

  it('suppresses the reveal while the crystal sits in its lane, and censors history', () => {
    const { sys, reveal } = setup();
    reveal.radius = 1;
    const e = sys.spawn('redactor', 0.5, 0)!;
    let minTarget = 99;
    run(sys, 2, () => {
      minTarget = Math.min(minTarget, reveal.targetRadius);
      reveal.targetRadius = 3;
    });
    expect(e.shield).toBe(1);
    expect(minTarget).toBeLessThan(3);
    expect(reveal.erased).toBeGreaterThan(0);
  });
});

describe('Panel Warden', () => {
  function untilBox(sys: EnemySystem, e: Enemy, max = 8) {
    for (let t = 0; t < max; t += DT) {
      sys.step(DT);
      if (e.state === AiState.Attack && e.phase === WARDEN_BOX) return true;
    }
    return false;
  }

  it('telegraphs, drops a shrinking box around the player; the gutter hurts', () => {
    const { sys, reveal, player, log } = setup();
    reveal.radius = 20;
    const e = sys.spawn('panelWarden', 7, 0)!;
    expect(untilBox(sys, e)).toBe(true);
    expect(log.some((l) => l.type === 'enemy:telegraph')).toBe(true);
    expect(e.boxHalf).toBeCloseTo(TUNING.enemies.wardenAi.boxSize / 2, 1);
    expect(inGutter(e, e.ax, e.az)).toBe(false);
    // warden stands outside the box
    expect(inGutter(e, e.position.x, e.position.z)).toBe(true);
    run(sys, 1);
    expect(e.boxHalf).toBeLessThan(TUNING.enemies.wardenAi.boxSize / 2);
    player.position.set(e.ax + 5, 0, e.az);
    run(sys, 2);
    expect(player.hits).toContain('panelWarden');
  });

  it('a bolt on the warden cuts the panel with a "shink" panel cut', () => {
    const { sys, reveal, log } = setup();
    reveal.radius = 20;
    const e = sys.spawn('panelWarden', 7, 0)!;
    expect(untilBox(sys, e)).toBe(true);
    e.hit(1, ORIGIN);
    expect(e.boxHalf).toBe(0);
    expect(log.some((l) => l.type === 'fx:panelCut' && (l.p as { word: string }).word === 'shink')).toBe(
      true,
    );
  });

  it('dashing through the telegraphed seam corner breaks the box', () => {
    const { sys, reveal, events, log } = setup();
    reveal.radius = 20;
    const e = sys.spawn('panelWarden', 7, 0)!;
    expect(untilBox(sys, e)).toBe(true);
    const c = seamCorner(e, { x: 0, z: 0 });
    // a dash elsewhere does nothing
    dash(events, e.ax - 0.5, e.az, e.ax + 0.5, e.az);
    run(sys, DT);
    expect(e.boxHalf).toBeGreaterThan(0);
    dash(events, e.ax, e.az, c.x + (c.x - e.ax) * 0.3, c.z + (c.z - e.az) * 0.3);
    run(sys, DT);
    expect(e.boxHalf).toBe(0);
    expect(e.state).toBe(AiState.Recoil);
    expect(log.some((l) => l.type === 'fx:panelCut' && (l.p as { word: string }).word === 'shink')).toBe(
      true,
    );
  });
});

describe('Misprint alignment clock', () => {
  const P = 2.5;
  const W = 0.6;
  it('aligns for exactly `window` seconds every `period`', () => {
    let on = 0;
    let rises = 0;
    let prev = false;
    for (let t = 0; t < P * 4; t += 0.001) {
      const a = misprintAligned(t, P, W);
      if (a) on += 0.001;
      if (a && !prev) rises++;
      prev = a;
    }
    expect(on / 4).toBeCloseTo(W, 2);
    expect(rises).toBe(4);
    expect(misprintAligned(P - W - 0.01, P, W)).toBe(false);
    expect(misprintAligned(P - W + 0.01, P, W)).toBe(true);
  });

  it('registration ramps up over `converge` before the window', () => {
    expect(misprintAlign(0, P, W, 0.45)).toBe(0);
    expect(misprintAlign(P - W - 0.45 - 0.01, P, W, 0.45)).toBe(0);
    const mid = misprintAlign(P - W - 0.225, P, W, 0.45);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    expect(misprintAlign(P - W + 0.1, P, W, 0.45)).toBe(1);
  });

  it('phase-locks the window start to a nearby beat', () => {
    const beat = 0.5;
    // 0.2 s before the window opens, a beat lands → window opens now
    const t = misprintStep(P - W - 0.2 - 1 / 60, 1 / 60, P, W, true, beat);
    expect(misprintAligned(t, P, W)).toBe(true);
    expect(((t % P) + P) % P).toBeCloseTo(P - W, 5);
    // a beat far from the window start changes nothing
    const t2 = misprintStep(0.3, 1 / 60, P, W, true, beat);
    expect(t2).toBeCloseTo(0.3 + 1 / 60, 6);
    // no beat: plain clock
    expect(misprintStep(1, 0.1, P, W, false, beat)).toBeCloseTo(1.1, 6);
  });

  it('bolts do nothing while the plates are misaligned', () => {
    const { sys, reveal } = setup();
    reveal.radius = 30;
    const { player } = ctxPlayer(sys);
    player.position.set(12, 0, 0);
    const e = sys.spawn('misprint', 2, 0)!;
    let hitWhileOff = false;
    let hitWhileOn = false;
    run(sys, 6, () => {
      const hp = e.hp;
      if (!e.alive) return;
      e.hit(1, ORIGIN);
      const aligned = e.align >= 1;
      if (e.hp < hp && !aligned) hitWhileOff = true;
      if (e.hp < hp && aligned) hitWhileOn = true;
    });
    expect(hitWhileOff).toBe(false);
    expect(hitWhileOn).toBe(true);
  });

  it('beats from audio:beat snap the in-game window', () => {
    const { sys, reveal, events } = setup();
    reveal.radius = 30;
    const e = sys.spawn('misprint', 2, 0)!;
    e.setState(AiState.Stalk, 0);
    const a = TUNING.enemies.misprintAi;
    e.cycleT = a.period - a.window - 0.15;
    events.emit('audio:beat', { beat: 1, bar: 0, bpm: 120 });
    run(sys, DT);
    expect(e.align).toBe(1);
  });
});

describe('Origami Crane Swarm', () => {
  it('is 5–7 cranes counted as one enemy; one hit per crane; last crane kills the swarm', () => {
    const { sys, reveal, targets, log } = setup();
    reveal.radius = 30;
    sys.deps.player = null;
    const e = sys.spawn('cranes', 2, 0)!;
    expect(sys.activeCount).toBe(1);
    expect(e.flock.length).toBeGreaterThanOrEqual(TUNING.enemies.craneAi.countMin);
    expect(e.flock.length).toBeLessThanOrEqual(TUNING.enemies.craneAi.countMax);
    expect(e.revealed).toBe(false); // the swarm itself is never a target
    run(sys, 0.2);
    const n = e.flock.length;
    for (let i = 0; i < n - 1; i++) {
      const c = e.flock[i]!;
      c.hit(1, ORIGIN);
      c.hit(1, ORIGIN); // a second hit on a dead crane does nothing
    }
    expect(e.alive).toBe(true);
    expect(e.hp).toBe(1);
    expect(log.some((l) => l.type === 'enemy:died')).toBe(false);
    e.flock[n - 1]!.hit(1, ORIGIN);
    expect(e.alive).toBe(false);
    expect(log.filter((l) => l.type === 'enemy:died')).toHaveLength(1);
    run(sys, 1.5);
    expect(targets.size).toBe(0);
  });

  it('circles the reveal edge, folds one crane into a telegraphed dive', () => {
    const { sys, reveal, player, log } = setup();
    reveal.radius = 3;
    const e = sys.spawn('cranes', 6, 0)!;
    let folded = false;
    let ringErr = 0;
    let samples = 0;
    run(sys, 8, () => {
      for (const c of e.flock) {
        if (c.mode === CraneMode.Fold) folded = true;
        if (c.mode === CraneMode.Circle && e.age > 4) {
          ringErr += Math.abs(Math.hypot(c.position.x, c.position.z) - 3.25);
          samples++;
        }
      }
    });
    expect(folded).toBe(true);
    expect(log.some((l) => l.type === 'enemy:telegraph')).toBe(true);
    expect(ringErr / Math.max(1, samples)).toBeLessThan(0.9);
    expect(player.hits).toContain('cranes');
  });

  it('a dash through the flock scatters it', () => {
    const { sys, reveal, events } = setup();
    reveal.radius = 3;
    sys.deps.player = null;
    const e = sys.spawn('cranes', 0, 0)!;
    run(sys, 0.2);
    dash(events, -3, 0, 3, 0);
    run(sys, DT);
    expect(e.flock.some((c) => c.mode === CraneMode.Scatter)).toBe(true);
  });

  it('two swarms fit the crane pool; a third is refused rather than empty', () => {
    const { sys } = setup();
    const a = sys.spawn('cranes', 0, 0);
    const b = sys.spawn('cranes', 5, 0);
    expect(a && b).toBeTruthy();
    const used = a!.flock.length + b!.flock.length;
    const c = sys.spawn('cranes', 9, 0);
    if (used >= 14) expect(c).toBeNull();
  });
});

describe('Elite affixes', () => {
  it('First Edition: +1 HP and a full-ink bonus drop', () => {
    const { sys, reveal, log } = setup();
    reveal.radius = 20;
    sys.deps.player = null;
    const e = sys.spawn('smudge', 2, 0, { elite: 'firstEdition' })!;
    expect(e.hp).toBe(TUNING.enemies.smudge.hp + 1);
    run(sys, 0.1);
    e.hit(99, ORIGIN);
    const bonus = log.filter((l) => l.type === 'ink:drop' && (l.p as { bonus?: boolean }).bonus);
    expect(bonus).toHaveLength(1);
    expect((bonus[0]!.p as { amount: number }).amount).toBe(TUNING.energy.max);
  });

  it('Inked In stays revealed for 1.5 s after leaving the mask', () => {
    const { sys, reveal } = setup();
    sys.deps.player = null;
    reveal.radius = 20;
    const e = sys.spawn('smudge', 4, 0, { elite: 'inkedIn' })!;
    const plain = sys.spawn('smudge', -4, 0)!;
    run(sys, 0.2);
    reveal.radius = 1;
    run(sys, 1);
    expect(plain.revealed).toBe(false);
    expect(e.revealed).toBe(true);
    run(sys, 0.7);
    expect(e.revealed).toBe(false);
  });

  it('Bleed-Through buffs the nearest ghost on death', () => {
    const { sys, reveal } = setup();
    sys.deps.player = null;
    reveal.radius = 20;
    const e = sys.spawn('smudge', 2, 0, { elite: 'bleedThrough' })!;
    const near = sys.spawn('scribbler', 3, 0)!;
    const far = sys.spawn('scribbler', -9, 0)!;
    run(sys, 0.1);
    e.hit(99, ORIGIN);
    expect(near.hp).toBe(TUNING.enemies.scribbler.hp + 1);
    expect(near.speedBuff).toBeGreaterThan(1);
    expect(far.hp).toBe(TUNING.enemies.scribbler.hp);
  });

  it('rolled elites follow tuning chance × difficulty (story rarer)', () => {
    const count = (difficulty: 'story' | 'normal') => {
      const { sys } = setup(difficulty);
      let n = 0;
      for (let i = 0; i < 400; i++) {
        const e = sys.spawn('smudge', 0, 0, { elite: 'roll' })!;
        if (e.elite) n++;
        sys.clear();
      }
      return n / 400;
    };
    const normal = count('normal');
    const story = count('story');
    expect(normal).toBeGreaterThan(TUNING.enemies.elites.chance * 0.5);
    expect(normal).toBeLessThan(TUNING.enemies.elites.chance * 1.6);
    expect(story).toBeLessThan(normal);
  });
});

// ───────────── director ─────────────

class FakeWorld implements DirectorWorld {
  hasPlayer = true;
  playerX = 0;
  playerZ = 0;
  ink01 = 1;
  maxActive = 8;
  alive = new Map<number, EnemyKind>();
  nextId = 1;
  near = 0;
  spawns: EnemyKind[] = [];
  get activeCount() {
    return this.alive.size;
  }
  nearbyCount() {
    return this.near;
  }
  isAlive(id: number) {
    return this.alive.has(id);
  }
  canSpawnAt() {
    return true;
  }
  spawn(kind: EnemyKind) {
    if (this.alive.size >= this.maxActive) return null;
    const id = this.nextId++;
    this.alive.set(id, kind);
    this.spawns.push(kind);
    return { id };
  }
}

function director(scale = 1) {
  const events = new EventBus<GameEvents>();
  const world = new FakeWorld();
  const d = new Director(events, TUNING, world, { scale: () => scale });
  const phases: string[] = [];
  const drops: number[] = [];
  events.on('director:phase', (p) => phases.push(p.phase));
  events.on('ink:drop', (p) => {
    if (p.bonus) drops.push(p.amount);
  });
  d.load({
    seed: 3313,
    spawns: [
      { kind: 'smudge' },
      { kind: 'scribbler' },
      { kind: 'redactor' },
      { kind: 'panelWarden' },
      { kind: 'misprint' },
    ],
  });
  return { events, world, d, phases, drops };
}

describe('Director ("The Inker\'s Deadline")', () => {
  it('stays off outside moments, starts on a moment trigger', () => {
    const { events, d, world } = director();
    for (let i = 0; i < 600; i++) d.step(DT);
    expect(d.phase).toBe('off');
    expect(world.spawns).toHaveLength(0);
    events.emit('trigger:fired', { id: 'p3_arena' });
    expect(d.phase).toBe('build');
  });

  it('spends budget on role-tagged pieces from the page roster, max one priority alive', () => {
    const { d, world } = director();
    d.begin('test', 60);
    let maxPrio = 0;
    for (let i = 0; i < 60 * 20; i++) {
      d.step(DT);
      let prio = 0;
      for (const k of world.alive.values()) if (ROLE_OF[k] === 'priority') prio++;
      maxPrio = Math.max(maxPrio, prio);
      expect(d.budget).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(world.spawns.length).toBeGreaterThan(0);
    expect(world.spawns.length).toBeLessThanOrEqual(TUNING.enemies.director.maxSpawns);
    for (const k of world.spawns)
      expect(['smudge', 'scribbler', 'redactor', 'panelWarden', 'misprint']).toContain(k);
    expect(maxPrio).toBeLessThanOrEqual(1);
  });

  it('a spend never exceeds the budget and respects maxActive − reserve', () => {
    const { d, world } = director();
    d.begin('test', 60);
    d.budget = 0.5;
    expect(d.trySpend()).toBeNull(); // nothing affordable
    d.budget = 100;
    for (let i = 0; i < world.maxActive - TUNING.enemies.director.reserve - 1; i++)
      world.alive.set(1000 + i, 'smudge');
    expect(d.trySpend()).not.toBeNull();
    expect(d.trySpend()).toBeNull(); // full (reserve kept for authored waves)
    const before = d.budget;
    world.alive.clear();
    const k = d.trySpend()!;
    expect(before - d.budget).toBeCloseTo(TUNING.enemies.director.cost[ROLE_OF[k]], 6);
  });

  it('cycles build → peak → relax, requests ink during relax, emits director:phase', () => {
    const { d, world, phases, drops } = director();
    d.begin('test', 120);
    world.near = 99; // max pressure → peak quickly
    let t = 0;
    while (d.phase !== 'peak' && t < 30) {
      d.step(DT);
      t += DT;
    }
    expect(d.phase).toBe('peak');
    while (d.phase !== 'relax' && t < 60) {
      d.step(DT);
      t += DT;
    }
    expect(d.phase).toBe('relax');
    world.near = 0;
    world.alive.clear();
    while (d.phase !== 'build' && t < 120) {
      d.step(DT);
      t += DT;
    }
    expect(phases.slice(0, 4)).toEqual(['build', 'peak', 'relax', 'build']);
    expect(drops.length).toBe(TUNING.enemies.director.relaxDrops);
  });

  it('winds down when the authored fight it was layered on clears', () => {
    const { events, d } = director();
    events.emit('trigger:fired', { id: 'p3_arena' });
    for (let i = 0; i < 60; i++) d.step(DT);
    events.emit('trigger:fired', { id: 'p3_arena_cleared' });
    for (let i = 0; i < 60 * 20; i++) d.step(DT);
    expect(d.phase).toBe('off');
  });

  it('Deadline scale: story spends less, 0 disables', () => {
    const run = (scale: number) => {
      const { d, world } = director(scale);
      d.begin('test', 40);
      for (let i = 0; i < 60 * 40; i++) d.step(DT);
      return world.spawns.length;
    };
    expect(run(0)).toBe(0);
    expect(run(0.5)).toBeLessThanOrEqual(run(1));
  });

  it('is deterministic for a level seed', () => {
    const a = director();
    const b = director();
    a.d.begin('x', 30);
    b.d.begin('x', 30);
    for (let i = 0; i < 60 * 30; i++) {
      a.d.step(DT);
      b.d.step(DT);
    }
    expect(a.world.spawns).toEqual(b.world.spawns);
  });

  it('intensity rises with damage, low ink and nearby enemies', () => {
    const D = TUNING.enemies.director;
    expect(intensityOf(0, 1, 0, D)).toBe(0);
    expect(intensityOf(D.damageNorm, 1, 0, D)).toBeCloseTo(D.wDamage, 6);
    expect(intensityOf(0, 0, 0, D)).toBeCloseTo(D.wInk, 6);
    expect(intensityOf(99, 0, 99, D)).toBe(1);
  });

  it('layers on the Spawner without touching authored waves', () => {
    const events = new EventBus<GameEvents>();
    const reveal = new FakeReveal();
    const player = new FakePlayer();
    const sys = new EnemySystem({ events, tuning: TUNING, reveal, targets: new Targets(), player }, 3);
    const sp = new Spawner(events, sys);
    const world = new FakeWorld();
    sp.director = new Director(events, TUNING, world);
    sp.load({ seed: 1, spawns: [{ kind: 'smudge', at: [3, 0] }] });
    for (let i = 0; i < 30; i++) {
      sp.step(DT);
      sys.step(DT);
    }
    expect(sys.activeCount).toBe(1);
    expect((sp.director as Director).roster.has('smudge')).toBe(true);
  });
});

describe('finishable by a bolt-only bot (autoplay contract)', () => {
  for (const difficulty of ['story', 'normal'] as const)
    for (const kind of ['marginMan', 'redactor', 'panelWarden', 'misprint', 'cranes'] as const)
      it(`${difficulty}: ${kind} dies to tapped bolts at revealed targets with the crystal held`, () => {
        const { sys, reveal, player, targets } = setup(difficulty);
        reveal.radius = 7;
        player.crystalHeld = true;
        const e = sys.spawn(kind, 6, 2)!;
        let cd = 0;
        let t = 0;
        const limit = TUNING.difficulty[difficulty].gimmickFallback + 15;
        while (e.alive && t < limit) {
          sys.step(DT);
          t += DT;
          cd -= DT;
          if (cd > 0) continue;
          const tgt = targets.nearest(player.position, TUNING.bolt.maxRange);
          if (tgt) {
            tgt.hit(TUNING.bolt.damage, player.position);
            cd = TUNING.bolt.cooldown + 0.05;
          }
        }
        expect(e.alive).toBe(false);
      });
});
