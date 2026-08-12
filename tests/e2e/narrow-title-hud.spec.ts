// Regression coverage for a P2 user-review finding (2026-08-11,
// docs/plans/2026-08-11-daily-seed-time-attack): the HUD's 3rd line, added
// to hold TIME on narrow (390px) viewports without crowding out the
// existing STAGE/SCORE/HI or OCCUPANCY/LIVES lines (both were already at/
// near their character budget at that width before TIME was added). This
// checks the Title screen specifically, before any key/tap — the state a
// since-removed DAILY-mode Title UI once crowded #hud down to an unreadable
// ~9px in (see git history for that feature and its removal).
//
// Also covers four follow-up user-review findings (2026-08-12/13) against
// the same HUD:
// - P2 (601-960px band): the single-line layout no longer actually fit once
//   TIME was added, silently ellipsis-clipping OCCUPANCY/LIVES at a fixed
//   window.innerWidth cutoff that didn't reflect the resulting text width.
// - P3 (390px + huge seed): an extreme `?seed=` value (e.g.
//   Number.MAX_SAFE_INTEGER) whose `SEED <n>` HUD prefix overflowed the
//   narrow 3rd line — fixed by src/seedParam.ts rounding the parsed seed to
//   an unsigned 32-bit integer (see that module's doc comment).
// - P2 (short-viewport regression on the *first* 601-960px fix): that fix's
//   cutoff was keyed off window.innerWidth alone, so a wide-but-short
//   viewport (canvas/HUD width shrunk by *height*, via
//   fitCanvasToViewport()'s letterboxing) could still land in single-line
//   mode without actually having enough on-screen width for it. Fixed by
//   making the mode decision geometry-based (main.ts's wouldSingleLineFit())
//   instead of a fixed cutoff — see that function's doc comment for the
//   algorithm and how it avoids width<->height oscillation.
// - P2 (stale non-#hud width after the mode decision): wouldSingleLineFit()
//   only ever measured hudRow's non-#hud siblings (credit link, mute
//   button) once, at decision time — so a change to any of them afterward
//   (the mute button's label growing MUTE -> UNMUTE, or the dev-only DEBUG
//   badge mounting asynchronously after `?debug`'s dynamic import resolves)
//   could invalidate an already-committed single-line decision without ever
//   re-checking it. Fixed by reserving the mute button's widest possible
//   label width up front (so toggling never changes its rendered size, see
//   getMuteButtonElement()) and re-running fitCanvasToViewport() once right
//   after the DEBUG badge mounts (see init()).
//
// Runs against Vite's dev server (see playwright.config.ts's webServer),
// local Chromium only, matching smoke.spec.ts's own setup. Because this is
// the dev server (not a production build), import.meta.env.DEV is true here
// too, so `?debug`'s dynamic import actually mounts the DEBUG badge — this
// suite is able to cover that case directly rather than needing a
// unit-test/manual-check substitute.
import { test, expect, devices } from '@playwright/test';

const APP_URL = 'http://localhost:4173/';

/** True when `locator`'s content isn't being ellipsis-clipped by its box. */
const isUnclipped = async (locator: import('@playwright/test').Locator) =>
  locator.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);

/** Asserts every HUD field is present and unclipped, regardless of whether the HUD is currently single-line or stacked. */
async function expectFullyReadableHud(page: import('@playwright/test').Page): Promise<void> {
  const line1 = page.locator('#hud-line1');
  const line2 = page.locator('#hud-line2');
  const line3 = page.locator('#hud-line3');
  const stacked = await line2.evaluate((el) => (el as HTMLElement).style.display === 'block');

  await expect(line1).toBeVisible();
  expect(await isUnclipped(line1)).toBe(true);
  await expect(line1).toContainText('STAGE');
  await expect(line1).toContainText('SCORE');
  await expect(line1).toContainText('HI');

  if (stacked) {
    await expect(line2).toBeVisible();
    await expect(line3).toBeVisible();
    expect(await isUnclipped(line2)).toBe(true);
    expect(await isUnclipped(line3)).toBe(true);
    await expect(line2).toContainText('OCCUPANCY');
    await expect(line2).toContainText('LIVES');
    await expect(line3).toContainText('TIME');
  } else {
    await expect(line2).toBeHidden();
    await expect(line3).toBeHidden();
    await expect(line1).toContainText('TIME');
    await expect(line1).toContainText('OCCUPANCY');
    await expect(line1).toContainText('LIVES');
  }
}

