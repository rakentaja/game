import { AiState } from '../../systems/ai/fsm';
import type { V2 } from '../../systems/ai/steering';
import type { Brain, BrainWorld } from './brain';
import { distSqToSegment, distToPlayer } from './brain';
import type { Enemy } from './Enemy';

/** Margin Man sub-phases inside Stalk. */
export const MARGIN_WAIT = 0;
export const MARGIN_TELL = 1;

const FOLLOW_THROUGH = 0.35;

/**
 * Margin Man — a pencil-noir silhouette that lives in the gutters. Inside the ink mask he is a
 * frozen statue; outside it he blinks toward the player in shutter-clicked steps, stopping just
 * past the reveal edge. There he winds up (rapid clicks) and blinks *through* the light to
 * strike. Bolts pass through him unless a dash ink trail crossed him in the last
 * `vulnerableS` seconds (or the gimmick fallback wore him down).
 */
export const MarginManBrain: Brain = {
  selfMove: true,

  init(e, w) {
    const t = w.tuning.enemies;
    e.radius = t.marginAi.radius;
    e.hp = e.maxHp = t.marginMan.hp;
    e.vulnT = 0;
    e.timerA = 0;
  },

  stalk(e, w) {
    e.setState(AiState.Stalk, w.tuning.enemies.marginAi.stepEvery * w.tempo);
    e.timerA = 0;
    e.ballistic = false;
  },

  vulnerable(e) {
    return e.worn || e.vulnT > 0;
  },

  interrupt(e) {
    e.windup = 0;
    e.phase = 0;
  },

  onDash(e, w, ax, az, bx, bz) {
    const a = w.tuning.enemies.marginAi;
    const r = a.dashWidth + e.radius;
    if (distSqToSegment(e.position.x, e.position.z, ax, az, bx, bz) > r * r) return;
    e.vulnT = a.vulnerableS;
    w.sfx('crystal_on', e.position.x, e.position.y + 1.2, e.position.z, 0.7);
  },

  update(e: Enemy, w: BrainWorld, dt: number, desired: V2) {
    const a = w.tuning.enemies.marginAi;
    desired.x = desired.z = 0;
    e.velocity.set(0, 0, 0);
    // Seen = frozen. Every timer stops (stateT is advanced by the system; take it back).
    const frozen = e.inked && !(e.state === AiState.Attack && e.phase === 1);
    if (frozen) {
      if (e.state === AiState.Attack) {
        // caught mid-windup: the light cancels the strike (and frees the attack token)
        e.windup = 0;
        MarginManBrain.stalk(e, w);
        return;
      }
      e.stateT -= dt;
      if (e.phase === MARGIN_TELL) e.phase = MARGIN_WAIT;
      return;
    }
    if (!w.hasPlayer) return;
    const reach = w.reveal.radius + a.strikeRange;

    if (e.state === AiState.Stalk) {
      e.windup = 0;
      e.timerA += dt;
      const d = distToPlayer(e, w);
      if (d <= reach && e.phase === MARGIN_WAIT && w.requestAttack(e)) {
        const wind = a.windup * w.tempo;
        e.setState(AiState.Attack, wind);
        e.timerA = 0;
        w.telegraph(e, wind);
        w.sfx('ui_click', e.position.x, e.position.y + 1.4, e.position.z, 1);
        return;
      }
      if (e.phase === MARGIN_WAIT) {
        if (e.timerA < e.stateDur || d <= reach) return;
        // Plan the blink: toward the player, never deeper than just outside the light.
        const step = Math.min(a.stepDist, Math.max(0.4, d - reach * 0.9));
        const ux = (w.playerX - e.position.x) / (d || 1);
        const uz = (w.playerZ - e.position.z) / (d || 1);
        let tx = e.position.x + ux * step;
        let tz = e.position.z + uz * step;
        if (!w.walkable(tx, tz)) {
          // sidestep the blink instead of walking into a wall
          tx = e.position.x + (ux * 0.6 - uz * e.orbitDir * 0.8) * step;
          tz = e.position.z + (uz * 0.6 + ux * e.orbitDir * 0.8) * step;
          if (!w.walkable(tx, tz)) {
            e.orbitDir = -e.orbitDir;
            e.timerA = 0;
            return;
          }
        }
        e.bx = tx;
        e.bz = tz;
        e.phase = MARGIN_TELL;
        e.timerA = 0;
        w.sfx('ui_click', e.position.x, e.position.y + 1.4, e.position.z, 0.6);
        return;
      }
      // Tell → blink.
      if (e.timerA >= a.stepTell * w.tempo) {
        e.position.x = e.bx;
        e.position.z = e.bz;
        e.yaw = Math.atan2(w.playerX - e.bx, w.playerZ - e.bz);
        e.phase = MARGIN_WAIT;
        e.timerA = 0;
        e.stateDur = a.stepEvery * w.tempo * w.rng.range(0.8, 1.2);
        w.sfx('ui_click', e.position.x, e.position.y + 1.4, e.position.z, 0.9);
      }
      return;
    }

    if (e.state === AiState.Attack) {
      if (e.phase === 0) {
        e.windup = Math.min(1, e.stateT / Math.max(1e-3, e.stateDur));
        e.aimX = w.playerX;
        e.aimZ = w.playerZ;
        // a click every ~0.16 s while winding up (shutter burst)
        e.timerA += dt;
        if (e.timerA >= 0.16) {
          e.timerA = 0;
          w.sfx('ui_click', e.position.x, e.position.y + 1.4, e.position.z, 0.8);
        }
        if (e.stateT >= e.stateDur) {
          // Blink through the light to the player's side and strike.
          let dx = e.position.x - w.playerX;
          let dz = e.position.z - w.playerZ;
          const d = Math.sqrt(dx * dx + dz * dz) || 1;
          dx /= d;
          dz /= d;
          const off = w.playerRadius + e.radius + 0.35;
          const tx = w.playerX + dx * off;
          const tz = w.playerZ + dz * off;
          if (w.walkable(tx, tz)) {
            e.position.x = tx;
            e.position.z = tz;
          }
          e.yaw = Math.atan2(-dx, -dz);
          w.damagePlayer(e, w.tuning.enemies.marginMan.damage, 0.45);
          w.sfx('ui_click', e.position.x, e.position.y + 1.4, e.position.z, 1);
          e.phase = 1;
          e.stateT = 0;
          e.windup = 0;
          e.lunge = 1;
        }
        return;
      }
      e.lunge = Math.max(0, 1 - e.stateT / FOLLOW_THROUGH);
      if (e.stateT >= FOLLOW_THROUGH) {
        e.lunge = 0;
        MarginManBrain.stalk(e, w);
      }
    }
  },
};
