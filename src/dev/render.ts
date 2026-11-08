/**
 * Render harness (dev/render.html): the POC scene rebuilt on the INKWAKE render stack.
 *   default   wizard walks a loop through the procedural forest; the crystal's ink seeps around him
 *   ?poc=1    POC camera/pose/fog, everything inked, frozen clock — used by tests/e2e/visual.spec.ts
 *   ?freeze=1 deterministic clock (screenshots)   ?quality=low|high|auto   ?outline=A|B|AB
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EventBus, type GameEvents } from '../core/events';
import type { QualityLevel } from '../core/types';
import { PAL } from '../data/palette';
import { TUNING } from '../data/tuning';
import { FxSystem } from '../fx';
import { SteppedMixer } from '../render/boil';
import { type OutlineMode, wordFor } from '../render/index';
import { InkRenderer } from '../render/renderer';
import { probeRevealGPU } from '../render/reveal/probe';

THREE.ColorManagement.enabled = false;
const q = new URLSearchParams(location.search);
const POC = q.get('poc') === '1';
const FREEZE = q.get('freeze') === '1' || POC;
const $ = (id: string) => document.getElementById(id)!;

const canvas = $('gl') as HTMLCanvasElement;
const render = new InkRenderer({ canvas, quality: (q.get('quality') as QualityLevel) ?? 'auto' });
const { scene, camera, reveal, shared } = render;
const time = { scale: 1, simTime: 0 };
const events = new EventBus<GameEvents>();
const fx = new FxSystem(render, time);
if (POC) fx.halo.mesh.visible = false;
if (q.get('outline')) render.setOutlineMode(q.get('outline') as OutlineMode);

// ───────────────────────────── forest (POC generator, same seed / order) ─────────────────────────────
let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const treeMat = render.createInkMaterial({ ramp: 'teal', keyAmt: 0.75, glowAmt: 0.35 });
const rockMat = render.createInkMaterial({ ramp: 'staff', keyAmt: 0.8, glowAmt: 0.6 });
const groundMat = render.createInkMaterial({ ramp: 'teal', ground: true, keyAmt: 0.7, glowAmt: 0.9 });

function trunk(base: THREE.Vector3, height: number, r0: number, twist: number) {
  const pts: THREE.Vector3[] = [];
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(
      new THREE.Vector3(
        base.x + Math.sin(t * 3 + twist) * 0.35 * t + (rnd() - 0.5) * 0.12,
        base.y + t * height,
        base.z + Math.cos(t * 2.3 + twist) * 0.3 * t + (rnd() - 0.5) * 0.12,
      ),
    );
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const seg = 40;
  const rad = 10;
  const g = new THREE.TubeGeometry(curve, seg, 1, rad, false);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const ring = Math.floor(i / (rad + 1));
    const t = ring / seg;
    const c = curve.getPointAt(t);
    const r = r0 * (1.0 - 0.65 * t) * (1.0 + 1.6 * (Math.max(0, 0.12 - t) / 0.12) ** 2);
    v.fromBufferAttribute(pos, i).sub(c).multiplyScalar(r).add(c);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return { geo: g, curve };
}

const PATH_R = 3.2;
const forest = new THREE.Group();
scene.add(forest);
const treeGeos: THREE.BufferGeometry[] = [];
const rockMatrices: THREE.Matrix4[] = [];
function addTree(x: number, z: number, keep: boolean) {
  const { geo, curve } = trunk(new THREE.Vector3(x, 0, z), 5 + rnd() * 2, 0.16 + rnd() * 0.14, rnd() * 6);
  if (keep) treeGeos.push(geo);
  for (let b = 0; b < 2; b++) {
    const p = curve.getPointAt(0.45 + rnd() * 0.35);
    const dir = new THREE.Vector3(rnd() - 0.5, 0.6, rnd() - 0.5).normalize();
    const pts = [
      p.clone(),
      p
        .clone()
        .addScaledVector(dir, 0.7)
        .add(new THREE.Vector3((rnd() - 0.5) * 0.4, 0.2, 0)),
      p
        .clone()
        .addScaledVector(dir, 1.5)
        .add(new THREE.Vector3((rnd() - 0.5) * 0.6, 0.5, 0)),
    ];
    const bg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.04 + rnd() * 0.03, 6, false);
    if (keep) treeGeos.push(bg);
  }
}
const pocSpots = [
  [-1.9, -1.2],
  [1.7, -1.6],
  [-0.9, -3.2],
  [2.6, -3.6],
  [-3.2, -2.6],
  [0.7, -4.8],
  [-2.2, -5.5],
  [3.8, -1.0],
  [-4.2, -0.3],
  [1.6, -6.5],
  [-0.4, -7.5],
  [4.6, -5.2],
  [-5, -4.2],
] as const;
const nearPath = (x: number, z: number) => Math.abs(Math.hypot(x, z) - PATH_R) < 1.0;
for (const [x, z] of pocSpots) addTree(x, z, POC || !nearPath(x, z));
for (let i = 0; i < 9; i++) {
  const r = 0.12 + rnd() * 0.2;
  const m = new THREE.Matrix4();
  const o = new THREE.Object3D();
  o.position.set((rnd() - 0.5) * 5, 0.02, -rnd() * 4 + 0.8);
  o.scale.set(r, r * 0.5, r);
  o.rotation.set(rnd(), rnd(), rnd());
  o.updateMatrix();
  m.copy(o.matrix);
  if (POC || !nearPath(o.position.x, o.position.z)) rockMatrices.push(m);
}
if (!POC) {
  // a deeper wood for the 3/4 game camera: rings of crooked trunks, a scatter of stones
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2 + rnd() * 0.3;
    const rr = 6.2 + rnd() * 9;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (pocSpots.some(([px, pz]) => Math.hypot(px - x, pz - z) < 1.6)) continue;
    addTree(x, z, true);
  }
  for (let i = 0; i < 40; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = 1 + rnd() * 12;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (nearPath(x, z)) continue;
    const r = 0.1 + rnd() * 0.28;
    const o = new THREE.Object3D();
    o.position.set(x, 0.02, z);
    o.scale.set(r, r * (0.4 + rnd() * 0.4), r);
    o.rotation.set(rnd(), rnd(), rnd());
    o.updateMatrix();
    rockMatrices.push(o.matrix.clone());
  }
}
const trees = new THREE.Mesh(mergeGeometries(treeGeos), treeMat);
trees.name = 'trees';
forest.add(trees);
const rocks = new THREE.InstancedMesh(
  new THREE.DodecahedronGeometry(1, 0),
  POC ? treeMat : rockMat,
  rockMatrices.length,
);
for (let i = 0; i < rockMatrices.length; i++) rocks.setMatrixAt(i, rockMatrices[i]!);
rocks.name = 'rocks';
forest.add(rocks);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(POC ? 40 : 90, POC ? 40 : 90).rotateX(-Math.PI / 2),
  groundMat,
);
ground.name = 'ground';
ground.userData.noOutline = true;
forest.add(ground);
render.addOutline(rocks);

// ───────────────────────────── paper ghosts (crumple) ─────────────────────────────
const ghostMat = render.createInkMaterial({
  ramp: 'ghost',
  crumple: 0.07,
  keyAmt: 0.9,
  glowAmt: 1.1,
  sketch: 0.18,
});
const ghostGeo = (() => {
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const y = 1.5 - t * 1.5;
    const r = t < 0.35 ? Math.sin((t / 0.35) * Math.PI * 0.5) * 0.36 : 0.36 + (t - 0.35) * 0.32;
    prof.push(new THREE.Vector2(Math.max(0.001, r), y));
  }
  const g = new THREE.LatheGeometry(prof, 18);
  // ragged hem
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < 0.05) p.setY(i, p.getY(i) + Math.sin(Math.atan2(p.getZ(i), p.getX(i)) * 7) * 0.08 + 0.04);
  }
  g.computeVertexNormals();
  return g;
})();
const ghosts: { m: THREE.Mesh; a: number; r: number; seen: boolean }[] = [];
if (!POC) {
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(ghostGeo, ghostMat);
    m.name = `ghost${i}`;
    scene.add(m);
    render.addOutline(m, 1.6);
    ghosts.push({ m, a: (i / 5) * Math.PI * 2, r: 5.5 + (i % 2) * 2.2, seen: false });
  }
}

// ───────────────────────────── a sketch object waiting to be printed ─────────────────────────────
const bridgeMat = render.createInkMaterial({ ramp: 'staff', printed: 0, keyAmt: 0.85, glowAmt: 0.8 });
const bridge = new THREE.Group();
if (!POC) {
  const plank = new THREE.BoxGeometry(0.34, 0.08, 1.5);
  for (let i = 0; i < 8; i++) {
    const b = new THREE.Mesh(plank, bridgeMat);
    b.position.set(i * 0.4 - 1.4, 0.06 + Math.sin((i / 7) * Math.PI) * 0.35, 0);
    b.rotation.z = Math.cos((i / 7) * Math.PI) * -0.25;
    bridge.add(b);
  }
  bridge.position.set(0.2, 0, 0.3);
  bridge.rotation.y = 0.5;
  scene.add(bridge);
  render.addOutline(bridge, 1.5);
}
let printT = 0;
let printing = false;

// ───────────────────────────── crystal + smoke (POC) ─────────────────────────────
const crystalMat = new THREE.ShaderMaterial({
  uniforms: {
    core: { value: new THREE.Color(PAL.glowCore) },
    edge: { value: new THREE.Color(PAL.glowEdge) },
    uTime: shared.uTime!,
  },
  vertexShader: /* glsl */ `
    varying vec3 vVP; varying vec3 vObj;
    void main(){ vObj = position; vec4 mv = modelViewMatrix*vec4(position,1.); vVP = mv.xyz; gl_Position = projectionMatrix*mv; }`,
  fragmentShader: /* glsl */ `
    uniform vec3 core, edge; uniform float uTime; varying vec3 vVP; varying vec3 vObj;
    void main(){
      vec3 n = normalize(cross(dFdx(vVP), dFdy(vVP)));
      float facing = abs(dot(n, normalize(-vVP)));
      float flick = 0.04*sin(uTime*7.0) + 0.03*sin(uTime*13.0);
      float band = step(0.62 + flick, facing);
      float strip = step(abs(vObj.x) + abs(vObj.z)*0.5, 0.05) * step(-0.3, vObj.y);
      gl_FragColor = vec4(mix(edge, core, clamp(band + strip, 0., 1.)), 1.);
    }`,
});
const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.1, 0), crystalMat);
crystal.scale.set(0.62, 1.9, 0.45);
crystal.userData.noOutline = true;
const SMOKE_LEN = 0.75;
const smokeMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime: shared.uTime!,
    col: { value: new THREE.Color(PAL.smoke) },
    ink: { value: new THREE.Color(PAL.ink) },
  },
  vertexShader: /* glsl */ `
    uniform float uTime; varying float vT; varying float vSide;
    void main(){
      float t = position.y + 0.5; vT = t; vSide = position.x;
      vec3 p = vec3(0.0, t*${SMOKE_LEN.toFixed(2)}, 0.0);
      p.x += sin(t*9.0 - uTime*1.6)*0.09*t + sin(t*19.0 - uTime*2.7)*0.03*t;
      p.z += cos(t*5.0 - uTime*1.2)*0.05*t;
      float w = mix(0.014, 0.004, t);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vec4 mv2 = modelViewMatrix * vec4(p + vec3(0.0, 0.01, 0.0), 1.0);
      vec2 dir = normalize(mv2.xy - mv.xy);
      mv.xy += vec2(-dir.y, dir.x) * position.x * w * 2.0;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 col, ink; varying float vT; varying float vSide;
    void main(){ if (vT > 0.97) discard; float rim = smoothstep(0.32, 0.5, abs(vSide)); gl_FragColor = vec4(mix(col, ink, rim), 1.0); }`,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const smoke = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 80), smokeMat);
