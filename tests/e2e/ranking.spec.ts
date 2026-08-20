// E2E ranking suite (docs/plans/2026-08-16-score-ranking task 5). Runs
// against Vite's dev server like tests/e2e/smoke.spec.ts (playwright.config.ts's
// webServer) — there is no local Pages Functions server here, so every
// /api/* call is mocked via page.route(). This suite only exercises the
// ranking UI (src/ui/ranking.ts) wired through main.ts; server-side
// verifyReplay()/hash/name-validation behavior has its own unit tests under
// functions/_lib/ranking/*.test.ts (verified DOM-free there).
import { test, expect, type Page } from '@playwright/test';
import { GameSession } from '../../src/core/session';
import { encodeRle, type InputSample } from '../../src/core/rle';
import { RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../src/config';

// Minimal shape of the window.__game__ debug hook main.ts publishes,
// matching smoke.spec.ts's own local (not imported) declaration.
declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getScore: () => number;
        getTotalTicks: () => number;
        getGame: () => {
          getGraceTicks: () => number;
          getMarker: () => { isDrawing: () => boolean };
        };
      };
      /** Auto-advance transitions around replay skips (src/main.ts's debug hook). */
      getReplayAutoAdvanceLog: () => boolean[];
    };
  }
}

const APP_URL = 'http://localhost:4173/';

interface RankingEntry {
  id: string;
  createdAt: string;
  score: number;
  stage: number;
  name: string;
  xHandle: string | null;
  replayAvailable: boolean;
}

interface PendingRankingEntry {
  id: string;
  createdAt: string;
  score: number;
  stage: number;
  name: string;
  xHandle: string | null;
  unverified: true;
}

async function mockRanking(page: Page, entries: RankingEntry[], pendingEntries: PendingRankingEntry[] = []): Promise<void> {
  await page.route('**/api/ranking', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries, pendingEntries }),
    });
  });
}

/**
 * Mocks GET /api/ranking with a *full* (10-entry) board whose 10th-place
 * score sits `tenthPlaceOffset` away from whatever score the live run holds
 * at request time (read out of the page right then, so the boundary is exact
 * no matter how the wall-clock-timed chase actually played out).
 *
 * This is what pins down src/ui/ranking.ts's provisional-in-range comparison
 * at its exact boundary, which a `entries: []` mock cannot reach:
 * - offset  0 -> the run merely *ties* 10th place. Must NOT be offered: ties
 *   are broken by rank_seq ASC (first-come-first-served, functions/api/
 *   ranking.ts's 順位規則), so an equal score always sorts behind the
 *   incumbent — i.e. lands 11th and is deleted by POST's own trim step.
 * - offset -1 -> the run strictly beats 10th place. Must be offered.
 *
 * Returns a getter for how many GETs were served, so a test asserting a
 * *negative* (no overlay) can first prove the decision point was reached at
 * all rather than passing vacuously.
 */
async function mockFullBoardRelativeToLiveScore(page: Page, tenthPlaceOffset: number): Promise<() => number> {
  let getCount = 0;
  await page.route('**/api/ranking', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const liveScore = await page.evaluate(() => window.__game__!.session.getScore());
    const tenthScore = liveScore + tenthPlaceOffset;
    const entries: RankingEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: `full${i}`,
      createdAt: '2026-01-01T12:00:00Z',
      score: tenthScore + (9 - i), // descending, so index 9 (10th place) === tenthScore
      stage: 1,
      name: `RIVAL${i}`,
      xHandle: null,
      replayAvailable: false,
    }));
    getCount++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries }),
    });
  });
  return () => getCount;
}

// Fixes normal mode's internal per-run seed (src/main.ts's
// generateNormalRunSeed()) WITHOUT using `?seed=` — a `?seed=` run is
// runMode: 'seeded' and is structurally excluded from the whole ranking
// submission flow (src/ui/ranking.ts's isSnapshotEligible()), so it can't be
// used to stabilize these tests. generateNormalRunSeed() sources its seed
// from `crypto.getRandomValues(new Uint32Array(1))`; stubbing that (only for
// length-1 Uint32Array calls, so anything else that might call
// getRandomValues for an unrelated reason is left untouched) keeps the board
// deterministic while runMode stays 'normal' (POST-eligibility is preserved).
const SEED_VALUE = 1264;

async function stubDeterministicNormalSeed(page: Page): Promise<void> {
  await page.addInitScript((seed: number) => {
    const realGetRandomValues = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = ((array: ArrayBufferView | null) => {
      if (array instanceof Uint32Array && array.length === 1) {
        array[0] = seed;
        return array;
      }
      return realGetRandomValues(array as never);
    }) as Crypto['getRandomValues'];
  }, SEED_VALUE);
}

