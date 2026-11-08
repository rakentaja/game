/**
 * Levels dev harness: /dev/levels.html?page=1|2|3|boss
 *   cam=game|fly      follow camera (gameplay framing) or low cinematic fly-through
 *   t=0..1            start position along the walk;  hold=1 freezes there
 *   reveal=0          show the page fully inked (composition check);  r=N fixes reveal radius
 *   map=0|1|full      top-down debug map
 *   print=all         pre-print every sketch
 * Keys: 1-4 page · C camera · M map · R reveal · P print nearest · Space pause · ←/→ scrub
 */
import * as THREE from 'three';
import { EventBus, type GameEvents } from '../core/events';
import {
  DEFAULT_SETTINGS,
  type GameContext,
  type LevelDef,
  type PlayerAPI,
  type RevealAPI,
} from '../core/types';
import { PAL } from '../data/palette';
import { TUNING } from '../data/tuning';
import { installLevel, type LevelRuntime } from '../world/install';
import { LEVELS } from '../world/levels';
import { inRect, makeHit, type PathHit } from '../world/path';
import { validateLevel } from '../world/validate';
import { createStubRender, MAX_SOURCES } from './levels-render';

const q = new URLSearchParams(location.search);
let pageKey = q.get('page') ?? '1';
let camMode = (q.get('cam') ?? 'game') as 'game' | 'fly' | 'over';
let mapMode = (q.get('map') ?? '1') as '0' | '1' | 'full';
let revealOn = q.get('reveal') !== '0';
const fixedR = q.get('r') ? Number(q.get('r')) : null;
let paused = q.get('hold') === '1';
const speed = Number(q.get('speed') ?? 3.4);

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const titleEl = document.getElementById('title')!;
const mapEl = document.getElementById('map') as HTMLCanvasElement;
const bar = document.getElementById('bar')!;

const R = createStubRender(canvas);
const events = new EventBus<GameEvents>();
const log: string[] = [];
const note = (s: string) => {
  log.unshift(s);
  log.length = Math.min(log.length, 7);
};
for (const k of [
  'trigger:fired',
  'sketch:printed',
  'checkpoint:reached',
  'tutorial:hint',
  'page:complete',
  'page:start',
  'fx:panelCut',
  'music:intensity',
] as const) {
  events.on(k, (p) => note(`${k} ${JSON.stringify(p).slice(0, 60)}`));
}

// ───────────── reveal stub (CPU side of the stub shader) ─────────────
const sources = new Map<number, [number, number, number]>();
let nextHandle = 1;
const reveal = {
  center: new THREE.Vector3(),
  radius: TUNING.crystal.radiusIdle,
  targetRadius: TUNING.crystal.radiusIdle,
  blankPage: 0,
  uniforms: R.shared,
  addSource(x: number, z: number, r: number) {
    const h = nextHandle++;
    sources.set(h, [x, z, r]);
    return h;
  },
  removeSource(h: number) {
    sources.delete(h);
  },
  eraseStrip() {},
  revealAt(x: number, z: number) {
    return Math.hypot(x - reveal.center.x, z - reveal.center.z) < reveal.radius ? 1 : 0;
  },
  isRevealed(x: number, z: number) {
    return reveal.revealAt(x, z) > 0.5;
  },
  update(dt: number) {
    const C = TUNING.crystal;
    const tgt = fixedR ?? reveal.targetRadius;
    const rate =
      tgt > reveal.radius
        ? (C.radiusHeld - C.radiusIdle) / C.growTime
        : (C.radiusHeld - C.radiusIdle) / C.shrinkTime;
    reveal.radius += Math.sign(tgt - reveal.radius) * Math.min(Math.abs(tgt - reveal.radius), rate * dt);
  },
  reset() {
    sources.clear();
  },
} as unknown as RevealAPI & { update(dt: number): void };

