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

/**
 * GET /api/ranking's `displayEntries` (docs/plans/2026-08-19-ranking-free-
 * async spec item 5, 2026-08-20 revision) — the merged board the UI draws:
 * every RankingEntry field plus `status`.
 */
interface DisplayRankingEntry extends RankingEntry {
  status: 'pending' | 'verified';
}

/**
 * Mocks GET /api/ranking's two field families.
 *
 * `entries` is the submission-eligibility basis (verified only) and
 * `displayEntries` is what the list renders. When only `entries` is given,
 * the display board is derived from it as all-verified — the ordinary case,
 * where the two agree.
 */
async function mockRanking(page: Page, entries: RankingEntry[], displayEntries?: DisplayRankingEntry[]): Promise<void> {
  const display = displayEntries ?? entries.map((entry) => ({ ...entry, status: 'verified' as const }));
  await page.route('**/api/ranking', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries, displayEntries: display }),
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
async function mockFullBoardRelativeToLiveScore(
  page: Page,
  tenthPlaceOffset: number,
  displayPending: DisplayRankingEntry[] = []
): Promise<() => number> {
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
    // `displayPending` models the anti-griefing scenario (spec item 15a):
    // pending rows sitting at the TOP of the merged board while `entries` —
    // the only thing the offer decision may read — is unchanged.
    const displayEntries: DisplayRankingEntry[] = [
      ...displayPending,
      ...entries.map((entry) => ({ ...entry, status: 'verified' as const })),
    ].slice(0, 10);
    getCount++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries, displayEntries }),
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

  // Reported from a real device (2026-08-20): a submission made with only an
  // X handle showed up as "(no name)" beside the player's own handle. A
  // handle-only row stores name='' (the form submits one or the other), and
  // the handle IS the name in that case — "(no name)" must mean only that
  // neither was given.
  test('a handle-only row shows the handle as its name (and only "(no name)" when there is genuinely neither)', async ({ page }) => {
    const entries: RankingEntry[] = [
      { id: 'h', createdAt: '2026-01-02T12:00:00Z', score: 900, stage: 3, name: '', xHandle: 'handleonly', replayAvailable: true },
      { id: 'n', createdAt: '2026-01-03T12:00:00Z', score: 800, stage: 2, name: '', xHandle: null, replayAvailable: true },
      { id: 'b', createdAt: '2026-01-04T12:00:00Z', score: 700, stage: 1, name: 'BOTH', xHandle: 'both_handle', replayAvailable: true },
    ];
    // Two pending rows on the merged board, one handle-only and one with
    // neither name nor handle — same precedence rules, same link.
    const displayEntries: DisplayRankingEntry[] = [
      { id: 'ph', createdAt: '2026-01-05T12:00:00Z', score: 950, stage: 5, name: '', xHandle: 'pendinghandle', replayAvailable: true, status: 'pending' },
      { id: 'pn', createdAt: '2026-01-06T12:00:00Z', score: 940, stage: 4, name: '', xHandle: null, replayAvailable: true, status: 'pending' },
      ...entries.map((entry) => ({ ...entry, status: 'verified' as const })),
    ];
    await mockRanking(page, entries, displayEntries);
    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();

    // Verified rows (ranked #3-#5 here, behind the two pending rows): handle
    // in the name slot, and as the row's ONE link (the meta line no longer
    // repeats it) — so the profile stays reachable without printing the
    // handle twice.
    await expect(page.getByText('#3  900  STAGE 3  @handleonly')).toBeVisible();
    const handleOnlyLinks = page.locator('a', { hasText: '@handleonly' });
    await expect(handleOnlyLinks).toHaveCount(1);
    await expect(handleOnlyLinks).toHaveAttribute('href', 'https://x.com/handleonly');

    // Neither name nor handle: still "(no name)", which now means exactly that.
    await expect(page.getByText('#4  800  STAGE 2  (no name)')).toBeVisible();

    // A row with BOTH is unchanged: name in the slot, handle on the meta line.
    await expect(page.getByText('#5  700  STAGE 1  BOTH')).toBeVisible();
    await expect(page.locator('a', { hasText: '@both_handle' })).toHaveAttribute('href', 'https://x.com/both_handle');

    // Pending rows follow the same name/handle precedence AND get the same
    // link (decision of 2026-08-22): the audit verifies the score, never
    // handle ownership, so a row's audit state is no reason to withhold it.
    await expect(page.getByText('#1  950  STAGE 5  @pendinghandle')).toBeVisible();
    await expect(page.locator('a', { hasText: '@pendinghandle' })).toHaveAttribute('href', 'https://x.com/pendinghandle');
    await expect(page.getByText('#2  940  STAGE 4  (no name)')).toBeVisible();
  });

  // docs/plans/2026-08-19-ranking-free-async spec item 5 (2026-08-20
  // revision) as amended 2026-08-22: ONE board, and one kind of row. A
  // pending row is drawn at the rank it actually holds with nothing marking
  // it out — no badge, no separate section — and a REPLAY button gated on
  // the same `replayAvailable` field every other row uses. Verification is
  // disclosed once, by the static notice under the heading.
  test('renders pending rows inline in the single ranked board, unmarked, with no separate pending section and the verification notice shown', async ({ page }) => {
    const entries: RankingEntry[] = [
      { id: 'v1', createdAt: '2026-01-02T12:00:00Z', score: 900, stage: 3, name: 'CONFIRMED1', xHandle: null, replayAvailable: true },
      { id: 'v2', createdAt: '2026-01-03T12:00:00Z', score: 800, stage: 2, name: 'CONFIRMED2', xHandle: null, replayAvailable: true },
    ];
    const displayEntries: DisplayRankingEntry[] = [
      { id: 'p1', createdAt: '2026-01-04T12:00:00Z', score: 950, stage: 5, name: 'PENDING1', xHandle: null, replayAvailable: true, status: 'pending' },
      ...entries.map((entry) => ({ ...entry, status: 'verified' as const })),
    ];
    await mockRanking(page, entries, displayEntries);
    await page.goto(APP_URL);

    await page.locator('#ranking-button').click();
    // The pending row holds #1 — the position its score earns it.
    await expect(page.getByText('#1  950  STAGE 5  PENDING1')).toBeVisible();
    await expect(page.getByText('#2  900  STAGE 3')).toBeVisible();
    await expect(page.getByText('#3  800  STAGE 2')).toBeVisible();

    // No per-row marker of any kind, and no trace of the old separate section.
    await expect(page.getByText(/VERIFYING/)).toHaveCount(0);
    await expect(page.getByText('PENDING VERIFICATION')).toHaveCount(0);
    // The one place verification IS mentioned: the board-wide notice.
    await expect(page.getByText('Scores are verified after posting; entries that fail verification are removed.')).toBeVisible();

    // Every row — pending included — gets a REPLAY button, because a fresh
    // pending row's replay is servable now (spec item 7).
    const replayButtons = page.getByRole('button', { name: 'REPLAY' });
    await expect(replayButtons).toHaveCount(3);
    await expect(replayButtons.nth(0)).toBeEnabled();
  });

  test('shows the verification notice even when every displayed row is verified (it is a rule of the board, not a row state)', async ({ page }) => {
    await mockRanking(page, [{ id: 'v1', createdAt: '2026-01-02T12:00:00Z', score: 900, stage: 3, name: 'SOLO', xHandle: null, replayAvailable: true }]);
    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await expect(page.getByText('#1  900  STAGE 3')).toBeVisible();
    await expect(page.getByText('Scores are verified after posting; entries that fail verification are removed.')).toBeVisible();
    await expect(page.getByText(/VERIFYING/)).toHaveCount(0);
  });

  test('a pending row whose replay format has moved on gets the same disabled REPLAY button a verified one would', async ({ page }) => {
    const displayEntries: DisplayRankingEntry[] = [
      { id: 'p1', createdAt: '2026-01-04T12:00:00Z', score: 950, stage: 5, name: 'OLDFORMAT', xHandle: null, replayAvailable: false, status: 'pending' },
    ];
    await mockRanking(page, [], displayEntries);
    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await expect(page.getByText('#1  950  STAGE 5  OLDFORMAT')).toBeVisible();
    await expect(page.getByRole('button', { name: 'REPLAY' })).toBeDisabled();
  });

  // The 2026-08-22 promise: a pending row and its verified self are the SAME
  // row to the viewer — same rank, same markup, nothing to notice when the
  // audit confirms it.
  test('a pending row and the same row once verified render identical DOM (rank and markup unchanged)', async ({ page }) => {
    const verified: RankingEntry[] = [
      { id: 'v1', createdAt: '2026-01-02T12:00:00Z', score: 900, stage: 3, name: 'RIVAL', xHandle: null, replayAvailable: true },
    ];
    const row = { id: 'p1', createdAt: '2026-01-04T12:00:00Z', score: 950, stage: 5, name: 'CLIMBER', xHandle: null, replayAvailable: true };
    await mockRanking(page, verified, [{ ...row, status: 'pending' }, ...verified.map((e) => ({ ...e, status: 'verified' as const }))]);
    await page.goto(APP_URL);

    await page.locator('#ranking-button').click();
    await expect(page.getByText('#1  950  STAGE 5  CLIMBER')).toBeVisible();
    const whilePending = await page.locator('#ranking-list-body').innerHTML();
    expect(whilePending).not.toContain('VERIFYING');

    // The audit confirms it: same row, same score, now verified.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await mockRanking(page, [row, ...verified]);
    await page.getByRole('button', { name: 'CLOSE' }).click();
    await page.locator('#ranking-button').click();

    await expect(page.getByText('#1  950  STAGE 5  CLIMBER')).toBeVisible(); // same rank
    const onceVerified = await page.locator('#ranking-list-body').innerHTML();
    expect(onceVerified).toBe(whilePending); // byte-for-byte the same board
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

  // Doubles as the browser half of the ANTI-GRIEFING pair (docs/plans/2026
  // -08-19-ranking-free-async spec item 15a): pending rows share the board
  // with verified ones now, so the obvious attack is to flood the DISPLAY
  // with fake pending scores and hope that locks everyone else out. It must
  // not — the offer decision reads `entries` (verified only) and never
  // `displayEntries`. Folded into this run rather than given a test of its
  // own on purpose: each gameplay test here costs ~22s of real, wall-clock
  // -timed play, and this file's load already has to stay clear of the other
  // worker's timing-sensitive suites (see this describe's own note above).
  // Its server-side twin — a real submission actually being ACCEPTED under
  // the same conditions — is functions/_lib/ranking/mergedBoardIntegration.test.ts.
  test('a real (non-tainted, non-seeded) gameover that beats a FULL board offers submission even while fake pending rows own the display board, and SUBMIT posts score/stage', async ({ page }) => {
    let scoresPostCount = 0;
    let lastPostedBody: Record<string, unknown> | undefined;
    // Absurd scores, so the run being played loses to every one of them on
    // the DISPLAY board while still strictly beating the verified 10th place.
    const fakePending: DisplayRankingEntry[] = Array.from({ length: 3 }, (_, i) => ({
      id: `fake${i}`,
      createdAt: '2026-01-01T12:00:00Z',
      score: 999_000 - i,
      stage: 9,
      name: `FAKE${i}`,
      xHandle: null,
      replayAvailable: false,
      status: 'pending' as const,
    }));
    // A full 10-entry board whose 10th place is exactly one point *below*
    // the achieved score: the strictly-better side of the boundary, which
    // an `entries: []` mock (see the SKIP test below) never exercises.
    await mockFullBoardRelativeToLiveScore(page, -1, fakePending);
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

    // ...and the fakes really were dominating the board the player saw, so
    // the "form still opened" half above is not a vacuous pass.
    await page.keyboard.press('Space'); // dismiss GAME OVER back to Title
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('title');
    await page.locator('#ranking-button').click();
    await expect(page.getByText('#1  999000  STAGE 9  FAKE0')).toBeVisible();
    await expect(page.getByText('#3  998998  STAGE 9  FAKE2')).toBeVisible();
  });

  // Reported from a real device (2026-08-20) as "checking USE X HANDLE
  // INSTEAD erases the name I typed". The two inputs are separate elements
  // and always did keep their own values — the toggle only swaps which one is
  // visible — but a filled NAME box being replaced by an empty @handle box in
  // the same spot is indistinguishable from the text being wiped, so the form
  // now states the kept value outright. Pinned here so the retention itself
  // can never regress into the thing it was mistaken for.
  test('NAME and X HANDLE keep their own values across the toggle, and the form says so', async ({ page }) => {
    await mockRanking(page, []);
    await page.route('**/api/scores', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

    await stubDeterministicNormalSeed(page);
    await page.goto(APP_URL);
    await reachGameoverDeterministically(page);
    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeVisible();

    const nameInput = page.getByPlaceholder('NAME');
    const handleInput = page.getByPlaceholder('@handle');
    const handleCheckbox = page.getByRole('checkbox', { name: 'USE X HANDLE INSTEAD' });

    await nameInput.fill('SHIMABU');

    // ON: the handle field takes over ALREADY CARRYING the name — it is
    // almost always the same word, and an empty box here read as "my typing
    // was wiped". Nothing to note as "kept" while both sides say the same
    // thing.
    await handleCheckbox.check();
    await expect(handleInput).toBeVisible();
    await expect(handleInput).toHaveValue('SHIMABU');
    await expect(page.locator('#ranking-submit-hint')).toBeHidden();

    // Editing it makes the two sides differ, which is exactly when the kept
    // name is worth stating.
    await handleInput.fill('e2e_handle');
    await expect(page.getByText('NAME KEPT: SHIMABU')).toBeVisible();

    // OFF: the typed name is still there, untouched, and now the handle is
    // the one being kept.
    await handleCheckbox.uncheck();
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('SHIMABU');
    await expect(page.getByText('X HANDLE KEPT: e2e_handle')).toBeVisible();

    // ON again: an edited handle is NEVER overwritten by a later toggle — the
    // carry-over only ever seeds an empty field.
    await handleCheckbox.check();
    await expect(handleInput).toHaveValue('e2e_handle');
    await expect(page.getByText('NAME KEPT: SHIMABU')).toBeVisible();

    // Emptying the handle re-arms the carry-over: it is "seed the empty box",
    // not "seed it once ever".
    await handleInput.fill('');
    await handleCheckbox.uncheck();
    await handleCheckbox.check();
    await expect(handleInput).toHaveValue('SHIMABU');

    // A name that is not a legal X handle is carried over verbatim — no
    // silent transliteration or truncation — for the player to see and for
    // submit-time validation to judge. (Each fill() happens while its own
    // field is the visible one; the hidden side cannot be typed into.)
    await handleInput.fill('');
    await handleCheckbox.uncheck();
    await nameInput.fill('しまぶ 太郎');
    await handleCheckbox.check();
    await expect(handleInput).toHaveValue('しまぶ 太郎');

    // The hint echoes raw user input — assert it lands as inert text, never
    // as markup.
    await handleInput.fill('plainhandle');
    await handleCheckbox.uncheck();
    await nameInput.fill('<b>BOLD</b>');
    await handleCheckbox.check();
    await expect(page.getByText('NAME KEPT: <b>BOLD</b>')).toBeVisible();
    expect(await page.locator('#ranking-submit-hint').innerHTML()).not.toContain('<b>');
  });

  // A Japanese name is an ordinary case for this game's players, and the
  // carry-over above can now push one into the X-handle field — where it is
  // NOT valid. Both halves are pinned here: the name reaches the POST
  // verbatim, and a Japanese handle is refused with a message that says so
  // rather than being silently mangled. (That the SERVER is what refuses it
  // is covered by functions/_lib/ranking/scoresEndpoint.test.ts, against the
  // real handler; this asserts the form's half of the exchange.)
  test('submits a Japanese name verbatim, and surfaces the rejection when one is carried into the handle field', async ({ page }) => {
    const JP_NAME = 'しまぶ 太郎';
    const HANDLE_ERROR = 'x_handle must match ^[A-Za-z0-9_]{1,15}$ (after removing a leading @)';
    const postedBodies: Record<string, unknown>[] = [];
    await mockFullBoardRelativeToLiveScore(page, -1);
    await page.route('**/api/scores', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const posted = route.request().postDataJSON() as Record<string, unknown>;
      postedBodies.push(posted);
      // Mirrors the real handler: a non-ASCII handle is a 400 with the
      // pattern in the message; a name-only submission is accepted.
      if (posted.xHandle) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: HANDLE_ERROR }) });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accepted: true, status: 'pending', message: 'provisionally accepted — pending verification' }),
      });
    });

    await stubDeterministicNormalSeed(page);
    await page.goto(APP_URL);
    await reachGameoverDeterministically(page);
    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeVisible();

    const nameInput = page.getByPlaceholder('NAME');
    const handleInput = page.getByPlaceholder('@handle');
    const handleCheckbox = page.getByRole('checkbox', { name: 'USE X HANDLE INSTEAD' });

    await nameInput.fill(JP_NAME);

    // Carried into the handle field unchanged — no transliteration, no
    // stripping — and submitting it is refused, in as many words.
    await handleCheckbox.check();
    await expect(handleInput).toHaveValue(JP_NAME);
    await page.getByRole('button', { name: 'SUBMIT' }).click();
    await expect(page.getByText(`NOT ACCEPTED (${HANDLE_ERROR}).`)).toBeVisible();
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0].xHandle).toBe(JP_NAME); // sent as typed, for the server to judge
    // Rejected INPUT is fixable, so the form stays open and submittable —
    // this used to read "SUBMIT FAILED — YOU CAN TRY AGAIN" with the reason
    // discarded, which is the one message that helps nobody here.
    await expect(page.getByText('SUBMIT FAILED — YOU CAN TRY AGAIN.')).toBeHidden();
    await expect(page.getByRole('button', { name: 'SUBMIT' })).toBeEnabled();

    // Switching back submits it as a NAME, where it is perfectly valid — and
    // the name survived the whole round trip.
    await handleCheckbox.uncheck();
    await expect(nameInput).toHaveValue(JP_NAME);
    await page.getByRole('button', { name: 'SUBMIT' }).click();
    await expect(page.getByText('SUBMITTED — PENDING VERIFICATION.')).toBeVisible();
    expect(postedBodies).toHaveLength(2);
    expect(postedBodies[1].name).toBe(JP_NAME);
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

  // docs/plans/2026-08-22-pending-self-replace spec item 3, and the whole
  // reason the feature exists. Before this round, a 429 HID the SUBMIT
  // button: the player's best run of the session was destroyed by a queue
  // that drains in minutes. Now the button stays, and a retry can do better
  // than merely wait — the browser-ownership token in the body lets the
  // server swap this same browser's weakest pending row for the better score.
  //
  // Both halves of the token's persistence are covered here in one run
  // because each gameover costs ~22s of real gameplay: the token survives a
  // full page reload (same value in the second run's POST), and the
  // replacement it enables works across that reload.
  test('a 429 leaves SUBMIT retryable, and the retry replaces this browser\'s own weaker pending row using a token that survived a reload', async ({ page }) => {
    test.setTimeout(180_000);

    interface FakePendingRow {
      token: string | undefined;
      score: number;
      id: string;
    }
    // A deliberately small stand-in for the server's pending queue and its
    // replacement rule (functions/api/scores.ts) — enough to drive the UI
    // through 429 -> retry -> replaced. The rule's real, atomic
    // implementation is verified against a live D1 in
    // functions/_lib/ranking/pendingSelfReplace.test.ts; what is under test
    // HERE is purely what the browser sends and how it reacts.
    const CAP = 3;
    const pending: FakePendingRow[] = [
      { token: 'someone-else-a', score: 5_000, id: 'other-a' },
      { token: 'someone-else-b', score: 5_000, id: 'other-b' },
    ];
    const tokensSeen: (string | undefined)[] = [];
    const scoresSeen: number[] = [];
    let nextId = 0;
    const replacedIds: string[] = [];

    await mockRanking(page, []); // empty verified board: every run is in range
    await page.route('**/api/scores', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON() as { submitterToken?: string; score: number };
      const token = body.submitterToken;
      tokensSeen.push(token);
      scoresSeen.push(body.score);

      const accept = (): Promise<void> => {
        const id = `mine-${++nextId}`;
        pending.push({ token, score: body.score, id });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ accepted: true, id, status: 'pending' }),
        });
      };

      if (pending.length < CAP) return accept();

      // Self-replacement: strictly-weaker rows owned by THIS token only.
      const mine = token === undefined ? [] : pending.filter((row) => row.token === token && row.score < body.score);
      if (mine.length === 0) {
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ accepted: false, error: 'pending submission limit reached, try again later' }),
        });
      }
      const victim = mine.sort((a, b) => a.score - b.score)[0];
      pending.splice(pending.indexOf(victim), 1);
      replacedIds.push(victim.id);
      return accept();
    });

    await stubDeterministicNormalSeed(page);
    await page.goto(APP_URL);

    // --- Run 1: an ordinary accepted submission, which mints the token ---
    await reachGameoverDeterministically(page);
    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeVisible();
    await page.getByPlaceholder('NAME').fill('RUN-ONE');
    await page.getByRole('button', { name: 'SUBMIT' }).click();
    await expect(page.getByText('SUBMITTED — PENDING VERIFICATION.')).toBeVisible();

    const firstToken = tokensSeen[0];
    expect(firstToken).toMatch(/^[0-9a-f]{32}$/); // 16 crypto-random bytes, lowercase hex
    const storedToken = await page.evaluate(() => localStorage.getItem('qixxx:ranking:submitterToken'));
    expect(storedToken).toBe(firstToken);
    expect(pending).toHaveLength(CAP); // the queue is now full

    // --- Reload: a brand-new page, and the token must come back with it ---
    await page.reload();
    expect(await page.evaluate(() => localStorage.getItem('qixxx:ranking:submitterToken'))).toBe(firstToken);

    // --- Run 2, attempt 1: my pending row outscores this run, so nothing is
    // replaceable and the server says 429. The old build hid SUBMIT here. ---
    const myRow = pending.find((row) => row.token === firstToken)!;
    myRow.score = 10_000_000;

    await reachGameoverDeterministically(page);
    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeVisible();
    const submitButton = page.getByRole('button', { name: 'SUBMIT' });
    await page.getByPlaceholder('NAME').fill('RUN-TWO');
    await submitButton.click();

    await expect(page.getByText('VERIFICATION QUEUE IS FULL RIGHT NOW — WAIT A MOMENT, THEN SUBMIT AGAIN.')).toBeVisible();
    await expect(submitButton).toBeVisible(); // NOT hidden — this is the whole point
    await expect(submitButton).toBeEnabled();
    await expect(page.getByRole('button', { name: 'SKIP' })).toBeVisible(); // still "SKIP", not the terminal "OK"
    expect(tokensSeen).toHaveLength(2);
    expect(tokensSeen[1]).toBe(firstToken); // the same browser, across the reload

    // --- Run 2, attempt 2: once my own pending row is the weaker one, the
    // very same SUBMIT button replaces it. ---
    //
    // Pinned RELATIVE to what this run actually scored rather than to a
    // literal: reachGameoverDeterministically() dies to the Igniter while
    // standing still on a line, which claims nothing, so the run's score is
    // routinely 0 and any hard-coded "weaker" value would be a coin flip.
    myRow.score = scoresSeen[1] - 1;
    await submitButton.click();
    await expect(page.getByText('SUBMITTED — PENDING VERIFICATION.')).toBeVisible();

    expect(tokensSeen).toEqual([firstToken, firstToken, firstToken]);
    expect(replacedIds).toEqual([myRow.id]); // MY row, and only mine
    expect(pending).toHaveLength(CAP); // a replacement, never an extra slot
    expect(pending.map((row) => row.id)).toEqual(expect.arrayContaining(['other-a', 'other-b'])); // the other browsers' rows untouched
  });

  test('a rate-limit 429 without accepted uses distinct copy and leaves SUBMIT retryable', async ({ page }) => {
    test.setTimeout(120_000);
    let posted = false;
    await mockRanking(page, []);
    await page.route('**/api/scores', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posted = true;
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'Retry-After': '1800' },
        body: JSON.stringify({ error: 'rate limit exceeded' }),
      });
    });

    await stubDeterministicNormalSeed(page);
    await page.goto(APP_URL);
    await reachGameoverDeterministically(page);
    await page.getByPlaceholder('NAME').fill('RATE-LIMITED');
    const submitButton = page.getByRole('button', { name: 'SUBMIT' });
    await submitButton.click();

    expect(posted).toBe(true);
    await expect(page.getByText('TOO MANY SUBMISSIONS THIS HOUR — WAIT FOR THE RATE LIMIT TO RESET, THEN SUBMIT AGAIN.')).toBeVisible();
    await expect(submitButton).toBeVisible();
    await expect(submitButton).toBeEnabled();
    await expect(page.getByRole('button', { name: 'SKIP' })).toBeVisible();
  });

  // The private-browsing / storage-blocked path (spec item 1's fallback):
  // submitting must keep working exactly as it always did, just without the
  // self-replacement upgrade. A build that threw — or that sent a
  // placeholder the server would 400 — would lock these players out of the
  // ranking entirely.
  test('a browser with no usable localStorage submits with no token at all, and the submission still works', async ({ page }) => {
    let postedBody: Record<string, unknown> | undefined;
    await mockRanking(page, []);
    await page.route('**/api/scores', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      postedBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: true, status: 'pending' }) });
    });

    // Throwing on the PROPERTY ACCESS itself, which is what a
    // storage-blocked embedding actually does — a mere `delete
    // window.localStorage` would not exercise the try/catch that matters.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('SecurityError: storage is disabled');
        },
      });
    });
    await stubDeterministicNormalSeed(page);
    await page.goto(APP_URL);
    await reachGameoverDeterministically(page);

    await expect(page.getByText('YOU MADE THE TOP 10!')).toBeVisible();
    await page.getByPlaceholder('NAME').fill('NO-STORAGE');
    await page.getByRole('button', { name: 'SUBMIT' }).click();
    await expect(page.getByText('SUBMITTED — PENDING VERIFICATION.')).toBeVisible();

    // The key is ABSENT, not null/empty — the server distinguishes "no token"
    // (fine, old client) from "a malformed token" (400).
    expect(postedBody).toBeDefined();
    expect('submitterToken' in postedBody!).toBe(false);
    expect(postedBody!.score).toEqual(expect.any(Number));
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
    // ...and the skip control, having nowhere left to go, is gone (hidden,
    // not disabled — user feedback, 2026-08-20). It is also proof the chunked
    // skip actually finished: a still-running skip shows SKIPPING... instead.
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'SKIPPING...' })).toBeHidden();

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
    await expect(page.getByRole('button', { name: 'SKIPPING...' })).toBeHidden({ timeout: 20_000 });

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

  // User feedback (2026-08-20): on a run that ended on the stage being
  // played, SKIP TO FINAL STAGE does nothing — so it is hidden rather than
  // disabled, leaving no dead control to puzzle over. The predicate runs once
  // per rendered frame (RankingUI.syncReplayStatus()), so it covers the
  // single-stage case below, the post-skip case asserted in the tests above,
  // and equally an ordinary playback crossing into the final stage (the same
  // check, on the same frame cadence — not asserted separately here only
  // because reaching stage 4 by watching would take ~36s of real playback).
  test('a single-stage run never offers SKIP TO FINAL STAGE at all', async ({ page }) => {
    const rleBase64 = recordShortReplay(2026, 4); // one stage, start to finish
    await mockRanking(page, [
      { id: 'onestage', createdAt: '2026-01-01T00:00:00Z', score: 7, stage: 1, name: 'ONESTAGE', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: 2026, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
      });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();

    // The bar is up (so this is not just "the replay never started")...
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeVisible();
    await expect(page.getByText('STAGE 1 / 1')).toBeVisible();
    // ...and the skip control is absent from the first frame, never flashed.
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeHidden();
    await page.waitForTimeout(600);
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeHidden();
  });

  // docs/plans/2026-08-19-ranking-free-async spec item 7 (a fresh pending
  // row IS replayable) as amended 2026-08-22: it plays exactly like a
  // verified row's replay — no notice on the board, none in the status line.
  test('replaying a pending row plays exactly like a verified one, with no VERIFYING notice anywhere', async ({ page }) => {
    const rleBase64 = recordShortReplay(2026, 4);
    await mockRanking(page, [], [
      { id: 'pend', createdAt: '2026-01-01T00:00:00Z', score: 7, stage: 1, name: 'UNAUDITED', xHandle: null, replayAvailable: true, status: 'pending' },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: 2026, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION, status: 'pending' }),
      });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();

    await expect(page.locator('#replay-stage-label')).toContainText('STAGE 1 / 1');
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeVisible();
    await expect(page.getByText(/VERIFYING/)).toHaveCount(0);
    await page.waitForTimeout(800); // ...and still none once playback has ended
    await expect(page.getByText(/VERIFYING/)).toHaveCount(0);
    await page.getByRole('button', { name: 'EXIT' }).click();
  });

  test('the longest status wording stays on ONE line, and the end overlay puts SCORE and STAGE on their own lines', async ({ page }) => {
    // The regression reported on 2026-08-22: the status line wrapped into a
    // ragged 2-3 lines, and the overlay's "SCORE n  STAGE 4 / 4 (FINAL
    // STAGE)" broke at an arbitrary word. Longest wording = multi-stage
    // fixture, played to its gameover (as a pending row, which must make no
    // difference to what is drawn).
    const rleBase64 = recordMultiStageReplay(MULTI_STAGE_SEED);
    await mockRanking(page, [], [
      { id: 'ender', createdAt: '2026-01-01T00:00:00Z', score: 7, stage: MULTI_STAGE_FINAL_STAGE, name: 'ENDER', xHandle: null, replayAvailable: true, status: 'pending' },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: MULTI_STAGE_SEED, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION, status: 'pending' }),
      });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();
    await page.getByRole('button', { name: 'SKIP TO FINAL STAGE' }).click();
    await expect(page.getByRole('button', { name: 'SKIPPING...' })).toBeHidden({ timeout: 20_000 });

    const label = page.locator('#replay-stage-label');
    await expect(label).toHaveText(`REPLAY END - STAGE ${MULTI_STAGE_FINAL_STAGE} / ${MULTI_STAGE_FINAL_STAGE} (GAME OVER HERE)`, { timeout: 20_000 });

    // One line: the rendered height is a single line-height, never two.
    const { height, lineHeight } = await label.evaluate((el) => {
      const style = getComputedStyle(el);
      const lh = style.lineHeight === 'normal' ? parseFloat(style.fontSize) * 1.3 : parseFloat(style.lineHeight);
      return { height: el.getBoundingClientRect().height, lineHeight: lh };
    });
    expect(height).toBeLessThan(lineHeight * 1.6);

    // The overlay's SCORE and STAGE are separate lines by construction.
    const screenText = await page.locator('#screen').innerText();
    const lines = screenText.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines.some((l) => /^SCORE \d+$/.test(l))).toBe(true);
    expect(lines.some((l) => l === `STAGE ${MULTI_STAGE_FINAL_STAGE} / ${MULTI_STAGE_FINAL_STAGE} (FINAL STAGE)`)).toBe(true);
  });

  test('replaying a verified row shows no VERIFYING notice anywhere', async ({ page }) => {
    const rleBase64 = recordShortReplay(2026, 4);
    await mockRanking(page, [{ id: 'ok', createdAt: '2026-01-01T00:00:00Z', score: 7, stage: 1, name: 'AUDITED', xHandle: null, replayAvailable: true }]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: 2026, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION, status: 'verified' }),
      });
    });

    await page.goto(APP_URL);
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();

    await expect(page.getByText('STAGE 1 / 1')).toBeVisible();
    await expect(page.getByText(/VERIFYING/)).toHaveCount(0);
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
    // The SKIPPING... state clears once the chunked skip completes — if the
    // skip blocked the main thread, the intermediate state could never render
    // at all. The idle button does not come back: the final stage is playing
    // now, so there is nothing left to skip to.
    await expect(page.getByRole('button', { name: 'SKIPPING...' })).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'SKIP TO FINAL STAGE' })).toBeHidden();
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
