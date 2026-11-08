/**
 * Onomatopoeia stamp: hand-jittered comic lettering baked to a canvas texture. Layers are packed
 * into channels so the post pass composes them with exact palette colours at any scale:
 *   R ink (letter + burst outlines) · G letter fill · B starburst fill · A drop shadow
 */
import * as THREE from 'three';

export const STAMP_W = 1024;
export const STAMP_H = 512;

/** Built-in display words for `fx:panelCut` keys (UI i18n may override via ctx.t). */
export const WORDS: Record<string, string> = {
  krak: 'KRAK!',
  fwoosh: 'FWOOSH!',
  splat: 'SPLAT!',
  thwip: 'THWIP!',
  skrrt: 'SKRRT!',
  boom: 'BOOM!',
  shhk: 'SHHK!',
  rrip: 'RRIP!',
  blam: 'BLAM!',
  zap: 'ZAP!',
};

const FONT = `900 FONTSIZEpx "Bangers", Impact, "Haettenschweiler", "Arial Black", "Helvetica Neue", sans-serif`;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5;
    s ^= s + Math.imul(s ^ (s >>> 7), 61 | s);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

interface Glyph {
  ch: string;
  x: number;
  y: number;
  rot: number;
  scale: number;
}

function layout(
  ctx: CanvasRenderingContext2D,
  word: string,
  seed: number,
): { glyphs: Glyph[]; size: number } {
  const r = rng(seed);
  let size = 230;
  ctx.font = FONT.replace('FONTSIZE', String(size));
  let total = 0;
  const widths: number[] = [];
  for (const ch of word) {
    const w = ctx.measureText(ch).width * 0.92;
    widths.push(w);
    total += w;
  }
  const maxW = STAMP_W * 0.74;
  if (total > maxW) {
    const k = maxW / total;
    size *= k;
    total = maxW;
    for (let i = 0; i < widths.length; i++) widths[i]! *= k;
  }
  const glyphs: Glyph[] = [];
  let x = (STAMP_W - total) / 2;
  let i = 0;
  const n = widths.length;
  for (const ch of word) {
    const w = widths[i]!;
    const t = n > 1 ? i / (n - 1) : 0.5;
    // letters grow toward the end of the word and ride a slight arc: shouted, not typed
    glyphs.push({
      ch,
      x: x + w / 2,
      y: STAMP_H * 0.56 - Math.sin(t * Math.PI) * 18 + (r() - 0.5) * 22,
      rot: (r() - 0.5) * 0.22 - 0.04,
      scale: 0.88 + t * 0.22 + (r() - 0.5) * 0.08,
    });
    x += w;
    i++;
  }
  return { glyphs, size };
}

function drawGlyphs(
  ctx: CanvasRenderingContext2D,
  g: Glyph[],
  size: number,
  mode: 'fill' | 'stroke',
  dx = 0,
  dy = 0,
  lw = 0,
): void {
  ctx.font = FONT.replace('FONTSIZE', String(size));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw;
  for (const q of g) {
    ctx.save();
    ctx.translate(q.x + dx, q.y + dy);
    ctx.rotate(q.rot);
    ctx.scale(q.scale, q.scale * 1.08);
    if (mode === 'fill') ctx.fillText(q.ch, 0, 0);
    else {
      ctx.strokeText(q.ch, 0, 0);
      ctx.fillText(q.ch, 0, 0);
    }
    ctx.restore();
  }
}

function burstPath(ctx: CanvasRenderingContext2D, seed: number, scale: number): void {
  const r = rng(seed * 7 + 3);
  const cx = STAMP_W / 2;
  const cy = STAMP_H / 2;
  const spikes = 19;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2 + 0.1;
    const outer = i % 2 === 0;
    const rr = (outer ? 0.5 + r() * 0.12 : 0.34 + r() * 0.05) * scale;
    const x = cx + Math.cos(a) * rr * STAMP_W * 0.92;
    const y = cy + Math.sin(a) * rr * STAMP_H * 0.98;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

const cache = new Map<string, THREE.Texture>();

/** Returns a cached stamp texture for `word` (display text, e.g. "KRAK!"). */
export function stampTexture(word: string): THREE.Texture {
  const hit = cache.get(word);
  if (hit) return hit;
  let seed = 7;
  for (const c of word) seed = (Math.imul(seed, 31) + c.charCodeAt(0)) >>> 0;
  const layer = document.createElement('canvas');
  layer.width = STAMP_W;
  layer.height = STAMP_H;
  const ctx = layer.getContext('2d', { willReadFrequently: true })!;
  const { glyphs, size } = layout(ctx, word, seed);
  const out = new Uint8ClampedArray(STAMP_W * STAMP_H * 4);
  const grab = (ch: number, draw: () => void) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, STAMP_W, STAMP_H);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    draw();
    const d = ctx.getImageData(0, 0, STAMP_W, STAMP_H).data;
    for (let i = 0; i < STAMP_W * STAMP_H; i++) out[i * 4 + ch] = d[i * 4]!;
  };
  // B: burst
  grab(2, () => {
    burstPath(ctx, seed, 1);
    ctx.fill();
  });
  // A: drop shadow (offset, thick)
  grab(3, () => drawGlyphs(ctx, glyphs, size, 'stroke', 16, 18, 26));
  // G: letter fill
  grab(1, () => drawGlyphs(ctx, glyphs, size, 'fill'));
  // R: ink outlines — letters (thick stroke minus fill) + burst contour
  grab(0, () => {
    ctx.lineWidth = 11;
    burstPath(ctx, seed, 1);
    ctx.stroke();
    drawGlyphs(ctx, glyphs, size, 'stroke', 0, 0, 22);
    ctx.globalCompositeOperation = 'destination-out';
    drawGlyphs(ctx, glyphs, size, 'fill');
    ctx.globalCompositeOperation = 'source-over';
  });
  // canvas rows are top-down; flip so uv.y up matches
  const flipped = new Uint8Array(out.length);
  const row = STAMP_W * 4;
  for (let y = 0; y < STAMP_H; y++)
    flipped.set(out.subarray((STAMP_H - 1 - y) * row, (STAMP_H - y) * row), y * row);
  const tex = new THREE.DataTexture(flipped, STAMP_W, STAMP_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  cache.set(word, tex);
  return tex;
}
