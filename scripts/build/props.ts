/**
 * Prop packs: one GLB per biome with one root node per prop id (origin at the base centre, +Y up,
 * real-world metres). The loader clones a prop by node name.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Document, type Node, type NodeIO } from '@gltf-transform/core';
import {
  clearNodeTransform,
  copyToDocument,
  getBounds,
  simplify,
  transformMesh,
  weld,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { Matrix4 } from 'three';
import { addPrimitive } from '../lib/geo';
import { eraserGeo, material, stumpGeo } from './originals';
import { buildPath, sourcePath } from './paths';

const KK_HALLOWEEN =
  'KayKit-Halloween-Bits-1.0-6dc69bf6b2fa766a985754f35ec6a0324090e6c6/addons/kaykit_halloween_bits/Assets/gltf';

export interface PropSpec {
  id: string;
  /** Source id + file inside it, or 'original'. */
  source: string;
  file?: string;
  /** Target height in metres (uniform scale). */
  height: number;
  /** meshopt simplify ratio for heavy sources. */
  simplify?: number;
  /** Credit line override */
  note?: string;
}

export const FOREST: PropSpec[] = [
  { id: 'rock_a', source: 'quaternius-nature', file: 'glTF/Rock_Medium_1.gltf', height: 0.9 },
  { id: 'rock_b', source: 'quaternius-nature', file: 'glTF/Rock_Medium_2.gltf', height: 1.3 },
  { id: 'rock_c', source: 'quaternius-nature', file: 'glTF/Rock_Medium_3.gltf', height: 0.6 },
  { id: 'pebble_a', source: 'quaternius-nature', file: 'glTF/Pebble_Round_2.gltf', height: 0.18 },
  { id: 'mushroom', source: 'quaternius-nature', file: 'glTF/Mushroom_Common.gltf', height: 0.32 },
  {
    id: 'mushroom_shelf',
    source: 'quaternius-nature',
    file: 'glTF/Mushroom_Laetiporus.gltf',
    height: 0.4,
    simplify: 0.3,
  },
  { id: 'fern', source: 'quaternius-nature', file: 'glTF/Fern_1.gltf', height: 0.7 },
  { id: 'stump_a', source: 'original', height: 0.75 },
  { id: 'stump_b', source: 'original', height: 0.5 },
  {
    id: 'tree_dead_l',
    source: 'kaykit-halloween',
    file: `${KK_HALLOWEEN}/tree_dead_large.gltf`,
    height: 5.5,
  },
  {
    id: 'tree_dead_m',
    source: 'kaykit-halloween',
    file: `${KK_HALLOWEEN}/tree_dead_medium.gltf`,
    height: 3.6,
  },
  {
    id: 'tree_dead_s',
    source: 'kaykit-halloween',
    file: `${KK_HALLOWEEN}/tree_dead_small.gltf`,
    height: 2.2,
  },
  {
    id: 'bush_a',
    source: 'kaykit-forest',
    file: 'KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Bush_1_A_Color1.gltf',
    height: 0.8,
  },
];