/**
 * Drives a fresh, fully POST-eligible run (normal mode, no `?debug`, no
 * `?seed=`) to a real 'life' gameover, by the cheapest deterministic route
 * the real game offers: draw a short line inward, then stand still on it and
 * let the Igniter (src/core/fuse.ts) spawn and catch up. Three of those cost
 * three lives and end the run.
 *
 * Chosen over chasing a Wisp (what this suite used to do) on two counts.
 * Determinism: the Igniter is pure, spawning a fixed number of ticks after
 * the marker stops and advancing on a fixed cadence, with no dependence on
 * enemy RNG, on the marker ever intercepting a moving target, or on how
 * promptly this loop re-reads and re-steers. Headless simulation of this
 * exact pattern reaches a 'life' gameover — never a 'stageclear' — in
 * ~1319 ticks (~22s) at every seed tried, because standing still on a line
 * claims nothing. And cost: it needs one page.evaluate() every 300ms and a
 * key pulse only after each life is lost, where the chase needed two or
 * three evaluate() round trips every 80ms for ~34s. That difference is not
 * cosmetic — this file runs four real-gameplay tests serially while the
 * other Playwright worker runs the rest of the suite, and the chase's IPC
 * load was enough to push a timing-sensitive pre-existing test
 * (tests/e2e/gameover-share.spec.ts, whose 8s polls this file must not and
 * cannot edit) over its budget under full-suite contention.
 *
 * The `grace === 0` guard matters: for ~2s after each miss, entering an
 * UNCLAIMED cell is blocked (docs/plan.md §3.5's grace-period exploit fix),
 * so a draw pulse issued during grace would do nothing at all and the run
 * would sit at the border forever. Re-pulsing whenever the marker is idle —
 * rather than once per observed life change — also self-heals if a pulse is
 * ever swallowed.
 */
async function reachGameoverDeterministically(page: Page, timeoutMs = 90_000): Promise<void> {
  await page.keyboard.press('Space'); // Title -> Playing
  await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const session = window.__game__!.session;
      const game = session.getGame();
      return {
        status: session.getStatus(),
        drawing: game.getMarker().isDrawing(),
        grace: game.getGraceTicks(),
      };
    });
    if (state.status === 'gameover') return;

    if (state.status === 'playing' && !state.drawing && state.grace === 0) {
      // Cut a fresh stub of line into the field, then let go: the marker is
      // left stationary mid-line, which is exactly the condition the Igniter
      // spawns on.
      await page.keyboard.down('KeyX');
      await page.keyboard.down('ArrowDown');
      await page.waitForTimeout(200);
      await page.keyboard.up('ArrowDown');
      await page.keyboard.up('KeyX');
    }
    await page.waitForTimeout(300);
  }

  const status = await page.evaluate(() => window.__game__?.session.getStatus());
  throw new Error(`reachGameoverDeterministically: timed out after ${timeoutMs}ms, status was "${status}"`);
}

/** Records a short, deterministic "wander, then time runs out" replay (mirrors src/core/replayEngine.test.ts's recordTimeUpRun) and base64-encodes it for a mocked replay payload. */
function recordShortReplay(seed: number, timeLimitTicks: number): string {
  const session = new GameSession({ seed, timeLimitTicks });
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  const samples: InputSample[] = [];
  while (session.getStatus() === 'playing') {
    const input: InputSample = { dx: 1, dy: 0, drawHeld: false, slow: false };
    session.update({ ...input, confirm: false });
    samples.push(input);
  }
  const rle = encodeRle(samples);
  return Buffer.from(rle).toString('base64');
}

// A replay that actually spans SEVERAL stages, which is what makes
// "SKIP TO FINAL STAGE" testable at all: with a single-stage replay the final
// stage boundary is tick 0, so the skip is a no-op and a broken skip would
// pass just as happily as a working one.
//
// Produced by a serpentine that repeatedly draws across the field and steps
// along the border, claiming a strip at a time until the stage's required
// occupancy (0.65) is met. Seed 377 was chosen by scanning seeds 1-400
// headlessly for the LATEST final-stage boundary among well-formed replays:
// it reaches FOUR stages, with the last beginning at tick 2172 of a
// 2278-tick run. That maximizes the amount of real work the skip has to do.
const MULTI_STAGE_SEED = 377;
const MULTI_STAGE_STRIP_WIDTH = 4;
const MULTI_STAGE_FINAL_STAGE = 4;

/** Auto-confirms StageClear without recording it, exactly as ReplayEngine's own protocol replays it. */
function recordMultiStageReplay(seed: number): string {
  const session = new GameSession({ seed });
  const confirm = { dx: 0 as const, dy: 0 as const, drawHeld: false, slow: false, confirm: true };
  session.update(confirm); // Title -> Playing
  const samples: InputSample[] = [];
  const step = (dx: -1 | 0 | 1, dy: -1 | 0 | 1, drawHeld: boolean): void => {
    samples.push({ dx, dy, drawHeld, slow: false });
    session.update({ dx, dy, drawHeld, slow: false, confirm: false });
    session.drainEvents();
    session.drainDespawnedEmberPositions();
  };

  const height = session.getGame().getField().getHeight();
  const stripWidth = MULTI_STAGE_STRIP_WIDTH;
  let goingDown = true;
  let guard = 0;
  while (session.getStatus() !== 'gameover' && guard++ < 12_000) {
    if (session.getStatus() === 'stageclear') {
      session.update(confirm); // not recorded: the engine re-supplies it on playback
      session.drainEvents();
      session.drainDespawnedEmberPositions();
      continue;
    }
    const targetY = goingDown ? height - 1 : 0;
    let crossing = 0;
    while (session.getStatus() === 'playing' && session.getGame().getMarker().getPosition().y !== targetY && crossing++ < height + 5) {
      step(0, goingDown ? 1 : -1, true);
    }
    for (let i = 0; i < stripWidth && session.getStatus() === 'playing'; i++) step(1, 0, false);
    goingDown = !goingDown;
  }
  return Buffer.from(encodeRle(samples)).toString('base64');
}

