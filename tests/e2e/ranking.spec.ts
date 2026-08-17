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
        getTotalTicks: () => number;
        getGame: () => {
          getMarker: () => { getPosition: () => { x: number; y: number } };
          getWisps: () => { getPosition: () => { x: number; y: number } }[];
        };
      };
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

async function mockRanking(page: Page, entries: RankingEntry[]): Promise<void> {
  await page.route('**/api/ranking', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries }),
    });
  });
}

// Fixes normal mode's internal per-run seed (src/main.ts's
// generateNormalRunSeed()) WITHOUT using `?seed=` — a `?seed=` run is
// runMode: 'seeded' and is structurally excluded from the whole ranking
// submission flow (src/ui/ranking.ts's isEligible()), so it can't be used to
// stabilize these tests. generateNormalRunSeed() sources its seed from
// `crypto.getRandomValues(new Uint32Array(1))`; stubbing that (only for
// length-1 Uint32Array calls, so anything else that might call
// getRandomValues for an unrelated reason is left untouched) makes the
// board and Wisp behavior deterministic while runMode stays 'normal' (POST-
// eligibility is preserved).
//
// SEED_VALUE = 1264, chosen by headless simulation (no browser needed) of
// this exact file's chaseIntoWisp() pursuit logic directly against
// GameSession, scanning seeds 1-5000 for ones that reach a 'life' gameover
// without ever passing through 'stageclear' (the flake this fixes: a prior
// randomly-seeded run's chase path happened to trace a shape that claimed
// ~98% occupancy and cleared stage 1 before ever touching the Wisp) — see
// this test's own git history for the exploration script. 1264 was then
// cross-validated by re-running the same headless simulation at every
// direction-re-evaluation cadence from 3 to 8 ticks (chaseIntoWisp() below
// re-reads the Wisp's position roughly every 80ms of real time, i.e. every
// ~4-5 ticks at 60 ticks/s, but real wall-clock polling can jitter a tick or
// two either way) — seed 1264 reaches a 'life' gameover (never 'stageclear')
// at every one of those cadences, within a tight 2021-2030 tick band
// (~33.7-33.8s of real time at 60 ticks/s), making it robust to that jitter
// rather than a knife-edge result specific to one exact cadence.
const SEED_VALUE = 1264;

// A *second*, independent flake (found while stabilizing the first): ANY
// fresh keydown (not just Space/Enter) sets src/input/keyboard.ts's
// edge-triggered "any key" confirm pulse — harmless mid-'playing', but if a
// chase-driven direction-change keydown happens to land on the exact tick
// gameover is reached, that queued confirm gets consumed on the very next
// tick and immediately bounces GameOver -> Title, before this test ever
// observes the transient 'gameover' status (`status` reads back 'title',
// not 'gameover' — a real, reproduced failure, not hypothetical). Fixed by
// freezing the chase's held direction (no more keyboard.down() calls, only
// the passive keyboard.up() cleanup at the very end) once the live session
// crosses FREEZE_TOTAL_TICKS — re-verified by headless simulation
// (session.getTotalTicks() polled, not wall-clock time, so this is exact
// regardless of frame-rate jitter) that seed 1264 still reaches a 'life'
// gameover with no 'stageclear' when frozen this early, across cadences
// 3-8: observed death at ticks 2021-2030 — 1300 is close to the earliest
// tick that still reliably reaches the Wisp at all (freezing any earlier,
// e.g. 1000, times out: the marker hasn't closed the distance yet), so
// 1600 is used here for extra margin (~7s) rather than that bare minimum.
// Even this large a margin was NOT sufficient on its own under real
// full-suite CPU contention (a `read totalTicks, then decide, then
// dispatch a keydown` round trip can itself be delayed well past when the
// tick count was last observed, under enough scheduling pressure) — see
// reachGameoverDeterministically()'s retry wrapper below for the
// belt-and-suspenders fix that actually closed this out.
const FREEZE_TOTAL_TICKS = 1600;

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
 * Steers the marker directly at the live Wisp position while holding the
 * fast-draw key, repeatedly, until 3 lives are lost (real gameplay, driven
 * against the fixed board stubDeterministicNormalSeed() sets up — not a
 * hardcoded fixed input script, so this loop still tolerates normal
 * wall-clock/frame-rate jitter, just no longer a different board every
 * run). Verified (headless simulation, see SEED_VALUE's comment) to reach
 * a 'life' gameover in ~2021-2030 ticks (~34s) for this seed.
 */
async function chaseIntoWisp(page: Page, timeoutMs = 90_000): Promise<void> {
  await page.keyboard.down('KeyX'); // fast draw, held for the whole chase
  let heldX: 'ArrowLeft' | 'ArrowRight' | null = null;
  let heldY: 'ArrowUp' | 'ArrowDown' | null = null;
  let frozen = false;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const status = await page.evaluate(() => window.__game__!.session.getStatus());
    if (status !== 'playing') break;

    if (!frozen) {
      const totalTicks = await page.evaluate(() => window.__game__!.session.getTotalTicks());
      if (totalTicks >= FREEZE_TOTAL_TICKS) {
        // Stop issuing any further keydown (see FREEZE_TOTAL_TICKS's
        // comment) — hold whatever direction is already locked in and
        // just wait for gameover from here on, sending no more input at
        // all (not even keyup, which would be safe but is simply
        // unnecessary — the direction is already correct).
        frozen = true;
      } else {
        const state = await page.evaluate(() => {
          const s = window.__game__!.session;
          const wisps = s.getGame().getWisps();
          return { marker: s.getGame().getMarker().getPosition(), wisp: wisps[0]?.getPosition() ?? null };
        });
        if (state.wisp) {
          const wantX = state.wisp.x > state.marker.x ? 'ArrowRight' : state.wisp.x < state.marker.x ? 'ArrowLeft' : null;
          const wantY = state.wisp.y > state.marker.y ? 'ArrowDown' : state.wisp.y < state.marker.y ? 'ArrowUp' : null;
          if (wantX !== heldX) {
            if (heldX) await page.keyboard.up(heldX);
            if (wantX) await page.keyboard.down(wantX);
            heldX = wantX;
          }
          if (wantY !== heldY) {
            if (heldY) await page.keyboard.up(heldY);
            if (wantY) await page.keyboard.down(wantY);
            heldY = wantY;
          }
        }
      }
    }
    // 80ms (not tighter): keeps this loop's own evaluate()/IPC overhead
    // low so it doesn't itself add to CPU contention against other
    // parallel workers — still far more responsive than the Wisp's own
    // movement speed needs, and irrelevant to precision once frozen since
    // FREEZE_TOTAL_TICKS is read from the live session, not wall time.
    await page.waitForTimeout(80);
  }
  if (heldX) await page.keyboard.up(heldX);
  if (heldY) await page.keyboard.up(heldY);
  await page.keyboard.up('KeyX');
}

