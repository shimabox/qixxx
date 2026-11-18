// The on-device play log (src/playLog/, src/storage/playLog.ts) and the debug
// panel's PLAY LOG section (src/debug/panel.ts): which runs are kept in
// localStorage's qixxx.playLog and with what, that keeping them changes
// nothing about the run or the screen, and the panel's summary, EXPORT LOG
// and CLEAR LOG. Everything runs on a faked page clock
// (tests/e2e/support/fakeClock.ts), so budgets are game time.
import { test, expect, type Browser, type Page } from '@playwright/test';
import { GameSession } from '../../src/core/session';
import { encodeRle, type InputSample } from '../../src/core/rle';
import { INITIAL_LIVES, RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../src/config';
import type { PlayLogFile, PlayRecord } from '../../src/playLog/record';
import { advanceUntil, loseAllLivesToIgniter } from './support/fakeClock';

interface Point {
  x: number;
  y: number;
}

declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getStage: () => number;
        getScore: () => number;
        getLives: () => number;
        getTotalTicks: () => number;
        getGameOverReason: () => 'life' | 'time' | null;
        isRunTainted: () => boolean;
        setDebugTimeLimitTicks: (ticks: number) => void;
        getGame: () => { getMarker: () => { getPosition: () => Point } };
      };
      getPlayLog: () => PlayRecord[];
      getConfirmCount: () => number;
      getTitleDemo: () => { state: string };
    };
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const TICK_MS = 1000 / 60;
const GUARD_TICKS = 24; // RETRY_CONFIRM_GUARD_TICKS
const KEY = 'qixxx.playLog';

const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());
const marker = (page: Page) => page.evaluate(() => window.__game__!.session.getGame().getMarker().getPosition());
const playLog = (page: Page) => page.evaluate(() => window.__game__!.getPlayLog());
const storedLog = (page: Page) =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as PlayLogFile);
  }, KEY);

/** What the live session says about the run that just ended. */
const result = (page: Page) =>
  page.evaluate(() => {
    const s = window.__game__!.session;
    return { stage: s.getStage(), score: s.getScore(), lives: s.getLives(), ticks: s.getTotalTicks(), end: s.getGameOverReason(), tainted: s.isRunTainted() };
  });

const missTotal = (record: PlayRecord) => record.stages.reduce((n, s) => n + s.misses.wisp + s.misses.ember + s.misses.igniter, 0);

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

/** Stores `value` under qixxx.playLog before the page's own scripts run. */
async function presetLog(page: Page, value: string): Promise<void> {
  await page.addInitScript(([key, raw]) => localStorage.setItem(key, raw), [KEY, value] as const);
}

async function open(page: Page, query = ''): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
}

async function start(page: Page): Promise<void> {
  await page.keyboard.press('Space'); // Title -> Playing
  await page.clock.runFor(100);
  expect(await status(page)).toBe('playing');
}

/** Plays the run out on lives (no debug override) and waits for the GAME OVER modal. */
async function endOnLives(page: Page): Promise<void> {
  await loseAllLivesToIgniter(page);
  await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 3_000, 100);
}

/** From the GAME OVER modal, past its confirm guard, into the next run. */
async function retry(page: Page): Promise<void> {
  await page.clock.runFor(Math.ceil((GUARD_TICKS + 2) * TICK_MS));
  await page.locator('#gameover-retry-button').click();
  await page.clock.runFor(100);
  expect(await status(page)).toBe('playing');
}

/** Ends the run on TIME UP within a few ticks (a debug override: the run is tainted). */
async function timeUpSoon(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = window.__game__!.session;
    s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
  });
  await advanceUntil(page, async () => (await status(page)) === 'gameover', 1_000, FRAME_MS);
  await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 3_000, FRAME_MS);
}

async function holdUntil(page: Page, key: string, done: () => Promise<boolean>): Promise<void> {
  await page.keyboard.down(key);
  await advanceUntil(page, done, 2_000, FRAME_MS);
  await page.keyboard.up(key);
}

/**
 * Plays a run out to TIME UP with no debug override: from the top border,
 * draw a short U into the field (down, left, back up part of the way), then
 * keep pushing right into the line's own first leg. A held direction keeps
 * the Igniter away even though the marker cannot move, and Embers walk only
 * the border, so the marker sits it out until the time runs out.
 */