smoke.frustumCulled = false;
smoke.userData.noOutline = true;
scene.add(smoke);

// ───────────────────────────── wizard ─────────────────────────────
const wizardRoot = new THREE.Group();
scene.add(wizardRoot);
let model: THREE.Object3D | null = null;
let mixer: THREE.AnimationMixer | null = null;
let stepped: SteppedMixer | null = null;
let staffInfo: { node: THREE.Object3D; axis: THREE.Vector3; q0: THREE.Quaternion } | null = null;
let staffTip: THREE.Object3D | null = null;
const UP = new THREE.Vector3(-0.2, 1, 0.12).normalize();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _v = new THREE.Vector3();
function uprightStaff() {
  if (!staffInfo) return;
  const { node, axis, q0 } = staffInfo;
  node.quaternion.copy(q0);
  node.parent!.updateWorldMatrix(true, false);
  node.parent!.getWorldQuaternion(_pq);
  const wq = _pq.clone().multiply(q0);
  _v.copy(axis).applyQuaternion(wq);
  _q.setFromUnitVectors(_v, UP).multiply(wq);
  node.quaternion.copy(_pq.invert().multiply(_q));
}

function attachCrystal(root: THREE.Object3D) {
  let staff: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (
      (o as THREE.Mesh).isMesh &&
      !(o as THREE.SkinnedMesh).isSkinnedMesh &&
      /staff|weapon|cylinder/i.test(o.name)
    )
      staff = o as THREE.Mesh;
  });
  if (!staff) {
    scene.add(crystal);
    crystal.position.set(0.35, 2.0, 0.2);
    return;
  }
  const st = staff as THREE.Mesh;
  st.geometry.computeBoundingBox();
  const bb = st.geometry.boundingBox!;
  const size = bb.getSize(new THREE.Vector3());
  const ax = size.x > size.y ? (size.x > size.z ? 'x' : 'z') : size.y > size.z ? 'y' : 'z';
  const c = bb.getCenter(new THREE.Vector3());
  const a = c.clone();
  const b = c.clone();
  a[ax] = bb.min[ax];
  b[ax] = bb.max[ax];
  root.updateMatrixWorld(true);
  const wa = st.localToWorld(a.clone());
  const wb = st.localToWorld(b.clone());
  const top = wa.y > wb.y ? a : b;
  const bottom = wa.y > wb.y ? b : a;
  const dir = top.clone().sub(bottom).normalize();
  const len = top.distanceTo(bottom);
  const p = st.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    _v.fromBufferAttribute(p, i);
    const s = _v.clone().sub(c).dot(dir);
    _v.addScaledVector(dir, s > 0 ? len * 0.38 : -len * 0.25);
    p.setXYZ(i, _v.x, _v.y, _v.z);
  }
  p.needsUpdate = true;
  st.geometry.computeBoundingBox();
  top.addScaledVector(dir, len * 0.38);
  bottom.addScaledVector(dir, -len * 0.25);
  staffInfo = { node: st, axis: top.clone().sub(bottom).normalize(), q0: st.quaternion.clone() };
  const holder = new THREE.Object3D();
  holder.position.copy(top);
  holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), staffInfo.axis);
  st.add(holder);
  const ws = st.getWorldScale(new THREE.Vector3());
  holder.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
  crystal.position.set(0, 0.14, 0);
  holder.add(crystal);
  staffTip = new THREE.Object3D();
  staffTip.position.set(0, 0.24, 0);
  holder.add(staffTip);
}

