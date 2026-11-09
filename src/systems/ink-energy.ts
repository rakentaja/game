/**
 * Ink energy (the crystal's fuel) and ink pickups (droplets dropped by inked ghosts and ink wells)
 * that scatter, settle, then get magnet-pulled into the crystal. Pure sim + one InstancedMesh.
 */
import * as THREE from 'three';
import type { EventBus, GameEvents } from '../core/events';
import type { EnemyKind, GameContext, PlayerAPI, RunStats } from '../core/types';
import { PAL } from '../data/palette';
import type { Tuning } from '../data/tuning';

export class InkEnergy {
  value: number;
  /** Extra capacity on top of tuning.energy.max (Inker "India" perk; run-scoped). */
  bonusMax = 0;
  private lastEmitted = -1;

  constructor(
    private events: EventBus<GameEvents> | null,
    private tuning: Tuning,
  ) {
    this.value = tuning.energy.start;
  }

  get max(): number {
    return this.tuning.energy.max + this.bonusMax;
  }

  get empty(): boolean {
    return this.value <= 0;
  }

  /** All-or-nothing spend (bolts). */
  spend(amount: number): boolean {
    if (amount <= 0) return true;
    if (this.value + 1e-6 < amount) return false;
    this.value = Math.max(0, this.value - amount);
    this.emit();
    return true;
  }

  /** Continuous drain (crystal). Returns the amount actually drained. */
  drain(amount: number): number {
    const d = Math.min(this.value, Math.max(0, amount));
    this.value -= d;
    if (this.value < 1e-4) this.value = 0;
    this.emit();
    return d;
  }

  /** Returns the amount actually added. */
  add(amount: number): number {
    const before = this.value;
    this.value = Math.min(this.max, this.value + Math.max(0, amount));
    this.emit();
    return this.value - before;
  }

  regen(dt: number): void {
    const r = this.tuning.energy.regenPerSec;
    if (r > 0 && this.value < this.max) this.add(r * dt);
  }

  reset(value = this.tuning.energy.start): void {
    this.value = Math.min(this.max, value);
    this.lastEmitted = -1;
    this.emit();
  }

  /** Emit `energy:changed` when the displayed (integer) value changes, or at the bounds. */
  private emit(): void {
    const shown = this.value <= 0 ? 0 : this.value >= this.max ? this.max : Math.ceil(this.value);
    if (shown === this.lastEmitted) return;
    this.lastEmitted = shown;
    this.events?.emit('energy:changed', { value: shown, max: this.max });
  }
}

// ───────────────────────────── Pickups ─────────────────────────────

enum P {
  Free = 0,
  Scatter = 1,
  Rest = 2,
  Magnet = 3,
}

interface Pickup {
  state: P;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  amount: number;
  t: number;
  phase: number;
  speed: number;
}

export interface PickupDeps {
  events: EventBus<GameEvents>;
  tuning: Tuning;
  stats?: RunStats;
  groundHeight?: (x: number, z: number) => number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();

function dropletGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const n = 9;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // teardrop: round bottom, pointed top
    const a = t * Math.PI;
    const r = Math.sin(a) * (1 - t * 0.55) * 0.16;
    pts.push(new THREE.Vector2(r, -Math.cos(a) * 0.19 + t * 0.1));
  }
  return new THREE.LatheGeometry(pts, 8);
}

export class InkPickups {
  readonly mesh: THREE.InstancedMesh;
  private pool: Pickup[] = [];
  private seed = 1;
  private combo = 0;
  private comboT = 0;
  private sfx = { id: 'ink_pickup' as const, position: [0, 0, 0] as [number, number, number], volume: 0.8 };

