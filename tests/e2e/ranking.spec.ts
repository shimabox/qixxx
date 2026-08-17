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

/**
 * Steers the marker directly at the live Wisp position while holding the
 * fast-draw key, repeatedly, until 3 lives are lost (real gameplay, not a
 * fixed script — normal mode's board is randomly seeded per run so there is
 * no fixed path to script, unlike smoke.spec.ts's `?seed=1` scenario, which
 * would also be wrong here since seeded runs are excluded from the ranking
 * flow entirely). Verified empirically against the real app: each life-loss
 * typically takes 1-3s of held pursuit.
 */
async function chaseIntoWisp(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.keyboard.down('KeyX'); // fast draw, held for the whole chase
  let heldX: 'ArrowLeft' | 'ArrowRight' | null = null;
  let heldY: 'ArrowUp' | 'ArrowDown' | null = null;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const status = await page.evaluate(() => window.__game__!.session.getStatus());
    if (status !== 'playing') break;
    const state = await page.evaluate(() => {
      const s = window.__game__!.session;
      const wisps = s.getGame().getWisps();
      return { marker: s.getGame().getMarker().getPosition(), wisp: wisps[0]?.getPosition() ?? null };
    });
    if (!state.wisp) {
      await page.waitForTimeout(50);
      continue;
    }
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
    // 80ms (not tighter): keeps this loop's own evaluate()/IPC overhead
    // low so it doesn't itself add to CPU contention against other
    // parallel workers (a real gameplay-timing test in another file,
    // tests/e2e/gameover-share.spec.ts, was observed to occasionally miss
    // its own timing budget under 4-way parallel load with a tighter
    // poll here) — still far more responsive than the Wisp's own movement
    // speed needs.
    await page.waitForTimeout(80);
  }
  if (heldX) await page.keyboard.up(heldX);
  if (heldY) await page.keyboard.up(heldY);
  await page.keyboard.up('KeyX');
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
  test.setTimeout(150_000);

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

    await page.goto(APP_URL); // no ?seed= — normal mode is required for POST-eligibility
    await page.keyboard.press('Space'); // Title -> Playing
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');

    await chaseIntoWisp(page);
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus()), { timeout: 60_000 }).toBe('gameover');

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

    await page.goto(APP_URL);
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');

    await chaseIntoWisp(page);
    await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus()), { timeout: 60_000 }).toBe('gameover');
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