test.describe('ranking display', () => {
  test('shows entries with their dates, an X-handle link, a disabled REPLAY for unavailable rows, and renders an HTML-metacharacter name as inert text', async ({ page }) => {
    // Distinct dates per row (so each assertion below is unambiguous), all at
    // 12:00 UTC — src/ui/ranking.ts's formatRankingDate() renders in the
    // viewer's local timezone, and midday UTC lands on the same calendar day
    // in every timezone a CI/dev machine realistically runs in.
    const entries: RankingEntry[] = [
      { id: 'a', createdAt: '2026-01-02T12:00:00Z', score: 999, stage: 3, name: 'PLAIN', xHandle: null, replayAvailable: true },
      { id: 'b', createdAt: '2026-02-03T12:00:00Z', score: 500, stage: 2, name: 'HANDLED', xHandle: 'e2e_handle', replayAvailable: true },
      {
        id: 'c',
        createdAt: '2026-03-04T12:00:00Z',
        score: 1,
        stage: 1,
        name: '<img src=x onerror=alert(1)>',
        xHandle: null,
        replayAvailable: false,
      },
    ];
    await mockRanking(page, entries);
    await page.goto(APP_URL);

    await page.locator('#ranking-button').click();
    await expect(page.getByText('X handles are self-reported')).toBeVisible();
    await expect(page.getByText('#1  999  STAGE 3')).toBeVisible();
    await expect(page.getByText('#2  500  STAGE 2')).toBeVisible();

    // Date (task 4's "日付・スコア・ステージ・名前") — one per row.
    await expect(page.getByText('2026-01-02')).toBeVisible();
    await expect(page.getByText('2026-02-03')).toBeVisible();
    await expect(page.getByText('2026-03-04')).toBeVisible();

    const handleLink = page.locator('a', { hasText: '@e2e_handle' });
    await expect(handleLink).toHaveAttribute('href', 'https://x.com/e2e_handle');

    // XSS safety: the raw string appears as literal visible text, and no
    // <img> element was ever created from it (textContent-only rendering).
    await expect(page.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
    await expect(page.locator('img')).toHaveCount(0);

    const replayButtons = page.getByRole('button', { name: 'REPLAY' });
    await expect(replayButtons).toHaveCount(3);
    await expect(replayButtons.nth(2)).toBeDisabled(); // entry 'c': replayAvailable: false
    await expect(replayButtons.nth(0)).toBeEnabled();
  });

  // docs/plans/2026-08-19-ranking-free-async spec item 5: pendingEntries
  // renders as an unranked section ABOVE the confirmed board — never merged
  // into it, no rank number, no REPLAY button (the server itself refuses to
  // serve a pending row's replay regardless of what the UI does or doesn't
  // offer — see functions/api/ranking/[id]/replay.ts's status='verified'
  // requirement, covered separately by its own unit tests).
  test('renders pendingEntries as an unranked "PENDING VERIFICATION" section above the confirmed TOP10, never affecting its ranks/order', async ({ page }) => {
    const entries: RankingEntry[] = [
      { id: 'v1', createdAt: '2026-01-02T12:00:00Z', score: 900, stage: 3, name: 'CONFIRMED1', xHandle: null, replayAvailable: true },
      { id: 'v2', createdAt: '2026-01-03T12:00:00Z', score: 800, stage: 2, name: 'CONFIRMED2', xHandle: null, replayAvailable: true },
    ];
    const pendingEntries: PendingRankingEntry[] = [
      { id: 'p1', createdAt: '2026-01-04T12:00:00Z', score: 950, stage: 5, name: 'PENDING1', xHandle: null, unverified: true },
    ];
    await mockRanking(page, entries, pendingEntries);
    await page.goto(APP_URL);

    await page.locator('#ranking-button').click();
    await expect(page.getByText('PENDING VERIFICATION')).toBeVisible();
    // The pending row's score/stage/name appear, but with NO rank number
    // (unlike '#1 900 STAGE 3 CONFIRMED1' below) and a PENDING badge instead
    // of a REPLAY button.
    await expect(page.getByText('950  STAGE 5')).toBeVisible();
    await expect(page.getByText('#1  950')).toHaveCount(0); // never assigned a rank, even though it outscores both confirmed entries
    await expect(page.getByText('PENDING', { exact: true })).toBeVisible();

    // The confirmed board is untouched: still exactly 2 ranked rows, in
    // their own score order, unaffected by the pending entry's higher score.
    await expect(page.getByText('#1  900  STAGE 3')).toBeVisible();
    await expect(page.getByText('#2  800  STAGE 2')).toBeVisible();
    const replayButtons = page.getByRole('button', { name: 'REPLAY' });
    await expect(replayButtons).toHaveCount(2); // only the confirmed rows get a REPLAY button, never the pending one
  });

  test('renders no "PENDING VERIFICATION" section at all when pendingEntries is empty', async ({ page }) => {
    await mockRanking(page, [{ id: 'v1', createdAt: '2026-01-02T12:00:00Z', score: 900, stage: 3, name: 'SOLO', xHandle: null, replayAvailable: true }], []);
    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await expect(page.getByText('#1  900  STAGE 3')).toBeVisible();
    await expect(page.getByText('PENDING VERIFICATION')).toHaveCount(0);
  });
});

test.describe('ranking browsing is a Title-screen-only affordance', () => {
  // Why this is a correctness requirement and not a style choice: starting a
  // replay suspends the live GameSession entirely (src/main.ts's update()
  // returns early while viewMode === 'replay'), so a mid-run
  // RANKING -> REPLAY -> EXIT round trip would pause a time-limited run for
  // as long as the player likes and then resume the same still-submittable
  // run. Keeping the entry point on Title removes the pause primitive.
  // (The "…and comes back once the run really ends" half of this rule is
  // asserted on a genuine gameover -> Title transition in the stale-response
  // test below, which already pays for a real run.)
  test('the RANKING button is visible on Title, hidden while playing, and present again on a fresh Title', async ({ page }) => {
    await mockRanking(page, []);
    await page.goto(APP_URL);

    const rankingButton = page.locator('#ranking-button');
    await expect(rankingButton).toBeVisible();

    await page.keyboard.press('Space'); // Title -> Playing
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');
    await expect(rankingButton).toBeHidden();

    // And it comes back once the session is on Title again (driven here via
    // the debug-panel-free route: reload, which starts a fresh Title).
    await page.reload();
    await expect(page.locator('#ranking-button')).toBeVisible();
  });

  test('starting a run closes an open ranking list instead of leaving it over a live game', async ({ page }) => {
    await mockRanking(page, [
      { id: 'x', createdAt: '2026-01-01T12:00:00Z', score: 1, stage: 1, name: 'OPEN', xHandle: null, replayAvailable: true },
    ]);
    await page.goto(APP_URL);

    await page.locator('#ranking-button').click();
    await expect(page.getByText('X handles are self-reported')).toBeVisible();

    // The Title screen's "press any key to start" confirm still fires while
    // the overlay is up, so the list must not survive into the run.
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');
    await expect(page.getByText('X handles are self-reported')).toBeHidden();
    await expect(page.getByRole('button', { name: 'REPLAY' })).toBeHidden();
  });

  test('a replay response that lands after the player has started a run does not hijack the live game', async ({ page }) => {
    // The gate has to hold across startReplayFor()'s own await, not just at
    // click time: the Title "press any key" confirm still fires while the
    // replay request is outstanding, so a late response could otherwise drop
    // a live run into replay mode — which suspends the session entirely and
    // hands back the pause the Title-only gate exists to remove.
    const rleBase64 = recordShortReplay(2026, 4);
    await mockRanking(page, [
      { id: 'slow', createdAt: '2026-01-01T12:00:00Z', score: 42, stage: 1, name: 'SLOW', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: 2026, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
      });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();

    // Start a run while the replay request is still in flight.
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');

    await page.waitForTimeout(4500); // let the stale replay response land

    // No replay viewer, and — the part that actually matters — the live run
    // is still being ticked, i.e. never got suspended.
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeHidden();
    expect(await page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');
    const ticksBefore = await page.evaluate(() => window.__game__!.session.getTotalTicks());
    await expect
      .poll(() => page.evaluate(() => window.__game__!.session.getTotalTicks()))
      .toBeGreaterThan(ticksBefore);
  });
});

test.describe('name-input submission flow', () => {
  // Serialized (unlike this file's other, network-only describes): every
  // test here drives ~22s of real, wall-clock-timed gameplay via
  // reachGameoverDeterministically(). Running them concurrently in separate
  // Chromium workers (playwright.config.ts's fullyParallel default) contends
  // for real CPU/frame-rate — both between themselves and against the other
  // worker's suite — which is exactly the pressure that used to make these
  // miss their budget. Serial keeps this file's gameplay load to one run at
  // a time.
  test.describe.configure({ mode: 'serial' });
  // 90s is reachGameoverDeterministically()'s own internal budget for a run
  // that normally completes in ~22s; 120s leaves room for that plus the
  // surrounding assertions/waits without masking a genuine hang.
  test.setTimeout(120_000);

  test('a real (non-tainted, non-seeded) gameover that beats a FULL board offers submission, and SUBMIT posts score/stage and shows the pending-verification confirmation', async ({ page }) => {
    let scoresPostCount = 0;
    let lastPostedBody: Record<string, unknown> | undefined;
    // A full 10-entry board whose 10th place is exactly one point *below*
    // the achieved score: the strictly-better side of the boundary, which
    // an `entries: []` mock (see the SKIP test below) never exercises.
    await mockFullBoardRelativeToLiveScore(page, -1);
    await page.route('**/api/scores', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      scoresPostCount++;
      lastPostedBody = route.request().postDataJSON();
      // docs/plans/2026-08-19-ranking-free-async: POST no longer resimulates
      // synchronously, so a success response carries no final rank — only
      // "provisionally accepted, pending verification".
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accepted: true, status: 'pending', message: 'provisionally accepted — pending verification' }),
      });
    });

    await stubDeterministicNormalSeed(page);
    await page.goto(APP_URL); // no ?seed= — normal mode is required for POST-eligibility
    await reachGameoverDeterministically(page);

    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeVisible();

    // X-handle checkbox swaps the input.
    const nameInput = page.getByPlaceholder('NAME');
    const handleCheckbox = page.getByRole('checkbox', { name: 'USE X HANDLE INSTEAD' });
    await handleCheckbox.check();
    const handleInput = page.getByPlaceholder('@handle');
    await expect(handleInput).toBeVisible();
    await expect(nameInput).toBeHidden();
    await handleInput.fill('e2e_submitter');

    await page.getByRole('button', { name: 'SUBMIT' }).click();
    await expect(page.getByText('SUBMITTED — PENDING VERIFICATION.')).toBeVisible();
    expect(scoresPostCount).toBe(1);
    expect(lastPostedBody?.xHandle).toBe('e2e_submitter');
    expect(lastPostedBody?.rulesetVersion).toBe(RULESET_VERSION);
    expect(lastPostedBody?.replayFormatVersion).toBe(REPLAY_FORMAT_VERSION);
    // docs/plans/2026-08-19-ranking-free-async spec item 1: score/stage are
    // now the client's claim in the POST body (previously absent — the
    // synchronous version's verifyReplay() derived them server-side).
    expect(typeof lastPostedBody?.score).toBe('number');
    expect(typeof lastPostedBody?.stage).toBe('number');
    // duration_ticks is deliberately NEVER a client-submitted field, in
    // either version — confirms this round didn't accidentally add one.
    expect(lastPostedBody?.durationTicks).toBeUndefined();
    expect(lastPostedBody?.duration_ticks).toBeUndefined();
  });

  test('SKIP dismisses the submission overlay without ever POSTing', async ({ page }) => {
    let scoresPostCount = 0;
    await mockRanking(page, []);
    await page.route('**/api/scores', (route) => {
      scoresPostCount++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await stubDeterministicNormalSeed(page);
    await page.goto(APP_URL);
    await reachGameoverDeterministically(page);
    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeVisible();

    await page.getByRole('button', { name: 'SKIP' }).click();
    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeHidden();
    expect(scoresPostCount).toBe(0);
  });

  test('a gameover that merely TIES the 10th place of a full board is not offered submission (first-come-first-served)', async ({ page }) => {
    let scoresPostCount = 0;
    const rankingGetCount = await mockFullBoardRelativeToLiveScore(page, 0); // exact tie with 10th place
    await page.route('**/api/scores', (route) => {
      scoresPostCount++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await stubDeterministicNormalSeed(page);
    await page.goto(APP_URL);
    await reachGameoverDeterministically(page);

    // Not vacuous: the provisional-rank GET really was served (i.e. the
    // gameover flow reached the in-range decision, and the sibling test
    // above proves the overlay *does* appear when the score strictly beats
    // that same full board) — it simply decided "out of range" this time.
    await expect.poll(rankingGetCount).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(500); // let any (incorrect) overlay reveal settle before asserting its absence
    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeHidden();
    await expect(page.getByPlaceholder('NAME')).toBeHidden();
    expect(scoresPostCount).toBe(0);
  });

  test("run A's slow POST response cannot clobber run B's form or lock its SUBMIT", async ({ page }) => {
    // submitStatus / SUBMIT / SKIP are a single form reused by every run. If
    // run A's reply is applied after run B's offer has taken over, it both
    // reports A's outcome as if it were B's and — by hiding/disabling SUBMIT
    // — leaves B unsubmittable. (The in-flight marker used to be a shared
    // boolean, which locked B's button out on its own.)
    let posts = 0;
    let resolveFirstPost: (() => void) | null = null;
    const firstPostReceived = new Promise<void>((resolve) => {
      resolveFirstPost = resolve;
    });
    let releaseFirstPost: (() => void) | null = null;
    const firstPostReleased = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });

    await mockRanking(page, []); // empty board: every run is provisionally in range
    await page.route('**/api/scores', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts++;
      if (posts === 1) {
        resolveFirstPost!();
        await firstPostReleased; // held open across the whole of run B
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ accepted: true, status: 'pending' }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: true, status: 'pending' }) });
    });

    await stubDeterministicNormalSeed(page);
    await page.goto(APP_URL);

    // --- Run A: reach gameover, submit, leave the POST hanging ---
    await reachGameoverDeterministically(page);
    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeVisible();
    await page.getByPlaceholder('NAME').fill('RUN-A');
    await page.getByRole('button', { name: 'SUBMIT' }).click();
    await firstPostReceived;
    await expect(page.getByText('SUBMITTING...')).toBeVisible();

    // --- Run B: back to Title, play again, get a fresh offer ---
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('title');
    await reachGameoverDeterministically(page);
    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeVisible();

    const nameInput = page.getByPlaceholder('NAME');
    const submitButton = page.getByRole('button', { name: 'SUBMIT' });
    await expect(nameInput).toHaveValue(''); // a fresh form, not run A's
    await expect(submitButton).toBeVisible();
    await expect(submitButton).toBeEnabled();

    // --- Run A's response finally lands, mid-run-B-form ---
    releaseFirstPost!();
    await page.waitForTimeout(1500);

    // Run B's form is untouched: run A's (now-resolved) response did not
    // overwrite it into its post-submit state (hidden SUBMIT, "OK" SKIP
    // label) — the async-audit response contract no longer carries a
    // distinguishing per-run rank number to assert on directly (both runs'
    // success responses read identically, "provisionally accepted"), so
    // this asserts the stronger, more direct thing: the form B is looking
    // at is still its OWN pre-submit state, not run A's post-submit one.
    await expect(submitButton).toBeVisible();
    await expect(submitButton).toBeEnabled();
    await expect(page.getByRole('button', { name: 'SKIP' })).toBeVisible(); // not yet relabeled "OK" by a leaked response

    // And run B is still genuinely submittable.
    await nameInput.fill('RUN-B');
    await submitButton.click();
    await expect(page.getByText('SUBMITTED — PENDING VERIFICATION.')).toBeVisible();
    expect(posts).toBe(2);
  });

  test('a provisional-rank response that lands after the player has left GAME OVER never reopens the form', async ({ page }) => {
    // The race: offerSubmission() must ask the server for the current top 10
    // before it can decide whether to show the name field, and the player can
    // walk straight past that await (GAME OVER -> any key -> Title). A
    // response arriving then used to reopen the form — and the form used to
    // read the *live* seed/InputRecorder at submit time, i.e. the run now in
    // progress rather than the one that earned the score.
    let scoresPostCount = 0;
    let rankingGets = 0;
    await page.route('**/api/ranking', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      rankingGets++;
      await new Promise((resolve) => setTimeout(resolve, 3000)); // still in flight when the player moves on
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries: [] }), // empty board: would definitely be "in range"
      });
    });
    await page.route('**/api/scores', (route) => {
      scoresPostCount++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await stubDeterministicNormalSeed(page);
    await page.goto(APP_URL);
    await reachGameoverDeterministically(page);

    // The RANKING button stays hidden on GAME OVER too (browsing is Title-only).
    await expect(page.locator('#ranking-button')).toBeHidden();

    // Leave the finished run behind while the GET is still outstanding.
    await expect.poll(() => rankingGets).toBeGreaterThanOrEqual(1);
    await page.keyboard.press('Space'); // GAME OVER -> Title (a brand-new run id)
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('title');

    // ...and it really does come back on the Title a finished run returns to.
    await expect(page.locator('#ranking-button')).toBeVisible();

    // Let the stale response land (3s delay above) plus margin.
    await page.waitForTimeout(4000);
    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeHidden();
    await expect(page.getByPlaceholder('NAME')).toBeHidden();
    expect(scoresPostCount).toBe(0);
  });
});

