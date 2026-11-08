/**
 * Upstream asset sources. `bun scripts/fetch-assets.ts` downloads each into assets/source/<id>/,
 * verifying sha256 against assets/sources.lock.json. Licences were verified on the official pages
 * (see docs/ASSET_RESEARCH.md); the licence recorded here is the one shipped inside the download.
 */

export type SourceKind =
  /** itch.io pack, free tier ("name your own price", $0). `file` matches the upload name. */
  | { type: 'itch'; user: string; slug: string; file: RegExp }
  /** Direct HTTPS download. */
  | { type: 'url'; url: string }
  /** File already in this repository (e.g. the POC reference model). */
  | { type: 'repo'; path: string; decode?: 'base64-js-default' };

export interface Source {
  id: string;
  title: string;
  author: string;
  /** Page where the licence was verified. */
  page: string;
  license: string;
  licenseUrl: string;
  kind: SourceKind;
  /** Archive? Extracted into assets/source/<id>/. */
  unzip?: boolean;
  /** Upstream fallback / manual instructions when the automated route fails. */
  manual?: string;
}

const CC0 = 'https://creativecommons.org/publicdomain/zero/1.0/';

export const SOURCES: Source[] = [
  {
    id: 'poc-wizard',
    title: 'Wizard (RPG Character Pack)',
    author: 'Quaternius',
    page: 'https://quaternius.com/packs/rpgcharacters.html',
    license: 'CC0-1.0',
    licenseUrl: CC0,
    kind: { type: 'repo', path: 'reference/poc/wizard-model.js', decode: 'base64-js-default' },
    manual:
      'Upstream is a Google Drive folder (quota-limited). The repo keeps the exact POC copy; to re-verify, download glTF/Wizard.gltf from the pack page.',
  },
  {
    id: 'quaternius-ual1',
    title: 'Universal Animation Library (Standard)',
    author: 'Quaternius',
    page: 'https://quaternius.itch.io/universal-animation-library',
    license: 'CC0-1.0',
    licenseUrl: CC0,
    kind: { type: 'itch', user: 'quaternius', slug: 'universal-animation-library', file: /Standard/ },
    unzip: true,
  },
  {
    id: 'quaternius-ual2',
    title: 'Universal Animation Library 2 (Standard)',
    author: 'Quaternius',
    page: 'https://quaternius.itch.io/universal-animation-library-2',
    license: 'CC0-1.0',
    licenseUrl: CC0,
    kind: { type: 'itch', user: 'quaternius', slug: 'universal-animation-library-2', file: /Standard/ },
    unzip: true,
  },
  {
    id: 'quaternius-ubc',
    title: 'Universal Base Characters (Standard)',
    author: 'Quaternius',
    page: 'https://quaternius.itch.io/universal-base-characters',
    license: 'CC0-1.0',
    licenseUrl: CC0,
    kind: { type: 'itch', user: 'quaternius', slug: 'universal-base-characters', file: /Standard/ },
    unzip: true,
  },
  {
    id: 'quaternius-nature',
    title: 'Stylized Nature MegaKit (Standard)',
    author: 'Quaternius',
    page: 'https://quaternius.itch.io/stylized-nature-megakit',
    license: 'CC0-1.0',
    licenseUrl: CC0,
    kind: { type: 'itch', user: 'quaternius', slug: 'stylized-nature-megakit', file: /Standard/ },
    unzip: true,
  },
  {
    id: 'kaykit-halloween',
    title: 'KayKit Halloween Bits 1.0',
    author: 'Kay Lousberg (KayKit)',
    page: 'https://kaylousberg.itch.io/halloween-bits',
    license: 'CC0-1.0',
    licenseUrl: CC0,
    kind: {
      type: 'url',
      url: 'https://codeload.github.com/KayKit-Game-Assets/KayKit-Halloween-Bits-1.0/zip/6dc69bf6b2fa766a985754f35ec6a0324090e6c6',
    },
    unzip: true,
  },
  {
    id: 'kaykit-forest',
    title: 'KayKit Forest Nature Pack (Free)',
    author: 'Kay Lousberg (KayKit)',
    page: 'https://kaylousberg.itch.io/kaykit-forest',
    license: 'CC0-1.0',
    licenseUrl: CC0,
    kind: { type: 'itch', user: 'kaylousberg', slug: 'kaykit-forest', file: /^Free/ },
    unzip: true,
  },
  {
    id: 'ambientcg-paper003',
    title: 'Paper 003',
    author: 'ambientCG (Lennart Demes)',
    page: 'https://ambientcg.com/view?id=Paper003',
    license: 'CC0-1.0',
    licenseUrl: CC0,
    kind: { type: 'url', url: 'https://ambientcg.com/get?file=Paper003_1K-JPG.zip' },
    unzip: true,
  },
  {
    id: 'font-bangers',
    title: 'Bangers',
    author: 'Vernon Adams',
    page: 'https://fonts.google.com/specimen/Bangers',
    license: 'OFL-1.1',
    licenseUrl:
      'https://raw.githubusercontent.com/google/fonts/c13390277dfb1fcc7415d84ef7ef9cfc1e52f8c1/ofl/bangers/OFL.txt',
    kind: {
      type: 'url',
      url: 'https://raw.githubusercontent.com/google/fonts/c13390277dfb1fcc7415d84ef7ef9cfc1e52f8c1/ofl/bangers/Bangers-Regular.ttf',
    },
  },
  {
    id: 'font-bangers-ofl',
    title: 'Bangers OFL licence text',
    author: 'Vernon Adams',
    page: 'https://fonts.google.com/specimen/Bangers',
    license: 'OFL-1.1',
    licenseUrl: 'https://openfontlicense.org',
    kind: {
      type: 'url',
      url: 'https://raw.githubusercontent.com/google/fonts/c13390277dfb1fcc7415d84ef7ef9cfc1e52f8c1/ofl/bangers/OFL.txt',
    },
  },
  {
    id: 'font-comicneue',
    title: 'Comic Neue Bold',
    author: 'Craig Rozynski, Hrant Papazian',
    page: 'https://fonts.google.com/specimen/Comic+Neue',
    license: 'OFL-1.1',
    licenseUrl:
      'https://raw.githubusercontent.com/google/fonts/3dd78844021e948ceb633d1dcee3f7885561b5d9/ofl/comicneue/OFL.txt',
    kind: {
      type: 'url',
      url: 'https://raw.githubusercontent.com/google/fonts/3dd78844021e948ceb633d1dcee3f7885561b5d9/ofl/comicneue/ComicNeue-Bold.ttf',
    },
  },
  {
    id: 'font-comicneue-ofl',
    title: 'Comic Neue OFL licence text',
    author: 'Craig Rozynski, Hrant Papazian',
    page: 'https://fonts.google.com/specimen/Comic+Neue',
    license: 'OFL-1.1',
    licenseUrl: 'https://openfontlicense.org',
    kind: {
      type: 'url',
      url: 'https://raw.githubusercontent.com/google/fonts/3dd78844021e948ceb633d1dcee3f7885561b5d9/ofl/comicneue/OFL.txt',
    },
  },
];

export function sourceById(id: string): Source {
  const s = SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown source ${id}`);
  return s;
}
