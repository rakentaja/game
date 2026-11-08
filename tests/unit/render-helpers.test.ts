import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/data/tuning';
import { ScreenShake, TimeFreeze } from '../../src/fx/shake';
import { BoilClock, SteppedMixer } from '../../src/render/boil';
import { wordFor } from '../../src/render/index';
import { panelLayout } from '../../src/render/post/panels';
import { AdaptiveQuality, profileFor } from '../../src/render/quality';

describe('BoilClock / SteppedMixer', () => {
  it('re-rolls the seed at boil.hz and never while disabled', () => {
    const b = new BoilClock();
    let changes = 0;
    for (let i = 0; i < 60; i++) if (b.update(1 / 60)) changes++;
    expect(changes).toBe(TUNING.boil.hz);
    b.enabled = false;
    const s = b.seed;
    for (let i = 0; i < 60; i++) expect(b.update(1 / 60)).toBe(false);
    expect(b.seed).toBe(s);
  });

  it('advances the mixer only in whole 1/animHz steps', () => {
    const applied: number[] = [];
    const mixer = { update: (dt: number) => applied.push(dt) } as unknown as THREE.AnimationMixer;
    const m = new SteppedMixer(mixer);
    for (let i = 0; i < 60; i++) m.update(1 / 60);
    expect(applied.length).toBe(TUNING.boil.animHz);
    for (const a of applied) expect(a).toBeCloseTo(1 / TUNING.boil.animHz, 6);
    m.stepped = false;
    m.update(0.016);
    expect(applied.at(-1)).toBeCloseTo(0.016);
  });
});

describe('AdaptiveQuality', () => {
  it('drops resolution under sustained load and climbs back slowly', () => {
    const q = new AdaptiveQuality(3, 2);
    expect(q.pixelRatio).toBe(2);
    for (let i = 0; i < 120; i++) q.sample(28);
    expect(q.pixelRatio).toBeLessThan(2);
    const low = q.pixelRatio;
    // vsync-locked frames: allowed to climb, but not back to the ratio that failed (ceiling memory)
    for (let i = 0; i < 60 * 8; i++) q.sample(16.7);
    expect(q.pixelRatio).toBeGreaterThanOrEqual(low);
    expect(q.pixelRatio).toBeLessThan(2);
    for (let i = 0; i < 60 * 30; i++) q.sample(16.7);
    expect(q.pixelRatio).toBe(2);
  });

  it('ignores single hitches and respects bounds', () => {
    const q = new AdaptiveQuality(1, 1);
    q.sample(400);
    expect(q.pixelRatio).toBe(1);
    for (let i = 0; i < 600; i++) q.sample(40);
    expect(q.pixelRatio).toBe(TUNING.quality.minPixelRatio);
  });

  it('profiles: low drops history + MSAA; mobile auto uses half-res edges', () => {
    expect(profileFor('low', false)).toMatchObject({ msaa: 0, revealHistory: false, halfResEdges: true });
    expect(profileFor('auto', true).halfResEdges).toBe(true);
    expect(profileFor('high', false).msaa).toBe(4);
  });
});

describe('shake / freeze', () => {
  it('trauma decays to rest; disabled shake never moves', () => {
    const s = new ScreenShake();
    s.add(1, 0.5);
    s.update(0.05);
    expect(s.offset.length()).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) s.update(1 / 60);
    expect(s.trauma).toBe(0);
    expect(s.offset.length()).toBe(0);
    s.enabled = false;
    s.add(1);
    expect(s.trauma).toBe(0);
  });

  it('time freeze holds scale at 0 and resumes normal time', () => {
    const time = { scale: 1 };
    const f = new TimeFreeze();
    f.hold(0.1, time);
    expect(time.scale).toBe(0);
    f.hold(0.05, time);
    f.update(0.06, time);
    expect(time.scale).toBe(0);
    f.update(0.05, time);
    expect(time.scale).toBe(1);
    expect(f.active).toBe(false);
  });
});

describe('panel layout', () => {
  for (const aspect of [0.46, 1.8]) {
    for (const count of [2, 3]) {
      it(`aspect ${aspect} × ${count}: rects disjoint, quads inside their rect`, () => {
        const L = panelLayout(aspect, count);
        expect(L.length).toBe(count);
        for (let i = 0; i < L.length; i++) {
          const [x, y, w, h] = L[i]!.rect as [number, number, number, number];
          for (let c = 0; c < 4; c++) {
            const qx = L[i]!.quad[c * 2]!;
            const qy = L[i]!.quad[c * 2 + 1]!;
            expect(qx).toBeGreaterThanOrEqual(x - 1e-9);
            expect(qx).toBeLessThanOrEqual(x + w + 1e-9);
            expect(qy).toBeGreaterThanOrEqual(y - 1e-9);
            expect(qy).toBeLessThanOrEqual(y + h + 1e-9);
          }
          for (let j = i + 1; j < L.length; j++) {
            const [x2, y2, w2, h2] = L[j]!.rect as [number, number, number, number];
            const overlap = x < x2 + w2 && x2 < x + w && y < y2 + h2 && y2 < y + h;
            expect(overlap).toBe(false);
          }
        }
      });
    }
  }
});

describe('onomatopoeia', () => {
  it('prefers i18n, then the built-in table, then KEY!', () => {
    expect(wordFor({ t: (k) => (k === 'fx.krak' ? 'ÇATIRT!' : k) }, 'krak')).toBe('ÇATIRT!');
    expect(wordFor(null, 'fwoosh')).toBe('FWOOSH!');
    expect(wordFor(null, 'bonk')).toBe('BONK!');
  });
});

describe('TimeFreeze overlap', () => {
  it('resumes time when overlapping freezes release in any order', () => {
    const time = { scale: 1 };
    const a = new TimeFreeze();
    const b = new TimeFreeze();
    a.hold(0.6, time);
    b.hold(0.1, time);
    a.update(0.7, time);
    expect(time.scale).toBe(0);
    b.update(0.2, time);
    expect(time.scale).toBe(1);
    b.hold(0.1, time);
    a.hold(0.6, time);
    b.update(0.2, time);
    a.update(0.7, time);
    expect(time.scale).toBe(1);
  });
});
