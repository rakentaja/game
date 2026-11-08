import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ROOT = join(import.meta.dirname, '../..');
export const SOURCE_DIR = join(ROOT, 'assets/source');
export const BUILD_DIR = join(ROOT, 'assets/build');
export const PUBLIC_DIR = join(ROOT, 'public/assets');

export const sourcePath = (id: string, rel: string) => join(SOURCE_DIR, id, rel);
export function buildPath(rel: string): string {
  const p = join(BUILD_DIR, rel);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}
