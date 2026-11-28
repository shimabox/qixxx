// EASY (src/core/difficulty.ts): the Title screen's MODE toggle and what it
// leads to — the HUD's EASY tag and five lives, an EASY run's GAME OVER screen,
// what an EASY run is kept out of (the high score, the ranking, the play log,
// POST TO X), the debug override that no longer reaches the high score, and
// the GAME OVER screen's suggestion after a streak of early GAME OVERs.
//
// Everything runs on a faked page clock (tests/e2e/support/fakeClock.ts), so
// budgets are game time. Layouts are checked by boxes against boxes — no pixel
// constant of a font. Every test opens a fresh context, so the stored choice
// starts as NORMAL.
import { test, expect, type Browser, type Page, type Locator } from '@playwright/test';
import { GameSession } from '../../src/core/session';
import { encodeRle, type InputSample } from '../../src/core/rle';
import { getStageConfig } from '../../src/core/stage';
import type { PlayLogFile, PlayRecord } from '../../src/playLog/record';
import {
  EASY_INITIAL_LIVES,
  EASY_PROMPT_TOGGLE_GLOW_PEAK_BLUR_PX,
  EASY_PROMPT_TOGGLE_GLOW_REST_BLUR_PX,
  EASY_PROMPT_TOGGLE_PULSE_COUNT,
  EASY_PROMPT_TOGGLE_PULSE_SEC,
  EASY_WISP_SPEED_FACTOR,
  GRID_WIDTH,
  INITIAL_LIVES,
  RULESET_VERSION,
  REPLAY_FORMAT_VERSION,
  TITLE_MENU_GAP_PX,
} from '../../src/config';
import { validateSharePayload } from '../../functions/_lib/validation';
import {
  advancePastOfferTime,
  advanceToSubmissionPanel,
  advanceUntil,
  finishGameOverResult,
  loseAllLivesToIgniter,
  rankingOffer,
} from './support/fakeClock';

interface Point {
  x: number;
  y: number;
}

type Hook = {
  session: {
    getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
    getStage: () => number;
    getScore: () => number;
    getLives: () => number;
    getHighScore: () => number;
    getDifficulty: () => 'normal' | 'easy';
    getStageTicks: () => number;
    getTotalTicks: () => number;
    getSeed: () => number | undefined;
    isRunTainted: () => boolean;
    getMarkerStart: () => { edge: string; point: Point } | null;
    setDebugTimeLimitTicks: (ticks: number) => void;
    applyDebugOverrides: (overrides: { requiredOccupancy?: number; wispSpeedMultiplier?: number }) => void;
    update: (input: { dx: number; dy: number; drawHeld: boolean; slow?: boolean; confirm: boolean }) => void;
    getGame: () => {
      getMarker: () => { getPosition: () => Point };
      getWisps: () => Array<{ getSpeedMultiplier: () => number; getPosition: () => Point }>;
    };
  };
  fx: { tick: () => void; onStageStart: (heading: string, title: string) => void };
  getStartCue: () => unknown;
  getConfirmCount: () => number;
  getPlayLog: () => PlayRecord[];
  getTitleDemo: () => { state: string; shown: boolean };
  getGameOverResult: () => { active: boolean; highlight: string | null; prompt: boolean; best: string | null };
};

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const TICK_MS = 1000 / 60;
const GUARD_TICKS = 24; // RETRY_CONFIRM_GUARD_TICKS
const LOG_KEY = 'qixxx.playLog';
const DIFFICULTY_KEY = 'qixxx.difficulty';
const HIGH_SCORE_KEY = 'qixxx.highScore';
const PROMPT_EN = 'TRY EASY MODE ON TITLE';
const PROMPT_JA = 'タイトルで EASY を選べます';

