import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TUNING } from '../../src/data/tuning';
import { RevealSystem } from '../../src/render/reveal/RevealSystem';
import { LEVEL2 } from '../../src/world/Level2';
import { LEVEL3 } from '../../src/world/Level3';
import { CAPTION_LINES, CaptionDirector } from '../../src/world/meta/CaptionDirector';
import {
  DAILY_RULES,
  dailyInfo,
  dailyLevel,
  dailySeed,
  hashString,
  parseDailyFlag,
  segmentHitsRect,
  spawnSlotValidator,
} from '../../src/world/meta/daily';
import { decodeSamples, encodeSamples, GhostRecorder, sampleTrack } from '../../src/world/meta/ghost';
import { MisprintZones } from '../../src/world/meta/misprint';
import { validateLevel } from '../../src/world/validate';

const STEP = 1 / 20;
function run(r: RevealSystem, seconds: number) {
  for (let t = 0; t < seconds; t += STEP) r.update(STEP);
}
/** Park the crystal off the history map so it stamps nothing. */
function park(r: RevealSystem) {
  r.center.set(1000, 0, 1000);
}

describe('The Ink Remembers — permanent history', () => {
  let r: RevealSystem;
  beforeEach(() => {
    r = new RevealSystem(128);
    park(r);
  });

  it('permanent stamps survive the regular fade; crystal history does not', () => {
    r.center.set(-20, 0, -20);
    run(r, 0.2);
    expect(r.historyAt(-20, -20)).toBeGreaterThan(0.9);
    park(r);
    r.stampPermanent(15, 15, 2.1);
    expect(r.isPermanent(15, 15)).toBe(true);
    run(r, 40);
    expect(r.historyAt(-20, -20)).toBe(0);
    expect(r.historyAt(15, 15)).toBeGreaterThan(0.9);
    expect(r.isRevealed(15, 15)).toBe(true);
  });

  it('the soft rim of a permanent stamp still fades (only the core is kept)', () => {
    r.stampPermanent(0, 0, 2);
    const rim = 2 + TUNING.crystal.edgeWidth * 0.8;
    const before = r.historyAt(rim, 0);
    expect(before).toBeGreaterThan(0);
    expect(r.isPermanent(rim, 0)).toBe(false);
    run(r, 20);
    expect(r.historyAt(rim, 0)).toBe(0);
  });

  it('dash segments stamp a permanent capsule', () => {
    r.stampSegmentPermanent(-10, 0, -4, 0, 1);
    for (const x of [-10, -8, -6, -4]) expect(r.isPermanent(x, 0)).toBe(true);
    expect(r.isPermanent(-7, 4)).toBe(false);
  });

  it('erase and clear remove permanence; only clear can be re-inked', () => {
    r.stampPermanent(5, 5, 2);
    r.stampPermanent(-5, -5, 2);
    r.eraseStrip(3, 5, 7, 5, 1.5);
    r.clearStrip(-7, -5, -3, -5, 1.5);
    expect(r.isPermanent(5, 5)).toBe(false);
    expect(r.isPermanent(-5, -5)).toBe(false);
    expect(r.historyAt(-5, -5)).toBeLessThan(0.05);
    r.stampPermanent(5, 5, 2);
    r.stampPermanent(-5, -5, 2);
    expect(r.historyAt(5, 5)).toBeLessThan(0.05);
    expect(r.historyAt(-5, -5)).toBeGreaterThan(0.9);
  });

  it('blank-paper reclaim whitens long-unvisited regions, permanent ink included', () => {
    const M = TUNING.worldMeta.inkMemory;
    r.stampPermanent(20, 20, 2);
    run(r, M.reclaimAfterS - 2);
    expect(r.historyAt(20, 20)).toBeGreaterThan(0.95);
    run(r, 1 / M.reclaimPerSec + 6);
    expect(r.historyAt(20, 20)).toBe(0);
    expect(r.isPermanent(20, 20)).toBe(false);
  });

  it('re-inking a region resets its reclaim clock; reclaimMul 0 disables, story is gentler', () => {
    const M = TUNING.worldMeta.inkMemory;
    const a = new RevealSystem(128);
    park(a);
    a.reclaimMul = 0;
    a.stampPermanent(20, 20, 2);
    run(a, M.reclaimAfterS + 30);
    expect(a.historyAt(20, 20)).toBeGreaterThan(0.95);

    const s = new RevealSystem(128);
    const n = new RevealSystem(128);
    park(s);
    park(n);
    s.reclaimMul = M.storyReclaimMul;
    for (const x of [s, n]) x.stampPermanent(20, 20, 2);
    run(s, M.reclaimAfterS + 20);
    run(n, M.reclaimAfterS + 20);
    expect(s.historyAt(20, 20)).toBeGreaterThan(n.historyAt(20, 20));

    // visiting with the crystal keeps the region fresh
    const v = new RevealSystem(128);
    v.center.set(22, 0, 22);
    v.stampPermanent(20, 20, 2);
    run(v, M.reclaimAfterS + 20);
    expect(v.historyAt(20, 20)).toBeGreaterThan(0.95);
  });

  it('stamps are skipped without history (Low quality)', () => {
    r.historyEnabled = false;
    r.stampPermanent(0, 0, 2);
    expect(r.historyAt(0, 0)).toBe(0);
  });

  it('inkedFraction honours the progress mask', () => {
    r.setProgressMask((x) => x < 0);
    expect(r.inkedFraction()).toBe(0);
    r.stampPermanent(-20, 0, 6);
    r.stampPermanent(20, 0, 6);
    const f = r.inkedFraction();
    r.setProgressMask(null);
    expect(f).toBeGreaterThan(0);
    // the masked half holds half the ink in half the cells: same fraction as the whole page
    expect(f).toBeCloseTo(r.inkedFraction(), 3);
  });

  it('capRadius collapses the crystal for a while, then it recovers', () => {
    r.targetRadius = TUNING.crystal.radiusHeld;
    run(r, 2);
    expect(r.radius).toBeGreaterThan(6);
    r.capRadius(0.6, 1);
    run(r, 0.9);
    expect(r.radius).toBeLessThan(1);
    run(r, 2.5);
    expect(r.radius).toBeGreaterThan(6);
  });
});

