import { describe, expect, it } from 'vitest';
import { ClockSync, ManualScheduler } from '../../src/net/clock';
import { type InterpSample, SnapshotInterpolator } from '../../src/net/interp';
import { mulberry32 } from '../../src/net/rng';

describe('ClockSync', () => {
  it('converges on the host offset under symmetric latency + jitter', () => {
    const rand = mulberry32(42);
    const trueOffset = 12_345.6; // host clock is ahead of ours
    const c = new ClockSync();
    let local = 1000;
    for (let i = 0; i < 40; i++) {
      const up = 40 + rand() * 30;
      const down = 40 + rand() * 30;
      const t0 = local;
      const t1 = t0 + up + trueOffset;
      const t2 = t1 + 1; // host processing
      const t3 = t2 - trueOffset + down;
      c.sample(t0, t1, t2, t3);
      local = t3 + 500;
    }
    expect(c.synced).toBe(true);
    expect(Math.abs(c.offset - trueOffset)).toBeLessThan(10);
    expect(c.rtt).toBeGreaterThan(80);
    expect(c.rtt).toBeLessThan(140);
    expect(c.jitter).toBeGreaterThan(0);
    expect(c.toLocal(c.toHost(5))).toBeCloseTo(5);
  });

  it('down-weights high-RTT (queued, asymmetric) samples', () => {
    const c = new ClockSync();
    const off = -500;
    let local = 0;
    const exchange = (up: number, down: number) => {
      const t0 = local;
      const t1 = t0 + up + off;
      const t3 = t1 - off + down;
      c.sample(t0, t1, t1, t3);
      local = t3 + 100;
    };
    for (let i = 0; i < 10; i++) exchange(20, 20);
    const before = c.offset;
    // a burst of badly asymmetric samples (300 ms queue on the uplink)
    for (let i = 0; i < 3; i++) exchange(320, 20);
    expect(Math.abs(c.offset - off)).toBeLessThan(25);
    expect(Math.abs(before - off)).toBeLessThan(1);
  });
});

describe('SnapshotInterpolator', () => {
  const out: InterpSample = { x: 0, y: 0, z: 0, yaw: 0, extrapolated: false };

  it('render delay = clamp(interval + 2·jitter, 80, 250)', () => {
    const it = new SnapshotInterpolator({ alpha: 1 });
    it.noteSnapshot(0);
    it.noteSnapshot(50);
    expect(it.interval).toBe(50);
    expect(it.delay()).toBe(80);
    it.jitter = 40;
    expect(it.delay()).toBe(130);
    it.jitter = 400;
    expect(it.delay()).toBe(250);
  });

  it('hits samples exactly and moves smoothly between them (Hermite with velocity)', () => {
    const it = new SnapshotInterpolator();
    // constant velocity 2 m/s along x, 12 Hz
    for (let i = 0; i < 6; i++) it.push(1, i * 83, (i * 83 * 2) / 1000, 0, 0, 0, [2, 0, 0]);
    it.sampleAt(1, 166, out);
    expect(out.x).toBeCloseTo(0.332, 6);
    expect(out.extrapolated).toBe(false);
    // Hermite with exact velocities reproduces linear motion between samples
    it.sampleAt(1, 200, out);
    expect(out.x).toBeCloseTo(0.4, 6);
    let prev = -1;
    for (let t = 200; t <= 400; t += 5) {
      it.sampleAt(1, t, out);
      expect(out.x).toBeGreaterThan(prev);
      prev = out.x;
    }
  });

  it('derives velocity when missing, and accepts out-of-order samples', () => {
    const it = new SnapshotInterpolator();
    it.push(7, 0, 0, 0, 0);
    it.push(7, 200, 2, 0, 0);
    it.push(7, 100, 1, 0, 0); // late packet
    it.sampleAt(7, 150, out);
    expect(out.x).toBeCloseTo(1.5, 5);
  });

  it('extrapolates at most 150 ms past the newest sample', () => {
    const it = new SnapshotInterpolator();
    it.push(2, 0, 0, 0, 0, 0, [1, 0, 0]);
    it.push(2, 100, 0.1, 0, 0, 0, [1, 0, 0]);
    it.sampleAt(2, 150, out);
    expect(out.extrapolated).toBe(true);
    expect(out.x).toBeCloseTo(0.15, 6);
    it.sampleAt(2, 2000, out);
    expect(out.x).toBeCloseTo(0.25, 6);
  });

  it('interpolates yaw along the short arc and renders at hostNow − delay', () => {
    const it = new SnapshotInterpolator({ alpha: 1 });
    it.push(3, 0, 0, 0, 0, 3.0);
    it.push(3, 100, 0, 0, 0, -3.0);
    it.sampleAt(3, 50, out);
    expect(Math.abs(Math.abs(out.yaw) - Math.PI)).toBeLessThan(0.01);
    it.noteSnapshot(0);
    it.noteSnapshot(100);
    expect(it.sample(3, 150, out)).toBe(true); // renders at 150 − 100 = 50
    expect(Math.abs(Math.abs(out.yaw) - Math.PI)).toBeLessThan(0.01);
    expect(it.sample(99, 0, out)).toBe(false);
  });
});

describe('ManualScheduler', () => {
  it('fires timers in time order, including nested ones', () => {
    const s = new ManualScheduler();
    const log: string[] = [];
    s.setTimeout(() => log.push('b'), 20);
    s.setTimeout(() => {
      log.push('a');
      s.setTimeout(() => log.push('a2'), 5);
    }, 10);
    const h = s.setTimeout(() => log.push('x'), 12);
    s.clearTimeout(h);
    s.advance(30);
    expect(log).toEqual(['a', 'a2', 'b']);
    expect(s.now()).toBe(30);
  });
});
