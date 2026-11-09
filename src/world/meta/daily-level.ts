/**
 * Daily Issue page variants (lazy chunk: only a Daily run builds them; MetaRuntime.ready()).
 */
import type { LevelDef, SpawnDef } from '../../core/types';
import { TUNING } from '../../data/tuning';
import { makeHit, PathSampler } from '../path';
import { makeRng } from '../rng';
import { type DailyInfo, dailySeed } from './daily';

/**
 * A spawn slot is valid when it stays near the walk (path spine or a clearing, the same "within
 * reach of the walk" rule validate.ts enforces), sits in no void, does not cross a void (wall,
 * cliff, chasm) from its authored spot — near-side ambushes stay near-side — and keeps its
 * distance from the page start. Cheap (no flood fill), so it runs at page start on phones;
 * tests/unit/world-meta.test.ts runs the full `validateLevel` over daily variants.
 */
export function spawnSlotValidator(
  def: LevelDef,
): (fromX: number, fromZ: number, x: number, z: number) => boolean {
  const D = TUNING.worldMeta.daily;
  const path = new PathSampler(def.path, def.pathWidth, def.widths);
  const hit = makeHit();
  const voids = def.voids ?? [];
  const [sx, , sz] = def.playerStart.at;
  return (fromX, fromZ, x, z) => {
    if (Math.hypot(x - sx, z - sz) < D.minStartDist) return false;
    path.nearest(x, z, hit);
    let near = hit.dist <= hit.halfW + D.walkSlack;
    for (const c of def.clearings)
      if (!near && Math.hypot(x - c[0], z - c[1]) <= c[2] + D.walkSlack) near = true;
    if (!near) return false;
    for (const v of voids) {
      const r = v.rect;
      if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return false;
      if (segmentHitsRect(fromX, fromZ, x, z, r)) return false;
    }
    return true;
  };
}

/** Liang–Barsky: does segment a→b touch rect [minX, minZ, maxX, maxZ]? */
export function segmentHitsRect(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  r: readonly [number, number, number, number],
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  const p = [-dx, dx, -dz, dz];
  const q = [ax - r[0], r[2] - ax, az - r[1], r[3] - az];
  for (let i = 0; i < 4; i++) {
    const pi = p[i]!;
    const qi = q[i]!;
    if (pi === 0) {
      if (qi < 0) return false;
      continue;
    }
    const t = qi / pi;
    if (pi < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * The page as printed in today's Daily: every spawn nudged (up to `spawnJitter` m) to a valid
 * slot (see `spawnSlotValidator`); `doubleGhosts` adds a jittered twin per spawn (dropped if no
 * valid slot). Spawns that find no valid slot keep their authored position.
 */
export function dailyLevel(def: LevelDef, info: DailyInfo): LevelDef {
  if (def.page === 'boss') return def;
  const D = TUNING.worldMeta.daily;
  const rng = makeRng(dailySeed(info, def));
  const valid = spawnSlotValidator(def);
  const place = (sp: SpawnDef, minR: number): SpawnDef | null => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = rng() * Math.PI * 2;
      const r = minR + rng() * (D.spawnJitter - minR * 0.5);
      const x = sp.at[0] + Math.cos(a) * r;
      const z = sp.at[1] + Math.sin(a) * r;
      if (valid(sp.at[0], sp.at[1], x, z)) return { ...sp, at: [round(x), round(z)] };
    }
    return null;
  };
  const spawns: SpawnDef[] = [];
  for (const sp of def.spawns) {
    spawns.push(place(sp, 0) ?? sp);
    if (info.rule === 'doubleGhosts') {
      const twin = place(sp, 1.2);
      if (twin) spawns.push(twin);
    }
  }
  const fog = info.rule === 'thickFog' ? { near: def.fog.near * 0.72, far: def.fog.far * 0.78 } : def.fog;
  return { ...def, seed: def.seed, spawns, fog };
}

const round = (v: number) => Math.round(v * 100) / 100;
