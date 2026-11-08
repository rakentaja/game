/**
 * Asset harness (/dev/assets.html): every manifest asset in a grid, characters with a clip picker,
 * plain MeshToonMaterial in palette colours (the ink look lives in the render workstream).
 * One WebGL canvas, one scissored viewport per cell. `?t=<sec>` freezes time (screenshots).
 */
import * as THREE from 'three';
import { PAL } from '@/data/palette';
import { AssetLoader, browserDeps, type ManifestEntry } from '@/world/assets';

THREE.ColorManagement.enabled = false;

const q = new URLSearchParams(location.search);
const frozen = q.has('t') ? Number(q.get('t')) : null;
const loader = new AssetLoader(`${import.meta.env.BASE_URL}assets/`, browserDeps());
const grid = document.getElementById('grid')!;
const bar = document.getElementById('bar')!;
const statsEl = document.getElementById('stats')!;
const ui = {
  spin: document.getElementById('spin') as HTMLInputElement,
  sockets: document.getElementById('sockets') as HTMLInputElement,
  wire: document.getElementById('wire') as HTMLInputElement,
  speed: document.getElementById('speed') as HTMLInputElement,
};

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setScissorTest(true);
renderer.autoClear = false;

// 3-step toon gradient (matches the POC's posterised ramps closely enough for inspection).
const grad = new THREE.DataTexture(new Uint8Array([60, 140, 255]), 3, 1, THREE.RedFormat);
grad.minFilter = grad.magFilter = THREE.NearestFilter;
grad.needsUpdate = true;

/** Palette colour by material name (pipeline names materials for the ink renderer). */
function colourFor(name: string): string {
  const n = name.toLowerCase();
  if (/staff|pencil_lead|band|visor_band|ferrule/.test(n)) return PAL.staff[2];
  if (/visor|leaves|forest|bush|fern/.test(n)) return PAL.teal[2];
  if (/robe|rubber|skin|pencil_paint/.test(n)) return PAL.red[2];
  if (/sleeve|wood|pencil_wood|eyes|brows/.test(n)) return PAL.ghost[2];
  if (/bark/.test(n)) return PAL.red[1];
  if (/rock|halloween|mushroom/.test(n)) return PAL.ghost[1];
  return PAL.red[3];
}

const toonCache = new Map<string, THREE.MeshToonMaterial>();
function toon(src: THREE.Material, skinned: boolean): THREE.MeshToonMaterial {
  const map = (src as THREE.MeshStandardMaterial).map ?? null;
  const key = `${src.name}|${map?.uuid ?? ''}|${skinned}`;
  let m = toonCache.get(key);
  if (!m) {
    m = new THREE.MeshToonMaterial({ color: colourFor(src.name), gradientMap: grad, map });
    m.name = src.name;
    toonCache.set(key, m);
  }
  return m;
}

interface Cell {
  el: HTMLElement;
  view: HTMLElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  pivot: THREE.Object3D;
  mixer: THREE.AnimationMixer | null;
  action: THREE.AnimationAction | null;
  socketMarkers: THREE.Object3D[];
  radius: number;
}
const cells: Cell[] = [];
const keyLight = new THREE.DirectionalLight('#fff', 2.2);
keyLight.position.set(2, 4, 3);

