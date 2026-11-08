import { describe, expect, it } from 'vitest';
import { GestureClassifier, type GestureKind } from '../../src/core/input/gesture';
import { Joystick } from '../../src/core/input/joystick';

const CFG = { tapMaxMs: 180, tapMaxPx: 12, holdMinMs: 180, swipeMinPx: 40, swipeMaxMs: 200 };

function rig() {
  const log: { k: GestureKind; dx: number; dy: number }[] = [];
  const g = new GestureClassifier(CFG, (k, dx, dy) => log.push({ k, dx, dy }));
  const kinds = () => log.map((e) => e.k);
  return { g, log, kinds };
}

/** Drive a straight-line drag from (0,0) to (dx,dy) over `ms`, sampling every 16ms. */
function drag(g: GestureClassifier, t0: number, dx: number, dy: number, ms: number) {
  const n = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    const t = t0 + ms * f;
    g.update(t);
    g.move(t, dx * f, dy * f);
  }
}

describe('GestureClassifier — tap', () => {
  it('quick still press is a tap', () => {
    const { g, kinds } = rig();
    g.down(0, 100, 100);
    g.update(60);
    g.up(90, 101, 100);
    expect(kinds()).toEqual(['tap']);
    expect(g.phase).toBe('idle');
  });

  it('tap tolerates jitter below 12px', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    g.move(40, 6, -5);
    g.move(80, -4, 7);
    g.up(120, 3, 3);
    expect(kinds()).toEqual(['tap']);
  });

  it('just under the tap time limit still taps', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    g.up(179, 0, 0);
    expect(kinds()).toEqual(['tap']);
  });

  it('moving 12px or more is not a tap', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    g.move(50, 12, 0);
    g.up(100, 12, 0);
    expect(kinds()).toEqual(['cancel']);
  });

  it('release just past the hold threshold opens and closes the hold in order', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    g.up(185, 0, 0);
    // up() runs move() → update() first, so the hold is recognised and closed in order.
    expect(kinds()).toEqual(['holdStart', 'holdEnd']);
  });
});

describe('GestureClassifier — hold', () => {
  it('starts exactly at the hold threshold when steady', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    g.update(179);
    expect(kinds()).toEqual([]);
    g.update(180);
    expect(kinds()).toEqual(['holdStart']);
    expect(g.phase).toBe('holding');
    g.update(900);
    g.up(1000, 2, 2);
    expect(kinds()).toEqual(['holdStart', 'holdEnd']);
  });

  it('waits out the swipe window when the thumb is drifting', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    g.move(100, 20, 0); // drifting, under swipe distance
    g.update(190);
    expect(kinds()).toEqual([]);
    g.update(201);
    expect(kinds()).toEqual(['holdStart']);
  });

  it('cancel while holding releases the crystal', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    g.update(300);
    g.cancel();
    expect(kinds()).toEqual(['holdStart', 'holdEnd']);
    expect(g.active).toBe(false);
  });

  it('cancel while pending emits cancel only', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    g.cancel();
    expect(kinds()).toEqual(['cancel']);
  });
});

describe('GestureClassifier — swipe', () => {
  it('fast 60px flick right is a swipe with a unit direction', () => {
    const { g, log, kinds } = rig();
    g.down(0, 0, 0);
    drag(g, 0, 60, 0, 90);
    expect(kinds()).toEqual(['swipe']);
    expect(log[0]!.dx).toBeCloseTo(1);
    expect(log[0]!.dy).toBeCloseTo(0);
    g.up(120, 60, 0);
    expect(kinds()).toEqual(['swipe']);
  });

  it('fires on the move that crosses 40px, before release (snappy)', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    g.move(30, 25, 0);
    expect(kinds()).toEqual([]);
    g.move(50, 41, 0);
    expect(kinds()).toEqual(['swipe']);
  });

  it('diagonal up-left direction is preserved (screen y down)', () => {
    const { g, log } = rig();
    g.down(0, 100, 100);
    g.move(60, 70, 70);
    expect(log[0]!.k).toBe('swipe');
    expect(log[0]!.dx).toBeCloseTo(-Math.SQRT1_2);
    expect(log[0]!.dy).toBeCloseTo(-Math.SQRT1_2);
  });

  it('slow 60px drag is not a swipe; it becomes a hold', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    drag(g, 0, 60, 0, 600);
    expect(kinds()[0]).toBe('holdStart');
  });

  it('only one swipe per touch from the pending phase', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    drag(g, 0, 200, 0, 150);
    g.up(160, 200, 0);
    expect(kinds()).toEqual(['swipe']);
  });

  it('flick while holding dashes without dropping the crystal', () => {
    const { g, log, kinds } = rig();
    g.down(0, 0, 0);
    g.update(400);
    expect(kinds()).toEqual(['holdStart']);
    // slow drift first (not a flick)
    for (let t = 400; t <= 800; t += 16) g.move(t, ((t - 400) / 400) * 20, 0);
    expect(kinds()).toEqual(['holdStart']);
    // then a quick flick down 50px in 80ms
    for (let i = 1; i <= 5; i++) g.move(800 + i * 16, 20, i * 10);
    expect(kinds()).toEqual(['holdStart', 'swipe']);
    expect(log[1]!.dy).toBeGreaterThan(0.9);
    expect(g.phase).toBe('holding');
    // keeps flicking -> re-armed, a second flick is a second swipe
    for (let i = 1; i <= 5; i++) g.move(900 + i * 16, 20 + i * 10, 50);
    expect(kinds()).toEqual(['holdStart', 'swipe', 'swipe']);
    g.up(1200, 70, 50);
    expect(kinds()).toEqual(['holdStart', 'swipe', 'swipe', 'holdEnd']);
  });

  it('a swipe just after the hold started (slow ramp) still counts within the sliding window', () => {
    const { g, kinds } = rig();
    g.down(0, 0, 0);
    g.update(185); // hold begins
    for (let i = 1; i <= 6; i++) g.move(185 + i * 16, i * 9, 0); // 54px in ~96ms
    expect(kinds()).toEqual(['holdStart', 'swipe']);
  });
});

