/**
 * M2 render acceptance (PLAN §6 M2): the POC scene rebuilt on the new stack is compared side by
 * side with the original POC; the reveal shader is checked against its CPU mirror; the comic
 * moments render without errors. Uses the dev server on :5197 started by playwright.config.ts (the harness page is dev-only).
 */
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';

const PORT = 5197;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '../..');
const THREE_DIR = path.join(ROOT, 'node_modules/three');

test.describe.configure({ mode: 'serial' });

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function harness(page: Page, query: string) {
  await page.goto(`${BASE}/dev/render.html?shot=1&${query}`);
  await expect(page.locator('html[data-ready="1"]')).toBeAttached({ timeout: 60_000 });
}

/** Screenshot the original POC (three CDN routed to the local package). */
async function pocReference(page: Page): Promise<Buffer> {
  await page.route('https://cdn.jsdelivr.net/npm/three@0.170.0/**', (route) => {
    const rel = new URL(route.request().url()).pathname.replace('/npm/three@0.170.0/', '');
    return route.fulfill({ path: path.join(THREE_DIR, rel), contentType: 'text/javascript' });
  });
  await page.goto(`${BASE}/reference/poc/index.html`);
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('msg')!).display === 'none',
    null,
    {
      timeout: 60_000,
    },
  );
  await page.evaluate(() => {
    for (const id of ['ui', 'credit']) document.getElementById(id)!.style.display = 'none';
    (document.getElementById('boil') as HTMLInputElement).checked = false;
  });
  await page.waitForTimeout(800);
  return page.screenshot();
}

/** Compare two screenshots in-browser: coarse luminance structure + palette-bucket histogram. */
async function compare(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(
    async ([sa, sb]) => {
      const load = async (src: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${src}`;
        await img.decode();
        return img;
      };
      const [ia, ib] = await Promise.all([load(sa), load(sb)]);
      const W = 36;
      const H = Math.round((W * ia.height) / ia.width);
      const grab = (img: HTMLImageElement) => {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const g = c.getContext('2d')!;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, W, H);
        return g.getImageData(0, 0, W, H).data;
      };
      const da = grab(ia);
      const db = grab(ib);
      let lum = 0;
      const ha = new Float32Array(27);
      const hb = new Float32Array(27);
      const bucket = (d: Uint8ClampedArray, i: number) =>
        Math.min(2, Math.floor(d[i]! / 86)) * 9 +
        Math.min(2, Math.floor(d[i + 1]! / 86)) * 3 +
        Math.min(2, Math.floor(d[i + 2]! / 86));
      for (let i = 0; i < da.length; i += 4) {
        const la = 0.3 * da[i]! + 0.59 * da[i + 1]! + 0.11 * da[i + 2]!;
        const lb = 0.3 * db[i]! + 0.59 * db[i + 1]! + 0.11 * db[i + 2]!;
        lum += Math.abs(la - lb) / 255;
        ha[bucket(da, i)]! += 1;
        hb[bucket(db, i)]! += 1;
      }
      const n = da.length / 4;
      let inter = 0;
      for (let k = 0; k < 27; k++) inter += Math.min(ha[k]!, hb[k]!) / n;
      return { lumDiff: lum / n, histOverlap: inter };
    },
    [a.toString('base64'), b.toString('base64')] as const,
  );
}

test('POC scene on the new render stack matches the POC look', async ({ page }, info) => {
  const ref = await pocReference(page);
  const errors = watchErrors(page);
  await harness(page, 'poc=1');
  await page.waitForTimeout(800);
  const ours = await page.screenshot();
  await info.attach('poc-reference', { body: ref, contentType: 'image/png' });
  await info.attach('poc-rebuilt', { body: ours, contentType: 'image/png' });
  const m = await compare(page, ref, ours);
  await info.attach('metrics', { body: JSON.stringify(m, null, 2), contentType: 'application/json' });
  console.log(`[visual] ${info.project.name} POC vs rebuilt`, m);
  expect(errors).toEqual([]);
  expect(m.lumDiff).toBeLessThan(0.12);
  expect(m.histOverlap).toBeGreaterThan(0.7);
});

test('reveal shader matches its CPU mirror', async ({ page }) => {
  const errors = watchErrors(page);
  await harness(page, 'freeze=1');
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() =>
    (window.__ink as { probe(n: number): Record<string, number> }).probe(1024),
  );
  console.log('[visual] reveal probe', r);
  expect(errors).toEqual([]);
  expect(r.maxErr!).toBeLessThan(0.02);
  expect(r.mismatched!).toBe(0);
});

test('reveal, panel cut and page turn render cleanly', async ({ page }, info) => {
  const errors = watchErrors(page);
  await harness(page, 'freeze=1&dist=2');
  await page.waitForTimeout(1500);
  await info.attach('reveal', { body: await page.screenshot(), contentType: 'image/png' });
  await page.evaluate(() => (window.__ink as { panelCut(): void }).panelCut());
  await page.waitForTimeout(350);
  await info.attach('panel-cut', { body: await page.screenshot(), contentType: 'image/png' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const ink = window.__ink as { render: { turn: { hold: number | null } }; pageTurn(): Promise<void> };
    ink.render.turn.hold = 0.3;
    void ink.pageTurn();
  });
  await page.waitForTimeout(400);
  await info.attach('page-turn', { body: await page.screenshot(), contentType: 'image/png' });
  const stats = await page.evaluate(() => (window.__ink as { render: { stats: object } }).render.stats);
  console.log('[visual] stats', stats);
  expect(errors).toEqual([]);
});
