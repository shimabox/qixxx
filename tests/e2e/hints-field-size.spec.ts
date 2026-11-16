// The field keeps the size and place it had before the hints and HOW TO
// PLAY: on Title (with the HOW TO PLAY button) and in play (with the first
// hint on), in English and in Japanese. The expected boxes were measured on
// the commit before these features.
import { test, expect } from '@playwright/test';

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');

for (const c of [
  { viewport: { width: 1280, height: 800 }, hasTouch: false, field: { width: 1021, height: 766, left: 129.5, top: 34 } },
  { viewport: { width: 390, height: 844 }, hasTouch: true, field: { width: 390, height: 292, left: 0, top: 190 } },
  { viewport: { width: 844, height: 390 }, hasTouch: true, field: { width: 380, height: 285, left: 232, top: 82.5 } },
  { viewport: { width: 667, height: 375 }, hasTouch: true, field: { width: 203, height: 152, left: 232, top: 132.5 } },
]) {
  for (const locale of ['en-US', 'ja-JP']) {
    test(`the field at ${c.viewport.width}x${c.viewport.height} (${locale}) keeps its size on Title and in play`, async ({ browser }) => {
      const context = await browser.newContext({ locale, viewport: c.viewport, hasTouch: c.hasTouch });
      const page = await context.newPage();
      await page.clock.install({ time: CLOCK_START });
      await page.goto(APP_URL);
      await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
      await page.clock.runFor(100);
      const field = () =>
        page.evaluate(() => {
          const r = document.getElementById('game-canvas')!.getBoundingClientRect();
          return { width: r.width, height: r.height, left: r.left, top: r.top };
        });
      await expect(page.locator('#how-to-play-button')).toBeVisible();
      expect(await field()).toEqual(c.field);
      await page.keyboard.press('Enter');
      await page.clock.runFor(200);
      await expect(page.locator('#hint-bar')).toBeVisible();
      expect(await field()).toEqual(c.field);
      await context.close();
    });
  }
}
