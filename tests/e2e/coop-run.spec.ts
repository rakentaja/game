import { expect, type Page, test } from '@playwright/test';

/**
 * Online co-op run, end to end, offline: two pages of one browser context talk over
 * BroadcastChannel (?nettransport=loopback-bc) through a lossy link (?netsim=rtt150,jit40,loss3),
 * and both wizards are driven by the autoplay bot. Asserts the page turns (on BOTH machines)
 * only after BOTH bots reached the exit, then closes the guest and expects the host to go solo.
 *
 * Long-running (two software-GL pages): iphone14 project only, opt out with COOP_RUN_E2E=0.
 */

const NET = 'nettransport=loopback-bc&netsim=rtt150,jit40,loss3&autoplay=1&lang=en';

/** In-page probe: when this page's bot reached the path end, and when page 2 started. */
async function probe(p: Page): Promise<void> {
  await p.waitForFunction(() => (window as any).__game?.ctx?.events, null, { timeout: 90_000 });
  await p.evaluate(() => {
    const w = window as any;
    w.__probe = { doneAt: 0, page2At: 0, errors: [] as string[] };
    w.__game.ctx.events.on('page:start', (e: { page: unknown }) => {
      if (e.page === 2 && !w.__probe.page2At) w.__probe.page2At = Date.now();
    });
    setInterval(() => {
      const b = w.__game?.bot;
      if (b?.done && !w.__probe.doneAt && w.__game.page === 1) w.__probe.doneAt = Date.now();
    }, 50);
  });
}

test('online co-op: both bots must reach the exit before the page turns; guest leaves → host solo', async ({
  context,
}, info) => {
  test.skip(info.project.name !== 'iphone14', 'one device profile is enough');
  test.skip(process.env.COOP_RUN_E2E === '0', 'COOP_RUN_E2E=0');
  test.setTimeout(14 * 60_000);
  const errors: string[] = [];
  const host = await context.newPage();
  const guest = await context.newPage();
  for (const [name, p] of [
    ['host', host],
    ['guest', guest],
  ] as const) {
    p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
    });
  }

  // host opens a room from the title (autoplay + ?coop=host keeps the title instead of auto-starting)
  await host.bringToFront();
  await host.goto(`/?${NET}&coop=host`);
  await expect(host.locator('.scr-title')).toBeVisible({ timeout: 90_000 });
  await host.locator('[data-act="coop"]').click();
  await host.locator('[data-act="host"]').click();
  const code = await host.locator('.coop-code [data-code]').getAttribute('data-code');
  expect(code).toMatch(/^[A-Z2-9]{6}$/);

  // guest follows the invite link
  await guest.bringToFront();
  await guest.goto(`/?${NET}&room=${code}`);
  await expect(guest.locator('.coop-card')).toHaveAttribute('data-state', 'connected', { timeout: 90_000 });
  await guest.locator('[data-act="ready"]').click();
  await host.bringToFront();
  await expect(host.locator('.coop-card')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  await host.locator('[data-act="ready"]').click();
  await expect(host.locator('[data-act="start"]')).toBeEnabled({ timeout: 15_000 });
  await host.locator('[data-act="start"]').click();

  // both machines enter the run as host / guest
  await expect(host.locator('html')).toHaveAttribute('data-coop', 'host', { timeout: 60_000 });
  await expect(guest.locator('html')).toHaveAttribute('data-coop', 'guest', { timeout: 60_000 });
  await probe(host);
  await probe(guest);

  const read = (p: Page) =>
    p.evaluate(() => {
      const w = window as any;
      const g = w.__game;
      return {
        page: g.page,
        mode: g.mode,
        bot: g.bot?.mode ?? null,
        done: !!g.bot?.done,
        pos: g.player.position.toArray().map((v: number) => Math.round(v)),
        net: w.__net ?? null,
        probe: w.__probe,
      };
    });

  const deadline = Date.now() + 11 * 60_000;
  let h = await read(host);
  let g = await read(guest);
  while (Date.now() < deadline && !(h.probe.page2At && g.probe.page2At)) {
    // alternate which page is in front (background tabs may get throttled rAF)
    await (Math.floor(Date.now() / 4000) % 2 ? host : guest).bringToFront();
    await host.waitForTimeout(2000);
    h = await read(host);
    g = await read(guest);
    console.log(
      JSON.stringify({
        host: { page: h.page, bot: h.bot, done: h.done, pos: h.pos, peers: h.net?.players },
        guest: { page: g.page, bot: g.bot, done: g.done, pos: g.pos, rtt: Math.round(g.net?.rtt ?? -1) },
      }),
    );
  }
  expect(h.probe.page2At, 'host reached page 2').toBeGreaterThan(0);
  expect(g.probe.page2At, 'guest reached page 2').toBeGreaterThan(0);
  // the page only turned once BOTH bots had reached the exit
  const bothDone = Math.max(h.probe.doneAt, g.probe.doneAt);
  expect(h.probe.doneAt).toBeGreaterThan(0);
  expect(g.probe.doneAt).toBeGreaterThan(0);
  expect(h.probe.page2At).toBeGreaterThanOrEqual(bothDone - 500);
  expect(g.probe.page2At).toBeGreaterThanOrEqual(bothDone - 500);

  // guest closes its tab → host fades the partner out and continues solo
  await guest.close();
  await host.bringToFront();
  await expect(host.locator('html')).toHaveAttribute('data-coop', 'solo', { timeout: 60_000 });
  const solo = await host.evaluate(() => (window as any).__net);
  expect(solo).toMatchObject({ solo: true, players: 1 });
  expect(errors).toEqual([]);
});
