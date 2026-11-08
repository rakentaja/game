/**
 * Enemies dev harness (/dev/enemies.html). Stub reveal + stub player (crystal follows the
 * pointer), real EnemySystem / EnemyRenderer / Spawner / Targets. Not shipped.
 *
 * URL: ?n=8 (mixed spawn at start) ?auto=1 (auto bolt) ?hold=1 ?god=1 ?seed=N ?still=1 (freeze player)
 */
import * as THREE from 'three';
import { EventBus, type GameEvents } from '../core/events';
import { FixedLoop } from '../core/loop';
import type { Damageable, DamageSource, EnemyKind, PlayerAPI, RevealAPI, RunStats } from '../core/types';
import { PAL } from '../data/palette';
import { TUNING } from '../data/tuning';
import { EnemyRenderer } from '../entities/enemies/EnemyRenderer';
import { EnemySystem } from '../entities/enemies/EnemySystem';
import { MASK_GLSL, NOISE_GLSL } from '../entities/enemies/glsl';
import { Spawner } from '../systems/spawner';
import { Targets } from '../systems/targets';

THREE.ColorManagement.enabled = false;
const q = new URLSearchParams(location.search);
const $ = (id: string) => document.getElementById(id)!;

// ───────────── stub reveal (CPU mirror of MASK_GLSL without the fbm wobble) ─────────────
class StubReveal implements RevealAPI {
  readonly center = new THREE.Vector3();
  radius = TUNING.crystal.radiusIdle;
  targetRadius = TUNING.crystal.radiusIdle;
  blankPage = 0;
  readonly uniforms = {};
  addSource(): number {
    return -1;
  }
  removeSource(): void {}
  eraseStrip(): void {}
  revealAt(x: number, z: number): number {
    const d = Math.hypot(x - this.center.x, z - this.center.z);
    const e = TUNING.crystal.edgeWidth;
    const t = Math.min(1, Math.max(0, (d - (this.radius - e * 0.5)) / e));
    return (1 - t * t * (3 - 2 * t)) * (1 - this.blankPage);
  }
  isRevealed(x: number, z: number): boolean {
    return this.revealAt(x, z) > 0.5;
  }
  update(dt: number): void {
    const c = TUNING.crystal;
    const rate = this.targetRadius > this.radius ? c.radiusHeld / c.growTime : c.radiusHeld / c.shrinkTime;
    const d = this.targetRadius - this.radius;
    this.radius += Math.sign(d) * Math.min(Math.abs(d), rate * dt);
  }
  reset(): void {}
}

// ───────────── stub player ─────────────
class StubPlayer implements PlayerAPI {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly facing = new THREE.Vector3(0, 0, 1);
  readonly crystalPos = new THREE.Vector3();
  pages = TUNING.player.maxPages;
  energy = 100;
  iFrames = 0;
  crystalHeld = false;
  god = q.get('god') === '1';
  readonly object = new THREE.Group();
  readonly goal = new THREE.Vector3();
  constructor(private ev: EventBus<GameEvents>) {}
  get invulnerable(): boolean {
    return this.god || this.iFrames > 0;
  }
  damage(amount: number, source: DamageSource): void {
    if (this.invulnerable) return;
    this.pages = Math.max(0, this.pages - amount);
    this.iFrames = TUNING.player.iFramesOnHit;
    this.ev.emit('player:damaged', { amount, source, pagesLeft: this.pages });
    if (this.pages === 0) this.pages = TUNING.player.maxPages; // harness: auto-refill
  }
  addEnergy(a: number): void {
    this.energy += a;
  }
  teleport(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
  }
  setControllable(): void {}
  playClip(): void {}
  step(dt: number): void {
    this.iFrames = Math.max(0, this.iFrames - dt);
    const dx = this.goal.x - this.position.x;
    const dz = this.goal.z - this.position.z;
    const d = Math.hypot(dx, dz);
    const sp = Math.min(TUNING.player.runSpeed, d * 6);
    const vx = d > 1e-3 ? (dx / d) * sp : 0;
    const vz = d > 1e-3 ? (dz / d) * sp : 0;
    const k = Math.min(1, dt * TUNING.player.accel * 0.5);
    this.velocity.x += (vx - this.velocity.x) * k;
    this.velocity.z += (vz - this.velocity.z) * k;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    if (Math.hypot(this.velocity.x, this.velocity.z) > 0.2)
      this.facing.set(this.velocity.x, 0, this.velocity.z).normalize();
    this.crystalPos.set(
      this.position.x + 0.25,
      1.95 + Math.sin(performance.now() / 400) * 0.04,
      this.position.z + 0.15,
    );
  }
}