async function playOutTheTime(page: Page): Promise<void> {
  const from = await marker(page);
  await page.keyboard.down('KeyX');
  await holdUntil(page, 'ArrowDown', async () => (await marker(page)).y >= from.y + 4);
  await holdUntil(page, 'ArrowLeft', async () => (await marker(page)).x <= from.x - 2);
  await holdUntil(page, 'ArrowUp', async () => (await marker(page)).y <= from.y + 2);
  await page.keyboard.down('ArrowRight');
  // Three minutes of play: jumped through a quarter second at a time, so each
  // drawn frame runs the most ticks the game loop allows (MAX_FRAME_DELTA)
  // instead of drawing every one of them.
  for (let jumps = 0; jumps < 1_000; jumps++) {
    if (jumps % 40 === 0 && (await status(page)) === 'gameover') break;
    await page.clock.fastForward(250);
  }
  expect(await status(page)).toBe('gameover');
  await page.keyboard.up('ArrowRight');
  await page.keyboard.up('KeyX');
  await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 3_000, 100);
}

function sampleRecord(i: number): PlayRecord {
  const stage = (i % 4) + 1;
  return {
    endedAt: 1_700_000_000_000 + i * 60_000,
    stage,
    score: 100 * i + 7,
    end: i % 3 === 0 ? 'time' : 'life',
    ticks: 3000 + i,
    stages: Array.from({ length: stage }, (_, k) => ({
      stage: k + 1,
      claims: (i + k) % 5,
      splits: k === 0 && i % 2 === 0 ? 1 : 0,
      misses: { wisp: k === stage - 1 ? 2 : 0, ember: i % 2, igniter: k === stage - 1 ? 1 : 0 },
      cleared: k < stage - 1,
    })),
  };
}

const fileOf = (count: number): PlayLogFile => ({ v: 1, runs: Array.from({ length: count }, (_, i) => sampleRecord(i)) });

