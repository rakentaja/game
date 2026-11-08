/**
 * Asset validation: every file in public/assets/ (except manifest.json) needs a licenses.json entry
 * with a commercial-use license. Extended by the asset pipeline workstream (budgets, glTF-Validator).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ALLOWED = new Set([
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-3.0',
  'OFL-1.1',
  'MIT',
  'Apache-2.0',
  'Pixabay',
  'Original',
]);
type Entry = { file: string; license: string };
const lic = JSON.parse(readFileSync(join(ROOT, 'assets/licenses.json'), 'utf8')) as { assets: Entry[] };
const known = new Map(lic.assets.map((a) => [a.file, a]));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const errors: string[] = [];
for (const f of walk(join(ROOT, 'public/assets'))) {
  const rel = relative(join(ROOT, 'public'), f).replaceAll('\\', '/');
  if (rel.endsWith('manifest.json') || rel.endsWith('.gitkeep')) continue;
  const e = known.get(rel);
  if (!e) errors.push(`unlicensed asset: ${rel}`);
  else if (!ALLOWED.has(e.license)) errors.push(`disallowed license ${e.license}: ${rel}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`assets ok (${known.size} licensed entries)`);
