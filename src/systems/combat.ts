/**
 * Ink bolts (PLAN §3.2): tap fires at the nearest *revealed* target (TargetRegistry), costs ink,
 * homes softly, leaves a brush-stroke trail, splats on impact. Killing blows can be critical →
 * `fx:panelCut`. All pooled; one draw call each for heads, trails and splats.
 */
import * as THREE from 'three';
import type { EventBus, GameEvents } from '../core/events';
import { haptics } from '../core/input/haptics';
import type {
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
  /** Seed for crit rolls (deterministic e2e). */
  seed?: number;
}

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
  private lastCrit = -1e9;
  private kills = 0;
  private time = 0;
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
    const r = t.radius + this.deps.tuning.bolt.hitRadius;
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
        trail: new Float32Array(TRAIL * 3),
        head: 0,
        count: 0,
      });
    for (let i = 0; i < MAX_SPLATS; i++) this.splats.push({ t: 1, x: 0, y: 0, z: 0, s: 1, rot: 0 });

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

  step(dt: number): void {
    const T = this.deps.tuning;
    const B = T.bolt;
    this.time += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.buffer > 0) this.buffer -= dt;
    if (this.deps.input.state.boltPressed) this.buffer = B.buffer;
    const p = this.player;
    if (this.buffer > 0 && this.cooldown <= 0 && this.pendingFire < 0 && p.canAct && !p.dashing)
      this.tryFire();

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
    const cost = B.cost * (T.difficulty[this.deps.settings.difficulty]?.energyCost ?? 1);
    if (!this.energy.spend(cost)) {
      this.player.fizzle();
      this.cooldown = 0.25;
      return;
    }
    const target = this.pickTarget(B.maxRange);
    this.player.castTap(target ? target.position : null);
    this.pendingTarget = target;
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
    const e = t as Damageable & { kind?: string; windup?: number };
    const k = e.kind === 'blot' ? 0.55 : e.kind === 'scribbler' && (e.windup ?? 0) > 0.1 ? 0.6 : 1;
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
    const hp = (t as Damageable & { hp?: number }).hp;
    const kill = typeof hp === 'number' && hp <= B.damage;
    let critical = false;
    if (kill) {
      const sinceCrit = this.time - this.lastCrit;
      const first = this.kills === 0;
      if (sinceCrit >= B.critMinInterval && (first || this.rand() < B.critKillChance)) critical = true;
      this.kills++;
    }
    const dmg = critical ? B.damage * B.critDamageMul : B.damage;
    _from.set(b.ox, b.oy, b.oz);
    t.hit(dmg, _from);
    const ev = this.deps.events;
    const hp_ = this.hitPayload;
    hp_.enemyId = t.id;
    hp_.position[0] = b.x;
    hp_.position[1] = b.y;
    hp_.position[2] = b.z;
    hp_.critical = critical;
    ev.emit('bolt:hit', hp_);
    if (this.deps.stats) this.deps.stats.boltsHit++;
    this.sfx('bolt_hit', b.x, b.y, b.z);
    if (critical) {
      this.lastCrit = this.time;
      ev.emit('fx:panelCut', {
        word: 'krak',
        focus: [t.position.x, t.position.y + 1, t.position.z],
        reason: 'critical',
      });
      haptics.pulse(T.haptics.crit, 0);
    } else {
      ev.emit('fx:hitstop', { duration: kill ? 0.06 : 0.035 });
      ev.emit('fx:shake', { intensity: kill ? 0.22 : 0.1, duration: 0.15 });
    }
    this.kill(b, b.y, critical ? 1.6 : 1);
  }

  private kill(b: Bolt, y: number, size: number): void {
    b.dying = 0.12;
    this.addSplat(b.x, y, b.z, size);
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
        _s.set(0.8, 0.8, 1.9);
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
        const w = 0.11 * (1 - f) ** 0.7 + 0.01;
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
    },
    player,
    energy,
  );
  ctx.render.scene.add(c.object);
  return c;
}
