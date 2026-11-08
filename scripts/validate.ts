/**
 * Asset validation (CI gate, `bun run assets:validate`):
 *  1. Licences — every file in public/assets (except manifest.json/.gitkeep) has an assets/licenses.json
 *     entry with a commercial-use licence, and every component licence is allowed too.
 *  2. Manifest — every manifest file exists; ids are unique; prop nodes point at packs.
 *  3. glTF — Khronos glTF-Validator reports no errors.
 *  4. Budgets (PLAN §8) — tris / bones / texture size per asset class, total download size.
 *  5. Animation contract — required clips exist and locomotion clips are in place.
 * Exits non-zero on any error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

export const ALLOWED_LICENSES = new Set([
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-3.0',
  'OFL-1.1',
  'MIT',
  'Apache-2.0',
  'Original',
]);

/** Budgets per asset class (PLAN §8: ≤15k tris per character; mobile texture memory). */
export const BUDGETS = {
  character: { tris: 15_000, bones: 80, texture: 1024 },
  prop: { tris: 3_000, texture: 512 },
  'prop-pack': { tris: 25_000, texture: 512 },
  /** Whole public/assets folder (first-load budget is 8 MB incl. JS/audio). */
  totalBytes: 6 * 1024 * 1024,
};

export const REQUIRED_CLIPS: Record<string, string[]> = {
  wizard: [
    'idle',
    'walk',
    'run',
    'dash',
    'roll',
    'cast_tap',
    'cast_hold_loop',
    'hit_react',
    'death',
    'victory',
    'look_around',
    'kneel',
  ],
  editor: ['idle', 'walk', 'sweep', 'slam', 'hit_react', 'death'],
};
/** Clips that must not travel (hip XZ drift first→last frame, metres, after root scale). */
export const IN_PLACE: Record<string, string[]> = {
  wizard: ['idle', 'walk', 'run', 'dash', 'roll', 'cast_hold_loop', 'look_around', 'kneel', 'victory'],
  editor: ['idle', 'walk', 'guard', 'judge', 'taunt_no'],
};
const MAX_DRIFT = 0.1;
/** Pipeline metadata (no third-party content). */
const GENERATED = new Set(['assets/manifest.json', 'assets/credits.json']);

