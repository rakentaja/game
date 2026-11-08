import { AiState } from '../../systems/ai/fsm';
import { clampLen, orbit, type V2 } from '../../systems/ai/steering';
import type { Brain, BrainWorld } from './brain';
import { distToPlayer } from './brain';
import type { Enemy } from './Enemy';

const FOLLOW_THROUGH = 0.28;

/**
 * Scribbler — tall paper figure. Keeps its distance orbiting the player, raises its pencil arm
 * while a dashed pencil line scratches itself onto the ground (0.8 s telegraph), then flings a
 * pencil stroke along it. Hitting it during the telegraph cancels the shot.
 */
export const ScribblerBrain: Brain = {
  init(e, w) {
    const t = w.tuning.enemies;
    e.radius = t.scribblerAi.radius;
    e.hp = e.maxHp = t.scribbler.hp;
    e.orbitDir = w.rng.sign();
    e.fireCd = w.rng.range(0.8, 1.6) * w.tempo;
  },

  stalk(e, w) {
    e.setState(AiState.Stalk, w.rng.range(1.5, 3));
    e.ballistic = false;
  },

  update(e: Enemy, w: BrainWorld, dt: number, desired: V2) {
    const t = w.tuning.enemies;
    const s = t.scribbler;
    const a = t.scribblerAi;
    const speed = s.speed * w.speedMul;
    if (e.state === AiState.Stalk) {
      e.windup = 0;
      e.fireCd -= dt;
      if (w.hasPlayer) {
        orbit(
          desired,
          e.position.x,
          e.position.z,
          w.playerX,
          w.playerZ,
          a.preferRange,
          speed * a.orbitSpeed,
          e.orbitDir,
          1.4,
        );
        clampLen(desired, speed);
      } else {
        desired.x = desired.z = 0;
      }
      if (e.stateT >= e.stateDur) {
        e.stateT = 0;
        e.stateDur = w.rng.range(1.5, 3);
        if (w.rng.next() < 0.4) e.orbitDir = -e.orbitDir;
      }
      if (
        w.hasPlayer &&
        e.fireCd <= 0 &&
        distToPlayer(e, w) <= s.range &&
        w.lineClear(e.position.x, e.position.z, w.playerX, w.playerZ)
      ) {
        if (!w.requestAttack(e)) {
          e.fireCd = 0.4;
          return;
        }
        const tel = s.telegraph * w.tempo;
        e.setState(AiState.Attack, tel);
        // Aim is locked at telegraph start (slight lead) so sidestepping always works.
        e.aimX = w.playerX + w.playerVX * a.aimLead;
        e.aimZ = w.playerZ + w.playerVZ * a.aimLead;
        w.telegraph(e, tel);
      }
      return;
    }

    if (e.state === AiState.Attack) {
      desired.x = desired.z = 0;
      if (e.phase === 0) {
        e.windup = Math.min(1, e.stateT / e.stateDur);
        if (e.stateT >= e.stateDur) {
          let dx = e.aimX - e.position.x;
          let dz = e.aimZ - e.position.z;
          const d = Math.sqrt(dx * dx + dz * dz) || 1;
          dx /= d;
          dz /= d;
          w.fireProjectile(e, dx, dz);
          e.phase = 1;
          e.stateT = 0;
          e.windup = 0;
          e.lunge = 1;
          // A little kick back from the throw.
          e.velocity.x -= dx * 1.5;
          e.velocity.z -= dz * 1.5;
        }
        return;
      }
      e.lunge = Math.max(0, 1 - e.stateT / FOLLOW_THROUGH);
      if (e.stateT >= FOLLOW_THROUGH) {
        e.fireCd = s.fireCooldown * w.tempo * w.rng.range(0.85, 1.15);
        ScribblerBrain.stalk(e, w);
      }
    }
  },
};
