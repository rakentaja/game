/**
 * Player workstream harness — /dev/player.html
 * Test arena (flat ground, boxes, POC trunks), the wizard, practice dummies, pickups, and an
 * on-screen gesture debug readout. Query: ?autoplay=1 ?aggro=1 ?lefty=1 ?debug=1 ?nohud=1
 */
import * as THREE from 'three';
import { events } from '../core/events';
import { haptics } from '../core/input/haptics';
import { Input } from '../core/input/Input';
import { FixedLoop } from '../core/loop';
import { DEFAULT_SETTINGS, type RenderAPI, type RunStats, type Settings } from '../core/types';
import { PAL } from '../data/palette';
import { TUNING } from '../data/tuning';
import { AutoplayBot } from '../debug/autoplay';
import { loadWizard, Player } from '../entities/Player';
import { Combat } from '../systems/combat';
import { InkEnergy, InkPickups } from '../systems/ink-energy';
import { CameraRig } from '../world/camera';
import {
  BoxWorld,
  createInkMaterial,
  Dummy,
  StubPost,
  StubReveal,
  StubTargets,
  shared,
  trunk,
} from './player-stubs';

THREE.ColorManagement.enabled = false;
const q = new URLSearchParams(location.search);

// ───────── renderer ─────────
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, TUNING.quality.maxPixelRatio));
renderer.setSize(innerWidth, innerHeight, false);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(TUNING.camera.fovPortrait, innerWidth / innerHeight, 0.1, 80);
const post = new StubPost(renderer, scene, camera);

const settings: Settings = { ...DEFAULT_SETTINGS, leftHanded: q.get('lefty') === '1' };
haptics.settings = settings;
const stats: RunStats = {
  timeS: 0,
  ghostsInked: 0,
  inkCollected: 0,
  pagesTorn: 0,
  deaths: 0,
  boltsFired: 0,
  boltsHit: 0,
  bestPanel: null,
};
const reveal = new StubReveal();
const mat = (o: Parameters<typeof createInkMaterial>[0]) => createInkMaterial(o, reveal);
const renderStub: Pick<RenderAPI, 'createInkMaterial' | 'addOutline'> = {
  createInkMaterial: mat,
  addOutline: () => () => {},
};

// ───────── arena ─────────
const HALF = 17;
const boxes = [
  { minX: -6.5, minZ: -8, maxX: -4.5, maxZ: -6 },
  { minX: 3.5, minZ: -4.5, maxX: 6.5, maxZ: -3.5 },
  { minX: -2, minZ: -15, maxX: 2, maxZ: -14 },
  { minX: 7, minZ: 4, maxX: 8.5, maxZ: 7.5 },
  { minX: -10, minZ: 1, maxX: -8.5, maxZ: 2.5 },
];
const trees: [number, number, number][] = [];
let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(HALF * 2 + 60, HALF * 2 + 60).rotateX(-Math.PI / 2),
  mat({ ramp: 'teal', ground: true, keyAmt: 0.7, glowAmt: 0.9 }),
);
scene.add(ground);
const stoneMat = mat({ ramp: 'staff', keyAmt: 0.85, glowAmt: 0.9 });
const tealMat = mat({ ramp: 'teal', keyAmt: 0.75, glowAmt: 0.5 });
for (const [i, b] of boxes.entries()) {
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const h = 0.8 + (i % 3) * 0.5;
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), i % 2 ? stoneMat : tealMat);
  m.position.set((b.minX + b.maxX) / 2, h / 2, (b.minZ + b.maxZ) / 2);
  scene.add(m);
}
const treeMat = mat({ ramp: 'teal', keyAmt: 0.75, glowAmt: 0.35 });
for (let i = 0; i < 26; i++) {
  const a = (i / 26) * Math.PI * 2 + rnd() * 0.2;
  const r = HALF - 0.5 + rnd() * 3;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  scene.add(trunk(new THREE.Vector3(x, 0, z), 5 + rnd() * 2, 0.18 + rnd() * 0.14, rnd() * 6, treeMat, rnd));
}
for (const [x, z] of [
  [-3, -2],
  [5, 2],
  [-6, 7],
  [10, -8],
]) {
  scene.add(trunk(new THREE.Vector3(x!, 0, z!), 5 + rnd() * 2, 0.22, rnd() * 6, treeMat, rnd));
  trees.push([x!, z!, 0.35]);
}
for (let i = 0; i < 14; i++) {
  const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.12 + rnd() * 0.2, 0), treeMat);
  r.position.set((rnd() - 0.5) * 24, 0.02, (rnd() - 0.5) * 24);
  r.scale.y = 0.5;
  r.rotation.set(rnd(), rnd(), rnd());
  scene.add(r);
}
const world = new BoxWorld(boxes, trees, HALF);
const targets = new StubTargets();

