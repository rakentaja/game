import { expect, test } from '@playwright/test';

test('boots without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?skip=1');
  await expect(page.locator('html[data-ready="1"]')).toBeAttached({ timeout: 20_000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `test-results/smoke-${test.info().project.name}.png` });
  expect(errors.filter((e) => !/GPU stall|WebGL.*performance/i.test(e))).toEqual([]);
});