const hook = (page: Page) => page.evaluate(() => Boolean((window as unknown as { __game__?: Hook }).__game__));
const g = <T>(page: Page, fn: (h: Hook) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__game__)`) as Promise<T>;
const status = (page: Page) => g(page, (h) => h.session.getStatus());
const marker = (page: Page) => g(page, (h) => h.session.getGame().getMarker().getPosition());
const score = (page: Page) => g(page, (h) => h.session.getScore());
const toggle = (page: Page) => page.locator('#difficulty-button');
const storedHighScore = (page: Page) => page.evaluate((key) => localStorage.getItem(key), HIGH_SCORE_KEY);

/** Pins the normal run's seed (main.ts draws it from crypto.getRandomValues) without making it a `?seed=` run. */
async function pinNormalSeed(page: Page, seed: number): Promise<void> {
  await page.addInitScript((value: number) => {
    const real = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = ((array: ArrayBufferView | null) => {
      if (array instanceof Uint32Array && array.length === 1) {
        array[0] = value;
        return array;
      }
      return real(array as never);
    }) as Crypto['getRandomValues'];
  }, seed);
}

/** Stores `value` under `key` once, before the page's own scripts first run (a reload keeps what the page wrote). */
async function preset(page: Page, key: string, value: string): Promise<void> {
  await page.addInitScript(
    ([k, v]) => {
      if (sessionStorage.getItem(`preset:${k}`) === null) {
        localStorage.setItem(k, v);
        sessionStorage.setItem(`preset:${k}`, '1');
      }
    },
    [key, value] as const
  );
}

/** A kept run that ended on `stage`. */
function record(stage: number, i: number): PlayRecord {
  return {
    endedAt: 1_700_000_000_000 + i * 60_000,
    stage,
    score: 100 + i,
    end: 'life',
    ticks: 2000,
    stages: Array.from({ length: stage }, (_, k) => ({
      stage: k + 1,
      claims: 1,
      splits: 0,
      misses: { wisp: k === stage - 1 ? 3 : 0, ember: 0, igniter: 0 },
      cleared: k < stage - 1,
    })),
  };
}

/** A play log whose runs ended on `stages`, oldest first. */
async function presetLog(page: Page, stages: number[]): Promise<void> {
  const file: PlayLogFile = { v: 1, runs: stages.map((s, i) => record(s, i)) };
  await preset(page, LOG_KEY, JSON.stringify(file));
}

/** GET /api/ranking answers 503: no ranking offer opens over the GAME OVER modal. */
async function failRankingCheck(page: Page): Promise<void> {
  await page.route('**/api/ranking', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
}

async function open(page: Page, query = ''): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
  // init() runs on DOMContentLoaded: wait for its debug hook.
  await advanceUntil(page, () => hook(page), 2_000, 100);
}

async function start(page: Page): Promise<void> {
  await page.keyboard.press('Space'); // Title -> Playing
  await page.clock.runFor(100);
  expect(await status(page)).toBe('playing');
}

/** Picks `difficulty` with the Title screen's toggle (a click), if it is not already picked. */
async function pick(page: Page, difficulty: 'normal' | 'easy'): Promise<void> {
  const label = difficulty === 'easy' ? 'MODE: EASY' : 'MODE: NORMAL';
  if ((await toggle(page).textContent()) !== label) await toggle(page).click();
  await page.clock.runFor(50);
  await expect(toggle(page)).toHaveText(label);
  expect(await g(page, (h) => h.session.getDifficulty())).toBe(difficulty);
}

/**
 * A box off the top border, with the marker on it: along the border to
 * column `left`, then drawn down to row `depth`, right to column `right` and
 * back up until the claim lands.
 */
async function claimBoxAt(page: Page, box: { left: number; depth: number; right: number }): Promise<void> {
  const before = await score(page);
  const along = (await marker(page)).x > box.left ? 'ArrowLeft' : 'ArrowRight';
  await page.keyboard.down(along);
  await advanceUntil(
    page,
    async () => {
      const x = (await marker(page)).x;
      return along === 'ArrowLeft' ? x <= box.left : x >= box.left;
    },
    4_000,
    FRAME_MS
  );
  await page.keyboard.up(along);
  await page.keyboard.down('Space');
  await page.keyboard.down('ArrowDown');
  await advanceUntil(page, async () => (await marker(page)).y >= box.depth, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowDown');
  await page.keyboard.down('ArrowRight');
  await advanceUntil(page, async () => (await marker(page)).x >= box.right, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.down('ArrowUp');
  await advanceUntil(page, async () => (await score(page)) > before, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('Space');
}

/** tests/e2e/goals-and-retry.spec.ts's scripted claim on seed 1: a small box off the top border. */
async function claimSmallBox(page: Page): Promise<void> {
  await claimBoxAt(page, { left: 30, depth: 25, right: 55 });
}

/** Sets an override from the `?debug` panel's Wisp speed slider: the run is tuned from here on. */
async function tuneWispSpeed(page: Page): Promise<void> {
  await page.locator('#debug-panel input[data-debug-key="wispSpeedMultiplier"]').evaluate((el: HTMLInputElement) => {
    el.value = el.min;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(await g(page, (h) => h.session.isRunTainted())).toBe(true);
}

/** Plays the run out on lives (no debug override), then on through the GAME OVER result. */
async function endOnLives(page: Page): Promise<void> {
  await loseAllLivesToIgniter(page, 90_000);
  await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 3_000, FRAME_MS);
  await finishGameOverResult(page);
}

async function holdUntil(page: Page, key: string, done: () => Promise<boolean>): Promise<void> {
  await page.keyboard.down(key);
  await advanceUntil(page, done, 2_000, FRAME_MS);
  await page.keyboard.up(key);
}

/**
 * tests/e2e/play-log.spec.ts's run to TIME UP with no debug override: a short
 * U into the field from the top border, then held against its own first leg
 * until the time runs out.
 */
async function playOutTheTime(page: Page): Promise<void> {
  const from = await marker(page);
  await page.keyboard.down('KeyX');
  await holdUntil(page, 'ArrowDown', async () => (await marker(page)).y >= from.y + 4);
  await holdUntil(page, 'ArrowLeft', async () => (await marker(page)).x <= from.x - 2);
  await holdUntil(page, 'ArrowUp', async () => (await marker(page)).y <= from.y + 2);
  await page.keyboard.down('ArrowRight');
  for (let jumps = 0; jumps < 1_000; jumps++) {
    if (jumps % 40 === 0 && (await status(page)) === 'gameover') break;
    await page.clock.fastForward(250);
  }
  expect(await status(page)).toBe('gameover');
  await page.keyboard.up('ArrowRight');
  await page.keyboard.up('KeyX');
  await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 3_000, 100);
  await finishGameOverResult(page);
}

/** From the GAME OVER modal, past its confirm guard, with RETRY or TITLE. */
async function leaveGameOver(page: Page, via: 'retry' | 'title'): Promise<void> {
  await page.clock.runFor(Math.ceil((GUARD_TICKS + 2) * TICK_MS));
  await page.locator(via === 'retry' ? '#gameover-retry-button' : '#gameover-back-button').click();
  await page.clock.runFor(100);
  expect(await status(page)).toBe(via === 'retry' ? 'playing' : 'title');
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** The boxes (CSS px) of `selectors` as found now; null for one that is missing or not shown. */
async function boxesOf(page: Page, selectors: string[]): Promise<Record<string, Box | null>> {
  return page.evaluate((list) => {
    const out: Record<string, Box | null> = {};
    for (const s of list) {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) {
        out[s] = null;
        continue;
      }
      const b = el.getBoundingClientRect();
      out[s] = b.width > 0 && b.height > 0 ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } : null;
    }
    return out;
  }, selectors);
}

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const inside = (a: Box, b: Box) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;

/** The HUD's shown lines: their text, and whether any is cut short. */
async function hudState(page: Page) {
  return page.evaluate(() => {
    const lines = ['hud-line1', 'hud-line2', 'hud-line3']
      .map((id) => document.getElementById(id) as HTMLElement)
      .filter((el) => el.style.display !== 'none');
    return {
      lines: lines.length,
      text: lines.map((el) => el.textContent ?? ''),
      clipped: lines.some((el) => el.scrollWidth > el.clientWidth + 1),
      lives: document.getElementById('hud-lives')!.textContent ?? '',
    };
  });
}


// ---------------------------------------------------------------------------

test.describe('the Title screen toggle', () => {
  test('a click flips the label, saves the choice, rebuilds the waiting run with its lives and Wisp speed, and starts nothing', async ({ page }) => {
    await open(page);
    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveText('MODE: NORMAL');
    expect(await page.evaluate((k) => localStorage.getItem(k), DIFFICULTY_KEY)).toBeNull();
    const seed = await g(page, (h) => h.session.getSeed());
    expect((await hudState(page)).lives).toBe('◆'.repeat(INITIAL_LIVES));
    expect((await hudState(page)).text.join(' ')).not.toContain('EASY');

    await toggle(page).click();
    await page.clock.runFor(100);
    await expect(toggle(page)).toHaveText('MODE: EASY');
    expect(await page.evaluate((k) => localStorage.getItem(k), DIFFICULTY_KEY)).toBe('easy');
    expect(await status(page)).toBe('title');
    expect(await g(page, (h) => h.getConfirmCount())).toBe(0);
    await expect(toggle(page)).not.toBeFocused();
    // The run waiting on Title: same seed, EASY's lives and Wisp speed, and the HUD before any start.
    expect(await g(page, (h) => h.session.getSeed())).toBe(seed);
    expect(await g(page, (h) => h.session.getLives())).toBe(EASY_INITIAL_LIVES);
    const hud = await hudState(page);
    expect(hud.lives).toBe('◆'.repeat(EASY_INITIAL_LIVES));
    // EASY leads the HUD's (only, or TIME) line.
    expect(hud.text.filter((line) => line.startsWith('EASY  '))).toHaveLength(1);
    expect(hud.text.join(' ').match(/EASY/g)).toHaveLength(1);

    // Starting right after the click, on the same page, plays what is shown.
    const expectRunStarted = async (difficulty: 'normal' | 'easy', label: string) => {
      await start(page);
      expect(await g(page, (h) => h.session.getDifficulty()), label).toBe(difficulty);
      expect(await g(page, (h) => h.session.getStage()), label).toBe(1);
      expect(await g(page, (h) => h.session.getLives()), label).toBe(difficulty === 'easy' ? EASY_INITIAL_LIVES : INITIAL_LIVES);
      expect((await hudState(page)).lives, label).toBe('◆'.repeat(difficulty === 'easy' ? EASY_INITIAL_LIVES : INITIAL_LIVES));
      const speeds = await g(page, (h) => h.session.getGame().getWisps().map((w) => w.getSpeedMultiplier()));
      expect(speeds.length, label).toBeGreaterThan(0);
      const table = getStageConfig(1).wispSpeedMultiplier;
      for (const s of speeds) expect(s, label).toBeCloseTo(difficulty === 'easy' ? table * EASY_WISP_SPEED_FACTOR : table, 9);
      await expect(toggle(page)).toBeHidden();
    };
    await expectRunStarted('easy', 'EASY, straight after the click');

    // Saved: a reload keeps it, and starting after the reload plays EASY too.
    await page.reload();
    await page.clock.runFor(100);
    await expect(toggle(page)).toHaveText('MODE: EASY');
    expect((await hudState(page)).lives).toBe('◆'.repeat(EASY_INITIAL_LIVES));
    await expectRunStarted('easy', 'EASY, after a reload');

    // And back: NORMAL's three lives and table speed, before any start, and
    // starting right after the click plays NORMAL.
    await page.reload();
    await page.clock.runFor(100);
    await toggle(page).click();
    await page.clock.runFor(100);
    await expect(toggle(page)).toHaveText('MODE: NORMAL');
    expect(await page.evaluate((k) => localStorage.getItem(k), DIFFICULTY_KEY)).toBe('normal');
    expect((await hudState(page)).lives).toBe('◆'.repeat(INITIAL_LIVES));
    await expectRunStarted('normal', 'NORMAL, straight after the click');
  });

  test('Tab then Enter or Space presses it without starting a run, and focus leaves it', async ({ page }) => {
    await open(page);
    for (let i = 0; i < 10 && !(await toggle(page).evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(toggle(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await page.clock.runFor(200);
    await expect(toggle(page)).toHaveText('MODE: EASY');
    await expect(toggle(page)).not.toBeFocused();
    expect(await status(page)).toBe('title');

    await toggle(page).focus();
    await page.keyboard.press('Space');
    await page.clock.runFor(200);
    await expect(toggle(page)).toHaveText('MODE: NORMAL');
    await expect(toggle(page)).not.toBeFocused();
    expect(await status(page)).toBe('title');
    expect(await g(page, (h) => h.getConfirmCount())).toBe(0);

    // The next key starts a run as on any Title screen.
    await start(page);
  });

  for (const key of ['Enter', 'Space'] as const) {
    test(`${key} held on it, auto-repeat and all, presses it once and starts nothing until it is let go`, async ({ page }) => {
      await open(page);
      for (let i = 0; i < 10 && !(await toggle(page).evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press('Tab');
      }
      await expect(toggle(page)).toBeFocused();
      await page.keyboard.down(key);
      await page.clock.runFor(200);
      // The key's auto-repeat, on whatever has the focus by then.
      for (let i = 0; i < 20; i++) {
        await page.keyboard.down(key);
        await page.clock.runFor(50);
      }
      expect(await status(page)).toBe('title');
      expect(await g(page, (h) => h.getConfirmCount())).toBe(0);
      await page.keyboard.up(key);
      await page.clock.runFor(200);
      // One press: EASY, on the Title screen still.
      await expect(toggle(page)).toHaveText('MODE: EASY');
      await expect(toggle(page)).not.toBeFocused();
      expect(await status(page)).toBe('title');
      expect(await g(page, (h) => h.getConfirmCount())).toBe(0);
      // Let go, the key starts a run as on any Title screen.
      await page.keyboard.press(key);
      await page.clock.runFor(100);
      expect(await status(page)).toBe('playing');
      expect(await g(page, (h) => h.session.getDifficulty())).toBe('easy');
    });
  }

  test.describe('on a touch screen', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('a tap presses it without starting a run', async ({ page }) => {
      await open(page);
      await toggle(page).tap();
      await page.clock.runFor(200);
      await expect(toggle(page)).toHaveText('MODE: EASY');
      expect(await status(page)).toBe('title');
      await toggle(page).tap();
      await page.clock.runFor(200);
      await expect(toggle(page)).toHaveText('MODE: NORMAL');
      expect(await status(page)).toBe('title');
      expect(await g(page, (h) => h.getConfirmCount())).toBe(0);
    });
  });

  test('it shows on the live Title screen only', async ({ page }) => {
    await failRankingCheck(page);
    await open(page);
    await expect(toggle(page)).toBeVisible();
    await start(page);
    await expect(toggle(page)).toBeHidden();
    await page.evaluate(() => {
      const s = (window as unknown as { __game__: Hook }).__game__.session;
      s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
    });
    await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
    await expect(toggle(page)).toBeHidden();
    // No toggle and no extra button on the GAME OVER screen.
    expect(await page.locator('#gameover-modal button').count()).toBe(3);
    await leaveGameOver(page, 'title');
    await expect(toggle(page)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// The Title demo, for the layouts with the DEMO tag up and the HUD over it.

/** A recorded run for the mocked demo replay: strips down and up the field, `maxSamples` ticks long. */
function recordDemoReplay(seed: number, maxSamples: number): string {
  const session = new GameSession({ seed });
  const confirm = { dx: 0 as const, dy: 0 as const, drawHeld: false, slow: false, confirm: true };
  session.update(confirm);
  const samples: InputSample[] = [];
  const step = (dx: -1 | 0 | 1, dy: -1 | 0 | 1, drawHeld: boolean): void => {
    samples.push({ dx, dy, drawHeld, slow: false });
    session.update({ dx, dy, drawHeld, slow: false, confirm: false });
    session.drainEvents();
    session.drainDespawnedEmberPositions();
  };
  const height = session.getGame().getField().getHeight();
  let goingDown = true;
  while (session.getStatus() !== 'gameover' && samples.length < maxSamples) {
    if (session.getStatus() === 'stageclear') {
      session.update(confirm);
      continue;
    }
    const targetY = goingDown ? height - 1 : 0;
    let crossing = 0;
    while (
      session.getStatus() === 'playing' &&
      samples.length < maxSamples &&
      session.getGame().getMarker().getPosition().y !== targetY &&
      crossing++ < height + 5
    ) {
      step(0, goingDown ? 1 : -1, true);
    }
    for (let i = 0; i < 4 && session.getStatus() === 'playing' && samples.length < maxSamples; i++) step(1, 0, false);
    goingDown = !goingDown;
  }
  return Buffer.from(encodeRle(samples)).toString('base64');
}

const DEMO_SEED = 377;
const DEMO_PAYLOAD = JSON.stringify({
  seed: DEMO_SEED,
  rleBase64: recordDemoReplay(DEMO_SEED, 600),
  rulesetVersion: RULESET_VERSION,
  replayFormatVersion: REPLAY_FORMAT_VERSION,
});

/** A full board whose top row has a replay: the Title demo plays it, and RANKING lists it with REPLAY. */
async function mockBoardWithReplay(page: Page): Promise<void> {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    id: `row${i}`,
    createdAt: '2026-01-01T12:00:00Z',
    score: 9000 - i * 100,
    stage: 2,
    name: `RIVAL${i}`,
    xHandle: null,
    replayAvailable: i === 0,
  }));
  await page.route('**/api/ranking', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries, displayEntries: entries.map((e) => ({ ...e, status: 'verified' })) }),
    });
  });
  await page.route('**/api/ranking/*/replay', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: DEMO_PAYLOAD }));
}

async function untilDemoShown(page: Page): Promise<void> {
  await advanceUntil(page, async () => (await g(page, (h) => h.getTitleDemo().shown)) === true, 5_000, 100);
  await expect(page.locator('#title-demo-label')).toBeVisible();
}

const LAYOUTS = [
  { name: '1280x800', viewport: { width: 1280, height: 800 }, hasTouch: false, below: false },
  { name: '390x844 touch', viewport: { width: 390, height: 844 }, hasTouch: true, below: false },
  { name: '844x390 touch', viewport: { width: 844, height: 390 }, hasTouch: true, below: false },
  { name: '667x375 touch', viewport: { width: 667, height: 375 }, hasTouch: true, below: true },
];

const TITLE_BOXES = ['#difficulty-button', '#how-to-play-button', '#ranking-button', '#title-demo-label', '#screen', '#game-canvas', '#game-root', '#hud', '#mute-button', '#credit-link'];

/** Every shown touch control's box. */
async function touchControlBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#touch-controls button, #touch-dpad')]
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0)
      .map((b) => ({ left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }))
  );
}

/** The shown HUD lines' boxes, and the HUD row's. */
async function hudLineBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() =>
    ['hud-line1', 'hud-line2', 'hud-line3']
      .map((id) => document.getElementById(id) as HTMLElement)
      .filter((el) => el.style.display !== 'none')
      .map((el) => {
        // The text's own extent, not the line box stretched to the row.
        const range = document.createRange();
        range.selectNodeContents(el);
        const b = range.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
      })
  );
}

async function contextFor(browser: Browser, layout: (typeof LAYOUTS)[number], locale = 'en-US') {
  return browser.newContext({ viewport: layout.viewport, hasTouch: layout.hasTouch, isMobile: false, locale });
}

for (const layout of LAYOUTS) {
  test(`the toggle and an EASY HUD on the Title screen at ${layout.name}`, async ({ browser }) => {
    const context = await contextFor(browser, layout);
    const page = await context.newPage();
    await mockBoardWithReplay(page);
    await open(page);
    await untilDemoShown(page);
    const viewport = { left: 0, top: 0, right: layout.viewport.width, bottom: layout.viewport.height, width: 0, height: 0 };

    const check = async (label: string) => {
      const b = await boxesOf(page, TITLE_BOXES);
      const t = b['#difficulty-button']!;
      const field = b['#game-canvas']!;
      expect(t, label).not.toBeNull();
      expect(inside(t, viewport), label).toBe(true);
      expect(inside(t, b['#game-root']!), label).toBe(true);
      for (const other of ['#how-to-play-button', '#ranking-button', '#title-demo-label', '#screen', '#hud', '#mute-button', '#credit-link']) {
        expect(b[other], `${label} ${other}`).not.toBeNull();
        expect(overlaps(t, b[other]!), `${label}: the toggle and ${other}`).toBe(false);
      }
      for (const control of await touchControlBoxes(page)) expect(overlaps(t, control), `${label}: a touch control`).toBe(false);
      // The last of the Title menu's row, right of RANKING.
      expect(t.left, label).toBeGreaterThanOrEqual(b['#ranking-button']!.right - 0.5);
      expect(Math.abs(t.top - b['#ranking-button']!.top), label).toBeLessThanOrEqual(0.5);
      if (layout.below) {
        // Under the field.
        expect(t.top).toBeGreaterThanOrEqual(field.bottom);
      } else {
        // On the field, under the title text.
        expect(inside(t, field), label).toBe(true);
        expect(t.top).toBeGreaterThanOrEqual(b['#screen']!.bottom);
      }
      // Pressed where it shows.
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x: t.left + t.width / 2, y: t.top + t.height / 2 });
      expect(hit, label).toBe('difficulty-button');
      // The HUD: whole, on screen, clear of the SOUND button and the credit.
      const hud = await hudState(page);
      expect(hud.clipped, label).toBe(false);
      for (const line of await hudLineBoxes(page)) {
        expect(inside(line, viewport), label).toBe(true);
        expect(overlaps(line, b['#mute-button']!), `${label}: a HUD line and SOUND`).toBe(false);
        expect(overlaps(line, b['#credit-link']!), `${label}: a HUD line and the credit`).toBe(false);
      }
      return { boxes: b, hud };
    };

    const normal = await check('NORMAL');
    expect(normal.hud.lives).toBe('◆◆◆');
    await toggle(page).click();
    await page.clock.runFor(100);
    await expect(toggle(page)).toHaveText('MODE: EASY');
    expect((await g(page, (h) => h.getTitleDemo().shown))).toBe(true);
    const easy = await check('EASY');
    expect(easy.hud.lives).toBe('◆◆◆◆◆');
    expect(easy.hud.text.join(' ')).toContain('EASY  ');
    // The HUD keeps its line count here, and nothing on the Title screen moves.
    expect(easy.hud.lines).toBe(normal.hud.lines);
    for (const s of ['#difficulty-button', '#how-to-play-button', '#ranking-button', '#title-demo-label', '#screen', '#game-canvas']) {
      expect(easy.boxes[s], s).toEqual(normal.boxes[s]);
    }
    await context.close();
  });
}

test.describe('a field held to its size by a short window', () => {
  test.use({ viewport: { width: 500, height: 450 }, hasTouch: true });

  test('keeps the toggle whole on screen, along the field’s bottom edge, and pressable both ways', async ({ page }) => {
    await open(page);
    const b = await boxesOf(page, ['#difficulty-button', '#game-canvas', '#game-root']);
    const t = b['#difficulty-button']!;
    const field = b['#game-canvas']!;
    // A small field: there is no room under it, so the toggle is on it, in its lower half.
    expect(field.height).toBeLessThan(200);
    expect(inside(t, field)).toBe(true);
    expect(t.top).toBeGreaterThan(field.top + field.height / 2);
    expect(inside(t, b['#game-root']!)).toBe(true);
    expect(inside(t, { left: 0, top: 0, right: 500, bottom: 450, width: 0, height: 0 })).toBe(true);
    // Not covered: a tap at its middle lands on it, both ways.
    for (const label of ['MODE: EASY', 'MODE: NORMAL']) {
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x: t.left + t.width / 2, y: t.top + t.height / 2 });
      expect(hit).toBe('difficulty-button');
      await page.touchscreen.tap(t.left + t.width / 2, t.top + t.height / 2);
      await page.clock.runFor(100);
      await expect(toggle(page)).toHaveText(label);
      expect(await status(page)).toBe('title');
      expect((await boxesOf(page, ['#difficulty-button']))['#difficulty-button']).toEqual(t);
    }
  });
});

test.describe('the HUD at the one-line / three-line border (880x700)', () => {
  test.use({ viewport: { width: 880, height: 700 } });

  test('EASY never cuts the HUD short, and NORMAL again gives the line count back', async ({ page }) => {
    await open(page);
    const before = await hudState(page);
    expect(before.lines).toBe(1);
    expect(before.clipped).toBe(false);
    await toggle(page).click();
    await page.clock.runFor(100);
    const easy = await hudState(page);
    expect(easy.clipped).toBe(false);
    expect(easy.text.join(' ')).toContain('EASY  ');
    expect(easy.lives).toBe('◆◆◆◆◆');
    for (const line of await hudLineBoxes(page)) {
      expect(inside(line, { left: 0, top: 0, right: 880, bottom: 700, width: 0, height: 0 })).toBe(true);
    }
    await toggle(page).click();
    await page.clock.runFor(100);
    const back = await hudState(page);
    expect(back.lines).toBe(before.lines);
    expect(back.clipped).toBe(false);
    expect(back.text).toEqual(before.text);
  });
});

test.describe('the HUD of the session shown', () => {
  test('a ranking replay over an EASY pick reads NORMAL with three marks, and EASY is back after it', async ({ page }) => {
    await mockBoardWithReplay(page);
    await open(page);
    await pick(page, 'easy');
    expect((await hudState(page)).lives).toBe('◆◆◆◆◆');
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).and(page.locator(':enabled')).first().click();
    await advanceUntil(page, async () => page.getByRole('button', { name: 'EXIT' }).isVisible(), 3_000, 100);
    await page.clock.runFor(500);
    expect(await g(page, (h) => h.session.getStatus())).toBe('title');
    const replay = await hudState(page);
    expect(replay.text.join(' ')).not.toContain('EASY');
    expect(replay.lives).toMatch(/^[◆◇]{3}$/);
    expect(replay.clipped).toBe(false);
    // Like HOW TO PLAY and RANKING, the toggle is not offered during a replay.
    await expect(toggle(page)).toBeHidden();
    await expect(page.locator('#how-to-play-button')).toBeHidden();
    await page.getByRole('button', { name: 'EXIT' }).click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('title');
    const back = await hudState(page);
    expect(back.text.join(' ')).toContain('EASY  ');
    expect(back.lives).toBe('◆◆◆◆◆');
    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveText('MODE: EASY');
  });

  test('the Title demo leaves the HUD to the live run: EASY and five marks the whole time it plays', async ({ page }) => {
    await mockBoardWithReplay(page);
    await open(page);
    await untilDemoShown(page);
    await toggle(page).click();
    await page.clock.runFor(50);
    const first = await hudState(page);
    expect(first.text.join(' ')).toContain('EASY  ');
    expect(first.lives).toBe('◆◆◆◆◆');
    let sawEnd = false;
    for (let i = 0; i < 30; i++) {
      await page.clock.runFor(500);
      const now = await hudState(page);
      expect(now).toEqual(first);
      if ((await g(page, (h) => h.getTitleDemo().state)) === 'ended') sawEnd = true;
    }
    expect(sawEnd).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/** Counts the live run's fx ticks and stage starts (main.ts calls fx.tick() once per live tick). */
async function probeStarts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = (window as unknown as { __game__: Hook }).__game__;
    const probe = { ticks: 0, stageStarts: [] as number[] };
    const tick = h.fx.tick.bind(h.fx);
    h.fx.tick = () => {
      probe.ticks++;
      tick();
    };
    const onStageStart = h.fx.onStageStart.bind(h.fx);
    h.fx.onStageStart = (heading, title) => {
      probe.stageStarts.push(probe.ticks);
      onStageStart(heading, title);
    };
    (window as unknown as { __probe__: typeof probe }).__probe__ = probe;
  });
}
const stageStarts = (page: Page) => page.evaluate(() => (window as unknown as { __probe__: { stageStarts: number[] } }).__probe__.stageStarts.length);

test.describe('an EASY run', () => {
  test('shows EASY and five lives in play, starts stage 2 at the middle of the top edge with the start cue, and tags its GAME OVER', async ({ page }) => {
    await failRankingCheck(page);
    await open(page, '?seed=1');
    await probeStarts(page);
    await pick(page, 'easy');
    // Stage 1 cleared with a lowered goal (a debug override), the session fed
    // a small box from the top-middle start.
    await page.evaluate(() => {
      const session = (window as unknown as { __game__: Hook }).__game__.session;
      session.applyDebugOverrides({ requiredOccupancy: 0.00001 });
      const update = session.update.bind(session);
      const box = [
        { dx: 0, dy: 1 },
        { dx: 0, dy: 1 },
        { dx: 1, dy: 0 },
        { dx: 1, dy: 0 },
        { dx: 0, dy: -1 },
        { dx: 0, dy: -1 },
      ];
      session.update = (input) => {
        if (session.getStage() !== 1 || session.getStatus() !== 'playing') return update(input);
        const step = box[session.getStageTicks()] ?? { dx: 0, dy: 0 };
        return update({ ...step, drawHeld: true, slow: false, confirm: false });
      };
    });
    await start(page);
    const playing = await hudState(page);
    expect(playing.lives).toBe('◆◆◆◆◆');
    expect(playing.text.filter((line) => line.startsWith('EASY  '))).toHaveLength(1);
    await advanceUntil(page, async () => (await status(page)) === 'stageclear', 5_000, FRAME_MS);
    await page.clock.runFor(1_500);
    for (let i = 0; i < 4 && (await stageStarts(page)) < 2; i++) {
      await page.keyboard.press('Enter');
      await advanceUntil(page, async () => (await stageStarts(page)) >= 2 || (await status(page)) === 'stageclear', 300, FRAME_MS);
      if ((await stageStarts(page)) < 2) await page.clock.runFor(200);
    }
    await advanceUntil(page, async () => (await stageStarts(page)) >= 2, 2_000, FRAME_MS);
    expect(await g(page, (h) => h.session.getStage())).toBe(2);
    const topMiddle = { x: Math.floor(GRID_WIDTH / 2), y: 0 };
    expect(await g(page, (h) => h.session.getMarkerStart())).toEqual({ edge: 'top', point: topMiddle });
    await page.clock.runFor(FRAME_MS * 3);
    expect(await g(page, (h) => h.getStartCue())).not.toBeNull();
    expect((await hudState(page)).lives).toBe('◆◆◆◆◆');
    for (const s of await g(page, (h) => h.session.getGame().getWisps().map((w) => w.getSpeedMultiplier()))) {
      expect(s).toBeCloseTo(getStageConfig(2).wispSpeedMultiplier * EASY_WISP_SPEED_FACTOR, 9);
    }

    await page.evaluate(() => {
      const s = (window as unknown as { __game__: Hook }).__game__.session;
      s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
    });
    await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
    await finishGameOverResult(page);
    await expect(page.locator('#gameover-easy')).toBeVisible();
    await expect(page.locator('#gameover-easy')).toHaveText('EASY');
    await expect(page.locator('#gameover-share-button')).toBeHidden();
  });
});

for (const layout of LAYOUTS) {
  test(`an EASY run's GAME OVER screen fits at ${layout.name}`, async ({ browser }) => {
    const context = await contextFor(browser, layout);
    const page = await context.newPage();
    await failRankingCheck(page);
    await preset(page, HIGH_SCORE_KEY, '999999');
    await pinNormalSeed(page, 1);
    await open(page);
    await pick(page, 'easy');
    await start(page);
    await claimSmallBox(page);
    // TIME UP! too, the tallest EASY screen (a debug override ends it quickly).
    await page.evaluate(() => {
      const s = (window as unknown as { __game__: Hook }).__game__.session;
      s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
    });
    await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
    await finishGameOverResult(page);
    await expect(page.locator('#gameover-easy')).toBeVisible();
    await expect(page.locator('#gameover-reason')).toHaveText('TIME UP!');
    await expect(page.locator('#gameover-share-button')).toBeHidden();
    await expect(page.locator('#gameover-to-best')).toBeHidden();
    await expect(page.locator('#gameover-new-record')).toBeHidden();
    const b = await boxesOf(page, ['#game-canvas', '#gameover-modal', '#gameover-easy', '#gameover-retry-button', '#gameover-back-button']);
    expect(inside(b['#gameover-modal']!, b['#game-canvas']!)).toBe(true);
    expect(inside(b['#gameover-easy']!, b['#gameover-modal']!)).toBe(true);
    for (const button of ['#gameover-retry-button', '#gameover-back-button']) {
      expect(b[button]!.height).toBeGreaterThanOrEqual(44);
      expect(inside(b[button]!, b['#gameover-modal']!)).toBe(true);
    }
    await context.close();
  });
}