let walkAction: THREE.AnimationAction | null = null;
async function loadWizard() {
  const m = await import('../../reference/poc/wizard-model.js');
  const bin = Uint8Array.from(atob(m.default), (c) => c.charCodeAt(0)).buffer;
  const gltf = await new GLTFLoader().parseAsync(bin, '');
  model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  const h = box.getSize(new THREE.Vector3()).y || 1;
  model.scale.multiplyScalar(1.85 / h);
  box.setFromObject(model);
  model.position.y -= box.min.y;
  model.position.x -= (box.min.x + box.max.x) / 2;
  model.position.z -= (box.min.z + box.max.z) / 2;
  model.rotation.y = 0.25;
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = (
      Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    ) as THREE.MeshStandardMaterial;
    const isStaff = /staff|weapon|cylinder/i.test(o.name) || /staff/i.test(src?.name || '');
    mesh.material = render.createInkMaterial({
      ramp: isStaff ? 'staff' : 'red',
      reveal: false,
      map: src?.map ?? null,
      albedoMix: isStaff ? 0.3 : 0.55,
      keyAmt: 0.85,
      glowAmt: 1.4,
      skinning: (mesh as THREE.SkinnedMesh).isSkinnedMesh,
    });
    mesh.frustumCulled = false;
  });
  wizardRoot.add(model);
  mixer = new THREE.AnimationMixer(model);
  stepped = new SteppedMixer(mixer);
  const clip = (n: RegExp) => gltf.animations.find((c) => n.test(c.name)) ?? gltf.animations[0]!;
  const idle = mixer.clipAction(clip(/^idle$/i));
  attachCrystal(model);
  if (POC) {
    idle.play();
    idle.time = 0.3 * idle.getClip().duration;
    mixer.update(0);
  } else {
    walkAction = mixer.clipAction(clip(/^walk$/i));
    walkAction.play();
  }
  uprightStaff();
  render.addOutline(model, 2.0);
}

