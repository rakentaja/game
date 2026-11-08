import { describe, expect, it } from 'vitest';
import type { LevelDef } from '../../src/core/types';
import { TUNING } from '../../src/data/tuning';
import { buildLevelData } from '../../src/world/levelData';
import { LEVELS, nextPage } from '../../src/world/levels';
import { validateLevel } from '../../src/world/validate';

describe('LevelDef validation', () => {
  for (const [key, def] of Object.entries(LEVELS)) {
    it(`page ${key} passes every static check`, () => {
      const r = validateLevel(def);
      expect(r.errors).toEqual([]);
    });
    it(`page ${key} start and end are walkable, start is not inside a blocker`, () => {
      const d = buildLevelData(def);
      const [x, , z] = def.playerStart.at;
      expect(d.collision.walkable(x, z)).toBe(true);
      const end = def.path[def.path.length - 1]!;
      expect(d.collision.walkable(end[0], end[1])).toBe(true);
      for (const b of d.layout.blockers)
        expect(Math.hypot(b.x - x, b.z - z)).toBeGreaterThan(b.r + TUNING.player.radius);
    });
  }

  it('pages chain 1 → 2 → 3 → boss', () => {
    expect(nextPage(1)).toBe(2);
    expect(nextPage(3)).toBe('boss');
    expect(nextPage('boss')).toBe(null);
  });

  it('pages total ≈ 4.5 min for a first-time player', () => {
    const pages = ['1', '2', '3'].map((k) => validateLevel(LEVELS[k]!).estimateS);
    const total = pages.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(220);
    expect(total).toBeLessThan(330);
  });

  it('detects a leaking gate', () => {
    const broken: LevelDef = { ...LEVELS['1']!, voids: [] };
    expect(validateLevel(broken).errors.join()).toMatch(/gates leak|does not gate/);
  });

  it('detects an unreachable trigger and a sketch out of reach', () => {
    const def = LEVELS['1']!;
    const broken: LevelDef = {
      ...def,
      triggers: [...def.triggers, { id: 'lost', rect: [80, 80, 82, 82], action: { type: 'spawn' } }],
      sketches: def.sketches.map((s) => ({
        ...s,
        at: [s.at[0] + 40, s.at[1], s.at[2]] as [number, number, number],
      })),
    };
    const errs = validateLevel(broken).errors.join('\n');
    expect(errs).toMatch(/trigger lost rect unreachable/);
    expect(errs).toMatch(/cannot be approached/);
  });

  it('is deterministic: same seed → same dressing', () => {
    const a = buildLevelData(LEVELS['2']!).layout;
    const b = buildLevelData(LEVELS['2']!).layout;
    expect(a.trees.length).toBe(b.trees.length);
    expect(a.trees[17]).toEqual(b.trees[17]);
  });
});