test.describe('what an EASY run is kept out of', () => {
  test('a live EASY run past the NORMAL best is not saved and shows no NEW RECORD; HI stays; it is not logged; a NORMAL run after it short of the best changes nothing', async ({ page }) => {
    await failRankingCheck(page);
    await preset(page, HIGH_SCORE_KEY, '1');
    await pinNormalSeed(page, 1);
    await open(page);
    await pick(page, 'easy');
    await start(page);
    await claimSmallBox(page);
    expect(await score(page)).toBeGreaterThan(1);
    expect(await g(page, (h) => h.session.isRunTainted())).toBe(false);
    expect((await hudState(page)).text.join(' ')).toContain('HI 1');
    await page.clock.runFor(500);
    expect(await storedHighScore(page)).toBe('1');
    await endOnLives(page);
    expect(await g(page, (h) => h.session.getLives())).toBe(0);
    expect(await storedHighScore(page)).toBe('1');
    expect(await g(page, (h) => h.session.getHighScore())).toBe(1);
    await expect(page.locator('#gameover-new-record')).toBeHidden();
    await expect(page.locator('#gameover-to-best')).toBeHidden();
    await expect(page.locator('#gameover-modal')).toContainText('HI SCORE: 1');
    expect(await g(page, (h) => h.getGameOverResult().best)).toBeNull();
    expect(await g(page, (h) => h.getPlayLog())).toEqual([]);
    expect(await page.evaluate((k) => localStorage.getItem(k), LOG_KEY)).toBeNull();

    // A NORMAL run after it, short of the best: kept in the log, the best unchanged.
    await leaveGameOver(page, 'title');
    await pick(page, 'normal');
    // The NORMAL run chases the best as it was before the EASY run.
    expect((await hudState(page)).text.join(' ')).toContain('TO BEST 1');
    await start(page);
    await endOnLives(page);
    expect(await score(page)).toBe(0);
    expect(await storedHighScore(page)).toBe('1');
    expect(await g(page, (h) => h.getPlayLog())).toHaveLength(1);
  });

  test('the ranking offer and POST TO X: shown for a NORMAL run, never for an EASY one, on the same board', async ({ browser }) => {
    const play = async (difficulty: 'normal' | 'easy') => {
      const context = await browser.newContext();
      const page = await context.newPage();
      // An empty board: any NORMAL run is in range. Every read of the board is counted.
      let boardReads = 0;
      await page.route('**/api/ranking', (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        boardReads += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries: [], displayEntries: [] }) });
      });
      await pinNormalSeed(page, 1);
      await open(page);
      await pick(page, difficulty);
      await start(page);
      await claimSmallBox(page);
      const readsBeforeTheEnd = boardReads;
      await endOnLives(page);
      // A NORMAL run asks the board whether it is in range, and the form
      // opens once the answer is in and the result has been read. An EASY run
      // never asks: past the time a form would have opened, there is none.
      if (difficulty === 'normal') await advanceToSubmissionPanel(page);
      else await advancePastOfferTime(page);
      await page.clock.runFor(500);
      const result = {
        score: await score(page),
        tainted: await g(page, (h) => h.session.isRunTainted()),
        offer: await page.locator('#ranking-submit-panel').isVisible(),
        share: await page.locator('#gameover-share-button').isVisible(),
        readsAtTheEnd: boardReads - readsBeforeTheEnd,
      };
      await context.close();
      return result;
    };
    const normal = await play('normal');
    const easy = await play('easy');
    // The same score on the same board: only the difficulty tells the two apart.
    expect(normal.score).toBeGreaterThan(0);
    expect(easy.score).toBe(normal.score);
    expect(normal.tainted || easy.tainted).toBe(false);
    expect(normal.offer).toBe(true);
    expect(normal.readsAtTheEnd).toBeGreaterThan(0);
    expect(easy.offer).toBe(false);
    expect(easy.readsAtTheEnd).toBe(0);
    // POST TO X sits under the offer for NORMAL; an EASY run has none at all.
    expect(easy.share).toBe(false);
  });

  test('the POST TO X button is offered after a NORMAL run with no offer', async ({ page }) => {
    await failRankingCheck(page);
    await open(page);
    await start(page);
    await page.evaluate(() => {
      const s = (window as unknown as { __game__: Hook }).__game__.session;
      s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
    });
    await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
    await expect(page.locator('#gameover-share-button')).toBeVisible();
    await expect(page.locator('#gameover-easy')).toBeHidden();
  });

  test('POST TO X posts the NORMAL run it was pressed on, even when the answer comes back on a later EASY run’s GAME OVER', async ({ page, context }) => {
    await failRankingCheck(page);
    // The share answer is held until the later run's GAME OVER is up.
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const bodies: unknown[] = [];
    await page.route('**/share', async (route) => {
      bodies.push(route.request().postDataJSON());
      await answered;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'held-id' }) });
    });
    await context.route('https://twitter.com/intent/tweet**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' })
    );
    const endNow = () =>
      page.evaluate(() => {
        const s = (window as unknown as { __game__: Hook }).__game__.session;
        s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
      });
    const untilGameOver = async () => {
      await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
      await finishGameOverResult(page);
    };

    // A NORMAL run with points, and POST TO X pressed on its GAME OVER.
    await pinNormalSeed(page, 1);
    await open(page);
    await start(page);
    await claimSmallBox(page);
    await endNow();
    await untilGameOver();
    const pressed = {
      score: await score(page),
      stage: await g(page, (h) => h.session.getStage()),
      hi: await g(page, (h) => h.session.getHighScore()),
    };
    expect(pressed.score).toBeGreaterThan(0);
    const requested = page.waitForRequest('**/share');
    const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('#gameover-share-button').click()]);
    await requested;

    // TITLE, then an EASY run with no points to its own GAME OVER.
    await leaveGameOver(page, 'title');
    await pick(page, 'easy');
    await start(page);
    await endNow();
    await untilGameOver();
    await expect(page.locator('#gameover-easy')).toBeVisible();
    const later = await score(page);
    expect(later).not.toBe(pressed.score);

    // The answer comes back now: the request and the post are both the pressed run's.
    answer();
    await popup.waitForURL(/^https:\/\/twitter\.com\/intent\/tweet/);
    expect(bodies).toEqual([pressed]);
    expect(new URL(popup.url()).searchParams.get('text')).toBe(
      `QIXXX で STAGE ${pressed.stage} / SCORE ${pressed.score.toLocaleString('en-US')} を記録！ #QIXXX`
    );
    await popup.close();
    // The EASY run's GAME OVER is left as it is: no POST TO X.
    await expect(page.locator('#gameover-share-button')).toBeHidden();
  });
});

