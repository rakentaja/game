import type { LevelDef } from '../core/types';
import { LevelCollision } from './LevelCollision';
import { buildLayout, type Layout } from './layout';
import { PathSampler } from './path';
import { buildHeightfield, type Heightfield } from './terrain';

/** Everything about a page that doesn't need WebGL: spine, ground, dressing, collision. */
export interface LevelData {
  def: LevelDef;
  path: PathSampler;
  height: Heightfield;
  layout: Layout;
  collision: LevelCollision;
}

export function buildLevelData(def: LevelDef): LevelData {
  const path = new PathSampler(def.path, def.pathWidth, def.widths);
  const height = buildHeightfield(def, path);
  const layout = buildLayout(def, path);
  const collision = new LevelCollision(def, path, height, layout.blockers);
  return { def, path, height, layout, collision };
}
