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
 * 54 ticks from the modal appearing; 1.2s of game time covers it.
 */
export async function finishGameOverResult(page: Page): Promise<void> {
  await page.clock.runFor(1_200);
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
