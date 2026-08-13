// TIME countdown + TIME UP! E2E coverage (docs/plans/2026-08-13-time-limit-
// mode). Runs against Vite's dev server (see playwright.config.ts's
// webServer), local Chromium only, matching every other e2e file in this
// repo. Because this is the dev server (not a production build),
// import.meta.env.DEV is true here too, so `?debug`'s dynamic import
// actually mounts the debug panel (see src/main.ts's init()) — this suite
// drives the real debug-panel UI, not just GameSession's API directly.
import { test, expect } from '@playwright/test';

// Minimal shape of the window.__game__ debug hook main.ts publishes
// (docs/plan.md §7.2), extended with the getters this suite reads directly
// (mirroring smoke.spec.ts/gameover-share.spec.ts's own local declarations —
// kept independent so this file stays a black-box consumer of the built app).
declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getRemainingTicks: () => number;
        getGameOverReason: () => 'life' | 'time' | null;
      };
    };
  }
}

const APP_URL = 'http://localhost:4173/';

test('HUD TIME counts down during normal play', async ({ page }) => {
  await page.goto(APP_URL);
  await page.keyboard.press('Space'); // Title -> Playing

  await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');

  const getRemaining = () => page.evaluate(() => window.__game__!.session.getRemainingTicks());
  const initialRemaining = await getRemaining();

  // Real gameplay ticks are driven by wall-clock time (the fixed-timestep
  // accumulator in main.ts's gameLoop()), so simply waiting for
  // getRemainingTicks() to drop below its initial reading — rather than
  // sleeping a hand-picked duration — proves the run-wide countdown is
  // actually decreasing while playing.
  await expect.poll(getRemaining, { timeout: 10_000 }).toBeLessThan(initialRemaining);

  // The HUD's own TIME text (not just the underlying tick count) reflects
  // the countdown too — whichever line currently carries it (single-line or
  // stacked layout, see src/main.ts's updateHud()).
  const hud = page.locator('#hud');
  await expect(hud).toContainText('TIME');
});

test.describe('debug panel time-limit override -> TIME UP!', () => {
  test('shrinking the time limit via the debug panel forces a TIME UP! gameover', async ({ page }) => {
    await page.goto(`${APP_URL}?debug`);

    // The debug panel starts open by default (src/debug/panel.ts's
    // initDebugPanel()), so the time-limit slider is visible without any
    // extra badge click.
    const timeLimitInput = page.locator('#debug-time-limit-input');
    await expect(timeLimitInput).toBeVisible();

    // Drag it to its minimum (5s — RANGES.timeLimitSec in
    // src/debug/panel.ts) — the fastest a real-time-driven E2E can reach
    // TIME UP! without calling GameSession's API directly, exercising the
    // actual debug-panel <input type="range"> wiring end-to-end (its
    // 'input' listener -> GameSession.setDebugTimeLimitTicks()).
    await timeLimitInput.evaluate((el: HTMLInputElement) => {
      el.value = el.min;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#debug-panel')).toContainText('5s');

    await page.keyboard.press('Space'); // Title -> Playing
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');

    // Up to ~5s of real time for the shrunk budget to actually run out.
    await expect
      .poll(() => page.evaluate(() => window.__game__?.session.getStatus()), { timeout: 10_000 })
      .toBe('gameover');
    expect(await page.evaluate(() => window.__game__?.session.getGameOverReason())).toBe('time');

    // Player-visible confirmation: the GameOverModal shows a distinct
    // "TIME UP!" line (src/ui/gameOverModal.ts's `reason: 'time'` case),
    // alongside its ordinary GAME OVER heading and score info.
    const modal = page.locator('#gameover-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('GAME OVER');
    await expect(modal).toContainText('TIME UP!');
  });
});
