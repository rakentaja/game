/**
 * `bun run assets`: fetch → compose → optimize → credits → validate, from scratch.
 * Pass --offline to skip fetching (uses assets/source as is).
 */
import { spawnSync } from 'node:child_process';

const steps: [string, string[]][] = [
  ['fetch', ['scripts/fetch-assets.ts']],
  ['compose', ['scripts/compose.ts']],
  ['optimize', ['scripts/optimize.ts']],
  ['credits', ['scripts/credits.ts']],
  ['validate', ['scripts/validate.ts']],
];
const offline = process.argv.includes('--offline');
for (const [name, args] of steps) {
  if (offline && name === 'fetch') continue;
  console.log(`\n── ${name} ──`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`assets: step "${name}" failed`);
    process.exit(r.status ?? 1);
  }
}
