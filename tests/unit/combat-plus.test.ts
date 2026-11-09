import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../../src/core/events';
import {
  type BeatAPI,
  type CollisionAPI,
  type Damageable,
  DEFAULT_SETTINGS,
  type InputAPI,
  type InputState,
  type RevealAPI,
  type RunStats,
  type TargetRegistry,
} from '../../src/core/types';
import { TUNING } from '../../src/data/tuning';
import { Player } from '../../src/entities/Player';
import {
  Combat,
  chainRate,
  critRule,
  detectLoop,
  makeLoopResult,
  pointInLoop,
} from '../../src/systems/combat';
import { InkEnergy } from '../../src/systems/ink-energy';
import { StyleMeter, StyleSystem } from '../../src/systems/style';

const DT = 1 / 60;

const openWorld: CollisionAPI = {
  groundHeight: () => 0,
  resolveCircle: () => false,
  walkable: () => true,
  segmentClear: () => true,
};

class Ghost implements Damageable {
  static next = 1000;
  readonly id = Ghost.next++;
  readonly position: THREE.Vector3;
  readonly radius = 0.45;
  readonly kind = 'smudge';
  alive = true;
  revealed = true;
  attacking = false;
  hp: number;
  hits: number[] = [];
  stuns: number[] = [];
  constructor(x: number, z: number, hp = 2, withStun = true) {
    this.position = new THREE.Vector3(x, 0, z);
    this.hp = hp;
    if (!withStun) (this as { stun?: unknown }).stun = undefined;
  }
  hit(n: number): void {
    if (!this.alive) return;
    this.hits.push(n);
    this.hp -= n;
    if (this.hp <= 0) this.alive = false;
  }
  stun(s: number): void {
    this.stuns.push(s);
  }
}

function registry(list: Damageable[]): TargetRegistry {
  return {
    add: (t) => list.push(t),
    remove: () => {},
    nearest: () => null,
    forEach: (fn) => list.forEach(fn),
  };
}

function rig(targets: Damageable[] = [], beat: BeatAPI | null = null) {
  const events = new EventBus<GameEvents>();
  const state: InputState = {
    move: new THREE.Vector2(),
    crystalHeld: false,
    boltPressed: false,
    dashPressed: false,
    dashDir: new THREE.Vector2(),
    pausePressed: false,
    snuffPressed: false,
    device: 'touch',
  };
  const input: InputAPI = { state, poll() {}, setLeftHanded() {}, setEnabled() {}, dispose() {} };
  const reveal: RevealAPI = {
    center: new THREE.Vector3(),
    radius: 3,
    targetRadius: 3,
    blankPage: 0,
    uniforms: {},
    addSource: () => 1,
    removeSource() {},
    eraseStrip() {},
    revealAt: () => 1,
    isRevealed: () => true,
    update() {},
    reset() {},
  };
  const energy = new InkEnergy(events, TUNING);
  const settings = { ...DEFAULT_SETTINGS };
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
      collision: openWorld,
      reveal,
      render: { createInkMaterial: () => new THREE.ShaderMaterial(), addOutline: () => () => {} },
      beat: () => beat,
    },
    energy,
  );
  player.teleport(0, 0, 0, 0);
  const stats = { boltsFired: 0, boltsHit: 0 } as RunStats;
  const combat = new Combat(
    {
      events,
      tuning: TUNING,
      settings,
      input,
      targets: registry(targets),
      collision: openWorld,
      stats,
      beat: () => beat,
    },
    player,
    energy,
  );
  const step = (seconds: number, each?: () => void) => {
    const n = Math.max(1, Math.round(seconds / DT));
    for (let i = 0; i < n; i++) {
      each?.();
      player.step(DT);
      combat.step(DT);
      state.boltPressed = false;
      state.dashPressed = false;
      state.snuffPressed = false;
    }
  };
  const of = <T = never>(type: string): T[] => log.filter((e) => e.type === type).map((e) => e.payload as T);
  return { events, state, reveal, energy, player, combat, step, log, of };
}

