import { describe, expect, it } from 'vitest';
import {
  audibleTime,
  BeatClock,
  downbeatDelay,
  nearestOffset,
  phaseAt,
  quantizeDelay,
  untilNext,
} from '../../src/audio/beat';
import {
  DRUM_KIT,
  drumDensity,
  ERASE_ORDER,
  HitRing,
  LEITMOTIF,
  lightCutoff,
  MOTIF_MIDI,
  MOTIF_STEPS,
  PENTA,
  PickupMelody,
  revealMix,
  revealProxy,
  shepardVoice,
  stemLayer,
} from '../../src/audio/fxmath';
import { TUNING } from '../../src/data/tuning';

const S16 = 0.125; // 120 bpm

describe('beat grid math', () => {
  it('nearestOffset is signed toward the closest line', () => {
    expect(nearestOffset(10.01, 10, 0.25)).toBeCloseTo(-0.01);
    expect(nearestOffset(10.24, 10, 0.25)).toBeCloseTo(0.01);
    expect(nearestOffset(9.99, 10, 0.25)).toBeCloseTo(0.01); // before the anchor too
    expect(nearestOffset(5, Number.NaN, 0.25)).toBe(0);
  });

  it('untilNext / phaseAt', () => {
    expect(untilNext(10, 10, 0.5)).toBe(0);
    expect(untilNext(10.1, 10, 0.5)).toBeCloseTo(0.4);
    expect(phaseAt(10.25, 10, 0.5)).toBeCloseTo(0.5);
  });

  it('audibleTime prefers getOutputTimestamp, else subtracts output latency, plus user offset', () => {
    // stamp: context time 4.9 was at the speaker at perf 1000 ms; now perf 1050 → 4.95
    expect(audibleTime(5, 0.2, 0.01, { contextTime: 4.9, performanceTime: 1000 }, 1050, 0)).toBeCloseTo(4.95);
    // never ahead of currentTime even with a stale stamp
    expect(audibleTime(5, 0.2, 0.01, { contextTime: 4.9, performanceTime: 1000 }, 9000, 0)).toBe(5);
    expect(audibleTime(5, 0.2, 0.01, null, 0, 0)).toBeCloseTo(4.8);
    expect(audibleTime(5, 0, 0.01, null, 0, 0)).toBeCloseTo(4.99); // Safari: baseLatency fallback
    expect(audibleTime(5, 0.2, 0.01, null, 0, 50)).toBeCloseTo(4.75); // +50 ms calibration
    // zeroed stamp (context not running yet) falls back
    expect(audibleTime(5, 0.1, 0, { contextTime: 0, performanceTime: 0 }, 0, 0)).toBeCloseTo(4.9);
  });

  it('BeatClock reads the grid in audible time', () => {
    const src = { currentTime: 10.2, state: 'running', outputLatency: 0.2 };
    const grid = { anchor: 2, sec16: S16, bpm: 120 };
    const clock = new BeatClock(src, grid, 60);
    // audible 10.0 → exactly on a beat
    expect(clock.offsetMs()).toBeCloseTo(0);
    expect(clock.onBeat()).toBe(true);
    expect(clock.phase()).toBeCloseTo(0);
    expect(clock.bpm).toBe(120);
    src.currentTime = 10.3; // audible 10.1: 0.1 s past a beat, 8th = 0.25 → 0.1 past nearest line
    expect(clock.offsetMs()).toBeCloseTo(-100);
    expect(clock.onBeat()).toBe(false);
    expect(clock.onBeat(120)).toBe(true);
    expect(clock.phase()).toBeCloseTo(0.2);
    clock.latencyOffsetMs = 100; // the player hears 100 ms later still → back on the beat
    expect(clock.offsetMs()).toBeCloseTo(0);
    expect(clock.msUntilAudible(10.5)).toBeCloseTo(500);
  });

  it('BeatClock is inert without a track or while suspended', () => {
    const c = new BeatClock({ currentTime: 3, state: 'suspended' }, { anchor: 0, sec16: S16, bpm: 120 }, 60);
    expect(c.bpm).toBe(0);
    expect(c.onBeat()).toBe(false);
    const d = new BeatClock(
      { currentTime: 3, state: 'running' },
      { anchor: Number.NaN, sec16: 0, bpm: 0 },
      60,
    );
    expect(d.offsetMs()).toBe(0);
    expect(d.phase()).toBe(0);
  });
});

