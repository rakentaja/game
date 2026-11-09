import { expect, test } from '@playwright/test';

/**
 * Hero select: title → Read → four hero cards → pick the Letterer → the run starts with the
 * Letterer kit (lazy chunk), the perk card offers page 1's two perks, the Splash meter shows,
 * and the pick is remembered for the next visit.
 */
test('hero select picks and remembers a hero', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone14', 'one device profile is enough');
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('html[data-ready="1"]')).toBeAttached({ timeout: 60_000 });
  await expect(page.locator('.loading-tap')).toBeVisible({ timeout: 30_000 });
  await page.locator('.scr-loading').dispatchEvent('pointerup');
  await expect(page.locator('.scr-title')).toBeVisible({ timeout: 15_000 });
  await page.locator('.scr-title .cx-btn.primary').click();
  await expect(page.locator('.scr-heroes')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.hero-card')).toHaveCount(4);
  await page.locator('[data-act="pick"][data-id="letterer"]').click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __game?: { player?: { kit?: { id: string } } } }).__game?.player?.kit?.id ===
      'letterer',
    null,
    { timeout: 30_000 },
  );
  await expect(page.locator('.hero-perk [data-perk]')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator('.hero-splash')).toBeVisible();
  await page.locator('.hero-perk [data-perk="italics"]').click();
  await expect(page.locator('.hero-perk')).toHaveCount(0);
  const perks = await page.evaluate(() => [
    ...(window as unknown as { __game: { player: { kit: { perks: Set<string> } } } }).__game.player.kit.perks,
  ]);
  expect(perks).toEqual(['italics']);
  expect(await page.evaluate(() => localStorage.getItem('inkwake:hero'))).toContain('letterer');
  expect(errors).toEqual([]);
});