describe('Daily Issue', () => {
  it('parses the ?daily= flag', () => {
    const now = new Date(2026, 10, 9);
    expect(parseDailyFlag(null, now)).toBeNull();
    expect(parseDailyFlag('0', now)).toBeNull();
    expect(parseDailyFlag('2026-03-14', now)).toBe('2026-03-14');
    expect(parseDailyFlag('2026-02-30', now)).toBe('2026-11-09');
    expect(parseDailyFlag('1', now)).toBe('2026-11-09');
  });

  it('is deterministic per date, numbered from 2026-01-01, and rotates rules', () => {
    expect(dailyInfo('2026-01-01').number).toBe(1);
    expect(dailyInfo('2026-11-09').number).toBe(313);
    expect(dailyInfo('2026-11-09')).toEqual(dailyInfo('2026-11-09'));
    expect(dailyInfo('2026-11-09').hash).toBe(hashString('20261109'));
    expect(dailyInfo('2026-11-09').hash).not.toBe(dailyInfo('2026-11-10').hash);
    const seen = new Set<string>();
    for (let d = 1; d <= 28; d++) {
      const info = dailyInfo(`2026-02-${String(d).padStart(2, '0')}`);
      expect(DAILY_RULES).toContain(info.rule);
      seen.add(info.rule);
    }
    expect(seen.size).toBe(DAILY_RULES.length);
  });

  it('seed = date hash XOR level seed', () => {
    const i = dailyInfo('2026-05-05');
    expect(dailySeed(i, LEVEL2)).toBe((i.hash ^ LEVEL2.seed) >>> 0);
  });

  it('daily variants move spawns but stay valid levels', () => {
    for (const date of ['2026-04-01', '2026-07-19']) {
      for (const base of [LEVEL2, LEVEL3]) {
        const info = { ...dailyInfo(date), rule: 'doubleGhosts' as const };
        const def = dailyLevel(base, info);
        expect(def.spawns.length).toBeGreaterThan(base.spawns.length);
        expect(def.spawns.some((s, i) => s.at[0] !== base.spawns[i]?.at[0])).toBe(true);
        expect(validateLevel(def).errors).toEqual([]);
        // deterministic
        expect(dailyLevel(base, info).spawns).toEqual(def.spawns);
        // near-side ambushes never jump the closed gate wall
        for (const sp of def.spawns)
          if (sp.trigger === 'p2_gate_ambush') expect(sp.at[1]).toBeGreaterThan(-90.8);
      }
    }
  }, 60_000);

  it('slot validator rejects voids and void crossings', () => {
    expect(segmentHitsRect(0, 0, 0, -10, [-1, -6, 1, -5])).toBe(true);
    expect(segmentHitsRect(0, 0, 0, -4, [-1, -6, 1, -5])).toBe(false);
    const ok = spawnSlotValidator(LEVEL2);
    expect(ok(-4.5, -87, -4.5, -88)).toBe(true);
    expect(ok(-4.5, -87, -4.5, -93.5)).toBe(false);
    expect(ok(0, -20, 0, 0)).toBe(false); // too close to the start
  });

  it('thickFog closes the fog; other rules keep the authored count', () => {
    const fog = dailyLevel(LEVEL3, { ...dailyInfo('2026-04-02'), rule: 'thickFog' });
    expect(fog.fog.far).toBeLessThan(LEVEL3.fog.far);
    expect(fog.spawns.length).toBe(LEVEL3.spawns.length);
  });
});