// ───────────────────────────── camera / controls ─────────────────────────────
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
if (POC) {
  camera.fov = 32;
  camera.near = 0.1;
  camera.far = 60;
  camera.position.set(-0.8, 1.3, 3.5);
  controls.target.set(0.0, 1.45, 0);
  shared.uFogNear!.value = 4.0;
  shared.uFogFar!.value = 14.0;
  reveal.radius = reveal.targetRadius = 100;
} else {
  camera.fov = TUNING.camera.fovPortrait;
  camera.far = 80;
  const pitch = THREE.MathUtils.degToRad(TUNING.camera.pitchDeg);
  const d = TUNING.camera.distance * Number(q.get('dist') ?? 1.2);
  camera.position.set(0, Math.sin(pitch) * d, Math.cos(pitch) * d);
  controls.target.set(0, 0.6, 0);
  controls.maxPolarAngle = 1.35;
  shared.uFogNear!.value = 12;
  shared.uFogFar!.value = 30;
}
camera.updateProjectionMatrix();
controls.update();

// ───────────────────────────── demo choreography ─────────────────────────────
let held = false;
let autoHold = !POC;
let holdClock = 0;
let trailClock = 0;
let walkAngle = -Math.PI / 2;
let revealedCount = 0;
const tmp = new THREE.Vector3();
const crystalWorld = new THREE.Vector3();

