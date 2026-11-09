/**
 * The wizard. Kinematic capsule controller (CollisionAPI), analog walk/run, dash, crystal reveal,
 * health in pages, and a layered animation state machine whose mixer is stepped at 12 fps
 * (TUNING.boil.animHz) for line boil while the body moves at the 60 Hz sim rate.
 *
 * Scene graph:  object (sim pos + yaw, interpolated in render)
 *                └ tilt (lean into acceleration)
 *                   └ squash (squash & stretch, volume preserving)
 *                      └ model (glTF)  …staff → holder → crystal + smoke
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { EventBus, GameEvents } from '../core/events';
import { haptics } from '../core/input/haptics';
import type {
  AudioAPI,
  BeatAPI,
  CollisionAPI,
  DamageSource,
  GameContext,
  InputAPI,
  PlayerAPI,
  PlayerSlot,
  PlayerVerb,
  RenderAPI,
  RevealAPI,
  RunStats,
  Settings,
  SfxId,
  TargetRegistry,
} from '../core/types';
import { PAL } from '../data/palette';
import type { Tuning } from '../data/tuning';
import type { HeroHost, HeroKit, PrintSpot } from './heroes/HeroKit';
import { InkerKit } from './heroes/inker';
import { SplashMeter } from './heroes/splash';

export type AnimStateName =
  | 'idle'
  | 'walk'
  | 'run'
  | 'dash'
  | 'cast_tap'
  | 'cast_hold_loop'
  | 'hit_react'
  | 'death'
  | 'victory';

/**
 * Logical clip → candidate clip names (first match wins, case-insensitive, "Armature|" prefixes
 * ignored). `wizard@<name>` is the assets pipeline convention (PLAN §4.2); the rest are the
 * Quaternius names in the POC model.
 */
export const CLIP_ALIASES: Record<string, string[]> = {
  idle: ['wizard@idle', 'idle'],
  walk: ['wizard@walk', 'walk'],
  run: ['wizard@run', 'run'],
  dash: ['wizard@dash', 'roll', 'dodge', 'run'],
  cast_tap: ['wizard@cast_tap', 'staff_attack', 'spell1', 'punch'],
  cast_hold_loop: ['wizard@cast_hold_loop', 'spell1', 'idle_weapon'],
  hit_react: ['wizard@hit_react', 'recievehit', 'receivehit', 'hit'],
  death: ['wizard@death', 'death'],
  victory: ['wizard@victory', 'victory', 'spell1'],
  look_around: ['wizard@look_around', 'idle_weapon', 'idle'],
  kneel: ['wizard@kneel', 'pickup'],
};

/** Per-clip playback hints for clips that need it (POC model). */
const CLIP_HINTS: Record<string, { start?: number; end?: number; freeze?: number }> = {
  // Spell1 peaks with the staff overhead around 45% — hold that pose for the crystal.
  cast_hold_loop: { freeze: 0.45 },
  // Mid-stride frame of Run reads as a comic "leap" pose for the dash.
  dash: { freeze: 0.3 },
};

export interface PlayerDeps {
  events: EventBus<GameEvents>;
  tuning: Tuning;
  settings: Settings;
  input: InputAPI;
  collision: CollisionAPI;
  reveal: RevealAPI;
  render: Pick<RenderAPI, 'createInkMaterial' | 'addOutline'>;
  stats?: RunStats;
  /** Screen → world basis (CameraRig provides it). Defaults to camera looking down -Z. */
  view?: { forward: THREE.Vector3; right: THREE.Vector3 };
  /** Shared beat clock (Ink Rhythm). Read at use time; may return null. */
  beat?: () => BeatAPI | null | undefined;
  // ── hero kits (wave 2, all optional) ──
  targets?: TargetRegistry;
  /** Direct audio (pitched hero sfx); falls back to `sfx:play`. */
  audio?: Pick<AudioAPI, 'play'>;
  /** Scene node for hero VFX and render shared uniforms. */
  scene?: () => THREE.Object3D | null;
  shared?: () => Record<string, THREE.IUniform> | null;
  t?: (key: string) => string;
  /** Players in the session (solo assists when 1). */
  playerCount?: () => number;
}

const NO_SPOTS: readonly PrintSpot[] = [];
const _sfxV = new THREE.Vector3();

interface Spring1 {
  x: number;
  v: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const STAFF_UP = new THREE.Vector3(-0.2, 1, 0.12).normalize();
const STAFF_UP_HOLD = new THREE.Vector3(-0.05, 1, 0.35).normalize();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _out2 = new THREE.Vector2();

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (t: number) => t * t * (3 - 2 * t);
const expK = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function stepSpring(s: Spring1, target: number, k: number, c: number, dt: number): void {
  // semi-implicit Euler damped spring (k stiffness, c damping)
  s.v += (k * (target - s.x) - c * s.v) * dt;
  s.x += s.v * dt;
}

function findClip(clips: THREE.AnimationClip[], logical: string): THREE.AnimationClip | null {
  const names = CLIP_ALIASES[logical] ?? [logical];
  for (const want of names) {
    for (const c of clips) {
      const n = c.name.toLowerCase();
      const bare = n.includes('|') ? n.slice(n.lastIndexOf('|') + 1) : n;
      if (n === want || bare === want) return c;
    }
  }
  return null;
}

/** Keep only tracks that drive bones under `rootName` (inclusive). */
function maskClip(clip: THREE.AnimationClip, keep: Set<string>, name: string): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) => keep.has(t.name.slice(0, t.name.lastIndexOf('.'))));
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

// ───────────────────────────── Crystal visuals (POC port) ─────────────────────────────

function makeCrystal(time: THREE.IUniform) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      core: { value: new THREE.Color(PAL.glowCore) },
      edge: { value: new THREE.Color(PAL.glowEdge) },
      ink: { value: new THREE.Color(PAL.ink) },
      uTime: time,
      uPower: { value: 0 },
      uDim: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vVP; varying vec3 vObj;
      void main(){ vObj = position; vec4 mv = modelViewMatrix*vec4(position,1.); vVP = mv.xyz; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 core, edge, ink; uniform float uTime, uPower, uDim; varying vec3 vVP; varying vec3 vObj;
      void main(){
        vec3 n = normalize(cross(dFdx(vVP), dFdy(vVP)));
        float facing = abs(dot(n, normalize(-vVP)));
        float flick = 0.04*sin(uTime*7.0) + 0.03*sin(uTime*13.0) + uPower*0.08*sin(uTime*31.0);
        float band = step(0.62 - uPower*0.25 + flick, facing);
        float strip = step(abs(vObj.x) + abs(vObj.z)*0.5, 0.05 + uPower*0.03) * step(-0.3, vObj.y);
        vec3 c = mix(edge, core, clamp(band + strip, 0., 1.));
        // empty crystal: ink with a sputtering ember core
        float sput = step(0.6, fract(sin(floor(uTime*9.0)*12.9898)*43758.5453));
        c = mix(c, mix(ink, edge, strip*sput), uDim);
        gl_FragColor = vec4(c, 1.);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.1, 0), mat);
  mesh.scale.set(0.62, 1.9, 0.45);
  mesh.name = 'crystal';
  mesh.frustumCulled = false;
  return { mesh, mat };
}