/**
 * Overwrites the HUD's currently-visible line(s) with config.ts's
 * HUD_WORST_CASE_STATS_TEXT budget (kept in sync by hand — e2e specs can't
 * import from src/ here, matching every other test in this file), split
 * across lines exactly like updateHud() does in stacked mode. Real gameplay
 * can't practically be scripted to Stage 999 / a 6-digit score, so this
 * simulates "an in-progress game has grown the HUD text to its budgeted
 * worst case" the same way updateHud() itself writes the DOM (a plain
 * textContent assignment) — without touching layout/mode.
 */
async function setWorstCaseHudText(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const l1 = document.getElementById('hud-line1') as HTMLElement;
    const l2 = document.getElementById('hud-line2') as HTMLElement;
    const l3 = document.getElementById('hud-line3') as HTMLElement;
    if (l2.style.display === 'block') {
      l1.textContent = 'STAGE 999  SCORE: 999999  HI: 999999';
      l2.textContent = 'OCCUPANCY: 100%  LIVES: 9  x9';
      l3.textContent = 'TIME 99:59.9';
    } else {
      l1.textContent = 'STAGE 999  SCORE: 999999  HI: 999999  TIME 99:59.9  OCCUPANCY: 100%  LIVES: 9  x9';
    }
  });
}

test.describe('narrow mobile Title screen (390px)', () => {
  const { defaultBrowserType: _defaultBrowserType, ...pixel5 } = devices['Pixel 5'];
  test.use({ ...pixel5, viewport: { width: 390, height: 844 } });

  test('HUD stats (3-line mode, including TIME) stay readable, not clipped', async ({ page }) => {
    await page.goto(APP_URL);
    await expectFullyReadableHud(page);

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

test.describe('mid-width normal-mode HUD, ample height (601-960px band)', () => {
  // P2 fix regression coverage (user review, 2026-08-12): this band used to
  // render as a single nowrap+ellipsis line that no longer actually fit once
  // TIME was added. It now renders in the same stacked-lines layout as
  // 390px whenever the available width genuinely isn't enough for one line
  // (see wouldSingleLineFit() in main.ts) — true for both widths below at a
  // generous (900px) height.
  for (const width of [640, 728]) {
    test(`HUD stats stay readable, not clipped at ${width}x900`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(APP_URL);
      await expectFullyReadableHud(page);
      await expect(page.locator('#hud-line2')).toBeVisible(); // expected stacked at this width/height
    });
  }
});

test.describe('desktop baseline (1280x720)', () => {
  // Existing pre-TIME/pre-P2-fix behavior (user review, 2026-08-12): a
  // reasonably tall widescreen desktop viewport must stay single-line,
  // unclipped — the geometry-based wouldSingleLineFit() decision
  // (main.ts) must not regress this common case while fixing the
  // short-viewport band below.
  test('HUD renders as a single unclipped line, matching the pre-fix baseline layout', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(APP_URL);

    const line1 = page.locator('#hud-line1');
    const line2 = page.locator('#hud-line2');
    await expect(line1).toBeVisible();
    await expect(line2).toBeHidden();
    await expectFullyReadableHud(page);

    // Layout sanity, not just text-clipping: the HUD row sits directly above
    // the canvas with the fixed HUD_GAP_PX (6px) gap (docs/plan.md §12.1),
    // and the canvas keeps its 4:3 (CANVAS_WIDTH x CANVAS_HEIGHT) aspect
    // ratio letterboxed into whatever height fitCanvasToViewport() computed.
    const canvas = page.locator('#game-canvas');
    const hudRow = page.locator('#hud-row');
    const hudBox = await hudRow.boundingBox();
    const canvasBox = await canvas.boundingBox();
    expect(hudBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    if (hudBox && canvasBox) {
      expect(Math.round(canvasBox.y - (hudBox.y + hudBox.height))).toBe(6);
      // 4:3 aspect ratio, allowing for sub-pixel floor() rounding.
      expect(Math.abs(canvasBox.width / canvasBox.height - 4 / 3)).toBeLessThan(0.01);
    }
  });
});

test.describe('short-viewport normal/seeded HUD (P2 fix, 2026-08-12 follow-up)', () => {
  // The first 601-960px-band fix above keyed the single/stacked decision off
  // window.innerWidth alone, which doesn't account for fitCanvasToViewport()
  // shrinking the canvas — and with it hudRow, which is kept in sync with
  // the canvas's own on-screen width — via *height* instead of width. Each
  // case here reproduces a real user-reported clip: a wide-but-short normal
  // viewport, and a `?seed=` run (both `?seed=1`, whose existing e2e
  // coverage in smoke.spec.ts must keep behaving exactly as before, and the
  // rounded max seed from the P3 fix above) at a moderate height where the
  // single-line layout no longer actually fits.
  test('1024x576 normal mode: HUD stays readable, not clipped', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 576 });
    await page.goto(APP_URL);
    await expectFullyReadableHud(page);
  });

  test('961x400 normal mode: HUD stays readable, not clipped', async ({ page }) => {
    await page.setViewportSize({ width: 961, height: 400 });
    await page.goto(APP_URL);
    await expectFullyReadableHud(page);
  });

  test('1024x600 ?seed=1: HUD stays readable, not clipped (SEED prefix included)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.goto(`${APP_URL}?seed=1`);
    await expectFullyReadableHud(page);
    const stackedLine = (await page.locator('#hud-line2').isVisible()) ? page.locator('#hud-line3') : page.locator('#hud-line1');
    await expect(stackedLine).toContainText('SEED 1');
  });

  test('1024x600 max seed (4294967295): HUD stays readable, not clipped (SEED prefix included)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.goto(`${APP_URL}?seed=9007199254740991`); // rounds to 4294967295 (src/seedParam.ts)
    await expectFullyReadableHud(page);
    const stackedLine = (await page.locator('#hud-line2').isVisible()) ? page.locator('#hud-line3') : page.locator('#hud-line1');
    await expect(stackedLine).toContainText('SEED 4294967295');
  });
});