function makeCell(id: string, e: ManifestEntry, wide = false): Cell {
  const el = document.createElement('div');
  el.className = `cell${wide ? ' wide' : ''}`;
  const view = document.createElement('div');
  view.className = 'view';
  el.appendChild(view);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const facts = [
    e.tris ? `${e.tris.toLocaleString()} tris` : '',
    e.bones ? `${e.bones} bones` : '',
    e.clips ? `${Object.keys(e.clips).length} clips` : '',
    e.bytes ? `${(e.bytes / 1024).toFixed(0)} KB` : e.pack ? `in ${e.pack}` : '',
  ].filter(Boolean);
  meta.innerHTML = `<b>${id}</b><small>${facts.join(' · ')}</small>`;
  el.appendChild(meta);
  const lic = document.createElement('span');
  lic.className = 'lic';
  lic.textContent = e.license;
  el.appendChild(lic);
  grid.appendChild(el);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#f7eedd', '#1d3a38', 1.1), keyLight.clone());
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshToonMaterial({ color: PAL.teal[1], gradientMap: grad }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const camera = new THREE.PerspectiveCamera(30, 0.75, 0.01, 200);
  const pivot = new THREE.Object3D();
  scene.add(pivot);
  const cell: Cell = {
    el,
    view,
    scene,
    camera,
    pivot,
    mixer: null,
    action: null,
    socketMarkers: [],
    radius: 1,
  };
  cells.push(cell);
  return cell;
}

function frame(cell: Cell, obj: THREE.Object3D, groundScale = 1) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const r = Math.max(size.x, size.z) * 0.5;
  const h = size.y;
  const ground = cell.scene.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
  ground.scale.setScalar(Math.max(r, h * 0.35) * 1.4 * groundScale);
  const dist = Math.max(h, r * 2.1) * 2.4 + 0.3;
  cell.camera.position.set(dist * 0.55, h * 0.62 + dist * 0.18, dist * 0.85);
  cell.camera.lookAt(0, h * 0.45, 0);
  cell.radius = dist;
}

function addSockets(cell: Cell, root: THREE.Object3D) {
  const geo = new THREE.OctahedronGeometry(0.035);
  const mat = new THREE.MeshBasicMaterial({ color: PAL.glowCore, depthTest: false });
  root.traverse((o) => {
    if (!o.name.startsWith('socket_')) return;
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 10;
    // keep marker size constant regardless of parent scale
    const ws = o.getWorldScale(new THREE.Vector3());
    m.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
    o.add(m);
    cell.socketMarkers.push(m);
  });
}

function applyToon(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh === true;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((m) => toon(m, skinned))
      : toon(mesh.material, skinned);
    mesh.frustumCulled = false;
  });
}

async function addCharacter(id: string, e: ManifestEntry) {
  const cell = makeCell(id, e, true);
  const { scene, animations } = await loader.loadAsset(id);
  applyToon(scene);
  cell.pivot.add(scene);
  addSockets(cell, scene);
  cell.mixer = new THREE.AnimationMixer(scene);
  const sel = document.createElement('select');
  for (const c of animations) sel.add(new Option(`${c.name} · ${c.duration.toFixed(2)}s`, c.name));
  const pick = (name: string) => {
    const clip = loader.getClip(id, name);
    if (!clip || !cell.mixer) return;
    const next = cell.mixer.clipAction(clip);
    next.reset().play();
    if (cell.action && cell.action !== next) cell.action.crossFadeTo(next, 0.25, false);
    cell.action = next;
  };
  sel.onchange = () => pick(sel.value);
  const initial = q.get(id) ?? `${id}@idle`;
  sel.value = animations.some((a) => a.name === initial) ? initial : (animations[0]?.name ?? '');
  pick(sel.value);
  cell.el.appendChild(sel);
  frame(cell, scene, 1);
  // headroom for raised-staff clips (hold, victory) above the rest-pose bounds
  cell.camera.position.multiplyScalar(1.2);
  cell.camera.lookAt(0, cell.camera.position.y * 0.55, 0);
}

async function addProp(id: string, e: ManifestEntry) {
  const cell = makeCell(id, e);
  const { scene } = await loader.loadAsset(id);
  applyToon(scene);
  cell.pivot.add(scene);
  addSockets(cell, scene);
  frame(cell, scene);
}

async function addTexture(id: string, e: ManifestEntry) {
  const cell = makeCell(id, e);
  const tex = await loader.loadTexture(id);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: tex }));
  plane.position.y = 0.8;
  cell.pivot.add(plane);
  cell.camera.position.set(0, 0.8, 3.4);
  cell.camera.lookAt(0, 0.8, 0);
  cell.radius = -1; // no turntable
}

