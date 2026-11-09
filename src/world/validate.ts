import type { LevelDef } from '../core/types';
import { TUNING } from '../data/tuning';
import { buildLevelData, type LevelData } from './levelData';
import type { Rect } from './path';

const RES = 0.4;

/** Occupancy grid flood fill from the player start, honouring walkability and trunk blockers. */
export class ReachGrid {
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  readonly reach: Uint8Array;

  constructor(data: LevelData, startX: number, startZ: number) {
    const h = data.height;
    this.x0 = h.x0;
    this.z0 = h.z0;
    this.nx = Math.ceil((h.maxX - h.x0) / RES) + 1;
    this.nz = Math.ceil((h.maxZ - h.z0) / RES) + 1;
    this.reach = new Uint8Array(this.nx * this.nz);
    const pr = TUNING.player.radius;
    const free = new Uint8Array(this.nx * this.nz);
    const blockers = data.layout.blockers;
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = this.x0 + i * RES;
        const z = this.z0 + j * RES;
        if (!data.collision.walkable(x, z)) continue;
        free[j * this.nx + i] = 1;
      }
    }
    for (const b of blockers) {
      const rr = b.r + pr * 0.9;
      for (let j = Math.floor((b.z - rr - this.z0) / RES); j <= Math.ceil((b.z + rr - this.z0) / RES); j++)
        for (
          let i = Math.floor((b.x - rr - this.x0) / RES);
          i <= Math.ceil((b.x + rr - this.x0) / RES);
          i++
        ) {
          if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
          const x = this.x0 + i * RES;
          const z = this.z0 + j * RES;
          if ((x - b.x) ** 2 + (z - b.z) ** 2 < rr * rr) free[j * this.nx + i] = 0;
        }
    }
    const si = Math.round((startX - this.x0) / RES);
    const sj = Math.round((startZ - this.z0) / RES);
    const stack: number[] = [];
    const s = sj * this.nx + si;
    if (free[s]) {
      this.reach[s] = 1;
      stack.push(s);
    }
    while (stack.length) {
      const c = stack.pop()!;
      const ci = c % this.nx;
      const cj = (c - ci) / this.nx;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= this.nx || nj >= this.nz) continue;
          const n = nj * this.nx + ni;
          if (free[n] && !this.reach[n]) {
            this.reach[n] = 1;
            stack.push(n);
          }
        }
    }
  }

  at(x: number, z: number): boolean {
    const i = Math.round((x - this.x0) / RES);
    const j = Math.round((z - this.z0) / RES);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return false;
    return this.reach[j * this.nx + i] === 1;
  }

  /** Any reachable cell within `r` of (x,z)? */
  near(x: number, z: number, r: number): boolean {
    for (let j = Math.floor((z - r - this.z0) / RES); j <= Math.ceil((z + r - this.z0) / RES); j++)
      for (let i = Math.floor((x - r - this.x0) / RES); i <= Math.ceil((x + r - this.x0) / RES); i++) {
        if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
        const cx = this.x0 + i * RES;
        const cz = this.z0 + j * RES;
        if ((cx - x) ** 2 + (cz - z) ** 2 <= r * r && this.reach[j * this.nx + i]) return true;
      }
    return false;
  }

  anyInRect(r: Rect): boolean {
    for (let j = Math.ceil((r[1] - this.z0) / RES); j <= Math.floor((r[3] - this.z0) / RES); j++)
      for (let i = Math.ceil((r[0] - this.x0) / RES); i <= Math.floor((r[2] - this.x0) / RES); i++) {
        if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
        if (this.reach[j * this.nx + i]) return true;
      }
    return false;
  }

  get reachableArea(): number {
    let n = 0;
    for (let i = 0; i < this.reach.length; i++) n += this.reach[i]!;
    return n * RES * RES;
  }
}

export interface ValidationReport {
  errors: string[];
  /** Arc length of the walk spine (m). */
  pathLength: number;
  /** Rough first-time play estimate (s): travel + fights + prints + pauses. */
  estimateS: number;
}

/**
 * Static checks a level must pass: start/end/checkpoints walkable, every gate really gates, every
 * sketch can be reached and printed in order, every trigger/well/spawn is reachable once printed.
 */
