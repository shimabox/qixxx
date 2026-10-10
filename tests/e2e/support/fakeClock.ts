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
