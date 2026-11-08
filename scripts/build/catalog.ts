/**
 * Every shipped asset: what it is, how it is built, its budget class and its provenance (source ids
 * from scripts/sources.ts, or 'original'). optimize.ts turns this into public/assets + manifest.json
 * + assets/licenses.json; validate.ts and credits.ts read those.
 */
import { FOREST, GRAVEYARD } from './props';

export type AssetType = 'character' | 'prop-pack' | 'prop' | 'texture' | 'font' | 'license-text';

export interface CatalogEntry {
  id: string;
  type: AssetType;
  title: string;
  /** File in assets/build (glb) or a source-relative path for copied files. */
  build?: string;
  copy?: { source: string; file: string; ext: string };
  /** Source ids (scripts/sources.ts) this asset is derived from; 'original' = made for INKWAKE. */
  sources: string[];
  /** Max texture edge (px) for GLB textures; textures are re-encoded as WebP. */
  maxTexture?: number;
  /** Prop packs: ids of contained props (node names). */
  props?: { id: string; sources: string[] }[];
  notes?: string;
}

const propSources = (s: { source: string }) => (s.source === 'original' ? ['original'] : [s.source]);

export const CATALOG: CatalogEntry[] = [
  {
    id: 'wizard',
    type: 'character',
    title: 'Wizard (hero) with 14 clips',
    build: 'wizard.glb',
    sources: ['poc-wizard', 'quaternius-ual1', 'quaternius-ual2', 'original'],
    maxTexture: 512,
    notes: 'POC model; UAL clips retargeted to its rig; hold/victory/look/kneel authored for INKWAKE',
  },
  {
    id: 'editor',
    type: 'character',
    title: 'THE EDITOR (boss) with 13 clips',
    build: 'editor.glb',
    sources: ['quaternius-ubc', 'quaternius-ual1', 'quaternius-ual2', 'original'],
    maxTexture: 512,
    notes: 'Universal Base Character + UAL clips; visor and pencil are originals',
  },
  {
    id: 'eraser',
    type: 'prop',
    title: 'Giant eraser',
    build: 'eraser.glb',
    sources: ['original'],
  },
  {
    id: 'props_forest',
    type: 'prop-pack',
    title: 'Forest props (rocks, mushrooms, stumps, dead trees, ferns, bushes)',
    build: 'props_forest.glb',
    sources: [...new Set(FOREST.flatMap(propSources))],
    maxTexture: 256,
    props: FOREST.map((p) => ({ id: p.id, sources: propSources(p) })),
  },
  {
    id: 'props_graveyard',
    type: 'prop-pack',
    title: 'Graveyard & ruins props (graves, lanterns, crypt, arches, fences)',
    build: 'props_graveyard.glb',
    sources: [...new Set(GRAVEYARD.flatMap(propSources))],
    maxTexture: 128,
    props: GRAVEYARD.map((p) => ({ id: p.id, sources: propSources(p) })),
  },
  {
    id: 'paper_grain',
    type: 'texture',
    title: 'Paper grain (tileable, normalised greyscale, 1024²)',
    build: 'paper_grain.webp',
    sources: ['ambientcg-paper003'],
  },
  {
    id: 'paper_grain_512',
    type: 'texture',
    title: 'Paper grain (tileable, normalised greyscale, 512²)',
    build: 'paper_grain_512.webp',
    sources: ['ambientcg-paper003'],
  },
  {
    id: 'font_bangers',
    type: 'font',
    title: 'Bangers (display font)',
    copy: { source: 'font-bangers', file: 'Bangers-Regular.ttf', ext: 'ttf' },
    sources: ['font-bangers'],
  },
  {
    id: 'font_bangers_license',
    type: 'license-text',
    title: 'Bangers SIL OFL 1.1',
    copy: { source: 'font-bangers-ofl', file: 'OFL.txt', ext: 'txt' },
    sources: ['font-bangers-ofl'],
  },
  {
    id: 'font_comicneue',
    type: 'font',
    title: 'Comic Neue Bold (body font)',
    copy: { source: 'font-comicneue', file: 'ComicNeue-Bold.ttf', ext: 'ttf' },
    sources: ['font-comicneue'],
  },
  {
    id: 'font_comicneue_license',
    type: 'license-text',
    title: 'Comic Neue SIL OFL 1.1',
    copy: { source: 'font-comicneue-ofl', file: 'OFL.txt', ext: 'txt' },
    sources: ['font-comicneue-ofl'],
  },
];