// ───────── player stack ─────────
const input = new Input({
  element: canvas,
  overlay: document.getElementById('app'),
  leftHanded: settings.leftHanded,
});
const rig = new CameraRig(camera, TUNING, events);
const energy = new InkEnergy(events, TUNING);
const player = new Player(
  {
    events,
    tuning: TUNING,
    settings,
    input,
    collision: world,
    reveal,
    render: renderStub,
    stats,
    view: rig,
  },
  energy,
);
scene.add(player.object);
player.teleport(0, 0, 2, Math.PI);
const combat = new Combat(
  { events, tuning: TUNING, settings, input, targets, collision: world, stats, seed: 7 },
  player,
  energy,
);
scene.add(combat.object);
const pickups = new InkPickups({ events, tuning: TUNING, stats });
scene.add(pickups.mesh);

const dummies: Dummy[] = [];
for (const [x, z] of [
  [0, -4],
  [-3, -7],
  [4, -8],
  [-8, -3],
  [8, -1],
  [2, -12],
]) {
  const d = new Dummy(x!, z!, reveal, events, reveal);
  d.aggressive = q.get('aggro') === '1' && dummies.length < 2;
  dummies.push(d);
  targets.add(d);
  scene.add(d.mesh);
}

let bot: AutoplayBot | null = null;
if (q.get('autoplay') === '1') {
  bot = new AutoplayBot(
    {
      input,
      events,
      tuning: TUNING,
      targets,
      getPlayer: () => player,
      view: rig,
    },
    {
      path: [
        [0, 2],
        [0, -6],
        [-7, -10],
        [-12, -2],
        [-6, 9],
        [5, 10],
        [12, 0],
        [9, -10],
        [2, -13],
      ],
      sketches: [{ id: 'bridge', at: [-12, 0, -2] }],
    },
  ).attach();
  bot.loop = true;
  // pretend the sketch prints after 2 s of a full-radius hold (sketch system stub)
  let printT = 0;
  events.on('crystal:hold', () => {});
  setInterval(() => {
    const d = Math.hypot(player.position.x + 12, player.position.z + 2);
    if (player.crystalHeld && reveal.radius > TUNING.sketch.requiredRadius - 0.3 && d < 7) printT += 0.1;
    if (printT >= TUNING.sketch.holdToPrint) {
      printT = -1e9;
      events.emit('sketch:printed', { id: 'bridge' });
    }
  }, 100);
}

// ───────── hit-stop / panel-cut stubs (render owns the real ones) ─────────
let freeze = 0;
events.on('fx:hitstop', ({ duration }) => {
  freeze = Math.max(freeze, duration);
});
const word = document.createElement('div');
word.className = 'pw-word';
document.getElementById('ui-root')!.appendChild(word);
events.on('fx:panelCut', (e) => {
  freeze = Math.max(freeze, TUNING.panelCut.duration);
  word.textContent = `${e.word.toUpperCase()}!`;
  word.classList.remove('go');
  void word.offsetWidth;
  word.classList.add('go');
});
events.on('player:died', () => {
  setTimeout(() => {
    player.teleport(0, 0, 2, Math.PI);
    events.emit('player:respawn', { checkpointId: 'arena' });
    rig.snap(player.position);
  }, 900);
});

// ───────── HUD + gesture debug ─────────
const hud = document.createElement('div');
hud.className = 'pw-hud';
hud.innerHTML = `
  <div class="pw-pages"></div>
  <div class="pw-ink"><div class="pw-ink-fill"></div></div>
  <div class="pw-dash"></div>
  <pre class="pw-log"></pre>
  <div class="pw-btns">
    <button data-k="aggro">aggro</button><button data-k="lefty">lefty</button><button data-k="god">god</button><button data-k="ink">+ink</button><button data-k="dev">dbg</button>
  </div>`;
