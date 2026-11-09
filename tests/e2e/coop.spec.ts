import { type BrowserContext, expect, type Page, test } from '@playwright/test';

/**
 * Co-op lobby: host on one page, join by code on another, both must reach 'connected'.
 *
 * - Default (offline-safe): `?nettransport=loopback-bc` — a BroadcastChannel transport between two
 *   pages of the SAME browser context (BroadcastChannel does not cross contexts).
 * - `COOP_E2E_REAL=1`: real Trystero over public Nostr relays + STUN, two separate browser
 *   contexts. Needs outbound WebSocket/UDP, so it is opt-in (CI runners/proxies often block it).
 */

async function openTitle(page: Page, query: string): Promise<void> {
  // the boot needs rAF, which background tabs don't get: put this page in front
  await page.bringToFront();
  await page.goto(`/?${query}`);
  await expect(page.locator('html[data-ready="1"]')).toBeAttached({ timeout: 60_000 });
  // loading screen waits for a gesture (audio unlock)
  await expect(page.locator('.loading-tap')).toBeVisible({ timeout: 30_000 });
  // (pointerup, not Enter: a keyboard press would also activate the focused "Read Issue #1")
  await page.locator('.scr-loading').dispatchEvent('pointerup');
  await expect(page.locator('.scr-title')).toBeVisible({ timeout: 15_000 });
}

async function hostRoom(page: Page, query: string): Promise<string> {
  await openTitle(page, query);
  await page.locator('[data-act="coop"]').click();
  await page.locator('[data-act="host"]').click();
  const code = await page.locator('.coop-code [data-code]').getAttribute('data-code');
  expect(code).toMatch(/^[A-Z2-9]{6}$/);
  return code!;
}

async function joinRoom(page: Page, query: string, code: string, viaInput: boolean): Promise<void> {
  if (viaInput) {
    await openTitle(page, query);
    await page.locator('[data-act="coop"]').click();
    await page.locator('#coop-code').fill(code.toLowerCase());
    await page.locator('[data-act="join"]').click();
  } else {
    // invite link: ?room=CODE opens the lobby straight into join mode
    await openTitle(page, `${query}&room=${code}`);
  }
}

async function expectConnected(host: Page, guest: Page, timeout: number): Promise<void> {
  await expect(host.locator('.coop-card')).toHaveAttribute('data-state', 'connected', { timeout });
  await expect(guest.locator('.coop-card')).toHaveAttribute('data-state', 'connected', { timeout });
  await expect(host.locator('.coop-seat[data-slot="1"]')).toHaveAttribute('data-on', 'true');
  await expect(guest.locator('.coop-seat[data-slot="0"]')).toHaveAttribute('data-on', 'true');
}

async function readyAndStart(host: Page, guest: Page): Promise<void> {
  // Playwright's actionability checks need rAF → interact with the page in front only
  await host.bringToFront();
  // all four heroes are selectable; the guest picks the Letterer
  await expect(host.locator('[data-hero="colorist"]')).toBeEnabled();
  await expect(host.locator('[data-hero="inker"]')).toHaveAttribute('aria-checked', 'true');
  await expect(host.locator('[data-act="start"]')).toBeDisabled();
  await host.locator('[data-act="ready"]').click();
  await guest.bringToFront();
  await guest.locator('[data-hero="letterer"]').click();
  await expect(guest.locator('[data-hero="letterer"]')).toHaveAttribute('aria-checked', 'true');
  await guest.locator('[data-act="ready"]').click();
  await guest.evaluate(() => {
    const w = window as unknown as {
      __coopStart?: unknown;
      __game?: { ctx?: { events?: { on: Function } } };
    };
    w.__game?.ctx?.events?.on('coop:start', (e: unknown) => {
      w.__coopStart = e;
    });
  });
  await host.bringToFront();
  await expect(host.locator('[data-act="start"]')).toBeEnabled({ timeout: 10_000 });
  await host.locator('[data-act="start"]').click();
  const ev = await guest.waitForFunction(
    () => (window as unknown as { __coopStart?: unknown }).__coopStart,
    null,
    {
      polling: 100,
      timeout: 10_000,
    },
  );
  await guest.bringToFront();
  expect(await ev.jsonValue()).toMatchObject({ role: 'guest', slot: 1, heroes: ['inker', 'letterer'] });
  // wave 2: Start launches the co-op run on both machines (the lobby closes)
  await expect(host.locator('html')).toHaveAttribute('data-coop', 'host', { timeout: 60_000 });
  await expect(guest.locator('html')).toHaveAttribute('data-coop', 'guest', { timeout: 60_000 });
  await expect(host.locator('html')).toHaveAttribute('data-coop-peers', '2');
}

test.describe('co-op lobby', () => {
  // two WebGL pages boot side by side (software GL in CI): give them room
  test.describe.configure({ timeout: 180_000 });
  test('offline: host + join by code over BroadcastChannel', async ({ context }, info) => {
    test.skip(info.project.name !== 'iphone14', 'one device profile is enough');
    const errors: string[] = [];
    const host = await context.newPage();
    const guest = await context.newPage();
    for (const p of [host, guest]) p.on('pageerror', (e) => errors.push(e.message));
    const q = 'nettransport=loopback-bc';
    const code = await hostRoom(host, q);
    await expect(host.locator('.coop-card')).toHaveAttribute('data-state', 'waiting');
    await joinRoom(guest, q, code, true);
    await expectConnected(host, guest, 30_000);
    await expect(host.locator('.coop-tier')).toHaveAttribute('data-tier', 'loopback');
    await expect(host.locator('.coop-rtt')).toBeVisible({ timeout: 5000 });
    await readyAndStart(host, guest);

    // guest's tab goes away → the host holds the seat and fades the partner out (then plays solo)
    await guest.close();
    await host.bringToFront();
    await host.waitForFunction(() => /fading|gone/.test((window as any).__net?.partner ?? ''), null, {
      timeout: 15_000,
    });
    expect(errors).toEqual([]);
  });

  test('offline: invite link joins directly', async ({ context }, info) => {
    test.skip(info.project.name !== 'iphone14', 'one device profile is enough');
    const host = await context.newPage();
    const guest = await context.newPage();
    const q = 'nettransport=loopback-bc';
    const code = await hostRoom(host, q);
    await joinRoom(guest, q, code, false);
    await expectConnected(host, guest, 30_000);
  });

  test('real network: Trystero over Nostr in two browser contexts', async ({ browser }, info) => {
    test.skip(!process.env.COOP_E2E_REAL, 'set COOP_E2E_REAL=1 (needs public Nostr relays + STUN)');
    test.skip(info.project.name !== 'iphone14', 'one device profile is enough');
    test.setTimeout(120_000);
    const contexts: BrowserContext[] = [await browser.newContext(), await browser.newContext()];
    try {
      const [host, guest] = await Promise.all(contexts.map((c) => c.newPage()));
      const code = await hostRoom(host!, 'lang=en');
      await joinRoom(guest!, 'lang=en', code, true);
      await expectConnected(host!, guest!, 60_000);
      await expect(host!.locator('.coop-tier')).toHaveAttribute('data-tier', /direct|turn|relay/);
      await readyAndStart(host!, guest!);
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });
});