// ───────────── scene ─────────────
const canvas = $('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, TUNING.quality.maxPixelRatio));
renderer.setSize(innerWidth, innerHeight, false);
renderer.setClearColor(PAL.paper, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(TUNING.camera.fovPortrait, innerWidth / innerHeight, 0.1, 80);

const events = new EventBus<GameEvents>();
const reveal = new StubReveal();
const player = new StubPlayer(events);
const targets = new Targets();
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
const aiOn = q.get('ai') !== '0';
if (q.get('clean') === '1') for (const id of ['hud', 'bar', 'hint']) $(id).style.display = 'none';
const system = new EnemySystem(
  { events, tuning: TUNING, reveal, targets, player: aiOn ? player : null, stats },
  Number(q.get('seed') ?? 7),
);
const enemyGfx = new EnemyRenderer(system, { crystalPos: () => player.crystalPos });
scene.add(enemyGfx.root);
const spawner = new Spawner(events, system);

// Ground + stage props share the enemies' mask so the harness reads like the game.
const stageUniforms = enemyGfx.uniforms;
const groundMat = new THREE.ShaderMaterial({
  uniforms: {
    ...stageUniforms,
    uTeal0: { value: new THREE.Color(PAL.teal[0]) },
    uTeal1: { value: new THREE.Color(PAL.teal[1]) },
    uTeal2: { value: new THREE.Color(PAL.teal[2]) },
    uTeal3: { value: new THREE.Color(PAL.teal[3]) },
    uPaper: { value: new THREE.Color(PAL.paper) },
    uGround: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vW; varying vec3 vN;
    void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix)*normal);
      gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: /* glsl */ `
    ${NOISE_GLSL}
    ${MASK_GLSL}
    uniform vec3 uTeal0, uTeal1, uTeal2, uTeal3, uPaper, uRamp0, uRamp1, uCrystalPos, uKeyDir;
    uniform float uGround, uTime;
    varying vec3 vW; varying vec3 vN;
    void main(){
      float m = inkMask(vW.xz);
      vec3 N = normalize(vN);
      if (m < 0.5){
        // blank page with faint pencil construction lines + brush rim near the edge
        vec3 c = uPaper;
        float rim = smoothstep(0.18, 0.5, m);
        float hatch = abs(fract((gl_FragCoord.x - gl_FragCoord.y) / 7.0) - 0.5);
        if (uGround < 0.5){
          float contour = 1.0 - abs(dot(N, normalize(cameraPosition - vW)));
          if (contour > 0.72 || hatch < 0.06) c = uRamp1;
        } else if (en(vW.xz * 0.35) > 0.72 && hatch < 0.05) c = uRamp1;
        if (rim > 0.05 && en(vW.xz * 7.0 + floor(uTime * 12.0)) < rim * 1.2) c = uRamp0;
        gl_FragColor = vec4(c, 1.0);
        return;
      }
      vec3 L = uCrystalPos - vW; float d2 = dot(L,L);
      float key = clamp(dot(N, normalize(uKeyDir))*0.6+0.4, 0., 1.) * 0.7;
      float pl = max(dot(N, normalize(L)), 0.) * 1.8 / (1.0 + d2*0.09);
      float alb = 0.8;
      if (uGround > 0.5){
        float g = efbm(vW.xz * vec2(3.2, 1.2));
        float streak = smoothstep(.6,.8, en(vW.xz*vec2(26.,5.)));
        alb = 0.9 - smoothstep(.45,.75,g)*0.5 - streak*0.3;
      }
      float tone = alb * (0.12 + key*0.6 + pl) + (efbm(vW.xz*7.0 + vW.y*3.0)-0.5)*0.08;
      vec3 c = uTeal0;
      if (tone > 0.3) c = uTeal1;
      if (tone > 0.52) c = uTeal2;
      if (tone > 0.85) c = uTeal3;
      if (m < 0.62) c = uRamp0; // inked brush edge
      gl_FragColor = vec4(c, 1.0);
    }`,
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), groundMat);
scene.add(ground);
const propMat = groundMat.clone();
propMat.uniforms = { ...groundMat.uniforms, uGround: { value: 0 } };
let seed = 11;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
for (let i = 0; i < 26; i++) {
  const a = rnd() * Math.PI * 2;
  const r = 9 + rnd() * 14;
  const h = 4 + rnd() * 4;
  const g = new THREE.CylinderGeometry(0.08 + rnd() * 0.1, 0.25 + rnd() * 0.2, h, 7, 6);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position!;
  const tw = rnd() * 6;
  for (let k = 0; k < p.count; k++) {
    const y = p.getY(k) / h;
    p.setX(k, p.getX(k) + Math.sin(y * 3 + tw) * 0.35 * y);
    p.setZ(k, p.getZ(k) + Math.cos(y * 2.3 + tw) * 0.3 * y);
  }
  g.computeVertexNormals();
  const t = new THREE.Mesh(g, propMat);
  t.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
  scene.add(t);
}
for (let i = 0; i < 14; i++) {
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.2 + rnd() * 0.35, 0), propMat);
  rock.position.set((rnd() - 0.5) * 22, 0.05, (rnd() - 0.5) * 22);
  rock.scale.y = 0.55;
  rock.rotation.set(rnd(), rnd(), rnd());
  scene.add(rock);
}

