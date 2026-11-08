/**
 * ?autoplay=1 on the boss page: wraps the generic autoplay bot. While the Editor is awake this
 * plays the fight like a decent player — reads telegraphs and steps/dashes out of lanes, walks to
 * pinned arms, prints sketched weak points, lights and shoots the bowing core. Before the fight
 * (and after it) the wrapped bot keeps walking the path, which fires `boss_intro`.
 */
import * as THREE from 'three';
import type { GameContext, InputState } from '../../core/types';
import type { Editor } from './Editor';
import { CORE_INDEX } from './fsm';

interface Drivable {
  drive(s: InputState, dt: number): void;
}

const _v = new THREE.Vector2();

export function attachEditorBot(
  bot: Drivable,
  editor: Editor,
  ctx: GameContext,
  view: { forward: THREE.Vector3; right: THREE.Vector3 },
): void {
  const base = bot.drive.bind(bot);
  let fireT = 0;
  let walkT = 0;
  const toScreen = (wx: number, wz: number, out: THREE.Vector2) => {
    const l = Math.hypot(wx, wz) || 1;
    out.set((wx * view.right.x + wz * view.right.z) / l, (wx * view.forward.x + wz * view.forward.z) / l);
  };
  bot.drive = (s: InputState, dt: number) => {
    base(s, dt);
    const f = editor.fsm;
    const p = ctx.player;
    const px = p?.position.x ?? 0;
    const pz = p?.position.z ?? 0;
    if (!p) return;
    if (f.state === 'dormant') {
      // the path ends at the arena mouth: keep walking in until boss_intro fires
      const [cx, cz] = ctx.tuning.boss.arena;
      if (pz < cz + 13 && pz > cz + 4) toScreen(cx - p.position.x, cz + 3 - pz, s.move);
      return;
    }
    if (!(f.state === 'intro' || f.state === 'phase' || f.state === 'transition')) return;
    const T = ctx.tuning;
    const [bx, bz] = T.boss.pos;
    let gx = Math.sin(f.fightTime * 0.35) * 5;
    let gz = bz + 10;
    let hold = false;
    if (f.state === 'phase' && f.phase === 1) {
      // go stand next to a pinned arm
      for (const w of f.wps)
        if (w.phase === 1 && w.exposed) {
          gx = w.x + 2.5;
          gz = w.z + 3;
        }
    } else if (f.state === 'phase' && f.phase === 2 && f.p2Active >= 0) {
      const w = f.wps[f.p2Active]!;
      gx = w.x + 1.5;
      gz = w.z + 4.5;
      walkT += dt;
      hold = !w.printed && w.drawIn >= 1 && Math.hypot(px - w.x, pz - w.z) < 6 && p.energy > 2;
    } else if (f.state === 'phase' && f.phase === 3) {
      const c = f.wps[CORE_INDEX]!;
      if (f.bowAmt > 0.15) {
        gx = c.x + 0.8;
        gz = c.z + 2.6;
        hold = p.energy > 2;
      } else {
        gx = Math.sin(f.fightTime * 0.4) * 4;
        gz = bz + 8.5;
      }
    }
    // dodge telegraphs
    let dx = 0;
    let dz = 0;
    let dash = false;
    for (const a of f.attacks) {
      if (!a.active || a.stage === 'recover') continue;
      if (a.kind === 'drag') {
        const lx = a.bx - a.ax;
        const lz = a.bz - a.az;
        const l = Math.hypot(lx, lz) || 1;
        const nx = -lz / l;
        const nz = lx / l;
        const side = (px - a.ax) * nx + (pz - a.az) * nz;
        const along = ((px - a.ax) * lx + (pz - a.az) * lz) / (l * l);
        if (Math.abs(side) < a.hw + 1.3 && along > -0.1 && along < 1.1) {
          const sg = side >= 0 ? 1 : -1;
          dx += nx * sg * 4;
          dz += nz * sg * 4;
          if (a.stage === 'strike' || a.p > 0.7) dash = true;
        }
      } else if (Math.hypot(px - a.ax, pz - a.az) < a.hw + 1.5) {
        dx += (px - a.ax) * 3;
        dz += (pz - a.az) * 3;
        if (a.p > 0.75) dash = true;
      }
    }
    let mx = gx - px + dx;
    let mz = gz - pz + dz;
    const l = Math.hypot(mx, mz);
    if (l < 0.5 && dx === 0 && dz === 0) mx = mz = 0;
    s.move.set(0, 0);
    if (mx !== 0 || mz !== 0) toScreen(mx, mz, s.move);
    if (dash) {
      toScreen(mx || dx, mz || dz, _v);
      s.dashDir.copy(_v);
      s.dashPressed = true;
    }
    s.crystalHeld = hold;
    fireT -= dt;
    s.boltPressed = false;
    if (fireT <= 0 && ctx.targets.nearest(p.crystalPos, T.bolt.maxRange) && p.energy >= T.bolt.cost) {
      s.boltPressed = true;
      fireT = 0.25;
    }
    void bx;
    void walkT;
  };
}
