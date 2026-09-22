// GAME OVER modal + "POST TO X" share E2E (docs/plan-cloudflare-x-share.md
// Phase 1). Runs against the same Vite dev server as tests/e2e/smoke.spec.ts
// (see playwright.config.ts). Phase 2's real `/share` Cloudflare
// Function doesn't exist yet, so the POST is stubbed via route interception
// — this test only exercises Phase 1's DOM layer (modal, button wiring,
// intent-URL construction), not the real share backend.
import { test, expect, type Page } from '@playwright/test';

// Minimal shape of the window.__game__ debug hook main.ts publishes
// (docs/plan.md §7.2), extended with the session getters/debug-override
// method this suite drives directly (mirroring smoke.spec.ts's own local
// declaration — kept independent so this file stays a black-box consumer).
declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getLives: () => number;
        getStage: () => number;
        getScore: () => number;
        getHighScore: () => number;
        getGame: () => { getMarker: () => { getPosition: () => { x: number; y: number } } };
        applyDebugOverrides: (overrides: { wispCount?: number }) => void;
      };
    };
  }
}

// `?debug` (main.ts: `import.meta.env.DEV && ...has('debug')`) is what makes
// window.__game__.session.applyDebugOverrides actually take effect — dev
// only, never shipped, exactly like the debug panel's own gating.
const APP_URL = 'http://localhost:4173/?debug';

// Advances the page's (faked) clock in `stepMs` slices until `predicate`
// holds, giving up after `maxMs` of *game* time. Under `page.clock.install()`
// requestAnimationFrame only fires while the clock is advanced, so the game
// loop (main.ts's fixed-timestep accumulator) runs exactly as many ticks as
// the advanced time dictates — independent of how fast the machine running
// the test happens to be. Budgets below are therefore game-time budgets,
// not wall-clock timeouts.
async function advanceUntil(
  page: Page,
  predicate: () => Promise<boolean>,
  maxMs: number,
  stepMs = 50,
): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs; elapsed += stepMs) {
    if (await predicate()) return;
    await page.clock.runFor(stepMs);
  }
  if (await predicate()) return;
  throw new Error(`condition not met within ${maxMs}ms of game time`);
}

