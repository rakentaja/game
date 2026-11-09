import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { HitHistory } from '../../src/coop/history';
import { CoopRules, type Member } from '../../src/coop/rules';
import { COOP_MSG, emptyBoss, emptyWiz, rleDecode, rleEncode, type SnapMsg } from '../../src/coop/wire';
import { EventBus, type GameEvents } from '../../src/core/events';
import { DEFAULT_SETTINGS, type GameContext } from '../../src/core/types';
import { TUNING } from '../../src/data/tuning';
import { Player } from '../../src/entities/Player';
import { NET_REGISTRY } from '../../src/net/protocol';
import { RevealSystem } from '../../src/render/reveal/RevealSystem';
import { Triggers } from '../../src/systems/triggers';
import { fakeInput, flat, makePair, type Pair } from './coop-harness';

function aliveSet(p: Pair['host']): Map<number, number> {
  const m = new Map<number, number>();
  for (const e of p.enemies.pool) if (e.active && e.alive) m.set(e.id, e.hp);
  return m;
}

function expectConverged(pair: Pair): void {
  const h = aliveSet(pair.host);
  const g = aliveSet(pair.guest);
  expect([...g.keys()].sort()).toEqual([...h.keys()].sort());
  for (const [id, hp] of h) expect(g.get(id)).toBeCloseTo(hp, 1);
}

describe('co-op wire format', () => {
  it('round-trips a snapshot (wizard, boss block, enemy bytes)', () => {
    const host = emptyWiz();
    Object.assign(host, {
      x: 3.21,
      z: -7.5,
      yaw: 1.2,
      cr: 4.4,
      flags: 9,
      pages: 3.5,
      energy: 77,
      dashSerial: 4,
    });
    const boss = emptyBoss();
    boss.phase = 2;
    boss.spread = true;
    boss.gutterX = -1.5;
    boss.stet.active = true;
    boss.stet.target = 1;
    boss.attacks[1]!.active = true;
    boss.attacks[1]!.stage = 2;
    boss.attacks[1]!.t = 0.4;
    const msg: SnapMsg = {
      tick: 99,
      time: 1234.5,
      epoch: 3,
      supp: 0.5,
      host,
      boss,
      enemies: new Uint8Array([1, 2, 3]),
    };
    const bytes = NET_REGISTRY.encode(COOP_MSG.snap, msg);
    const dec = NET_REGISTRY.decode(bytes)!.msg as SnapMsg;
    expect(dec.tick).toBe(99);
    expect(dec.epoch).toBe(3);
    expect(dec.supp).toBeCloseTo(0.5, 2);
    expect(dec.host.x).toBeCloseTo(3.21, 2);
    expect(dec.host.cr).toBeCloseTo(4.4, 2);
    expect(dec.host.pages).toBeCloseTo(3.5, 1);
    expect(dec.boss!.spread).toBe(true);
    expect(dec.boss!.gutterX).toBeCloseTo(-1.5, 2);
    expect(dec.boss!.stet).toMatchObject({ active: true, target: 1 });
    expect(dec.boss!.attacks[1]).toMatchObject({ active: true, stage: 2 });
    expect([...dec.enemies]).toEqual([1, 2, 3]);
  });

  it('RLE-compresses the reveal history', () => {
    const src = new Uint8Array(4096);
    src.fill(200, 100, 900);
    src[3000] = 7;
    const enc = rleEncode(src);
    expect(enc.length).toBeLessThan(100);
    expect([...rleDecode(enc, src.length)]).toEqual([...src]);
  });
});

describe('HitHistory (favor the shooter)', () => {
  it('answers "alive + revealed around tick t" from a 250 ms ring', () => {
    const h = new HitHistory(15);
    for (let t = 1; t <= 40; t++) {
      h.begin(t);
      h.add(5, true, t >= 20 && t <= 30);
      h.add(6, t < 35, true);
    }
    expect(h.wasHittable(5, 28)).toBe(true);
    expect(h.wasHittable(5, 38)).toBe(false); // hidden again after 30
    expect(h.wasHittable(6, 38)).toBe(false); // dead
    expect(h.wasHittable(6, 30)).toBe(true);
    expect(h.wasHittable(5, 3)).toBe(true); // older than the ring → clamps to the oldest tick (26)
    expect(h.wasHittable(9, 30)).toBe(false);
  });
});

