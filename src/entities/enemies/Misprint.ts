import { AiState } from '../../systems/ai/fsm';
import { clampLen, orbit, type V2 } from '../../systems/ai/steering';
import type { Brain, BrainWorld } from './brain';
import type { Enemy } from './Enemy';

// ───────────── pure alignment clock (unit-tested) ─────────────

/** Window start inside one cycle: the window is the last `window` seconds of `period`. */
function windowStart(period: number, window: number): number {
  return Math.max(0, period - window);
}

function cyc(t: number, period: number): number {
  const m = t % period;
  return m < 0 ? m + period : m;
}

/** True while the three plates are in register (hittable). */
export function misprintAligned(t: number, period: number, window: number): boolean {
  return cyc(t, period) >= windowStart(period, window);
}

/**
 * Registration 0..1: 0 = plates fully offset, rises over `converge` seconds before the window
 * (the telegraph), 1 during the window, snaps back to 0 when the window ends.
 */
export function misprintAlign(t: number, period: number, window: number, converge: number): number {
  const c = cyc(t, period);
  const ws = windowStart(period, window);
  if (c >= ws) return 1;
  const cs = ws - converge;
  if (c <= cs || converge <= 0) return 0;
  const k = (c - cs) / converge;
  return k * k * (3 - 2 * k);
}

/**
 * Advance the clock by dt. When a beat lands (`beatNow`) within half a beat of the window start,
 * the clock is snapped so the window opens exactly on that beat (phase-locks to the music
 * without ever skipping more than half a beat).
 */
export function misprintStep(
  t: number,
  dt: number,
  period: number,
  window: number,
  beatNow: boolean,
  beatLen: number,
): number {
  let n = t + dt;
  if (beatNow && beatLen > 0) {
    const ws = windowStart(period, window);
    let diff = cyc(n, period) - ws;
    if (diff > period * 0.5) diff -= period;
    if (diff < -period * 0.5) diff += period;
    if (Math.abs(diff) <= beatLen * 0.5) n -= diff;
  }
  return n;
}

// ───────────── brain ─────────────

/**
 * Misprint — a ghost printed out of register: three offset CMYK plates drift around the player.
 * Every `period` seconds the plates slide into register (the telegraph) and for `window`
 * seconds it is one solid, hittable body that lurches at the player. Bolts pass through the
 * offset plates. Phase-locks the window to the music beat when `audio:beat` is running.
 */
export const MisprintBrain: Brain = {
  init(e, w) {
    const t = w.tuning.enemies;
    e.radius = t.misprintAi.radius;
    e.hp = e.maxHp = t.misprint.hp;
    e.orbitDir = w.rng.sign();
    // stagger so several misprints don't register in unison
    e.cycleT = w.rng.range(0, t.misprintAi.period * 0.5);
    e.align = 0;
  },

  stalk(e) {
    e.setState(AiState.Stalk, 0);
    e.ballistic = false;
  },

  vulnerable(e) {
    return e.worn || e.align >= 1;
  },

  update(e: Enemy, w: BrainWorld, dt: number, desired: V2) {
    const t = w.tuning.enemies;
    const a = t.misprintAi;
    const period = a.period * w.tempo;
    const prev = e.align;
    e.cycleT = misprintStep(e.cycleT, dt, period, a.window, a.beatSnap && w.beatNow, w.beatLen);
    e.align = e.worn ? 1 : misprintAlign(e.cycleT, period, a.window, a.converge * w.tempo);
    const aligned = e.align >= 1;
    // telegraph = plates sliding together
    e.windup = aligned ? 0 : e.align;
    if (prev <= 0 && e.align > 0 && !e.worn) w.telegraph(e, a.converge * w.tempo + a.window);
    if (aligned && prev < 1) {
      w.sfx('sketch_done', e.position.x, e.position.y + 1, e.position.z, 0.8);
      e.lunge = 1;
    }
    e.lunge = Math.max(0, e.lunge - dt * 2);
    const speed = t.misprint.speed * w.speedMul;
    if (!w.hasPlayer) {
      desired.x = desired.z = 0;
      return;
    }
    if (aligned) {
      // in register: lurch straight at the player
      const dx = w.playerX - e.position.x;
      const dz = w.playerZ - e.position.z;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;
      desired.x = (dx / d) * speed * 1.8;
      desired.z = (dz / d) * speed * 1.8;
      w.touchPlayer(e);
      return;
    }
    orbit(desired, e.position.x, e.position.z, w.playerX, w.playerZ, 3, speed, e.orbitDir, 1.4);
    clampLen(desired, speed);
  },
};
