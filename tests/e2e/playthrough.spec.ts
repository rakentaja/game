import { expect, test } from '@playwright/test';

/**
 * Full Issue #1 run driven by the autoplay bot (?autoplay=1). Logs key events, screenshots
 * each page start and the cover. Long-running: only in the `iphone14` project.
 */
test('autoplay completes Issue #1', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone14', 'one device is enough for the long run');
  test.setTimeout(15 * 60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?autoplay=1');
  await page.waitForFunction(() => (window as any).__game?.ctx?.player, null, { timeout: 60_000 });
  await page.evaluate(() => {
    const w = window as any;
    w.__log = [];
    const g = w.__game;
    for (const e of [
      'page:start',
      'page:complete',
      'player:died',
      'enemy:died',
      'sketch:printed',
      'checkpoint:reached',
      'boss:phase',
      'boss:defeated',
      'boss:death',
      'state:change',
    ])
      g.ctx.events.on(e, (p: unknown) => w.__log.push([Math.round(g.ctx.stats.timeS), e, JSON.stringify(p)]));
  });
  const seen = new Set<string>();
  const deadline = Date.now() + 14 * 60_000;
  let last = '';
  let stuckSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    const s = await page.evaluate(() => {
      const g = (window as any).__game;
      return {
        mode: g.mode as string,
        page: String(g.page),
        t: Math.round(g.ctx.stats.timeS),
        pos: g.player.position.toArray().map((v: number) => Math.round(v)),
        pages: g.player.pages,
        energy: Math.round(g.player.energy),
        fps: Math.round(1000 / g.render.stats.frameMs),
        log: (window as any).__log.splice(0),
      };
    });
    console.log(JSON.stringify(s));
    const key = `${s.mode}:${s.page}`;
    if (!seen.has(key)) {
      seen.add(key);
      await page.screenshot({ path: `test-results/run-${key.replace(':', '-')}.png` });
    }
    const sig = `${key}:${s.pos.join(',')}`;
    if (sig !== last) {
      last = sig;
      stuckSince = Date.now();
    } else if (Date.now() - stuckSince > 60_000) throw new Error(`stuck at ${sig}`);
    if (s.mode === 'cover') break;
  }
  await page.screenshot({ path: 'test-results/run-cover.png' });
  expect(errors).toEqual([]);
  expect(seen.has('cover:null') || [...seen].some((k) => k.startsWith('cover'))).toBe(true);
});
