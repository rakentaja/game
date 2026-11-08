import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCredits, creditsMarkdown } from '../../scripts/credits';

const ROOT = join(import.meta.dirname, '../..');
const lic = JSON.parse(readFileSync(join(ROOT, 'assets/licenses.json'), 'utf8')) as {
  assets: { file: string; title?: string; license: string }[];
};
const shipped = JSON.parse(readFileSync(join(ROOT, 'public/assets/credits.json'), 'utf8'));
const md = readFileSync(join(ROOT, 'CREDITS.md'), 'utf8');

describe('credits stay 1:1 with assets/licenses.json', () => {
  const sections = buildCredits(lic.assets as never);

  it('committed credits.json and CREDITS.md are up to date (run `bun scripts/credits.ts`)', () => {
    expect(shipped.sections).toEqual(JSON.parse(JSON.stringify(sections)));
    expect(md).toBe(creditsMarkdown(sections));
  });

  it('every licensed file is covered by exactly one credit or the original-work entry', () => {
    const covered = new Set(sections.flatMap((s) => s.items.flatMap((i) => i.usedIn)));
    for (const a of lic.assets) {
      const key = a.file.startsWith('assets/') ? a.file.split('/')[1]!.split('.')[0]! : a.file;
      expect(covered.has(key), `${a.file} missing from credits`).toBe(true);
    }
  });

  it('the Credits screen font list matches the licensed fonts', () => {
    const ui = readFileSync(join(ROOT, 'src/ui/screens/credits.ts'), 'utf8');
    const block = ui.slice(
      ui.indexOf('const FONT_CREDITS'),
      ui.indexOf('];', ui.indexOf('const FONT_CREDITS')),
    );
    const uiFonts = [...block.matchAll(/name: '([^']+)'/g)].map((m) => m[1]).sort();
    const licFonts = sections
      .find((s) => s.title === 'Fonts')
      ?.items.map((i) => i.name)
      .sort();
    expect(uiFonts).toEqual(licFonts);
  });
});