function makeSmoke(time: THREE.IUniform) {
  const LEN = 0.75;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: time,
      uPower: { value: 0 },
      col: { value: new THREE.Color(PAL.smoke) },
      ink: { value: new THREE.Color(PAL.ink) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime, uPower; varying float vT; varying float vSide;
      void main(){
        float t = position.y + 0.5;
        vT = t; vSide = position.x;
        float len = ${LEN.toFixed(2)} * (1.0 + uPower * 0.6);
        vec3 p = vec3(0.0, t*len, 0.0);
        float sp = 1.0 + uPower * 1.5;
        p.x += sin(t*9.0 - uTime*1.6*sp)*0.09*t*(1.0+uPower) + sin(t*19.0 - uTime*2.7*sp)*0.03*t;
        p.z += cos(t*5.0 - uTime*1.2*sp)*0.05*t;
        float w = mix(0.014, 0.004, t) * (1.0 + uPower * 0.8);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec4 mv2 = modelViewMatrix * vec4(p + vec3(0.0, 0.01, 0.0), 1.0);
        vec2 dir = normalize(mv2.xy - mv.xy + 1e-5);
        mv.xy += vec2(-dir.y, dir.x) * position.x * w * 2.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 col, ink; varying float vT; varying float vSide;
      void main(){
        if (vT > 0.97) discard;
        float rim = smoothstep(0.32, 0.5, abs(vSide));
        gl_FragColor = vec4(mix(col, ink, step(0.5, rim)), 1.0);
      }`,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 60), mat);
  mesh.frustumCulled = false;
  mesh.name = 'crystal-smoke';
  // Layer 1: excluded from the POC-style normal/depth outline pass.
  mesh.layers.set(1);
  return { mesh, mat };
}

/** Flat ink ring that bursts out of the crystal when it powers up (palette, no blending). */
function makeFlare() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { col: { value: new THREE.Color(PAL.glowCore) }, uT: { value: 1 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 col; uniform float uT; varying vec2 vUv;
      void main(){
        vec2 q = vUv*2.-1.; float r = length(q); float a = atan(q.y,q.x);
        float w = mix(0.22, 0.02, uT);
        float wob = sin(a*7.0+uT*6.0)*0.03 + sin(a*13.0)*0.015;
        float ring = step(abs(r - (0.55 + 0.4*uT) + wob), w*0.5);
        float dash = step(0.35, fract(a*3.0/3.14159 + uT));
        if (ring*dash < 0.5 || uT >= 1.0) discard;
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;
  mesh.layers.set(1);
  mesh.visible = false;
  return { mesh, mat };
}

// ───────────────────────────── Player ─────────────────────────────

export class Player implements PlayerAPI {
  readonly object = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly facing = new THREE.Vector3(0, 0, 1);
  readonly crystalPos = new THREE.Vector3(0, 2.1, 0);
  /** Interpolated (render-time) position — feed this to the camera. */
  readonly renderPosition = new THREE.Vector3();

  pages: number;
  /** Extra multiplier on the crystal radius (Blot suppression writes this; reset to 1 by its owner). */
  radiusMul = 1;
  godMode = false;
  /** Co-op (additive hooks): player slot, move-speed multiplier (downed crawl), downed flag. */
  slot: PlayerSlot = 0;
  speedMul = 1;
  downed = false;
  /**
   * Co-op: called when a hit would take the last page. Return true to keep the wizard alive
   * (it goes down as an "UNFINISHED" sketch instead of dying).
   */
  downedHook: ((p: Player) => boolean) | null = null;
  /** Surface footstep sfx (levels may switch to step_stone). */
  stepSfx: SfxId = 'step_grass';
  /** Exposed for HUD/debug. */
  anim: AnimStateName = 'idle';
  /** Verbs the Editor has cut (`boss:rewrite`). Combat reads `bolt`; the player obeys the rest. */
  readonly verbCut: Record<PlayerVerb, boolean> = { bolt: false, dash: false, crystal: false, print: false };
  /** Increments on every dash start (combat uses it to reset per-dash state). */
  dashSerial = 0;
  /** Hero kit (strategy for tap / hold / swipe / ultimate). Defaults to the Inker. */
  kit: HeroKit;
  /** Splash (ultimate) meter. */
  readonly splash: SplashMeter;
  /** Unprinted sketches / weak points (Game wires it; the non-Inker print light reads it). */
  printSpots: (() => readonly PrintSpot[]) | null = null;
  /** Combat installs its bolt ring here (Inker Spot Black). */
  boltRing: ((n: number) => void) | null = null;
  /** What hero kits may touch (see HeroHost). */
  readonly host: HeroHost;

  readonly energyStore: {
    value: number;
    max: number;
    drain(n: number): number;
    add(n: number): number;
    reset(v?: number): void;
  };

  private readonly tilt = new THREE.Group();
  private readonly squash = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private acts: Partial<Record<string, THREE.AnimationAction>> = {};
  private upperActs: Partial<Record<string, THREE.AnimationAction>> = {};
  private animAcc = 0;
  private staff: { node: THREE.Object3D; axis: THREE.Vector3; q0: THREE.Quaternion } | null = null;
  private crystalHolder = new THREE.Object3D();
  private readonly crystalLocal = new THREE.Vector3(0.35, 2.1, 0.2);
  private crystal: ReturnType<typeof makeCrystal>;
  private smoke: ReturnType<typeof makeSmoke>;
  private flare: ReturnType<typeof makeFlare>;
  private readonly time: THREE.IUniform = { value: 0 };
  private readonly smokeTip = new THREE.Object3D();

  // sim state
  private prevPos = new THREE.Vector3();
  private yaw = 0;
  private prevYaw = 0;
  private controllable = true;
  private alive = true;
  private iTimer = 0;
  private dashI = 0;
  private dashT = -1;
  private dashCd = 0;
  private dashBuf = 0;
  private dashBufX = 0;
  private dashBufZ = 0;
  private readonly dashDir = new THREE.Vector3();
  private dashDone = 0;
  private dashTrailAcc = 0;
  private readonly kb = new THREE.Vector3();
  private castT = -1;
  private castFace = 0;
  private castYaw = 0;
  private hitT = -1;
  private deathT = -1;
  private diedEmitted = false;
  private heldT = 0;
  private dimT = 0;
  private held = false;
  private crystalHeldFlag = false;
  private lowSputter = 0;
  private cinematic: string | null = null;
  private cinematicT = 0;
  private locoPhase = 0;
  private lastStepPhase = 0;
  private speedSmooth = 0;
  private flareT = 1;
  private lastVel = new THREE.Vector3();
  private lean = { px: 0, pv: 0, rx: 0, rv: 0 };
  private sq: Spring1 = { x: 1, v: 0 };
  // smoothed anim weights (sim rate), applied at anim ticks
  private wFull = 0;
  private wUpper = 0;
  private upright = 1;
  private fullName: string | null = null;
  private upperName: string | null = null;
  private visible = true;
  private flickerT = 0;
  // Snuff & Flare
  private snuffedFlag = false;
  private flareRun = -1;
  private wantPrev = false;
  private parryPending = false;
  // hero kit verbs
  private kitHolding = false;
  private kitHoldT = 0;
  private sketchedT = 0;
  private cam: THREE.Camera | null = null;

  private sfxPayload = { id: 'dash' as SfxId, position: [0, 0, 0] as [number, number, number], volume: 1 };
  private dashPayload = {
    from: [0, 0, 0] as [number, number, number],
    to: [0, 0, 0] as [number, number, number],
  };
  private offs: (() => void)[] = [];

  constructor(
    private deps: PlayerDeps,
    energy?: Player['energyStore'],
  ) {
    this.pages = deps.tuning.player.maxPages;
    // Respect Settings.vibration even when Input was built without installInput().
    if (!haptics.settings) haptics.settings = deps.settings;
    this.energyStore = energy ?? {
      value: deps.tuning.energy.start,
      max: deps.tuning.energy.max,
      drain(n) {
        const d = Math.min(this.value, n);
        this.value -= d;
        return d;
      },
      add(n) {
        const b = this.value;
        this.value = Math.min(this.max, this.value + n);
        return this.value - b;
      },
      reset(v) {
        this.value = v ?? deps.tuning.energy.start;
      },
    };
    this.object.name = 'player';
    this.object.add(this.tilt);
    this.tilt.add(this.squash);
    this.crystal = makeCrystal(this.time);
    this.smoke = makeSmoke(this.time);
    this.flare = makeFlare();
    // Until a model arrives the crystal floats where the staff tip would be.
    this.crystalHolder.position.copy(this.crystalLocal);
    this.crystalHolder.add(this.crystal.mesh);
    this.squash.add(this.crystalHolder);
    this.object.add(this.smoke.mesh, this.flare.mesh);
    this.smoke.mesh.matrixAutoUpdate = true;

    this.host = this.makeHost();
    this.splash = new SplashMeter(deps.events, 0);
    this.kit = new InkerKit();
    this.kit.attach(this.host);

    const ev = deps.events;
    this.offs.push(
      ev.on('enemy:died', (e) => {
        if (!this.alive) return;
        this.splash.kill();
        this.kit.onKill?.(e.position[0], e.position[2], e.kind);
      }),
      ev.on('sketch:printed', () => this.splash.print()),
      ev.on('hero:combo', () => this.splash.combo()),
      ev.on('checkpoint:reached', () => {
        this.pages = deps.tuning.player.maxPages;
      }),
      ev.on('player:respawn', () => this.revive()),
      ev.on('boss:rewrite', (e) => {
        if (e.verb in this.verbCut) this.verbCut[e.verb] = e.cut;
        if (e.cut && e.verb === 'dash') this.cancelDash();
      }),
      ev.on('page:start', () => {
        this.restoreVerbs();
        this.snuffedFlag = false;
        this.flareRun = -1;
      }),
      ev.on('boss:defeated', () => this.restoreVerbs()),
    );
  }

  /** Swap the hero kit (hero select / co-op). The old kit is disposed. */
  setKit(kit: HeroKit): void {
    if (kit === this.kit) return;
    if (this.kitHolding) this.kit.onRelease(this.kitHoldT);
    this.kitHolding = false;
    this.sketchedT = 0;
    this.kit.dispose();
    this.host.setMaxInkBonus?.(0);
    this.kit = kit;
    kit.attach(this.host);
  }

  private makeHost(): HeroHost {
    const self = this;
    const d = this.deps;
    return {
      get pid(): PlayerSlot {
        return (self as { slot?: PlayerSlot }).slot ?? 0;
      },
      position: this.position,
      facing: this.facing,
      crystalPos: this.crystalPos,
      events: d.events,
      tuning: d.tuning,
      settings: d.settings,
      reveal: d.reveal,
      get collision() {
        return d.collision;
      },
      get targets() {
        return d.targets ?? null;
      },
      get time() {
        return self.time.value;
      },
      get playerCount() {
        return d.playerCount?.() ?? 1;
      },
      get energy() {
        return self.energyStore.value;
      },
      beat: () => d.beat?.() ?? null,
      scene: () => d.scene?.() ?? self.object.parent,
      shared: () => d.shared?.() ?? null,
      t: (k) => d.t?.(k) ?? k,
      spend: (n) => {
        const E = self.energyStore as Player['energyStore'] & { spend?: (n: number) => boolean };
        if (E.spend) return E.spend(n);
        if (E.value + 1e-6 < n) return false;
        E.drain(n);
        return true;
      },
      addEnergy: (n) => {
        self.energyStore.add(n);
      },
      heal: (n) => {
        if (self.alive) self.pages = Math.min(d.tuning.player.maxPages, self.pages + n);
      },
      printables: () => self.printSpots?.() ?? NO_SPOTS,
      sfx: (id, volume = 1, rate = 1, at) => {
        const x = at ? at[0] : self.position.x;
        const y = at ? at[1] : self.position.y + 1;
        const z = at ? at[2] : self.position.z;
        if (d.audio && rate !== 1) {
          _sfxV.set(x, y, z);
          d.audio.play(id, { position: _sfxV, volume, rate });
          return;
        }
        const p = self.sfxPayload;
        p.id = id;
        p.volume = volume;
        p.position[0] = x;
        p.position[1] = y;
        p.position[2] = z;
        d.events.emit('sfx:play', p);
      },
      fireRing: (n) => self.boltRing?.(n),
      setMaxInkBonus: (n) => {
        const E = self.energyStore as { bonusMax?: number; max: number };
        if ('bonusMax' in E) E.bonusMax = n;
        else E.max = d.tuning.energy.max + n;
      },
      setSketched: (on) => {
        self.sketchedT = on ? 1 : 0;
      },
    };
  }

  private restoreVerbs(): void {
    const v = this.verbCut;
    v.bolt = v.dash = v.crystal = v.print = false;
  }

  // ───────── PlayerAPI ─────────

  get energy(): number {
    return this.energyStore.value;
  }

  get invulnerable(): boolean {
    return this.godMode || !this.alive || this.iTimer > 0 || this.dashI > 0;
  }

  get crystalHeld(): boolean {
    return this.crystalHeldFlag;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get dashing(): boolean {
    return this.dashT >= 0;
  }

  /** Seconds since the current dash started, or -1 when not dashing. */
  get dashAge(): number {
    return this.dashT;
  }

  /** In a hero "sketch phase" (Penciller erase-step): attacks pass through. */
  get sketched(): boolean {
    return this.sketchedT > 0;
  }

  /** Crystal snuffed to 0 m (Snuff & Flare). */
  get snuffed(): boolean {
    return this.snuffedFlag;
  }

  /** 0..1 progress of a running flare, -1 otherwise. */
  get flare01(): number {
    return this.flareRun < 0 ? -1 : clamp(this.flareRun / this.deps.tuning.combatPlus.snuff.flareTime, 0, 1);
  }

  /** Dash-Strike Nib kill: the next dash is ready right away. */
  resetDashCooldown(): void {
    this.dashCd = 0;
  }

  /** True once after a hit was dodged in the parry window (Ink Parry). */
  consumeParry(): boolean {
    const p = this.parryPending;
    this.parryPending = false;
    return p;
  }

  /** 0 = ready, 1 = just used (HUD). */
  get dashCooldown01(): number {
    return clamp(this.dashCd / this.deps.tuning.dash.cooldown, 0, 1);
  }

  get canAct(): boolean {
    return this.alive && this.controllable && this.cinematic === null;
  }

  damage(amount: number, source: DamageSource, from?: THREE.Vector3): void {
    const T = this.deps.tuning;
    if (
      amount > 0 &&
      this.alive &&
      this.dashI > 0 &&
      this.dashT >= 0 &&
      this.dashT <= T.combatPlus.parry.window
    )
      this.parryPending = true;
    if (this.invulnerable || amount <= 0) return;
    if (this.kit.mods.ignore === source) return;
    if (this.kit.onDamage?.(amount, source, from)) return;
    const mul = T.difficulty[this.deps.settings.difficulty]?.damageTaken ?? 1;
    const dmg = amount * mul;
    this.pages = Math.max(0, this.pages - dmg);
    this.iTimer = T.player.iFramesOnHit;
    // knockback away from the source (or backwards)
    if (from) _v.set(this.position.x - from.x, 0, this.position.z - from.z);
    else _v.copy(this.facing).negate();
    if (_v.lengthSq() < 1e-6) _v.copy(this.facing).negate();
    _v.normalize().multiplyScalar(T.player.hitKnockback);
    this.kb.copy(_v);
    this.cancelDash();
    this.sq.v -= 9;
    this.hitT = 0;
    const ev = this.deps.events;
    ev.emit('player:damaged', { amount: dmg, source, pagesLeft: this.pages });
    ev.emit('fx:hitstop', { duration: T.player.hitStop });
    ev.emit('fx:shake', { intensity: 0.5, duration: 0.3 });
    this.sfx('player_hurt');
    haptics.pulse([T.haptics.hurt, 40, T.haptics.hurt * 0.5], 0);
    if (this.pages <= 0 && !this.downedHook?.(this)) this.die();
  }

  addEnergy(amount: number): void {
    this.energyStore.add(amount);
  }

  teleport(x: number, y: number, z: number, facingY?: number): void {
    this.position.set(x, y, z);
    this.prevPos.copy(this.position);
    this.renderPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.kb.set(0, 0, 0);
    this.cancelDash();
    if (facingY !== undefined) {
      this.yaw = this.prevYaw = facingY;
      this.facing.set(Math.sin(facingY), 0, Math.cos(facingY));
    }
    this.object.position.copy(this.position);
    this.object.rotation.y = this.yaw;
    this.updateCrystalPos();
  }

  setControllable(v: boolean): void {
    this.controllable = v;
    if (!v) this.cancelDash();
  }

  playClip(name: string, loop = false): void {
    if (!name || name === 'none' || name === 'idle') {
      this.cinematic = null;
      return;
    }
    this.cinematic = name;
    this.cinematicT = 0;
    const a = this.action(name);
    if (a) {
      a.reset();
      a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      a.clampWhenFinished = !loop;
      a.play();
    }
  }

  // ───────── Extra API (combat, checkpoints, harness) ─────────

  /** Start the tap-cast animation and face `target` briefly. Returns false if it can't cast now. */
  castTap(target: THREE.Vector3 | null): boolean {
    if (!this.canAct || this.dashT >= 0) return false;
    this.castT = 0;
    const a = this.upperActs.cast_tap;
    if (a) {
      a.reset();
      a.play();
    }
    if (target) {
      this.castYaw = Math.atan2(target.x - this.position.x, target.z - this.position.z);
      this.castFace = this.deps.tuning.player.castFaceTime;
    }
    this.sq.v += 5;
    this.flareT = 0.35;
    return true;
  }

  /** Out of ink: tiny "pfft" reaction. */
  fizzle(): void {
    this.sq.v -= 3;
    haptics.pulse(this.deps.tuning.haptics.fizzle);
  }

  /** Full heal + revive in place (checkpoint respawn calls teleport first). */
  revive(): void {
    const T = this.deps.tuning;
    this.alive = true;
    this.deathT = -1;
    this.diedEmitted = false;
    this.pages = T.player.maxPages;
    this.iTimer = T.player.iFramesOnHit;
    this.hitT = -1;
    this.castT = -1;
    this.cinematic = null;
    this.snuffedFlag = false;
    this.flareRun = -1;
    this.parryPending = false;
    if (this.energyStore.value < T.energy.start * 0.5) this.energyStore.reset(T.energy.start * 0.5);
    const d = this.acts.death;
    if (d) {
      d.stop();
    }
    this.fullName = null;
    this.wFull = 0;
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
    this.kit.dispose();
    this.mixer?.stopAllAction();
    this.object.removeFromParent();
  }

  /**
   * Install a glTF character. Normalises height, applies ink materials + outline, finds and
   * stretches the staff (POC: the chibi CC0 model's staff is lengthened so the crystal clears
   * the head), and builds full-body + upper-body (masked) actions.
   */
  setModel(root: THREE.Object3D, clips: THREE.AnimationClip[]): void {
    if (this.model) this.squash.remove(this.model);
    const T = this.deps.tuning;
    const box = new THREE.Box3().setFromObject(root);
    const h = box.getSize(new THREE.Vector3()).y || 1;
    root.scale.multiplyScalar(T.player.height / h);
    root.updateMatrixWorld(true);
    box.setFromObject(root);
    root.position.y -= box.min.y;
    root.position.x -= (box.min.x + box.max.x) / 2;
    root.position.z -= (box.min.z + box.max.z) / 2;

    const render = this.deps.render;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const src = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
      const isStaff = /staff|weapon|cylinder/i.test(o.name) || /staff/i.test(src?.name || '');
      m.material = render.createInkMaterial({
        ramp: isStaff ? 'staff' : 'red',
        reveal: false,
        skinning: (m as THREE.SkinnedMesh).isSkinnedMesh === true,
        map: src?.map ?? null,
        albedoMix: isStaff ? 0.3 : 0.45,
        // the hero must pop against the dark forest from a 12-15 m camera
        keyAmt: isStaff ? 0.9 : 1.1,
        glowAmt: 1.6,
      });
      m.frustumCulled = false;
    });
    this.model = root;
    this.squash.add(root);
    // Find + stretch the staff before outlining so the hull is built from the final shape; the
    // crystal holder is detached while hulls are added (the crystal draws its own contour).
    this.attachCrystal(root);
    const holderParent = this.crystalHolder.parent;
    this.crystalHolder.removeFromParent();
    render.addOutline(root);
    holderParent?.add(this.crystalHolder);
    this.buildActions(root, clips);
    this.animAcc = 1; // force an immediate pose
    this.tickAnim(0);
  }

  // ───────── Simulation ─────────

  step(dt: number): void {
    const T = this.deps.tuning;
    const P = T.player;
    const input = this.deps.input.state;
    this.prevPos.copy(this.position);
    this.prevYaw = this.yaw;
    this.time.value += dt;

    // timers
    if (this.iTimer > 0) this.iTimer = Math.max(0, this.iTimer - dt);
    if (this.dashI > 0) this.dashI = Math.max(0, this.dashI - dt);
    if (this.dashCd > 0) this.dashCd = Math.max(0, this.dashCd - dt);
    if (this.castFace > 0) this.castFace -= dt;
    if (this.castT >= 0) {
      this.castT += dt;
      if (this.castT > 0.42) this.castT = -1;
    }
    if (this.hitT >= 0) {
      this.hitT += dt;
      if (this.hitT > 0.45) this.hitT = -1;
    }
    if (this.cinematic) this.cinematicT += dt;

    const live = this.alive && this.controllable && this.cinematic === null;
    const view = this.deps.view;
    const fx = view ? view.forward.x : 0;
    const fz = view ? view.forward.z : -1;
    const rx = view ? view.right.x : 1;
    const rz = view ? view.right.z : 0;

    // ── input → desired velocity
    let mx = 0;
    let my = 0;
    if (live) {
      mx = input.move.x;
      my = input.move.y;
    }
    const mag = Math.min(1, Math.hypot(mx, my));
    let wx = rx * mx + fx * my;
    let wz = rz * mx + fz * my;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-5) {
      wx /= wl;
      wz /= wl;
    }
    let target = 0;
    if (mag > 0.001) {
      const wt = P.walkThreshold;
      target =
        mag < wt
          ? P.walkSpeed * (mag / wt)
          : P.walkSpeed + (P.runSpeed - P.walkSpeed) * ((mag - wt) / (1 - wt));
    }
    if (this.held) target *= P.holdMoveMul;
    target *= this.speedMul;
    if (this.castT >= 0) target *= P.castMoveMul;

    // ── dash (buffered so a swipe slightly early still fires)
    const mods = this.kit.mods;
    if (live && input.snuffPressed && !this.verbCut.crystal && mods.baseCrystal) this.toggleSnuff();
    // non-bolt heroes: the action-side tap is the kit's attack
    if (live && input.boltPressed && !mods.baseBolt && !this.kit.remote) {
      if (this.verbCut.bolt) this.fizzle();
      else if (this.dashT < 0) this.kit.onTap();
    }
    if (live && input.ultimatePressed && !this.kit.remote && this.splash.consume()) this.kit.onUltimate();
    if (mods.revealBoostT > 0) mods.revealBoostT = Math.max(0, mods.revealBoostT - dt);
    if (live && input.dashPressed && !this.verbCut.dash) {
      this.dashBuf = T.dash.buffer;
      const dx = input.dashDir.x;
      const dy = input.dashDir.y;
      if (dx * dx + dy * dy > 0.01) {
        this.dashBufX = rx * dx + fx * dy;
        this.dashBufZ = rz * dx + fz * dy;
      } else if (wl > 1e-5 && mag > 0.05) {
        this.dashBufX = wx;
        this.dashBufZ = wz;
      } else {
        this.dashBufX = this.facing.x;
        this.dashBufZ = this.facing.z;
      }
    }
    if (this.dashBuf > 0) {
      this.dashBuf -= dt;
      if (live && this.dashCd <= 0 && this.dashT < 0 && !this.verbCut.dash)
        this.startDash(this.dashBufX, this.dashBufZ);
      else if (this.dashBuf <= 0 && live && this.dashCd > 0) this.fizzle();
    }

    if (this.dashT >= 0) this.stepDash(dt);
    else {
      // accelerate toward target velocity; decelerate harder (snappy stops)
      const tvx = wx * target;
      const tvz = wz * target;
      const dvx = tvx - this.velocity.x;
      const dvz = tvz - this.velocity.z;
      const dvl = Math.hypot(dvx, dvz);
      const speeding = target * target > this.velocity.x ** 2 + this.velocity.z ** 2;
      const a = (speeding ? P.accel : P.decel) * dt;
      if (dvl <= a) {
        this.velocity.x = tvx;
        this.velocity.z = tvz;
      } else {
        this.velocity.x += (dvx / dvl) * a;
        this.velocity.z += (dvz / dvl) * a;
      }
      // turning (exponential, faster when stopped so pivots feel instant)
      let faceYaw = this.yaw;
      if (this.castFace > 0) faceYaw = this.castYaw;
      else if (mag > 0.08) faceYaw = Math.atan2(wx, wz);
      const speedFrac = Math.hypot(this.velocity.x, this.velocity.z) / P.runSpeed;
      const tr = P.turnRate * (this.castFace > 0 ? 2 : 1.4 - speedFrac * 0.5);
      this.yaw += angleDelta(this.yaw, faceYaw) * expK(tr, dt);
      this.moveBy((this.velocity.x + this.kb.x) * dt, (this.velocity.z + this.kb.z) * dt);
    }
    this.kb.multiplyScalar(Math.exp(-10 * dt));
    this.facing.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.position.y = this.deps.collision.groundHeight(this.position.x, this.position.z);

    // ── crystal / energy / reveal (Inker: the crystal *is* the hold verb; others: kit hold + print light)
    const wantHold = live && input.crystalHeld && !this.verbCut.crystal;
    if (mods.baseCrystal) {
      this.stepCrystal(dt, wantHold);
      this.stepKitHold(dt, this.crystalHeldFlag);
    } else {
      this.stepKitHold(dt, wantHold);
      this.stepCrystal(dt, this.kit.wantsPrintLight?.(wantHold) ?? false);
    }
    if (!this.kit.remote) this.kit.update(dt);

    // ── death
    if (!this.alive) {
      this.deathT += dt;
      if (!this.diedEmitted && this.deathT >= P.deathDelay) {
        this.diedEmitted = true;
        this.deps.events.emit('player:died', {});
      }
    }

    // ── juice + animation
    this.stepJuice(dt);
    this.stepAnimWeights(dt);
    this.animAcc += dt;
    if (this.animAcc >= 1 / T.boil.animHz) this.tickAnim(this.animAcc);
    this.updateCrystalPos();
    this.stepFootsteps();
  }

  /** Interpolate the visual transform. Call once per rendered frame. */
  render(alpha: number, frameDt: number): void {
    this.renderPosition.lerpVectors(this.prevPos, this.position, alpha);
    this.object.position.copy(this.renderPosition);
    this.object.rotation.y = this.prevYaw + angleDelta(this.prevYaw, this.yaw) * alpha;

    // i-frame flicker (hit only, not dash)
    let vis = true;
    if (this.iTimer > 0 && this.alive) {
      this.flickerT += frameDt;
      vis = Math.floor(this.flickerT * this.deps.tuning.player.flickerHz) % 2 === 0;
    } else this.flickerT = 0;

    if (vis !== this.visible && this.model) {
      this.visible = vis;
      this.model.visible = vis;
    }

    // crystal follows the staff tip; smoke + flare live in object space but track the tip
    this.object.updateMatrixWorld(true);
    this.smokeTip.getWorldPosition(_v);
    this.object.worldToLocal(_v);
    this.smoke.mesh.position.copy(_v);
    this.crystal.mesh.getWorldPosition(_v);
    this.object.worldToLocal(_v);
    this.flare.mesh.position.copy(_v);
    const power = smooth(this.heldT);
    this.crystal.mat.uniforms.uPower!.value = power;
    this.crystal.mat.uniforms.uDim!.value = this.dimT;
    this.smoke.mat.uniforms.uPower!.value = power;
    const s =
      (1 + power * 0.35 + (this.flareT < 0.35 ? (0.35 - this.flareT) * 1.2 : 0)) * (1 - this.dimT * 0.25);
    this.crystal.mesh.scale.set(0.62 * s, 1.9 * s, 0.45 * s);
    this.crystal.mesh.rotation.y += frameDt * (0.6 + power * 5);

    if (this.flareT < 1) {
      this.flareT = Math.min(1, this.flareT + frameDt * 2.4);
      this.flare.mesh.visible = true;
      this.flare.mat.uniforms.uT!.value = this.flareT;
      const fs = 0.5 + this.flareT * 1.4;
      this.flare.mesh.scale.set(fs, fs, fs);
    } else this.flare.mesh.visible = false;
    this.kit.render(alpha, frameDt, this.cam);
  }

  /** Orient the flare to a camera (harness / main call with the active camera each frame). */
  faceCamera(cam: THREE.Camera): void {
    this.cam = cam;
    if (!this.flare.mesh.visible) return;
    _q.copy(this.object.quaternion).invert();
    this.flare.mesh.quaternion.copy(_q).multiply(cam.quaternion);
  }

  // ───────── internals ─────────

  private moveBy(dx: number, dz: number): boolean {
    const C = this.deps.collision;
    const r = this.deps.tuning.player.radius;
    const ox = this.position.x;
    const oz = this.position.z;
    let nx = ox + dx;
    let nz = oz + dz;
    // walkable area: slide along the boundary axis-by-axis. If we're already outside (respawn
    // point, a push-out at a corridor edge), never freeze: let any step through so the player
    // can walk back in — otherwise every move is rejected and the wizard is stuck for good.
    if (!C.walkable(nx, nz) && C.walkable(ox, oz)) {
      if (C.walkable(nx, oz)) nz = oz;
      else if (C.walkable(ox, nz)) nx = ox;
      else {
        nx = ox;
        nz = oz;
      }
    }
    if (C.resolveCircle(nx, nz, r, _out2)) {
      nx = _out2.x;
      nz = _out2.y;
    }
    const moved = Math.abs(nx - ox) + Math.abs(nz - oz) > 1e-6;
    this.position.x = nx;
    this.position.z = nz;
    return moved;
  }

  private startDash(dx: number, dz: number): void {
    const T = this.deps.tuning;
    const l = Math.hypot(dx, dz) || 1;
    this.dashDir.set(dx / l, 0, dz / l);
    this.dashT = 0;
    this.dashDone = 0;
    this.dashBuf = 0;
    this.dashI = this.kit.mods.dashIFrames ?? T.dash.iFrames;
    this.dashCd = T.dash.cooldown;
    this.dashTrailAcc = T.dash.trailSpacing; // drop a source immediately at the start
    this.yaw = Math.atan2(this.dashDir.x, this.dashDir.z);
    this.castFace = 0;
    this.dashSerial++;
    if (this.deps.beat?.()?.onBeat()) this.deps.events.emit('combat:onBeat', { action: 'dash' });
    this.sq.x = 0.78; // anticipation squash, the spring snaps it into a stretch
    this.sq.v = 14;
    const p = this.dashPayload;
    p.from[0] = this.position.x;
    p.from[1] = this.position.y;
    p.from[2] = this.position.z;
    p.to[0] = this.position.x + this.dashDir.x * T.dash.distance;
    p.to[1] = this.position.y;
    p.to[2] = this.position.z + this.dashDir.z * T.dash.distance;
    this.deps.events.emit('player:dash', p);
    if (!this.kit.remote) this.kit.onSwipe(p.from[0], p.from[2], this.dashDir.x, this.dashDir.z);
    this.sfx('dash');
    const a = this.acts.dash;
    if (a) {
      a.reset();
      a.play();
    }
  }

  private stepDash(dt: number): void {
    const D = this.deps.tuning.dash;
    this.dashT += dt;
    const p = Math.min(1, this.dashT / D.duration);
    // ease-out quart: explosive start, soft landing
    const target = (1 - (1 - p) ** 4) * D.distance;
    const step = target - this.dashDone;
    this.dashDone = target;
    const moved = this.moveBy(this.dashDir.x * step, this.dashDir.z * step);
    const sp = step / Math.max(dt, 1e-4);
    this.velocity.set(this.dashDir.x * sp, 0, this.dashDir.z * sp);
    // reveal trail
    this.dashTrailAcc += step;
    if (this.dashTrailAcc >= D.trailSpacing) {
      this.dashTrailAcc = 0;
      this.deps.reveal.addSource(
        this.position.x,
        this.position.z,
        D.trailRadius,
        this.kit.mods.dashTrailLife ?? D.trailLife,
      );
    }
    if (p >= 1 || (!moved && this.dashT > 0.03)) {
      this.dashT = -1;
      const carry = D.carry * this.deps.tuning.player.runSpeed;
      this.velocity.set(this.dashDir.x * carry, 0, this.dashDir.z * carry);
      this.sq.v -= 8; // landing squash
      this.deps.reveal.addSource(
        this.position.x,
        this.position.z,
        D.trailRadius * 0.9,
        this.kit.mods.dashTrailLife ?? D.trailLife,
      );
    }
  }

  private cancelDash(): void {
    if (this.dashT < 0) return;
    this.dashT = -1;
    this.velocity.multiplyScalar(0.3);
  }

  private die(): void {
    this.alive = false;
    this.deathT = 0;
    this.diedEmitted = false;
    this.held = false;
    this.cinematic = null;
    const a = this.acts.death;
    if (a) {
      a.reset();
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.play();
    }
    this.deps.events.emit('fx:shake', { intensity: 0.8, duration: 0.5 });
  }

  /** Hold-verb edges → kit hooks (local only). */
  private stepKitHold(dt: number, holding: boolean): void {
    if (this.kit.remote) return;
    if (holding && !this.kitHolding) {
      this.kitHolding = true;
      this.kitHoldT = 0;
      this.kit.onHoldStart();
    } else if (!holding && this.kitHolding) {
      this.kitHolding = false;
      this.kit.onRelease(this.kitHoldT);
    }
    if (this.kitHolding) {
      this.kitHoldT += dt;
      this.kit.onHoldTick(dt);
    }
  }

  private stepCrystal(dt: number, wantHeld: boolean): void {
    const T = this.deps.tuning;
    const C = T.crystal;
    const E = this.energyStore;
    const cost = T.difficulty[this.deps.settings.difficulty]?.energyCost ?? 1;
    const hasInk = E.value > 0;
    // Snuff & Flare: snuffed = 0 m and no drain; a fresh hold flares straight to full size
    const pressed = wantHeld && !this.wantPrev;
    this.wantPrev = wantHeld;
    if (this.snuffedFlag && pressed && hasInk) {
      this.snuffedFlag = false;
      this.flareRun = 0;
      this.heldT = 1;
      this.deps.events.emit('crystal:snuff', { snuffed: false });
      haptics.pulse(T.haptics.dash, 0);
    }
    if (this.flareRun >= 0) {
      this.flareRun += dt;
      if (this.flareRun > T.combatPlus.snuff.flareTime) this.flareRun = -1;
    }
    const held = wantHeld && hasInk && !this.snuffedFlag;
    const mods = this.kit.mods;
    if (held) E.drain(C.drainPerSec * cost * mods.holdCostMul * dt);
    const powered = held && E.value > 0;
    if (powered !== this.crystalHeldFlag) {
      this.crystalHeldFlag = powered;
      this.deps.events.emit('crystal:hold', { held: powered });
      this.sfx(powered ? 'crystal_on' : 'crystal_off');
      if (powered) {
        this.flareT = 0;
        this.sq.v += 4;
      }
    }
    this.held = powered;
    this.heldT = clamp(this.heldT + (powered ? dt / C.growTime : -dt / C.shrinkTime), 0, 1);
    this.dimT = clamp(this.dimT + (E.value <= 0 ? dt / 0.5 : -dt / 0.35), 0, 1);
    const idle = mods.radiusIdle ?? C.radiusIdle;
    const full = mods.radiusHeld ?? C.radiusHeld;
    let r = idle + (full - idle) * smooth(this.heldT);
    r += ((mods.baseCrystal ? C.radiusDim : Math.min(C.radiusDim, idle)) - r) * this.dimT;
    if (mods.revealBoostT > 0) r = Math.max(r, mods.revealBoostR);
    // low-ink sputter (visible flicker in the mask edge)
    if (E.value > 0 && E.value < C.lowEnergy) {
      this.lowSputter += dt * 11;
      const n = Math.sin(this.lowSputter) * Math.sin(this.lowSputter * 2.7);
      r *= 1 - C.sputterAmp * Math.max(0, n) * (1 - E.value / C.lowEnergy);
    }
    if (!this.alive) r = C.radiusDim * Math.max(0, 1 - this.deathT);
    // print cut by the Editor: the light can't quite reach printing size
    if (this.verbCut.print) r = Math.min(r, T.sketch.requiredRadius * T.sketch.radiusSlack - 0.4);
    const rv = this.deps.reveal;
    if (this.snuffedFlag) {
      rv.targetRadius = 0;
      rv.radius *= Math.exp(-dt * 30);
      if (rv.radius < 0.02) rv.radius = 0;
      this.dimT = 1;
      return;
    }
    rv.targetRadius = r * this.radiusMul;
    if (this.flareRun >= 0) {
      const k = clamp(this.flareRun / T.combatPlus.snuff.flareTime, 0, 1);
      rv.radius = rv.targetRadius * (1 - (1 - k) ** 3);
    }
  }

  private toggleSnuff(): void {
    this.snuffedFlag = !this.snuffedFlag;
    this.flareRun = -1;
    if (this.snuffedFlag) {
      this.heldT = 0;
      if (this.crystalHeldFlag) {
        this.crystalHeldFlag = false;
        this.held = false;
        this.deps.events.emit('crystal:hold', { held: false });
      }
      this.sfx('crystal_off');
    } else this.sfx('crystal_on', 0.6);
    this.deps.events.emit('crystal:snuff', { snuffed: this.snuffedFlag });
  }

  private stepJuice(dt: number): void {
    const P = this.deps.tuning.player;
    // acceleration in local space → lean
    _v.copy(this.velocity).sub(this.lastVel).divideScalar(Math.max(dt, 1e-4));
    this.lastVel.copy(this.velocity);
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const fwd = _v.x * s + _v.z * c;
    const side = _v.x * c - _v.z * s;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const dashLean = this.dashT >= 0 ? 0.35 : 0;
    const pitchT = clamp(
      fwd * 0.012 + (speed / P.runSpeed) * 0.08 + dashLean,
      -P.leanMax,
      P.leanMax + dashLean,
    );
    const rollT = clamp(-side * 0.01, -P.leanMax, P.leanMax);
    const L = this.lean;
    const k = P.leanSpring * P.leanSpring;
    const d = 2 * P.leanSpring * 0.7;
    L.pv += (k * (pitchT - L.px) - d * L.pv) * dt;
    L.px += L.pv * dt;
    L.rv += (k * (rollT - L.rx) - d * L.rv) * dt;
    L.rx += L.rv * dt;
    this.tilt.rotation.set(L.px, 0, L.rx);
    // squash spring toward 1 (dash holds a stretch)
    const sqTarget = this.dashT >= 0 ? 1.12 : 1;
    stepSpring(this.sq, sqTarget, P.squashStiffness, P.squashDamping, dt);
    const sy = clamp(this.sq.x, 0.65, 1.4);
    const sxz = 1 / Math.sqrt(sy);
    this.squash.scale.set(sxz, sy, sxz);
  }

  private stepAnimWeights(dt: number): void {
    // Which full-body override and upper-body overlay should be active?
    let full: string | null = null;
    if (!this.alive) full = 'death';
    else if (this.cinematic) full = this.cinematic;
    else if (this.dashT >= 0) full = 'dash';
    else if (this.hitT >= 0) full = 'hit_react';
    let upper: string | null = null;
    if (this.alive && !full) {
      if (this.castT >= 0) upper = 'cast_tap';
      else if (this.held) upper = 'cast_hold_loop';
    }
    if (full !== this.fullName) {
      if (full && full !== 'death' && full !== this.cinematic) {
        const a = this.acts[full];
        if (a && full !== 'dash') a.reset().play();
      }
      if (full) this.fullName = full;
    }
    const kf = expK(full ? (full === 'dash' ? 40 : 18) : 10, dt);
    this.wFull += ((full ? 1 : 0) - this.wFull) * kf;
    if (!full && this.wFull < 0.01) this.fullName = null;

    if (upper !== this.upperName && upper) {
      if (upper === 'cast_hold_loop') this.upperActs.cast_hold_loop?.play();
      this.upperName = upper;
    }
    this.wUpper += ((upper ? 1 : 0) - this.wUpper) * expK(upper ? 22 : 8, dt);
    if (!upper && this.wUpper < 0.01) this.upperName = null;
    const wantUpright = this.castT >= 0 || !this.alive || full === 'hit_react' ? 0 : 1;
    this.upright += (wantUpright - this.upright) * expK(wantUpright ? 6 : 25, dt);

    this.speedSmooth += (Math.hypot(this.velocity.x, this.velocity.z) - this.speedSmooth) * expK(14, dt);
    const P = this.deps.tuning.player;
    if (full) this.anim = full === 'dash' || full === 'death' || full === 'hit_react' ? full : 'victory';
    else if (upper) this.anim = upper === 'cast_tap' ? 'cast_tap' : 'cast_hold_loop';
    else if (this.speedSmooth < 0.15) this.anim = 'idle';
    else this.anim = this.speedSmooth < P.walkSpeed + 0.4 ? 'walk' : 'run';
  }

  private tickAnim(dt: number): void {
    this.animAcc = 0;
    const mixer = this.mixer;
    if (!mixer) return;
    const P = this.deps.tuning.player;
    const s = this.speedSmooth;
    // locomotion blend
    let wI = 1;
    let wW = 0;
    let wR = 0;
    if (s > 0.05) {
      if (s < P.walkSpeed) {
        const t = s / P.walkSpeed;
        wI = 1 - t;
        wW = t;
      } else {
        const t = clamp((s - P.walkSpeed) / (P.runSpeed - P.walkSpeed), 0, 1);
        wI = 0;
        wW = 1 - t;
        wR = t;
      }
    }
    const idle = this.acts.idle;
    const walk = this.acts.walk;
    const run = this.acts.run;
    // shared gait phase so walk/run stay in step while blending
    if (walk && run) {
      const wd = walk.getClip().duration;
      const rd = run.getClip().duration;
      const rateW = Math.max(0.55, s / P.walkAnimSpeed) / wd;
      const rateR = Math.max(0.6, s / P.runAnimSpeed) / rd;
      const rate = (wW * rateW + wR * rateR) / Math.max(1e-3, wW + wR);
      if (wW + wR > 0.01) this.locoPhase = (this.locoPhase + rate * dt) % 1;
      walk.time = this.locoPhase * wd;
      run.time = this.locoPhase * rd;
    }
    const base = 1 - this.wFull;
    idle?.setEffectiveWeight(wI * base);
    walk?.setEffectiveWeight(wW * base);
    run?.setEffectiveWeight(wR * base);
    for (const [name, a] of Object.entries(this.acts)) {
      if (!a || name === 'idle' || name === 'walk' || name === 'run') continue;
      a.setEffectiveWeight(name === this.fullName ? this.wFull : 0);
    }
    const ku = Math.min(0.9, this.wUpper);
    const wu = ku / (1 - ku);
    for (const [name, a] of Object.entries(this.upperActs)) {
      if (!a) continue;
      a.setEffectiveWeight(name === this.upperName ? wu : 0);
    }
    // dash pose: frozen leap frame; hold pose: tiny sway around the frozen frame
    const dash = this.acts.dash;
    if (dash) dash.time = (CLIP_HINTS.dash?.freeze ?? 0.3) * dash.getClip().duration;
    const hold = this.upperActs.cast_hold_loop;
    if (hold) {
      const f = CLIP_HINTS.cast_hold_loop?.freeze ?? 0.45;
      hold.time = (f + Math.sin(this.time.value * 2.2) * 0.015) * hold.getClip().duration;
    }
    mixer.update(dt);
    this.uprightStaff();
  }

  /** POC: stand the staff upright in the hand (blend so cast swings still read). */
  private uprightStaff(): void {
    const st = this.staff;
    if (!st?.node.parent) return;
    st.node.quaternion.copy(st.q0);
    const w = this.upright;
    if (w < 0.01) return;
    st.node.parent.updateWorldMatrix(true, false);
    st.node.parent.getWorldQuaternion(_pq);
    _q2.copy(_pq).multiply(st.q0);
    _v.copy(st.axis).applyQuaternion(_q2);
    // the model's world includes our juice transforms; aim in object space so lean doesn't tip it
    this.object.getWorldQuaternion(_q);
    _v2.copy(this.held ? STAFF_UP_HOLD : STAFF_UP).applyQuaternion(_q);
    _q.setFromUnitVectors(_v, _v2).multiply(_q2);
    _q.premultiply(_pq.invert());
    st.node.quaternion.slerp(_q, w);
  }

  private attachCrystal(root: THREE.Object3D): void {
    this.crystalHolder.removeFromParent();
    this.staff = null;
    let staff: THREE.Mesh | null = null;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (
        !staff &&
        m.isMesh &&
        !(m as THREE.SkinnedMesh).isSkinnedMesh &&
        !o.name.endsWith(':hull') &&
        /staff|weapon|cylinder/i.test(o.name)
      )
        staff = m;
    });
    const holder = this.crystalHolder;
    holder.position.set(0, 0, 0);
    holder.quaternion.identity();
    holder.scale.set(1, 1, 1);
    if (!staff) {
      holder.position.copy(this.crystalLocal);
      this.squash.add(holder);
      this.crystal.mesh.position.set(0, 0, 0);
      this.smokeTip.position.set(0, 0.12, 0);
      holder.add(this.smokeTip);
      return;
    }
    const sm = staff as THREE.Mesh;
    sm.geometry.computeBoundingBox();
    const bb = sm.geometry.boundingBox!;
    const size = bb.getSize(new THREE.Vector3());
    const ax: 'x' | 'y' | 'z' = size.x > size.y ? (size.x > size.z ? 'x' : 'z') : size.y > size.z ? 'y' : 'z';
    const c = bb.getCenter(new THREE.Vector3());
    const a = c.clone();
    const b = c.clone();
    a[ax] = bb.min[ax];
    b[ax] = bb.max[ax];
    root.updateMatrixWorld(true);
    const wa = sm.localToWorld(a.clone());
    const wb = sm.localToWorld(b.clone());
    const top = wa.y > wb.y ? a : b;
    const bottom = wa.y > wb.y ? b : a;
    if (!sm.userData.stretched) {
      sm.userData.stretched = true;
      // Quantized GLBs (KHR_mesh_quantization, int16/normalized) clamp at the original bounds:
      // dequantize to float first so the stretched shaft can actually grow.
      const src = sm.geometry.attributes.position as THREE.BufferAttribute;
      if (src.normalized || !(src.array instanceof Float32Array)) {
        const f = new Float32Array(src.count * 3);
        for (let i = 0; i < src.count; i++) {
          f[i * 3] = src.getX(i);
          f[i * 3 + 1] = src.getY(i);
          f[i * 3 + 2] = src.getZ(i);
        }
        sm.geometry.setAttribute('position', new THREE.BufferAttribute(f, 3));
      }
      const dir = top.clone().sub(bottom).normalize();
      const len = top.distanceTo(bottom);
      const p = sm.geometry.attributes.position as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const sd = v.clone().sub(c).dot(dir);
        v.addScaledVector(dir, sd > 0 ? len * 0.38 : -len * 0.25);
        p.setXYZ(i, v.x, v.y, v.z);
      }
      p.needsUpdate = true;
      sm.geometry.computeBoundingBox();
      sm.geometry.computeBoundingSphere();
      top.addScaledVector(dir, len * 0.38);
      bottom.addScaledVector(dir, -len * 0.25);
    }
    const axis = top.clone().sub(bottom).normalize();
    this.staff = { node: sm, axis, q0: sm.quaternion.clone() };
    holder.position.copy(top);
    holder.quaternion.setFromUnitVectors(UP, axis);
    sm.add(holder);
    const ws = sm.getWorldScale(new THREE.Vector3());
    const vs = this.deps.tuning.crystal.visualScale;
    holder.scale.set(vs / ws.x, vs / ws.y, vs / ws.z);
    this.crystal.mesh.position.set(0, 0.14, 0);
    this.smokeTip.position.set(0, 0.24, 0);
    holder.add(this.smokeTip);
  }

  private buildActions(root: THREE.Object3D, clips: THREE.AnimationClip[]): void {
    this.mixer?.stopAllAction();
    const mixer = new THREE.AnimationMixer(root);
    this.mixer = mixer;
    this.acts = {};
    this.upperActs = {};
    // upper-body bone set (Torso and everything under it)
    const upperBones = new Set<string>();
    let torso: THREE.Object3D | null = null;
    root.traverse((o) => {
      if (!torso && /torso|spine|chest/i.test(o.name) && (o as THREE.Bone).isBone) torso = o;
    });
    if (torso) (torso as THREE.Object3D).traverse((o) => upperBones.add(o.name));

    const full = ['idle', 'walk', 'run', 'dash', 'hit_react', 'death', 'victory', 'look_around', 'kneel'];
    const used = new Set<THREE.AnimationClip>();
    for (const name of full) {
      let clip = findClip(clips, name);
      if (!clip) continue;
      // one action per clip per root: clone shared clips (dash = frozen Run, victory = Spell1)
      if (used.has(clip)) clip = clip.clone();
      used.add(clip);
      const a = mixer.clipAction(clip);
      const loop = name === 'idle' || name === 'walk' || name === 'run' || name === 'look_around';
      a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      a.clampWhenFinished = !loop;
      if (name === 'walk' || name === 'run' || name === 'dash') a.timeScale = 0;
      a.enabled = true;
      a.setEffectiveWeight(name === 'idle' ? 1 : 0);
      a.play();
      this.acts[name] = a;
    }
    if (upperBones.size) {
      for (const name of ['cast_tap', 'cast_hold_loop']) {
        const clip = findClip(clips, name);
        if (!clip) continue;
        const masked = maskClip(clip, upperBones, `${name}@upper`);
        const a = mixer.clipAction(masked);
        if (name === 'cast_tap') {
          a.setLoop(THREE.LoopOnce, 1);
          a.clampWhenFinished = true;
          // squeeze the swing into ~0.38 s so taps feel instant
          a.timeScale = clip.duration / 0.38;
        } else {
          a.setLoop(THREE.LoopRepeat, Infinity);
          a.timeScale = 0;
        }
        a.setEffectiveWeight(0);
        a.play();
        this.upperActs[name] = a;
      }
    }
  }

  private action(name: string): THREE.AnimationAction | null {
    return this.acts[name] ?? null;
  }

  private updateCrystalPos(): void {
    // crystal offset in object space, measured at the last anim tick
    if (this.model && this.animAcc === 0) {
      this.object.position.copy(this.position);
      this.object.rotation.y = this.yaw;
      this.object.updateMatrixWorld(true);
      this.crystal.mesh.getWorldPosition(_v);
      this.object.worldToLocal(_v);
      this.crystalLocal.copy(_v);
    }
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const l = this.crystalLocal;
    this.crystalPos.set(
      this.position.x + l.x * c + l.z * s,
      this.position.y + l.y,
      this.position.z - l.x * s + l.z * c,
    );
    const rc = this.deps.reveal.center;
    rc.x = this.crystalPos.x;
    rc.y = this.crystalPos.y;
    rc.z = this.crystalPos.z;
  }

  private stepFootsteps(): void {
    if (!this.alive || this.dashT >= 0 || this.speedSmooth < 0.6) {
      this.lastStepPhase = this.locoPhase;
      return;
    }
    const a = this.lastStepPhase;
    const b = this.locoPhase;
    const crossed = (x: number) => (a <= b ? a < x && b >= x : a < x || b >= x);
    if (crossed(0.02) || crossed(0.52)) {
      this.sfxPayload.volume = Math.min(1, 0.35 + this.speedSmooth * 0.12);
      this.sfx(this.stepSfx, this.sfxPayload.volume);
    }
    this.lastStepPhase = b;
  }

  private sfx(id: SfxId, volume = 1): void {
    const p = this.sfxPayload;
    p.id = id;
    p.volume = volume;
    p.position[0] = this.position.x;
    p.position[1] = this.position.y + 1;
    p.position[2] = this.position.z;
    this.deps.events.emit('sfx:play', p);
  }
}

// ───────────────────────────── Loading + install ─────────────────────────────

export interface LoadedCharacter {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

/**
 * Load the wizard: `public/assets/wizard.glb` (resolved against Vite's BASE_URL so the /game/
 * Pages deploy works) if it exists, else `fallback()`
 * (the harness passes the POC's embedded CC0 GLB).
 */
export async function loadWizard(
  url = `${import.meta.env.BASE_URL}assets/wizard.glb`,
  fallback?: () => Promise<ArrayBuffer>,
): Promise<LoadedCharacter> {
  const loader = new GLTFLoader();
  try {
    const res = await fetch(url);
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const magic = new Uint8Array(buf, 0, 4);
      if (magic[0] === 0x67 && magic[1] === 0x6c && magic[2] === 0x54 && magic[3] === 0x46) {
        const g = await loader.parseAsync(buf, url.slice(0, url.lastIndexOf('/') + 1));
        return { scene: g.scene, animations: g.animations };
      }
    }
  } catch {
    /* fall through */
  }
  if (!fallback) throw new Error(`wizard model not found at ${url}`);
  const g = await loader.parseAsync(await fallback(), '');
  return { scene: g.scene, animations: g.animations };
}

/** main.ts wiring. `view` = the CameraRig (forward/right basis). */
export function installPlayer(
  ctx: GameContext,
  character: LoadedCharacter | null,
  view?: PlayerDeps['view'],
  energy?: Player['energyStore'],
): Player {
  const p = new Player(
    {
      events: ctx.events,
      tuning: ctx.tuning,
      settings: ctx.settings,
      input: ctx.input,
      collision: ctx.collision,
      reveal: ctx.reveal,
      render: ctx.render,
      stats: ctx.stats,
      view,
      beat: () => ctx.beat,
      targets: ctx.targets,
      audio: ctx.audio,
      scene: () => ctx.render.scene,
      shared: () => ctx.render.shared ?? null,
      t: (k) => ctx.t(k),
    },
    energy,
  );

  if (character) p.setModel(character.scene, character.animations);
  ctx.render.scene.add(p.object);
  ctx.player = p;
  return p;
}