test('GAME OVER modal shows score/stage, shares to X, and returns to Title', async ({ page, context }) => {
  // Stand in for Phase 2's not-yet-implemented `/share` Function.
  await page.route('**/share', async (route) => {
    expect(route.request().method()).toBe('POST');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'e2e-test-id' }),
    });
  });

  // Fake the page clock (timers, Date, performance.now and — what matters
  // here — requestAnimationFrame) and then *pause* it: install() alone keeps
  // the fake clock ticking with real time, so rAF frames would still slip
  // in between our explicit advances. Once paused, the game only advances
  // through page.clock.runFor(), and every wait below is a fixed amount of
  // game time rather than a wall-clock timeout that a slow CI runner can
  // miss. The clock keeps running during page load (the title screen just
  // animates in real time until then) and is frozen before the first input.
  const CLOCK_START = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: CLOCK_START });
  await page.goto(APP_URL);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.keyboard.press('Space'); // Title -> Playing
  await page.clock.runFor(100);

  const getStatus = () => page.evaluate(() => window.__game__?.session.getStatus());
  const getLives = () => page.evaluate(() => window.__game__!.session.getLives());
  const getMarkerY = () => page.evaluate(() => window.__game__!.session.getGame().getMarker().getPosition().y);

  expect(await getStatus()).toBe('playing');

  // Reproducing GAME OVER via Wisp/Ember contact would depend on RNG timing
  // (Wisps use Math.random() in the real app, no seeded rng). Worse, trying
  // the "many fast Wisps" shortcut and completing a line back to the border
  // was found to reliably trigger an *instant split-clear* instead (any 2+
  // Wisps ending up on opposite sides of the closed line — see
  // core/claim.ts's claimArea split detection — which stage 10 Wisps spread
  // across the field's center make near-certain). Dropping to 0 Wisps here
  // sidesteps both problems and relies purely on the Igniter (core/fuse.ts)
  // instead: fully deterministic, no RNG — it spawns 1s after the player
  // stops moving mid-line and then reliably catches up, triggering a miss.
  await page.evaluate(() => window.__game__!.session.applyDebugOverrides({ wispCount: 0 }));

  const initialLives = await getLives();
  for (let attempt = 0; attempt < initialLives; attempt++) {
    const livesBefore = await getLives();
    if (livesBefore <= 0) break;

    // Draw a short line a few cells off the top border, then stop — leaving
    // the marker stationary mid-line, which is exactly what lets the
    // Igniter spawn (core/fuse.ts's shouldSpawnIgniter()).
    await page.keyboard.down('Space');
    await page.keyboard.down('ArrowDown');
    // On iterations after the first, this also has to wait out the previous
    // miss's ~2s grace period before the marker can start moving at all (see
    // the comment on the advanceUntil below) — 6s of game time covers grace
    // plus the short move with room to spare.
    await advanceUntil(page, async () => (await getMarkerY()) >= 5, 6_000);
    await page.keyboard.up('ArrowDown');
    await page.keyboard.up('Space');

    // ~1s (IGNITER_SPAWN_STILL_TICKS) for it to spawn, plus a handful of
    // IGNITER_ADVANCE_TICKS steps to climb the short line and catch up. On
    // every iteration after the first, this loop's key-down at the top also
    // has to first wait out the ~2s post-miss grace period (MISS_GRACE_TICKS)
    // from the previous iteration's miss: entering an UNCLAIMED cell (i.e.
    // starting the new line the ArrowDown above is trying to draw) is now
    // blocked for that whole window (docs/plan.md §3.5 grace-period exploit
    // fix, "案B") — only BORDER movement stays free during grace — so the
    // marker sits at the border until grace elapses before it can even begin
    // moving down. 6s of game time comfortably covers spawn + catch-up.
    await advanceUntil(page, async () => (await getLives()) < livesBefore, 6_000);
  }

  await page.clock.runFor(100);
  expect(await getStatus()).toBe('gameover');

  const [stage, score, hi] = await page.evaluate(() => {
    const s = window.__game__!.session;
    return [s.getStage(), s.getScore(), s.getHighScore()];
  });

  const modal = page.locator('#gameover-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('GAME OVER');
  await expect(modal).toContainText(`SCORE: ${score}`);
  await expect(modal).toContainText(`STAGE: ${stage}`);
  await expect(modal).toContainText(`HI SCORE: ${hi}`);

  // Stub the intent URL's navigation too (context-wide, so it also applies
  // to the not-yet-opened popup page below): twitter.com itself redirects
  // real requests through to x.com's login flow, which would make this test
  // depend on live network access and an external site's behavior instead
  // of just our own intent-URL construction.
  await context.route('https://twitter.com/intent/tweet**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' });
  });

  // "POST TO X": clicking opens a new tab, whose location is repointed to
  // the X intent URL once the (stubbed) share POST resolves.
  const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('#gameover-share-button').click()]);
  await popup.waitForURL(/^https:\/\/twitter\.com\/intent\/tweet/);

  const popupUrl = new URL(popup.url());
  expect(popupUrl.hostname).toBe('twitter.com');
  expect(popupUrl.pathname).toBe('/intent/tweet');
  expect(popupUrl.searchParams.get('text')).toBe(
    `QIXXX で STAGE ${stage} / SCORE ${score.toLocaleString('en-US')} を記録！ #QIXXX`
  );
  expect(popupUrl.searchParams.get('url')).toBe(`http://localhost:4173/s?id=e2e-test-id`);
  await popup.close();

  // "BACK TO TITLE": returns to Title (same confirm path as any key/tap) and hides the modal.
  await page.locator('#gameover-back-button').click();
  await page.clock.runFor(100);
  expect(await getStatus()).toBe('title');
  await expect(modal).toBeHidden();
});