function step(dt: number) {
  const sdt = dt * time.scale;
  time.simTime += sdt;
  if (!POC) {
    holdClock += sdt;
    if (autoHold) held = holdClock % 7 > 3.6;
    reveal.targetRadius = held ? TUNING.crystal.radiusHeld : TUNING.crystal.radiusIdle;
    // walk the loop
    walkAngle += (sdt * 1.05) / PATH_R;
    wizardRoot.position.set(Math.cos(walkAngle) * PATH_R, 0, Math.sin(walkAngle) * PATH_R);
    wizardRoot.rotation.y = -walkAngle - 0.25 + Math.PI;
    // dash-trail style temp sources now and then
    trailClock += sdt;
    if (trailClock > 2.3) {
      trailClock = 0;
      for (let i = 1; i <= 3; i++) {
        const a = walkAngle - i * 0.28;
        reveal.addSource(Math.cos(a) * PATH_R, Math.sin(a) * PATH_R, 1.5 - i * 0.2, TUNING.dash.trailLife);
      }
    }
    for (const g of ghosts) {
      g.a += sdt * 0.12;
      const x = Math.cos(g.a) * g.r;
      const z = Math.sin(g.a) * g.r;
      g.m.position.set(x, 0.15 + Math.sin(time.simTime * 2 + g.a * 3) * 0.12, z);
      g.m.rotation.y = -g.a;
      const vis = reveal.isRevealed(x, z);
      if (vis && !g.seen) {
        revealedCount++;
        fx.splash.burst(x, 1.0, z, 0.9, 0.5, 3);
      }
      g.seen = vis;
    }
    if (printing) {
      printT = Math.min(1, printT + sdt / TUNING.sketch.holdToPrint);
      bridgeMat.uniforms.uPrinted!.value = printT;
      if (printT >= 1) printing = false;
    }
  }
  if (stepped) {
    stepped.update(sdt);
    uprightStaff();
  }
  scene.updateMatrixWorld(true);
  crystal.getWorldPosition(crystalWorld);
  reveal.center.copy(crystalWorld);
  reveal.update(sdt);
}

