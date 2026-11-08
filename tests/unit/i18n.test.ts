import { describe, expect, it } from 'vitest';
import { FLAT_DICTIONARIES, I18n, interpolate } from '../../src/ui/i18n';
import { parseCredits } from '../../src/ui/screens/credits';
import { sanitize } from '../../src/ui/settings';

const en = FLAT_DICTIONARIES.en;
const tr = FLAT_DICTIONARIES.tr;
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  it('TR and EN have exactly the same keys', () => {
    const a = [...en.keys()].sort();
    const b = [...tr.keys()].sort();
    expect(b.filter((k) => !en.has(k))).toEqual([]);
    expect(a.filter((k) => !tr.has(k))).toEqual([]);
  });

  it('every string is non-empty and uses the same {vars} in both languages', () => {
    for (const [k, v] of en) {
      const t = tr.get(k)!;
      expect(v.trim(), `en ${k}`).not.toBe('');
      expect(t.trim(), `tr ${k}`).not.toBe('');
      expect(vars(t), `vars ${k}`).toEqual(vars(v));
    }
  });

  it('has the onomatopoeia render uses and page titles', () => {
    for (const k of ['krak', 'fwoosh', 'thunk', 'shhh', 'splat', 'rrrip', 'boom', 'scrub']) {
      expect(en.has(`onomatopoeia.${k}`)).toBe(true);
    }
    for (const p of ['1', '2', '3', 'boss']) expect(tr.has(`page.${p}`)).toBe(true);
  });

  it('t() interpolates and falls back', () => {
    const i = new I18n('tr');
    expect(i.t('page.label', { n: 2 })).toBe('Sayfa 2');
    expect(i.t('missing.key')).toBe('missing.key');
    expect(interpolate('{a}-{b}', { a: 1 })).toBe('1-{b}');
    expect(i.upper('iğne')).toBe('İĞNE');
  });
});

describe('settings sanitize', () => {
  it('clamps and rejects junk', () => {
    const s = sanitize({ master: 4, quality: 'ultra' as never, lang: 'tr', vibration: 'yes' as never });
    expect(s.master).toBe(1);
    expect(s.quality).toBe('auto');
    expect(s.lang).toBe('tr');
    expect(s.vibration).toBe(true);
  });
});

describe('credits parsing', () => {
  it('accepts licenses.json-style and sectioned shapes', () => {
    expect(
      parseCredits({ assets: [{ file: 'assets/a.glb', license: 'CC0-1.0', author: 'X' }] }, 'A'),
    ).toEqual([{ title: 'A', items: [{ name: 'a.glb', author: 'X', license: 'CC0-1.0', url: undefined }] }]);
    expect(parseCredits({ sections: [{ title: 'Music', items: [{ name: 'Song' }] }] }, 'A')[0]!.title).toBe(
      'Music',
    );
    expect(parseCredits(null, 'A')).toEqual([]);
  });
});
