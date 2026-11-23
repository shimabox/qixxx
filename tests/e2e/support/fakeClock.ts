// Shared helper for the specs that drive the game on a faked page clock
// (`page.clock.install()` + `pauseAt()`), where the game only advances through
// `page.clock.runFor()`.
import type { Page } from '@playwright/test';

// Advances the page's (faked) clock in `stepMs` slices until `predicate`
// holds, giving up after `maxMs` of *game* time. Under `page.clock.install()`
// requestAnimationFrame only fires while the clock is advanced, so the game
// loop (main.ts's fixed-timestep accumulator) runs exactly as many ticks as
// the advanced time dictates — independent of how fast the machine running
// the test happens to be. Budgets are therefore game-time budgets, not
// wall-clock timeouts.
export async function advanceUntil(
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

/**
 * Runs the faked clock on through the GAME OVER result (src/gameOverResult.ts):
 * the score's count-up, then the highlight and the best line after it — about
 * 54 ticks from the modal appearing; 1.2s of game time covers it. A ranking
 * submission panel opens later (advanceToSubmissionPanel()).
 */
export async function finishGameOverResult(page: Page): Promise<void> {
  await page.clock.runFor(1_200);
}

/** The GAME OVER result's timing as window.__game__.getGameOverResult() reads it (src/gameOverResult.ts). */
export interface GameOverTiming {
  active: boolean;
  /** Live ticks since the modal appeared — not the session's ticks, which stand still on GAME OVER. */
  age: number;
  /** The age the last line (the best line) is due at. */
  lastLineAge: number;
  /** The age from which the ranking submission panel may open. */
  offerAge: number;
}

export function gameOverTiming(page: Page): Promise<GameOverTiming> {
  return page.evaluate(() => {
    const r = (window as unknown as { __game__: { getGameOverResult: () => GameOverTiming } }).__game__.getGameOverResult();
    return { active: r.active, age: r.age, lastLineAge: r.lastLineAge, offerAge: r.offerAge };
  });
}

/** The GAME OVER ranking offer as window.__game__.getRankingOffer() reads it (src/ui/ranking.ts). */
export interface RankingOfferState {
  /** GET /api/ranking for the run is in flight. */
  checkPending: boolean;
  /** Its reply decided to open the submission panel, which waits for its time. */
  waiting: boolean;
  /** A submission panel is open. */
  panelShown: boolean;
}

export function rankingOffer(page: Page): Promise<RankingOfferState> {
  return page.evaluate(() =>
    (window as unknown as { __game__: { getRankingOffer: () => RankingOfferState } }).__game__.getRankingOffer()
  );
}

/**
 * Runs the clock a frame (`stepMs`, shorter than a tick) at a time until the
 * GAME OVER result has gone exactly one tick on: each frame then runs at most
 * one tick, so every rendered frame is seen.
 */
export async function runOneGameOverTick(page: Page, stepMs = 16): Promise<number> {
  const before = (await gameOverTiming(page)).age;
  await advanceUntil(page, async () => (await gameOverTiming(page)).age > before, 10 * stepMs, stepMs);
  const after = (await gameOverTiming(page)).age;
  if (after !== before + 1) throw new Error(`runOneGameOverTick: went from ${before} to ${after}`);
  return after;
}

/**
 * Runs the faked clock until the ranking submission panel is open. It opens
 * RANKING_OFFER_DELAY_TICKS (90) after the GAME OVER result's last line is
 * due — about 2.4s of game time from the modal for a counted score, plus the
 * last miss's hold before the modal — or as soon as a later reply lands.
 * A game-time budget.
 */
export async function advanceToSubmissionPanel(page: Page, maxMs = 5_000, stepMs = 16): Promise<void> {
  await advanceUntil(page, () => page.locator('#ranking-submit-panel').isVisible(), maxMs, stepMs);
}

/**
 * Runs the faked clock on to where a submission panel would have opened had
 * the run been offered one (the result's offerAge), and a little past it.
 * Only once the modal is up.
 */
export async function advancePastOfferTime(page: Page, stepMs = 16): Promise<void> {
  await advanceUntil(page, async () => {
    const timing = await gameOverTiming(page);
    return timing.active && timing.age >= timing.offerAge + 10;
  }, 5_000, stepMs);
}

interface IgniterProbe {
  status: string;
  drawing: boolean;
  grace: number;
}

/**
 * Ends a live run on a real 'life' GAME OVER, on the faked clock and with no
 * debug override (the run stays untainted and may be posted): cut a short
 * stub of line into the field, let go, and stand still on it until the
 * Igniter (src/core/fuse.ts) burns along it — three times. The Igniter is
 * deterministic (it spawns a fixed number of ticks after the marker stops),
 * so this needs neither enemy luck nor steering; standing on a line claims
 * nothing, so it never ends on STAGE CLEAR. ~1300 ticks (~22s of game time).
 *
 * Re-pulses whenever the marker is idle and out of its post-miss grace (a
 * draw pulse in grace cannot enter the field), which also self-heals a
 * swallowed pulse. `drawKey` is the key held to draw.
 */
export async function loseAllLivesToIgniter(page: Page, maxMs = 60_000, drawKey = 'KeyX'): Promise<void> {
  const probe = () =>
    page.evaluate((): IgniterProbe => {
      const session = (window as unknown as {
        __game__: {
          session: {
            getStatus: () => string;
            getGame: () => { getMarker: () => { isDrawing: () => boolean }; getGraceTicks: () => number };
          };
        };
      }).__game__.session;
      const game = session.getGame();
      return { status: session.getStatus(), drawing: game.getMarker().isDrawing(), grace: game.getGraceTicks() };
    });
  for (let elapsed = 0; elapsed < maxMs; elapsed += 300) {
    const state = await probe();
    if (state.status === 'gameover') return;
    if (state.status === 'playing' && !state.drawing && state.grace === 0) {
      await page.keyboard.down(drawKey);
      await page.keyboard.down('ArrowDown');
      await page.clock.runFor(200);
      await page.keyboard.up('ArrowDown');
      await page.keyboard.up(drawKey);
      elapsed += 200;
    }
    await page.clock.runFor(300);
  }
  const state = await probe();
  if (state.status === 'gameover') return;
  throw new Error(`loseAllLivesToIgniter: no GAME OVER within ${maxMs}ms of game time (status "${state.status}")`);
}
