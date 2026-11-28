// Steps that bring the game to a picture: keys held and released on the
// faked clock, read back through window.__game__ (the E2E hook). Nothing here
// changes the game's rules or settings, so a run driven this way is an
// ordinary run (its high score and ranking offer behave as for a player).
import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import { advanceUntil, FRAME_MS, probe, type Probe } from './page';

export type DrawKey = 'Space' | 'Shift';

/** Lets `ms` of game time pass. */
export async function wait(page: Page, ms: number): Promise<void> {
  await page.clock.runFor(ms);
}

/**
 * Lets the page finish work that does not wait on game time (a mocked
 * answer arriving, a replay being built in chunks) until `expression` holds,
 * without letting a single frame pass: the clock only fires what is already
 * due now.
 */
export async function settle(page: Page, expression: string, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return;
    await flushTasks(page);
  }
  throw new Error(`${what}: not ready within 20s`);
}

/**
 * Advances the faked clock one frame at a time until `expression` holds:
 * for what the page shows on game time (a panel that opens some ticks after
 * the answer it waits on has arrived).
 */
export async function advanceUntilShown(page: Page, expression: string, maxMs: number, what: string): Promise<void> {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += FRAME_MS) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return;
    await page.clock.runFor(FRAME_MS);
  }
  throw new Error(`${what}: not shown within ${maxMs}ms of game time`);
}

/** Lets the page run the tasks already queued (a network answer being read), the clock stopped. */
export async function flushTasks(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.evaluate('new Promise((resolve) => { const c = new MessageChannel(); c.port1.onmessage = () => resolve(true); c.port2.postMessage(0); })');
    await sleep(20);
  }
}

/**
 * Advances the clock 1ms at a time until `expression` holds: for work the
 * page splits over zero-delay timers (a replay built in chunks). Start it
 * only once the work's input has arrived (see settle()), so the number of
 * steps is the same every time. Returns the steps taken.
 */
export async function stepTimers(page: Page, expression: string, what: string, maxMs = 2_000): Promise<number> {
  for (let ms = 0; ms <= maxMs; ms++) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return ms;
    await page.clock.runFor(1);
  }
  throw new Error(`${what}: not done within ${maxMs}ms of game time`);
}

/** Title -> playing with a key. */
export async function startRun(page: Page): Promise<void> {
  await page.keyboard.press('Space');
  await advanceUntil(page, (p) => p.status === 'playing', 1_000, 'start a run');
  await wait(page, 100);
}

const ARROW = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' } as const;
type Dir = keyof typeof ARROW;

/** Holds an arrow (and a draw key) until `until` holds. */
async function hold(page: Page, dir: Dir, drawKey: DrawKey | null, until: (p: Probe) => boolean, what: string): Promise<Probe> {
  if (drawKey) await page.keyboard.down(drawKey);
  await page.keyboard.down(ARROW[dir]);
  try {
    return await advanceUntil(page, until, 20_000, what);
  } finally {
    await page.keyboard.up(ARROW[dir]);
    if (drawKey) await page.keyboard.up(drawKey);
  }
}

/** Walks along the border to column `x` on the edge the marker is on. */
export async function walkToX(page: Page, x: number): Promise<void> {
  const p = await probe(page);
  if (p.marker.x === x) return;
  const dir: Dir = p.marker.x > x ? 'left' : 'right';
  await hold(page, dir, null, (q) => (dir === 'left' ? q.marker.x <= x : q.marker.x >= x), `walk to x=${x}`);
}

/** Walks along the border to row `y` on the edge the marker is on. */
export async function walkToY(page: Page, y: number): Promise<void> {
  const p = await probe(page);
  if (p.marker.y === y) return;
  const dir: Dir = p.marker.y > y ? 'up' : 'down';
  await hold(page, dir, null, (q) => (dir === 'up' ? q.marker.y <= y : q.marker.y >= y), `walk to y=${y}`);
}

/** Draws in `dir` until the marker reaches `target` on that axis (or the line closes, or a miss). */
export async function drawTo(page: Page, dir: Dir, target: number, drawKey: DrawKey): Promise<Probe> {
  const before = await probe(page);
  const reached = (q: Probe): boolean => {
    if (q.lives < before.lives || q.status !== 'playing' || q.occ > before.occ) return true;
    if (dir === 'down') return q.marker.y >= target;
    if (dir === 'up') return q.marker.y <= target;
    if (dir === 'right') return q.marker.x >= target;
    return q.marker.x <= target;
  };
  return hold(page, dir, drawKey, reached, `draw ${dir} to ${target}`);
}

/** Draws in `dir` until the line closes (occupancy rises) or the run misses. */
export async function drawUntilClosed(page: Page, dir: Dir, drawKey: DrawKey): Promise<Probe> {
  const before = await probe(page);
  return hold(page, dir, drawKey, (q) => q.occ > before.occ || q.lives < before.lives || q.status !== 'playing', `close a line ${dir}`);
}

/** Moves one frame at a time until `predicate` holds, keys untouched. */
export async function waitFor(page: Page, predicate: (p: Probe) => boolean, maxMs: number, what: string): Promise<Probe> {
  return advanceUntil(page, predicate, maxMs, what);
}

/** Lets the post-miss grace run out. */
export async function waitOutGrace(page: Page): Promise<void> {
  await advanceUntil(page, (p) => p.grace === 0, 5_000, 'grace');
}

/** A full-height cut at column `x` from the edge the marker is on. */
export async function cutColumn(page: Page, x: number, drawKey: DrawKey): Promise<Probe> {
  await walkToX(page, x);
  const p = await probe(page);
  return drawUntilClosed(page, p.marker.y === 0 ? 'down' : 'up', drawKey);
}