describe('quantize decision', () => {
  it('snaps to the next 16th only when ≤ max away', () => {
    expect(quantizeDelay(10.1, 10, S16, 0.045)).toBeCloseTo(0.025); // 25 ms → wait
    expect(quantizeDelay(10.05, 10, S16, 0.045)).toBe(0); // 75 ms → play now
    expect(quantizeDelay(10.125, 10, S16, 0.045)).toBe(0); // on the line
    expect(quantizeDelay(10.08, 10, S16, 0.045)).toBeCloseTo(0.045);
    expect(quantizeDelay(10.1, Number.NaN, S16, 0.045)).toBe(0);
  });

  it('downbeat: next bar if close, else next beat', () => {
    const bar = S16 * 16; // 2 s
    expect(downbeatDelay(10 + bar - 0.5, 10, S16, 0.9)).toBeCloseTo(0.5);
    expect(downbeatDelay(10.1, 10, S16, 0.9)).toBeCloseTo(0.4); // next beat (0.5 s grid)
    expect(downbeatDelay(1, 0, 0, 0.9)).toBe(0);
  });
});

describe('unprinted mix / light', () => {
  const U = TUNING.audio.unprinted;
  const m = { hp: 0, lp: 0, drive: 0, crackle: 0 };
  it('radio at 0, full fidelity at 1, monotone between', () => {
    revealMix(0, m, U);
    expect(m.hp).toBeCloseTo(U.hpLo);
    expect(m.lp).toBeCloseTo(U.lpLo);
    expect(m.drive).toBeCloseTo(U.drive);
    expect(m.crackle).toBeCloseTo(U.crackle);
    revealMix(1, m, U);
    expect(m.hp).toBeCloseTo(20);
    expect(m.lp).toBeCloseTo(20000);
    expect(m.drive).toBe(0);
    expect(m.crackle).toBe(0);
    let lastLp = 0;
    for (let r = 0; r <= 1; r += 0.1) {
      revealMix(r, m, U);
      expect(m.lp).toBeGreaterThanOrEqual(lastLp);
      lastLp = m.lp;
    }
  });

  it('proxy grows with crystal hold time', () => {
    expect(revealProxy(0, 45)).toBe(0);
    expect(revealProxy(45, 45)).toBeCloseTo(1 - Math.exp(-1));
    expect(revealProxy(1000, 45)).toBeCloseTo(1);
  });

  it('light cutoff: bright inside, muffled beyond the feather', () => {
    expect(lightCutoff(1, 4, 3, 18000, 700)).toBe(18000);
    expect(lightCutoff(7, 4, 3, 18000, 700)).toBeCloseTo(700);
    const mid = lightCutoff(5.5, 4, 3, 18000, 700);
    expect(mid).toBeGreaterThan(700);
    expect(mid).toBeLessThan(18000);
    expect(lightCutoff(Number.NaN, 4, 3, 18000, 700)).toBe(18000);
  });
});

describe('shepard riser', () => {
  it('voices stay inside the window and wrap silently', () => {
    const o: [number, number] = [0, 0];
    for (let p = 0; p <= 1; p += 0.05) {
      for (let i = 0; i < 4; i++) {
        shepardVoice(p, i, 4, 110, 4, 3, o);
        expect(o[0]).toBeGreaterThanOrEqual(110);
        expect(o[0]).toBeLessThanOrEqual(110 * 16 + 1e-6);
        expect(o[1]).toBeGreaterThanOrEqual(0);
        expect(o[1]).toBeLessThanOrEqual(1);
      }
    }
    shepardVoice(0, 0, 4, 110, 4, 3, o);
    expect(o[1]).toBeCloseTo(0); // at the bottom edge: silent
    // pitch rises with progress
    const a = shepardVoice(0.1, 1, 4, 110, 4, 3, [0, 0])[0];
    const b = shepardVoice(0.12, 1, 4, 110, 4, 3, [0, 0])[0];
    expect(b).toBeGreaterThan(a);
  });
});