async function addFont(id: string, e: ManifestEntry) {
  const el = document.createElement('div');
  el.className = 'cell font';
  const family = `inkwake-${id}`;
  const face = new FontFace(family, `url(${loader.url(id)})`);
  await face.load();
  document.fonts.add(face);
  if (id === 'font_bangers') document.fonts.add(new FontFace('Bangers', `url(${loader.url(id)})`));
  el.innerHTML = `<div class="sample" style="font-family:${family};font-size:${id.includes('bangers') ? 44 : 28}px">KRAK! Issue #1<br><span style="font-size:0.55em">The Unprinted Wood</span></div><div class="meta"><b>${id}</b><small>${(e.bytes / 1024).toFixed(0)} KB</small></div><span class="lic">${e.license}</span>`;
  grid.appendChild(el);
}

// ───────────────────────────── boot ─────────────────────────────

const errEl = document.getElementById('err')!;
try {
  const manifest = await loader.loadManifest();
  const all = Object.entries(manifest.assets);
  const ids = all.filter(([, e]) => e.type !== 'license-text').map(([id]) => id);
  const t0 = performance.now();
  await loader.preload(ids, (p) => {
    bar.style.width = `${(p.ratio * 100).toFixed(1)}%`;
  });
  const loadMs = performance.now() - t0;
  setTimeout(() => (bar.style.opacity = '0'), 400);
  const order: ManifestEntry['type'][] = ['character', 'prop', 'texture', 'font'];
  const sorted = all
    .filter(([, e]) => order.includes(e.type))
    .sort((a, b) => order.indexOf(a[1].type) - order.indexOf(b[1].type));
  for (const [id, e] of sorted) {
    if (e.type === 'character') await addCharacter(id, e);
    else if (e.type === 'prop') await addProp(id, e);
    else if (e.type === 'texture') await addTexture(id, e);
    else if (e.type === 'font') await addFont(id, e);
  }
  const totalKb = all.reduce((s, [, e]) => s + e.bytes, 0) / 1024;
  statsEl.textContent = `${sorted.length} assets · ${(totalKb / 1024).toFixed(2)} MB · loaded in ${loadMs.toFixed(0)} ms`;
} catch (e) {
  errEl.textContent = String((e as Error).stack ?? e);
  console.error(e);
}

// ───────────────────────────── render loop ─────────────────────────────

let last = performance.now();
const CELL_BG = new THREE.Color('#2a2224');
const rect = { l: 0, b: 0, w: 0, h: 0 };
let time = frozen ?? 0;
function render() {
  const now = performance.now();
  const dt = frozen !== null ? 0 : Math.min(0.05, (now - last) / 1000) * Number(ui.speed.value);
  last = now;
  time += dt;
  const w = innerWidth;
  const h = innerHeight;
  if (
    canvas.width !== Math.floor(w * renderer.getPixelRatio()) ||
    canvas.height !== Math.floor(h * renderer.getPixelRatio())
  )
    renderer.setSize(w, h, false);
  renderer.setScissor(0, 0, w, h);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.setClearColor(CELL_BG, 1);
  for (const c of cells) {
    const r = c.view.getBoundingClientRect();
    if (r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) continue;
    rect.l = r.left;
    rect.b = h - r.bottom;
    rect.w = r.width;
    rect.h = r.height;
    renderer.setViewport(rect.l, rect.b, rect.w, rect.h);
    renderer.setScissor(rect.l, rect.b, rect.w, rect.h);
    c.camera.aspect = rect.w / rect.h;
    c.camera.updateProjectionMatrix();
    if (frozen !== null && c.mixer && c.action) {
      c.action.time = frozen % c.action.getClip().duration;
      c.mixer.update(0);
    } else c.mixer?.update(dt);
    if (c.radius > 0 && ui.spin.checked) c.pivot.rotation.y = time * 0.35;
    for (const m of c.socketMarkers) m.visible = ui.sockets.checked;
    renderer.clear();
    renderer.render(c.scene, c.camera);
  }
  requestAnimationFrame(render);
}
for (const m of toonCache.values()) m.wireframe = false;
ui.wire.onchange = () => {
  for (const m of toonCache.values()) m.wireframe = ui.wire.checked;
};
render();
document.documentElement.dataset.ready = '1';
