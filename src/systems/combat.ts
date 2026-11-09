/**
 * Ink bolts (PLAN §3.2): tap fires at the nearest *revealed* target (TargetRegistry), costs ink,
 * homes softly, leaves a brush-stroke trail, splats on impact. All pooled; one draw call each for
 * heads, trails and splats.
 *
 * Idea-ledger wave 1 (`tuning.combatPlus`), all owned here so the player's verbs share one clock:
 *  - Heavier Ink: hit-stop by blow weight, kill-chain pitch rise + trail width, knockback along
 *    the bolt, "thock" haptic on kills.
 *  - Close-Up Crits: a killing bolt is critical only when the target is mid-attack (its
 *    `attacking` flag, or an `enemy:telegraph` we saw) or marked by a Flare -> `fx:panelCut`.
 *  - Snuff & Flare: the expanding flare edge stuns + marks every ghost it sweeps.
 *  - Dash-Strike Nib: dashing through a revealed ghost deals damage; a nib kill resets the dash.
 *  - Ink Parry: a hit landing in the first moments of a dash -> `combat:parry` (FX slows time).
 *  - Frame Lasso: dash endpoints + splat points closing a loop damage + stun everything inside.
 *  - Ink Rhythm: on-beat bolts are free and bigger (`combat:onBeat`).
 */
import * as THREE from 'three';
import type { EventBus, GameEvents } from '../core/events';
import { haptics } from '../core/input/haptics';
import type {
  AudioAPI,
  BeatAPI,
  CollisionAPI,
  Damageable,
  GameContext,
  InputAPI,
  RunStats,
  Settings,
  SfxId,
  TargetRegistry,
} from '../core/types';
import { PAL } from '../data/palette';
import type { Tuning } from '../data/tuning';
import type { Player } from '../entities/Player';

const MAX_BOLTS = 10;
const TRAIL = 14;
const MAX_SPLATS = 12;
const MAX_CAUGHT = 16;
const MAX_NIB = 8;

// ───────────────────────────── pure rules (unit-tested) ─────────────────────────────

export interface CritResult {
  damage: number;
  kill: boolean;
  critical: boolean;
}
const _crit: CritResult = { damage: 0, kill: false, critical: false };

/**
 * Close-Up Crits. A bolt at a target that is attacking or marked (`eligible`) deals
 * `base * critMul`; it is critical iff that blow kills. Otherwise it deals `base` and is never
 * critical. `hp` undefined (boss weak points) -> never predicted as a kill. Returns a shared object.
 */
export function critRule(
  hp: number | undefined,
  base: number,
  critMul: number,
  eligible: boolean,
): CritResult {
  const dmg = eligible ? base * critMul : base;
  const kill = typeof hp === 'number' && hp <= dmg;
  _crit.damage = dmg;
  _crit.kill = kill;
  _crit.critical = kill && eligible;
  return _crit;
}

export interface LoopResult {
  /** Closed-loop polygon (scratch arrays owned by the caller). */
  px: Float32Array;
  pz: Float32Array;
  count: number;
  area: number;
  cx: number;
  cz: number;
}

export function makeLoopResult(maxPoints: number): LoopResult {
  return {
    px: new Float32Array(maxPoints + 1),
    pz: new Float32Array(maxPoints + 1),
    count: 0,
    area: 0,
    cx: 0,
    cz: 0,
  };
}

/** Shoelace area (absolute) and vertex-mean centre written into `out`. */
function finishPolygon(out: LoopResult): void {
  let a = 0;
  let cx = 0;
  let cz = 0;
  const n = out.count;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += out.px[i]! * out.pz[j]! - out.px[j]! * out.pz[i]!;
    cx += out.px[i]!;
    cz += out.pz[i]!;
  }
  out.area = Math.abs(a) * 0.5;
  out.cx = n > 0 ? cx / n : 0;
  out.cz = n > 0 ? cz / n : 0;
}

/**
 * Frame Lasso detection on a time-ordered polyline (oldest -> newest, `n` points). Only the newest
 * point can close a loop (call after every push):
 *  - the newest segment crosses an earlier, non-adjacent segment -> polygon from the crossing, or
 *  - the newest point lands within `closeDist` of a point at least 3 back -> polygon from there.
 * The loop must enclose at least `minArea` m². Writes the polygon into `out`.
 */
