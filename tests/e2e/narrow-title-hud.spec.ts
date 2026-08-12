// Regression coverage for a P2 user-review finding (2026-08-11,
// docs/plans/2026-08-11-daily-seed-time-attack): the HUD's 3rd line, added
// to hold TIME on narrow (390px) viewports without crowding out the
// existing STAGE/SCORE/HI or OCCUPANCY/LIVES lines (both were already at/
// near their character budget at that width before TIME was added). This
// checks the Title screen specifically, before any key/tap — the state a
// since-removed DAILY-mode Title UI once crowded #hud down to an unreadable
// ~9px in (see git history for that feature and its removal).
//
// Runs against Vite's dev server (see playwright.config.ts's webServer),
// local Chromium only, matching smoke.spec.ts's own setup.
import { test, expect, devices } from '@playwright/test';

const APP_URL = 'http://localhost:4173/';

test.describe('narrow mobile Title screen (390px)', () => {
  const { defaultBrowserType: _defaultBrowserType, ...pixel5 } = devices['Pixel 5'];
  test.use({ ...pixel5, viewport: { width: 390, height: 844 } });

  test('HUD stats (3-line mode, including TIME) stay readable, not clipped', async ({ page }) => {
    await page.goto(APP_URL);

    // The stats HUD (narrow/3-line mode below HUD_TWO_LINE_MAX_VIEWPORT_WIDTH_PX,
    // see main.ts's hudLine3) must show every field, across its 3 lines,
    // unclipped.
    const line1 = page.locator('#hud-line1');
    const line2 = page.locator('#hud-line2');
    const line3 = page.locator('#hud-line3');
    await expect(line1).toBeVisible();
    await expect(line2).toBeVisible();
    await expect(line3).toBeVisible();
    await expect(line1).toContainText('STAGE');
    await expect(line1).toContainText('SCORE');
    await expect(line1).toContainText('HI');
    await expect(line2).toContainText('OCCUPANCY');
    await expect(line2).toContainText('LIVES');
    await expect(line3).toContainText('TIME');

    const isUnclipped = async (locator: typeof line1) =>
      locator.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(await isUnclipped(line1)).toBe(true);
    expect(await isUnclipped(line2)).toBe(true);
    expect(await isUnclipped(line3)).toBe(true);

    // #hud itself (not just its lines) must actually have real width to
    // work with.
    const hudWidth = await page.locator('#hud').evaluate((el) => el.clientWidth);
    expect(hudWidth).toBeGreaterThan(100);
  });
});