test.describe('a debug-tuned run never reaches the stored best', () => {
  test('past the best with a debug override: not saved after RESET in the same run, nor in the clean run after it', async ({ page }) => {
    await failRankingCheck(page);
    await preset(page, HIGH_SCORE_KEY, '1');
    await pinNormalSeed(page, 1);
    await open(page, '?debug');
    await expect(page.locator('#debug-panel')).toBeVisible();
    await start(page);
    await tuneWispSpeed(page);
    await claimSmallBox(page);
    expect(await score(page)).toBeGreaterThan(1);
    // (a) RESET in the same run: no override is active any more.
    await page.locator('#debug-panel').getByRole('button', { name: 'RESET', exact: true }).click();
    await page.clock.runFor(500);
    expect(await storedHighScore(page)).toBe('1');
    expect(await g(page, (h) => h.session.getHighScore())).toBe(1);
    await endOnLives(page);
    expect(await storedHighScore(page)).toBe('1');
    // (b) The next run, with no override at all.
    await leaveGameOver(page, 'retry');
    expect(await g(page, (h) => h.session.isRunTainted())).toBe(false);
    await page.clock.runFor(1_000);
    expect(await storedHighScore(page)).toBe('1');
    expect(await g(page, (h) => h.session.getHighScore())).toBe(1);
  });

  test('past the best before an override: that score stays the best — through points after it, RESET and the clean run after it', async ({ page }) => {
    await failRankingCheck(page);
    await preset(page, HIGH_SCORE_KEY, '1');
    await pinNormalSeed(page, 1);
    await open(page, '?debug');
    await expect(page.locator('#debug-panel')).toBeVisible();
    await start(page);
    // Past the best with no override yet: saved at once.
    await claimSmallBox(page);
    const reached = await score(page);
    expect(reached).toBeGreaterThan(1);
    await page.clock.runFor(100);
    expect(await storedHighScore(page)).toBe(String(reached));
    // (a) An override partway: the best is still the score reached so far,
    // and the points after it do not raise it.
    await tuneWispSpeed(page);
    expect(await g(page, (h) => h.session.getHighScore())).toBe(reached);
    await claimBoxAt(page, { left: 115, depth: 25, right: 135 });
    expect(await score(page)).toBeGreaterThan(reached);
    await page.clock.runFor(500);
    expect(await g(page, (h) => h.session.getHighScore())).toBe(reached);
    expect(await storedHighScore(page)).toBe(String(reached));
    await page.locator('#debug-panel').getByRole('button', { name: 'RESET', exact: true }).click();
    await page.clock.runFor(500);
    expect(await g(page, (h) => h.session.getHighScore())).toBe(reached);
    expect(await storedHighScore(page)).toBe(String(reached));
    await endOnLives(page);
    expect(await g(page, (h) => h.session.getHighScore())).toBe(reached);
    expect(await storedHighScore(page)).toBe(String(reached));
    // (b) The next run, with no override, short of that best: no NEW RECORD, the stored best unchanged.
    await leaveGameOver(page, 'retry');
    expect(await g(page, (h) => h.session.isRunTainted())).toBe(false);
    expect(await g(page, (h) => h.session.getHighScore())).toBe(reached);
    await claimBoxAt(page, { left: 40, depth: 10, right: 48 });
    const short = await score(page);
    expect(short).toBeGreaterThan(1);
    expect(short).toBeLessThan(reached);
    await endOnLives(page);
    await expect(page.locator('#gameover-new-record')).toBeHidden();
    await expect(page.locator('#gameover-to-best')).toBeVisible();
    expect(await g(page, (h) => h.getGameOverResult().best)).not.toBeNull();
    expect(await storedHighScore(page)).toBe(String(reached));
    expect(await g(page, (h) => h.session.getHighScore())).toBe(reached);
  });

  test('POST TO X on a run tuned past the best sends a high score no lower than the score, as /share takes', async ({ page, context }) => {
    await failRankingCheck(page);
    await preset(page, HIGH_SCORE_KEY, '1');
    const bodies: unknown[] = [];
    await page.route('**/share', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'tuned-id' }) });
    });
    await context.route('https://twitter.com/intent/tweet**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' })
    );
    await pinNormalSeed(page, 1);
    await open(page, '?debug');
    await expect(page.locator('#debug-panel')).toBeVisible();
    await start(page);
    await tuneWispSpeed(page);
    await claimSmallBox(page);
    await endOnLives(page);
    const run = { score: await score(page), stage: await g(page, (h) => h.session.getStage()) };
    expect(run.score).toBeGreaterThan(1);
    // The session's best and the modal leave the tuned points out.
    expect(await g(page, (h) => h.session.getHighScore())).toBe(1);
    await expect(page.locator('#gameover-modal')).toContainText('HI SCORE: 1');
    await expect(page.locator('#gameover-share-button')).toBeVisible();
    const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('#gameover-share-button').click()]);
    await popup.waitForURL(/^https:\/\/twitter\.com\/intent\/tweet/);
    expect(bodies).toEqual([{ score: run.score, stage: run.stage, hi: run.score }]);
    expect(validateSharePayload(bodies[0])).toEqual({ kind: 'ok', value: bodies[0] });
    expect(new URL(popup.url()).searchParams.get('text')).toBe(
      `QIXXX で STAGE ${run.stage} / SCORE ${run.score.toLocaleString('en-US')} を記録！ #QIXXX`
    );
    await popup.close();
    // Sending leaves the bests alone.
    expect(await g(page, (h) => h.session.getHighScore())).toBe(1);
    expect(await storedHighScore(page)).toBe('1');
  });
});

