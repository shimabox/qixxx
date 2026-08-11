// Regression coverage for a P2 user-review finding (2026-08-11,
// docs/plans/2026-08-11-daily-seed-time-attack): on a narrow (390px) Title
// screen, the DAILY button + best-score label used to live inside #hud-row
// itself, crowding the STAGE/SCORE/HI/TIME/OCCUPANCY/LIVES text (#hud) down
// to an unreadable ~9px width. The existing mobile-viewport 2-line-mode test
// in smoke.spec.ts only checks *after* pressing a key (Playing status, DAILY
// UI hidden), so it never caught this — this file specifically checks the
// Title screen itself, before any key/tap.
//
// Runs against Vite's dev server (see playwright.config.ts's webServer),
// local Chromium only, matching smoke.spec.ts's own setup.
import { test, expect, devices } from '@playwright/test';

// Minimal shape of the window.__game__ debug hook main.ts publishes
// (docs/plan.md §7.2) — mirrors smoke.spec.ts's own local declaration (kept
// local rather than imported from src/ so this suite stays a black-box
// consumer of the built app, not a compile-time dependency of it).
declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
      };
    };
  }
}

const APP_URL = 'http://localhost:4173/';

test.describe('narrow mobile Title screen (390px)', () => {
  const { defaultBrowserType: _defaultBrowserType, ...pixel5 } = devices['Pixel 5'];
  test.use({ ...pixel5, viewport: { width: 390, height: 844 } });

  test('HUD stats stay readable (not squeezed to near-zero width) while the DAILY UI is visible', async ({
    page,
  }) => {
    await page.goto(APP_URL);

    // Still on Title — the DAILY button/label are visible right from page
    // load, before any key/tap (the exact state the crowding bug occurred
    // in).
    const dailyButton = page.locator('#daily-button');
    const dailyBestLabel = page.locator('#daily-best-label');
    await expect(dailyButton).toBeVisible();
    await expect(dailyBestLabel).toBeVisible();
    await expect(dailyBestLabel).toContainText('DAILY');
    await expect(dailyBestLabel).toContainText('BEST');

    // The stats HUD (narrow/3-line mode below HUD_TWO_LINE_MAX_VIEWPORT_WIDTH_PX,
    // see main.ts's hudLine3) must still show every field, across its 3
    // lines, unclipped — the DAILY button/label living in their own
    // #title-ui-row (not #hud-row) means #hud's own layout is completely
    // unaffected by them.
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
    // work with — the original bug squeezed it down to ~9px even though
    // its children were still nominally "visible".
    const hudWidth = await page.locator('#hud').evaluate((el) => el.clientWidth);
    expect(hudWidth).toBeGreaterThan(100);
  });

  test('the DAILY button is still clickable and starts a DAILY run', async ({ page }) => {
    await page.goto(APP_URL);

    await page.locator('#daily-button').click();

    await expect
      .poll(() => page.evaluate(() => window.__game__?.session.getStatus()))
      .toBe('playing');

    // DAILY UI hides again once play starts (Title-only) — same
    // visibility-toggle path exercised by the crowding-fix change.
    await expect(page.locator('#daily-button')).toBeHidden();
  });
});