// ───────────── player stub: a wizard silhouette on the fly-through ─────────────
const wizard = new THREE.Group();
{
  const robe = new THREE.Mesh(
    new THREE.ConeGeometry(0.42, 1.25, 9),
    R.createInkMaterial({ ramp: 'red', reveal: false, keyAmt: 0.85, glowAmt: 1.4 }),
  );
  robe.position.y = 0.62;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 9, 7),
    R.createInkMaterial({ ramp: 'red', reveal: false, keyAmt: 0.85, glowAmt: 1.4 }),
  );
  head.position.y = 1.38;
  const hat = new THREE.Mesh(
    new THREE.ConeGeometry(0.34, 0.75, 8),
    R.createInkMaterial({ ramp: 'red', reveal: false, keyAmt: 0.7, glowAmt: 1.2 }),
  );
  hat.position.set(0, 1.78, 0);
  hat.rotation.z = 0.25;
  const staff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 2.0, 5),
    R.createInkMaterial({ ramp: 'staff', reveal: false }),
  );
  staff.position.set(0.42, 1.0, 0.05);
  wizard.add(robe, head, hat, staff);
}
const crystal = new THREE.Mesh(
  new THREE.OctahedronGeometry(0.12, 0),
  new THREE.ShaderMaterial({
    uniforms: { c: { value: new THREE.Color(PAL.glowCore) } },
    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'uniform vec3 c; void main(){ gl_FragColor = vec4(c,1.); }',
  }),
);
crystal.scale.set(0.7, 1.8, 0.5);
crystal.position.set(0.42, 2.12, 0.05);
wizard.add(crystal);
R.scene.add(wizard);

const player = {
  position: new THREE.Vector3(),
  velocity: new THREE.Vector3(),
  facing: new THREE.Vector3(0, 0, -1),
  crystalPos: new THREE.Vector3(),
  pages: 5,
  energy: 100,
  invulnerable: false,
  crystalHeld: false,
  object: wizard,
  damage() {},
  addEnergy(n: number) {
    player.energy = Math.min(100, player.energy + n);
    note(`+${n} ink`);
  },
  teleport(x: number, y: number, z: number) {
    player.position.set(x, y, z);
  },
  setControllable() {},
  playClip() {},
} as unknown as PlayerAPI & { energy: number; crystalHeld: boolean; pages: number };

const ctx = {
  events,
  tuning: TUNING,
  settings: { ...DEFAULT_SETTINGS },
  render: {
    ...R,
    beginPanelCut() {},
    async pageTurn(swap: () => void) {
      swap();
    },
    addOutline: () => () => {},
    snapshot: () => '',
    setQuality() {},
    setMisregistration() {},
    setReduceMotion() {},
  },
  reveal,
  player,
  time: { scale: 1, simTime: 0 },
  t: (k: string) => k,
} as unknown as GameContext;

// ───────────── page lifecycle ─────────────
let level: LevelRuntime | null = null;
let def: LevelDef;
let s = 0;
let holdUntil = 0;
const hit: PathHit = makeHit();
const look = makeHit();
const camPos = new THREE.Vector3();
const camTgt = new THREE.Vector3();
let snapCam = true;
let staticMap: HTMLCanvasElement | null = null;
const TITLES: Record<string, [string, string]> = {
  '1': ['INK', 'PAGE ONE'],
  '2': ['HOLLOW', 'PAGE TWO'],
  '3': ['BLOT', 'PAGE THREE'],
  boss: ['THE EDITOR', 'FINAL PAGE'],
};

