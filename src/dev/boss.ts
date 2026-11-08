/**
 * DEV HARNESS — THE EDITOR boss fight, fully playable with stub player / reveal / ghosts / audio.
 * /dev/boss.html   ?autoplay=1 (bot plays)  ?phase=1|2|3 (jump)  ?ff=N (fast-forward N s)
 *                  ?difficulty=story  ?shot=1 (hide debug UI)  ?god=1
 * Desktop: WASD move · Shift / right mouse hold = crystal · left click / J = bolt · Space = dash.
 * Touch: left half joystick · right half tap = bolt, hold = crystal, swipe = dash.
 */
import * as THREE from 'three';
import { EventBus, type GameEvents } from '../core/events';
import { FixedLoop } from '../core/loop';
import { DEFAULT_SETTINGS, type GameContext, type InputState, type RunStats } from '../core/types';
import { TUNING } from '../data/tuning';
import { install } from '../entities/Editor';
import { CORE_INDEX } from '../entities/Editor/fsm';
import { StubAudio } from './boss/audio';
import { StubGhosts } from './boss/ghosts';
import { StubInput, StubPlayer } from './boss/player';
import { StubRender } from './boss/render';
import { StubReveal } from './boss/reveal';
import { buildArena, StubCollision, StubTargets } from './boss/world';

THREE.ColorManagement.enabled = false;
const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('gl');
const events = new EventBus<GameEvents>();
const reveal = new StubReveal();
const render = new StubRender(canvas, reveal);
const audio = new StubAudio();
const input = new StubInput(canvas);
const settings = { ...DEFAULT_SETTINGS };
if (q.get('difficulty') === 'story') settings.difficulty = 'story';
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

const ctx: GameContext = {
  events,
  tuning: TUNING,
  settings,
  render,
  reveal,
  input,
  audio,
  collision: new StubCollision(),
  targets: new StubTargets(),
  player: null,
  stats,
  time: { scale: 1, simTime: 0 },
  t: (k) => k,
};

render.scene.add(buildArena(render));
const player = new StubPlayer(ctx, render);
ctx.player = player;
player.god = q.get('god') === '1';
render.scene.add(player.object);
const ghosts = new StubGhosts(ctx, render);
const editor = install(ctx, { loadAssets: q.get('glb') === '1' });

// POC convention: fx without depth-normal edges on layer 1
editor.particles.mesh.layers.set(1);
editor.cover.mesh.layers.set(1);
editor.telegraphs.group.traverse((o) => o.layers.set(1));

// ───────────── camera ─────────────
const cam = render.camera;
const camPos = new THREE.Vector3(0, 8, 18);
const camLook = new THREE.Vector3(0, 2, 0);
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const closeCam = q.get('cam');
function updateCamera(dt: number): void {
  if (closeCam) {
    // inspection cameras: ?cam=close | side | low
    const [bx, bz] = TUNING.boss.pos;
    if (closeCam === 'side') cam.position.set(bx + 9, 4.5, bz + 6);
    else if (closeCam === 'low') cam.position.set(bx + 1.5, 1.2, bz + 7);
    else cam.position.set(bx, 4.6, bz + 10);
    cam.lookAt(bx, closeCam === 'low' ? 4 : 3.8, bz);
    return;
  }
  const p = player.position;
  const land = innerWidth > innerHeight;
  const w = 0.3 + editor.cameraWeight * 0.4;
  _look.set(p.x, 1.2, p.z).lerp(editor.focus, w);
  _desired.set(p.x * 0.6, land ? 9.5 : 7.2, p.z + (land ? 14.5 : 11.5));
  const k = 1 - Math.exp(-TUNING.camera.spring * dt);
  camPos.lerp(_desired, k);
  camLook.lerp(_look, k);
  cam.position.copy(camPos);
  cam.lookAt(camLook);
}
render.resize();

// ───────────── fx stand-ins: panel cut, shake, hitstop ─────────────
const WORDS: Record<string, string> = {
  roar: 'GRAAAH!',
  scrub: 'SKRRRUB!',
  skritch: 'SKRITCH!',
  fwoosh: 'FWOOSH!',
  krak: 'KRAK!',
};
let freeze = 0;
let ffing = false;
const panel = $('panel');
events.on('fx:panelCut', (e) => {
  const big = e.reason.startsWith('boss:');
  freeze = Math.max(freeze, TUNING.panelCut.duration * (big ? 1.5 : 1));
  $('panel-word').textContent = WORDS[e.word] ?? `${e.word.toUpperCase()}!`;
  panel.classList.remove('on');
  void panel.offsetWidth;
  panel.classList.add('on');
  setTimeout(() => panel.classList.remove('on'), freeze * 1000 + 450);
  if (ffing) freeze = 0;
});
events.on('fx:hitstop', (e) => {
  freeze = Math.max(freeze, e.duration);
});
events.on('fx:shake', (e) => {
  render.shake = Math.max(render.shake * (render.shakeT > 0 ? 1 : 0), e.intensity);
  render.shakeT = Math.max(render.shakeT, e.duration);
});
events.on('music:intensity', (e) => audio.setIntensity(e.layer, e.level));

