/**
 * Co-op hooks on a page (LevelRuntime.coop): every wizard feeds the triggers (a page end fires
 * only once BOTH are inside it), and the sketch printer listens to whichever crystal is actually
 * over an unprinted sketch.
 */
import type { GameContext, LevelDef } from '../core/types';
import type { RevealSystem } from '../render/reveal/RevealSystem';
import { type CrystalSample, SketchObjects } from '../systems/sketch-objects';
import type { Triggers } from '../systems/triggers';
import type { LevelRuntime } from '../world/install';

export function levelHooks(ctx: GameContext): NonNullable<LevelRuntime['coop']> {
  const pts = new Float32Array(6);
  const s2: CrystalSample = { held: false, x: 0, z: 0, radius: 0 };
  const reaches = (c: CrystalSample, sk: SketchObjects, def: LevelDef) => {
    if (!c.held) return false;
    for (const s of def.sketches)
      if (!sk.isPrinted(s.id) && sk.isEnabled(s.id) && SketchObjects.inReach(s, c)) return true;
    return false;
  };
  return {
    triggers(t: Triggers) {
      const list = ctx.players ?? [];
      const n = Math.min(2, list.length);
      for (let k = 0; k < n; k++) {
        const q = list[k]!;
        pts[k * 3] = q.position.x;
        pts[k * 3 + 1] = q.position.y;
        pts[k * 3 + 2] = q.position.z;
      }
      if (n > 1) t.updateAll(pts, n);
      else if (ctx.player) t.update(ctx.player.position.x, ctx.player.position.y, ctx.player.position.z);
    },
    sample(own, sk, def) {
      if (reaches(own, sk, def)) return own;
      // crystal 0 = this machine's wizard, crystal 1 = the partner's
      for (const q of ctx.players ?? []) {
        if (q === ctx.player) continue;
        s2.held = q.crystalHeld && !q.downed;
        s2.x = q.crystalPos.x;
        s2.z = q.crystalPos.z;
        s2.radius = (ctx.reveal as RevealSystem).radius2;
        if (reaches(s2, sk, def)) return s2;
      }
      return own;
    },
  };
}

/** Put the other local wizards next to the page start (the level teleports `ctx.player` only). */
export function placeOthers(ctx: GameContext, lvl: LevelRuntime): void {
  const me = ctx.player;
  if (!me) return;
  for (const p of ctx.players ?? []) {
    if (p === me || p.remote) continue;
    const x = me.position.x + ((p.slot ?? 1) - (me.slot ?? 0)) * 1.4;
    const z = me.position.z;
    p.teleport(x, lvl.built.collision.groundHeight(x, z), z, Math.atan2(me.facing.x, me.facing.z));
  }
}
