/** Fails if initial JS (gzip) exceeds the PLAN §8 budget of 350 KB. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dir = join(import.meta.dirname, '../dist/assets');
let total = 0;
for (const f of readdirSync(dir)) if (f.endsWith('.js')) total += gzipSync(readFileSync(join(dir, f))).length;
const kb = total / 1024;
console.log(`JS gzip total: ${kb.toFixed(1)} KB`);
if (kb > 350) process.exit(1);