// ───────────────────────────── UI ─────────────────────────────
const bar = $('bar');
function button(label: string, fn: (b: HTMLButtonElement) => void, on?: () => boolean) {
  const b = document.createElement('button');
  b.textContent = label;
  const sync = () => b.classList.toggle('on', on?.() ?? false);
  b.onclick = () => {
    fn(b);
    sync();
  };
  sync();
  bar.appendChild(b);
  return b;
}
const WORD_KEYS = ['krak', 'fwoosh', 'splat', 'thwip', 'boom'];
let wordIdx = 0;
let freezeLeft = 0;
const panelCut = () => {
  const key = WORD_KEYS[wordIdx++ % WORD_KEYS.length]!;
  const focus = tmp.copy(wizardRoot.position);
  render.beginPanelCut(wordFor(null, key), focus, TUNING.panelCut.duration * 1.6);
  freezeLeft = TUNING.panelCut.duration * 1.6;
  time.scale = 0;
  fx.rip([focus.x + 0.8, 0.2, focus.z], true);
};
let page = 1;
const pageTurn = () =>
  render.pageTurn(() => {
    page = page === 1 ? 2 : 1;
    // page 2: the same wood in a different light — key swings, fog closes in, ink re-seeps
    (shared.uKeyDir!.value as THREE.Vector3)
      .set(page === 1 ? -0.5 : 0.6, 0.75, page === 1 ? 0.45 : -0.3)
      .normalize();
    shared.uFogNear!.value = page === 1 ? 12 : 7;
    shared.uFogFar!.value = page === 1 ? 30 : 20;
    reveal.reset();
    walkAngle += Math.PI;
  }, TUNING.pageTurn.duration);
const modes: OutlineMode[] = ['AB', 'A', 'B'];
const outlineBtn = button(`lines ${render.outlineMode}`, (b) => {
  const next = modes[(modes.indexOf(render.outlineMode) + 1) % modes.length]!;
  render.setOutlineMode(next);
  b.textContent = `lines ${next}`;
});
void outlineBtn;
if (!POC) {
  button('panel cut', panelCut);
  button('page turn', () => void pageTurn());
  button(
    'hold',
    () => {
      autoHold = false;
      held = !held;
    },
    () => held,
  );
  button('print', () => {
    printT = printT >= 1 ? 0 : printT;
    bridgeMat.uniforms.uPrinted!.value = printT;
    printing = true;
  });
  button('erase', () => {
    const a = walkAngle + 0.6;
    const cx = Math.cos(a) * PATH_R;
    const cz = Math.sin(a) * PATH_R;
    reveal.eraseStrip(cx - 4, cz - 1, cx + 4, cz + 1, 0.7);
    render.shake.add(0.4, 0.4);
  });
  button(
    'blank',
    () => {
      reveal.blankPage = reveal.blankPage > 0 ? 0 : 1;
    },
    () => reveal.blankPage > 0,
  );
  button('splat', () => {
    const g = ghosts[0]!.m.position;
    fx.rip([g.x, 0, g.z], false);
    render.shake.add(0.3, 0.3);
  });
  button('quality', (b) => {
    const order: QualityLevel[] = ['auto', 'low', 'high'];
    const cur = (b.dataset.q as QualityLevel) ?? 'auto';
    const next = order[(order.indexOf(cur) + 1) % 3]!;
    b.dataset.q = next;
    b.textContent = `q ${next}`;
    render.setQuality(next);
  });
  let misreg = true;
  button(
    'misreg',
    () => {
      misreg = !misreg;
      render.setMisregistration(misreg);
    },
    () => misreg,
  );
  button(
    'calm',
    () => {
      render.setReduceMotion(!render.reduceMotion);
      if (stepped) stepped.stepped = !render.reduceMotion;
    },
    () => render.reduceMotion,
  );
  button('ctx loss', () => render.simulateContextLoss(700));
}
addEventListener('resize', () => render.resize());
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'p') panelCut();
  if (e.key === 't') void pageTurn();
  if (e.key === 'h') {
    autoHold = false;
    held = !held;
  }
});
events.on('fx:panelCut', (e) => render.beginPanelCut(wordFor(null, e.word), tmp.set(...e.focus), 0.6));

