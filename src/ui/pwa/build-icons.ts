/**
 * Generates PWA icons + iOS launch images from public/icons/icon.svg and the logo glyph data.
 *   bun src/ui/pwa/build-icons.ts
 * Renders with Playwright's Chromium (already a dev dependency) so no image tooling is needed.
 * Outputs (committed): public/icons/{icon-192,icon-512,maskable-512,apple-touch-icon}.png and
 * public/icons/splash/*.png.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { PAL } from '../../data/palette';
import { CRYSTAL, CRYSTAL_FACET, LOGO_VIEWBOX, layout } from '../logo';
import { SPLASHES, splashFile } from './splash';

const ROOT = join(import.meta.dirname, '../../..');
const PUB = join(ROOT, 'public');
const svg = readFileSync(join(PUB, 'icons/icon.svg'), 'utf8');
const font = (f: string) =>
  `url(data:font/woff2;base64,${readFileSync(join(PUB, 'fonts', f)).toString('base64')})`;

function logoSvg(): string {
  const v = LOGO_VIEWBOX;
  const g = layout();
  const pass = (cls: string, extra = '') =>
    g.map((p) => `<path d="${p.d}" transform="${p.transform}${extra}" class="${cls}"/>`).join('');
  const i = g[0]!;
  return `<svg viewBox="${v.x} ${v.y} ${v.w} ${v.h}" xmlns="http://www.w3.org/2000/svg">
  <style>path{fill:none;stroke-linecap:square;stroke-linejoin:miter;stroke-miterlimit:3.2}
  .x{stroke:${PAL.red[2]};stroke-width:24}.o{stroke:${PAL.ink};stroke-width:24}.f{stroke:${PAL.paper};stroke-width:10}</style>
  <g transform="skewX(-6)">${pass('x', ' translate(6 7)')}${pass('o')}${pass('f')}
  <g transform="${i.transform}"><path d="${CRYSTAL}" style="fill:${PAL.glowCore};stroke:${PAL.ink};stroke-width:4;stroke-linejoin:round"/>
  <path d="${CRYSTAL_FACET}" style="stroke:${PAL.glowEdge};stroke-width:1.6"/></g></g></svg>`;
}

function splashHtml(w: number, h: number): string {
  const lw = Math.min(w * 0.78, h * 0.5);
  return `<html><head><style>
  @font-face{font-family:Bangers;src:${font('bangers-latin.woff2')}}
  html,body{margin:0;width:${w}px;height:${h}px;background:${PAL.paper};overflow:hidden}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(lw * 0.08)}px}
  .logo{width:${lw}px}
  .sub{font:${Math.round(lw * 0.06)}px Bangers;letter-spacing:.25em;color:${PAL.staff[3]}}
  .frame{position:fixed;inset:${Math.round(w * 0.05)}px;border:${Math.max(2, w / 400)}px solid ${PAL.ghost[1]}}
  </style></head><body><div class="frame"></div><div class="logo">${logoSvg()}</div><div class="sub">ISSUE #1</div></body></html>`;
}

const browser = await chromium.launch();
const shot = async (html: string, w: number, h: number, out: string) => {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(PUB, out), omitBackground: false });
  await page.close();
  console.log('wrote', out);
};
const iconPage = (size: number, scale = 1) =>
  `<html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden;background:${PAL.teal[1]} repeating-linear-gradient(118deg, ${PAL.ink} 0 9px, ${PAL.teal[1]} 9px 14px)">
  <div style="width:${size}px;height:${size}px;transform:scale(${scale})">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`;

mkdirSync(join(PUB, 'icons/splash'), { recursive: true });
await shot(iconPage(192), 192, 192, 'icons/icon-192.png');
await shot(iconPage(512), 512, 512, 'icons/icon-512.png');
await shot(iconPage(512, 0.86), 512, 512, 'icons/maskable-512.png');
await shot(iconPage(180), 180, 180, 'icons/apple-touch-icon.png');
for (const s of SPLASHES) {
  const w = s.w * s.dpr;
  const h = s.h * s.dpr;
  await shot(splashHtml(w, h), w, h, splashFile(s));
}
await browser.close();