describe('GestureClassifier — robustness', () => {
  it('ignores events when idle', () => {
    const { g, kinds } = rig();
    g.move(0, 10, 10);
    g.up(10, 0, 0);
    g.update(1000);
    expect(kinds()).toEqual([]);
  });

  it('is reusable for many touches', () => {
    const { g, kinds } = rig();
    for (let i = 0; i < 50; i++) {
      const t = i * 1000;
      g.down(t, 0, 0);
      g.up(t + 50, 0, 0);
    }
    expect(kinds().length).toBe(50);
    expect(new Set(kinds())).toEqual(new Set(['tap']));
  });

  it('independent classifiers do not interfere (multi-touch)', () => {
    const a = rig();
    const b = rig();
    a.g.down(0, 0, 0);
    b.g.down(10, 300, 300);
    b.g.move(40, 360, 300);
    a.g.update(200);
    b.g.up(60, 360, 300);
    a.g.up(500, 0, 0);
    expect(a.kinds()).toEqual(['holdStart', 'holdEnd']);
    expect(b.kinds()).toEqual(['swipe']);
  });
});

describe('Joystick', () => {
  it('dead zone swallows small offsets', () => {
    const j = new Joystick(60, 0.12);
    j.start(100, 100);
    j.move(105, 100);
    expect(j.magnitude).toBe(0);
    expect(j.x).toBe(0);
  });

  it('rescales past the dead zone so output starts at 0 and reaches 1 at the rim', () => {
    const j = new Joystick(60, 0.12);
    j.start(0, 0);
    j.move(60 * 0.12 + 0.01, 0);
    expect(j.magnitude).toBeLessThan(0.01);
    j.move(30, 0);
    expect(j.magnitude).toBeCloseTo((0.5 - 0.12) / 0.88, 5);
    j.move(60, 0);
    expect(j.magnitude).toBeCloseTo(1, 5);
  });

  it('y is up on screen', () => {
    const j = new Joystick(60, 0.12);
    j.start(0, 0);
    j.move(0, -60);
    expect(j.y).toBeCloseTo(1);
    expect(j.x).toBeCloseTo(0);
  });

  it('base follows the thumb past the rim so reversing is instant', () => {
    const j = new Joystick(60, 0.12, true);
    j.start(0, 0);
    j.move(200, 0);
    expect(j.ox).toBeCloseTo(140);
    expect(j.x).toBeCloseTo(1);
    j.move(140 - 60, 0); // reverse by one radius from the dragged base
    expect(j.x).toBeCloseTo(-1);
  });

  it('without follow the knob clamps to the rim', () => {
    const j = new Joystick(60, 0.12, false);
    j.start(0, 0);
    j.move(0, 300);
    expect(j.ky).toBeCloseTo(60);
    expect(j.oy).toBe(0);
    expect(j.y).toBeCloseTo(-1);
  });

  it('end zeroes output', () => {
    const j = new Joystick(60, 0.12);
    j.start(0, 0);
    j.move(50, 50);
    j.end();
    expect(j.active).toBe(false);
    expect(j.magnitude).toBe(0);
  });
});