document.getElementById('ui-root')!.appendChild(hud);
const style = document.createElement('style');
style.textContent = `
.pw-hud{position:absolute;inset:0;pointer-events:none!important;font:600 11px/1.25 ui-monospace,Menlo,monospace;color:${PAL.paper}}
.pw-pages{position:absolute;left:calc(14px + var(--sal));top:calc(12px + var(--sat));display:flex;gap:5px}
.pw-pages i{width:16px;height:21px;background:${PAL.paper};border:2px solid ${PAL.ink};box-shadow:2px 2px 0 ${PAL.ink};transform:rotate(-4deg);clip-path:polygon(0 0,100% 0,100% 78%,74% 100%,0 100%)}
.pw-pages i.torn{background:${PAL.red[1]};opacity:.55;transform:rotate(8deg) translateY(3px)}
.pw-ink{position:absolute;left:calc(14px + var(--sal));top:calc(44px + var(--sat));width:120px;height:12px;border:2px solid ${PAL.ink};background:${PAL.staff[1]};box-shadow:2px 2px 0 ${PAL.ink};transform:skewX(-8deg)}
.pw-ink-fill{height:100%;background:${PAL.glowCore};transform-origin:0 50%}
.pw-ink.low .pw-ink-fill{background:${PAL.glowEdge}}
.pw-dash{position:absolute;left:calc(14px + var(--sal));top:calc(64px + var(--sat));width:60px;height:5px;background:${PAL.paper};border:1px solid ${PAL.ink};transform-origin:0 50%}
.pw-log{position:absolute;right:calc(10px + var(--sar));top:calc(10px + var(--sat));margin:0;padding:6px 8px;background:${PAL.ink}d0;border:1px solid ${PAL.red[1]};white-space:pre;min-width:150px;text-align:left}
.pw-btns{position:absolute;right:calc(10px + var(--sar));bottom:calc(10px + var(--sab));display:flex;gap:4px;pointer-events:auto}
.pw-btns button{font:inherit;background:${PAL.ink};color:${PAL.paper};border:1px solid ${PAL.red[1]};padding:5px 7px;border-radius:2px}
.pw-btns button.on{background:${PAL.red[1]}}
.pw-word{position:absolute;left:50%;top:34%;font:900 64px/1 Impact,'Arial Black',sans-serif;color:${PAL.glowCore};-webkit-text-stroke:3px ${PAL.ink};text-shadow:5px 5px 0 ${PAL.ink};opacity:0;transform:translate(-50%,-50%) rotate(-8deg);pointer-events:none!important;letter-spacing:.02em}
.pw-word.go{animation:pw-word .9s cubic-bezier(.2,1.6,.3,1) both}
@keyframes pw-word{0%{opacity:1;scale:.3}18%{opacity:1;scale:1.15}70%{opacity:1;scale:1}100%{opacity:0;scale:1.05}}
body.nohud .pw-log,body.nohud .pw-btns{display:none}
`;
document.head.appendChild(style);
if (q.get('nohud') === '1') document.body.classList.add('nohud');
const pagesEl = hud.querySelector('.pw-pages') as HTMLElement;
const inkEl = hud.querySelector('.pw-ink') as HTMLElement;
const inkFill = hud.querySelector('.pw-ink-fill') as HTMLElement;
const dashEl = hud.querySelector('.pw-dash') as HTMLElement;
const logEl = hud.querySelector('.pw-log') as HTMLElement;
for (let i = 0; i < TUNING.player.maxPages; i++) pagesEl.appendChild(document.createElement('i'));
const gestures: string[] = [];
input.onGesture = (k, info) => {
  if (k === 'cancel' && info.ms < 40) return;
  gestures.unshift(`${k.padEnd(9)} ${String(info.ms).padStart(4)}ms ${String(info.px).padStart(3)}px`);
  if (gestures.length > 6) gestures.length = 6;
};
let god = false;
for (const b of hud.querySelectorAll('button')) {
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', () => {
    const k = b.dataset.k;
    if (k === 'aggro') {
      const on = !dummies[0]!.aggressive;
      for (const [i, d] of dummies.entries()) d.aggressive = on && i < 3;
      b.classList.toggle('on', on);
    } else if (k === 'lefty') {
      settings.leftHanded = !settings.leftHanded;
      input.setLeftHanded(settings.leftHanded);
      b.classList.toggle('on', settings.leftHanded);
    } else if (k === 'god') {
      god = !god;
      player.godMode = god;
      b.classList.toggle('on', god);
    } else if (k === 'ink') {
      const a = Math.random() * Math.PI * 2;
      pickups.spawn(player.position.x + Math.cos(a) * 3, 0, player.position.z + Math.sin(a) * 3, 30);
    } else if (k === 'dev') {
      void import('../debug/debug').then((m) => m.initDebug());
    }
  });
}
if (q.get('debug') === '1') void import('../debug/debug').then((m) => m.initDebug());

