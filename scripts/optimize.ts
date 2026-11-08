/**
 * assets/build/* → public/assets/<id>.<hash>.<ext> + public/assets/manifest.json + assets/licenses.json
 *
 * GLB pipeline (gltf-transform): strip PBR-only maps (the ink renderer uses albedo luminance only) →
 * dedup → prune → weld → resample → WebP textures (bounded size) → meshopt (quantize + compress).
 * Deterministic: identical inputs give identical bytes and hashes.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Document, Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, getBounds, meshopt, prune, resample, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { CATALOG, type CatalogEntry } from './build/catalog';
import { BUILD_DIR, PUBLIC_DIR, ROOT, sourcePath } from './build/paths';
import { SOURCES, type Source } from './sources';

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder })
  .setLogger(new Logger(Logger.Verbosity.WARN));

export interface ManifestClip {
  duration: number;
}
export interface ManifestEntry {
  file: string;
  type: CatalogEntry['type'];
  title: string;
  bytes: number;
  tris?: number;
  bones?: number;
  clips?: Record<string, ManifestClip>;
  sockets?: string[];
  materials?: string[];
  textures?: { name: string; width: number; height: number; mime: string }[];
  height?: number;
  /** Prop inside a pack: node name to clone. */
  node?: string;
  pack?: string;
  bounds?: { min: number[]; max: number[] };
  width?: number;
  license: string;
}
export interface Manifest {
  version: 1;
  assets: Record<string, ManifestEntry>;
}

const sha8 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 10);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function trisOf(doc: Document): number {
  let t = 0;
  for (const m of doc.getRoot().listMeshes())
    for (const p of m.listPrimitives()) {
      const idx = p.getIndices();
      t += (idx ? idx.getCount() : p.getAttribute('POSITION')!.getCount()) / 3;
    }
  return t;
}

const validator = await import('gltf-validator');

