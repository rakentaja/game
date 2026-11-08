import { describe, expect, it } from 'vitest';
import {
  busGains,
  clamp01,
  dbToGain,
  equalPower,
  gainToDb,
  integratedLoudness,
  layerLevel,
  limitInPlace,
  masteringGain,
  peak,
  sliderToGain,
  voiceGain,
} from '../../src/audio/mix';

const sine = (f: number, amp: number, secs: number, fs = 48000) => {
  const d = new Float32Array(Math.floor(secs * fs));
  for (let i = 0; i < d.length; i++) d[i] = amp * Math.sin((2 * Math.PI * f * i) / fs);
  return d;
};

describe('audio mix math', () => {
  it('converts dB ↔ gain', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(gainToDb(0)).toBe(-96);
    expect(dbToGain(-200)).toBe(0);
  });

  it('maps sliders with a square law and clamps', () => {
    expect(sliderToGain(0)).toBe(0);
    expect(sliderToGain(1)).toBe(1);
    expect(gainToDb(sliderToGain(0.5))).toBeCloseTo(-12.04, 1);
    expect(sliderToGain(2)).toBe(1);
    expect(sliderToGain(Number.NaN)).toBe(0);
    expect(clamp01(-1)).toBe(0);
  });

  it('chains master × bus × mastering × volume', () => {
    const v = { master: 1, music: 0.5, sfx: 1 };
    expect(busGains(v).music).toBeCloseTo(0.25);
    expect(voiceGain(v, 'sfx', 0.5, 0.5)).toBeCloseTo(0.25);
    expect(voiceGain({ master: 0, music: 1, sfx: 1 }, 'sfx', 1)).toBe(0);
    expect(voiceGain(v, 'sfx', 1, -3)).toBe(0);
  });

  it('equal-power crossfade keeps constant power', () => {
    for (const t of [0, 0.25, 0.5, 0.9, 1]) {
      const [a, b] = equalPower(t);
      expect(a * a + b * b).toBeCloseTo(1, 6);
    }
  });

  it('layers enter smoothly between start and full', () => {
    expect(layerLevel(0.1, 0.2, 0.6)).toBe(0);
    expect(layerLevel(0.4, 0.2, 0.6)).toBeCloseTo(0.5);
    expect(layerLevel(0.8, 0.2, 0.6)).toBe(1);
    expect(layerLevel(0.5, 0.5, 0.5)).toBe(1);
  });

  it('measures loudness per BS.1770 (997 Hz sine references)', () => {
    // A 997 Hz full-scale sine reads -3.01 LUFS on one channel.
    const l = integratedLoudness([sine(997, 1, 2)], 48000);
    expect(l).toBeCloseTo(-3.01, 0);
    const q = integratedLoudness([sine(997, 0.1, 2)], 48000);
    expect(q).toBeCloseTo(-23.01, 0);
    expect(integratedLoudness([new Float32Array(48000)], 48000)).toBe(-96);
  });

  it('mastering gain respects both the peak ceiling and the loudness target', () => {
    // loud enough already: loudness wins (attenuate)
    expect(gainToDb(masteringGain(0.5, -10, -16))).toBeCloseTo(-6, 5);
    // very peaky: peak ceiling wins
    const g = masteringGain(0.9, -30, -16);
    expect(gainToDb(0.9 * g)).toBeCloseTo(-1, 5);
  });

  it('limiter never exceeds the ceiling and leaves quiet material alone', () => {
    const d = sine(220, 1.6, 0.5);
    const gr = limitInPlace([d], 48000, -1);
    expect(peak(d)).toBeLessThanOrEqual(dbToGain(-1) + 1e-6);
    expect(gr).toBeLessThan(-4);
    const quiet = sine(220, 0.3, 0.2);
    const copy = quiet.slice();
    expect(limitInPlace([quiet], 48000, -1)).toBe(0);
    expect(quiet).toEqual(copy);
  });
});