// ───────────────────────────── loop ─────────────────────────────
const hud = $('hud');
let last = performance.now();
let hudClock = 0;
let fpsFrames = 0;
let fps = 0;
const FIXED_DT = 1 / 60;
const followTo = new THREE.Vector3();
const followDelta = new THREE.Vector3();
function frame(now: number) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (FREEZE) dt = POC ? 0 : FIXED_DT;
  if (freezeLeft > 0) {
    freezeLeft -= dt;
    if (freezeLeft <= 0) time.scale = 1;
  }
  if (!POC && model) {
    // follow the wizard like the game camera (keeps the user's orbit offset)
    followTo.copy(wizardRoot.position).setY(0.7);
    followDelta
      .copy(followTo)
      .sub(controls.target)
      .multiplyScalar(1 - Math.exp(-dt * 3));
    controls.target.add(followDelta);
    camera.position.add(followDelta);
  }
  controls.update();
  step(dt);
  if (staffTip) {
    staffTip.getWorldPosition(smoke.position);
  } else smoke.position.copy(crystalWorld).add(tmp.set(0, 0.25, 0));
  render.render(dt);
  fpsFrames++;
  hudClock += Math.max(dt, 1e-3);
  if (hudClock > 0.5) {
    fps = fpsFrames / hudClock;
    fpsFrames = 0;
    hudClock = 0;
    const s = render.stats;
    hud.textContent =
      `${fps.toFixed(0)} fps  ${s.frameMs.toFixed(1)} ms\n` +
      `draws ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(1)}k\n` +
      `pr ${s.pixelRatio.toFixed(2)}  lines ${render.outlineMode}\n` +
      `r ${reveal.radius.toFixed(2)}  ghosts inked ${revealedCount}`;
  }
}

declare global {
  interface Window {
    __ink: unknown;
  }
}
/** e2e: compare the shader's reveal field with the CPU mirror at `n` points around the crystal. */
function probe(n = 512) {
  const xz = new Float32Array(n * 2);
  let s = 12345;
  const r01 = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < n; i++) {
    const a = r01() * Math.PI * 2;
    const d = r01() * (reveal.radius + 3);
    xz[i * 2] = reveal.center.x + Math.cos(a) * d;
    xz[i * 2 + 1] = reveal.center.z + Math.sin(a) * d;
  }
  const gpu = probeRevealGPU(render.renderer, reveal, xz);
  let maxErr = 0;
  let mismatched = 0;
  let nearEdge = 0;
  for (let i = 0; i < n; i++) {
    const cpu = Math.min(3, Math.max(-2, reveal.fieldAt(xz[i * 2]!, xz[i * 2 + 1]!)));
    const g = gpu[i]!;
    maxErr = Math.max(maxErr, Math.abs(cpu - g));
    if (cpu > 0.5 !== g > 0.5) mismatched++;
    if (Math.abs(cpu - 0.5) < 0.05) nearEdge++;
  }
  return { n, maxErr, mismatched, nearEdge };
}
window.__ink = { render, reveal, fx, events, step, panelCut, pageTurn, time, camera, controls, probe };
if (q.get('shot') === '1') document.body.classList.add('shot');

loadWizard()
  .catch((e) => console.error(e))
  .finally(() => {
    render.resize();
    // warm the clock so the reveal has seeped in before the first look
    if (!POC) for (let i = 0; i < 90; i++) step(FIXED_DT);
    else step(0);
    requestAnimationFrame((t) => {
      last = t;
      frame(t);
      requestAnimationFrame(() => {
        document.documentElement.dataset.ready = '1';
      });
    });
  });