export function detectLoop(
  xs: ArrayLike<number>,
  zs: ArrayLike<number>,
  n: number,
  closeDist: number,
  minArea: number,
  out: LoopResult,
): boolean {
  out.count = 0;
  if (n < 3) return false;
  const cap = out.px.length;
  const ax = xs[n - 2]!;
  const az = zs[n - 2]!;
  const bx = xs[n - 1]!;
  const bz = zs[n - 1]!;
  const rX = bx - ax;
  const rZ = bz - az;
  // 1) self-intersection: newest segment vs segments that don't share a vertex with it
  for (let i = n - 4; i >= 0; i--) {
    const cx = xs[i]!;
    const cz = zs[i]!;
    const sX = xs[i + 1]! - cx;
    const sZ = zs[i + 1]! - cz;
    const den = rX * sZ - rZ * sX;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((cx - ax) * sZ - (cz - az) * sX) / den;
    const u = ((cx - ax) * rZ - (cz - az) * rX) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) continue;
    let k = 0;
    out.px[k] = ax + rX * t;
    out.pz[k++] = az + rZ * t;
    for (let j = i + 1; j <= n - 2 && k < cap; j++) {
      out.px[k] = xs[j]!;
      out.pz[k++] = zs[j]!;
    }
    out.count = k;
    finishPolygon(out);
    if (k >= 3 && out.area >= minArea) return true;
    out.count = 0;
  }
  // 2) endpoints meet: newest point near an earlier one
  const c2 = closeDist * closeDist;
  for (let j = n - 4; j >= 0; j--) {
    const ex = xs[j]! - bx;
    const ez = zs[j]! - bz;
    if (ex * ex + ez * ez > c2) continue;
    let k = 0;
    for (let q = j; q <= n - 1 && k < cap; q++) {
      out.px[k] = xs[q]!;
      out.pz[k++] = zs[q]!;
    }
    out.count = k;
    finishPolygon(out);
    if (out.area >= minArea) return true;
    out.count = 0;
  }
  return false;
}

