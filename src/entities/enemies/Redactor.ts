import { AiState } from '../../systems/ai/fsm';
import { seek, type V2 } from '../../systems/ai/steering';
import type { Brain, BrainWorld } from './brain';
import { distSqToSegment } from './brain';
import type { Enemy } from './Enemy';

/**
 * Redactor — a black censorship bar. While shielded it slides back and forth along a lane,
 * choking the reveal whenever the crystal is inside that lane (like a Blot) and censoring the
 * inked history it passes over. Bolts pass straight through it until the *held* crystal's light
 * has covered it for `exposeS` seconds; then the bar cracks and it takes plain hits (2 HP) while
 * it charges the player.
 *
 * Lane: (ax,az)→(bx,bz). `timerA` = slide parameter 0..1, `orbitDir` = slide direction.
 */
export const RedactorBrain: Brain = {
  init(e, w) {
    const t = w.tuning.enemies;
    const a = t.redactorAi;
    e.radius = a.radius;
    e.hp = e.maxHp = t.redactor.hp;
    e.shield = 1;
    e.expose = 0;
    const ang = w.rng.range(0, Math.PI);
    const hx = Math.cos(ang) * a.laneLen * 0.5;
    const hz = Math.sin(ang) * a.laneLen * 0.5;
    e.ax = e.position.x - hx;
    e.az = e.position.z - hz;
    e.bx = e.position.x + hx;
    e.bz = e.position.z + hz;
    e.timerA = 0.5;
    e.timerB = 0;
    e.aimX = e.position.x;
    e.aimZ = e.position.z;
  },

  stalk(e) {
    e.setState(AiState.Stalk, 0);
    e.ballistic = false;
  },

  vulnerable(e) {
    return e.shield <= 0;
  },

  update(e: Enemy, w: BrainWorld, dt: number, desired: V2) {
    const t = w.tuning.enemies;
    const a = t.redactorAi;
    const speed = t.redactor.speed * w.speedMul;
    if (e.worn && e.shield > 0) breakShield(e, w);

    if (e.shield > 0) {
      // Exposure: the held crystal's light must sit on the bar.
      const lit = w.crystalHeld && e.inked;
      if (lit) e.expose = Math.min(1, e.expose + dt / a.exposeS);
      else e.expose = Math.max(0, e.expose - dt * a.exposeDecay);
      if (e.expose >= 1) {
        breakShield(e, w);
        return;
      }
      // Drag the lane along behind the player so it stays relevant.
      if (w.hasPlayer) {
        const cx = (e.ax + e.bx) * 0.5;
        const cz = (e.az + e.bz) * 0.5;
        const dx = w.playerX - cx;
        const dz = w.playerZ - cz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > 5) {
          const k = (Math.min(1.2, d - 5) * dt) / d;
          e.ax += dx * k;
          e.az += dz * k;
          e.bx += dx * k;
          e.bz += dz * k;
        }
      }
      // Slide toward the current lane end.
      const len = Math.hypot(e.bx - e.ax, e.bz - e.az) || 1;
      e.timerA += ((e.orbitDir * a.slideSpeed * w.speedMul) / len) * dt;
      if (e.timerA >= 1) {
        e.timerA = 1;
        e.orbitDir = -1;
      } else if (e.timerA <= 0) {
        e.timerA = 0;
        e.orbitDir = 1;
      }
      const tx = e.ax + (e.bx - e.ax) * e.timerA;
      const tz = e.az + (e.bz - e.az) * e.timerA;
      seek(desired, e.position.x, e.position.z, tx, tz, a.slideSpeed * 1.6 * w.speedMul, 0.6);
      // Suppress the reveal while the crystal is inside the lane.
      const c = w.reveal.center;
      const hw = a.laneHalfWidth;
      if (distSqToSegment(c.x, c.z, e.ax, e.az, e.bx, e.bz) < hw * hw)
        w.suppressReveal(1 - (1 - a.suppress) * w.drainMul);
      // Censor the inked history it slides over.
      e.timerB += dt;
      if (e.timerB >= a.eraseEvery) {
        e.timerB = 0;
        w.reveal.eraseStrip(e.aimX, e.aimZ, e.position.x, e.position.z, a.eraseHalfWidth);
        e.aimX = e.position.x;
        e.aimZ = e.position.z;
      }
      w.touchPlayer(e);
      return;
    }

    // Cracked: charge the player.
    if (w.hasPlayer) seek(desired, e.position.x, e.position.z, w.playerX, w.playerZ, speed * 1.2, 0.4);
    w.touchPlayer(e);
  },
};

/** The crystal (or the gimmick fallback) cracked the bar: bolts work now. */
export function breakShield(e: Enemy, w: BrainWorld): void {
  e.shield = 0;
  e.expose = 1;
  e.windup = 0;
  e.hitT = 1;
  w.sfx('bolt_hit', e.position.x, e.position.y + 1, e.position.z, 1);
  w.sfx('ghost_reveal', e.position.x, e.position.y + 1, e.position.z, 1);
  w.panelCut('rrrip', e.position.x, e.position.y + 1, e.position.z, 'redactor-break');
}
