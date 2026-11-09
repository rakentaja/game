/** Small allocation-free helpers shared by the lazy hero kits. */
import * as THREE from 'three';
import type { Damageable } from '../../core/types';
import type { HeroHost } from './HeroKit';

export type Ghost = Damageable & { kind?: string; hp?: number; stunT?: number };

const _from = new THREE.Vector3();

let bestT: Damageable | null = null;
let bestD = 0;
let qx = 0;
let qz = 0;
let mode = 0; // 0 ghosts any, 1 ghosts revealed, 2 anything revealed
let skip = -1;
const scanNearest = (t: Damageable) => {
  if (!t.alive || t.id === skip) return;
  const g = t as Ghost;
  if (mode === 0 && g.kind === undefined) return;
  if (mode === 1 && (g.kind === undefined || !t.revealed)) return;
  if (mode === 2 && !t.revealed) return;
  const dx = t.position.x - qx;
  const dz = t.position.z - qz;
  const d = dx * dx + dz * dz;
  if (d < bestD) {
    bestD = d;
    bestT = t;
  }
};

/**
 * Nearest target to (x, z) within `maxR`. `which`: 'ghost' = any live ghost (revealed or not),
 * 'revealedGhost', 'revealed' = anything hittable right now (weak points included).
 */
export function nearest(
  host: HeroHost,
  x: number,
  z: number,
  maxR: number,
  which: 'ghost' | 'revealedGhost' | 'revealed',
  skipId = -1,
): Damageable | null {
  const T = host.targets;
  if (!T) return null;
  bestT = null;
  bestD = maxR * maxR;
  qx = x;
  qz = z;
  skip = skipId;
  mode = which === 'ghost' ? 0 : which === 'revealedGhost' ? 1 : 2;
  T.forEach(scanNearest);
  return bestT;
}

let findId = -1;
let found: Damageable | null = null;
const scanId = (t: Damageable) => {
  if (t.id === findId) found = t;
};

export function byId(host: HeroHost, id: number): Damageable | null {
  if (!host.targets || id < 0) return null;
  findId = id;
  found = null;
  host.targets.forEach(scanId);
  return found;
}

let rx = 0;
let rz = 0;
let rr = 0;
let rfn: ((t: Damageable) => void) | null = null;
const scanRadius = (t: Damageable) => {
  if (!t.alive) return;
  const dx = t.position.x - rx;
  const dz = t.position.z - rz;
  const r = rr + t.radius;
  if (dx * dx + dz * dz <= r * r) rfn!(t);
};

/** Call `fn` for every live target within `r` of (x, z). Not re-entrant. */
export function inRadius(host: HeroHost, x: number, z: number, r: number, fn: (t: Damageable) => void): void {
  if (!host.targets) return;
  rx = x;
  rz = z;
  rr = r;
  rfn = fn;
  host.targets.forEach(scanRadius);
  rfn = null;
}

/** Hit `t` for `dmg` from (fx, fz). Returns true if that blow killed it (hp known) or it died. */
export function strike(t: Damageable, dmg: number, fx: number, fz: number): boolean {
  const hp = (t as Ghost).hp;
  _from.set(fx, t.position.y, fz);
  t.hit(dmg, _from);
  return (typeof hp === 'number' && hp <= dmg) || !t.alive;
}

/**
 * Damage that must wait for the reveal mask to catch up (a word lands → letters ink the ground →
 * the ghost becomes hittable a couple of sim steps later). Fixed pool.
 */
export class DelayedHits {
  private id = new Int32Array(24).fill(-1);
  private t = new Float32Array(24);
  private dmg = new Float32Array(24);
  private fx = new Float32Array(24);
  private fz = new Float32Array(24);

  constructor(private host: () => HeroHost) {}

  add(targetId: number, delay: number, dmg: number, fx: number, fz: number): void {
    for (let i = 0; i < 24; i++)
      if (this.id[i]! < 0) {
        this.id[i] = targetId;
        this.t[i] = delay;
        this.dmg[i] = dmg;
        this.fx[i] = fx;
        this.fz[i] = fz;
        return;
      }
  }

  /** `onHit(t, killed)` after each landed blow. */
  update(dt: number, onHit?: (t: Damageable, killed: boolean) => void): void {
    for (let i = 0; i < 24; i++) {
      if (this.id[i]! < 0) continue;
      this.t[i]! -= dt;
      if (this.t[i]! > 0) continue;
      const t = byId(this.host(), this.id[i]!);
      this.id[i] = -1;
      if (!t?.alive || !t.revealed) continue;
      const killed = strike(t, this.dmg[i]!, this.fx[i]!, this.fz[i]!);
      onHit?.(t, killed);
    }
  }

  clear(): void {
    this.id.fill(-1);
  }
}

/** Distance from point to segment a→b, squared. */
export function distSqSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  const ex = ax + dx * t - px;
  const ez = az + dz * t - pz;
  return ex * ex + ez * ez;
}