describe('Triggers with two players', () => {
  it('fires a page end only once BOTH players are inside', () => {
    const ev = new EventBus<GameEvents>();
    const t = new Triggers(
      [
        { id: 'cp', rect: [-1, -1, 1, 1] },
        { id: 'exit', rect: [10, 10, 20, 20], action: { type: 'pageEnd' } },
      ],
      ev,
      1,
    );
    const fired: string[] = [];
    ev.on('trigger:fired', (e) => fired.push(e.id));
    let done = 0;
    ev.on('page:complete', () => done++);
    t.updateAll([0, 0, 0, 50, 0, 50], 2);
    expect(fired).toEqual(['cp']); // any player fires regular triggers
    t.updateAll([15, 0, 15, 50, 0, 50], 2);
    expect(done).toBe(0);
    expect([...t.atExit]).toEqual([1, 0]);
    t.updateAll([15, 0, 15, 12, 0, 18], 2);
    expect(done).toBe(1);
  });
});

function localCtx(): GameContext {
  const ev = new EventBus<GameEvents>();
  const reveal = new RevealSystem(64);
  reveal.setHistoryBounds(-30, -30, 60);
  return {
    events: ev,
    tuning: TUNING,
    settings: { ...DEFAULT_SETTINGS },
    render: {} as GameContext['render'],
    reveal,
    input: fakeInput(),
    audio: {} as GameContext['audio'],
    collision: flat,
    targets: {} as GameContext['targets'],
    player: null,
    stats: {} as GameContext['stats'],
    time: { scale: 1, simTime: 0 },
    t: (k) => k,
  };
}

describe('co-op rules (downed / revive / both down)', () => {
  function two() {
    const ctx = localCtx();
    const mk = () => {
      const input = fakeInput();
      const p = new Player({
        events: ctx.events,
        tuning: TUNING,
        settings: ctx.settings,
        input,
        collision: flat,
        reveal: ctx.reveal,
        render: { createInkMaterial: () => new THREE.ShaderMaterial(), addOutline: () => () => {} },
      });
      return { p, input };
    };
    const a = mk();
    const b = mk();
    a.p.teleport(0, 0, 0);
    b.p.teleport(1.5, 0, 0);
    const ink: [number, number] = [0, 0];
    const members: Member[] = [
      { api: a.p, body: a.p, slot: 0, addInk: (n) => (ink[0] += n) },
      { api: b.p, body: b.p, slot: 1, addInk: (n) => (ink[1] += n) },
    ];
    ctx.players = [a.p, b.p];
    const rules = new CoopRules(ctx, members, {
      authority: true,
      path: () => null,
      triggers: () => null,
      spread: () => null,
    });
    return { ctx, a, b, rules, ink };
  }

  it('a lethal hit downs the wizard; the partner reprints it by holding the crystal on it', () => {
    const { ctx, a, b, rules } = two();
    const downs: number[] = [];
    const ups: number[] = [];
    let died = 0;
    ctx.events.on('player:downed', (e) => downs.push(e.pid));
    ctx.events.on('player:revived', (e) => ups.push(e.pid));
    ctx.events.on('player:died', () => died++);
    b.p.damage(99, 'smudge');
    expect(downs).toEqual([1]);
    expect(b.p.downed).toBe(true);
    expect(b.p.isAlive).toBe(true);
    expect(b.p.invulnerable).toBe(true);
    // partner holds the crystal over the downed wizard (inside the reveal) for 2 s
    a.input.state.crystalHeld = true;
    for (let i = 0; i < 60 * 3 && !ups.length; i++) {
      a.p.step(1 / 60);
      b.p.step(1 / 60);
      rules.step(1 / 60);
      ctx.reveal.update(1 / 60);
    }
    expect(ups).toEqual([1]);
    expect(b.p.downed).toBe(false);
    expect(b.p.pages).toBeGreaterThan(0);
    expect(died).toBe(0);
  });

  it('both down → one player:died (checkpoint reprint)', () => {
    const { ctx, a, b, rules } = two();
    let died = 0;
    ctx.events.on('player:died', () => died++);
    a.p.damage(99, 'smudge');
    b.p.damage(99, 'smudge');
    rules.step(1 / 60);
    rules.step(1 / 60);
    expect(died).toBe(1);
  });

  it('dashing through the partner gives them ink', () => {
    const { rules, ink } = two();
    rules.partnerDash(0, -2, 0, 4, 0);
    expect(ink[1]).toBe(TUNING.coop.dashThroughInk);
    expect(ink[0]).toBe(0);
  });
});