test.describe('replay viewing', () => {
  test('plays a mocked replay, skips to the final stage, exits, and never POSTs or touches the stored high score', async ({ page }) => {
    const rleBase64 = recordMultiStageReplay(MULTI_STAGE_SEED);
    let scoresPostCount = 0;

    await mockRanking(page, [
      { id: 'r1', createdAt: '2026-01-01T00:00:00Z', score: 42, stage: 1, name: 'REPLAYED', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: MULTI_STAGE_SEED, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
      });
    });
    await page.route('**/api/scores', (route) => {
      scoresPostCount++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto(APP_URL);
    const highScoreBefore = await page.evaluate(() => localStorage.getItem('qixxx.highScore'));

    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();

    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeVisible();

    // The replay starts on stage 1; the skip must actually carry it to the
    // replay's final stage (boundary tick ~1191), which is only observable
    // because this fixture spans several stages. The HUD reflects whichever
    // session is being rendered, so during replay it shows the replay's.
    await expect(page.locator('#hud')).toContainText('STAGE 1');
    // The control bar says which stage of how many is on screen, and marks
    // the run's LAST stage as such (user feedback, 2026-08-20) — on stage 1
    // of 4 there is no FINAL STAGE marker yet.
    await expect(page.getByText(`REPLAY - STAGE 1 / ${MULTI_STAGE_FINAL_STAGE}`)).toBeVisible();
    await page.getByRole('button', { name: 'SKIP TO FINAL STAGE' }).click();
    await expect(page.locator('#hud')).toContainText(`STAGE ${MULTI_STAGE_FINAL_STAGE}`, { timeout: 20_000 });
    // ...and once the skip lands on it, the marker appears.
    await expect(page.getByText(`REPLAY - STAGE ${MULTI_STAGE_FINAL_STAGE} / ${MULTI_STAGE_FINAL_STAGE} (FINAL STAGE)`)).toBeVisible({ timeout: 20_000 });
    // The button returns to its idle label once the chunked skip finishes.
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeEnabled();

    // Normal playback was suspended for the duration and restored afterwards.
    // Asserted on the transition log rather than by watching the board: the
    // skip and main.ts's per-frame driver would step the SAME engine, and on
    // a replay this short that double-advance is only a few ticks of drift —
    // real, but far too small to observe as a wrong stage.
    await expect
      .poll(() => page.evaluate(() => window.__game__!.getReplayAutoAdvanceLog()))
      .toEqual([false, true]);

    // Before EXIT the list is closed (startReplayFor() hid it on the way in).
    await expect(page.getByText('#1  42  STAGE 1')).toBeHidden();

    await page.getByRole('button', { name: 'EXIT' }).click();
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeHidden();

    // "終了して一覧へ戻る" (task 4): EXIT reopens the ranking list rather
    // than just dropping back to the live screen.
    await expect(page.getByText('#1  42  STAGE 1')).toBeVisible();
    await expect(page.getByText('X handles are self-reported')).toBeVisible();

    expect(scoresPostCount).toBe(0); // no persistence/POST side effects during replay viewing
    const highScoreAfter = await page.evaluate(() => localStorage.getItem('qixxx.highScore'));
    expect(highScoreAfter).toBe(highScoreBefore);
  });

  // User feedback (2026-08-20): while watching a replay there was no way to
  // tell "more stages are coming" from "this is the stage they died on", and
  // the end-of-playback line ("REPLAY FINISHED") read as "the video stopped"
  // rather than "the run ended here". A replay is a whole recorded run, so
  // reaching gameover IS that run's death — both places now say so.
  test('a replay marks its final stage and, at the end, says the run game-overed there', async ({ page }) => {
    // The multi-stage fixture, specifically: it is recorded with the real
    // game settings and so genuinely reaches gameover on playback. (The short
    // fixture above is recorded with a 4-tick time limit and replays under
    // the real one, so its input merely runs out mid-play — a legitimate case
    // that must NOT claim a gameover, which is why the status line only says
    // "GAME OVER HERE" for an actual one.)
    const rleBase64 = recordMultiStageReplay(MULTI_STAGE_SEED);
    await mockRanking(page, [
      { id: 'ender', createdAt: '2026-01-01T00:00:00Z', score: 7, stage: MULTI_STAGE_FINAL_STAGE, name: 'ENDER', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: MULTI_STAGE_SEED, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
      });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeVisible();

    // Skip to the final stage so the remaining ~100 ticks of playback reach
    // the end of the run within the test's patience.
    await page.getByRole('button', { name: 'SKIP TO FINAL STAGE' }).click();
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeEnabled({ timeout: 20_000 });

    // 1. Playback runs out on the stage the run died on, and the status line
    //    says exactly that rather than leaving it to be inferred.
    await expect(page.getByText(`REPLAY END - STAGE ${MULTI_STAGE_FINAL_STAGE} / ${MULTI_STAGE_FINAL_STAGE} (GAME OVER HERE)`)).toBeVisible({ timeout: 20_000 });

    // 2. The board's own end-of-replay overlay says the same thing, with the
    //    run's score and its stage as "n / N".
    await expect(page.locator('#screen')).toContainText('GAME OVER - REPLAY END');
    await expect(page.locator('#screen')).toContainText(`STAGE ${MULTI_STAGE_FINAL_STAGE} / ${MULTI_STAGE_FINAL_STAGE} (FINAL STAGE)`);

    // Replay isolation is unchanged by the new wording: still no POST, and
    // the live session was never touched (it is still sitting on the Title it
    // was on when the replay started).
    await page.getByRole('button', { name: 'EXIT' }).click();
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeHidden();
    expect(await page.evaluate(() => window.__game__?.session.getStatus())).toBe('title');
  });

  test('a 410 from the replay endpoint shows a graceful message instead of a silent failure', async ({ page }) => {
    await mockRanking(page, [
      { id: 'stale', createdAt: '2026-01-01T00:00:00Z', score: 10, stage: 1, name: 'STALE', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'format mismatch' }) });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();

    await expect(page.getByText('THIS RECORD CANNOT BE REPLAYED ON THE CURRENT VERSION.')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText('THIS RECORD CANNOT BE REPLAYED ON THE CURRENT VERSION.')).toBeHidden();
  });

  test('an error message never survives into a live run', async ({ page }) => {
    // The message overlay is dismissed by its own OK button, so before this
    // it could sit across the whole board for an entire run — the Title
    // "press any key" confirm starts the game right through it.
    await mockRanking(page, [
      { id: 'stale', createdAt: '2026-01-01T12:00:00Z', score: 10, stage: 1, name: 'STALE', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'format mismatch' }) });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();
    await expect(page.getByText('THIS RECORD CANNOT BE REPLAYED ON THE CURRENT VERSION.')).toBeVisible();

    await page.keyboard.press('Space'); // start a run with the message still up
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');
    await expect(page.getByText('THIS RECORD CANNOT BE REPLAYED ON THE CURRENT VERSION.')).toBeHidden();
    await expect(page.getByRole('button', { name: 'OK' })).toBeHidden();
  });

  test('a replay payload this build cannot honour is refused instead of played back wrongly', async ({ page }) => {
    // A stale tab across a deploy: the server considers the row current, but
    // this bundle's core implements an older ruleset, so resimulating it
    // would render a plausible-looking *wrong* run rather than fail.
    const rleBase64 = recordShortReplay(2026, 4);
    await mockRanking(page, [
      { id: 'future', createdAt: '2026-01-01T12:00:00Z', score: 10, stage: 1, name: 'FUTURE', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          seed: 2026,
          rleBase64,
          rulesetVersion: RULESET_VERSION + 1, // newer than this build
          replayFormatVersion: REPLAY_FORMAT_VERSION,
        }),
      });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();

    await expect(page.getByText('THIS RECORD CANNOT BE REPLAYED ON THE CURRENT VERSION.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeHidden(); // never entered replay mode
  });

  test('an undecodable replay payload fails with a message rather than an unhandled rejection', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await mockRanking(page, [
      { id: 'corrupt', createdAt: '2026-01-01T12:00:00Z', score: 10, stage: 1, name: 'CORRUPT', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          // Valid base64, but not a valid RLE stream: 0xFF is not a legal
          // sample code, so decoding throws (src/core/rle.ts).
          seed: 2026,
          rleBase64: '/wE=',
          rulesetVersion: RULESET_VERSION,
          replayFormatVersion: REPLAY_FORMAT_VERSION,
        }),
      });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();

    await expect(page.getByText('THIS REPLAY COULD NOT BE PLAYED BACK.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test('SKIP TO FINAL STAGE keeps the page responsive while it works', async ({ page }) => {
    // The skip resimulates up to a whole replay. Done synchronously it froze
    // the main thread outright; chunked, the page can still paint and answer
    // input while it runs.
    const rleBase64 = recordMultiStageReplay(MULTI_STAGE_SEED);
    await mockRanking(page, [
      { id: 'long', createdAt: '2026-01-01T12:00:00Z', score: 10, stage: 1, name: 'LONG', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: MULTI_STAGE_SEED, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
      });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeVisible();

    await page.getByRole('button', { name: 'SKIP TO FINAL STAGE' }).click();
    // The button returns to its idle label once the chunked skip completes —
    // if the skip blocked the main thread, the intermediate state could never
    // render at all.
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeVisible();

    // The page is still live and interactive afterwards.
    await page.getByRole('button', { name: 'EXIT' }).click();
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeHidden();
  });

  test('EXIT during a skip cancels it, leaving no SKIPPING... state for the next replay', async ({ page }) => {
    // Two things used to leak past EXIT: the skip loop kept advancing a
    // discarded engine, and the button could still be showing SKIPPING...
    // when the next replay opened.
    const rleBase64 = recordMultiStageReplay(MULTI_STAGE_SEED);
    await mockRanking(page, [
      { id: 'ms', createdAt: '2026-01-01T12:00:00Z', score: 10, stage: 1, name: 'MULTI', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: MULTI_STAGE_SEED, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
      });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeVisible();

    // Both clicks in ONE evaluate, deliberately: the skip runs its first
    // chunk synchronously and then awaits a macrotask, so an EXIT dispatched
    // in the same task lands strictly *between* chunks. Two separate
    // Playwright clicks are milliseconds apart, by which time this ~2172-tick
    // skip has already finished — i.e. the abort path would never be reached
    // and the test would pass without testing anything.
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const byLabel = (label: string) => buttons.find((b) => b.textContent === label) as HTMLButtonElement;
      byLabel('SKIP TO FINAL STAGE').click();
      byLabel('EXIT').click();
    });
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeHidden();

    // Playback was suspended by the skip and never resumed afterwards: the
    // aborted skip must not restart a driver for an engine that has already
    // been discarded.
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__game__!.getReplayAutoAdvanceLog())).toEqual([false]);

    // Reopening a replay finds a clean control bar, not a stuck SKIPPING...
    await expect(page.getByRole('button', { name: 'REPLAY' })).toBeVisible();
    await page.getByRole('button', { name: 'REPLAY' }).click();
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'SKIPPING...' })).toBeHidden();

    // And the fresh replay still skips correctly.
    await page.getByRole('button', { name: 'SKIP TO FINAL STAGE' }).click();
    await expect(page.locator('#hud')).toContainText(`STAGE ${MULTI_STAGE_FINAL_STAGE}`, { timeout: 20_000 });
  });

  test('closing the list cancels an in-flight replay pre-pass instead of letting it run on', async ({ page }) => {
    // The pre-pass is up to 10800 ticks of simulation. Before cancellation it
    // kept running after the player had moved on, competing for frames with
    // whatever came next — the exact cost chunking was meant to avoid.
    const rleBase64 = recordMultiStageReplay(MULTI_STAGE_SEED);
    await mockRanking(page, [
      { id: 'ms', createdAt: '2026-01-01T12:00:00Z', score: 10, stage: 1, name: 'MULTI', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: MULTI_STAGE_SEED, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
      });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();

    // Start a run while the fetch + pre-pass are still under way.
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');

    // The replay must never take over, and the live run must keep ticking.
    await page.waitForTimeout(2500);
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeHidden();
    expect(await page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');
    const ticks = await page.evaluate(() => window.__game__!.session.getTotalTicks());
    await expect.poll(() => page.evaluate(() => window.__game__!.session.getTotalTicks())).toBeGreaterThan(ticks);
  });
});
