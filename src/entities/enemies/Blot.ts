import { AiState } from '../../systems/ai/fsm';
import { clampLen, orbit, seek, type V2 } from '../../systems/ai/steering';
import type { Brain, BrainWorld } from './brain';
import type { Enemy } from './Enemy';

/**
 * Blot — living ink stain. Oozes straight for the crystal; within `drainRadius` it latches on,
 * stretching a tendril toward it and choking the reveal radius (energy drain). Kill it first.
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
    const c = w.reveal.center;
    const dx = c.x - e.position.x;
    const dz = c.z - e.position.z;
    const d = Math.sqrt(dx * dx + dz * dz);

    if (e.state === AiState.Stalk) {
      seek(desired, e.position.x, e.position.z, c.x, c.z, b.speed, a.stopDistance + 0.6);
      e.drain = Math.max(0, e.drain - dt * 2);
      if (d <= b.drainRadius) {
        e.setState(AiState.Attack, 0);
        e.drainPulseT = 0;
        w.telegraph(e, 0);
      }
      w.touchPlayer(e);
      return;
    }

    if (e.state === AiState.Attack) {
      // Latched: slow creeping circle around the crystal.
      orbit(
        desired,
        e.position.x,
        e.position.z,
        c.x,
        c.z,
        a.stopDistance + 0.25,
        b.speed * 0.35,
        e.orbitDir,
        1.2,
      );
      clampLen(desired, b.speed);
      const p = Math.max(0, Math.min(1, 1 - d / b.drainRadius));
      const strength = 0.4 + 0.6 * p;
      e.drain = Math.min(1, e.drain + dt * 3) * strength + (1 - strength) * e.drain;
      w.suppressReveal(1 - b.radiusSuppress * strength);
      e.drainPulseT -= dt;
      if (e.drainPulseT <= 0) {
        e.drainPulseT = a.drainPulse;
        w.drainPulse(e);
      }
      w.touchPlayer(e);
      if (d > b.drainRadius * 1.25) BlotBrain.stalk(e, w);
    }
  },
};
