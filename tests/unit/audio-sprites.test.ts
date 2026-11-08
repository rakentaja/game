import { describe, expect, it } from 'vitest';
import { MIME, normalizeSprites, pickFormats, SPRITE } from '../../src/audio/sprites';
import { BAKE_ORDER, SFX, SFX_IDS } from '../../src/audio/synth/sfx';

const files = { webm: 'audio/sfx.webm', m4a: 'audio/sfx.m4a' };

describe('sfx sprite map', () => {
  it('prefers Opus/WebM where supported', () => {
    expect(pickFormats(files, () => 'probably')).toEqual([files.webm, files.m4a]);
  });
  it('falls back to AAC on Safari without WebM Opus', () => {
    expect(pickFormats(files, (m) => (m === MIME.m4a ? 'maybe' : ''))).toEqual([files.m4a]);
  });
  it('still tries every file when canPlayType claims nothing', () => {
    expect(pickFormats(files, () => '')).toHaveLength(2);
  });
  it('normalises entries and rejects out-of-range ones', () => {
    const m = normalizeSprites(
      {
        files,
        sprites: {
          ui_click: { start: 0, dur: 0.1 },
          step_grass: [
            { start: 0.2, dur: 0.1 },
            { start: 0.4, dur: 0.1 },
          ],
        },
      },
      1,
    );
    expect(m.get('ui_click')).toHaveLength(1);
    expect(m.get('step_grass')).toHaveLength(2);
    expect(() => normalizeSprites({ files, sprites: { ui_click: { start: 0.95, dur: 0.1 } } }, 1)).toThrow();
  });
  it('ships procedural: no sprite to fetch', () => {
    expect(SPRITE).toBeNull();
  });
});

describe('synth bank catalogue', () => {
  const catalogue = [
    'crystal_on',
    'crystal_off',
    'bolt_fire',
    'bolt_hit',
    'dash',
    'ghost_reveal',
    'ghost_die',
    'player_hurt',
    'ink_pickup',
    'sketch_loop',
    'sketch_done',
    'page_turn',
    'step_grass',
    'step_stone',
    'eraser_sweep',
    'boss_roar',
    'panel_stinger',
    'ui_click',
    'ui_hover',
    'fanfare',
    'scribble_fire',
    'blot_drain',
  ].sort();
  it('has a recipe for every SfxId and bakes each exactly once', () => {
    expect([...SFX_IDS].sort()).toEqual(catalogue);
    expect([...BAKE_ORDER].sort()).toEqual(catalogue);
  });
  it('declares sane mastering and voice limits', () => {
    for (const id of SFX_IDS) {
      const r = SFX[id];
      expect(r.lufs).toBeLessThanOrEqual(-12);
      expect(r.lufs).toBeGreaterThanOrEqual(-32);
      expect(r.variants).toBeGreaterThan(0);
      expect(r.maxVoices).toBeGreaterThan(0);
      expect(r.dur).toBeGreaterThan(0);
    }
    expect(SFX.sketch_loop.loop).toBe(true);
    expect(SFX.eraser_sweep.loop).toBe(true);
  });
});
