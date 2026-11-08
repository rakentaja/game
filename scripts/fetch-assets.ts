/**
 * Download every upstream source (scripts/sources.ts) into assets/source/<id>/ and verify sha256
 * against assets/sources.lock.json.
 *
 *   bun scripts/fetch-assets.ts            fetch missing sources, verify checksums
 *   bun scripts/fetch-assets.ts --update   accept new checksums (upstream re-uploaded a pack)
 *   bun scripts/fetch-assets.ts --force    re-download everything
 *
 * Archives are cached in assets/source/_cache/ (gitignored) so re-runs are offline.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { itchUploads } from './lib/itch';
import { SOURCES, type Source } from './sources';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'assets/source');
const CACHE = join(SRC, '_cache');
const LOCK = join(ROOT, 'assets/sources.lock.json');

type Lock = Record<string, { sha256: string; bytes: number; file: string; fetched: string }>;

const args = new Set(process.argv.slice(2));
const lock: Lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : {};
const only = [...args].filter((a) => !a.startsWith('--'));

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function download(url: string): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'inkwake-asset-fetch/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 3) throw new Error(`download failed ${url}: ${e}`);
      await Bun.sleep(2000 * 2 ** attempt);
    }
  }
}

async function acquire(s: Source): Promise<{ bytes: Uint8Array; file: string }> {
  const k = s.kind;
  if (k.type === 'repo') {
    const raw = readFileSync(join(ROOT, k.path));
    if (k.decode === 'base64-js-default') {
      const m = raw.toString('utf8').match(/export default "([A-Za-z0-9+/=]+)"/);
      if (!m) throw new Error(`${k.path}: no base64 default export`);
      return { bytes: new Uint8Array(Buffer.from(m[1]!, 'base64')), file: `${s.id}.glb` };
    }
    return { bytes: new Uint8Array(raw), file: k.path.split('/').pop()! };
  }
  if (k.type === 'url')
    return { bytes: await download(k.url), file: decodeURIComponent(k.url.split('/').pop()!) };
  const { uploads, resolve } = await itchUploads(k.user, k.slug);
  const up = uploads.find((u) => k.file.test(u.name));
  if (!up)
    throw new Error(
      `${s.id}: no itch upload matching ${k.file} (have: ${uploads.map((u) => u.name).join(', ')})`,
    );
  return { bytes: await download(await resolve(up)), file: up.name };
}

let failed = 0;
for (const s of SOURCES) {
  if (only.length && !only.includes(s.id)) continue;
  const out = join(SRC, s.id);
  const marker = join(out, '.fetched');
  const cached = join(CACHE, `${s.id}.bin`);
  try {
    let bytes: Uint8Array;
    let file: string;
    if (!args.has('--force') && existsSync(cached)) {
      bytes = new Uint8Array(readFileSync(cached));
      file = lock[s.id]?.file ?? `${s.id}.bin`;
    } else {
      process.stdout.write(`↓ ${s.id} … `);
      ({ bytes, file } = await acquire(s));
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(cached, bytes);
      console.log(`${(bytes.length / 1e6).toFixed(1)} MB`);
      if (s.kind.type === 'itch') await Bun.sleep(1500); // be gentle with itch.io
    }
    const hash = sha256(bytes);
    const prev = lock[s.id];
    if (prev && prev.sha256 !== hash && !args.has('--update')) {
      throw new Error(
        `checksum mismatch (lock ${prev.sha256.slice(0, 12)}…, got ${hash.slice(0, 12)}…). Upstream changed; re-check licence and run with --update.`,
      );
    }
    if (!prev || prev.sha256 !== hash) {
      lock[s.id] = {
        sha256: hash,
        bytes: bytes.length,
        file,
        fetched: new Date().toISOString().slice(0, 10),
      };
    }
    if (!existsSync(marker) || readFileSync(marker, 'utf8') !== hash) {
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      if (s.unzip) {
        // `unzip` refuses absolute paths and strips "../" components (zip-slip safe).
        const r = spawnSync('unzip', ['-qo', cached, '-d', out], { stdio: 'inherit' });
        if (r.status !== 0) throw new Error('unzip failed');
      } else {
        const dest = join(out, file);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
      }
      writeFileSync(marker, hash);
    }
    console.log(`✓ ${s.id} ${hash.slice(0, 12)}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${s.id}: ${(e as Error).message}`);
    if (s.manual) console.error(`  manual: ${s.manual}`);
  }
}
writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
if (failed) {
  console.error(`${failed} source(s) failed — see assets/source/README.md for manual steps`);
  process.exit(1);
}