test.describe('the `?debug` panel', () => {
  test('its Wisp speed follows the Title toggle, and the toggle alone sets no override', async ({ page }) => {
    await failRankingCheck(page);
    await open(page, '?debug');
    await expect(page.locator('#debug-panel')).toBeVisible();
    const slider = page.locator('#debug-panel input[data-debug-key="wispSpeedMultiplier"]');
    const shown = () =>
      slider.evaluate((el: HTMLInputElement) => ({
        value: Number(el.value),
        readout: el.parentElement!.firstElementChild!.lastElementChild!.textContent,
      }));
    const expectShown = async (speed: number, label: string) => {
      const now = await shown();
      expect(now.readout, label).toBe(speed.toFixed(2));
      // The slider sits on its step grid.
      expect(Math.abs(now.value - speed), label).toBeLessThanOrEqual(Number(await slider.getAttribute('step')) / 2 + 1e-9);
      for (const s of await g(page, (h) => h.session.getGame().getWisps().map((w) => w.getSpeedMultiplier()))) {
        expect(s, label).toBeCloseTo(speed, 9);
      }
    };
    const table = getStageConfig(1).wispSpeedMultiplier;
    await expectShown(table, 'NORMAL');
    await pick(page, 'easy');
    await expectShown(table * EASY_WISP_SPEED_FACTOR, 'EASY');
    await pick(page, 'normal');
    await expectShown(table, 'NORMAL again');
    expect(await g(page, (h) => h.session.isRunTainted())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The GAME OVER screen's suggestion.

const prompt = (page: Page) => page.locator('#gameover-easy-prompt');
const highlight = (page: Page) => page.locator('#gameover-highlight');
const attention = (page: Page) => toggle(page).evaluate((el) => (el as HTMLElement).dataset.attention === 'true');

/** One kept NORMAL run with a claim, lost on lives on stage 1. */
async function shortRun(page: Page): Promise<void> {
  await claimSmallBox(page);
  await endOnLives(page);
  expect(await g(page, (h) => h.session.getStage())).toBe(1);
  expect(await g(page, (h) => h.session.isRunTainted())).toBe(false);
}

async function expectHighlightOnly(page: Page): Promise<void> {
  await expect(highlight(page)).toBeVisible();
  await expect(highlight(page)).toHaveText(/^BEST CLAIM \d+%$/);
  await expect(prompt(page)).toBeHidden();
  expect(await g(page, (h) => h.getGameOverResult().prompt)).toBe(false);
}

async function expectPrompt(page: Page, text = PROMPT_EN): Promise<void> {
  await expect(prompt(page)).toBeVisible();
  await expect(prompt(page)).toHaveText(text);
  await expect(highlight(page)).toBeHidden();
  expect(await g(page, (h) => h.getGameOverResult())).toMatchObject({ prompt: true, highlight: null });
  // Nothing added to the screen: the same three buttons.
  expect(await page.locator('#gameover-modal button').count()).toBe(3);
}

test.describe('the GAME OVER suggestion', () => {
  test('shows on the third early NORMAL GAME OVER in a row, in the highlight’s place; TITLE then lights the toggle until it is pressed', async ({ page }) => {
    await failRankingCheck(page);
    await pinNormalSeed(page, 1);
    await open(page);
    await start(page);
    await shortRun(page);
    await expectHighlightOnly(page);
    await leaveGameOver(page, 'retry');
    await shortRun(page);
    await expectHighlightOnly(page);
    await leaveGameOver(page, 'retry');
    await shortRun(page);
    expect(await g(page, (h) => h.getPlayLog().map((r) => r.stage))).toEqual([1, 1, 1]);
    await expectPrompt(page);
    // The best line and the rest are as they always are.
    await expect(page.locator('#gameover-modal')).toContainText('HI SCORE:');

    await leaveGameOver(page, 'title');
    await expect(toggle(page)).toBeVisible();
    expect(await attention(page)).toBe(true);
    // Lit text (and underline) whose glow pulses three times; lit and still with reduced motion.
    const look = () =>
      toggle(page).evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          color: s.color,
          underline: s.textDecorationColor,
          animation: s.animationName,
          count: s.animationIterationCount,
          duration: s.animationDuration,
        };
      });
    const rowBoxes = () => boxesOf(page, ['#title-menu', '#how-to-play-button', '#ranking-button', '#difficulty-button']);
    const boxesLit = await rowBoxes();
    const lit = await look();
    expect(lit).toMatchObject({
      color: 'rgb(255, 255, 255)',
      underline: 'rgb(255, 255, 255)',
      animation: 'difficulty-attention',
      count: String(EASY_PROMPT_TOGGLE_PULSE_COUNT),
      duration: `${EASY_PROMPT_TOGGLE_PULSE_SEC}s`,
    });
    // The glow's numbers are src/config.ts's: at rest at the start of a
    // pulse, the peak in its middle — never an invalid (dropped) declaration.
    const glow = (blur: number) => `rgb(255, 255, 255) 0px 0px ${blur}px`;
    const shadowAt = (fraction: number) =>
      toggle(page).evaluate((el, at) => {
        const pulse = el.getAnimations()[0];
        const duration = Number(pulse.effect!.getTiming().duration);
        pulse.pause();
        pulse.currentTime = duration * at;
        const shadow = getComputedStyle(el).textShadow;
        pulse.play();
        return shadow;
      }, fraction);
    expect(await shadowAt(0)).toBe(glow(EASY_PROMPT_TOGGLE_GLOW_REST_BLUR_PX));
    expect(await shadowAt(0.5)).toBe(glow(EASY_PROMPT_TOGGLE_GLOW_PEAK_BLUR_PX));
    // The glow never moves the row.
    expect(await rowBoxes()).toEqual(boxesLit);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await look()).toMatchObject({ color: 'rgb(255, 255, 255)', underline: 'rgb(255, 255, 255)', animation: 'none' });
    // Lit and still: the glow at rest.
    expect(await toggle(page).evaluate((el) => getComputedStyle(el).textShadow)).toBe(glow(EASY_PROMPT_TOGGLE_GLOW_REST_BLUR_PX));
    expect(await rowBoxes()).toEqual(boxesLit);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await toggle(page).click();
    await page.clock.runFor(100);
    expect(await attention(page)).toBe(false);
    expect((await look()).animation).toBe('none');
    expect((await look()).color).not.toBe('rgb(255, 255, 255)');
    expect(await toggle(page).evaluate((el) => getComputedStyle(el).textShadow)).toBe('none');
    await expect(toggle(page)).toHaveText('MODE: EASY');
    // EASY's HUD may take more lines and so shrink the field; the row stays
    // under the title text all the same.
    const after = await boxesOf(page, ['#title-menu', '#screen']);
    expect(Math.abs(after['#title-menu']!.top - after['#screen']!.bottom - TITLE_MENU_GAP_PX)).toBeLessThanOrEqual(1);
  });

  test('a run started from the lit Title screen turns it off; RETRY from the suggestion lights nothing; a GAME OVER without it lights nothing', async ({ page }) => {
    await failRankingCheck(page);
    await presetLog(page, [1, 1]);
    await pinNormalSeed(page, 1);
    await open(page);
    await start(page);
    await shortRun(page);
    await expectPrompt(page);
    await leaveGameOver(page, 'title');
    expect(await attention(page)).toBe(true);
    await start(page);
    expect(await attention(page)).toBe(false);
    await shortRun(page);
    await expectPrompt(page);
    // RETRY: straight into a run, then back to Title from a GAME OVER with no suggestion.
    await leaveGameOver(page, 'retry');
    await page.evaluate(() => {
      const s = (window as unknown as { __game__: Hook }).__game__.session;
      s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
    });
    await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
    await finishGameOverResult(page);
    await expect(prompt(page)).toBeHidden();
    await leaveGameOver(page, 'title');
    expect(await attention(page)).toBe(false);
  });

  test('TITLE taken before the suggestion appears lights nothing', async ({ page }) => {
    await failRankingCheck(page);
    await presetLog(page, [1, 1]);
    await pinNormalSeed(page, 1);
    await open(page);
    await start(page);
    // A run with points: its score counts up first, and the suggestion comes after.
    await claimSmallBox(page);
    await loseAllLivesToIgniter(page, 90_000);
    await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 3_000, FRAME_MS);
    // TITLE as soon as it works: the suggestion is decided but not on screen yet.
    await page.clock.runFor(Math.ceil((GUARD_TICKS + 2) * TICK_MS));
    expect(await g(page, (h) => h.getPlayLog().map((r) => r.stage))).toEqual([1, 1, 1]);
    expect(await prompt(page).evaluate((el) => ({ display: getComputedStyle(el).display, visibility: getComputedStyle(el).visibility, text: el.textContent }))).toEqual({
      display: 'block',
      visibility: 'hidden',
      text: PROMPT_EN,
    });
    expect(await g(page, (h) => h.getGameOverResult().prompt)).toBe(false);
    await page.locator('#gameover-back-button').click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('title');
    await expect(toggle(page)).toBeVisible();
    expect(await attention(page)).toBe(false);
  });

  test.describe('with the ranking submission form', () => {
    /** The third early run's GAME OVER on a board it gets onto: the modal is up and the board's answer is in. */
    async function offeredGameOver(page: Page): Promise<void> {
      // An empty board: the run is in range, and the form opens.
      await page.route('**/api/ranking', (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries: [], displayEntries: [] }) });
      });
      await presetLog(page, [1, 1]);
      await pinNormalSeed(page, 1);
      await open(page);
      await start(page);
      await claimSmallBox(page);
      await loseAllLivesToIgniter(page, 90_000);
      await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 3_000, FRAME_MS);
      // The clock stays where the modal opened while the board's answer
      // comes in: the form is decided on, and waits for the result to be read.
      await expect.poll(async () => (await rankingOffer(page)).waiting).toBe(true);
      expect(await g(page, (h) => h.getPlayLog().map((r) => r.stage))).toEqual([1, 1, 1]);
    }

    /** offeredGameOver(), then the suggestion on screen with nothing over it, then the form over it. */
    async function promptThenForm(page: Page): Promise<void> {
      await offeredGameOver(page);
      expect(await g(page, (h) => h.getGameOverResult().prompt)).toBe(false);
      await advanceUntil(page, () => prompt(page).isVisible(), 2_000, FRAME_MS);
      await expect(page.locator('#ranking-submit-panel')).toBeHidden();
      await expectPrompt(page);
      await advanceToSubmissionPanel(page);
      expect(await g(page, (h) => h.getGameOverResult().prompt)).toBe(true);
    }

    test('the suggestion seen, then the form over it: TITLE from the form lights the toggle', async ({ page }) => {
      await promptThenForm(page);
      await page.locator('#ranking-submit-title-button').click();
      await page.clock.runFor(100);
      expect(await status(page)).toBe('title');
      await expect(toggle(page)).toBeVisible();
      expect(await attention(page)).toBe(true);
    });

    test('the modal TITLE before the suggestion appears, the form waiting: lights nothing', async ({ page }) => {
      await offeredGameOver(page);
      await page.clock.runFor(Math.ceil((GUARD_TICKS + 2) * TICK_MS));
      expect(await g(page, (h) => h.getGameOverResult().prompt)).toBe(false);
      expect((await rankingOffer(page)).waiting).toBe(true);
      await page.locator('#gameover-back-button').click();
      await page.clock.runFor(100);
      expect(await status(page)).toBe('title');
      await expect(toggle(page)).toBeVisible();
      expect(await attention(page)).toBe(false);
    });

    test('TITLE once the form is closed and the suggestion is on screen lights the toggle', async ({ page }) => {
      await promptThenForm(page);
      await page.locator('#ranking-submit-panel').getByRole('button', { name: 'SKIP', exact: true }).click();
      await page.clock.runFor(100);
      await expect(page.locator('#ranking-submit-panel')).toBeHidden();
      await expectPrompt(page);
      await page.locator('#gameover-back-button').click();
      await page.clock.runFor(100);
      expect(await status(page)).toBe('title');
      expect(await attention(page)).toBe(true);
    });
  });

  test('a kept NORMAL run that reached stage 4 starts the count again', async ({ page }) => {
    await failRankingCheck(page);
    await presetLog(page, [1, 1, 1, 1, 4]);
    await pinNormalSeed(page, 1);
    await open(page);
    await start(page);
    await shortRun(page);
    await expectHighlightOnly(page);
  });

  test('an EASY run in between neither counts nor breaks the streak, and never shows it', async ({ page }) => {
    await failRankingCheck(page);
    await presetLog(page, [1, 1]);
    await pinNormalSeed(page, 1);
    await open(page);
    await pick(page, 'easy');
    await start(page);
    await shortRun(page);
    await expect(prompt(page)).toBeHidden();
    await expect(highlight(page)).toBeVisible();
    expect(await g(page, (h) => h.getPlayLog())).toHaveLength(2);
    await leaveGameOver(page, 'title');
    expect(await attention(page)).toBe(false);
    await pick(page, 'normal');
    await start(page);
    await shortRun(page);
    await expectPrompt(page);
  });

  test('a `?seed=` run in between neither counts nor breaks the streak, and never shows it', async ({ page }) => {
    await failRankingCheck(page);
    await presetLog(page, [1, 1]);
    await open(page, '?seed=1');
    await start(page);
    await shortRun(page);
    await expect(prompt(page)).toBeHidden();
    expect(await g(page, (h) => h.getPlayLog())).toHaveLength(2);
    await pinNormalSeed(page, 1);
    await open(page);
    await start(page);
    await shortRun(page);
    await expectPrompt(page);
  });

  test.describe('in Japanese', () => {
    test.use({ locale: 'ja-JP' });

    test('reads in Japanese', async ({ page }) => {
      await failRankingCheck(page);
      await presetLog(page, [1, 1]);
      await pinNormalSeed(page, 1);
      await open(page, '?lang=ja');
      await start(page);
      await shortRun(page);
      await expectPrompt(page, PROMPT_JA);
    });
  });
});