  constructor(private deps: PickupDeps) {
    const n = deps.tuning.energy.maxPickups;
    for (let i = 0; i < n; i++)
      this.pool.push({
        state: P.Free,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        amount: 0,
        t: 0,
        phase: 0,
        speed: 0,
      });
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ink: { value: new THREE.Color(PAL.ink) },
        gold: { value: new THREE.Color(PAL.glowCore) },
        ember: { value: new THREE.Color(PAL.glowEdge) },
        paper: { value: new THREE.Color(PAL.paper) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main(){
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 ink, gold, ember, paper; varying vec3 vN; varying vec3 vV;
        void main(){
          vec3 n = normalize(vN);
          float f = dot(n, normalize(vV));
          // liquid-gold ink drop: ember shadow band, paper glint, inked contour (palette only)
          float lit = dot(n, normalize(vec3(-0.4, 0.7, 0.6)));
          vec3 c = lit > -0.1 ? gold : ember;
          c = mix(c, paper, step(0.9, lit));
          gl_FragColor = vec4(mix(c, ink, step(f, 0.34)), 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(dropletGeometry(), mat, n);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'ink-pickups';
    deps.events.on('enemy:died', (e) => this.onEnemyDied(e.kind, e.position));
  }

  get active(): number {
    let c = 0;
    for (const p of this.pool) if (p.state !== P.Free) c++;
    return c;
  }

  /** Burst `total` energy as droplets around (x,y,z). */
  spawn(x: number, y: number, z: number, total: number): void {
    const v = this.deps.tuning.energy.dropletValue;
    let left = total;
    while (left > 0) {
      const p = this.alloc();
      if (!p) return;
      const amt = Math.min(v, left);
      left -= amt;
      const a = this.rand() * Math.PI * 2;
      const sp = 1.5 + this.rand() * 2.5;
      p.state = P.Scatter;
      p.x = x;
      p.y = y + 0.6;
      p.z = z;
      p.vx = Math.cos(a) * sp;
      p.vz = Math.sin(a) * sp;
      p.vy = 3 + this.rand() * 2.5;
      p.amount = amt;
      p.t = 0;
      p.phase = this.rand() * 6.28;
      p.speed = 0;
    }
  }

  clear(): void {
    for (const p of this.pool) p.state = P.Free;
    this.mesh.count = 0;
  }

  step(dt: number, player: PlayerAPI | null, addEnergy: (n: number) => number): void {
    const E = this.deps.tuning.energy;
    const gh = this.deps.groundHeight;
    this.comboT -= dt;
    if (this.comboT <= 0) this.combo = 0;
    const px = player?.position.x ?? 0;
    const py = (player?.position.y ?? 0) + 1.1;
    const pz = player?.position.z ?? 0;
    const full = player ? player.energy >= E.max - 0.01 : true;
    for (const p of this.pool) {
      if (p.state === P.Free) continue;
      p.t += dt;
      const g = gh ? gh(p.x, p.z) : 0;
      if (p.state === P.Scatter) {
        p.vy -= 18 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.vx *= 1 - 2.5 * dt;
        p.vz *= 1 - 2.5 * dt;
        if (p.y < g + 0.15) {
          p.y = g + 0.15;
          if (Math.abs(p.vy) > 1.2) p.vy = -p.vy * 0.35;
          else {
            p.vy = 0;
            p.state = P.Rest;
          }
        }
      }
      if (!player || full) {
        if (p.state === P.Magnet) p.state = P.Rest;
        if (p.state === P.Rest) p.y = g + 0.22 + Math.sin(p.t * 3 + p.phase) * 0.06;
        continue;
      }
      const dx = px - p.x;
      const dy = py - p.y;
      const dz = pz - p.z;
      const d = Math.hypot(dx, dy, dz);
      if (p.state !== P.Magnet && p.t > 0.25 && d < E.magnetRadius) p.state = P.Magnet;
      if (p.state === P.Rest) p.y = g + 0.22 + Math.sin(p.t * 3 + p.phase) * 0.06;
      else if (p.state === P.Magnet) {
        p.speed = Math.min(E.magnetSpeed * 2.2, p.speed + E.magnetSpeed * 3 * dt);
        const s = Math.min(d, (E.magnetSpeed + p.speed) * dt);
        // slight orbit so droplets spiral in rather than beeline
        const ox = -dz * 0.35;
        const oz = dx * 0.35;
        const k = s / Math.max(d, 1e-4);
        p.x += (dx + ox) * k;
        p.y += dy * k;
        p.z += (dz + oz) * k;
        if (d < E.pickupRadius) this.collect(p, addEnergy);
      }
    }
  }

  /** Write instance matrices (call once per rendered frame). */
  render(time: number): void {
    let n = 0;
    for (const p of this.pool) {
      if (p.state === P.Free) continue;
      const stretch = p.state === P.Magnet ? 1 + Math.min(0.8, p.speed * 0.06) : 1;
      const sq = p.state === P.Scatter ? 1 + Math.min(0.4, Math.abs(p.vy) * 0.05) : 1;
      _e.set(0, time * 2.2 + p.phase, p.state === P.Magnet ? 0.4 : 0);
      _q.setFromEuler(_e);
      _s.set(1 / Math.sqrt(stretch * sq), stretch * sq, 1 / Math.sqrt(stretch * sq));
      _p.set(p.x, p.y, p.z);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(n++, _m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = n > 0;
  }

  private collect(p: Pickup, addEnergy: (n: number) => number): void {
    p.state = P.Free;
    const got = addEnergy(p.amount);
    const st = this.deps.stats;
    if (st) st.inkCollected += got;
    this.combo = Math.min(this.combo + 1, 12);
    this.comboT = 0.45;
    this.sfx.position[0] = p.x;
    this.sfx.position[1] = p.y;
    this.sfx.position[2] = p.z;
    this.sfx.volume = 0.55 + Math.min(0.35, this.combo * 0.03);
    this.deps.events.emit('sfx:play', this.sfx);
    this.deps.events.emit('ink:collected', { amount: got, total: st?.inkCollected ?? 0 });
  }

  private onEnemyDied(kind: EnemyKind, pos: [number, number, number]): void {
    const drop = this.deps.tuning.enemies[kind]?.inkDrop ?? 0;
    if (drop > 0) this.spawn(pos[0], pos[1], pos[2], drop);
  }

  private alloc(): Pickup | null {
    for (const p of this.pool) if (p.state === P.Free) return p;
    return null;
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /** Current combo (consecutive pickups), for pitch-rising sfx in audio. */
  get comboCount(): number {
    return this.combo;
  }
}

/** main.ts wiring: `const pickups = installInkPickups(ctx); ctx.render.scene.add(pickups.mesh)`. */
export function installInkPickups(ctx: GameContext): InkPickups {
  const p = new InkPickups({
    events: ctx.events,
    tuning: ctx.tuning,
    stats: ctx.stats,
    groundHeight: (x, z) => ctx.collision.groundHeight(x, z),
  });
  ctx.render.scene.add(p.mesh);
  return p;
}
