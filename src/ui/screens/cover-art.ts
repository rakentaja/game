/**
 * Draws the "ISSUE #1 — COMPLETE" comic cover on a canvas: masthead, price box, the player's best
 * panel as cover art, starburst, blurb, stats strip and a barcode that encodes the run. The same
 * canvas is shown on screen and exported as the share PNG.
 */
import type { RunStats } from '../../core/types';
import { PAL } from '../../data/palette';
import { drawLogo } from '../logo';

export const COVER_W = 1000;
export const COVER_H = 1500;

export interface CoverText {
  complete: string;
  number: string;
  price: string;
  month: string;
  subtitle: string;
  blurb: string;
  featuring: string;
  seal: string;
  stats: { label: string; value: string }[];
  upper(s: string): string;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((r) => {
    const img = new Image();
    img.onload = () => r(img);
    img.onerror = () => r(null);
    img.src = src;
  });
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function burst(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r1: number,
  r2: number,
  n: number,
  rot: number,
) {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i * Math.PI) / n;
    const r = i % 2 ? r2 * (0.85 + 0.15 * Math.sin(i * 2.1)) : r1;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.82;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.closePath();
}

function dots(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  hh: number,
  color: string,
  step: number,
  r: number,
) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, hh);
  g.clip();
  g.fillStyle = color;
  for (let yy = y; yy < y + hh + step; yy += step) {
    const off = Math.round((yy - y) / step) % 2 ? step / 2 : 0;
    for (let xx = x - step + off; xx < x + w + step; xx += step) {
      g.beginPath();
      g.arc(xx, yy, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}

/** Fit text to a max width by shrinking the font size. */
function fitFont(
  g: CanvasRenderingContext2D,
  text: string,
  family: string,
  size: number,
  maxW: number,
): number {
  let s = size;
  g.font = `${s}px ${family}`;
  while (s > 10 && g.measureText(text).width > maxW) {
    s -= 2;
    g.font = `${s}px ${family}`;
  }
  return s;
}

/** Procedural fallback art when no panel snapshot exists (dev / snapshot failure). */
export function drawFallbackArt(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  hh: number,
  seed = 7,
) {
  const r = rng(seed);
  g.save();
  g.beginPath();
  g.rect(x, y, w, hh);
  g.clip();
  g.fillStyle = PAL.teal[0];
  g.fillRect(x, y, w, hh);
  // ink-revealed clearing
  const cx = x + w * 0.5;
  const cy = y + hh * 0.62;
  const rings: [string, number][] = [
    [PAL.teal[1], 0.62],
    [PAL.teal[2], 0.44],
    [PAL.teal[3], 0.3],
  ];
  for (const [c, k] of rings) {
    g.fillStyle = c;
    g.beginPath();
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const rr = w * k * (1 + 0.08 * Math.sin(a * 5 + seed) + 0.05 * Math.sin(a * 11));
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr * 0.55;
      if (i) g.lineTo(px, py);
      else g.moveTo(px, py);
    }
    g.fill();
  }
  // trees (silhouettes in deep teal with ink outline)
  for (let i = 0; i < 16; i++) {
    const tx = x + r() * w;
    const back = r() < 0.5;
    const th = hh * (back ? 0.35 + r() * 0.2 : 0.5 + r() * 0.3);
    const tw = th * (0.28 + r() * 0.1);
    const by = y + hh * (back ? 0.5 : 0.95 + r() * 0.1);
    if (Math.abs(tx - cx) < w * 0.18 && !back) continue;
    g.fillStyle = back ? PAL.teal[1] : PAL.teal[0];
    g.strokeStyle = PAL.ink;
    g.lineWidth = 5;
    g.beginPath();
    for (let k = 0; k < 3; k++) {
      const ly = by - th * (0.25 + k * 0.28);
      const lw = tw * (1 - k * 0.25);
      g.moveTo(tx - lw, ly + th * 0.22);
      g.lineTo(tx, ly - th * 0.2);
      g.lineTo(tx + lw, ly + th * 0.22);
      g.closePath();
    }
    g.fill();
    g.stroke();
  }
  // crystal glow
  const gx = cx + w * 0.07;
  const gy = cy - hh * 0.26;
  for (const [c, rad] of [
    [PAL.glowEdge, 70],
    [PAL.glowCore, 40],
    [PAL.ghost[3], 16],
  ] as const) {
    g.fillStyle = c;
    g.beginPath();
    g.arc(gx, gy, rad, 0, Math.PI * 2);
    g.fill();
  }
  // wizard silhouette: robe + hat + staff
  g.fillStyle = PAL.red[1];
  g.strokeStyle = PAL.ink;
  g.lineWidth = 7;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(cx - 70, cy + 70);
  g.quadraticCurveTo(cx - 40, cy - 70, cx - 10, cy - 120);
  g.lineTo(cx - 60, cy - 150);
  g.lineTo(cx + 10, cy - 260);
  g.lineTo(cx + 30, cy - 140);
  g.quadraticCurveTo(cx + 50, cy - 40, cx + 70, cy + 70);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = PAL.red[2];
  g.beginPath();
  g.moveTo(cx - 6, cy - 120);
  g.quadraticCurveTo(cx + 30, cy - 40, cx + 40, cy + 64);
  g.lineTo(cx + 10, cy + 64);
  g.quadraticCurveTo(cx + 6, cy - 30, cx - 6, cy - 120);
  g.fill();
  g.strokeStyle = PAL.staff[2];
  g.lineWidth = 10;
  g.beginPath();
  g.moveTo(gx - 10, gy + 30);
  g.lineTo(gx - 40, cy + 80);
  g.stroke();
  // paper ghosts at the edge of the light
  const ghostX = [0.14, 0.84, 0.3];
  const ghostY = [0.36, 0.42, 0.18];
  for (let i = 0; i < 3; i++) {
    const px = x + w * ghostX[i]! + r() * 20;
    const py = y + hh * ghostY[i]! + r() * 20;
    g.fillStyle = PAL.ghost[2];
    g.strokeStyle = PAL.ink;
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(px - 40, py + 60);
    g.quadraticCurveTo(px - 46, py - 50, px, py - 56);
    g.quadraticCurveTo(px + 46, py - 50, px + 40, py + 60);
    g.lineTo(px + 22, py + 44);
    g.lineTo(px + 6, py + 62);
    g.lineTo(px - 10, py + 44);
    g.lineTo(px - 24, py + 62);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = PAL.ink;
    g.beginPath();
    g.ellipse(px - 13, py - 12, 6, 10, 0, 0, Math.PI * 2);
    g.ellipse(px + 13, py - 12, 6, 10, 0, 0, Math.PI * 2);
    g.fill();
  }
  // line-screen shading over the darks
  g.strokeStyle = PAL.ink;
  g.lineWidth = 3;
  for (let i = -hh; i < w; i += 11) {
    g.beginPath();
    g.moveTo(x + i, y);
    g.lineTo(x + i + hh * 0.53, y + hh * 0.42);
    g.stroke();
  }
  g.restore();
}

/** Barcode bars from run stats (decorative but deterministic per run). */
function barcode(g: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, digits: string) {
  g.fillStyle = PAL.paper;
  g.strokeStyle = PAL.ink;
  g.lineWidth = 4;
  g.fillRect(x, y, w, hh);
  g.strokeRect(x, y, w, hh);
  const r = rng([...digits].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  let bx = x + 14;
  g.fillStyle = PAL.ink;
  while (bx < x + w - 16) {
    const bw = 2 + Math.floor(r() * 3) * 2;
    const tall = bx < x + 24 || bx > x + w - 30 || Math.abs(bx - (x + w / 2)) < 4;
    g.fillRect(bx, y + 12, bw, hh - (tall ? 24 : 44));
    bx += bw + 2 + Math.floor(r() * 3) * 2;
  }
  g.font = `22px Anton, Impact, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillText(digits, x + w / 2, y + hh - 10);
}

export async function drawCover(canvas: HTMLCanvasElement, stats: RunStats, txt: CoverText): Promise<void> {
  canvas.width = COVER_W;
  canvas.height = COVER_H;
  const g = canvas.getContext('2d')!;
  const W = COVER_W;
  const H = COVER_H;
  if (document.fonts) {
    await Promise.all(
      ['64px Bangers', '64px Anton', '700 32px Kalam'].map((f) =>
        document.fonts.load(f, 'AZaz09İıŞşĞğÇçÖöÜü').catch(() => null),
      ),
    );
  }
  const up = txt.upper;

  // paper
  g.fillStyle = PAL.paper;
  g.fillRect(0, 0, W, H);

  // ─ art ─
  const ax = 40;
  const ay = 300;
  const aw = W - 80;
  const ah = 960;
  const img = stats.bestPanel ? await loadImage(stats.bestPanel) : null;
  if (img) {
    const k = Math.max(aw / img.width, ah / img.height);
    const iw = img.width * k;
    const ih = img.height * k;
    g.save();
    g.beginPath();
    g.rect(ax, ay, aw, ah);
    g.clip();
    g.drawImage(img, ax + (aw - iw) / 2, ay + (ah - ih) / 2, iw, ih);
    g.restore();
  } else {
    drawFallbackArt(g, ax, ay, aw, ah, Math.round(stats.timeS) || 7);
  }
  g.strokeStyle = PAL.ink;
  g.lineWidth = 10;
  g.strokeRect(ax, ay, aw, ah);

  // ─ masthead band ─
  g.fillStyle = PAL.red[2];
  g.fillRect(0, 0, W, 290);
  dots(g, 0, 0, W, 290, PAL.red[1], 12, 2.4);
  g.fillStyle = PAL.ink;
  g.fillRect(0, 282, W, 14);
  drawLogo(g, W / 2 + 80, 150, 720, { extrude: PAL.red[1], outline: PAL.ink, fill: PAL.paper, gem: true });

  // price box (top-left)
  g.save();
  g.translate(40, 34);
  g.fillStyle = PAL.paper;
  g.strokeStyle = PAL.ink;
  g.lineWidth = 6;
  g.fillRect(0, 0, 150, 200);
  g.strokeRect(0, 0, 150, 200);
  g.fillStyle = PAL.ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fitFont(g, up(txt.number), 'Anton, Impact, sans-serif', 46, 130);
  g.fillText(up(txt.number), 75, 46);
  g.fillRect(14, 78, 122, 4);
  g.fillStyle = PAL.red[1];
  fitFont(g, up(txt.price), 'Bangers, Impact, sans-serif', 58, 130);
  g.fillText(up(txt.price), 75, 122);
  g.fillStyle = PAL.ink;
  fitFont(g, up(txt.month), 'Anton, Impact, sans-serif', 30, 130);
  g.fillText(up(txt.month), 75, 174);
  g.restore();

  // subtitle strip under masthead
  g.save();
  g.translate(W / 2 + 70, 262);
  g.rotate(-0.012);
  const sub = up(txt.subtitle);
  fitFont(g, sub, 'Bangers, Impact, sans-serif', 44, 640);
  const sw = g.measureText(sub).width + 60;
  g.fillStyle = PAL.ink;
  g.fillRect(-sw / 2, -30, sw, 56);
  g.fillStyle = PAL.glowCore;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(sub, 0, 0);
  g.restore();

  // ─ starburst "ISSUE #1 — COMPLETE!" ─
  g.save();
  g.translate(W - 210, 470);
  g.rotate(0.14);
  burst(g, 0, 0, 190, 140, 16, 0.1);
  g.fillStyle = PAL.ink;
  g.translate(8, 10);
  g.fill();
  g.translate(-8, -10);
  burst(g, 0, 0, 190, 140, 16, 0.1);
  g.fillStyle = PAL.glowCore;
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = PAL.ink;
  g.stroke();
  g.fillStyle = PAL.ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const parts = up(txt.complete).split(/\s+[—-]\s+/);
  const l1 = parts[0] ?? '';
  const l2 = parts[1] ?? '';
  fitFont(g, l1, 'Bangers, Impact, sans-serif', 66, 230);
  g.fillText(l1, 0, l2 ? -34 : 0);
  if (l2) {
    g.fillStyle = PAL.red[1];
    fitFont(g, l2, 'Bangers, Impact, sans-serif', 70, 250);
    g.fillText(l2, 0, 34);
  }
  g.restore();

  // ─ blurb caption (bottom-left of art) ─
  g.save();
  g.translate(70, 1080);
  g.rotate(-0.03);
  const blurb = up(txt.blurb);
  fitFont(g, blurb, 'Bangers, Impact, sans-serif', 62, 560);
  const bw = g.measureText(blurb).width + 50;
  g.fillStyle = PAL.ink;
  g.fillRect(8, 8, bw, 84);
  g.fillStyle = PAL.paper;
  g.fillRect(0, 0, bw, 84);
  g.lineWidth = 5;
  g.strokeStyle = PAL.ink;
  g.strokeRect(0, 0, bw, 84);
  g.fillStyle = PAL.ink;
  g.textBaseline = 'middle';
  g.fillText(blurb, 25, 46);
  g.restore();

  // featuring
  g.save();
  g.translate(70, 1196);
  g.rotate(-0.03);
  g.fillStyle = PAL.paper;
  g.strokeStyle = PAL.ink;
  g.lineWidth = 8;
  g.lineJoin = 'round';
  const feat = up(txt.featuring);
  fitFont(g, feat, 'Bangers, Impact, sans-serif', 40, 540);
  g.strokeText(feat, 0, 0);
  g.fillText(feat, 0, 0);
  g.restore();

  // ─ bottom band: stats + seal + barcode ─
  g.fillStyle = PAL.ink;
  g.fillRect(0, 1272, W, H - 1272);
  dots(g, 0, 1272, W, H - 1272, PAL.staff[1], 10, 2);
  const cols = txt.stats.slice(0, 4);
  const colW = 620 / cols.length;
  g.textAlign = 'left';
  cols.forEach((st, i) => {
    const x = 44 + i * colW;
    g.fillStyle = PAL.ghost[1];
    fitFont(g, up(st.label), 'Bangers, Impact, sans-serif', 26, colW - 16);
    g.textBaseline = 'alphabetic';
    g.fillText(up(st.label), x, 1340);
    g.fillStyle = PAL.paper;
    fitFont(g, st.value, 'Anton, Impact, sans-serif', 66, colW - 16);
    g.fillText(st.value, x, 1420);
  });
  // seal
  g.save();
  g.translate(150, 1462);
  g.fillStyle = PAL.glowCore;
  fitFont(g, up(txt.seal), 'Bangers, Impact, sans-serif', 26, 560);
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(`✦ ${up(txt.seal)} ✦`, -106, 0);
  g.restore();
  // barcode
  const t = Math.round(stats.timeS);
  const digits = `1 ${String(t).padStart(4, '0')} ${String(stats.ghostsInked).padStart(3, '0')} ${String(stats.deaths).padStart(2, '0')}`;
  barcode(g, W - 300, 1296, 240, 160, digits);

  // ─ aged paper: worn edges & corner fold ─
  g.strokeStyle = PAL.ghost[1];
  g.lineWidth = 3;
  const r = rng(99);
  for (let i = 0; i < 60; i++) {
    const side = i % 4;
    const p = r() * (side % 2 ? H : W);
    const len = 6 + r() * 18;
    g.beginPath();
    if (side === 0) {
      g.moveTo(p, 0);
      g.lineTo(p + r() * 6, len * 0.4);
    } else if (side === 1) {
      g.moveTo(W, p);
      g.lineTo(W - len * 0.4, p + r() * 6);
    } else if (side === 2) {
      g.moveTo(p, H);
      g.lineTo(p + r() * 6, H - len * 0.4);
    } else {
      g.moveTo(0, p);
      g.lineTo(len * 0.4, p + r() * 6);
    }
    g.stroke();
  }
  g.fillStyle = PAL.ghost[2];
  g.beginPath();
  g.moveTo(W, H - 70);
  g.lineTo(W - 70, H);
  g.lineTo(W, H);
  g.closePath();
  g.fill();
  g.fillStyle = PAL.ghost[1];
  g.beginPath();
  g.moveTo(W, H - 70);
  g.lineTo(W - 70, H);
  g.lineTo(W - 62, H - 62);
  g.closePath();
  g.fill();
  g.strokeStyle = PAL.ink;
  g.lineWidth = 3;
  g.stroke();
}
