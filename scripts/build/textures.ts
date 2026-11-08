/**
 * Paper grain for the post pass: ambientCG Paper003 colour map → greyscale, contrast-normalised so
 * the shader can use (v − 0.5) as a signed grain term. Tileable (source is tileable; we only scale).
 */
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { buildPath, sourcePath } from './paths';

export async function buildPaper(): Promise<string[]> {
  const src = sourcePath('ambientcg-paper003', 'Paper003_1K-JPG_Color.jpg');
  const { data, info } = await sharp(src).greyscale().raw().toBuffer({ resolveWithObject: true });
  let mean = 0;
  for (const v of data) mean += v;
  mean /= data.length;
  let varc = 0;
  for (const v of data) varc += (v - mean) ** 2;
  const sd = Math.sqrt(varc / data.length) || 1;
  const out = Buffer.alloc(data.length);
  // map to mean 128, ±2.5σ → ±110
  for (let i = 0; i < data.length; i++)
    out[i] = Math.max(0, Math.min(255, Math.round(128 + ((data[i]! - mean) / sd) * 44)));
  const raw = { raw: { width: info.width, height: info.height, channels: 1 as const } };
  const files: string[] = [];
  for (const [name, size] of [
    ['paper_grain.webp', 1024],
    ['paper_grain_512.webp', 512],
  ] as const) {
    const buf = await sharp(out, raw)
      .resize(size, size, { kernel: 'lanczos3' })
      .webp({ quality: 82, effort: 6 })
      .toBuffer();
    const p = buildPath(name);
    writeFileSync(p, buf);
    files.push(p);
  }
  return files;
}
