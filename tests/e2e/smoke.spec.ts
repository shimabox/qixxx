// E2E smoke suite (docs/plan.md §7.2): kept to the 4 documented scenarios.
// "ゲームプレイの自動E2Eは費用対効果が低い" — this is a smoke check, not a
// gameplay regression suite. Runs against Vite's dev server (see
// playwright.config.ts's webServer), local Chromium only.
//
// Scenario 3 drives the marker via real held keys (not by poking game
// state directly) but *waits* on the marker's actual position/occupancy via
// window.__game__ (docs/plan.md §7.2's suggested debug hook) rather than
// sleeping a hand-computed number of milliseconds — the fixed-timestep game
// loop is driven by real wall-clock time, so a duration-based wait would be
// exactly the kind of flaky timing assumption this approach avoids.
import { test, expect, devices } from '@playwright/test';

// Minimal shape of the window.__game__ debug hook main.ts publishes
// (docs/plan.md §7.2). Declared locally rather than imported from src/ so
// this test suite stays a black-box consumer of the built app, not a
// compile-time dependency of it.
declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getGame: () => {
          getMarker: () => { getPosition: () => { x: number; y: number } };
          getOccupancy: () => number;
        };
      };
    };
  }
}

const APP_URL = 'http://localhost:4173/qixxx/';

test('loads and renders the field on a canvas', async ({ page }) => {
  await page.goto(APP_URL);

  const canvas = page.locator('#game-canvas');
  await expect(canvas).toBeVisible();

  // Internal resolution is CANVAS_WIDTH/HEIGHT * devicePixelRatio (§5.3) —
  // just confirm it's actually been sized (not a 0x0 canvas) rather than
  // pinning an exact pixel count that would break on a different DPR.
  const box = await canvas.evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);

  await page.screenshot({ path: 'test-results/smoke-initial-render.png' });
});

test('advances from the Title screen to Playing on a key press', async ({ page }) => {
  await page.goto(APP_URL);

  await expect(page.locator('#screen')).toContainText('QIXXX');
  await expect
    .poll(() => page.evaluate(() => window.__game__?.session.getStatus()))
    .toBe('title');

  await page.keyboard.press('Space');

  await expect
    .poll(() => page.evaluate(() => window.__game__?.session.getStatus()))
    .toBe('playing');
  await expect(page.locator('#screen')).toHaveText('');
});

test('claims an area via a scripted movement sequence, increasing occupancy from 0%', async ({ page }) => {
  await page.goto(APP_URL);
  await page.keyboard.press('Space'); // Title -> Playing

  await expect
    .poll(() => page.evaluate(() => window.__game__?.session.getStatus()))
    .toBe('playing');

  const getMarker = () => page.evaluate(() => window.__game__!.session.getGame().getMarker().getPosition());
  const getOccupancy = () => page.evaluate(() => window.__game__!.session.getGame().getOccupancy());

  expect(await getOccupancy()).toBe(0);

  // Walk left along the (freely-walkable) top border, well away from the
  // Wisp's field-center spawn point, before drawing anything.
  await page.keyboard.down('ArrowLeft');
  await expect.poll(async () => (await getMarker()).x).toBeLessThanOrEqual(30);
  await page.keyboard.up('ArrowLeft');

  // Draw a small square back up to the border (Space = fast line, §5.1):
  // down, then right, then up to close the loop against the top border.
  await page.keyboard.down('Space');
  await page.keyboard.down('ArrowDown');
  await expect.poll(async () => (await getMarker()).y).toBeGreaterThanOrEqual(25);
  await page.keyboard.up('ArrowDown');

  await page.keyboard.down('ArrowRight');
  await expect.poll(async () => (await getMarker()).x).toBeGreaterThanOrEqual(55);
  await page.keyboard.up('ArrowRight');

  await page.keyboard.down('ArrowUp');
  await expect.poll(() => getOccupancy(), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('Space');
});

test.describe('mobile viewport', () => {
  // `defaultBrowserType` (part of the devices['Pixel 5'] preset) can only be
  // set at the top level/project config, not inside a describe block — the
  // rest of the preset (viewport/userAgent/hasTouch/isMobile) is all we
  // actually need to emulate a touch-capable phone here.
  const { defaultBrowserType: _defaultBrowserType, ...pixel5 } = devices['Pixel 5'];
  test.use({ ...pixel5 });

  test('shows the virtual touch pad', async ({ page }) => {
    await page.goto(APP_URL);

    const pad = page.locator('#touch-controls');
    await expect(pad).toBeVisible();
    // All 4 d-pad directions + FAST/SLOW should be present as tappable buttons.
    await expect(pad.locator('button')).toHaveCount(6);
  });
});

test.describe('narrow mobile viewport HUD (two-line mode)', () => {
  // Below HUD_TWO_LINE_MAX_VIEWPORT_WIDTH_PX (config.ts, ~600), main.ts's
  // updateHudMode() switches the HUD from one nowrap+ellipsis line to two
  // explicit stacked lines so OCCUPANCY/LIVES/the multiplier stay visible
  // instead of being clipped by the ellipsis (the bug this test guards
  // against). 390x844 mirrors a typical modern phone in portrait.
  test.use({ viewport: { width: 390, height: 844 } });

  test('OCCUPANCY and LIVES are visible, not ellipsis-clipped', async ({ page }) => {
    await page.goto(APP_URL);
    await page.keyboard.press('Space'); // Title -> Playing

    await expect
      .poll(() => page.evaluate(() => window.__game__?.session.getStatus()))
      .toBe('playing');

    const hud = page.locator('#hud');
    await expect(hud).toContainText('OCCUPANCY');
    await expect(hud).toContainText('LIVES');

    // The regression this guards against: in one-line mode, #hud's
    // nowrap+ellipsis text-overflow silently truncated LIVES/OCCUPANCY off
    // the end at this width without failing a plain toContainText() check
    // (Playwright reads full textContent regardless of CSS ellipsis
    // clipping) — so also assert the second line is on its own, unclipped
    // (scrollWidth <= clientWidth means nothing is cut off by overflow).
    const line2 = page.locator('#hud-line2');
    await expect(line2).toBeVisible();
    await expect(line2).toContainText('OCCUPANCY');
    await expect(line2).toContainText('LIVES');
    const isUnclipped = await line2.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(isUnclipped).toBe(true);
  });
});