// ───────────── HUD ─────────────
const hud = {
  pages: $('pages'),
  energy: $('energy-fill'),
  bossBar: $('boss-fill'),
  bossWrap: $('boss'),
  phase: $('boss-phase'),
  hint: $('hint'),
  dbg: $('dbg-info'),
};
for (let i = 0; i < TUNING.player.maxPages; i++) hud.pages.appendChild(document.createElement('i'));
const HINTS: Record<string, string> = {
  dormant: 'The Editor waits. Press START (or step into the arena).',
  intro: 'THE EDITOR wakes…',
  p1: 'ERASE — dodge the pencil lanes. Shoot the ink blots on its arms while they’re pinned.',
  p2: 'REDRAW — hold the crystal (7 m) on the sketched knot to PRINT it, then shoot it.',
  p3: 'BLANK PAGE — only your light remains. Dash through sweeps; when it bows, light its heart and shoot.',
  dying: 'KRAK!',
  dead: 'Page inked. (Cover screen goes here.)',
};
let lastHint = '';
function updateHud(): void {
  const f = editor.fsm;
  const pages = hud.pages.children;
  for (let i = 0; i < pages.length; i++) pages[i]!.classList.toggle('torn', i >= player.pages);
  hud.energy.style.transform = `scaleX(${player.energy / TUNING.energy.max})`;
  hud.bossWrap.classList.toggle('on', f.state !== 'dormant' && f.state !== 'dead');
  hud.bossBar.style.transform = `scaleX(${f.health})`;
  const key = f.state === 'phase' || f.state === 'transition' ? `p${f.phase}` : (f.state as string);
  hud.phase.textContent =
    f.state === 'phase' || f.state === 'transition'
      ? ['', 'I · ERASE', 'II · REDRAW', 'III · BLANK PAGE'][f.phase]!
      : f.state === 'intro'
        ? '…'
        : '';
  if (key !== lastHint) {
    lastHint = key;
    hud.hint.textContent = HINTS[key] ?? '';
    hud.hint.classList.remove('pop');
    void hud.hint.offsetWidth;
    hud.hint.classList.add('pop');
  }
  hud.dbg.textContent = `${f.state} p${f.phase} t=${f.fightTime.toFixed(1)}s · ghosts ${ghosts.count} · calls ${render.stats.drawCalls} · tris ${(render.stats.triangles / 1000).toFixed(1)}k`;
}

// ───────────── autoplay bot (for screenshots / soak) ─────────────
let botFire = 0;
const _bv = new THREE.Vector3();
function bot(s: InputState): void {
  const f = editor.fsm;
  const p = player.position;
  const [bx, bz] = TUNING.boss.pos;
  const goal = _bv.set(p.x, 0, p.z);
  let held = false;
  if (f.state === 'phase' && f.phase === 2 && f.p2Active >= 0) {
    const w = f.wps[f.p2Active]!;
    goal.set(w.x + 1.2, 0, w.z + 4.2);
    held = !w.printed && w.drawIn >= 1 && Math.hypot(p.x - w.x, p.z - w.z) < 6.2;
  } else if (f.state === 'phase' && f.phase === 3) {
    const c = f.wps[CORE_INDEX]!;
    if (f.bowAmt > 0.2) goal.set(c.x + 0.6, 0, c.z + 2.4);
    else goal.set(Math.sin(f.fightTime * 0.4) * 5, 0, bz + 9);
    held = f.bowAmt > 0.2;
  } else {
    goal.set(Math.sin(f.fightTime * 0.35) * 6, 0, bz + 10.5);
  }
  // dodge
  let dodgeX = 0;
  let dodgeZ = 0;
  for (const a of f.attacks) {
    if (!a.active || a.stage === 'recover') continue;
    const dx = a.bx - a.ax;
    const dz = a.bz - a.az;
    const l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l;
    const nz = dx / l;
    const side = (p.x - a.ax) * nx + (p.z - a.az) * nz;
    const along = ((p.x - a.ax) * dx + (p.z - a.az) * dz) / (l * l);
    const r = a.kind === 'drag' ? a.hw + 1.2 : a.hw + 1.4;
    const dist = a.kind === 'drag' ? Math.abs(side) : Math.hypot(p.x - a.ax, p.z - a.az);
    if (dist < r && (a.kind !== 'drag' || (along > -0.1 && along < 1.1))) {
      if (a.kind === 'drag') {
        const sg = side >= 0 ? 1 : -1;
        dodgeX += nx * sg * 3;
        dodgeZ += nz * sg * 3;
      } else {
        dodgeX += (p.x - a.ax) * 3;
        dodgeZ += (p.z - a.az) * 3;
      }
      if (a.stage === 'strike' || a.p > 0.75) s.dashPressed = true;
    }
  }
  let mx = goal.x - p.x + dodgeX;
  let mz = goal.z - p.z + dodgeZ;
  const l = Math.hypot(mx, mz);
  if (l < 0.4 && dodgeX === 0 && dodgeZ === 0) {
    mx = 0;
    mz = 0;
  } else {
    mx /= l;
    mz /= l;
  }
  s.move.set(mx, -mz);
  if (s.dashPressed) s.dashDir.set(mx, -mz);
  s.crystalHeld = held;
  botFire -= 1 / 60;
  if (botFire <= 0 && ctx.targets.nearest(player.crystalPos, TUNING.bolt.maxRange)) {
    s.boltPressed = true;
    botFire = 0.22;
  }
  if (player.energy < 30) player.addEnergy(0.5);
  void bx;
}
if (q.get('autoplay') === '1') input.autoplay = bot;