/**
 * Drives a fresh run (Title -> Playing -> chaseIntoWisp) all the way to a
 * real 'life' gameover, retrying the whole thing from Title if it instead
 * lands back on 'title' (the FREEZE_TOTAL_TICKS-guarded race described
 * above, occasionally still possible under enough real scheduling delay —
 * this retry is the actual belt-and-suspenders fix, since it self-heals
 * regardless of the exact cause). SEED_VALUE is fixed for every retry
 * (stubDeterministicNormalSeed() patches the page's crypto, not a one-shot
 * value), so a retry replays the identical deterministic board/chase, just
 * hoping to avoid whatever scheduling coincidence caused the bounce.
 */
async function reachGameoverDeterministically(page: Page, attempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.keyboard.press('Space'); // Title -> Playing
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');

    await chaseIntoWisp(page);
    const status = await page.evaluate(() => window.__game__?.session.getStatus());
    if (status === 'gameover') return;
    if (attempt === attempts) {
      throw new Error(`reachGameoverDeterministically: gave up after ${attempts} attempts, last status was "${status}"`);
    }
    // Landed back on 'title' (or something else unexpected) instead of
    // 'gameover' — retry from a clean Title screen.
  }
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

test.describe('ranking display', () => {
  test('shows entries, an X-handle link, a disabled REPLAY for unavailable rows, and renders an HTML-metacharacter name as inert text', async ({ page }) => {
    const entries: RankingEntry[] = [
      { id: 'a', createdAt: '2026-01-01T00:00:00Z', score: 999, stage: 3, name: 'PLAIN', xHandle: null, replayAvailable: true },
      { id: 'b', createdAt: '2026-01-01T00:00:00Z', score: 500, stage: 2, name: 'HANDLED', xHandle: 'e2e_handle', replayAvailable: true },
      {
        id: 'c',
        createdAt: '2026-01-01T00:00:00Z',
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
});

test.describe('name-input submission flow', () => {
  // Serialized (not this file's other, network-only describes): both tests
  // here drive several seconds of real, wall-clock-timed gameplay via
  // chaseIntoWisp() — running them concurrently in separate Chromium
  // workers (playwright.config.ts's fullyParallel default) contends for
  // real CPU/frame-rate and was observed to make the chase loop miss its
  // budget under 4-way parallel load (a real flake seen once locally,
  // 59.7s timeout; the same test passed in 10.3s run alone) — not a defect
  // in the app itself.
  test.describe.configure({ mode: 'serial' });
  // Generous (not just 1-2x a single ~34s chase): reachGameoverDeterministically()
  // retries up to 3 full attempts if a run lands back on 'title' instead of
  // 'gameover' (see its own doc comment), and a single attempt's internal
  // chaseIntoWisp() budget is itself 90s.
  test.setTimeout(240_000);

  test('a real (non-tainted, non-seeded) gameover offers submission, and SUBMIT posts and shows the server-confirmed rank', async ({ page }) => {
    let scoresPostCount = 0;
    let lastPostedBody: Record<string, unknown> | undefined;
    await mockRanking(page, []); // entries: [] forces provisionalInRange = true regardless of the real achieved score
    await page.route('**/api/scores', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      scoresPostCount++;
      lastPostedBody = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accepted: true, rank: 3 }),
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
    await expect(page.getByText('RANKED #3!')).toBeVisible();
    expect(scoresPostCount).toBe(1);
    expect(lastPostedBody?.xHandle).toBe('e2e_submitter');
    expect(lastPostedBody?.rulesetVersion).toBe(RULESET_VERSION);
    expect(lastPostedBody?.replayFormatVersion).toBe(REPLAY_FORMAT_VERSION);
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
});

test.describe('replay viewing', () => {
  test('plays a mocked replay, skips to the final stage, exits, and never POSTs or touches the stored high score', async ({ page }) => {
    const rleBase64 = recordShortReplay(2026, 4);
    let scoresPostCount = 0;

    await mockRanking(page, [
      { id: 'r1', createdAt: '2026-01-01T00:00:00Z', score: 42, stage: 1, name: 'REPLAYED', xHandle: null, replayAvailable: true },
    ]);
    await page.route('**/api/ranking/*/replay', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: 2026, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
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

    await page.getByRole('button', { name: 'SKIP TO FINAL STAGE' }).click();
    await page.getByRole('button', { name: 'EXIT' }).click();
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeHidden();

    expect(scoresPostCount).toBe(0); // no persistence/POST side effects during replay viewing
    const highScoreAfter = await page.evaluate(() => localStorage.getItem('qixxx.highScore'));
    expect(highScoreAfter).toBe(highScoreBefore);
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
});
