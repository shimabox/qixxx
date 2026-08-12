// Regression coverage for a P2 user-review finding (2026-08-11,
// docs/plans/2026-08-11-daily-seed-time-attack): the HUD's 3rd line, added
// to hold TIME on narrow (390px) viewports without crowding out the
// existing STAGE/SCORE/HI or OCCUPANCY/LIVES lines (both were already at/
// near their character budget at that width before TIME was added). This
// checks the Title screen specifically, before any key/tap — the state a
// since-removed DAILY-mode Title UI once crowded #hud down to an unreadable
// ~9px in (see git history for that feature and its removal).
//
// Also covers two follow-up user-review findings (2026-08-12) against the
// same HUD:
// - P2: a 601-727px viewport band where the single-line layout no longer
//   actually fit once TIME was added, silently ellipsis-clipping OCCUPANCY/
//   LIVES — fixed by raising config.ts's HUD_TWO_LINE_MAX_VIEWPORT_WIDTH_PX
//   from 600 to 960 so that band renders in the same stacked-lines layout as
//   390px instead.
// - P3: an extreme `?seed=` value (e.g. Number.MAX_SAFE_INTEGER) whose
//   `SEED <n>` HUD prefix overflowed the narrow 3rd line at 390px — fixed by
//   src/seedParam.ts rounding the parsed seed to an unsigned 32-bit integer
//   (see that module's doc comment).
//
// Runs against Vite's dev server (see playwright.config.ts's webServer),
// local Chromium only, matching smoke.spec.ts's own setup.
import { test, expect, devices } from '@playwright/test';

const APP_URL = 'http://localhost:4173/';

/** True when `locator`'s content isn't being ellipsis-clipped by its box. */
const isUnclipped = async (locator: import('@playwright/test').Locator) =>
  locator.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);

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

    expect(await isUnclipped(line1)).toBe(true);
    expect(await isUnclipped(line2)).toBe(true);
    expect(await isUnclipped(line3)).toBe(true);

    // #hud itself (not just its lines) must actually have real width to
    // work with.
    const hudWidth = await page.locator('#hud').evaluate((el) => el.clientWidth);
    expect(hudWidth).toBeGreaterThan(100);
  });

  test('an extreme ?seed= value is rounded so the SEED prefix does not clip TIME on line 3', async ({ page }) => {
    // Number.MAX_SAFE_INTEGER — previously passed straight through to the
    // HUD's `SEED <n>` prefix; src/seedParam.ts now rounds it to an
    // unsigned 32-bit integer (see that module's doc comment for why).
    await page.goto(`${APP_URL}?seed=9007199254740991`);

    const line3 = page.locator('#hud-line3');
    await expect(line3).toBeVisible();
    await expect(line3).toContainText('SEED 4294967295');
    await expect(line3).toContainText('TIME');
    expect(await isUnclipped(line3)).toBe(true);
  });
});

test.describe('mid-width normal-mode HUD (601-960px band)', () => {
  // P2 fix regression coverage (user review, 2026-08-12): this band used to
  // render as a single nowrap+ellipsis line that no longer actually fit once
  // TIME was added (config.ts's HUD_TWO_LINE_MAX_VIEWPORT_WIDTH_PX was still
  // 600, pre-TIME). It now renders in the same stacked-lines layout as
  // 390px, at every width up to and including the new 960px cutoff.
  for (const width of [640, 728, 960]) {
    test(`HUD stats stay readable, not clipped at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(APP_URL);

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

      expect(await isUnclipped(line1)).toBe(true);
      expect(await isUnclipped(line2)).toBe(true);
      expect(await isUnclipped(line3)).toBe(true);
    });
  }

  test('HUD renders as a single unclipped line just past the cutoff (961px)', async ({ page }) => {
    await page.setViewportSize({ width: 961, height: 900 });
    await page.goto(APP_URL);

    const line1 = page.locator('#hud-line1');
    const line2 = page.locator('#hud-line2');
    await expect(line1).toBeVisible();
    await expect(line2).toBeHidden();
    await expect(line1).toContainText('STAGE');
    await expect(line1).toContainText('SCORE');
    await expect(line1).toContainText('HI');
    await expect(line1).toContainText('TIME');
    await expect(line1).toContainText('OCCUPANCY');
    await expect(line1).toContainText('LIVES');

    expect(await isUnclipped(line1)).toBe(true);
  });
});
