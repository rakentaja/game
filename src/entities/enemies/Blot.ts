import { AiState } from '../../systems/ai/fsm';
import { clampLen, orbit, seek, type V2 } from '../../systems/ai/steering';
import type { Brain, BrainWorld } from './brain';
import type { Enemy } from './Enemy';

/**
 * Blot — living ink stain. Oozes straight for the crystal. Within `drainRadius` it *latches*:
 * a readable rear-up (shape + `enemy:telegraph` + gloop) while its tendril sketches toward the
 * crystal, then the drain ramps up over `drainRamp` seconds, choking the reveal radius down to
 * an absolute floor that keeps the blot itself lit and shootable. Any hit knocks it off and
 * resets the drain — kill it first.
 */
export const BlotBrain: Brain = {
  init(e, w) {
    const t = w.tuning.enemies;
    e.radius = t.blotAi.radius;
    e.hp = e.maxHp = t.blot.hp;
    e.orbitDir = w.rng.sign();
  },

  stalk(e) {
    e.setState(AiState.Stalk, 0);
    e.ballistic = false;
  },

  update(e: Enemy, w: BrainWorld, dt: number, desired: V2) {
    const t = w.tuning.enemies;
    const b = t.blot;
    const a = t.blotAi;
    const speed = b.speed * w.speedMul;
    const c = w.reveal.center;
    const dx = c.x - e.position.x;
    const dz = c.z - e.position.z;
    const d = Math.sqrt(dx * dx + dz * dz);

    if (e.state === AiState.Stalk) {
      seek(desired, e.position.x, e.position.z, c.x, c.z, speed, a.stopDistance + 0.6);
      e.drain = Math.max(0, e.drain - dt * 2);
      e.windup = Math.max(0, e.windup - dt * 3);
      if (d <= b.drainRadius) {
        const latch = a.latchTime * w.tempo;
        e.setState(AiState.Attack, latch);
        e.drainPulseT = 0;
        w.telegraph(e, latch);
        w.drainPulse(e);
      }
      w.touchPlayer(e);
      return;
    }

    if (e.state === AiState.Attack) {
      if (d > b.drainRadius * 1.25) {
        BlotBrain.stalk(e, w);
        return;
      }
      if (e.phase === 0) {
        // Latch telegraph: stop, rear up, shiver; the tendril sketches out (renderer).
        desired.x = desired.z = 0;
        e.windup = Math.min(1, e.stateT / e.stateDur);
        if (e.stateT >= e.stateDur) {
          e.phase = 1;
          e.stateT = 0;
        }
        w.touchPlayer(e);
        return;
      }
      // Latched: slow creeping circle around the crystal, drain ramps up.
      orbit(
        desired,
        e.position.x,
        e.position.z,
        c.x,
        c.z,
        a.stopDistance + 0.25,
        speed * 0.35,
        e.orbitDir,
        1.2,
      );
      clampLen(desired, speed);
      e.windup = Math.max(0, e.windup - dt * 2);
      const p = Math.max(0, Math.min(1, 1 - d / b.drainRadius));
      const proximity = 0.4 + 0.6 * p;
      e.drain = Math.min(1, e.drain + dt / (a.drainRamp * w.tempo));
      w.suppressReveal(1 - b.radiusSuppress * w.drainMul * proximity * e.drain);
      e.drainPulseT -= dt;
      if (e.drainPulseT <= 0) {
        e.drainPulseT = a.drainPulse;
        w.drainPulse(e);
      }
      w.touchPlayer(e);
    }
  },
};