/** The modal's boxes for the fit checks. */
async function modalBoxes(page: Page) {
  return boxesOf(page, [
    '#game-canvas',
    '#gameover-modal',
    '#gameover-retry-button',
    '#gameover-back-button',
    '#gameover-share-button',
    '#gameover-easy-prompt',
    '#gameover-easy-prompt-text',
    '#gameover-highlight',
    '#gameover-to-best',
  ]);
}

/** tests/e2e/goals-and-retry.spec.ts's expectModalFits(): the modal on the field, its three buttons at least 44px tall and on screen. */
function expectModalFits(b: Record<string, Box | null>, viewport: { width: number; height: number }, label: string): void {
  expect(inside(b['#gameover-modal']!, b['#game-canvas']!), `${label}: the modal on the field`).toBe(true);
  for (const id of ['#gameover-retry-button', '#gameover-back-button', '#gameover-share-button']) {
    const button = b[id]!;
    expect(button, `${label} ${id}`).not.toBeNull();
    expect(button.height, `${label} ${id}`).toBeGreaterThanOrEqual(44);
    expect(inside(button, { left: 0, top: 0, right: viewport.width, bottom: viewport.height, width: 0, height: 0 }), `${label} ${id}`).toBe(true);
  }
}

/** The suggestion on one line, inside the modal. */
async function expectPromptOneLine(page: Page, b: Record<string, Box | null>, label: string): Promise<void> {
  const rects = await page.locator('#gameover-easy-prompt-text').evaluate((el) => el.getClientRects().length);
  expect(rects, `${label}: one line`).toBe(1);
  const line = b['#gameover-easy-prompt']!;
  const text = b['#gameover-easy-prompt-text']!;
  expect(inside(text, b['#gameover-modal']!), `${label}: the text in the modal`).toBe(true);
  expect(inside(line, b['#gameover-modal']!), `${label}: the line in the modal`).toBe(true);
  expect(text.width, `${label}: no overflow`).toBeLessThanOrEqual(line.width + 0.5);
  expect(await page.locator('#gameover-easy-prompt').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), label).toBe(true);
}

