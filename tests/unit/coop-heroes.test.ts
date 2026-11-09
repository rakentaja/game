/**
 * Wave 3: heroes in co-op (puppet kits, host-resolved world effects), pair-combo effects, decoy
 * aggro, the Splash double-rate window, clock-synced shared moments and the boss/rewrite wire.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ComboEffects } from '../../src/coop/combos';
import { COOP_MSG, emptyBoss, emptyWiz, reader, readWiz, type SnapMsg, writeWiz } from '../../src/coop/wire';
import { EventBus, type GameEvents } from '../../src/core/events';
import { TUNING } from '../../src/data/tuning';
import { BRAINS } from '../../src/entities/enemies/EnemySystem';
import type { ColoristKit } from '../../src/entities/heroes/colorist';
import { loadKit } from '../../src/entities/heroes/registry';
import { SplashMeter } from '../../src/entities/heroes/splash';
import { ManualScheduler } from '../../src/net/clock';
import { ByteWriter } from '../../src/net/codec';
import { NET_REGISTRY } from '../../src/net/protocol';
import { makePair, makeSide } from './coop-harness';

const DT = 1 / 60;

describe('Splash meter (per player, combos double the rate)', () => {
  it('charges ×2 for comboBoostS after a combo, and reports its own pid', () => {
    const ev = new EventBus<GameEvents>();
    const seen: number[] = [];
    ev.on('splash:changed', (e) => seen.push(e.pid));
    let slot: 0 | 1 = 1;
    const m = new SplashMeter(ev, () => slot);
    m.add(0.1);
    expect(m.value).toBeCloseTo(0.1, 5);
    m.combo();
    const afterCombo = m.value;
    expect(afterCombo).toBeCloseTo(0.1 + TUNING.heroes.splash.perCombo, 5);
    m.add(0.1);
    expect(m.value).toBeCloseTo(afterCombo + 0.2, 5);
    for (let t = 0; t < TUNING.heroes.splash.comboBoostS + 0.1; t += 0.1) m.step(0.1);
    const v = m.value;
    m.add(0.05);
    expect(m.value).toBeCloseTo(v + 0.05, 5);
    expect(seen.every((p) => p === 1)).toBe(true);
    slot = 0;
    m.add(0.05);
    expect(seen[seen.length - 1]).toBe(0);
  });
});

describe('decoys draw aggro (hero:lure)', () => {
  it('enemy targeting reads a nearby decoy instead of the far wizard for its lifetime', () => {
    const side = makeSide(new ManualScheduler());
    const en = side.enemies;
    side.player.teleport(0, 0, -3);
    const e = en.spawn('smudge', 0, -9)!;
    const far = en.spawn('smudge', 30, -30)!;
    // what the brains see as "the player" while they think
    const seen = new Map<number, number>();
    const brain = BRAINS.smudge;
    const orig = brain.update;
    const origIdle = brain.idle;
    brain.update = (q, w, dt, d) => {
      seen.set(q.id, w.playerX);
      orig.call(brain, q, w, dt, d);
    };
    brain.idle = (q, w, dt) => {
      seen.set(q.id, w.playerX);
      origIdle?.call(brain, q, w, dt);
    };
    try {
      for (let i = 0; i < 40; i++) en.step(DT);
      expect(seen.get(e.id)).toBeCloseTo(0, 3);
      side.ev.emit('hero:lure', { x: 4, z: -9, seconds: 1.5 });
      en.step(DT);
      expect(seen.get(e.id)).toBeCloseTo(4, 3);
      expect(seen.get(far.id)).toBeCloseTo(0, 3); // out of reach: still hunts the wizard
      for (let i = 0; i < 100; i++) en.step(DT);
      expect(seen.get(e.id)).toBeCloseTo(0, 3); // expired after 1.5 s
    } finally {
      brain.update = orig;
      brain.idle = origIdle;
    }
  });
});

describe('pair-combo effects', () => {
  it('panel reveals + slows, overprint doubles damage in colour ∩ ink, blast hits', () => {
    const side = makeSide(new ManualScheduler());
    const { ctx, enemies } = side;
    const fx = new ComboEffects(ctx, enemies);
    const cuts: string[] = [];
    side.ev.on('fx:panelCut', (c) => cuts.push(c.word));
    const a = enemies.spawn('smudge', 0, -6)!;
    fx.play({ combo: 'inkThePencils', kind: 'panel', x: 0, z: -6, r: 2 }, true);
    expect(a.stunT).toBeGreaterThan(1);
    for (let i = 0; i < 20; i++) ctx.reveal.update(DT);
    expect(ctx.reveal.isRevealed(0, -6)).toBe(true);
    expect(cuts).toEqual(['heroes.combo.inkThePencils']);
    // Overprint: ×2 inside the flat where it's inked
    fx.play({ combo: 'overprint', kind: 'double', x: 0, z: -6, r: 2.5, col: 1 }, true);
    expect(enemies.damageMul).not.toBeNull();
    const hp0 = a.hp;
    enemies.onEnemyHit(a, 1, new THREE.Vector3(0, 0, 0));
    expect(hp0 - a.hp).toBeCloseTo(TUNING.heroes.combos.fx.double.mul, 5);
    for (let t = 0; t < TUNING.heroes.combos.fx.double.life + 0.2; t += 0.1) fx.step(0.1);
    expect(enemies.damageMul).toBeNull();
    // a guest replay draws + inks but never hits
    const b = enemies.spawn('smudge', 8, -6)!;
    const hpB = b.hp;
    fx.play({ combo: 'chromaticChorus', kind: 'blast', x: 8, z: -6 }, false, false);
    expect(b.hp).toBe(hpB);
    fx.play({ combo: 'chromaticChorus', kind: 'blast', x: 8, z: -6 }, true);
    expect(b.hp).toBeLessThan(hpB);
    fx.dispose();
  });
});

describe('heroes in online co-op', () => {
  it('a guest Letterer word is resolved by the host puppet (damage on the host, no hit requests)', async () => {
    const pair = await makePair({ rtt: 100, jitter: 10, loss: 0, seed: 3 }, ['inker', 'letterer']);
    await pair.host.coop!.remote.setHero('letterer');
    expect(pair.host.coop!.remote.body.kit.id).toBe('letterer');
    expect(pair.host.coop!.remote.body.kit.remote).toBe(true);
    pair.guest.player.setKit((await loadKit('letterer'))());
    expect(pair.guest.player.worldAuthority).toBe(false);
    const he = pair.host.enemies;
    const target = he.spawn('smudge', 1.4, -4)!;
    pair.run(1);
    expect(pair.guest.enemies.byId(target.id)).toBeTruthy();
    const hp0 = target.hp;
    // smudges dodge the light: hold it still (stunned = hittable) so the word can land on it
    target.stun(5);
    pair.guest.energy.value = 80;
    pair.guest.player.kit.onTap();
    pair.run(2.5);
    expect(target.hp).toBeLessThan(hp0);
    expect(pair.guest.coop!.stats.hitReq).toBe(0);
    pair.host.coop!.dispose();
    pair.guest.coop!.dispose();
  });

  it('a guest Colorist dash lures the host enemies only through the host puppet', async () => {
    const pair = await makePair(null, ['inker', 'colorist']);
    await pair.host.coop!.remote.setHero('colorist');
    pair.guest.player.setKit((await loadKit('colorist'))());
    const lures: { host: number; guest: number } = { host: 0, guest: 0 };
    pair.host.ev.on('hero:lure', () => lures.host++);
    pair.guest.ev.on('hero:lure', () => lures.guest++);
    pair.run(0.3);
    pair.guest.player.kit.onSwipe(1.4, 0, 1, 0);
    pair.run(0.5);
    expect(lures.guest).toBe(0);
    expect(lures.host).toBe(TUNING.heroes.colorist.decoys.count);
    const puppet = pair.host.coop!.remote.body.kit as ColoristKit;
    expect(puppet.decoyAt(0)).not.toBeNull();
    pair.host.coop!.dispose();
    pair.guest.coop!.dispose();
  });

  it('perks replicate to the partner puppet; combos resolve on the host and replay on the guest', async () => {
    const pair = await makePair({ rtt: 120, jitter: 20, loss: 0, seed: 8 }, ['inker', 'penciller']);
    await pair.host.coop!.remote.setHero('penciller');
    pair.guest.ev.emit('hero:perk', { pid: 1, hero: 'penciller', perk: 'ricochet' });
    const combosG: string[] = [];
    const combosH: string[] = [];
    pair.guest.ev.on('hero:combo', (c) => combosG.push(c.combo));
    pair.host.ev.on('hero:combo', (c) => combosH.push(c.combo));
    pair.run(0.5);
    expect(pair.host.coop!.remote.body.kit.perks.has('ricochet')).toBe(true);
    // guest Penciller closes a loop, host Inker holds its crystal over it
    const pts: number[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      pts.push(Math.cos(a) * 1.6, -4 + Math.sin(a) * 1.6);
    }
    pair.guest.ev.emit('hero:action', {
      pid: 1,
      hero: 'penciller',
      action: 'hold',
      data: { kind: 'loop', pts, cx: 0, cz: -4, area: 8 },
    });
    pair.run(0.5);
    pair.host.ev.emit('hero:action', { pid: 0, hero: 'inker', action: 'hold', data: { x: 0, z: -4, r: 6 } });
    pair.run(1);
    expect(combosH).toContain('inkThePencils');
    expect(combosG).toContain('inkThePencils');
    expect(pair.guest.coop!.combos.counts.get('inkThePencils')).toBe(1);
    pair.host.coop!.dispose();
    pair.guest.coop!.dispose();
  });

  it('shared panel cuts play at the same host-clock moment on both machines', async () => {
    const pair = await makePair({ rtt: 120, jitter: 10, loss: 0, seed: 6 });
    pair.run(1);
    const at: { host: number; guest: number } = { host: -1, guest: -1 };
    pair.host.ev.on('fx:panelCut', () => {
      at.host = pair.hs.hostNow();
    });
    pair.guest.ev.on('fx:panelCut', () => {
      at.guest = pair.gs.hostNow();
    });
    pair.host.ev.emit('fx:panelCut', { word: 'krak', focus: [0, 0, 0], reason: 'print:x' });
    expect(at.host).toBe(-1); // scheduled, not immediate
    pair.run(1);
    expect(at.host).toBeGreaterThan(0);
    expect(at.guest).toBeGreaterThan(0);
    // within two sim ticks of each other on the host clock
    expect(Math.abs(at.guest - at.host)).toBeLessThan((2 * 1000) / TUNING.sim.hz + 1);
    pair.host.coop!.dispose();
    pair.guest.coop!.dispose();
  });

  it('guest sees sketch print progress live', async () => {
    const pair = await makePair(null);
    const sk = pair.guest.level.sketches;
    sk.add({ id: 's1', type: 'bridge', at: [0, 0, -5] } as never);
    pair.host.level.sketches.add({ id: 's1', type: 'bridge', at: [0, 0, -5] } as never);
    pair.run(0.2);
    pair.host.ev.emit('sketch:progress', { id: 's1', t: 0.42 });
    pair.run(0.3);
    expect(sk.progress('s1')).toBeCloseTo(0.42, 2);
    pair.host.coop!.dispose();
    pair.guest.coop!.dispose();
  });
});

describe('co-op wire (wave 3 fields)', () => {
  it('round-trips the partner Splash meter, rewrite sketch and summon in the snapshot', () => {
    const w = emptyWiz();
    w.splash = 0.5;
    const bw = new ByteWriter();
    writeWiz(bw, w);
    expect(readWiz(reader(bw.finish()), emptyWiz()).splash).toBeCloseTo(0.5, 2);
    const boss = emptyBoss();
    boss.rw = { verb: 1, cut: true, sketch: true, drawIn: 0.5, print: 0.25, x: 3, y: 1, z: -4 };
    boss.sm = { active: true, t: 0.7, x: -2, z: 5, kind: 3 };
    const msg: SnapMsg = {
      tick: 1,
      time: 2,
      epoch: 0,
      supp: 1,
      host: emptyWiz(),
      boss,
      enemies: new Uint8Array(0),
    };
    const back = NET_REGISTRY.decode(NET_REGISTRY.encode(COOP_MSG.snap, msg))!.msg as SnapMsg;
    expect(back.boss!.rw).toMatchObject({ verb: 1, cut: true, sketch: true, x: 3, z: -4 });
    expect(back.boss!.rw.print).toBeCloseTo(0.25, 1);
    expect(back.boss!.sm).toMatchObject({ active: true, x: -2, z: 5, kind: 3 });
  });
});