describe('CaptionDirector', () => {
  const C = TUNING.worldMeta.captions;
  const still = { active: true, energyFrac: 1 };
  const tick = (d: CaptionDirector, seconds: number, snap = still) => {
    const out: string[] = [];
    for (let t = 0; t < seconds; t += 0.1) {
      const r = d.update(0.1, snap);
      if (r) out.push(r.key);
    }
    return out;
  };
  let saved = 0;
  beforeEach(() => {
    saved = C.threatChancePerMin;
    C.threatChancePerMin = 0;
  });
  afterEach(() => {
    C.threatChancePerMin = saved;
  });

  it('respects the global and per-category cooldowns', () => {
    const d = new CaptionDirector({ rng: () => 0.3 });
    d.pageStart(2);
    tick(d, C.globalCooldown);
    d.note('damage', 4);
    expect(tick(d, 0.2)).toEqual(['caption.damage.1']);
    d.note('damage', 4);
    expect(tick(d, 1)).toEqual([]); // global cooldown
    tick(d, C.globalCooldown);
    d.note('damage', 4);
    expect(tick(d, 1)).toEqual([]); // category cooldown still running
    d.note('kill');
    expect(tick(d, 0.2)).toEqual(['caption.firstKill.0']); // another category is fine
  });

  it('prioritises near death over a plain hit and drops stale moments', () => {
    const d = new CaptionDirector({ rng: () => 0 });
    d.pageStart(1);
    d.note('damage', 3);
    d.note('damage', 1);
    expect(tick(d, 3)).toEqual([]); // page card window; moments went stale
    tick(d, C.globalCooldown);
    d.note('damage', 3);
    d.note('damage', 1);
    expect(tick(d, 0.2)).toEqual(['caption.nearDeath.0']);
  });

  it('first kill fires once per run, idle once per still spell, low ink on the edge', () => {
    const d = new CaptionDirector({ rng: () => 0 });
    d.pageStart(1);
    tick(d, C.globalCooldown);
    d.note('kill');
    expect(tick(d, 0.2)).toEqual(['caption.firstKill.0']);
    tick(d, C.categoryCooldown + 1);
    d.note('kill');
    expect(tick(d, 0.5)).toEqual([]);
    const idle = { active: false, energyFrac: 1 };
    expect(tick(d, C.idleS + 0.5, idle)).toEqual(['caption.idle.0']);
    expect(tick(d, C.categoryCooldown + 5, idle)).toEqual([]);
    tick(d, C.globalCooldown);
    expect(tick(d, 0.3, { active: true, energyFrac: 0.05 })).toEqual(['caption.lowInk.0']);
  });

  it('every caption key resolves to an i18n line', async () => {
    const en = (await import('../../src/ui/i18n/en.json')).default as Record<string, Record<string, unknown>>;
    const cap = en.caption as Record<string, Record<string, string>>;
    for (const [cat, n] of Object.entries(CAPTION_LINES)) {
      for (let i = 0; i < n; i++) expect(cap[cat]?.[String(i)], `${cat}.${i}`).toBeTruthy();
    }
    for (const e of ['crystalOut', 'fogIn', 'ghostsHaste', 'inkDrought'])
      expect(cap.threat?.[e]).toBeTruthy();
  });

  it('threats: rare, late in a page, once per page, never on Story page 1 or the boss', () => {
    C.threatChancePerMin = 6000; // always roll true
    const story = new CaptionDirector({ rng: () => 0, story: () => true });
    story.pageStart(1);
    expect(tick(story, 200).filter((k) => k.startsWith('caption.threat'))).toEqual([]);

    const d = new CaptionDirector({ rng: () => 0 });
    d.pageStart('boss');
    expect(tick(d, 120)).toEqual([]);
    d.pageStart(2);
    expect(tick(d, C.threatMinPageS - 1)).toEqual([]);
    const got = tick(d, 200);
    expect(got).toEqual(['caption.threat.crystalOut']);
  });

  it('busy blocks new captions', () => {
    const d = new CaptionDirector({ rng: () => 0, busy: () => true });
    d.pageStart(2);
    tick(d, C.globalCooldown);
    d.note('damage', 4);
    expect(tick(d, 1)).toEqual([]);
  });
});