for (const layout of LAYOUTS) {
  for (const lang of ['en', 'ja'] as const) {
    test(`the suggestion fits at ${layout.name} (${lang}), no taller than the highlight`, async ({ browser }) => {
      // One page: the second early run shows the highlight, the third the
      // suggestion — both with a claim and the distance to the stored best.
      const context = await contextFor(browser, layout, lang === 'ja' ? 'ja-JP' : 'en-US');
      const page = await context.newPage();
      await failRankingCheck(page);
      await preset(page, HIGH_SCORE_KEY, '999999');
      await presetLog(page, [1]);
      await pinNormalSeed(page, 1);
      await open(page, `?lang=${lang}`);
      await start(page);
      await shortRun(page);
      await expectHighlightOnly(page);
      await expect(page.locator('#gameover-to-best')).toBeVisible();
      const withHighlight = await modalBoxes(page);
      expectModalFits(withHighlight, layout.viewport, `${layout.name} highlight`);
      await leaveGameOver(page, 'retry');
      await shortRun(page);
      await expectPrompt(page, lang === 'ja' ? PROMPT_JA : PROMPT_EN);
      await expect(page.locator('#gameover-to-best')).toBeVisible();
      const withPrompt = await modalBoxes(page);
      expectModalFits(withPrompt, layout.viewport, `${layout.name} suggestion`);
      await expectPromptOneLine(page, withPrompt, layout.name);
      expect(withPrompt['#gameover-modal']!.height).toBeLessThanOrEqual(withHighlight['#gameover-modal']!.height + 0.5);
      // In the highlight's place, and no taller than its line.
      expect(Math.abs(withPrompt['#gameover-easy-prompt']!.top - withHighlight['#gameover-highlight']!.top)).toBeLessThanOrEqual(0.5);
      expect(withPrompt['#gameover-easy-prompt']!.height).toBeLessThanOrEqual(withHighlight['#gameover-highlight']!.height + 0.5);
      await context.close();
    });
  }
}