export function validateLevel(def: LevelDef, data: LevelData = buildLevelData(def)): ValidationReport {
  const errors: string[] = [];
  const err = (m: string) => errors.push(`[page ${def.page}] ${m}`);
  const col = data.collision;
  col.reset();
  const [sx, , sz] = def.playerStart.at;
  const end = def.path[def.path.length - 1]!;

  if (def.widths && def.widths.length !== def.path.length) err('widths length must equal path length');
  if (!col.walkable(sx, sz)) err('playerStart not walkable');
  if (!col.walkable(end[0], end[1])) err('path end not walkable');

  const ids = new Set<string>();
  for (const t of def.triggers) {
    if (ids.has(t.id)) err(`duplicate trigger id ${t.id}`);
    ids.add(t.id);
  }
  const sketchIds = new Set(def.sketches.map((s) => s.id));
  if (sketchIds.size !== def.sketches.length) err('duplicate sketch ids');
  const fireable = new Set<string>([
    ...ids,
    ...def.sketches.flatMap((s) => (s.ambushTrigger ? [s.ambushTrigger] : [])),
  ]);
  for (const sp of def.spawns)
    if (sp.trigger && !fireable.has(sp.trigger)) err(`spawn trigger ${sp.trigger} never fires`);
  if (def.page !== 'boss' && !def.triggers.some((t) => t.action?.type === 'pageEnd'))
    err('no pageEnd trigger');
  for (const c of def.checkpoints) {
    if (!col.walkable(c.at[0], c.at[2])) err(`checkpoint ${c.id} not walkable`);
    if (
      !def.triggers.some((t) => t.id === c.id && t.action?.type === 'checkpoint') &&
      c.id !== def.checkpoints[0]?.id
    )
      err(`checkpoint ${c.id} has no checkpoint trigger`);
  }

  // sketches in walk order
  const order = [...def.sketches].sort(
    (a, b) => arcOf(data, a.at[0], a.at[2]) - arcOf(data, b.at[0], b.at[2]),
  );
  const gating = order.filter((s) => s.unlocks);
  const required = TUNING.sketch.requiredRadius * 0.75;
  for (const s of order) {
    const g = new ReachGrid(data, sx, sz);
    if (!g.near(s.at[0], s.at[2], required)) err(`sketch ${s.id} cannot be approached within ${required} m`);
    if (s.unlocks) col.unlock(s.id, s.type === 'bridge');
  }
  const full = new ReachGrid(data, sx, sz);
  if (!full.at(end[0], end[1])) err('path end unreachable with all sketches printed');
  for (const c of def.checkpoints)
    if (!full.near(c.at[0], c.at[2], 0.6)) err(`checkpoint ${c.id} unreachable`);
  for (const w of def.inkWells)
    if (!full.near(w[0], w[1], TUNING.world.wellRadius)) err(`ink well at ${w[0]},${w[1]} unreachable`);
  for (const t of def.triggers) if (!full.anyInRect(t.rect)) err(`trigger ${t.id} rect unreachable`);
  for (const sp of def.spawns)
    if (!full.near(sp.at[0], sp.at[1], 5)) err(`spawn ${sp.kind}@${sp.at} is >5 m from the walk`);

  // every gate must actually gate: with it locked, the end is unreachable
  col.reset();
  if (gating.length) {
    const g0 = new ReachGrid(data, sx, sz);
    if (g0.at(end[0], end[1])) err('end reachable without printing any sketch (gates leak)');
    for (let k = 0; k < gating.length; k++) {
      col.reset();
      for (let m = 0; m < gating.length; m++)
        if (m !== k) col.unlock(gating[m]!.id, gating[m]!.type === 'bridge');
      const g = new ReachGrid(data, sx, sz);
      if (g.at(end[0], end[1])) err(`sketch ${gating[k]!.id} does not gate the walk`);
    }
  }
  col.reset();

  const pathLength = data.path.length;
  const counts = { smudge: 0, scribbler: 0, blot: 0 };
  for (const s of def.spawns) if (s.kind in counts) counts[s.kind as keyof typeof counts]++;
  const hints = def.triggers.filter((t) => t.action?.type === 'tutorial').length;
  const estimateS =
    pathLength / 3.4 +
    counts.smudge * 3 +
    counts.scribbler * 6 +
    counts.blot * 7 +
    def.sketches.length * 9 +
    hints * 4 +
    8;
  return { errors, pathLength, estimateS };
}

function arcOf(data: LevelData, x: number, z: number): number {
  const h = { dist: 0, s: 0, halfW: 0, px: 0, pz: 0, tx: 0, tz: 0 };
  return data.path.nearest(x, z, h).s;
}