describe('Ghost Inker', () => {
  it('records at 12 Hz, round-trips through base64 and interpolates', () => {
    const rec = new GhostRecorder(12, 60);
    for (let i = 0; i <= 120; i++) rec.step(1 / 60, i * 0.05, -i * 0.1, 0.5);
    expect(rec.count).toBe(25);
    const tr = rec.track();
    const back = decodeSamples(encodeSamples(tr.samples));
    expect(Array.from(back)).toEqual(Array.from(tr.samples));
    const o = { x: 0, z: 0, yaw: 0 };
    expect(sampleTrack({ ...tr, samples: back }, 1, o)).toBe(true);
    expect(o.x).toBeCloseTo(3, 1);
    expect(o.z).toBeCloseTo(-6, 1);
    expect(o.yaw).toBeCloseTo(0.5, 3);
    expect(sampleTrack(tr, 100, o)).toBe(false);
    // ≈5 KB for a 70 s page
    expect(70 * 12 * 6).toBeLessThan(5200);
  });

  it('interpolates yaw the short way round', () => {
    const tr = { timeS: 1, hz: 1, samples: new Int16Array([0, 0, 32000, 0, 0, -32000]) };
    const o = { x: 0, z: 0, yaw: 0 };
    sampleTrack(tr, 0.5, o);
    expect(Math.abs(Math.abs(o.yaw) - Math.PI)).toBeLessThan(0.05);
  });
});

describe('Misprint zones', () => {
  it('blend toward the zone boost and back to neutral', () => {
    const target = { misprint: { misreg: 1, halftone: 1 } };
    const z = new MisprintZones([{ rect: [0, 0, 10, 10], misreg: 4, halftone: 1.5 }], target);
    for (let i = 0; i < 300; i++) z.update(1 / 60, 5, 5);
    expect(target.misprint.misreg).toBeCloseTo(4, 1);
    expect(target.misprint.halftone).toBeCloseTo(1.5, 2);
    for (let i = 0; i < 300; i++) z.update(1 / 60, 50, 5);
    expect(target.misprint.misreg).toBeCloseTo(1, 1);
    z.dispose();
    expect(target.misprint.misreg).toBe(1);
  });
});