async function optimizeGlb(e: CatalogEntry): Promise<{ bytes: Uint8Array; doc: Document }> {
  // Validate the uncompressed build (glTF-Validator cannot look inside EXT_meshopt_compression).
  const raw = new Uint8Array(readFileSync(join(BUILD_DIR, e.build!)));
  const report = await validator.validateBytes(raw, { maxIssues: 50 });
  const errs = report.issues.messages.filter((m) => m.severity === 0);
  if (errs.length)
    throw new Error(
      `${e.build}: glTF errors\n${errs.map((m) => `  ${m.code} ${m.message} ${m.pointer}`).join('\n')}`,
    );
  const doc = await io.readBinary(raw);
  for (const m of doc.getRoot().listMaterials()) {
    m.setNormalTexture(null)
      .setOcclusionTexture(null)
      .setMetallicRoughnessTexture(null)
      .setEmissiveTexture(null);
  }
  const n = e.maxTexture ?? 512;
  await doc.transform(
    dedup(),
    prune({ keepLeaves: true }),
    weld(),
    resample({ tolerance: 1e-4 }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [n, n], quality: 85, effort: 90 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    prune({ keepLeaves: true }),
  );
  const bytes = await io.writeBinary(doc);
  return { bytes, doc: await io.readBinary(bytes) };
}

function licenseOf(ids: string[]): string {
  const lic = ids.map((id) => (id === 'original' ? 'Original' : SOURCES.find((s) => s.id === id)!.license));
  const set = new Set(lic);
  if (set.size === 1) return lic[0]!;
  if (set.has('CC-BY-4.0') || set.has('CC-BY-3.0')) return [...set].filter((x) => x.startsWith('CC-BY'))[0]!;
  if (set.has('Original')) return 'Original';
  return lic[0]!;
}

function component(id: string) {
  if (id === 'original')
    return { source: 'original', title: 'Original work for INKWAKE', license: 'Original' };
  const s = SOURCES.find((x) => x.id === id) as Source;
  return {
    source: s.id,
    title: s.title,
    author: s.author,
    license: s.license,
    licenseUrl: s.licenseUrl,
    page: s.page,
  };
}

// ── run ─────────────────────────────────────────────────────────────
if (existsSync(PUBLIC_DIR)) {
  for (const f of readdirSync(PUBLIC_DIR))
    if (f !== '.gitkeep') rmSync(join(PUBLIC_DIR, f), { recursive: true });
}
mkdirSync(PUBLIC_DIR, { recursive: true });

const manifest: Manifest = { version: 1, assets: {} };
const licenses: { file: string; id: string; title: string; license: string; components: object[] }[] = [];
let total = 0;

for (const e of CATALOG) {
  for (const s of e.sources)
    if (s !== 'original' && !SOURCES.some((x) => x.id === s)) throw new Error(`${e.id}: unknown source ${s}`);
  let bytes: Uint8Array;
  let ext: string;
  let doc: Document | null = null;
  if (e.copy) {
    bytes = new Uint8Array(readFileSync(sourcePath(e.copy.source, e.copy.file)));
    ext = e.copy.ext;
  } else if (e.build!.endsWith('.glb')) {
    ({ bytes, doc } = await optimizeGlb(e));
    ext = 'glb';
  } else {
    bytes = new Uint8Array(readFileSync(join(BUILD_DIR, e.build!)));
    ext = e.build!.split('.').pop()!;
  }
  const file = `${e.id}.${sha8(bytes)}.${ext}`;
  writeFileSync(join(PUBLIC_DIR, file), bytes);
  total += bytes.length;
  const license = licenseOf(e.sources);
  const entry: ManifestEntry = { file, type: e.type, title: e.title, bytes: bytes.length, license };

  if (doc) {
    const root = doc.getRoot();
    entry.tris = trisOf(doc);
    const skin = root.listSkins()[0];
    if (skin) entry.bones = skin.listJoints().length;
    const anims = root.listAnimations();
    if (anims.length) {
      entry.clips = {};
      for (const a of anims) {
        let d = 0;
        for (const s of a.listSamplers()) d = Math.max(d, s.getInput()!.getMax([0])[0]!);
        entry.clips[a.getName()] = { duration: r3(d) };
      }
    }
    const sockets = root
      .listNodes()
      .map((x) => x.getName())
      .filter((x) => x.startsWith('socket_'));
    if (sockets.length) entry.sockets = sockets;
    entry.materials = root.listMaterials().map((m) => m.getName());
    entry.textures = root.listTextures().map((t) => {
      const [w, h] = t.getSize() ?? [0, 0];
      return { name: t.getName(), width: w, height: h, mime: t.getMimeType() };
    });
    const scene = root.listScenes()[0]!;
    if (e.type === 'character') {
      const b = getBounds(scene);
      entry.height = r3(b.max[1] - b.min[1]);
    }
    if (e.type === 'prop' || e.type === 'prop-pack') {
      const b = getBounds(scene);
      entry.bounds = { min: b.min.map(r3), max: b.max.map(r3) };
    }
    if (e.props) {
      for (const p of e.props) {
        const node = scene.listChildren().find((x) => x.getName() === p.id);
        if (!node) throw new Error(`${e.id}: prop node ${p.id} missing`);
        let t = 0;
        node.traverse((x) => {
          const m = x.getMesh();
          if (m)
            for (const pr of m.listPrimitives())
              t += (pr.getIndices()?.getCount() ?? pr.getAttribute('POSITION')!.getCount()) / 3;
        });
        const b = getBounds(node);
        manifest.assets[p.id] = {
          file,
          type: 'prop',
          title: p.id,
          bytes: 0,
          tris: t,
          node: p.id,
          pack: e.id,
          bounds: { min: b.min.map(r3), max: b.max.map(r3) },
          license: licenseOf(p.sources),
        };
      }
    }
  } else if (e.type === 'texture') {
    const meta = await sharp(bytes).metadata();
    entry.width = meta.width;
  }
  manifest.assets[e.id] = entry;
  licenses.push({
    file: `assets/${file}`,
    id: e.id,
    title: e.title,
    license,
    components: e.sources.map(component),
  });
  console.log(
    `✓ ${file.padEnd(36)} ${(bytes.length / 1024).toFixed(0).padStart(6)} KB${entry.tris ? `  ${entry.tris} tris` : ''}${entry.bones ? `  ${entry.bones} bones` : ''}${entry.clips ? `  ${Object.keys(entry.clips).length} clips` : ''}`,
  );
}

writeFileSync(join(PUBLIC_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
// Entries outside public/assets (UI fonts in public/fonts, audio in public/audio) are maintained by
// their workstreams by hand: keep them, regenerate only ours.
const licPath = join(ROOT, 'assets/licenses.json');
const external = existsSync(licPath)
  ? (JSON.parse(readFileSync(licPath, 'utf8')).assets as { file: string }[]).filter(
      (a) => !a.file.startsWith('assets/'),
    )
  : [];
writeFileSync(
  licPath,
  `${JSON.stringify(
    {
      $comment:
        'assets/* entries are GENERATED by scripts/optimize.ts (scripts/build/catalog.ts + scripts/sources.ts); fonts/* and audio/* entries are hand-maintained by their workstreams and preserved. Every shipped file under public/{assets,fonts,audio} needs an entry (validate.ts). Only licences permitting commercial use.',
      assets: [...licenses, ...external],
    },
    null,
    2,
  )}\n`,
);
console.log(`public/assets: ${(total / 1024 / 1024).toFixed(2)} MB in ${licenses.length} files`);
