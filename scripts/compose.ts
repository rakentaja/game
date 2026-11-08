/**
 * Build intermediate GLBs (assets/build/) from the fetched sources: wizard (retarget + authored
 * clips), boss, props, procedural originals, textures. `optimize.ts` turns these into public/assets.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { buildBoss } from './build/boss';
import { buildEraser, buildPack, FOREST, GRAVEYARD } from './build/props';
import { buildPaper } from './build/textures';
import { buildWizard } from './build/wizard';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const only = process.argv.slice(2);
const want = (k: string) => !only.length || only.includes(k);

if (want('wizard')) console.log('✓', await buildWizard(io));
if (want('props')) {
  console.log('✓', await buildPack(io, 'props_forest', FOREST));
  console.log('✓', await buildPack(io, 'props_graveyard', GRAVEYARD));
  console.log('✓', await buildEraser(io));
}
if (want('boss')) console.log('✓', await buildBoss(io));
if (want('textures')) for (const f of await buildPaper()) console.log('✓', f);
