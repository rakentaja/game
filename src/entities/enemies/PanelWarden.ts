import { AiState } from '../../systems/ai/fsm';
import { clampLen, orbit, type V2 } from '../../systems/ai/steering';
import type { Brain, BrainWorld } from './brain';
import { distSqToSegment, distToPlayer } from './brain';
import type { Enemy } from './Enemy';

/** Attack sub-phases. */
export const WARDEN_WINDUP = 0;
export const WARDEN_BOX = 1;

/** World position of the telegraphed seam corner of the active box. */
export function seamCorner(e: Enemy, out: V2): V2 {
  out.x = e.ax + (e.seam & 1 ? e.boxHalf : -e.boxHalf);
  out.z = e.az + (e.seam & 2 ? e.boxHalf : -e.boxHalf);
  return out;
}

/** Is (x,z) outside the warden's active box (in the gutter)? */
export function inGutter(e: Enemy, x: number, z: number): boolean {
  return e.boxHalf > 0 && (Math.abs(x - e.ax) > e.boxHalf || Math.abs(z - e.az) > e.boxHalf);
}

const _c: V2 = { x: 0, z: 0 };

/** Cut the panel border (bolt on the warden, or a dash through the seam). */
export function breakBox(e: Enemy, w: BrainWorld): boolean {
  if (e.boxHalf <= 0) return false;
  seamCorner(e, _c);
  e.boxHalf = 0;
  w.sfx('panel_stinger', _c.x, 1, _c.z, 0.8);
  w.panelCut('shink', e.ax, 1, e.az, 'panel-break');
  return true;
}

/**
 * Panel Warden — a stiff paper panel that keeps its distance and *frames* the player: after a
 * pencil-scratch windup it drops a `boxSize` m square border around them that shrinks over
 * `shrinkS`. Standing in the gutter outside the border tears pages every `gutterTick`. Break
 * the panel by bolting the warden (it always stands outside) or dashing through the dashed
 * seam on one corner.
 *
 * Box: centre (ax,az), half size `boxHalf`, seam corner `seam` (0..3). `timerA` gutter tick,
 * `timerB` time spent in the gutter.
 */
export const PanelWardenBrain: Brain = {
  init(e, w) {
    const t = w.tuning.enemies;
    e.radius = t.wardenAi.radius;
    e.hp = e.maxHp = t.panelWarden.hp;
    e.orbitDir = w.rng.sign();
    e.fireCd = w.rng.range(1, 2) * w.tempo;
    e.boxHalf = 0;
  },

  stalk(e, w) {
    e.setState(AiState.Stalk, w.rng.range(1.5, 3));
    e.ballistic = false;
  },

  interrupt(e, w) {
    breakBox(e, w);
    e.fireCd = w.tuning.enemies.wardenAi.cooldown * w.tempo;
  },

  onDash(e, w, ax, az, bx, bz) {
    if (e.state !== AiState.Attack || e.phase !== WARDEN_BOX || e.boxHalf <= 0) return;
    const a = w.tuning.enemies.wardenAi;
    seamCorner(e, _c);
    if (distSqToSegment(_c.x, _c.z, ax, az, bx, bz) > a.seamRadius * a.seamRadius) return;
    breakBox(e, w);
    e.fireCd = a.cooldown * w.tempo;
    e.setState(AiState.Recoil, w.tuning.enemies.ai.recoilTime * 2.5);
    e.recoil = 1;
  },

  update(e: Enemy, w: BrainWorld, dt: number, desired: V2) {
    const t = w.tuning.enemies;
    const a = t.wardenAi;
    const speed = t.panelWarden.speed * w.speedMul;

    if (e.state === AiState.Stalk) {
      e.windup = 0;
      e.fireCd -= dt;
      if (!w.hasPlayer) {
        desired.x = desired.z = 0;
        return;
      }
      orbit(
        desired,
        e.position.x,
        e.position.z,
        w.playerX,
        w.playerZ,
        a.keepRange,
        speed * 0.6,
        e.orbitDir,
        1.2,
      );
      clampLen(desired, speed);
      if (e.stateT >= e.stateDur) {
        e.stateT = 0;
        e.stateDur = w.rng.range(1.5, 3);
        if (w.rng.next() < 0.4) e.orbitDir = -e.orbitDir;
      }
      if (e.fireCd <= 0 && distToPlayer(e, w) <= a.castRange) {
        if (!w.requestAttack(e)) {
          e.fireCd = 0.5;
          return;
        }
        const wind = a.windup * w.tempo;
        e.setState(AiState.Attack, wind);
        e.ax = w.playerX;
        e.az = w.playerZ;
        e.seam = Math.floor(w.rng.next() * 4) & 3;
        w.telegraph(e, wind);
        w.sfx('scribble_fire', e.position.x, e.position.y + 1.2, e.position.z, 0.7);
      }
      return;
    }

    if (e.state !== AiState.Attack) return;
    if (e.phase === WARDEN_WINDUP) {
      desired.x = desired.z = 0;
      e.windup = Math.min(1, e.stateT / Math.max(1e-3, e.stateDur));
      // The preview frame tracks the player for the first 60%, then locks (fair read).
      if (e.windup < 0.6 && w.hasPlayer) {
        e.ax = w.playerX;
        e.az = w.playerZ;
      }
      e.aimX = e.ax;
      e.aimZ = e.az;
      if (e.stateT >= e.stateDur) {
        e.phase = WARDEN_BOX;
        e.stateT = 0;
        e.stateDur = a.shrinkS;
        e.boxHalf = a.boxSize * 0.5;
        e.windup = 0;
        e.timerA = 0;
        e.timerB = 0;
        w.sfx('page_turn', e.ax, 1, e.az, 0.6);
      }
      return;
    }

    // Box active: shrink, keep the warden outside it, gutter damage.
    const k = Math.min(1, e.stateT / Math.max(1e-3, e.stateDur));
    e.boxHalf = (a.boxSize + (a.boxMin - a.boxSize) * k) * 0.5;
    const ox = e.position.x - e.ax;
    const oz = e.position.z - e.az;
    const m = e.boxHalf + e.radius + 0.6;
    if (Math.abs(ox) < m && Math.abs(oz) < m) {
      const d = Math.sqrt(ox * ox + oz * oz) || 1;
      desired.x = (ox / d) * speed;
      desired.z = (oz / d) * speed;
    } else desired.x = desired.z = 0;
    if (w.hasPlayer && inGutter(e, w.playerX, w.playerZ)) {
      e.timerB += dt;
      if (e.timerB >= a.gutterGrace) {
        e.timerA -= dt;
        if (e.timerA <= 0) {
          e.timerA = a.gutterTick;
          w.damagePlayer(e, t.panelWarden.damage, 0.3);
        }
      }
    } else {
      e.timerB = 0;
      e.timerA = 0;
    }
    if (e.stateT >= e.stateDur) {
      e.boxHalf = 0;
      e.fireCd = a.cooldown * w.tempo;
      w.sfx('crystal_off', e.ax, 1, e.az, 0.5);
      PanelWardenBrain.stalk(e, w);
    }
  },
};