function loadPage(key: string): void {
  level?.dispose();
  pageKey = key;
  def = LEVELS[key]!;
  const t0 = performance.now();
  level = installLevel(ctx, def);
  const buildMs = performance.now() - t0;
  level.start();
  const rep = validateLevel(def);
  console.info(
    `[levels] page ${key}: build ${buildMs.toFixed(0)} ms, path ${rep.pathLength.toFixed(0)} m, est ${rep.estimateS.toFixed(0)} s`,
    rep.errors,
  );
  if (rep.errors.length) note(`VALIDATION: ${rep.errors.join(' | ')}`);
  (R.shared.uKeyDir!.value as THREE.Vector3).set(...(def.mood?.keyDir ?? [-0.5, 0.75, 0.45])).normalize();
  R.shared.uShadow!.value = def.mood?.shadow ?? 0.3;
  R.shared.uFogNear!.value = def.fog.near;
  R.shared.uFogFar!.value = def.fog.far;
  if (q.get('fog') === '0' || camMode === 'over') {
    R.shared.uFogNear!.value = 200;
    R.shared.uFogFar!.value = 400;
  }
  if (q.get('print') === 'all') for (const sk of def.sketches) level.sketches.printNow(sk.id, true);
  const tq = Number(q.get('t') ?? 0);
  s = Math.max(0, Math.min(1, tq)) * level.built.data.path.length;
  // starting mid-page: everything behind us is already printed
  for (let st = nextStop(); st && st.at < s - 0.5; st = nextStop()) level.sketches.printNow(st.id, true);
  snapCam = true;
  staticMap = null;
  const [w, sub] = TITLES[key] ?? ['', ''];
  titleEl.innerHTML = `${w}<small>${sub}</small>`;
  titleEl.style.opacity = '1';
  setTimeout(() => (titleEl.style.opacity = '0'), 1800);
  // pencil strokes and mist skip the outline (normal) pass
  level.built.root.traverse((o) => {
    if (o.userData.noOutline) o.layers.set(1);
  });
  renderBar();
}
events.on('sketch:printed', () => {
  staticMap = null;
});

/** Where the fly-through should stop to print the next sketch (arc length), or Infinity. */
function nextStop(): { at: number; id: string } | null {
  if (!level) return null;
  let best: { at: number; id: string } | null = null;
  const path = level.built.data.path;
  for (const sk of def.sketches) {
    if (level.sketches.isPrinted(sk.id)) continue;
    const sArc = path.nearest(sk.at[0], sk.at[2], look).s;
    let stopAt = sArc;
    const blocked = (a: number) => {
      path.at(a, look);
      return (
        !level!.built.collision.walkable(look.px, look.pz) ||
        (sk.unlocks ? inRect(sk.unlocks, look.px, look.pz) : false)
      );
    };
    while (stopAt > 0 && blocked(stopAt)) stopAt -= 0.25;
    stopAt = Math.max(0, stopAt - (sk.type === 'bossDoor' ? 3.5 : 1.6));
    if (!best || stopAt < best.at) best = { at: stopAt, id: sk.id };
  }
  return best;
}

function step(dt: number): void {
  if (!level) return;
  const path = level.built.data.path;
  const stop = nextStop();
  let holding = false;
  if (!paused) {
    if (stop && s >= stop.at - 0.05) {
      s = stop.at;
      holding = true;
      // arena must be "cleared" before the boss door can print
      const sk = def.sketches.find((k) => k.id === stop.id)!;
      if (sk.requires && !level.sketches.isEnabled(sk.id)) {
        holdUntil += dt;
        if (holdUntil > 1.2) events.emit('trigger:fired', { id: sk.requires });
      }
    } else {
      s = Math.min(path.length, s + speed * dt);
      if (s >= path.length && q.get('loop') !== '0') {
        const order = ['1', '2', '3', 'boss'];
        const nxt = order[(order.indexOf(pageKey) + 1) % order.length]!;
        q.set('t', '0');
        loadPage(nxt);
        return;
      }
    }
  }
  path.at(s, hit);
  const sway = Math.sin(s * 0.35) * hit.halfW * 0.25;
  const x = hit.px - hit.tz * sway;
  const z = hit.pz + hit.tx * sway;
  const y = level.built.collision.groundHeight(x, z);
  player.position.set(x, y, z);
  player.facing.set(hit.tx, 0, hit.tz);
  player.crystalHeld = holding;
  reveal.targetRadius = holding
    ? TUNING.crystal.radiusHeld
    : camMode === 'fly'
      ? 5
      : TUNING.crystal.radiusIdle + 1;
  reveal.update(dt);
  wizard.position.copy(player.position);
  wizard.rotation.y = Math.atan2(-hit.tx, -hit.tz);
  wizard.updateMatrixWorld();
  crystal.getWorldPosition(player.crystalPos);
  (R.shared.uCrystalPos!.value as THREE.Vector3).copy(player.crystalPos);
  reveal.center.copy(player.crystalPos);
  (R.shared.uRevealCenter!.value as THREE.Vector3).copy(player.crystalPos);
  R.shared.uRevealRadius!.value = reveal.radius;
  R.shared.uRevealOn!.value = revealOn ? 1 : 0;
  const arr = R.shared.uSources!.value as THREE.Vector3[];
  let n = 0;
  for (const v of sources.values()) {
    if (n >= MAX_SOURCES) break;
    arr[n++]!.set(v[0], v[1], v[2]);
  }
  R.shared.uSourceCount!.value = n;
  ctx.time.simTime += dt;
  R.shared.uTime!.value = ctx.time.simTime;
  level.update(dt);
}