/**
 * A kept run with a claim, played out to TIME UP!: the small box, off it
 * along the top border, then held there until the time runs out — no debug
 * override.
 */
async function timeUpRun(page: Page): Promise<void> {
  await claimSmallBox(page);
  await holdUntil(page, 'ArrowRight', async () => (await marker(page)).x >= 70);
  expect((await marker(page)).y).toBe(0);
  await playOutTheTime(page);
  expect(await g(page, (h) => h.session.isRunTainted())).toBe(false);
  await expect(page.locator('#gameover-reason')).toHaveText('TIME UP!');
}

for (const layout of LAYOUTS.filter((l) => l.hasTouch)) {
  for (const lang of ['en', 'ja'] as const) {
    test(`TIME UP! with the suggestion fits at ${layout.name} (${lang}), no taller than TIME UP! with the highlight`, async ({ browser }) => {
      // One page: the second early run ends on TIME UP! with the highlight,
      // the third on TIME UP! with the suggestion — both with a claim and the
      // distance to the stored best.
      const context = await contextFor(browser, layout, lang === 'ja' ? 'ja-JP' : 'en-US');
      const page = await context.newPage();
      await failRankingCheck(page);
      await preset(page, HIGH_SCORE_KEY, '999999');
      await presetLog(page, [1]);
      await pinNormalSeed(page, 1);
      await open(page, `?lang=${lang}`);
      await start(page);
      await timeUpRun(page);
      await expectHighlightOnly(page);
      await expect(page.locator('#gameover-to-best')).toBeVisible();
      const withHighlight = await modalBoxes(page);
      expectModalFits(withHighlight, layout.viewport, `${layout.name} TIME UP! highlight`);
      await leaveGameOver(page, 'retry');
      await timeUpRun(page);
      expect(await g(page, (h) => h.getPlayLog().map((r) => r.end))).toEqual(['life', 'time', 'time']);
      await expectPrompt(page, lang === 'ja' ? PROMPT_JA : PROMPT_EN);
      await expect(page.locator('#gameover-to-best')).toBeVisible();
      const withPrompt = await modalBoxes(page);
      expectModalFits(withPrompt, layout.viewport, `${layout.name} TIME UP! suggestion`);
      await expectPromptOneLine(page, withPrompt, `${layout.name} TIME UP!`);
      expect(withPrompt['#gameover-modal']!.height).toBeLessThanOrEqual(withHighlight['#gameover-modal']!.height + 0.5);
      // In the highlight's place, and no taller than its line.
      expect(Math.abs(withPrompt['#gameover-easy-prompt']!.top - withHighlight['#gameover-highlight']!.top)).toBeLessThanOrEqual(0.5);
      expect(withPrompt['#gameover-easy-prompt']!.height).toBeLessThanOrEqual(withHighlight['#gameover-highlight']!.height + 0.5);
      await context.close();
    });
  }
}