// ───────────────────────────── Close-Up Crits ─────────────────────────────

describe('critRule (Close-Up Crits)', () => {
  it('only an eligible (attacking / marked) killing blow is critical', () => {
    expect({ ...critRule(1, 1, 2, false) }).toEqual({ damage: 1, kill: true, critical: false });
    expect({ ...critRule(1, 1, 2, true) }).toEqual({ damage: 2, kill: true, critical: true });
    // eligible blows deal crit damage, so a 2 hp ghost dies to one close-up bolt
    expect({ ...critRule(2, 1, 2, true) }).toEqual({ damage: 2, kill: true, critical: true });
    expect({ ...critRule(3, 1, 2, true) }).toEqual({ damage: 2, kill: false, critical: false });
    expect({ ...critRule(2, 1, 2, false) }).toEqual({ damage: 1, kill: false, critical: false });
    expect(critRule(undefined, 1, 2, true).critical).toBe(false);
  });

  it('no random crits: an idle kill never panel-cuts', () => {
    const g = new Ghost(0, -4, 1);
    const r = rig([g]);
    r.state.boltPressed = true;
    r.step(1);
    expect(g.alive).toBe(false);
    expect(r.of('fx:panelCut').length).toBe(0);
    const hit = r.of<{ critical: boolean; kill: boolean }>('bolt:hit').at(-1)!;
    expect(hit).toMatchObject({ critical: false, kill: true });
    const stop = r.of<{ duration: number }>('fx:hitstop').at(-1)!;
    expect(stop.duration).toBe(TUNING.combatPlus.hitStop.kill);
  });

  it('enemy:telegraph marks a ghost as attacking (fallback) → critical kill + panel cut, with a min gap', () => {
    const a = new Ghost(0, -4, 2);
    const b = new Ghost(0.5, -4.5, 2);
    const r = rig([a, b]);
    r.events.emit('enemy:telegraph', { id: a.id, kind: 'smudge', duration: 2 });
    expect(r.combat.isAttacking(a)).toBe(true);
    r.state.boltPressed = true;
    r.step(0.8);
    expect(a.alive).toBe(false);
    expect(r.of('fx:panelCut').length).toBe(1);
    // second close-up kill right after: still critical, but no second panel cut inside the gap
    r.events.emit('enemy:telegraph', { id: b.id, kind: 'smudge', duration: 2 });
    r.state.boltPressed = true;
    r.step(0.8);
    expect(b.alive).toBe(false);
    const hits = r.of<{ critical: boolean }>('bolt:hit');
    expect(hits.at(-1)!.critical).toBe(true);
    expect(r.of('fx:panelCut').length).toBe(1);
    const stop = r.of<{ duration: number }>('fx:hitstop').at(-1)!;
    expect(stop.duration).toBe(TUNING.combatPlus.hitStop.crit);
  });

  it('auto-aim prefers an attacking ghost over a nearer idle one', () => {
    const near = new Ghost(0, -3, 5);
    const far = new Ghost(2, -4.5, 5);
    far.attacking = true;
    const r = rig([near, far]);
    r.state.boltPressed = true;
    r.step(1);
    expect(far.hits.length).toBe(1);
    expect(near.hits.length).toBe(0);
  });
});

// ───────────────────────────── Frame Lasso ─────────────────────────────