export const GRAVEYARD: PropSpec[] = [
  { id: 'gravestone', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/gravestone.gltf`, height: 1.0 },
  { id: 'grave_a', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/grave_A.gltf`, height: 1.1 },
  { id: 'grave_b', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/grave_B.gltf`, height: 1.1 },
  {
    id: 'grave_broken',
    source: 'kaykit-halloween',
    file: `${KK_HALLOWEEN}/grave_A_destroyed.gltf`,
    height: 0.8,
  },
  {
    id: 'gravemarker_a',
    source: 'kaykit-halloween',
    file: `${KK_HALLOWEEN}/gravemarker_A.gltf`,
    height: 0.9,
  },
  {
    id: 'gravemarker_b',
    source: 'kaykit-halloween',
    file: `${KK_HALLOWEEN}/gravemarker_B.gltf`,
    height: 0.9,
  },
  { id: 'lantern', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/lantern_standing.gltf`, height: 0.55 },
  { id: 'lantern_post', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/post_lantern.gltf`, height: 2.4 },
  {
    id: 'lantern_hanging',
    source: 'kaykit-halloween',
    file: `${KK_HALLOWEEN}/lantern_hanging.gltf`,
    height: 0.6,
  },
  { id: 'crypt', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/crypt.gltf`, height: 3.6 },
  { id: 'ruin_arch', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/arch.gltf`, height: 3.4 },
  { id: 'ruin_gate', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/arch_gate.gltf`, height: 3.4 },
  { id: 'ruin_pillar', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/pillar.gltf`, height: 2.8 },
  { id: 'shrine', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/shrine_candles.gltf`, height: 1.5 },
  { id: 'fence', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/fence.gltf`, height: 1.1 },
  { id: 'fence_broken', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/fence_broken.gltf`, height: 1.1 },
  { id: 'fence_pillar', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/fence_pillar.gltf`, height: 1.4 },
  { id: 'skull', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/skull.gltf`, height: 0.22 },
  { id: 'candles', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/candle_triple.gltf`, height: 0.3 },
  { id: 'coffin', source: 'kaykit-halloween', file: `${KK_HALLOWEEN}/coffin.gltf`, height: 0.5 },
];

/** Read a .gltf whose image URIs may be wrong (e.g. "*_png.png"): missing images are dropped. */
export async function readTolerant(io: NodeIO, path: string): Promise<Document> {
  if (path.endsWith('.glb')) return io.read(path);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const dir = dirname(path);
  const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const b of json.buffers ?? [])
    if (b.uri) resources[b.uri] = new Uint8Array(readFileSync(join(dir, b.uri)));
  for (const img of json.images ?? []) {
    if (!img.uri) continue;
    let uri = decodeURIComponent(img.uri);
    if (!existsSync(join(dir, uri)) && existsSync(join(dir, uri.replace(/_png\.png$/, '.png'))))
      uri = uri.replace(/_png\.png$/, '.png');
    if (existsSync(join(dir, uri))) resources[img.uri] = new Uint8Array(readFileSync(join(dir, uri)));
    else img.uri = undefined; // dropped: missing upstream file
  }
  json.images = (json.images ?? []).map((i: { uri?: string; bufferView?: number }) =>
    i.uri || i.bufferView !== undefined ? i : { uri: 'data:image/png;base64,' },
  );
  return io.readJSON({ json, resources });
}

/** Move all mesh nodes of `src` into one group node of `dst`, baked, normalised and ground-centred. */
async function importProp(dst: Document, src: Document, spec: PropSpec): Promise<Node> {
  for (const n of src.getRoot().listNodes()) if (n.getMesh()) clearNodeTransform(n);
  const scene = src.getRoot().listScenes()[0]!;
  if (spec.simplify) {
    await src.transform(
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio: spec.simplify, error: 0.002 }),
    );
  }
  const b = getBounds(scene);
  const h = b.max[1] - b.min[1];
  const s = spec.height / h;
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const m = new Matrix4().makeScale(s, s, s).multiply(new Matrix4().makeTranslation(-cx, -b.min[1], -cz));
  for (const mesh of src.getRoot().listMeshes())
    transformMesh(mesh, m.toArray() as unknown as Parameters<typeof transformMesh>[1]);
  const meshNodes = src
    .getRoot()
    .listNodes()
    .filter((n) => n.getMesh());
  const map = copyToDocument(dst, src, meshNodes);
  const group = dst.createNode(spec.id);
  for (const n of meshNodes) {
    const copy = map.get(n) as Node;
    copy.setName(`${spec.id}_${copy.getName() || 'mesh'}`);
    group.addChild(copy);
  }
  return group;
}

function originalProp(dst: Document, spec: PropSpec): Node {
  const group = dst.createNode(spec.id);
  if (spec.id.startsWith('stump')) {
    const { bark, wood } = stumpGeo(spec.id === 'stump_a' ? 7 : 19);
    const s = spec.height / 0.55;
    const m = new Matrix4().makeScale(s, s, s);
    const mesh = dst.createMesh(spec.id);
    addPrimitive(dst, mesh, bark.apply(m), material(dst, 'bark', [0.36, 0.25, 0.18]));
    addPrimitive(dst, mesh, wood.apply(m), material(dst, 'wood', [0.78, 0.64, 0.45]));
    group.addChild(dst.createNode(`${spec.id}_mesh`).setMesh(mesh));
  }
  return group;
}

export async function buildPack(io: NodeIO, name: string, specs: PropSpec[]): Promise<string> {
  const dst = new Document();
  dst.createBuffer();
  const scene = dst.createScene(name);
  for (const spec of specs) {
    let node: Node;
    if (spec.source === 'original') node = originalProp(dst, spec);
    else node = await importProp(dst, await readTolerant(io, sourcePath(spec.source, spec.file!)), spec);
    node.setExtras({ prop: spec.id });
    scene.addChild(node);
  }
  // Single buffer for the whole pack.
  const buf = dst.getRoot().listBuffers()[0]!;
  for (const a of dst.getRoot().listAccessors()) a.setBuffer(buf);
  for (const b of dst.getRoot().listBuffers()) if (b !== buf) b.dispose();
  const out = buildPath(`${name}.glb`);
  await io.write(out, dst);
  return out;
}

/** Standalone eraser prop (THE EDITOR's weapon; also usable as a pickup / UI 3D icon). */
export async function buildEraser(io: NodeIO): Promise<string> {
  const doc = new Document();
  doc.createBuffer();
  const { rubber, sleeve, band } = eraserGeo();
  const mesh = doc.createMesh('eraser');
  addPrimitive(doc, mesh, rubber, material(doc, 'rubber', [0.85, 0.47, 0.45]));
  addPrimitive(doc, mesh, sleeve, material(doc, 'sleeve', [0.93, 0.88, 0.8]));
  addPrimitive(doc, mesh, band, material(doc, 'band', [0.2, 0.32, 0.31]));
  const node = doc.createNode('eraser').setMesh(mesh);
  // socket at the worn erasing edge (local +X end, bottom)
  node.addChild(doc.createNode('socket_erase_edge').setTranslation([0.58, -0.17, 0]));
  doc.createScene('eraser').addChild(node);
  const out = buildPath('eraser.glb');
  await io.write(out, doc);
  return out;
}
