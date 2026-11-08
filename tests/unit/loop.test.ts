import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events';
import { FixedLoop } from '../../src/core/loop';

describe('FixedLoop', () => {
  it('runs fixed steps and reports alpha', () => {
    let steps = 0;
    let alpha = -1;
    const loop = new FixedLoop({ step: () => steps++, render: (a) => (alpha = a) }, 60, 5);
    loop.tick(1 / 30);
    expect(steps).toBe(2);
    loop.tick(1 / 120);
    expect(alpha).toBeCloseTo(0.5, 5);
  });
  it('clamps spiral of death', () => {
    let steps = 0;
    const loop = new FixedLoop({ step: () => steps++, render: () => {} }, 60, 5);
    loop.tick(10);
    expect(steps).toBe(5);
  });
  it('honours timeScale 0 (hit-stop)', () => {
    let steps = 0;
    const loop = new FixedLoop({ step: () => steps++, render: () => {} }, 60, 5);
    loop.timeScale = 0;
    loop.tick(0.1);
    expect(steps).toBe(0);
  });
});

describe('EventBus', () => {
  it('on/once/off', () => {
    const bus = new EventBus<{ a: number }>();
    const got: number[] = [];
    const off = bus.on('a', (n) => got.push(n));
    bus.once('a', (n) => got.push(n * 10));
    bus.emit('a', 1);
    bus.emit('a', 2);
    off();
    bus.emit('a', 3);
    expect(got).toEqual([1, 10, 2]);
  });
});