test.describe('non-#hud row width changing after the mode decision (P2 fix, 2026-08-13 follow-up)', () => {
  test('toggling MUTE/UNMUTE repeatedly never clips a near-worst-case single-line HUD', async ({ page }) => {
    // A borderline single-line viewport (empirically found: the
    // single/stacked transition sits at 871-872px wide at this height with
    // this fix applied — comfortable margin above that, not a razor's-edge
    // pixel, for CI stability) reproducing the reviewer's report that a
    // moderate desktop-class viewport, not just a narrow phone, clips once
    // MUTE grows the HUD's non-text neighbor.
    await page.setViewportSize({ width: 880, height: 700 });
    // Start unmuted ("音声ON" in the report) — loadMuted() (src/storage/
    // settings.ts) defaults to muted unless localStorage explicitly says
    // 'false', and the bug only showed up going *from* the shorter "MUTE"
    // label *to* the longer "UNMUTE" one (the direction that grows the
    // button and steals width from the HUD text).
    await page.addInitScript(() => localStorage.setItem('qixxx.muted', 'false'));
    await page.goto(APP_URL);

    const line1 = page.locator('#hud-line1');
    await expect(line1).toBeVisible();
    await expect(page.locator('#hud-line2')).toBeHidden(); // confirms this viewport is genuinely single-line

    await setWorstCaseHudText(page);
    expect(await isUnclipped(line1)).toBe(true);

    const muteButton = page.locator('#mute-button');
    for (let i = 0; i < 4; i++) {
      await muteButton.click();
      expect(await isUnclipped(line1)).toBe(true);
    }
  });

  test('the DEBUG badge (?debug) does not clip the HUD once mounted', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${APP_URL}?debug`);

    const badge = page.locator('#debug-badge');
    await expect(badge).toBeVisible();

    // The badge's extra width pushes this particular viewport just past
    // single-line eligibility (see main.ts's wouldSingleLineFit()), so the
    // real regression check is that whichever mode main.ts landed on has
    // every field visible, unclipped, even at the HUD_WORST_CASE_STATS_TEXT
    // budget.
    await setWorstCaseHudText(page);
    await expectFullyReadableHud(page);
  });
});
