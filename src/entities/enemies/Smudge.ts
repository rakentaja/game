import { AiState } from '../../systems/ai/fsm';
import { clampLen, orbit, type V2 } from '../../systems/ai/steering';
import type { Brain, BrainWorld } from './brain';
import { distToPlayer } from './brain';
import type { Enemy } from './Enemy';

/**
 * Smudge — crumpled paper ghost. Lurks just outside the reveal edge, circling it, then winds up
 * (shudders, squashes, leans back: readable by shape) and darts straight through the light.
 */
export const SmudgeBrain: Brain = {
  init(e, w) {
    const t = w.tuning.enemies;
    e.radius = t.smudgeAi.radius;
    e.hp = e.maxHp = t.smudge.hp;
    e.orbitDir = w.rng.sign();
  },

  stalk(e, w) {
    const a = w.tuning.enemies.smudgeAi;
    e.setState(AiState.Stalk, w.rng.range(a.stalkMin, a.stalkMax) * w.tempo);
    if (w.rng.next() < 0.35) e.orbitDir = -e.orbitDir;
    e.ballistic = false;
  },

  update(e: Enemy, w: BrainWorld, _dt: number, desired: V2) {
    const t = w.tuning.enemies;
    const a = t.smudgeAi;
    const speed = t.smudge.speed * w.speedMul;
    if (e.state === AiState.Stalk) {
      const c = w.reveal.center;
      // Hug the outside of the reveal edge so it's a flicker at the rim, never fully seen.
      const ring = w.reveal.radius + a.stalkOffset;
      orbit(desired, e.position.x, e.position.z, c.x, c.z, ring, speed * a.orbitSpeed * 0.5, e.orbitDir);
      clampLen(desired, speed * 1.25);
      e.windup = 0;
      if (e.stateT >= e.stateDur && w.hasPlayer) {
        if (distToPlayer(e, w) <= a.dartRange && w.requestAttack(e)) {
          const wind = a.windup * w.tempo;
          e.setState(AiState.Attack, wind);
          e.aimX = w.playerX;
          e.aimZ = w.playerZ;
          w.telegraph(e, wind);
        } else {
          e.stateDur = e.stateT + 0.5;
        }
      }
      return;
    }

    if (e.state === AiState.Attack) {
      if (e.phase === 0) {
        // Windup: track the player for the first 70%, then lock (fair dodge window).
        const k = e.stateT / e.stateDur;
        if (k < 0.7 && w.hasPlayer) {
          e.aimX = w.playerX;
          e.aimZ = w.playerZ;
        }
        let dx = e.aimX - e.position.x;
        let dz = e.aimZ - e.position.z;
        const d = Math.sqrt(dx * dx + dz * dz) || 1;
        dx /= d;
        dz /= d;
        e.dartDist = d;
        // Anticipation: drift backwards away from the target while coiling up.
        desired.x = -dx * 0.9;
        desired.z = -dz * 0.9;
        e.windup = Math.min(1, k);
        if (e.stateT >= e.stateDur) {
          const ds = a.dartSpeed * w.speedMul;
          e.phase = 1;
          e.stateT = 0;
          // Decelerating dart covers 0.75·speed·T: fly just past the aim point.
          e.stateDur = Math.min(a.dartTime, Math.max(0.3, (e.dartDist + a.dartOvershoot) / (0.75 * ds)));
          e.aimX = dx;
          e.aimZ = dz;
          e.velocity.x = dx * ds;
          e.velocity.z = dz * ds;
          e.ballistic = true;
          e.hitPlayer = false;
          e.lunge = 1;
          e.windup = 0;
        }
        return;
      }
      // Dart: ballistic, decelerating towards the end.
      const k = Math.min(1, e.stateT / e.stateDur);
      const s = a.dartSpeed * w.speedMul * (1 - k * k * 0.75);
      e.velocity.x = e.aimX * s;
      e.velocity.z = e.aimZ * s;
      desired.x = e.velocity.x;
      desired.z = e.velocity.z;
      e.lunge = 1 - k;
      if (!e.hitPlayer && w.touchPlayer(e)) {
        e.hitPlayer = true;
        e.ballistic = false;
        e.setState(AiState.Recoil, t.ai.recoilTime * 1.4);
        e.velocity.x = -e.aimX * t.ai.recoilImpulse;
        e.velocity.z = -e.aimZ * t.ai.recoilImpulse;
        e.recoil = 1;
        e.lunge = 0;
        return;
      }
      if (e.stateT >= e.stateDur) {
        e.lunge = 0;
        SmudgeBrain.stalk(e, w);
      }
    }
  },
};