/** Even-odd point-in-polygon test. */
export function pointInLoop(x: number, z: number, loop: LoopResult): boolean {
  let inside = false;
  const n = loop.count;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = loop.px[i]!;
    const zi = loop.pz[i]!;
    const xj = loop.px[j]!;
    const zj = loop.pz[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Kill-chain playback rate: one semitone per chained kill after the first, capped. */
export function chainRate(chain: number, maxSemitones: number): number {
  return 2 ** (Math.min(Math.max(0, chain - 1), maxSemitones) / 12);
}

interface Bolt {
  live: boolean;
  dying: number;
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  ox: number;
  oy: number;
  oz: number;
  life: number;
  target: Damageable | null;
  /** Ink Rhythm size multiplier and kill-chain trail width multiplier. */
  scale: number;
  width: number;
  trail: Float32Array;
  head: number;
  count: number;
}

interface Splat {
  t: number;
  x: number;
  y: number;
  z: number;
  s: number;
  rot: number;
}

export interface CombatDeps {
  events: EventBus<GameEvents>;
  tuning: Tuning;
  settings: Settings;
  input: InputAPI;
  targets: TargetRegistry;
  collision: CollisionAPI;
  stats?: RunStats;
  /** Seed for splat rotation (deterministic e2e). */
  seed?: number;
  /** Direct audio for pitched kill-chain hits (falls back to `sfx:play`). */
  audio?: Pick<AudioAPI, 'play'>;
  /** Shared beat clock (Ink Rhythm); read at use time, may be null. */
  beat?: () => BeatAPI | null | undefined;
}

/** Scribbler pencil strokes in flight (EnemySystem.projectiles), for Ink Parry. */
export interface ThreatProjectiles {
  readonly capacity: number;
  readonly x: ArrayLike<number>;
  readonly z: ArrayLike<number>;
  readonly active: ArrayLike<number>;
}

type Target = Damageable & { kind?: string; windup?: number; hp?: number };

export interface EnergySpender {
  spend(n: number): boolean;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, 1);
const _from = new THREE.Vector3();
const _sfxPos = new THREE.Vector3();

export class Combat {
  /** Group to add to the scene (heads, trails, splats). */
  readonly object = new THREE.Group();
  private bolts: Bolt[] = [];
  private splats: Splat[] = [];
  private splatIdx = 0;
  private cooldown = 0;
  private buffer = 0;
  private pendingFire = -1;
  private pendingTarget: Damageable | null = null;
  private lastPanel = -1e9;
  private time = 0;
  /** EnemySystem.projectiles — set by the game after enemies exist (Ink Parry probe). */
  projectiles: ThreatProjectiles | null = null;
  // Heavier Ink: kill chain
  private chain = 0;
  private lastKillT = -1e9;
  private pendingScale = 1;
  // Close-Up Crits: telegraph fallback (id -> sim time the windup ends) and flare marks
  private tele = new Map<number, number>();
  private marks = new Map<number, number>();
  // Snuff & Flare
  private flaring = false;
  private caught: (Damageable | null)[] = new Array(MAX_CAUGHT).fill(null);
  private caughtApplied = new Uint8Array(MAX_CAUGHT);
  private caughtN = 0;
  private caughtUntil = -1;
  private flareR = 0;
  // Dash-Strike Nib + Ink Parry
  private nibSerial = -1;
  private nibIds = new Int32Array(MAX_NIB);
  private nibN = 0;
  private wasDashing = false;
  private parried = false;
  private lastParry = -1e9;
  private parryPayload = { position: [0, 0, 0] as [number, number, number] };
  private threat = false;
  // Frame Lasso
  private lx: Float32Array;
  private lz: Float32Array;
  private lt: Float32Array;
  private ln = 0;
  private loop: LoopResult;
  private lastLasso = -1e9;
  private lassoIds: number[] = [];
  private rng: number;
  private heads: THREE.InstancedMesh;
  private splatMesh: THREE.InstancedMesh;
  private trailGeo: THREE.BufferGeometry;
  private trailPos: Float32Array;
  private trailT: Float32Array;
  private scanBolt: Bolt | null = null;
  private scanHit: Damageable | null = null;
  private scanBest = 0;
  private readonly scan = (t: Damageable) => {
    const b = this.scanBolt!;
    if (!t.alive || !t.revealed) return;
    const dx = t.position.x - b.x;
    const dz = t.position.z - b.z;
    const dy = t.position.y + 0.6 - b.y;
    const r = t.radius + this.deps.tuning.bolt.hitRadius * b.scale;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r && Math.abs(dy) < 1.6 && d2 < this.scanBest) {
      this.scanBest = d2;
      this.scanHit = t;
    }
  };
  private sfxPayload = {
    id: 'bolt_fire' as SfxId,
    position: [0, 0, 0] as [number, number, number],
    volume: 1,
  };
  private hitPayload = {
    enemyId: 0,
    position: [0, 0, 0] as [number, number, number],
    critical: false,
    kill: false,
    chain: 0,
    dir: [0, 0] as [number, number],
  };

  constructor(
    private deps: CombatDeps,
    private player: Player,
    private energy: EnergySpender,
  ) {
    this.rng = (deps.seed ?? 7) >>> 0 || 7;
    for (let i = 0; i < MAX_BOLTS; i++)
      this.bolts.push({
        live: false,
        dying: 0,
        x: 0,
        y: 0,
        z: 0,
        px: 0,
        py: 0,
        pz: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        ox: 0,
        oy: 0,
        oz: 0,
        life: 0,
        target: null,
        scale: 1,
        width: 1,
        trail: new Float32Array(TRAIL * 3),
        head: 0,
        count: 0,
      });
    for (let i = 0; i < MAX_SPLATS; i++) this.splats.push({ t: 1, x: 0, y: 0, z: 0, s: 1, rot: 0 });
    const L = deps.tuning.combatPlus.lasso;
    this.lx = new Float32Array(L.maxPoints);
    this.lz = new Float32Array(L.maxPoints);
    this.lt = new Float32Array(L.maxPoints);
    this.loop = makeLoopResult(L.maxPoints);
    deps.events.on('enemy:telegraph', (e) => {
      if (this.tele.size > 64)
        for (const [id, until] of this.tele) if (until < this.time) this.tele.delete(id);
      this.tele.set(e.id, this.time + e.duration + deps.tuning.combatPlus.telegraphGrace);
    });
    deps.events.on('enemy:died', (e) => {
      this.tele.delete(e.id);
      this.marks.delete(e.id);
    });
    deps.events.on('player:dash', (e) => this.lassoPush(e.from[0], e.from[2]));

    const ink = new THREE.Color(PAL.ink);
    const core = new THREE.Color(PAL.glowCore);
    const edge = new THREE.Color(PAL.glowEdge);

    // Heads: stretched ink drop with a gold core.
    const headMat = new THREE.ShaderMaterial({
      uniforms: { ink: { value: ink }, core: { value: core } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main(){
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position,1.);
          vN = normalize(normalMatrix * mat3(instanceMatrix) * normal); vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 ink, core; varying vec3 vN; varying vec3 vV;
        void main(){
          float f = abs(dot(normalize(vN), normalize(vV)));
          gl_FragColor = vec4(mix(ink, core, step(0.72, f)), 1.);
        }`,
    });
    this.heads = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.13, 1), headMat, MAX_BOLTS);
    this.heads.count = 0;
    this.heads.frustumCulled = false;

    // Trails: one merged triangle-strip-as-triangles buffer, flat on XZ (camera is top-down-ish).
    const verts = MAX_BOLTS * TRAIL * 2;
    this.trailPos = new Float32Array(verts * 3);
    this.trailT = new Float32Array(verts);
    const idx: number[] = [];
    for (let b = 0; b < MAX_BOLTS; b++) {
      for (let i = 0; i < TRAIL - 1; i++) {
        const a = (b * TRAIL + i) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.trailGeo.setAttribute(
      'aT',
      new THREE.BufferAttribute(this.trailT, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.trailGeo.setIndex(idx);
    const trailMat = new THREE.ShaderMaterial({
      uniforms: { ink: { value: ink }, edge: { value: edge }, core: { value: core } },
      vertexShader: /* glsl */ `
        attribute float aT; varying float vT; varying float vSide;
        void main(){ vT = aT; vSide = float(gl_VertexID % 2); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 ink, edge, core; varying float vT; varying float vSide;
        void main(){
          if (vT < 0.0) discard;
          // dry-brush breakup toward the tail
          float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453);
          if (n < vT * vT * 0.7) discard;
          float centre = 1.0 - abs(vSide - 0.5) * 2.0;
          vec3 c = vT < 0.25 && centre > 0.55 ? core : (vT < 0.5 && centre > 0.7 ? edge : ink);
          gl_FragColor = vec4(c, 1.);
        }`,
      side: THREE.DoubleSide,
    });
    const trail = new THREE.Mesh(this.trailGeo, trailMat);
    trail.frustumCulled = false;
    trail.layers.set(1);
    this.trailT.fill(-1);

    // Splats: flat ink star on the ground/target, expanding then shrinking.
    const splatMat = new THREE.ShaderMaterial({
      uniforms: { ink: { value: ink }, core: { value: core } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position,1.); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 ink, core; varying vec2 vUv;
        void main(){
          vec2 q = vUv*2.-1.; float r = length(q); float a = atan(q.y, q.x);
          float spikes = 0.55 + 0.25*sin(a*7.0) + 0.12*sin(a*13.0+1.3);
          if (r > spikes) discard;
          gl_FragColor = vec4(r < 0.22 ? core : ink, 1.);
        }`,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.splatMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      splatMat,
      MAX_SPLATS,
    );
    this.splatMesh.count = 0;
    this.splatMesh.frustumCulled = false;
    this.splatMesh.layers.set(1);

    this.object.name = 'combat';
    this.object.add(this.heads, trail, this.splatMesh);
  }

  get liveBolts(): number {
    let n = 0;
    for (const b of this.bolts) if (b.live) n++;
    return n;
  }

  /** Is `t` winding up an attack right now (its own flag, or a telegraph we heard)? */
  isAttacking(t: Damageable): boolean {
    return t.attacking === true || (this.tele.get(t.id) ?? -1) > this.time;
  }

  /** Marked by a Flare for a guaranteed crit. */
  isMarked(t: Damageable): boolean {
    return (this.marks.get(t.id) ?? -1) > this.time;
  }

  /** Current kill chain (0 when it has lapsed). */
  get killChain(): number {
    return this.time - this.lastKillT <= this.deps.tuning.combatPlus.chainWindow ? this.chain : 0;
  }

  step(dt: number): void {
    const T = this.deps.tuning;
    const B = T.bolt;
    this.time += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.buffer > 0) this.buffer -= dt;
    if (this.deps.input.state.boltPressed) this.buffer = B.buffer;
    const p = this.player;
    if (this.buffer > 0 && p.verbCut.bolt) {
      // the Editor struck out bolts: swallow the tap with a fizzle
      this.buffer = 0;
      p.fizzle();
    }
    if (this.buffer > 0 && this.cooldown <= 0 && this.pendingFire < 0 && p.canAct && !p.dashing)
      this.tryFire();
    this.stepDashVerbs();
    this.stepFlare();
    this.expireLasso();

    if (this.pendingFire >= 0) {
      this.pendingFire -= dt;
      if (this.pendingFire < 0) this.spawnBolt();
    }

    for (const b of this.bolts) if (b.live) this.stepBolt(b, dt);
    for (const s of this.splats) if (s.t < 1) s.t = Math.min(1, s.t + dt / 0.34);
  }

  private tryFire(): void {
    const T = this.deps.tuning;
    const B = T.bolt;
    this.buffer = 0;
    const onBeat = !!this.deps.beat?.()?.onBeat();
    const cost = onBeat ? 0 : B.cost * (T.difficulty[this.deps.settings.difficulty]?.energyCost ?? 1);
    if (!this.energy.spend(cost)) {
      this.player.fizzle();
      this.cooldown = 0.25;
      return;
    }
    const target = this.pickTarget(B.maxRange);
    this.player.castTap(target ? target.position : null);
    this.pendingTarget = target;
    this.pendingScale = onBeat ? T.combatPlus.beatBoltScale : 1;
    if (onBeat) this.deps.events.emit('combat:onBeat', { action: 'bolt' });
    this.pendingFire = B.castDelay;
    this.cooldown = B.cooldown;
    if (this.deps.stats) this.deps.stats.boltsFired++;
    this.deps.events.emit('bolt:fire', { targetId: target ? target.id : null });
  }

  /**
   * Nearest revealed target, except Blots count as if 45% closer: they choke the crystal, so a
   * tap should go to them first (PLAN §3.3 "kill it first"). Targets without line of sight are
   * skipped.
   */
  private pickTarget(maxRange: number): Damageable | null {
    this.pickBest = null;
    this.pickScore = maxRange * maxRange;
    this.deps.targets.forEach(this.pickScan);
    return this.pickBest;
  }

  private pickBest: Damageable | null = null;
  private pickScore = 0;
  private readonly pickScan = (t: Damageable) => {
    if (!t.alive || !t.revealed) return;
    const p = this.player.position;
    const dx = t.position.x - p.x;
    const dz = t.position.z - p.z;
    const edge = Math.max(0, Math.sqrt(dx * dx + dz * dz) - t.radius);
    // Blots choke the crystal; a scribbler mid wind-up is about to shoot (a hit cancels the shot)
    const e = t as Target;
    const C = this.deps.tuning.combatPlus;
    let k = e.kind === 'blot' ? 0.55 : e.kind === 'scribbler' && (e.windup ?? 0) > 0.1 ? 0.6 : 1;
    // Close-Up Crits: a ghost mid-attack (or marked by a flare) is the one worth shooting
    if (this.isAttacking(t)) k = Math.min(k, C.attackAimBias);
    else if (this.isMarked(t)) k = Math.min(k, C.markedAimBias);
    const score = edge * k * (edge * k);
    // never auto-aim a ghost through a wall / the gate (the bolt would splat on it). Boss weak
    // points sit on the Editor's own body, which is itself a LOS blocker, so they're exempt.
    if (
      e.kind !== undefined &&
      edge > 1.5 &&
      !this.deps.collision.segmentClear(p.x, p.z, t.position.x, t.position.z)
    )
      return;
    if (edge <= this.deps.tuning.bolt.maxRange && score <= this.pickScore) {
      this.pickScore = score;
      this.pickBest = t;
    }
  };

  private spawnBolt(): void {
    const b = this.bolts.find((x) => !x.live) ?? null;
    if (!b) return;
    const B = this.deps.tuning.bolt;
    const c = this.player.crystalPos;
    b.live = true;
    b.dying = 0;
    b.x = b.px = b.ox = c.x;
    b.y = b.py = b.oy = c.y;
    b.z = b.pz = b.oz = c.z;
    b.target = this.pendingTarget;
    b.scale = this.pendingScale;
    const C = this.deps.tuning.combatPlus;
    b.width = Math.min(C.trailWidthMax, (1 + this.killChain * C.trailWidthPerChain) * b.scale);
    if (b.target?.alive) {
      _d.set(b.target.position.x - c.x, b.target.position.y + 0.6 - c.y, b.target.position.z - c.z);
    } else {
      const f = this.player.facing;
      _d.set(f.x, -0.12, f.z);
    }
    _d.normalize().multiplyScalar(B.speed);
    // launch slightly upward for an arc that the homing then pulls down
    b.vx = _d.x;
    b.vy = _d.y + 1.2;
    b.vz = _d.z;
    b.life = (B.maxRange / B.speed) * 1.4;
    b.head = 0;
    b.count = 0;
    this.pushTrail(b);
    this.sfx('bolt_fire', c.x, c.y, c.z);
  }

  private stepBolt(b: Bolt, dt: number): void {
    const B = this.deps.tuning.bolt;
    b.px = b.x;
    b.py = b.y;
    b.pz = b.z;
    if (b.dying > 0) {
      b.dying -= dt;
      // trail drains into the head
      if (b.count > 1) b.count--;
      if (b.dying <= 0) b.live = false;
      return;
    }
    b.life -= dt;
    const t = b.target;
    if (t?.alive && t.revealed) {
      _d.set(t.position.x - b.x, t.position.y + 0.6 - b.y, t.position.z - b.z)
        .normalize()
        .multiplyScalar(B.speed);
      const k = 1 - Math.exp(-B.homing * dt);
      b.vx += (_d.x - b.vx) * k;
      b.vy += (_d.y - b.vy) * k;
      b.vz += (_d.z - b.vz) * k;
    } else b.vy -= 3 * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    this.pushTrail(b);

    // hit scan against all revealed targets
    this.scanBolt = b;
    this.scanHit = null;
    this.scanBest = Infinity;
    this.deps.targets.forEach(this.scan);
    if (this.scanHit) {
      this.hit(b, this.scanHit);
      return;
    }
    const g = this.deps.collision.groundHeight(b.x, b.z);
    const _o = this.splatOut;
    if (b.y < g + 0.05 || this.deps.collision.resolveCircle(b.x, b.z, 0.08, _o) || b.life <= 0) {
      this.kill(b, Math.max(b.y, g + 0.02), b.life > 0 ? 0.7 : 0.4);
    }
  }

  private splatOut = new THREE.Vector2();

  private hit(b: Bolt, t: Damageable): void {
    const T = this.deps.tuning;
    const B = T.bolt;
    const C = T.combatPlus;
    const marked = this.isMarked(t);
    const r = critRule((t as Target).hp, B.damage, B.critDamageMul, this.isAttacking(t) || marked);
    const kill = r.kill;
    const critical = r.critical;
    // knockback along the bolt: report the hit as coming from behind the target on the bolt's line
    let dx = b.vx;
    let dz = b.vz;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    _from.set(t.position.x - dx * C.knockbackFrom, t.position.y, t.position.z - dz * C.knockbackFrom);
    t.hit(r.damage, _from);
    if (critical) this.marks.delete(t.id);
    const chain = kill ? this.onKill() : this.killChain;
    const ev = this.deps.events;
    const hp_ = this.hitPayload;
    hp_.enemyId = t.id;
    hp_.position[0] = b.x;
    hp_.position[1] = b.y;
    hp_.position[2] = b.z;
    hp_.critical = critical;
    hp_.kill = kill;
    hp_.chain = chain;
    hp_.dir[0] = dx;
    hp_.dir[1] = dz;
    ev.emit('bolt:hit', hp_);
    if (this.deps.stats) this.deps.stats.boltsHit++;
    if (kill) this.hitSfx(b.x, b.y, b.z, chainRate(chain, C.chainMaxSemitones));
    else this.sfx('bolt_hit', b.x, b.y, b.z);
    if (critical && this.time - this.lastPanel >= C.critMinGap) {
      this.lastPanel = this.time;
      ev.emit('fx:panelCut', {
        word: 'krak',
        focus: [t.position.x, t.position.y + 1, t.position.z],
        reason: 'critical',
      });
      haptics.pulse(T.haptics.crit, 0);
    } else {
      const H = C.hitStop;
      ev.emit('fx:hitstop', { duration: critical ? H.crit : kill ? H.kill : H.hit });
      ev.emit('fx:shake', { intensity: critical ? 0.3 : kill ? 0.22 : 0.1, duration: 0.15 });
    }
    this.kill(b, b.y, (critical ? 1.6 : 1) * b.scale);
  }

  /** Register a player kill: chain bookkeeping + thock. Returns the chain length. */
  private onKill(): number {
    const C = this.deps.tuning.combatPlus;
    this.chain = this.time - this.lastKillT <= C.chainWindow ? this.chain + 1 : 1;
    this.lastKillT = this.time;
    haptics.pulse(C.thockMs, 0);
    return this.chain;
  }

  private hitSfx(x: number, y: number, z: number, rate: number): void {
    const a = this.deps.audio;
    if (!a) {
      this.sfx('bolt_hit', x, y, z);
      return;
    }
    _sfxPos.set(x, y, z);
    a.play('bolt_hit', { position: _sfxPos, rate });
  }

  // ───────── Dash-Strike Nib + Ink Parry ─────────

  private stepDashVerbs(): void {
    const p = this.player;
    const C = this.deps.tuning.combatPlus;
    const dodged = p.consumeParry();
    if (p.dashing) {
      if (p.dashSerial !== this.nibSerial) {
        this.nibSerial = p.dashSerial;
        this.nibN = 0;
        this.parried = false;
      }
      this.deps.targets.forEach(this.nibScan);
      const age = p.dashAge;
      if (
        !this.parried &&
        age >= 0 &&
        age <= C.parry.window &&
        this.time - this.lastParry >= C.parry.cooldown &&
        (dodged || this.threatNear())
      )
        this.parry();
    } else if (this.wasDashing) this.lassoPush(p.position.x, p.position.z);
    this.wasDashing = p.dashing;
  }

  private readonly nibScan = (t: Damageable) => {
    const e = t as Target;
    if (!t.alive || !t.revealed || e.kind === undefined) return;
    const p = this.player;
    const C = this.deps.tuning.combatPlus;
    for (let i = 0; i < this.nibN; i++) if (this.nibIds[i] === t.id) return;
    const dx = t.position.x - p.position.x;
    const dz = t.position.z - p.position.z;
    const r = t.radius + this.deps.tuning.player.radius + C.nib.reach;
    if (dx * dx + dz * dz > r * r) return;
    if (this.nibN < MAX_NIB) this.nibIds[this.nibN++] = t.id;
    const vl = Math.hypot(p.velocity.x, p.velocity.z) || 1;
    const kb = C.knockbackFrom / vl;
    _from.set(t.position.x - p.velocity.x * kb, t.position.y, t.position.z - p.velocity.z * kb);
    const hp = e.hp;
    t.hit(C.nib.damage, _from);
    const kill = (typeof hp === 'number' && hp <= C.nib.damage) || !t.alive;
    const ev = this.deps.events;
    ev.emit('combat:nib', { id: t.id, kill });
    if (kill) {
      p.resetDashCooldown();
      const chain = this.onKill();
      this.hitSfx(t.position.x, t.position.y + 0.6, t.position.z, chainRate(chain, C.chainMaxSemitones));
      ev.emit('fx:hitstop', { duration: C.hitStop.kill });
    } else {
      this.sfx('bolt_hit', t.position.x, t.position.y + 0.6, t.position.z);
      ev.emit('fx:hitstop', { duration: C.hitStop.hit });
    }
  };

  /** A projectile or an attacking ghost is about to touch the dashing player. */
  private threatNear(): boolean {
    const p = this.player.position;
    const T = this.deps.tuning;
    const pr = this.projectiles;
    if (pr) {
      const r = T.player.radius + T.enemies.scribblerAi.projectileRadius + T.combatPlus.parry.probe;
      for (let i = 0; i < pr.capacity; i++) {
        if (!pr.active[i]) continue;
        const dx = pr.x[i]! - p.x;
        const dz = pr.z[i]! - p.z;
        if (dx * dx + dz * dz <= r * r) return true;
      }
    }
    this.threat = false;
    this.deps.targets.forEach(this.threatScan);
    return this.threat;
  }

  private readonly threatScan = (t: Damageable) => {
    if (this.threat || !t.alive || (t as Target).kind === undefined || !this.isAttacking(t)) return;
    const p = this.player.position;
    const dx = t.position.x - p.x;
    const dz = t.position.z - p.z;
    const r = t.radius + this.deps.tuning.player.radius + this.deps.tuning.combatPlus.parry.probe;
    if (dx * dx + dz * dz <= r * r) this.threat = true;
  };

  private parry(): void {
    const C = this.deps.tuning.combatPlus;
    const p = this.player;
    this.parried = true;
    this.lastParry = this.time;
    p.addEnergy(C.parry.refund);
    const pl = this.parryPayload;
    pl.position[0] = p.position.x;
    pl.position[1] = p.position.y;
    pl.position[2] = p.position.z;
    this.deps.events.emit('combat:parry', pl);
    this.sfx('crystal_on', p.position.x, p.position.y + 1, p.position.z);
    haptics.pulse(this.deps.tuning.haptics.crit, 0);
  }

  // ───────── Snuff & Flare ─────────

  private stepFlare(): void {
    const p = this.player;
    const f = p.flare01;
    if (f >= 0) {
      if (!this.flaring) {
        this.flaring = true;
        this.caughtN = 0;
      }
      const T = this.deps.tuning;
      this.flareR = T.crystal.radiusHeld * p.radiusMul * (1 - (1 - f) ** 3);
      this.caughtUntil = this.time + T.combatPlus.snuff.flareTime + 0.4;
      this.deps.targets.forEach(this.flareScan);
    } else if (this.flaring) {
      this.flaring = false;
      this.deps.events.emit('crystal:flare', { caught: this.caughtN });
    }
    // stun what the edge swept as soon as it is actually revealed (hit() ignores hidden ghosts)
    if (this.caughtN > 0 && this.time <= this.caughtUntil) {
      for (let i = 0; i < this.caughtN; i++) {
        const t = this.caught[i];
        if (!t || this.caughtApplied[i]) continue;
        if (t.stun || (t.alive && t.revealed)) {
          this.caughtApplied[i] = 1;
          this.stun(t, this.player.position);
        }
      }
    }
  }

  private readonly flareScan = (t: Damageable) => {
    if (!t.alive || (t as Target).kind === undefined || this.caughtN >= MAX_CAUGHT) return;
    const c = this.player.crystalPos;
    const dx = t.position.x - c.x;
    const dz = t.position.z - c.z;
    const r = this.flareR + t.radius;
    if (dx * dx + dz * dz > r * r) return;
    for (let i = 0; i < this.caughtN; i++) if (this.caught[i] === t) return;
    this.caught[this.caughtN] = t;
    this.caughtApplied[this.caughtN++] = 0;
    this.marks.set(t.id, this.time + this.deps.tuning.combatPlus.snuff.markTime);
  };

  private stun(t: Damageable, from: THREE.Vector3): void {
    const s = this.deps.tuning.combatPlus.snuff.stunTime;
    if (t.stun) t.stun(s);
    else if (t.alive && t.revealed) t.hit(0, from); // fallback: at least interrupts the windup
  }

  // ───────── Frame Lasso ─────────

  private lassoPush(x: number, z: number): void {
    const L = this.deps.tuning.combatPlus.lasso;
    const n = this.ln;
    if (n > 0) {
      const dx = this.lx[n - 1]! - x;
      const dz = this.lz[n - 1]! - z;
      if (dx * dx + dz * dz < L.minSpacing * L.minSpacing) return;
    }
    if (n >= L.maxPoints) this.lassoDrop(1);
    this.lx[this.ln] = x;
    this.lz[this.ln] = z;
    this.lt[this.ln++] = this.time;
    if (this.time - this.lastLasso < L.cooldown) return;
    if (!detectLoop(this.lx, this.lz, this.ln, L.closeDist, L.minArea, this.loop)) return;
    this.lassoIds.length = 0;
    this.deps.targets.forEach(this.lassoScan);
    if (this.lassoIds.length === 0) {
      // empty loop: forget it so it can't re-trigger, keep the newest point to draw on from
      this.lassoDrop(this.ln - 1);
      return;
    }
    const lp = this.loop;
    this.lastLasso = this.time;
    this.lastPanel = this.time;
    this.lassoDrop(this.ln);
    const y = this.deps.collision.groundHeight(lp.cx, lp.cz);
    const ev = this.deps.events;
    ev.emit('combat:lasso', { ids: this.lassoIds.slice(), center: [lp.cx, y, lp.cz], area: lp.area });
    ev.emit('fx:panelCut', { word: 'kachunk', focus: [lp.cx, y + 1, lp.cz], reason: 'lasso' });
    haptics.pulse(this.deps.tuning.haptics.crit, 0);
  }

  private readonly lassoScan = (t: Damageable) => {
    if (!t.alive || !t.revealed || (t as Target).kind === undefined) return;
    if (!pointInLoop(t.position.x, t.position.z, this.loop)) return;
    const L = this.deps.tuning.combatPlus.lasso;
    this.lassoIds.push(t.id);
    _from.set(this.loop.cx, t.position.y, this.loop.cz);
    const hp = (t as Target).hp;
    t.hit(L.damage, _from);
    if ((typeof hp === 'number' && hp <= L.damage) || !t.alive) this.onKill();
    else this.stun(t, _from);
  };

  private expireLasso(): void {
    const life = this.deps.tuning.combatPlus.lasso.life;
    let k = 0;
    while (k < this.ln && this.time - this.lt[k]! > life) k++;
    if (k > 0) this.lassoDrop(k);
  }

  private lassoDrop(k: number): void {
    if (k <= 0) return;
    if (k >= this.ln) {
      this.ln = 0;
      return;
    }
    this.lx.copyWithin(0, k, this.ln);
    this.lz.copyWithin(0, k, this.ln);
    this.lt.copyWithin(0, k, this.ln);
    this.ln -= k;
  }

  /** Lasso polyline length (debug / tests). */
  get lassoPoints(): number {
    return this.ln;
  }

  private kill(b: Bolt, y: number, size: number): void {
    b.dying = 0.12;
    this.addSplat(b.x, y, b.z, size);
    this.lassoPush(b.x, b.z);
  }

  private addSplat(x: number, y: number, z: number, s: number): void {
    const sp = this.splats[this.splatIdx++ % MAX_SPLATS]!;
    sp.t = 0;
    sp.x = x;
    sp.y = y;
    sp.z = z;
    sp.s = s;
    sp.rot = this.rand() * Math.PI * 2;
  }

  private pushTrail(b: Bolt): void {
    const o = b.head * 3;
    b.trail[o] = b.x;
    b.trail[o + 1] = b.y;
    b.trail[o + 2] = b.z;
    b.head = (b.head + 1) % TRAIL;
    if (b.count < TRAIL) b.count++;
  }

  /** Update GPU buffers. Call once per rendered frame. */
  render(alpha: number): void {
    let n = 0;
    const pos = this.trailPos;
    const tt = this.trailT;
    for (let bi = 0; bi < MAX_BOLTS; bi++) {
      const b = this.bolts[bi]!;
      const base = bi * TRAIL * 2;
      if (!b.live) {
        for (let i = 0; i < TRAIL * 2; i++) tt[base + i] = -1;
        continue;
      }
      const hx = b.px + (b.x - b.px) * alpha;
      const hy = b.py + (b.y - b.py) * alpha;
      const hz = b.pz + (b.z - b.pz) * alpha;
      if (b.dying <= 0) {
        const sp = Math.hypot(b.vx, b.vy, b.vz) || 1;
        _d.set(b.vx / sp, b.vy / sp, b.vz / sp);
        _q.setFromUnitVectors(_fwd, _d);
        _s.set(0.8 * b.scale, 0.8 * b.scale, 1.9 * b.scale);
        _p.set(hx, hy, hz);
        _m.compose(_p, _q, _s);
        this.heads.setMatrixAt(n++, _m);
      }
      // ribbon: newest point first (head), flat side vector in XZ
      const cnt = b.count;
      for (let i = 0; i < TRAIL; i++) {
        const v = base + i * 2;
        if (i >= cnt) {
          tt[v] = tt[v + 1] = -1;
          continue;
        }
        const k = ((b.head - 1 - i + TRAIL * 2) % TRAIL) * 3;
        let x = b.trail[k]!;
        let y = b.trail[k + 1]!;
        let z = b.trail[k + 2]!;
        if (i === 0) {
          x = hx;
          y = hy;
          z = hz;
        }
        const k2 = ((b.head - 1 - Math.min(i + 1, cnt - 1) + TRAIL * 2) % TRAIL) * 3;
        let dx = x - b.trail[k2]!;
        let dz = z - b.trail[k2 + 2]!;
        const dl = Math.hypot(dx, dz) || 1;
        dx /= dl;
        dz /= dl;
        const f = i / (TRAIL - 1);
        const w = (0.11 * (1 - f) ** 0.7 + 0.01) * b.width;
        const o = v * 3;
        pos[o] = x - dz * w;
        pos[o + 1] = y;
        pos[o + 2] = z + dx * w;
        pos[o + 3] = x + dz * w;
        pos[o + 4] = y;
        pos[o + 5] = z - dx * w;
        tt[v] = tt[v + 1] = f;
      }
    }
    this.heads.count = n;
    this.heads.instanceMatrix.needsUpdate = n > 0;
    (this.trailGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeo.attributes.aT as THREE.BufferAttribute).needsUpdate = true;

    let m = 0;
    for (const s of this.splats) {
      if (s.t >= 1) continue;
      const e = s.t < 0.3 ? s.t / 0.3 : 1 - (s.t - 0.3) / 0.7;
      const sc = (0.3 + 0.9 * Math.sqrt(Math.max(0, e))) * s.s;
      _q.setFromAxisAngle(_up, s.rot);
      _s.set(sc, 1, sc);
      _p.set(s.x, s.y + 0.03, s.z);
      _m.compose(_p, _q, _s);
      this.splatMesh.setMatrixAt(m++, _m);
    }
    this.splatMesh.count = m;
    this.splatMesh.instanceMatrix.needsUpdate = m > 0;
  }

  clear(): void {
    for (const b of this.bolts) b.live = false;
    for (const s of this.splats) s.t = 1;
    this.pendingFire = -1;
    this.ln = 0;
    this.caughtN = 0;
    this.flaring = false;
    this.marks.clear();
    this.tele.clear();
  }

  private rand(): number {
    // mulberry32
    this.rng = (this.rng + 0x6d2b79f5) >>> 0;
    let t = this.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private sfx(id: SfxId, x: number, y: number, z: number): void {
    const p = this.sfxPayload;
    p.id = id;
    p.position[0] = x;
    p.position[1] = y;
    p.position[2] = z;
    this.deps.events.emit('sfx:play', p);
  }
}

/** main.ts wiring: after installPlayer + energy. */
export function installCombat(ctx: GameContext, player: Player, energy: EnergySpender, seed = 7): Combat {
  const c = new Combat(
    {
      events: ctx.events,
      tuning: ctx.tuning,
      settings: ctx.settings,
      input: ctx.input,
      targets: ctx.targets,
      collision: ctx.collision,
      stats: ctx.stats,
      seed,
      audio: ctx.audio,
      beat: () => ctx.beat,
    },
    player,
    energy,
  );
  ctx.render.scene.add(c.object);
  return c;
}