// ───────────── loop ─────────────
const loop = new FixedLoop(
  {
    step(dt) {
      if (freeze > 0) {
        freeze -= dt;
        return;
      }
      ctx.time.simTime += dt;
      input.poll();
      player.step(dt, input.state, cam);
      editor.step(dt);
      ghosts.step(dt);
      reveal.update(dt);
      // auto-start when the player walks toward the Editor
      if (editor.fsm.state === 'dormant' && player.position.z < TUNING.boss.arena[1] + 1.5) startFight();
    },
    render(_a, frameDt) {
      editor.frame(frameDt);
      updateCamera(Math.min(frameDt, 0.05));
      render.render(frameDt);
      updateHud();
    },
  },
  TUNING.sim.hz,
  TUNING.sim.maxStepsPerFrame,
);

function startFight(): void {
  reveal.reset();
  ghosts.clear();
  editor.start();
}

// ───────────── debug buttons ─────────────
const btn = (id: string, fn: () => void) =>
  $(id).addEventListener('click', (e) => {
    e.stopPropagation();
    void audio.unlock().then(fn);
  });
btn('b-start', startFight);
btn('b-p1', () => editor.jumpTo(1));
btn('b-p2', () => editor.jumpTo(2));
btn('b-p3', () => editor.jumpTo(3));
btn('b-kill', () => editor.kill());
btn('b-reset', () => {
  reveal.reset();
  ghosts.clear();
  editor.fsm.reset();
  player.teleport(0, 0, 6.5);
});
btn('b-diff', () => {
  settings.difficulty = settings.difficulty === 'story' ? 'normal' : 'story';
  events.emit('settings:changed', { key: 'difficulty' });
  $('b-diff').textContent = settings.difficulty.toUpperCase();
});
btn('b-god', () => {
  player.god = !player.god;
  $('b-god').classList.toggle('on', player.god);
});
btn('b-bot', () => {
  input.autoplay = input.autoplay ? null : bot;
  $('b-bot').classList.toggle('on', !!input.autoplay);
});
$('b-diff').textContent = settings.difficulty.toUpperCase();
$('b-god').classList.toggle('on', player.god);
$('b-bot').classList.toggle('on', !!input.autoplay);
for (const ev of ['pointerdown', 'keydown'] as const)
  addEventListener(
    ev,
    () => void audio.unlock().then(() => audio.setMusic(editor.fsm.state === 'dormant' ? null : 'boss')),
    { once: true },
  );
if (q.get('shot') === '1') document.body.classList.add('shot');
events.on('boss:death', (e) => {
  if (e.stage === 'black') $('fin').classList.add('on');
});
events.on('boss:phase', () => $('fin').classList.remove('on'));

// URL jumps + fast-forward (deterministic sim steps, for screenshots)
const jp = Number(q.get('phase'));
if (jp === 1 || jp === 2 || jp === 3) editor.jumpTo(jp);
else if (q.get('autoplay') === '1') startFight();
const ff = Number(q.get('ff') ?? 0);
if (ff > 0) {
  ffing = true;
  const dt = 1 / TUNING.sim.hz;
  for (let i = 0; i < ff * TUNING.sim.hz; i++) {
    if (freeze > 0) freeze -= dt;
    input.poll();
    player.step(dt, input.state, cam);
    editor.step(dt);
    ghosts.step(dt);
    reveal.update(dt);
    updateCamera(dt);
  }
  freeze = 0;
  panel.classList.remove('on');
  ffing = false;
}
loop.start();
document.documentElement.dataset.ready = '1';
(window as unknown as { __boss: unknown }).__boss = { editor, player, ctx, loop };