describe('detectLoop (Frame Lasso)', () => {
  const loop = makeLoopResult(32);

  it('closes when the newest point returns within closeDist of an old one', () => {
    const xs = [0, 4, 4, 0, 0.3];
    const zs = [0, 0, 4, 4, 0.4];
    expect(detectLoop(xs, zs, 5, 1, 2, loop)).toBe(true);
    expect(loop.area).toBeGreaterThan(12);
    expect(pointInLoop(2, 2, loop)).toBe(true);
    expect(pointInLoop(6, 2, loop)).toBe(false);
  });

  it('closes on a self-intersection and builds the polygon from the crossing', () => {
    // a "6" shape: down, right, up, then back left across the first segment
    const xs = [1, 1, 4, 4, -1];
    const zs = [-1, 4, 4, 1, 1];
    expect(detectLoop(xs, zs, 5, 0.5, 2, loop)).toBe(true);
    expect(loop.px[0]).toBeCloseTo(1);
    expect(loop.pz[0]).toBeCloseTo(1);
    expect(loop.area).toBeCloseTo(9, 3);
    expect(pointInLoop(2.5, 2.5, loop)).toBe(true);
    expect(pointInLoop(0, 0, loop)).toBe(false);
  });

  it('ignores open polylines, adjacent segments and slivers', () => {
    expect(detectLoop([0, 1, 2, 3, 4], [0, 0, 0, 0, 0], 5, 1, 2, loop)).toBe(false);
    expect(detectLoop([0, 1], [0, 0], 2, 1, 2, loop)).toBe(false);
    // closes, but encloses less than minArea
    expect(detectLoop([0, 1, 1, 0.1], [0, 0, 0.5, 0.1], 4, 1, 2, loop)).toBe(false);
  });

  it('lassoing ghosts with dash endpoints damages + stuns them and cuts to KACHUNK', () => {
    const inside = new Ghost(2, 2, 5);
    const outside = new Ghost(9, 9, 5);
    const r = rig([inside, outside]);
    const pts: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0.2, 0.3],
    ];
    for (const [x, z] of pts) {
      r.events.emit('player:dash', { from: [x, 0, z], to: [x, 0, z] });
      r.step(DT);
    }
    expect(inside.hits).toEqual([TUNING.combatPlus.lasso.damage]);
    expect(inside.stuns.length).toBe(1);
    expect(outside.hits.length).toBe(0);
    const lasso = r.of<{ ids: number[] }>('combat:lasso');
    expect(lasso.length).toBe(1);
    expect(lasso[0]!.ids).toEqual([inside.id]);
    expect(r.of<{ word: string }>('fx:panelCut')[0]!.word).toBe('kachunk');
    expect(r.combat.lassoPoints).toBe(0);
  });

  it('forgets points older than the lasso life', () => {
    const r = rig([]);
    r.events.emit('player:dash', { from: [0, 0, 0], to: [0, 0, 0] });
    r.events.emit('player:dash', { from: [3, 0, 0], to: [0, 0, 0] });
    expect(r.combat.lassoPoints).toBe(2);
    r.step(TUNING.combatPlus.lasso.life + 0.2);
    expect(r.combat.lassoPoints).toBe(0);
  });
});

// ───────────────────────────── Snuff & Flare, Nib, Parry, Rhythm, Rewrites ─────────────────────────────