function updateCamera(dt: number): void {
  const cam = R.camera;
  const portrait = innerHeight > innerWidth;
  const P = player.position;
  if (camMode === 'game') {
    const C = TUNING.camera;
    cam.fov = portrait ? C.fovPortrait : C.fovLandscape;
    camTgt.set(P.x + player.facing.x * C.lookAhead, P.y + 0.9, P.z + player.facing.z * C.lookAhead);
    const want = new THREE.Vector3(camTgt.x, camTgt.y + C.height, camTgt.z + C.distance);
    if (snapCam) camPos.copy(want);
    else camPos.lerp(want, 1 - Math.exp(-C.spring * dt));
    cam.position.copy(camPos);
    cam.lookAt(camTgt);
  } else if (camMode === 'over') {
    cam.fov = portrait ? 50 : 36;
    camTgt.set(P.x, P.y, P.z - 4);
    camPos.set(P.x + 7, P.y + 21, P.z + 13);
    cam.position.copy(camPos);
    cam.lookAt(camTgt);
  } else {
    cam.fov = portrait ? 58 : 40;
    const path = level!.built.data.path;
    path.at(Math.max(0, s - 6), look);
    const want = new THREE.Vector3(look.px - look.tz * 1.8, P.y + 2.4, look.pz + look.tx * 1.8);
    want.y = Math.max(want.y, level!.built.collision.groundHeight(want.x, want.z) + 1.6);
    path.at(Math.min(path.length, s + 5), look);
    const tgt = new THREE.Vector3(
      look.px,
      level!.built.collision.groundHeight(look.px, look.pz) + 1.3,
      look.pz,
    );
    if (snapCam) {
      camPos.copy(want);
      camTgt.copy(tgt);
    } else {
      camPos.lerp(want, 1 - Math.exp(-2.5 * dt));
      camTgt.lerp(tgt, 1 - Math.exp(-3 * dt));
    }
    cam.position.copy(camPos);
    cam.lookAt(camTgt);
  }
  snapCam = false;
  cam.updateProjectionMatrix();
}

// ───────────── debug map ─────────────
function mapScale(w: number, h: number) {
  const hf = level!.built.data.height;
  const sx = w / (hf.maxX - hf.x0);
  const sz = h / (hf.maxZ - hf.z0);
  const k = Math.min(sx, sz);
  const ox = (w - (hf.maxX - hf.x0) * k) / 2;
  const oz = (h - (hf.maxZ - hf.z0) * k) / 2;
  return { k, X: (x: number) => ox + (x - hf.x0) * k, Z: (z: number) => oz + (z - hf.z0) * k };
}