let fpsAcc = 0;
let fpsN = 0;
let fps = 0;
let hudT = 0;
function updateHud(dt: number) {
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = Math.round(fpsN / fpsAcc);
    fpsAcc = 0;
    fpsN = 0;
  }
  hudT += dt;
  const pages = pagesEl.children;
  for (let i = 0; i < pages.length; i++) pages[i]!.classList.toggle('torn', i >= Math.ceil(player.pages));
  inkFill.style.transform = `scaleX(${energy.value / energy.max})`;
  inkEl.classList.toggle('low', energy.value < TUNING.crystal.lowEnergy);
  dashEl.style.transform = `scaleX(${1 - player.dashCooldown01})`;
  dashEl.style.opacity = player.dashCooldown01 > 0 ? '0.4' : '1';
  if (hudT > 0.1) {
    hudT = 0;
    const s = input.state;
    logEl.textContent =
      `fps ${fps}  ${s.device}${settings.leftHanded ? ' L' : ''}\n` +
      `anim ${player.anim}\n` +
      `move ${s.move.x.toFixed(2)},${s.move.y.toFixed(2)}  ${s.crystalHeld ? 'HOLD' : ''}\n` +
      `r ${reveal.radius.toFixed(1)}→${reveal.targetRadius.toFixed(1)}  ink ${energy.value.toFixed(0)}\n` +
      (bot ? `bot ${bot.mode}\n` : '') +
      '─ gestures ─\n' +
      gestures.join('\n');
  }
}

// ───────── wizard ─────────
loadWizard(undefined, async () => {
  const txt = await (await fetch(`${import.meta.env.BASE_URL}reference/poc/wizard-model.js`)).text();
  const b64 = txt.slice(txt.indexOf('"', txt.indexOf('export default')) + 1, txt.lastIndexOf('"'));
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
})
  .then((c) => {
    player.setModel(c.scene, c.animations);
    document.documentElement.dataset.ready = '1';
  })
  .catch((e) => console.error(e));

// ───────── loop ─────────
const loop = new FixedLoop(
  {
    step(dt) {
      input.poll();
      player.step(dt);
      combat.step(dt);
      pickups.step(dt, player, (n) => energy.add(n));
      for (const d of dummies) d.step(dt, player);
      reveal.update(dt);
      stats.timeS += dt;
    },
    render(alpha, frameDt) {
      shared.uTime.value += frameDt;
      // hit-stop: sim freezes, camera + post keep breathing
      if (freeze > 0) {
        freeze -= frameDt;
        loop.timeScale = freeze > 0 ? 0 : 1;
      }
      player.render(alpha, frameDt);
      rig.update(frameDt, player.renderPosition, player.velocity);
      player.faceCamera(camera);
      shared.uCrystalPos.value.copy(player.crystalPos);
      // fog relative to the boom so the focus is never dimmed (render owns the real fog)
      const boom = camera.position.distanceTo(rig.focus);
      shared.uFogNear.value = boom + 4;
      shared.uFogFar.value = boom + 22;
      combat.render(alpha);
      pickups.render(shared.uTime.value);
      for (const d of dummies) d.render();
      post.render();
      updateHud(frameDt);
    },
  },
  TUNING.sim.hz,
  TUNING.sim.maxStepsPerFrame,
);
rig.snap(player.position);
loop.start();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  post.resize();
});

// e2e / console handles
Object.assign(window as unknown as Record<string, unknown>, {
  __pw: { player, input, combat, energy, rig, reveal, dummies, loop, events, stats, pickups },
});
