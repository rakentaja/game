import { expect, test } from '@playwright/test';

/**
 * Boss-only run: ?page=boss&autoplay=1 must beat THE EDITOR (rewrites, summons, Blank Page
 * Reversed and all). Slow (~3–4 min of game time under swiftshader), so its title contains
 * "autoplay completes" and CI's default `--grep-invert "autoplay completes"` skips it.
 * Run locally: bunx playwright test tests/e2e/boss.spec.ts --project=iphone14
 */
test('autoplay completes the boss (slow)', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone14', 'one device is enough for the long run');
  test.setTimeout(9 * 60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?page=boss&autoplay=1');
  await page.waitForFunction(() => (window as any).__game?.ctx?.player, null, { timeout: 60_000 });
  await page.evaluate(() => {
    const w = window as any;
    // swiftshader renders a few fps: let the fixed-step sim catch up with real time
    w.__game.loop.maxSteps = 40;
    w.__boss = { log: [] as string[], defeated: false };
    const ev = w.__game.ctx.events;
    for (const e of ['boss:phase', 'boss:rewrite', 'boss:eraseStem', 'boss:defeated', 'player:died'])
      ev.on(e, (p: unknown) => {
        w.__boss.log.push(`${Math.round(w.__game.ctx.stats.timeS)} ${e} ${JSON.stringify(p)}`);
        if (e === 'boss:defeated') w.__boss.defeated = true;
      });
  });
  const deadline = Date.now() + 8 * 60_000;
  let defeated = false;
  while (Date.now() < deadline && !defeated) {
    await page.waitForTimeout(5000);
    const s = await page.evaluate(() => {
      const w = window as any;
      const f = w.__game.editor?.fsm;
      const p = w.__game.player;
      const act = f && f.p2Active >= 0 ? f.wps[f.p2Active] : null;
      return {
        defeated: w.__boss.defeated as boolean,
        t: Math.round(w.__game.ctx.stats.timeS),
        state: f ? `${f.state}:${f.phase}` : 'none',
        hp: f ? Math.round(f.health * 100) : -1,
        pos: p.position.toArray().map((v: number) => Math.round(v)),
        energy: Math.round(p.energy),
        wp: act ? `${act.index} d${act.drawIn.toFixed(1)} p${act.print.toFixed(2)} ${act.printed}` : '',
        cut: f?.rewrite.cut
          ? `${f.rewrite.verb} ${f.rewrite.t.toFixed(0)}s p${f.rewrite.print.toFixed(2)}`
          : '',
        log: (w.__boss.log as string[]).splice(0),
      };
    });
    console.log(JSON.stringify(s));
    defeated = s.defeated;
  }
  expect(defeated).toBe(true);
  expect(errors).toEqual([]);
});