function buildStaticMap(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const { k, X, Z } = mapScale(w, h);
  const data = level!.built.data;
  const hf = data.height;
  const col = data.collision;
  const st = Math.max(0.35, 1.2 / k);
  for (let z = hf.z0; z < hf.maxZ; z += st)
    for (let x = hf.x0; x < hf.maxX; x += st) {
      const wk = col.walkable(x, z);
      const hh = hf.sample(x, z);
      if (wk) g.fillStyle = PAL.teal[2];
      else g.fillStyle = hh > 1.5 ? '#232b29' : hh < -1 ? '#06100f' : '#151b1a';
      g.fillRect(X(x), Z(z), st * k + 0.6, st * k + 0.6);
    }
  for (const v of def.voids ?? []) {
    g.strokeStyle = v.kind === 'chasm' ? PAL.glowEdge : v.kind === 'cliff' ? PAL.staff[3] : PAL.red[2];
    g.setLineDash([3, 2]);
    g.strokeRect(X(v.rect[0]), Z(v.rect[1]), (v.rect[2] - v.rect[0]) * k, (v.rect[3] - v.rect[1]) * k);
  }
  g.setLineDash([]);
  g.strokeStyle = PAL.teal[3];
  g.beginPath();
  for (let i = 0; i < data.path.count; i += 2) {
    const fn = i ? 'lineTo' : 'moveTo';
    g[fn](X(data.path.xs[i]!), Z(data.path.zs[i]!));
  }
  g.stroke();
  for (const t of data.layout.trees) {
    g.fillStyle = t.stump ? PAL.staff[2] : PAL.teal[1];
    g.beginPath();
    g.arc(X(t.x), Z(t.z), Math.max(1, t.r * k), 0, 7);
    g.fill();
  }
  for (const b of data.layout.blockers) {
    g.strokeStyle = 'rgba(239,225,201,.25)';
    g.beginPath();
    g.arc(X(b.x), Z(b.z), Math.max(1, b.r * k), 0, 7);
    g.stroke();
  }
  const full = mapMode === 'full';
  g.font = `${full ? 11 : 8}px ui-monospace, monospace`;
  for (const t of def.triggers) {
    const ty = t.action?.type ?? 'event';
    g.strokeStyle =
      ty === 'spawn'
        ? PAL.red[3]
        : ty === 'checkpoint'
          ? PAL.glowCore
          : ty === 'tutorial'
            ? PAL.ghost[2]
            : ty === 'pageEnd'
              ? '#ffffff'
              : PAL.smoke;
    g.strokeRect(X(t.rect[0]), Z(t.rect[1]), (t.rect[2] - t.rect[0]) * k, (t.rect[3] - t.rect[1]) * k);
    if (full) {
      g.fillStyle = g.strokeStyle;
      g.fillText(t.id, X(t.rect[2]) + 2, Z(t.rect[1]) + 9);
    }
  }
  for (const sk of def.sketches) {
    const printed = level!.sketches.isPrinted(sk.id);
    g.strokeStyle = printed ? PAL.glowCore : PAL.glowEdge;
    g.lineWidth = 2;
    if (sk.unlocks)
      g.strokeRect(
        X(sk.unlocks[0]),
        Z(sk.unlocks[1]),
        (sk.unlocks[2] - sk.unlocks[0]) * k,
        (sk.unlocks[3] - sk.unlocks[1]) * k,
      );
    g.setLineDash([2, 3]);
    g.beginPath();
    g.arc(X(sk.at[0]), Z(sk.at[2]), TUNING.sketch.requiredRadius * k, 0, 7);
    g.stroke();
    g.setLineDash([]);
    g.lineWidth = 1;
    if (full) {
      g.fillStyle = PAL.glowEdge;
      g.fillText(`${sk.id}${printed ? ' ✓' : ''}`, X(sk.at[0]) + 4, Z(sk.at[2]) - 4);
    }
  }
  for (const w2 of def.inkWells) {
    g.fillStyle = PAL.glowCore;
    g.beginPath();
    g.arc(X(w2[0]), Z(w2[1]), 3, 0, 7);
    g.fill();
  }
  for (const sp of def.spawns) {
    g.fillStyle = sp.kind === 'blot' ? PAL.ink : PAL.ghost[3];
    g.strokeStyle = PAL.red[2];
    const px = X(sp.at[0]);
    const pz = Z(sp.at[1]);
    g.beginPath();
    if (sp.kind === 'scribbler') g.rect(px - 3, pz - 3, 6, 6);
    else g.arc(px, pz, 3, 0, 7);
    g.fill();
    g.stroke();
  }
  for (const c of def.checkpoints) {
    g.fillStyle = PAL.glowCore;
    g.fillRect(X(c.at[0]) - 1, Z(c.at[2]) - 8, 2, 8);
    g.fillRect(X(c.at[0]), Z(c.at[2]) - 8, 6, 4);
  }
  return c;
}