test.describe('a finished run is kept on this device', () => {
  test('a normal run lost on lives adds one matching record, and a retry adds one more; nothing new is requested', async ({ page }) => {
    const requests: string[] = [];
    await pinNormalSeed(page, 7);
    await open(page);
    expect(await storedLog(page)).toBeNull();
    expect(await playLog(page)).toEqual([]);
    page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`));

    await start(page);
    await endOnLives(page);
    const first = await result(page);
    expect(first).toMatchObject({ end: 'life', lives: 0, tainted: false });
    const stored = await storedLog(page);
    expect(stored?.v).toBe(1);
    expect(stored?.runs).toHaveLength(1);
    const [record] = stored!.runs;
    expect(record).toMatchObject({ stage: first.stage, score: first.score, end: 'life' });
    expect(missTotal(record)).toBe(INITIAL_LIVES);
    expect(record.stages.map((s) => s.stage)).toEqual(Array.from({ length: first.stage }, (_, i) => i + 1));
    expect(record.ticks).toBeGreaterThanOrEqual(first.ticks);
    expect(await playLog(page)).toEqual(stored!.runs);

    // Playing a run out talks to nothing but the ranking's GET (the board read
    // for the GAME OVER offer): everything else is the dev server's own modules.
    const origin = new URL(APP_URL).origin;
    for (const entry of requests) {
      const [method, url] = entry.split(' ');
      const parsed = new URL(url);
      expect(parsed.origin, entry).toBe(origin);
      const devModule = /^\/(src|node_modules|@vite|@fs|@id)\//.test(parsed.pathname);
      expect(devModule || (method === 'GET' && parsed.pathname === '/api/ranking'), entry).toBe(true);
    }

    // The modal staying up for a while adds nothing more.
    await page.clock.runFor(2_000);
    expect((await storedLog(page))?.runs).toHaveLength(1);

    await retry(page);
    await endOnLives(page);
    const second = await result(page);
    const runs = (await storedLog(page))!.runs;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual(record);
    expect(runs[1]).toMatchObject({ stage: second.stage, score: second.score, end: 'life' });
    expect(missTotal(runs[1])).toBe(INITIAL_LIVES);
    expect(runs[1].endedAt).toBeGreaterThan(runs[0].endedAt);
  });

  test('a normal run that runs out of time is kept with end "time"', async ({ page }) => {
    await pinNormalSeed(page, 3);
    await open(page);
    await start(page);
    await playOutTheTime(page);
    const end = await result(page);
    expect(end).toMatchObject({ end: 'time', tainted: false });
    expect(end.lives).toBeGreaterThan(0);
    const runs = (await storedLog(page))!.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ stage: end.stage, score: end.score, end: 'time' });
    expect(missTotal(runs[0])).toBe(INITIAL_LIVES - end.lives);
  });

  test('a run started from PLAY WITH HINTS is kept', async ({ page }) => {
    await open(page);
    await page.locator('#how-to-play-button').click();
    await expect(page.locator('#how-to-play')).toBeVisible();
    await page.locator('#how-to-play-with-hints').click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('playing');
    await endOnLives(page);
    const end = await result(page);
    const runs = (await storedLog(page))!.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ stage: end.stage, score: end.score, end: 'life' });
  });
});

test.describe('runs that are not kept', () => {
  test('a `?seed=` run is not kept', async ({ page }) => {
    await open(page, '?seed=1');
    await start(page);
    await endOnLives(page);
    expect((await result(page)).tainted).toBe(false);
    expect(await storedLog(page)).toBeNull();
    expect(await playLog(page)).toEqual([]);
  });

  test('a run with a debug panel override is not kept', async ({ page }) => {
    await open(page, '?debug');
    const timeLimit = page.locator('#debug-time-limit-input');
    await expect(timeLimit).toBeVisible();
    await timeLimit.evaluate((el: HTMLInputElement) => {
      el.value = el.min;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await start(page);
    await advanceUntil(page, async () => (await status(page)) === 'gameover', 10_000, 250);
    expect((await result(page)).tainted).toBe(true);
    expect(await storedLog(page)).toBeNull();
    await expect(page.locator('#debug-play-log-summary')).toHaveText('NO RUNS YET');
  });

  test('the Title demo and a ranking replay played to its GAME OVER are not kept', async ({ page }) => {
    const seed = 4242;
    const rleBase64 = recordIgniterLossReplay(seed);
    await page.route('**/api/ranking', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const entries = [{ id: 'r', createdAt: '2026-01-01T00:00:00Z', score: 0, stage: 1, name: 'REPLAYED', xHandle: null, replayAvailable: true }];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries, displayEntries: entries.map((e) => ({ ...e, status: 'verified' })) }),
      });
    });
    await page.route('**/api/ranking/*/replay', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
      })
    );
    await open(page);

    // The Title demo plays to its end on the Title screen.
    await advanceUntil(page, async () => (await page.evaluate(() => window.__game__!.getTitleDemo().state)) === 'ended', 30_000, 500);
    expect(await storedLog(page)).toBeNull();

    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();
    await advanceUntil(page, async () => page.getByRole('button', { name: 'EXIT' }).isVisible(), 3_000, 100);
    await advanceUntil(page, async () => ((await page.locator('#screen').textContent()) ?? '').includes('GAME OVER - REPLAY END'), 30_000, 500);
    await page.getByRole('button', { name: 'EXIT' }).click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('title');
    expect(await storedLog(page)).toBeNull();
    expect(await playLog(page)).toEqual([]);
  });
});

/** A short real-rules run lost on lives to the Igniter (one cell into the field, then still), base64 RLE for a mocked replay payload. */
function recordIgniterLossReplay(seed: number): string {
  const session = new GameSession({ seed });
  session.update({ dx: 0, dy: 0, drawHeld: false, slow: false, confirm: true });
  const samples: InputSample[] = [];
  while (session.getStatus() === 'playing' && samples.length < 5_000) {
    const game = session.getGame();
    const idle = !game.getMarker().isDrawing() && game.getGraceTicks() === 0;
    const input: InputSample = { dx: 0, dy: idle ? 1 : 0, drawHeld: true, slow: false };
    session.update({ ...input, confirm: false });
    session.drainEvents();
    samples.push(input);
  }
  expect(session.getStatus()).toBe('gameover');
  return Buffer.from(encodeRle(samples)).toString('base64');
}

/**
 * Installs, on the Title screen, a driver that plays the run out on lives with
 * its inputs keyed to the run's own ticks, so two pages get the same input on
 * the same tick however their clocks line up (at most one tick per frame at
 * the 16ms frames page.clock.runFor() draws): draw held throughout, and one
 * tick of Down — a one-cell stub into the field the Igniter then burns —
 * whenever the marker is back on the border and out of its post-miss grace.
 */
async function installLossDriver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const session = (window as unknown as {
      __game__: {
        session: {
          getStatus: () => string;
          getTotalTicks: () => number;
          getGame: () => { getMarker: () => { isDrawing: () => boolean }; getGraceTicks: () => number };
        };
      };
    }).__game__.session;
    const key = (code: string, down: boolean) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code }));
    let lastTick = -1;
    let drawing = false;
    let pulsing = false;
    const drive = () => {
      const status = session.getStatus();
      if (status === 'gameover') {
        if (pulsing) key('ArrowDown', false);
        if (drawing) key('KeyX', false);
        return;
      }
      const tick = session.getTotalTicks();
      if (status === 'playing' && tick !== lastTick) {
        lastTick = tick;
        if (!drawing) {
          key('KeyX', true);
          drawing = true;
        }
        const game = session.getGame();
        if (pulsing) {
          key('ArrowDown', false);
          pulsing = false;
        } else if (!game.getMarker().isDrawing() && game.getGraceTicks() === 0) {
          key('ArrowDown', true);
          pulsing = true;
        }
      }
      requestAnimationFrame(drive);
    };
    requestAnimationFrame(drive);
  });
}

test.describe('keeping the log never changes the run', () => {
  async function playScripted(browser: Browser, storageFails: boolean) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await pinNormalSeed(page, 11);
    if (storageFails) {
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException('full', 'QuotaExceededError');
        };
      });
    }
    await open(page);
    await installLossDriver(page);
    await start(page);
    await advanceUntil(page, async () => (await status(page)) === 'gameover', 60_000, 500);
    await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 3_000, 100);
    const end = await result(page);
    const kept = await playLog(page);
    const stored = await storedLog(page);
    await expect(page.locator('#gameover-modal')).toBeVisible();
    await retry(page);
    await context.close();
    return { end, kept, stored, errors };
  }

  test('the same seed and inputs end the same with a working storage and with one whose setItem throws', async ({ browser }) => {
    const working = await playScripted(browser, false);
    const failing = await playScripted(browser, true);
    expect(failing.end).toEqual(working.end);
    expect(working.end.end).toBe('life');
    expect(working.stored?.runs).toHaveLength(1);
    // Nothing could be written, but this page load still has the run.
    expect(failing.stored).toBeNull();
    expect(failing.kept).toHaveLength(1);
    expect({ ...failing.kept[0], endedAt: 0 }).toEqual({ ...working.kept[0], endedAt: 0 });
    expect(working.errors).toEqual([]);
    expect(failing.errors).toEqual([]);
  });

  test('a broken stored value is read as no runs and replaced by a sound one-run log', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await presetLog(page, '{not json');
    await open(page);
    expect(await playLog(page)).toEqual([]);
    await start(page);
    await endOnLives(page);
    const end = await result(page);
    const stored = await storedLog(page);
    expect(stored?.v).toBe(1);
    expect(stored?.runs).toHaveLength(1);
    expect(stored!.runs[0]).toMatchObject({ stage: end.stage, score: end.score, end: 'life' });
    expect(errors).toEqual([]);
  });
});

test.describe('the debug panel PLAY LOG section', () => {
  const summary = (page: Page) => page.locator('#debug-play-log-summary');

  test('shows NO RUNS YET, then the finished run while the panel stays open', async ({ page }) => {
    await open(page, '?debug');
    await expect(page.locator('#debug-play-log')).toContainText('PLAY LOG');
    await expect(summary(page)).toHaveText('NO RUNS YET');
    await start(page);
    await endOnLives(page);
    const end = await result(page);
    expect(end.tainted).toBe(false);
    const runs = (await storedLog(page))!.runs;
    expect(runs).toHaveLength(1);
    const [r] = runs;
    const claims = r.stages.reduce((n, s) => n + s.claims, 0);
    const splits = r.stages.reduce((n, s) => n + s.splits, 0);
    const expected = [
      'RUNS 1 / 50',
      'END STAGE',
      `  ST${r.stage} 1`,
      'END BY  LIFE 1  TIME 0',
      'MISSES',
      ...r.stages.flatMap((s) => [`  ST${s.stage}  (runs 1)`, `    WISP ${s.misses.wisp}  EMBER ${s.misses.ember}  IGNITER ${s.misses.igniter}`]),
      'SCORE',
      `  AVG ${r.score}  MED ${r.score}  MAX ${r.score}`,
      'PER RUN',
      `  CLAIMS ${claims.toFixed(1)}  SPLITS ${splits.toFixed(1)}`,
      `STREAK ≤ ST2  ${r.stage <= 2 ? 1 : 0}`,
    ];
    expect((await summary(page).textContent())?.split('\n')).toEqual(expected);
    expect(r).toMatchObject({ stage: end.stage, score: end.score, end: 'life' });
  });

  test('EXPORT LOG puts the stored log in the output box, CLEAR LOG forgets it; neither starts a run, and EXPORT is unchanged', async ({ page }) => {
    const file = fileOf(3);
    await presetLog(page, JSON.stringify(file));
    await open(page, '?debug');
    const output = page.locator('#debug-export-output');
    await expect(summary(page)).toContainText('RUNS 3 / 50');
    await expect(summary(page)).toContainText('END BY  LIFE 2  TIME 1');

    await page.locator('#debug-panel').getByRole('button', { name: 'EXPORT', exact: true }).click();
    const tuningWithRuns = await output.inputValue();
    expect(tuningWithRuns).not.toContain('runs');

    await page.locator('#debug-play-log-export').click();
    await page.clock.runFor(200);
    const exported = JSON.parse(await output.inputValue()) as PlayLogFile;
    expect(exported).toEqual(await storedLog(page));
    expect(exported).toEqual(file);

    await page.locator('#debug-play-log-clear').click();
    await page.clock.runFor(200);
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBeNull();
    await expect(summary(page)).toHaveText('NO RUNS YET');
    expect(await playLog(page)).toEqual([]);

    // The tuning EXPORT reads the same with or without kept runs.
    await page.locator('#debug-panel').getByRole('button', { name: 'EXPORT', exact: true }).click();
    expect(await output.inputValue()).toBe(tuningWithRuns);

    // Neither button reached the game as a confirm.
    expect(await status(page)).toBe('title');
    expect(await page.evaluate(() => window.__game__!.getConfirmCount())).toBe(0);
  });
});

// The screen without `?debug` is the same with no kept runs and with a full
// log: no PLAY LOG in the DOM, and every box in the same place.
const LAYOUTS = [
  { name: '1280x800', viewport: { width: 1280, height: 800 }, hasTouch: false },
  { name: '390x844 touch', viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: '844x390 touch', viewport: { width: 844, height: 390 }, hasTouch: true },
  { name: '667x375 touch', viewport: { width: 667, height: 375 }, hasTouch: true },
];
const BOXES = ['#game-canvas', '#hud-row', '#hud', '#hud-line1', '#hud-line2', '#hud-line3', '#touch-controls', '#touch-dpad', '#touch-actions', '#mute-button', '#gameover-modal'];

async function screenBoxes(page: Page) {
  return page.evaluate((selectors) => {
    const box = (el: Element) => {
      const b = el.getBoundingClientRect();
      return [b.left, b.top, b.width, b.height];
    };
    return {
      ids: [...document.querySelectorAll('[id]')].map((el) => el.id),
      boxes: selectors.map((s) => {
        const el = document.querySelector(s);
        return el ? [s, ...box(el)] : [s, null];
      }),
      buttons: [...document.querySelectorAll('#touch-controls button, #gameover-modal button')].map((el) => [el.textContent, ...box(el)]),
      playLog: document.querySelectorAll('#debug-play-log, #debug-play-log-export, #debug-play-log-clear').length,
      text: document.body.innerText.includes('PLAY LOG'),
    };
  }, BOXES);
}

async function snapshotScreens(browser: Browser, layout: (typeof LAYOUTS)[number], locale: string, runs: number) {
  const context = await browser.newContext({ viewport: layout.viewport, hasTouch: layout.hasTouch, isMobile: false, locale });
  const page = await context.newPage();
  await pinNormalSeed(page, 5);
  if (runs > 0) await presetLog(page, JSON.stringify(fileOf(runs)));
  await open(page);
  expect(await playLog(page)).toHaveLength(runs);
  const title = await screenBoxes(page);
  await start(page);
  await page.clock.runFor(500);
  const playing = await screenBoxes(page);
  await timeUpSoon(page);
  await page.clock.runFor(500);
  const gameover = await screenBoxes(page);
  await context.close();
  return { title, playing, gameover };
}

for (const layout of LAYOUTS) {
  for (const locale of ['en-US', 'ja-JP']) {
    test(`no PLAY LOG and the same layout with 0 and 50 kept runs at ${layout.name} (${locale})`, async ({ browser }) => {
      const none = await snapshotScreens(browser, layout, locale, 0);
      const full = await snapshotScreens(browser, layout, locale, 50);
      for (const screen of [none.title, none.playing, none.gameover, full.title, full.playing, full.gameover]) {
        expect(screen.playLog).toBe(0);
        expect(screen.text).toBe(false);
      }
      expect(full).toEqual(none);
      // The comparison saw the field, the modal and, on touch, the buttons.
      const size = (screen: Awaited<ReturnType<typeof screenBoxes>>, selector: string) => screen.boxes.find((b) => b[0] === selector)!.slice(3) as number[];
      expect(size(none.playing, '#game-canvas').every((n) => n > 0)).toBe(true);
      expect(size(none.gameover, '#gameover-modal').every((n) => n > 0)).toBe(true);
      if (layout.hasTouch) expect(size(none.playing, '#touch-dpad').every((n) => n > 0)).toBe(true);
    });
  }
}