interface LicenseEntry {
  file: string;
  license: string;
  components?: { source: string; license: string }[];
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export interface ValidateOptions {
  publicDir: string;
  licensesPath: string;
  /** Skip glTF-Validator + budget checks (licence-only, fast). */
  licensesOnly?: boolean;
}

export async function validateAssets(
  opt: ValidateOptions,
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const assetsDir = join(opt.publicDir, 'assets');
  const lic = JSON.parse(readFileSync(opt.licensesPath, 'utf8')) as { assets: LicenseEntry[] };
  const known = new Map(lic.assets.map((a) => [a.file, a]));

  // 1. licences
  const files = ['assets', 'fonts', 'audio']
    .map((d) => join(opt.publicDir, d))
    .filter((d) => existsSync(d))
    .flatMap((d) => walk(d))
    .map((f) => relative(opt.publicDir, f).replaceAll('\\', '/'))
    .filter((f) => !/^fonts\/OFL-.*\.txt$/.test(f));
  let total = 0;
  for (const rel of files) {
    if (GENERATED.has(rel) || rel.endsWith('.gitkeep') || rel.endsWith('.DS_Store')) continue;
    total += statSync(join(opt.publicDir, rel)).size;
    const e = known.get(rel);
    if (!e) {
      errors.push(`unlicensed asset: ${rel} (add it via scripts/build/catalog.ts or remove it)`);
      continue;
    }
    if (!ALLOWED_LICENSES.has(e.license)) errors.push(`disallowed license ${e.license}: ${rel}`);
    for (const c of e.components ?? [])
      if (!ALLOWED_LICENSES.has(c.license))
        errors.push(`disallowed component license ${c.license} (${c.source}): ${rel}`);
  }
  for (const f of known.keys()) if (!files.includes(f)) errors.push(`licenses.json lists missing file: ${f}`);
  if (total > BUDGETS.totalBytes)
    errors.push(
      `public/assets is ${(total / 1048576).toFixed(2)} MB > ${(BUDGETS.totalBytes / 1048576).toFixed(0)} MB budget`,
    );

  // 2. manifest
  let manifest: { assets: Record<string, Record<string, unknown>> } | null = null;
  try {
    manifest = JSON.parse(readFileSync(join(assetsDir, 'manifest.json'), 'utf8'));
  } catch {
    if (files.some((f) => f.endsWith('.glb'))) errors.push('public/assets/manifest.json missing or invalid');
  }
  if (manifest) {
    for (const [id, e] of Object.entries(manifest.assets)) {
      if (!files.includes(`assets/${e.file}`)) errors.push(`manifest ${id}: file ${e.file} missing`);
      if (e.pack && !manifest.assets[e.pack as string]) errors.push(`manifest ${id}: unknown pack ${e.pack}`);
    }
  }
  if (opt.licensesOnly || !manifest) return { errors, warnings };

  // 3–5. glTF validation, budgets, clips
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const validator = await import('gltf-validator');
  for (const [id, e] of Object.entries(manifest.assets)) {
    const file = e.file as string;
    if (!file.endsWith('.glb') || e.node) continue;
    const bytes = new Uint8Array(readFileSync(join(assetsDir, file)));
    const report = await validator.validateBytes(bytes, { maxIssues: 50 });
    for (const m of report.issues.messages)
      if (m.severity === 0) errors.push(`glTF ${file}: ${m.code} ${m.message} @ ${m.pointer ?? ''}`);
    if (report.issues.numWarnings)
      warnings.push(`glTF ${file}: ${report.issues.numWarnings} validator warnings`);

    const doc = await io.readBinary(bytes);
    const root = doc.getRoot();
    const type = e.type as keyof typeof BUDGETS;
    const budget = BUDGETS[type] as { tris: number; bones?: number; texture: number } | undefined;
    let tris = 0;
    for (const m of root.listMeshes())
      for (const p of m.listPrimitives())
        tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3;
    if (budget && tris > budget.tris) errors.push(`${id}: ${tris} tris > ${budget.tris} budget`);
    const bones = Math.max(0, ...root.listSkins().map((s) => s.listJoints().length));
    if (budget?.bones && bones > budget.bones) errors.push(`${id}: ${bones} bones > ${budget.bones} budget`);
    for (const t of root.listTextures()) {
      const [w, h] = t.getSize() ?? [0, 0];
      if (budget && Math.max(w, h) > budget.texture)
        errors.push(`${id}: texture ${t.getName()} ${w}×${h} > ${budget.texture}px budget`);
    }
    if (type === 'prop-pack') {
      for (const child of root.listScenes()[0]!.listChildren()) {
        let t = 0;
        child.traverse((n) => {
          for (const p of n.getMesh()?.listPrimitives() ?? [])
            t += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3;
        });
        if (t > BUDGETS.prop.tris)
          errors.push(`${id}/${child.getName()}: ${t} tris > ${BUDGETS.prop.tris} prop budget`);
      }
    }

    const clips = root.listAnimations();
    for (const name of REQUIRED_CLIPS[id] ?? [])
      if (!clips.some((a) => a.getName() === `${id}@${name}`))
        errors.push(`${id}: missing clip ${id}@${name}`);
    for (const a of clips)
      if (!a.getName().startsWith(`${id}@`))
        errors.push(`${id}: clip "${a.getName()}" not named ${id}@<clip>`);
    // in place: hip = joint with a translation channel closest to the skeleton root
    const skin = root.listSkins()[0];
    if (skin) {
      const joints = skin.listJoints();
      let scale = 1;
      for (let n = joints[0]!.getParentNode(); n; n = n.getParentNode()) scale *= n.getScale()[0]!;
      for (const name of IN_PLACE[id] ?? []) {
        const a = clips.find((x) => x.getName() === `${id}@${name}`);
        if (!a) continue;
        const ch = a
          .listChannels()
          .filter((c) => c.getTargetPath() === 'translation' && joints.includes(c.getTargetNode()!))
          .sort((x, y) => joints.indexOf(x.getTargetNode()!) - joints.indexOf(y.getTargetNode()!))[0];
        if (!ch) continue;
        const out = ch.getSampler()!.getOutput()!;
        const first = out.getElement(0, [0, 0, 0]);
        const last = out.getElement(out.getCount() - 1, [0, 0, 0]);
        let s = scale;
        for (let n = ch.getTargetNode()!.getParentNode(); n && joints.includes(n); n = n.getParentNode())
          s *= n.getScale()[0]!;
        const drift = Math.hypot(last[0]! - first[0]!, last[2]! - first[2]!) * s;
        if (drift > MAX_DRIFT)
          errors.push(`${id}@${name}: root drifts ${drift.toFixed(2)} m (must be in place)`);
      }
    }
  }
  return { errors, warnings };
}

if (import.meta.main) {
  const ROOT = join(import.meta.dirname, '..');
  const { errors, warnings } = await validateAssets({
    publicDir: join(ROOT, 'public'),
    licensesPath: join(ROOT, 'assets/licenses.json'),
    licensesOnly: process.argv.includes('--licenses-only'),
  });
  for (const w of warnings) console.warn(`warn: ${w}`);
  if (errors.length) {
    console.error(errors.map((e) => `✗ ${e}`).join('\n'));
    process.exit(1);
  }
  console.log('assets ok');
}