// Crystal + stub wizard marker
const crystalMat = new THREE.ShaderMaterial({
  uniforms: {
    core: { value: new THREE.Color(PAL.glowCore) },
    edge: { value: new THREE.Color(PAL.glowEdge) },
    uTime: stageUniforms.uTime!,
  },
  vertexShader: `varying vec3 vVP; varying vec3 vObj; void main(){ vObj = position; vec4 mv = modelViewMatrix*vec4(position,1.); vVP = mv.xyz; gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `uniform vec3 core, edge; uniform float uTime; varying vec3 vVP; varying vec3 vObj;
    void main(){ vec3 n = normalize(cross(dFdx(vVP), dFdy(vVP))); float f = abs(dot(n, normalize(-vVP)));
      float strip = step(abs(vObj.x) + abs(vObj.z)*0.5, 0.05);
      gl_FragColor = vec4(mix(edge, core, clamp(step(0.62 + 0.04*sin(uTime*7.0), f) + strip, 0., 1.)), 1.); }`,
});
const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), crystalMat);
crystal.scale.set(0.7, 1.9, 0.5);
scene.add(crystal);
const inkMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PAL.ink) });
const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.9, 6).translate(0, 0.95, 0), inkMat);
scene.add(staff);
const cloak = new THREE.Mesh(
  new THREE.ConeGeometry(0.36, 1.45, 9, 1, true).translate(0, 0.72, 0),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(PAL.red[1]), side: THREE.DoubleSide }),
);
scene.add(cloak);
const hood = new THREE.Mesh(
  new THREE.ConeGeometry(0.2, 0.55, 8).translate(0, 1.62, 0),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(PAL.red[2]) }),
);
scene.add(hood);

// Bolts (harness only)
interface Bolt {
  mesh: THREE.Mesh;
  target: Damageable | null;
  t: number;
  from: THREE.Vector3;
}
const boltGeo = new THREE.OctahedronGeometry(0.12, 0);
const bolts: Bolt[] = [];
for (let i = 0; i < 10; i++) {
  const mesh = new THREE.Mesh(boltGeo, crystalMat);
  mesh.visible = false;
  scene.add(mesh);
  bolts.push({ mesh, target: null, t: 0, from: new THREE.Vector3() });
}
let boltCd = 0;
function fireBolt(): void {
  if (boltCd > 0) return;
  const t = targets.nearest(player.position, TUNING.bolt.maxRange);
  if (!t) return;
  const b = bolts.find((x) => !x.mesh.visible);
  if (!b) return;
  boltCd = TUNING.bolt.cooldown;
  b.target = t;
  b.t = 0;
  b.from.copy(player.crystalPos);
  b.mesh.position.copy(b.from);
  b.mesh.visible = true;
  stats.boltsFired++;
  sfx('bolt');
}
const _bv = new THREE.Vector3();
function stepBolts(dt: number): void {
  boltCd -= dt;
  for (const b of bolts) {
    if (!b.mesh.visible || !b.target) continue;
    const tp = _bv.copy(b.target.position);
    tp.y += 0.8;
    const d = b.mesh.position.distanceTo(tp);
    const step = TUNING.bolt.speed * dt;
    if (d <= step + b.target.radius * 0.5 || !b.target.alive) {
      b.mesh.visible = false;
      if (b.target.alive) {
        b.target.hit(TUNING.bolt.damage, b.from);
        stats.boltsHit++;
        sfx('hit');
      }
      continue;
    }
    b.mesh.position.addScaledVector(tp.sub(b.mesh.position).normalize(), step);
    b.mesh.rotation.y += dt * 20;
  }
}

// ───────────── input ─────────────
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let pointerDown = false;
let downAt = 0;
let downX = 0;
let downY = 0;
let holdBtn = q.get('hold') === '1';
let autoBolt = q.get('auto') === '1';
const still = q.get('still') === '1';
function aim(ev: PointerEvent): void {
  if (still) return;
  ndc.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (ray.ray.intersectPlane(plane, hit)) player.goal.set(hit.x, 0, hit.z);
}
canvas.addEventListener('pointerdown', (ev) => {
  unlockAudio();
  pointerDown = true;
  downAt = performance.now();
  downX = ev.clientX;
  downY = ev.clientY;
  $('hint').style.display = 'none';
  aim(ev);
});
canvas.addEventListener('pointermove', (ev) => {
  if (pointerDown || ev.pointerType === 'mouse') aim(ev);
});
window.addEventListener('pointerup', (ev: PointerEvent) => {
  if (
    pointerDown &&
    performance.now() - downAt < TUNING.gesture.tapMaxMs + 60 &&
    Math.hypot(ev.clientX - downX, ev.clientY - downY) < 24
  )
    fireBolt();
  pointerDown = false;
});
window.addEventListener('keydown', (ev: KeyboardEvent) => {
  if (ev.code === 'Space') fireBolt();
  if (ev.key === '1') spawnAround('smudge');
  if (ev.key === '2') spawnAround('scribbler');
  if (ev.key === '3') spawnAround('blot');
});

function spawnAround(
  kind: EnemyKind,
  angle = Math.random() * Math.PI * 2,
  dist = 9 + Math.random() * 3,
): void {
  system.spawn(kind, player.position.x + Math.cos(angle) * dist, player.position.z + Math.sin(angle) * dist);
}
function mixed(): void {
  const kinds: EnemyKind[] = [
    'smudge',
    'smudge',
    'smudge',
    'scribbler',
    'scribbler',
    'smudge',
    'blot',
    'blot',
  ];
  for (let i = 0; i < kinds.length; i++)
    spawnAround(kinds[i]!, (i / kinds.length) * Math.PI * 2 + 0.3, 7 + (i % 3) * 1.6);
}
function waves(): void {
  const px = player.position.x;
  const pz = player.position.z;
  spawner.load({
    spawns: [
      { kind: 'smudge', at: [px + 8, pz], wave: 0 },
      { kind: 'smudge', at: [px - 8, pz + 2], wave: 0 },
      { kind: 'smudge', at: [px, pz - 9], wave: 0 },
      { kind: 'scribbler', at: [px + 6, pz + 7], wave: 1 },
      { kind: 'scribbler', at: [px - 7, pz - 6], wave: 1 },
      { kind: 'smudge', at: [px + 9, pz - 3], wave: 1 },
      { kind: 'blot', at: [px - 9, pz + 6], wave: 2 },
      { kind: 'blot', at: [px + 9, pz + 6], wave: 2 },
      { kind: 'smudge', at: [px, pz + 10], wave: 2 },
      { kind: 'scribbler', at: [px, pz - 10], wave: 2 },
    ],
  });
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#bar button')) {
  b.addEventListener('click', () => {
    unlockAudio();
    const k = b.dataset.spawn as EnemyKind | undefined;
    if (k) spawnAround(k);
    switch (b.dataset.act) {
      case 'mixed':
        mixed();
        break;
      case 'wave':
        waves();
        break;
      case 'kill':
        system.killAll();
        break;
      case 'auto':
        autoBolt = !autoBolt;
        break;
      case 'hold':
        holdBtn = !holdBtn;
        break;
      case 'god':
        player.god = !player.god;
        break;
    }
    syncButtons();
  });
}
function syncButtons(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#bar button[data-act]')) {
    const a = b.dataset.act;
    b.classList.toggle(
      'on',
      (a === 'auto' && autoBolt) || (a === 'hold' && holdBtn) || (a === 'god' && player.god),
    );
  }
}
syncButtons();

// ───────────── feedback: panel cut, shake, hitstop, hurt, audio ─────────────
const WORDS: Record<string, string> = {
  'fx.shff': 'SHFF!',
  'fx.skritch': 'SKRITCH!',
  'fx.splotch': 'SPLOTCH!',
};
let freeze = 0;
let shake = 0;
let shakeDur = 0.0001;
events.on('fx:panelCut', (e) => {
  const w = $('word');
  w.querySelector('span')!.textContent = WORDS[e.word] ?? e.word;
  w.classList.remove('show');
  void w.offsetWidth;
  w.classList.add('show');
  $('panels').classList.add('show');
  freeze = Math.max(freeze, TUNING.panelCut.duration);
  sfx('stinger');
  setTimeout(() => {
    w.classList.remove('show');
    $('panels').classList.remove('show');
  }, 900);
});
events.on('fx:shake', (e) => {
  shake = Math.max(shake, e.intensity);
  shakeDur = e.duration;
});
events.on('fx:hitstop', (e) => {
  freeze = Math.max(freeze, e.duration);
});
events.on('player:damaged', () => {
  const h = $('hurt');
  h.classList.add('on');
  setTimeout(() => h.classList.remove('on'), 120);
  sfx('hurt');
});
events.on('ink:drop', (e) => {
  stats.inkCollected += e.amount;
});
events.on('sfx:play', (e) => sfx(e.id));
events.on('enemy:telegraph', (e) =>
  sfx(e.kind === 'scribbler' ? 'tele_scribble' : e.kind === 'smudge' ? 'tele_smudge' : 'tele_blot'),
);
events.on('wave:cleared', (e) => {
  if (!e.last) return;
  const w = $('word');
  w.querySelector('span')!.textContent = 'CLEAR!';
  w.classList.remove('show');
  void w.offsetWidth;
  w.classList.add('show');
  setTimeout(() => w.classList.remove('show'), 1200);
});

let actx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;
function unlockAudio(): void {
  if (actx) return;
  actx = new AudioContext();
  noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}
function burst(
  dur: number,
  f0: number,
  f1: number,
  q: number,
  vol: number,
  type: BiquadFilterType = 'bandpass',
): void {
  if (!actx || !noiseBuf) return;
  const t = actx.currentTime;
  const src = actx.createBufferSource();
  src.buffer = noiseBuf;
  const f = actx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = actx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(actx.destination);
  src.start(t, Math.random() * 0.5, dur);
}
function tone(dur: number, f0: number, f1: number, vol: number, type: OscillatorType = 'sine'): void {
  if (!actx) return;
  const t = actx.currentTime;
  const o = actx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = actx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur);
}
function sfx(id: string): void {
  switch (id) {
    case 'ghost_reveal':
      burst(0.5, 3000, 400, 2, 0.12);
      tone(0.5, 320, 180, 0.03, 'triangle');
      break;
    case 'ghost_die':
      for (let i = 0; i < 4; i++) setTimeout(() => burst(0.07, 2400 + i * 800, 900, 1.5, 0.22), i * 28);
      burst(0.35, 1200, 200, 0.8, 0.12);
      break;
    case 'scribble_fire':
      burst(0.18, 5000, 1800, 6, 0.25);
      break;
    case 'blot_drain':
      tone(0.35, 140, 70, 0.12, 'sine');
      tone(0.2, 220, 110, 0.05, 'triangle');
      break;
    case 'tele_scribble':
      for (let i = 0; i < 6; i++) setTimeout(() => burst(0.06, 3500 + i * 300, 2500, 8, 0.1), i * 120);
      break;
    case 'tele_smudge':
      burst(0.4, 600, 2600, 3, 0.12);
      break;
    case 'tele_blot':
      tone(0.6, 90, 55, 0.12);
      break;
    case 'bolt':
      tone(0.12, 900, 1800, 0.05, 'triangle');
      break;
    case 'hit':
      burst(0.09, 1800, 700, 2, 0.18);
      break;
    case 'hurt':
      tone(0.25, 200, 80, 0.15, 'square');
      break;
    case 'stinger':
      tone(0.45, 330, 660, 0.06, 'sawtooth');
      tone(0.45, 495, 990, 0.04, 'sawtooth');
      break;
  }
}

// ───────────── loop ─────────────
const ZOOM = Number(q.get('zoom') ?? 1.75);
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
function placeCamera(dt: number, instant = false): void {
  const c = TUNING.camera;
  camTarget.set(
    player.position.x + player.facing.x * c.lookAhead * 0.5,
    0.6,
    player.position.z + player.facing.z * c.lookAhead * 0.5,
  );
  // Harness camera sits further back than the game camera so the whole arena is readable.
  const want = _bv.set(camTarget.x, c.height * ZOOM, camTarget.z + c.distance * 0.82 * ZOOM);
  if (instant) camPos.copy(want);
  else camPos.lerp(want, 1 - Math.exp(-c.spring * dt));
  camera.position.copy(camPos);
  if (shake > 0) {
    const s = shake * 0.35;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    shake = Math.max(0, shake - dt * (shake / Math.max(0.05, shakeDur)));
  }
  camera.lookAt(camTarget);
}

let simTime = 0;
const loop = new FixedLoop(
  {
    step(dt) {
      simTime += dt;
      player.step(dt);
      reveal.center.set(player.position.x, 0, player.position.z);
      const held = holdBtn || (pointerDown && performance.now() - downAt > TUNING.gesture.holdMinMs);
      player.crystalHeld = held;
      reveal.targetRadius = held ? TUNING.crystal.radiusHeld : TUNING.crystal.radiusIdle;
      spawner.step(dt);
      system.step(dt);
      reveal.update(dt);
      stepBolts(dt);
      if (autoBolt) fireBolt();
    },
    render(_a, frameDt) {
      const scaled = freeze > 0 ? 0 : frameDt;
      freeze = Math.max(0, freeze - frameDt);
      loop.timeScale = freeze > 0 ? 0 : 1;
      enemyGfx.update(scaled, camera);
      placeCamera(frameDt);
      crystal.position.copy(player.crystalPos);
      crystal.rotation.y += frameDt * 1.5;
      staff.position.set(player.position.x + 0.25, 0, player.position.z + 0.15);
      cloak.position.set(player.position.x, 0, player.position.z);
      hood.position.copy(cloak.position);
      const blink = player.iFrames > 0 && Math.floor(simTime * 20) % 2 === 0;
      cloak.visible = hood.visible = !blink;
      renderer.render(scene, camera);
      hud(frameDt);
    },
  },
  TUNING.sim.hz,
  TUNING.sim.maxStepsPerFrame,
);

let fpsAcc = 0;
let fpsN = 0;
let fps = 0;
let hudT = 0;
function hud(dt: number): void {
  fpsAcc += dt;
  fpsN++;
  hudT -= dt;
  if (fpsAcc >= 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }
  if (hudT > 0) return;
  hudT = 0.2;
  const info = renderer.info.render;
  let enemyCalls = 0;
  for (const m of [enemyGfx.outline, enemyGfx.body, enemyGfx.fx, enemyGfx.particles])
    if (m.count > 0) enemyCalls++;
  $('stats').textContent =
    `${fps.toFixed(0)} fps  ${info.calls} calls (enemies ${enemyCalls})\n` +
    `alive ${system.activeCount}/${TUNING.enemies.maxActive}  fx ${enemyGfx.particleCount}\n` +
    `inked ${stats.ghostsInked}  ink ${stats.inkCollected}  r ${reveal.radius.toFixed(1)}`;
  const pages = $('pages');
  if (pages.childElementCount !== TUNING.player.maxPages)
    pages.innerHTML = '<i></i>'.repeat(TUNING.player.maxPages);
  pages.querySelectorAll('i').forEach((el, i) => {
    el.classList.toggle('lost', i >= player.pages);
  });
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.fov = (innerWidth > innerHeight ? TUNING.camera.fovLandscape : TUNING.camera.fovPortrait) * 1.2;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});
dispatchEvent(new Event('resize'));
placeCamera(0, true);
const n0 = Number(q.get('n') ?? 0);
if (n0 > 0) mixed();
loop.start();
document.documentElement.dataset.ready = '1';

// Playwright / console hooks
Object.assign(window, {
  __enemies: {
    system,
    renderer: enemyGfx,
    spawner,
    reveal,
    player,
    events,
    get fps() {
      return fps;
    },
    get calls() {
      return renderer.info.render.calls;
    },
    mixed,
    spawn: (k: EnemyKind, x: number, z: number) => system.spawn(k, x, z),
    fireBolt,
    setHold: (v: boolean) => {
      holdBtn = v;
      syncButtons();
    },
    setAuto: (v: boolean) => {
      autoBolt = v;
      syncButtons();
    },
    moveTo: (x: number, z: number) => player.goal.set(x, 0, z),
  },
});
