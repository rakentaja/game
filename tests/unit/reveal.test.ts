import { beforeEach, describe, expect, it } from 'vitest';
import { TUNING } from '../../src/data/tuning';
import { NOISE_PERIOD, NOISE_SIZE, noiseData, sampleNoise } from '../../src/render/noise';
import { RevealSystem } from '../../src/render/reveal/RevealSystem';
import {
  circleField,
  combineField,
  historyField,
  REVEAL_GLSL,
  smooth01,
  stampValue,
} from '../../src/render/reveal/revealMath';

const STEP = 1 / 60;
function run(r: RevealSystem, seconds: number) {
  for (let t = 0; t < seconds; t += STEP) r.update(STEP);
}

describe('noise texture mirror', () => {
  const data = noiseData();
  const texel = NOISE_PERIOD / NOISE_SIZE;

  it('returns the exact byte at a texel centre', () => {
    for (const [i, j] of [
      [0, 0],
      [17, 200],
      [255, 255],
    ] as const) {
      const v = sampleNoise(data, (i + 0.5) * texel, (j + 0.5) * texel, 0);
      expect(v).toBeCloseTo(data[(j * NOISE_SIZE + i) * 4]! / 255, 6);
    }
  });

  it('interpolates linearly between texel centres and wraps like REPEAT', () => {
    const a = data[(5 * NOISE_SIZE + 9) * 4 + 2]! / 255;
    const b = data[(5 * NOISE_SIZE + 10) * 4 + 2]! / 255;
    expect(sampleNoise(data, 10 * texel, 5.5 * texel, 2)).toBeCloseTo((a + b) / 2, 6);
    expect(sampleNoise(data, 3.3 + NOISE_PERIOD, 1.7 - NOISE_PERIOD * 2, 1)).toBeCloseTo(
      sampleNoise(data, 3.3, 1.7, 1),
      6,
    );
  });
});

describe('reveal field math', () => {
  it('circle field is 0 at r - n and 1 one edge-width inside', () => {
    expect(circleField(3, 0, 3, 0, 0.9)).toBeCloseTo(0);
    expect(circleField(2.1, 0, 3, 0, 0.9)).toBeCloseTo(1);
    expect(circleField(2.5, 0, 3, 0.5, 0.9)).toBeCloseTo(0);
  });

  it('a freshly stamped history texel reproduces the circle field (no noise)', () => {
    for (const d of [0, 1.5, 2.6, 3, 3.5]) {
      const v = stampValue(d, 3, 0.9);
      const expected = Math.min(2, Math.max(-1, circleField(d, 0, 3, 0, 0.9)));
      expect(historyField(v, 0, 0.9)).toBeCloseTo(expected, 5);
    }
  });

  it('blank page keeps only the primary; erase beats everything', () => {
    expect(combineField(-0.5, 1.5, 1, 0)).toBe(-0.5);
    expect(combineField(-0.5, 1.5, 0, 0)).toBe(1.5);
    expect(combineField(2, 2, 0, 1)).toBeLessThan(0);
  });

  it('smooth01 is a clamped smoothstep', () => {
    expect(smooth01(-1)).toBe(0);
    expect(smooth01(2)).toBe(1);
    expect(smooth01(0.5)).toBeCloseTo(0.5);
  });

  it('GLSL uses the same constants as the CPU mirror', () => {
    expect(REVEAL_GLSL).toContain('mat2(0.8, 0.6, -0.6, 0.8)');
    expect(REVEAL_GLSL).toContain('vec2(0.71, 0.37)');
    expect(REVEAL_GLSL).toContain('vec2(13.7, 7.1)');
    expect(REVEAL_GLSL).toContain('/ 0.9375');
    expect(REVEAL_GLSL).toContain('3.0 * h.r - 1.0 - n / uRevealEdge');
  });
});