describe('combat verbs', () => {
  it('snuff drops the crystal to 0 m without draining; a fresh hold flares, stunning + marking', () => {
    const g = new Ghost(0, -4, 2);
    const r = rig([g]);
    r.state.crystalHeld = true;
    r.step(0.2);
    const e0 = r.energy.value;
    r.state.snuffPressed = true;
    r.step(0.5); // still holding: a hold from before the snuff doesn't flare, nothing drains
    expect(r.player.snuffed).toBe(true);
    expect(r.player.crystalHeld).toBe(false);
    expect(r.reveal.targetRadius).toBe(0);
    expect(r.reveal.radius).toBeLessThan(0.05);
    expect(r.energy.value).toBe(e0);
    expect(r.player.snuffed).toBe(true);
    r.state.crystalHeld = false;
    r.step(DT);
    r.state.crystalHeld = true;
    r.step(0.4);
    expect(r.player.snuffed).toBe(false);
    expect(r.of<{ snuffed: boolean }>('crystal:snuff').map((e) => e.snuffed)).toEqual([true, false]);
    expect(r.of<{ caught: number }>('crystal:flare')).toEqual([{ caught: 1 }]);
    expect(g.stuns).toEqual([TUNING.combatPlus.snuff.stunTime]);
    expect(r.combat.isMarked(g)).toBe(true);
    // marked → guaranteed crit kill (2 hp, crit damage 2)
    r.state.boltPressed = true;
    r.step(1);
    expect(g.alive).toBe(false);
    expect(r.of<{ critical: boolean }>('bolt:hit').at(-1)!.critical).toBe(true);
  });

  it('Dash-Strike Nib damages a ghost dashed through; a nib kill resets the dash cooldown', () => {
    const g = new Ghost(0, 2, 1);
    const r = rig([g]);
    r.state.dashPressed = true;
    r.state.dashDir.set(0, -1); // screen down = world +z with the default view
    r.step(0.4);
    expect(g.hits).toEqual([TUNING.combatPlus.nib.damage]);
    expect(r.of<{ kill: boolean }>('combat:nib')).toEqual([{ id: g.id, kill: true }]);
    expect(r.player.dashCooldown01).toBe(0);
  });

  it('Ink Parry: a hit landing just after a dash starts slows time, refunds ink, once', () => {
    const r = rig([]);
    r.energy.reset(50);
    r.state.dashPressed = true;
    r.step(DT);
    r.player.damage(1, 'scribbler');
    r.step(DT);
    expect(r.of('combat:parry').length).toBe(1);
    expect(r.energy.value).toBe(50 + TUNING.combatPlus.parry.refund);
    expect(r.player.pages).toBe(TUNING.player.maxPages);
  });

  it('a projectile next to the player in the parry window counts too; late dodges do not', () => {
    const r = rig([]);
    const pr = { capacity: 1, x: [0.4], z: [0.2], active: [1] };
    r.combat.projectiles = pr;
    r.state.dashPressed = true;
    r.step(DT);
    expect(r.of('combat:parry').length).toBe(1);
    const r2 = rig([]);
    r2.state.dashPressed = true;
    r2.step(0.2); // past the window
    r2.combat.projectiles = {
      capacity: 1,
      x: [r2.player.position.x],
      z: [r2.player.position.z],
      active: [1],
    };
    r2.step(DT);
    expect(r2.of('combat:parry').length).toBe(0);
  });

  it('Ink Rhythm: on-beat bolts are free and emit combat:onBeat; off-beat is never penalised', () => {
    let on = true;
    const beat: BeatAPI = { bpm: 120, offsetMs: () => 0, onBeat: () => on, phase: () => 0 };
    const r = rig([], beat);
    r.state.boltPressed = true;
    r.step(0.5);
    expect(r.energy.value).toBe(100);
    expect(r.of<{ action: string }>('combat:onBeat')).toEqual([{ action: 'bolt' }]);
    on = false;
    r.state.boltPressed = true;
    r.step(0.5);
    expect(r.energy.value).toBe(100 - TUNING.bolt.cost);
    // dash on beat
    on = true;
    r.state.dashPressed = true;
    r.step(DT);
    expect(r.of<{ action: string }>('combat:onBeat').at(-1)).toEqual({ action: 'dash' });
  });

  it('works without a beat clock', () => {
    const r = rig([], null);
    r.state.boltPressed = true;
    r.step(0.5);
    expect(r.of('combat:onBeat').length).toBe(0);
    expect(r.of('bolt:fire').length).toBe(1);
  });

  it('obeys boss:rewrite cuts and restores them', () => {
    const r = rig([]);
    r.events.emit('boss:rewrite', { verb: 'bolt', cut: true });
    r.events.emit('boss:rewrite', { verb: 'dash', cut: true });
    r.events.emit('boss:rewrite', { verb: 'crystal', cut: true });
    r.state.boltPressed = true;
    r.state.dashPressed = true;
    r.state.crystalHeld = true;
    r.step(0.5);
    expect(r.of('bolt:fire').length).toBe(0);
    expect(r.of('player:dash').length).toBe(0);
    expect(r.player.crystalHeld).toBe(false);
    r.events.emit('boss:rewrite', { verb: 'bolt', cut: false });
    r.events.emit('boss:rewrite', { verb: 'dash', cut: false });
    r.events.emit('boss:rewrite', { verb: 'crystal', cut: false });
    r.state.boltPressed = true;
    r.step(0.5);
    r.state.dashPressed = true;
    r.step(0.5);
    expect(r.of('bolt:fire').length).toBe(1);
    expect(r.of('player:dash').length).toBe(1);
    expect(r.player.crystalHeld).toBe(true);
  });

  it('print cut keeps the light just under printing size', () => {
    const r = rig([]);
    r.events.emit('boss:rewrite', { verb: 'print', cut: true });
    r.state.crystalHeld = true;
    r.step(1.5);
    const S = TUNING.sketch;
    expect(r.reveal.targetRadius).toBeLessThan(S.requiredRadius * S.radiusSlack);
  });

  it('kill chain raises pitch a semitone per kill', () => {
    expect(chainRate(1, 12)).toBe(1);
    expect(chainRate(2, 12)).toBeCloseTo(2 ** (1 / 12));
    expect(chainRate(40, 12)).toBeCloseTo(2);
  });
});

