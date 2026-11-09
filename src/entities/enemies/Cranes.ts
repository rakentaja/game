import * as THREE from 'three';
import type { Damageable } from '../../core/types';
import { AiState } from '../../systems/ai/fsm';
import { orbit, steerToward, type V2 } from '../../systems/ai/steering';
import type { Brain, BrainWorld } from './brain';
import { distSqToSegment } from './brain';
import type { Enemy } from './Enemy';

export const CraneMode = { Circle: 0, Fold: 1, Dive: 2, Return: 3, Scatter: 4 } as const;
export type CraneMode = (typeof CraneMode)[keyof typeof CraneMode];

export interface CraneOwner {
  onCraneHit(c: CraneTarget, amount: number, from: THREE.Vector3): void;
}

/**
 * One origami crane of a swarm. A pooled, individually targetable Damageable (one hit each);
 * the swarm Enemy owns it and counts once against maxActive.
 */
export class CraneTarget implements Damageable {
  id = 0;
  readonly kind = 'cranes' as const;
  readonly position = new THREE.Vector3();
  radius = 0.3;
  hp = 1;
  /** Slot in use (includes the fall-apart animation). */
  active = false;
  alive = false;
  inked = false;
  swarm: Enemy | null = null;
  mode: CraneMode = CraneMode.Circle;
  t = 0;
  dur = 0;
  vx = 0;
  vz = 0;
  aimX = 0;
  aimZ = 0;
  /** 0 = wings open, 1 = folded into a dart. */
  fold = 0;
  height = 1.3;
  yaw = 0;
  seed = 0;
  dieT = 0;
  revealVis = 0;
  hitT = 0;

  constructor(private owner: CraneOwner) {}

  get revealed(): boolean {
    return this.alive && (this.inked || (this.swarm?.stunT ?? 0) > 0);
  }

  get attacking(): boolean {
    return this.alive && this.mode === CraneMode.Fold;
  }

  hit(amount: number, from: THREE.Vector3): void {
    if (!this.revealed) return;
    this.owner.onCraneHit(this, amount, from);
  }

  stun(seconds: number): void {
    this.swarm?.stun(seconds);
  }
}

const _d: V2 = { x: 0, z: 0 };
const _sep: V2 = { x: 0, z: 0 };

function steerCrane(c: CraneTarget, desired: V2, accel: number, dt: number): void {
  _sep.x = c.vx;
  _sep.z = c.vz;
  steerToward(_sep, desired, accel, dt);
  c.vx = _sep.x;
  c.vz = _sep.z;
}

function separate(c: CraneTarget, flock: readonly CraneTarget[], out: V2): void {
  for (let i = 0; i < flock.length; i++) {
    const o = flock[i]!;
    if (o === c || !o.alive) continue;
    const dx = c.position.x - o.position.x;
    const dz = c.position.z - o.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 1.1 * 1.1 || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const k = (1 - d / 1.1) * 3;
    out.x += (dx / d) * k;
    out.z += (dz / d) * k;
  }
}

/**
 * Origami Crane Swarm — 5–7 paper cranes flocking as one enemy. They circle the reveal edge (a
 * flicker of white wings at the rim); every few seconds one folds itself into a dart (the
 * telegraph) and dives at the player, then climbs back to the ring. Each crane dies to one hit.
 * A dash ink trail through the flock scatters it. The swarm dies with its last crane.
 *
 * `seam` = index (in flock) of the crane currently attacking.
 */