describe('RevealSystem (CPU mirror)', () => {
  let r: RevealSystem;
  beforeEach(() => {
    r = new RevealSystem(256);
    r.center.set(0, 1.6, 0);
  });

  it('inks the centre and leaves far paper blank', () => {
    run(r, 0.1);
    expect(r.revealAt(0, 0)).toBe(1);
    expect(r.isRevealed(0, 0)).toBe(true);
    expect(r.revealAt(20, 0)).toBe(0);
    expect(r.isRevealed(20, 0)).toBe(false);
  });

  it('edge sits within radius ± fbm amplitude', () => {
    run(r, 0.1);
    const R = r.radius;
    const amp = TUNING.crystal.fbmAmp;
    const edge = TUNING.crystal.edgeWidth;
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const inside = R - edge / 2 - amp - 0.05;
      const outside = R - edge / 2 + amp + 0.05;
      expect(r.isRevealed(Math.cos(a) * inside, Math.sin(a) * inside)).toBe(true);
      expect(r.isRevealed(Math.cos(a) * outside, Math.sin(a) * outside)).toBe(false);
    }
  });

  it('grows to the held radius within growTime and shrinks back slower', () => {
    r.targetRadius = TUNING.crystal.radiusHeld;
    run(r, TUNING.crystal.growTime);
    const span = TUNING.crystal.radiusHeld - TUNING.crystal.radiusIdle;
    expect(r.radius).toBeGreaterThan(TUNING.crystal.radiusHeld - span * 0.02);
    r.targetRadius = TUNING.crystal.radiusIdle;
    run(r, TUNING.crystal.growTime);
    expect(r.radius).toBeGreaterThan(TUNING.crystal.radiusIdle + span * 0.05);
    run(r, TUNING.crystal.shrinkTime);
    expect(r.radius).toBeLessThan(TUNING.crystal.radiusIdle + span * 0.02);
  });

  it('temporary sources ink then expire; removeSource is immediate', () => {
    const h = r.addSource(10, 10, 1.5, 1);
    run(r, 0.4);
    expect(r.isRevealed(10, 10)).toBe(true);
    run(r, 0.7);
    expect(r.isRevealed(10, 10)).toBe(false);
    const h2 = r.addSource(-10, 5, 1.5, 5);
    run(r, 0.4);
    expect(r.isRevealed(-10, 5)).toBe(true);
    r.removeSource(h2);
    expect(r.isRevealed(-10, 5)).toBe(false);
    expect(h2).not.toBe(h);
  });

  it('history keeps a trail behind the crystal, then it dries away', () => {
    run(r, 0.3);
    r.center.set(15, 1.6, 0);
    run(r, 0.2);
    expect(r.isRevealed(0, 0)).toBe(true);
    run(r, 1 / TUNING.reveal.historyFadePerSec + 1);
    expect(r.isRevealed(0, 0)).toBe(false);
  });

  it('eraseStrip is permanent: the crystal cannot re-ink it', () => {
    r.eraseStrip(-3, 0, 3, 0, 0.6);
    run(r, 0.5);
    expect(r.isRevealed(0, 0)).toBe(false);
    expect(r.isRevealed(0, 1.6)).toBe(true);
    run(r, 3);
    expect(r.isRevealed(0, 0)).toBe(false);
    r.reset();
    run(r, 0.1);
    expect(r.isRevealed(0, 0)).toBe(true);
  });

  it('blank page hides sources and history but not the crystal', () => {
    r.addSource(8, 0, 2, 10);
    run(r, 0.5);
    expect(r.isRevealed(8, 0)).toBe(true);
    r.blankPage = 1;
    run(r, STEP);
    expect(r.isRevealed(8, 0)).toBe(false);
    expect(r.isRevealed(0, 0)).toBe(true);
  });

  it('writes the uniforms the shader reads', () => {
    r.targetRadius = 5;
    r.addSource(1, 2, 3, 4);
    run(r, 0.2);
    expect(r.uniforms.uRevealRadius!.value).toBeCloseTo(r.radius);
    expect(r.uniforms.uRevealSourceCount!.value).toBe(1);
    expect(r.uniforms.uRevealTime!.value).toBeGreaterThan(0.19);
  });
});