// ───────────────────────────── Editor's Red Pen ─────────────────────────────

describe('StyleMeter (Editor’s Red Pen)', () => {
  const cfg = () => TUNING.combatPlus.style;
  const P = cfg().points;

  it('repeating an action makes it stale; variety stays fresh', () => {
    const m = new StyleMeter(cfg);
    const a = m.add('bolt');
    const b = m.add('bolt');
    const c = m.add('bolt');
    expect(a).toBe(P.bolt);
    expect(b).toBeCloseTo(P.bolt * cfg().staleMul);
    expect(c).toBeLessThan(b);
    expect(m.add('lasso')).toBe(P.lasso);
    expect(m.add('parry')).toBe(P.parry);
  });

  it('freshness recovers and the score decays over time', () => {
    const m = new StyleMeter(cfg);
    m.add('nib');
    m.add('nib');
    const s0 = m.score;
    m.update(2);
    expect(m.score).toBeLessThan(s0);
    expect(m.fresh.nib).toBeGreaterThan(cfg().staleMul ** 2);
    m.update(100);
    expect(m.score).toBe(0);
    expect(m.fresh.nib).toBe(1);
    expect(m.total).toBeCloseTo(P.nib * (1 + cfg().staleMul));
  });

  it('climbs D → P on varied play, drops on damage, never exceeds max', () => {
    const m = new StyleMeter(cfg);
    expect(m.grade).toBe('D');
    for (let i = 0; i < 3; i++)
      for (const a of ['bolt', 'crit', 'nib', 'lasso', 'parry', 'flare', 'onBeat'] as const) m.add(a);
    expect(m.grade).toBe('P');
    expect(m.score).toBeLessThanOrEqual(cfg().max);
    m.damaged();
    expect(m.score).toBeLessThan(cfg().max);
    expect(m.best).toBe(5);
  });

  it('StyleSystem emits style:grade on change and writes RunStats', () => {
    const events = new EventBus<GameEvents>();
    const grades: string[] = [];
    events.on('style:grade', (e) => grades.push(e.grade));
    const stats = {} as RunStats;
    const s = new StyleSystem(events, TUNING, stats);
    events.emit('combat:lasso', { ids: [1, 2], center: [0, 0, 0], area: 4 });
    events.emit('combat:parry', { position: [0, 0, 0] });
    s.step(DT);
    expect(grades[0]).toBe('D');
    expect(grades.length).toBeGreaterThan(1);
    expect(stats.styleScore).toBeGreaterThan(0);
    expect(stats.styleGrade).not.toBe('D');
    s.dispose();
  });
});
