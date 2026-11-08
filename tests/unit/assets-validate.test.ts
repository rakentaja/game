import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAssets } from '../../scripts/validate';

const ROOT = join(import.meta.dirname, '../..');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'inkwake-assets-'));
  cpSync(join(ROOT, 'public/assets'), join(dir, 'public/assets'), { recursive: true });
  cpSync(join(ROOT, 'assets/licenses.json'), join(dir, 'licenses.json'));
  return { dir, opts: { publicDir: join(dir, 'public'), licensesPath: join(dir, 'licenses.json') } };
}

describe('asset validation', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('passes on the committed public/assets', async () => {
    const s = sandbox();
    dir = s.dir;
    const { errors } = await validateAssets(s.opts);
    expect(errors).toEqual([]);
  }, 60_000);

  it('fails when a file is added without a licenses.json entry', async () => {
    const s = sandbox();
    dir = s.dir;
    writeFileSync(join(s.dir, 'public/assets/sneaky.glb'), 'not licensed');
    const { errors } = await validateAssets({ ...s.opts, licensesOnly: true });
    expect(errors).toContain(
      'unlicensed asset: assets/sneaky.glb (add it via scripts/build/catalog.ts or remove it)',
    );
  });

  it('fails on a non-commercial licence', async () => {
    const s = sandbox();
    dir = s.dir;
    const lic = JSON.parse(readFileSync(s.opts.licensesPath, 'utf8'));
    lic.assets[0].license = 'CC-BY-NC-4.0';
    writeFileSync(s.opts.licensesPath, JSON.stringify(lic));
    const { errors } = await validateAssets({ ...s.opts, licensesOnly: true });
    expect(errors.some((e) => e.startsWith('disallowed license CC-BY-NC-4.0'))).toBe(true);
  });
});
