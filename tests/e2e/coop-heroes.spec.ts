import { expect, type Page, test } from '@playwright/test';

/**
 * Heroes in co-op, end to end (wave 3), both driven by the autoplay bot:
 *  - local 2P (?local2p=1&hero=penciller&hero2=letterer) plays through page 2 → page 3 starts;
 *  - online (two pages over BroadcastChannel + netsim): host Letterer + guest Colorist picked in
 *    the lobby; each machine plays its own kit and a puppet of the partner's, through page 1.
 *
 * Long-running (software GL): iphone14 only; COOP_RUN_E2E=0 skips. The sim may catch up more
 * steps per frame than the shipped 5 (slow CI), exactly like boss.spec — game logic is unchanged.
 */

async function errorsOf(p: Page, name: string, into: string[]): Promise<void> {
  p.on('pageerror', (e) => into.push(`${name}: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') into.push(`${name}: ${m.text()}`);
  });
}

async function speedUp(p: Page): Promise<void> {
  await p.waitForFunction(() => (window as any).__game?.loop, null, { timeout: 90_000 });
  await p.evaluate(() => {
    (window as any).__game.loop.maxSteps = 40;
  });
}

/** In-page probe: page starts (sim seconds), hero actions per pid, combos, splash per pid. */
async function probe(p: Page): Promise<void> {
  await p.waitForFunction(() => (window as any).__game?.ctx?.events, null, { timeout: 90_000 });
  await p.evaluate(() => {
    const w = window as any;
    const g = w.__game;
    w.__probe = {
      pages: [] as [unknown, number][],
      acts: {} as Record<string, number>,
      combos: [],
      splash: {},
    };
    const ev = g.ctx.events;
    ev.on('page:start', (e: { page: unknown }) =>
      w.__probe.pages.push([e.page, Math.round(g.ctx.stats.timeS)]),
    );
    ev.on('hero:action', (e: { pid: number; hero: string }) => {
      const k = `${e.pid}:${e.hero}`;
      w.__probe.acts[k] = (w.__probe.acts[k] ?? 0) + 1;
    });
    ev.on('hero:combo', (e: { combo: string; kind?: string }) =>
      w.__probe.combos.push(`${e.combo}:${e.kind}`),
    );
    ev.on('splash:changed', (e: { pid: number; value: number }) => {
      w.__probe.splash[e.pid] = Math.max(w.__probe.splash[e.pid] ?? 0, e.value);
    });
  });
}

const state = (p: Page) =>
  p.evaluate(() => {
    const w = window as any;
    const g = w.__game;
    const c = g.coop;
    return {
      page: g.page,
      mode: g.mode,
      t: Math.round(g.ctx.stats.timeS),
      hero: g.player.kit.id,
      partner: c?.remote?.body?.kit?.id ?? c?.p2?.kit?.id ?? null,
      partnerRemote: c?.remote?.body?.kit?.remote ?? null,
      pos: g.player.position.toArray().map((v: number) => Math.round(v)),
      bot: g.bot?.mode ?? null,
      p2: c?.p2
        ? [
            c.p2.position.toArray().map((v: number) => Math.round(v)),
            c.bot?.mode,
            Math.round(c.energy2.value),
            [...c.rules.down],
          ]
        : null,
      fps: Math.round(1000 / g.render.stats.frameMs),
      probe: w.__probe,
      net: w.__net ? { role: w.__net.role, players: w.__net.players, rtt: Math.round(w.__net.rtt) } : null,
    };
  });

test('local 2P: Penciller + Letterer autoplay through page 2', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone14', 'one device profile is enough');
  test.skip(process.env.COOP_RUN_E2E === '0', 'COOP_RUN_E2E=0');
  test.setTimeout(20 * 60_000);
  const errors: string[] = [];
  await errorsOf(page, 'local', errors);
  await page.goto('/?local2p=1&autoplay=1&hero=penciller&hero2=letterer&lang=en');
  await speedUp(page);
  await probe(page);
  await expect(page.locator('html')).toHaveAttribute('data-coop', 'local', { timeout: 90_000 });
  const deadline = Date.now() + 18 * 60_000;
  let s = await state(page);
  while (Date.now() < deadline && !s.probe.pages.some(([p]: [unknown]) => p === 3)) {
    await page.waitForTimeout(5000);
    s = await state(page);
    console.log(JSON.stringify({ ...s, probe: { ...s.probe, combos: s.probe.combos.length } }));
  }
  console.log('[local2p] result', JSON.stringify(s.probe));
  expect(s.hero).toBe('penciller');
  expect(s.partner).toBe('letterer');
  expect(s.probe.pages.map(([p]: [unknown]) => p)).toContain(3);
  expect(s.probe.acts['0:penciller'] ?? 0).toBeGreaterThan(5);
  expect(s.probe.acts['1:letterer'] ?? 0).toBeGreaterThan(5);
  // both Splash meters charged (per player)
  expect(s.probe.splash[0] ?? 0).toBeGreaterThan(0);
  expect(s.probe.splash[1] ?? 0).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

const NET = 'nettransport=loopback-bc&netsim=rtt150,jit40,loss3&autoplay=1&lang=en';

test('online co-op: host Letterer + guest Colorist play their own kits and the partner puppet through page 1', async ({
  context,
}, info) => {
  test.skip(info.project.name !== 'iphone14', 'one device profile is enough');
  test.skip(process.env.COOP_RUN_E2E === '0', 'COOP_RUN_E2E=0');
  test.setTimeout(16 * 60_000);
  const errors: string[] = [];
  const host = await context.newPage();
  const guest = await context.newPage();
  await errorsOf(host, 'host', errors);
  await errorsOf(guest, 'guest', errors);

  await host.bringToFront();
  await host.goto(`/?${NET}&coop=host`);
  await expect(host.locator('.scr-title')).toBeVisible({ timeout: 90_000 });
  await host.locator('[data-act="coop"]').click();
  await host.locator('[data-act="host"]').click();
  const code = await host.locator('.coop-code [data-code]').getAttribute('data-code');
  expect(code).toMatch(/^[A-Z2-9]{6}$/);
  await host.locator('[data-hero="letterer"]').click();

  await guest.bringToFront();
  await guest.goto(`/?${NET}&room=${code}`);
  await expect(guest.locator('.coop-card')).toHaveAttribute('data-state', 'connected', { timeout: 90_000 });
  await guest.locator('[data-hero="colorist"]').click();
  await expect(guest.locator('[data-hero="colorist"]')).toHaveAttribute('aria-checked', 'true');
  await guest.locator('[data-act="ready"]').click();
  await host.bringToFront();
  await expect(host.locator('.coop-card')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  await host.locator('[data-act="ready"]').click();
  await expect(host.locator('[data-act="start"]')).toBeEnabled({ timeout: 15_000 });
  await host.locator('[data-act="start"]').click();

  await expect(host.locator('html')).toHaveAttribute('data-coop', 'host', { timeout: 60_000 });
  await expect(guest.locator('html')).toHaveAttribute('data-coop', 'guest', { timeout: 60_000 });
  await speedUp(host);
  await speedUp(guest);
  await probe(host);
  await probe(guest);

  const deadline = Date.now() + 13 * 60_000;
  let h = await state(host);
  let g = await state(guest);
  const turned = (s: typeof h) => s.probe.pages.some(([p]: [unknown]) => p === 2);
  while (Date.now() < deadline && !(turned(h) && turned(g))) {
    await (Math.floor(Date.now() / 4000) % 2 ? host : guest).bringToFront();
    await host.waitForTimeout(3000);
    h = await state(host);
    g = await state(guest);
    console.log(
      JSON.stringify({
        host: { page: h.page, t: h.t, hero: h.hero, partner: h.partner, pos: h.pos, acts: h.probe.acts },
        guest: { page: g.page, t: g.t, hero: g.hero, partner: g.partner, pos: g.pos, rtt: g.net?.rtt },
      }),
    );
  }
  console.log('[online] host', JSON.stringify(h.probe), 'guest', JSON.stringify(g.probe));
  // each machine plays its own pick and a remote puppet of the partner's
  expect(h.hero).toBe('letterer');
  expect(g.hero).toBe('colorist');
  expect(h.partner).toBe('colorist');
  expect(g.partner).toBe('letterer');
  expect(h.partnerRemote).toBe(true);
  expect(g.partnerRemote).toBe(true);
  // the partner's actions arrived (host hears the guest Colorist through the net)
  expect(h.probe.acts['1:colorist'] ?? 0).toBeGreaterThan(3);
  expect(g.probe.acts['1:colorist'] ?? 0).toBeGreaterThan(3);
  expect(h.probe.acts['0:letterer'] ?? 0).toBeGreaterThan(3);
  expect(turned(h), 'host reached page 2').toBe(true);
  expect(turned(g), 'guest reached page 2').toBe(true);
  expect(errors).toEqual([]);
});