export const CranesBrain: Brain = {
  selfMove: true,
  recoils: false,

  init(e, w) {
    const a = w.tuning.enemies.craneAi;
    const n = a.countMin + Math.floor(w.rng.next() * (a.countMax - a.countMin + 1));
    const got = w.attachCranes(e, Math.min(a.countMax, n));
    e.radius = 1.2;
    e.hp = e.maxHp = Math.max(1, got);
    e.orbitDir = w.rng.sign();
    e.ax = e.position.x;
    e.az = e.position.z;
    e.seam = -1;
  },

  stalk(e, w) {
    e.setState(AiState.Stalk, w.tuning.enemies.craneAi.diveEvery * w.tempo * w.rng.range(0.7, 1.2));
    e.ballistic = false;
    e.seam = -1;
    e.windup = 0;
  },

  vulnerable() {
    return false; // the swarm itself is never a target — its cranes are
  },

  interrupt(e) {
    for (const c of e.flock)
      if (c.alive && (c.mode === CraneMode.Fold || c.mode === CraneMode.Dive)) {
        c.mode = CraneMode.Return;
        c.t = 0;
        c.dur = 0.6;
      }
    e.seam = -1;
    e.windup = 0;
  },

  onDash(e, w, ax, az, bx, bz) {
    const a = w.tuning.enemies.craneAi;
    const r2 = a.scatterRadius * a.scatterRadius;
    let any = false;
    for (const c of e.flock) {
      if (!c.alive) continue;
      if (distSqToSegment(c.position.x, c.position.z, ax, az, bx, bz) > r2) continue;
      // push away from the nearest point of the dash line
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      let t = ((c.position.x - ax) * dx + (c.position.z - az) * dz) / l2;
      t = t < 0 ? 0 : Math.min(t, 1);
      let px = c.position.x - (ax + dx * t);
      let pz = c.position.z - (az + dz * t);
      const d = Math.sqrt(px * px + pz * pz);
      if (d < 1e-3) {
        px = -dz;
        pz = dx;
      }
      const l = Math.sqrt(px * px + pz * pz) || 1;
      c.vx = (px / l) * a.scatterImpulse;
      c.vz = (pz / l) * a.scatterImpulse;
      c.mode = CraneMode.Scatter;
      c.t = 0;
      c.dur = a.scatterS * w.rng.range(0.8, 1.2);
      c.fold = 0;
      any = true;
    }
    if (any) {
      if (e.state === AiState.Attack) CranesBrain.stalk(e, w);
      w.sfx('ui_hover', e.position.x, 1.3, e.position.z, 1);
    }
  },

  idle(e, w, dt) {
    // loose hover around the spawn point until aggro
    for (const c of e.flock) {
      if (!c.alive) continue;
      orbit(_d, c.position.x, c.position.z, e.ax, e.az, 1.3, 1.2, e.orbitDir, 1.5);
      steerCrane(c, _d, 6, dt);
      c.position.x += c.vx * dt;
      c.position.z += c.vz * dt;
      c.height = w.tuning.enemies.craneAi.flyHeight + Math.sin(c.t * 2 + c.seed * 20) * 0.15;
      c.t += dt;
      c.yaw = Math.atan2(c.vx, c.vz);
    }
    centroid(e);
  },

  update(e: Enemy, w: BrainWorld, dt: number, desired: V2) {
    const a = w.tuning.enemies.craneAi;
    desired.x = desired.z = 0;
    const center = w.reveal.center;
    const ring = Math.max(1.5, w.reveal.radius + (e.worn ? -1.2 : a.ringOffset));
    const speed = w.tuning.enemies.cranes.speed * w.speedMul * e.speedBuff;
    let fold = 0;
    for (let i = 0; i < e.flock.length; i++) {
      const c = e.flock[i]!;
      if (!c.alive) continue;
      c.t += dt;
      const bob = Math.sin(c.t * 2.3 + c.seed * 20) * 0.18;
      switch (c.mode) {
        case CraneMode.Circle:
        case CraneMode.Return: {
          orbit(
            _d,
            c.position.x,
            c.position.z,
            center.x,
            center.z,
            ring + (c.seed - 0.5) * 0.8,
            speed,
            e.orbitDir,
            1.6,
          );
          separate(c, e.flock, _d);
          steerCrane(c, _d, 9, dt);
          c.fold = Math.max(0, c.fold - dt * 2.5);
          c.height += (a.flyHeight + bob - c.height) * Math.min(1, dt * 3);
          if (c.mode === CraneMode.Return && c.t >= c.dur) c.mode = CraneMode.Circle;
          break;
        }
        case CraneMode.Fold: {
          const k = Math.min(1, c.t / Math.max(1e-3, c.dur));
          c.fold = k;
          fold = Math.max(fold, k);
          const damp = Math.exp(-5 * dt);
          c.vx *= damp;
          c.vz *= damp;
          if (k < 0.7 && w.hasPlayer) {
            c.aimX = w.playerX;
            c.aimZ = w.playerZ;
          }
          c.height += (a.flyHeight + 0.5 - c.height) * Math.min(1, dt * 4);
          if (k >= 1) {
            let dx = c.aimX - c.position.x;
            let dz = c.aimZ - c.position.z;
            const d = Math.sqrt(dx * dx + dz * dz) || 1;
            dx /= d;
            dz /= d;
            c.mode = CraneMode.Dive;
            c.t = 0;
            c.dur = a.diveTime;
            c.vx = dx * a.diveSpeed * w.speedMul;
            c.vz = dz * a.diveSpeed * w.speedMul;
            w.sfx('dash', c.position.x, c.height, c.position.z, 0.5);
          }
          break;
        }
        case CraneMode.Dive: {
          c.fold = 1;
          c.height += (0.75 - c.height) * Math.min(1, dt * 6);
          if (w.hasPlayer) {
            const dx = w.playerX - c.position.x;
            const dz = w.playerZ - c.position.z;
            const r = c.radius + w.playerRadius + 0.1;
            if (dx * dx + dz * dz <= r * r) {
              w.damagePlayer(e, w.tuning.enemies.cranes.damage, 0.3);
              c.mode = CraneMode.Return;
              c.t = 0;
              c.dur = a.returnTime;
              c.vx *= -0.4;
              c.vz *= -0.4;
              break;
            }
          }
          if (c.t >= c.dur) {
            c.mode = CraneMode.Return;
            c.t = 0;
            c.dur = a.returnTime;
          }
          break;
        }
        case CraneMode.Scatter: {
          const damp = Math.exp(-2.5 * dt);
          c.vx *= damp;
          c.vz *= damp;
          c.height += (a.flyHeight + 0.6 + bob - c.height) * Math.min(1, dt * 3);
          if (c.t >= c.dur) {
            c.mode = CraneMode.Circle;
            c.t = 0;
          }
          break;
        }
      }
      c.position.x += c.vx * dt;
      c.position.z += c.vz * dt;
      const sp = c.vx * c.vx + c.vz * c.vz;
      if (sp > 0.04) {
        let dy = Math.atan2(c.vx, c.vz) - c.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        c.yaw += dy * Math.min(1, dt * 10);
      }
    }
    e.windup = fold;
    centroid(e);

    if (e.state === AiState.Stalk) {
      if (e.stateT < e.stateDur || !w.hasPlayer) return;
      // pick the circling crane closest to the player
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < e.flock.length; i++) {
        const c = e.flock[i]!;
        if (!c.alive || c.mode !== CraneMode.Circle) continue;
        const d = (c.position.x - w.playerX) ** 2 + (c.position.z - w.playerZ) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0 || bestD > 12 * 12 || !w.requestAttack(e)) {
        e.stateDur = e.stateT + 0.5;
        return;
      }
      const c = e.flock[best]!;
      const fd = a.fold * w.tempo;
      c.mode = CraneMode.Fold;
      c.t = 0;
      c.dur = fd;
      c.aimX = w.playerX;
      c.aimZ = w.playerZ;
      e.setState(AiState.Attack, fd);
      e.seam = best;
      w.telegraph(e, fd);
      w.sfx('ui_hover', c.position.x, c.height, c.position.z, 0.9);
      return;
    }

    if (e.state === AiState.Attack) {
      const c = e.seam >= 0 ? e.flock[e.seam] : undefined;
      if (!c?.alive || (c.mode !== CraneMode.Fold && c.mode !== CraneMode.Dive)) CranesBrain.stalk(e, w);
    }
  },
};

/** Swarm entity sits on the centroid of its live cranes. */
function centroid(e: Enemy): void {
  let n = 0;
  let x = 0;
  let z = 0;
  for (const c of e.flock) {
    if (!c.alive) continue;
    x += c.position.x;
    z += c.position.z;
    n++;
  }
  if (n === 0) return;
  e.position.x = x / n;
  e.position.z = z / n;
  e.velocity.set(0, 0, 0);
}