describe('online co-op: two headless sims over Loopback + Lossy', () => {
  it('converges enemy alive/hp sets under rtt150 jit40 loss3', async () => {
    const pair = await makePair({ rtt: 150, jitter: 40, loss: 0.03, seed: 5 });
    const he = pair.host.enemies;
    for (let i = 0; i < 6; i++) he.spawn(i % 2 ? 'scribbler' : 'smudge', -6 + i * 2.5, -8);
    pair.run(2);
    expectConverged(pair);
    expect(pair.host.coop!.stats.snapsSent).toBeGreaterThan(30);
    expect(pair.guest.coop!.stats.snapsRecv).toBeGreaterThan(20);
    // host-side damage + a kill reach the guest within a few ticks
    const [first, second] = [...aliveSet(pair.host).keys()];
    he.onEnemyHit(he.byId(first!)!, 999, new THREE.Vector3(0, 0, 0));
    he.onEnemyHit(he.byId(second!)!, 1, new THREE.Vector3(0, 0, 0));
    pair.run(1);
    expect(aliveSet(pair.guest).has(first!)).toBe(false);
    expectConverged(pair);
    // co-op scaling: 2 players → ghost HP ×1.6
    expect(he.coopScale).toBe(1);
    expect(he.hpScale).toBeCloseTo(TUNING.coop.scale.ghostHp, 5);
    pair.host.coop!.dispose();
    pair.guest.coop!.dispose();
  });

  it('guest bolts: accepted when revealed on the host, rejected (ink refunded) when not', async () => {
    const pair = await makePair({ rtt: 120, jitter: 20, loss: 0, seed: 2 });
    const he = pair.host.enemies;
    // one ghost right next to the wizards (inside the crystal light), one far out in the dark
    const near = he.spawn('scribbler', 1, 1)!;
    const far = he.spawn('scribbler', 25, -25)!;
    pair.run(1.5);
    const gNear = pair.guest.enemies.byId(near.id);
    const gFar = pair.guest.enemies.byId(far.id);
    expect(gNear && gFar).toBeTruthy();
    const hp0 = near.hp;
    pair.guest.energy.value = 50;
    // favor the shooter: the guest's local bolt hit goes to the host
    pair.guest.enemies.onEnemyHit(gNear!, 1, new THREE.Vector3(1, 0, 3));
    pair.guest.enemies.onEnemyHit(gFar!, 1, new THREE.Vector3(25, 0, -22));
    pair.run(1);
    expect(near.hp).toBeCloseTo(hp0 - 1, 5);
    expect(far.hp).toBeCloseTo(far.maxHp, 5);
    const g = pair.guest.coop!.stats;
    expect(g.hitOk).toBe(1);
    expect(g.hitRejected).toBe(1);
    expect(pair.guest.energy.value).toBeCloseTo(50 + TUNING.bolt.cost, 3);
    expect(pair.host.coop!.stats.hitRejected).toBe(1);
    pair.host.coop!.dispose();
    pair.guest.coop!.dispose();
  });

  it('turns the page only once BOTH wizards are inside the exit (host decides)', async () => {
    const pair = await makePair({ rtt: 150, jitter: 40, loss: 0.03, seed: 9 });
    pair.run(0.5);
    // (stay inside the 22 m tether: past 30 m the lagging wizard is pulled to the partner)
    pair.guest.player.teleport(1, 0, -22);
    pair.host.player.teleport(0, 0, -40);
    pair.run(2);
    expect(pair.host.turned).toEqual([]);
    expect(pair.guest.turned).toEqual([]);
    pair.guest.player.teleport(1, 0, -40);
    pair.run(2);
    expect(pair.host.turned).toEqual([2]);
    expect(pair.guest.turned).toEqual([2]);
    expect(pair.host.coop!.epoch).toBe(pair.guest.coop!.epoch);
    pair.host.coop!.dispose();
    pair.guest.coop!.dispose();
  });

  it('partner disconnect → fade, solo, scaling eases back', async () => {
    const pair = await makePair({ rtt: 80, jitter: 10, loss: 0, seed: 4 });
    const he = pair.host.enemies;
    const e = he.spawn('smudge', 0, -10)!;
    pair.run(0.5);
    const base = TUNING.enemies.smudge.hp;
    expect(e.hp).toBeCloseTo(base * TUNING.coop.scale.ghostHp, 5);
    expect(pair.host.ctx.players).toHaveLength(2);
    const counts: number[] = [];
    pair.host.ev.on('coop:players', (c) => counts.push(c.count));
    pair.links[1].disconnect();
    pair.run(5);
    expect(pair.host.coop!.solo).toBe(false); // fading for 10 s
    expect(pair.host.coop!.remote.presence).toBeLessThan(1);
    pair.run(6);
    expect(pair.host.coop!.solo).toBe(true);
    expect(counts).toContain(1);
    expect(pair.host.ctx.players).toHaveLength(1);
    pair.run(TUNING.coop.scale.easeS + 0.5);
    expect(he.coopScale).toBe(0);
    expect(e.hp).toBeCloseTo(base, 5);
    // the guest lost its host too: after the 10 s reconnect window it took over solo
    expect(pair.guest.coop).toBeNull();
    pair.host.coop!.dispose();
  });
});