describe('motif sequencing', () => {
  it('pentatonic ladder climbs within 0.7 s and resets after a gap', () => {
    const m = new PickupMelody();
    expect(m.next(0)).toBe(PENTA[0]);
    expect(m.next(0.3)).toBe(PENTA[1]);
    expect(m.next(0.6)).toBe(PENTA[2]);
    expect(m.next(2)).toBe(PENTA[0]);
    for (let i = 0; i < 20; i++) m.next(2 + i * 0.1);
    expect(m.next(4.05)).toBe(PENTA[PENTA.length - 1]); // capped at the top
  });

  it('phase 2 spells A A A | D — F E | D and loops', () => {
    const m = new PickupMelody();
    m.mode = 'motif';
    const got: number[] = [];
    for (let i = 0; i < 9; i++) got.push(m.next(i * 1.5));
    expect(got).toEqual([0, 0, 0, 5, 8, 7, 5, 0, 0]);
    expect(LEITMOTIF).toEqual([0, 0, 0, 5, 8, 7, 5]);
    // long silence restarts the phrase
    m.next(100);
    expect(m.next(100.5)).toBe(0);
    expect(m.next(101)).toBe(0);
  });

  it('trumpet quote matches the leitmotif intervals', () => {
    for (let i = 0; i < LEITMOTIF.length; i++) expect(MOTIF_MIDI[i]! - MOTIF_MIDI[0]!).toBe(LEITMOTIF[i]);
    for (let i = 1; i < MOTIF_STEPS.length; i++) expect(MOTIF_STEPS[i]!).toBeGreaterThan(MOTIF_STEPS[i - 1]!);
  });
});

describe('drummer ring buffer', () => {
  it('drains only hits whose grid matches, keeping order', () => {
    const r = new HitRing(4);
    r.push(0, 0.5, 1);
    r.push(2, 0.4, 2);
    r.push(1, 0.3, 1, -0.5);
    const out: number[][] = [];
    const play = (p: number, v: number, o: number) => out.push([p, v, o]);
    expect(r.drain(3, play)).toBe(2); // odd step: the 8th-grid crash waits
    expect(out.map((x) => x[0])).toEqual([0, 1]);
    expect(out[1]![2]).toBeCloseTo(-0.5);
    expect(r.size).toBe(1);
    out.length = 0;
    r.drain(4, play);
    expect(out[0]![0]).toBe(2);
    expect(r.size).toBe(0);
  });

  it('drops the oldest when full and wraps cleanly', () => {
    const r = new HitRing(3);
    for (let i = 0; i < 5; i++) r.push(i, 1, 2);
    expect(r.size).toBe(3);
    const got: number[] = [];
    r.drain(1, () => {});
    r.drain(2, (p) => got.push(p));
    expect(got).toEqual([2, 3, 4]);
    for (let k = 0; k < 10; k++) {
      r.push(k % DRUM_KIT.length, 1, 1);
      got.length = 0;
      r.drain(k, (p) => got.push(p));
      expect(got).toEqual([k % DRUM_KIT.length]);
    }
  });

  it('density grows with heat', () => {
    expect(drumDensity(0, 0.08)).toBe(0);
    expect(drumDensity(0.1, 0.08)).toBe(1);
    expect(drumDensity(0.5, 0.08) & 2).toBe(2);
    expect(drumDensity(1, 0.08)).toBe(7);
  });
});

describe('editor stems', () => {
  it('maps stem indices to unique layers', () => {
    expect(new Set(ERASE_ORDER).size).toBe(ERASE_ORDER.length);
    expect(stemLayer(0)).toBe('brass');
    expect(stemLayer(-1)).toBeNull();
    expect(stemLayer(99)).toBeNull();
    expect(stemLayer(1.5)).toBeNull();
  });
});