function drawMap(): void {
  if (mapMode === '0' || !level) {
    mapEl.style.display = 'none';
    return;
  }
  mapEl.style.display = 'block';
  const full = mapMode === 'full';
  mapEl.className = full ? 'full' : '';
  const dpr = Math.min(2, devicePixelRatio);
  const hf = level.built.data.height;
  const aspect = (hf.maxX - hf.x0) / (hf.maxZ - hf.z0);
  const cssH = full ? innerHeight : Math.min(innerHeight * 0.42, 300);
  const cssW = full ? innerWidth : cssH * aspect;
  const W = Math.round(cssW * dpr);
  const H = Math.round(cssH * dpr);
  if (mapEl.width !== W || mapEl.height !== H) {
    mapEl.width = W;
    mapEl.height = H;
    mapEl.style.width = `${cssW}px`;
    mapEl.style.height = `${cssH}px`;
    staticMap = null;
  }
  if (!staticMap) staticMap = buildStaticMap(W, H);
  const g = mapEl.getContext('2d')!;
  g.drawImage(staticMap, 0, 0);
  const { k, X, Z } = mapScale(W, H);
  g.strokeStyle = PAL.glowCore;
  g.beginPath();
  g.arc(X(player.position.x), Z(player.position.z), reveal.radius * k, 0, 7);
  g.stroke();
  g.fillStyle = PAL.red[3];
  g.beginPath();
  g.arc(X(player.position.x), Z(player.position.z), 4, 0, 7);
  g.fill();
}

function renderBar(): void {
  bar.innerHTML = '';
  for (const k of ['1', '2', '3', 'boss']) {
    const b = document.createElement('button');
    b.textContent = k === 'boss' ? 'B' : k;
    if (k === pageKey) b.className = 'on';
    b.onclick = () => {
      q.set('t', '0');
      loadPage(k);
    };
    bar.append(b);
  }
  const cb = document.createElement('button');
  cb.textContent = camMode;
  cb.onclick = () => {
    camMode = camMode === 'game' ? 'fly' : camMode === 'fly' ? 'over' : 'game';
    snapCam = true;
    renderBar();
  };
  const mb = document.createElement('button');
  mb.textContent = `map:${mapMode}`;
  mb.onclick = () => {
    mapMode = mapMode === '0' ? '1' : mapMode === '1' ? 'full' : '0';
    staticMap = null;
    renderBar();
  };
  bar.append(cb, mb);
}

addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key >= '1' && e.key <= '4') loadPage(['1', '2', '3', 'boss'][Number(e.key) - 1]!);
  else if (e.key === 'c') camMode = camMode === 'game' ? 'fly' : camMode === 'fly' ? 'over' : 'game';
  else if (e.key === 'm') {
    mapMode = mapMode === '0' ? '1' : mapMode === '1' ? 'full' : '0';
    staticMap = null;
  } else if (e.key === 'r') revealOn = !revealOn;
  else if (e.key === ' ') paused = !paused;
  else if (e.key === 'ArrowRight') s += 5;
  else if (e.key === 'ArrowLeft') s = Math.max(0, s - 5);
  else if (e.key === 'p') {
    const st = nextStop();
    if (st) level?.sketches.printNow(st.id);
  }
  renderBar();
});
addEventListener('resize', () => {
  R.resize();
  level?.resize();
  staticMap = null;
});

loadPage(LEVELS[pageKey] ? pageKey : '1');
(window as unknown as { __lv: unknown }).__lv = { R, level: () => level, THREE };
let last = performance.now();
let fpsAcc = 0;
let fpsN = 0;
let fps = 0;
const frame = (now: number) => {
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;
  step(dt);
  updateCamera(dt);
  R.render(PAL.void);
  drawMap();
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }
  const st = R.stats as typeof R.stats & { colorCalls?: number };
  const sk = def.sketches
    .map((k) => `${k.id} ${(level!.sketches.progress(k.id) * 100).toFixed(0)}%`)
    .join('  ');
  hud.textContent = `page ${pageKey} · ${camMode} · s ${s.toFixed(0)}/${level!.built.data.path.length.toFixed(0)} m
draws ${st.colorCalls} (+outline ${st.drawCalls - (st.colorCalls ?? 0)}) · tris ${(st.triangles / 1000).toFixed(0)}k · ${fps.toFixed(0)} fps
ink ${player.energy.toFixed(0)} · r ${reveal.radius.toFixed(1)} · ${sk}
${log.join('\n')}`;
  (window as unknown as { __levels: unknown }).__levels = { s, page: pageKey, stats: st, ready: true };
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
