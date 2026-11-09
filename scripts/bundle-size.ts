/**
 * Fails if initial JS (gzip) exceeds the PLAN §8 budget of 350 KB.
 * "Initial" = the entry script(s) + modulepreloads referenced by dist/index.html. Lazy chunks
 * (debug tools, the co-op lobby + net code, MQTT fallback …) are reported separately and are not
 * part of the budget, since solo players never download them on first load.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = join(import.meta.dirname, '../dist');
const dir = join(dist, 'assets');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const initialNames = new Set(
  [...html.matchAll(/<(?:script[^>]*\bsrc|link[^>]*rel="modulepreload"[^>]*\bhref)="([^"]+\.js)"/g)].map(
    (m) => basename(m[1]!),
  ),
);
let initial = 0;
let lazy = 0;
const lazyFiles: string[] = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const gz = gzipSync(readFileSync(join(dir, f))).length;
  if (initialNames.has(f)) initial += gz;
  else {
    lazy += gz;
    lazyFiles.push(`${f} ${(gz / 1024).toFixed(1)}`);
  }
}
const kb = initial / 1024;
console.log(`JS gzip initial: ${kb.toFixed(1)} KB / 350 (${initialNames.size} file(s))`);
console.log(`JS gzip lazy:    ${(lazy / 1024).toFixed(1)} KB — ${lazyFiles.join(', ')}`);
console.log(`JS gzip total:   ${((initial + lazy) / 1024).toFixed(1)} KB`);
if (!initialNames.size) {
  console.error('no entry script found in dist/index.html');
  process.exit(1);
}
if (kb > 350) process.exit(1);
