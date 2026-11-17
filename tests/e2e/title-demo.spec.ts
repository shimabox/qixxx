// The Title screen's demo (src/titleDemo.ts): one of the board's best runs
// replayed silently behind the title text. GET /api/ranking and
// /api/ranking/{id}/replay are mocked (as in tests/e2e/ranking.spec.ts) and
// the page runs on a faked, paused clock, so every wait is game time.
import { test, expect, type Page, type Route } from '@playwright/test';
import { GameSession } from '../../src/core/session';
import { encodeRle, type InputSample } from '../../src/core/rle';
import { RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../src/config';
import { advanceUntil, loseAllLivesToIgniter } from './support/fakeClock';

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 1000 / 60;

interface DemoProbe {
  state: string;
  shown: boolean;
  ticks: number | null;
  marker: { x: number; y: number } | null;
  veil: number;
}

interface LiveProbe {
  status: string;
  score: number;
  stage: number;
  lives: number;
  occupancy: number;
  remaining: number;
  marker: { x: number; y: number };
}

declare global {
  interface Window {
    __demoSounds__?: string[];
  }
}

type GameHook = {
  getTitleDemo: () => DemoProbe;
  session: {
    getStatus: () => string;
    getScore: () => number;
    getStage: () => number;
    getLives: () => number;
    getRemainingTicks: () => number;
    getGame: () => { getOccupancy: () => number; getMarker: () => { getPosition: () => { x: number; y: number } } };
  };
};

const demo = (page: Page) =>
  page.evaluate(() => (window as unknown as { __game__: GameHook }).__game__.getTitleDemo());

const live = (page: Page) =>
  page.evaluate((): LiveProbe => {
    const session = (window as unknown as { __game__: GameHook }).__game__.session;
    const game = session.getGame();
    const marker = game.getMarker().getPosition();
    return {
      status: session.getStatus(),
      score: session.getScore(),
      stage: session.getStage(),
      lives: session.getLives(),
      occupancy: game.getOccupancy(),
      remaining: session.getRemainingTicks(),
      marker: { x: marker.x, y: marker.y },
    };
  });

/**
 * A recorded run for the mocked replay: it sweeps the field in strips,
 * drawing a line down and up and stepping along the border between them (so
 * it claims area and the marker keeps moving), then stops after
 * `maxSamples` ticks. Auto-confirms STAGE CLEAR without recording it, as
 * ReplayEngine replays it.
 */
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
// Long enough to watch it play, short enough to reach its end in a test.
const DEMO_RLE = recordDemoReplay(DEMO_SEED, 600);
const DEMO_PAYLOAD = JSON.stringify({ seed: DEMO_SEED, rleBase64: DEMO_RLE, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION });

const SECRET_NAME = 'DEMOSECRETNAME';
const SECRET_HANDLE = 'demo_secret_handle';

interface Entry {
  id: string;
  createdAt: string;
  score: number;
  stage: number;
  name: string;
  xHandle: string | null;
  replayAvailable: boolean;
}

const entry = (id: string, score: number, replayAvailable = true, name = `RIVAL${id}`): Entry => ({
  id,
  createdAt: '2026-01-01T12:00:00Z',
  score,
  stage: 2,
  name,
  xHandle: null,
  replayAvailable,
});

/** A full board: a run scoring 0 is never offered submission, so GAME OVER needs no form. */
const fullBoard = (firstReplayable = true): Entry[] =>
  Array.from({ length: 10 }, (_, i) => ({
    ...entry(`row${i}`, 9000 - i * 100, i === 0 && firstReplayable, i === 0 ? SECRET_NAME : `RIVAL${i}`),
    xHandle: i === 0 ? SECRET_HANDLE : null,
  }));

async function mockBoard(page: Page, entries: Entry[] | 'fail'): Promise<void> {
  await page.route('**/api/ranking', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (entries === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' });
    const displayEntries = entries.map((e) => ({ ...e, status: 'verified' }));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries, displayEntries }),
    });
  });
}

/** Mocks /api/ranking/{id}/replay with `answer(id)` and returns the ids asked for, in order. */
async function mockReplays(page: Page, answer: (id: string, route: Route) => Promise<void> | void = (_id, route) => okReplay(route)): Promise<string[]> {
  const asked: string[] = [];
  await page.route('**/api/ranking/*/replay', async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]);
    asked.push(id);
    await answer(id, route);
  });
  return asked;
}

const okReplay = (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: DEMO_PAYLOAD });

/** Fixes the live run's seed (main.ts's generateNormalRunSeed()) without `?seed=`, as ranking.spec.ts does. */
async function fixLiveSeed(page: Page, seed: number): Promise<void> {
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

/**
 * Opens the page on a fake clock paused before it loads (so the time the
 * load takes plays no ticks) and lets the first frames run.
 */
async function open(page: Page, query = ''): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.goto(`${APP_URL}${query}`);
  await page.clock.runFor(100);
}

/** Advances one rendered frame at a time until the live run has played `n` more ticks (a frame plays at most one). */
async function runTicks(page: Page, n: number): Promise<void> {
  const played = () => page.evaluate(() => (window as unknown as { __game__: { session: { getTotalTicks: () => number } } }).__game__.session.getTotalTicks());
  const target = (await played()) + n;
  for (let frames = 0; frames < n * 3; frames++) {
    if ((await played()) >= target) return;
    await page.clock.runFor(16);
  }
  throw new Error(`runTicks: ${n} ticks did not play`);
}

/** Waits until the demo's board is up, then lets a frame draw it (the engine can land between frames). */
async function waitForDemo(page: Page, maxMs = 6000): Promise<void> {
  await advanceUntil(page, async () => (await demo(page)).shown, maxMs);
  await page.clock.runFor(FRAME_MS * 2);
}

/** Records every sound the page would play (window.__game__.sfx), so a test can assert there were none. */
async function recordSounds(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sounds: string[] = [];
    window.__demoSounds__ = sounds;
    const sfx = (window as unknown as { __game__: { sfx: Record<string, (...args: unknown[]) => unknown> } }).__game__.sfx;
    for (const name of ['handleEvents', 'playClaim', 'playSplitImpact', 'playTimeWarning']) {
      const original = sfx[name].bind(sfx);
      sfx[name] = (...args: unknown[]) => {
        const events = args[0];
        if (name !== 'handleEvents' || (Array.isArray(events) && events.length > 0)) sounds.push(name);
        return original(...args);
      };
    }
    const setDrawing = sfx.setDrawing.bind(sfx);
    sfx.setDrawing = (drawing: unknown, speed: unknown) => {
      if (drawing) sounds.push('setDrawing');
      return setDrawing(drawing, speed);
    };
  });
}

const fieldBox = (page: Page) =>
  page.evaluate(() => {
    const r = document.getElementById('game-canvas')!.getBoundingClientRect();
    return { width: r.width, height: r.height, left: r.left, top: r.top };
  });

const hudMode = (page: Page) =>
  page.evaluate(() => ['hud-line1', 'hud-line2', 'hud-line3'].map((id) => document.getElementById(id)!.style.display));

test.describe('title demo', () => {
  test('plays a top run behind the Title screen under the veil and the DEMO tag, silently, with the live HUD and no name', async ({ page }) => {
    await mockBoard(page, fullBoard());
    const asked = await mockReplays(page);
    await open(page);
    await recordSounds(page);
    const hudBefore = await page.locator('#hud').innerText();
    const fieldBefore = await fieldBox(page);
    const modeBefore = await hudMode(page);
    expect(hudBefore).toContain('SCORE 0');
    expect(hudBefore).toContain('0%/65%');
    // The still board until the demo starts: no tag, no veil.
    await page.clock.runFor(500);
    expect((await demo(page)).shown).toBe(false);
    await expect(page.locator('#title-demo-label')).toBeHidden();

    await waitForDemo(page);
    expect(asked).toEqual(['row0']);
    await page.clock.runFor(FRAME_MS * 2);
    const first = await demo(page);
    expect(first.veil).toBeCloseTo(0.55, 5);
    await expect(page.locator('#title-demo-label')).toBeVisible();
    await expect(page.locator('#title-demo-label')).toHaveText('DEMO');
    expect(await page.locator('#title-demo-label').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

    await page.clock.runFor(2000);
    const later = await demo(page);
    expect(later.shown).toBe(true);
    expect(later.ticks!).toBeGreaterThan(first.ticks! + 60);
    expect(later.marker).not.toEqual(first.marker);

    // The HUD is still the live run's, and the field and the HUD lines kept their layout.
    expect(await page.locator('#hud').innerText()).toBe(hudBefore);
    expect(await fieldBox(page)).toEqual(fieldBefore);
    expect(await hudMode(page)).toEqual(modeBefore);
    expect((await live(page)).status).toBe('title');
    // Nothing of the record's owner is on the page.
    const text = await page.locator('body').innerText();
    expect(text).not.toContain(SECRET_NAME);
    expect(text).not.toContain(SECRET_HANDLE);
    expect(text).not.toContain('#1');
    // And not a sound.
    expect(await page.evaluate(() => window.__demoSounds__)).toEqual([]);
  });

  test('an Enter during the demo starts the very run a page without the demo starts, with the live board unveiled', async ({ browser }) => {
    const LIVE_SEED = 4242;
    const runOnce = async (withDemo: boolean) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await fixLiveSeed(page, LIVE_SEED);
      await mockBoard(page, withDemo ? fullBoard() : []);
      await mockReplays(page);
      await open(page);
      await page.clock.runFor(3000);
      expect((await demo(page)).shown).toBe(withDemo);
      await page.keyboard.press('Enter');
      await advanceUntil(page, async () => (await live(page)).status === 'playing', 500, 16);
      const start = await live(page);
      const afterStart = await demo(page);
      expect(afterStart.shown).toBe(false);
      expect(afterStart.veil).toBe(0);
      await expect(page.locator('#title-demo-label')).toBeHidden();
      // The same few moves on both pages, each held for a fixed number of
      // played ticks (the wall-clock time the page took to load shifts where
      // the ticks fall within a stretch of game time).
      await page.keyboard.down('ArrowLeft');
      await runTicks(page, 24);
      await page.keyboard.up('ArrowLeft');
      await page.keyboard.down('KeyX');
      await page.keyboard.down('ArrowDown');
      await runTicks(page, 18);
      await page.keyboard.up('ArrowDown');
      await page.keyboard.down('ArrowLeft');
      await runTicks(page, 18);
      await page.keyboard.up('ArrowLeft');
      await page.keyboard.down('ArrowUp');
      await runTicks(page, 24);
      await page.keyboard.up('ArrowUp');
      await page.keyboard.up('KeyX');
      await runTicks(page, 60);
      const after = await live(page);
      await context.close();
      return { start, after };
    };
    const withDemo = await runOnce(true);
    const without = await runOnce(false);
    expect(withDemo.start).toEqual(without.start);
    expect(withDemo.after).toEqual(without.after);
    expect(withDemo.after.marker).not.toEqual(withDemo.start.marker);
  });

  test('an Enter while the replay is still loading starts the run at once, and the late answer changes nothing', async ({ page }) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await mockBoard(page, fullBoard());
    const asked = await mockReplays(page, async (_id, route) => {
      await released;
      await okReplay(route);
    });
    await open(page);
    await advanceUntil(page, async () => asked.length > 0, 3000);
    expect((await demo(page)).state).toBe('preparing');
    await page.keyboard.press('Enter');
    await page.clock.runFor(FRAME_MS * 2);
    expect((await live(page)).status).toBe('playing');
    const before = await live(page);
    const hud = async () => (await page.locator('#hud').innerText()).replace(/TIME \S+/, 'TIME');
    const hudBefore = await hud();

    release();
    await page.clock.runFor(1500);
    const after = await live(page);
    expect(after.status).toBe('playing');
    expect(after.marker).toEqual(before.marker);
    expect(after.score).toBe(before.score);
    expect(after.remaining).toBeLessThan(before.remaining);
    expect(await hud()).toBe(hudBefore);
    const state = await demo(page);
    expect(state.shown).toBe(false);
    expect(state.veil).toBe(0);
    await expect(page.locator('#title-demo-label')).toBeHidden();
    expect(asked).toEqual(['row0']);
  });

  test('back on Title after a GAME OVER, the demo plays again from the start without asking for the replay again', async ({ page }) => {
    await mockBoard(page, fullBoard());
    const asked = await mockReplays(page);
    await open(page);
    await waitForDemo(page);
    await page.clock.runFor(1000);
    const before = (await demo(page)).ticks!;
    expect(before).toBeGreaterThan(30);
    await page.keyboard.press('Enter');
    await page.clock.runFor(FRAME_MS * 2);
    await loseAllLivesToIgniter(page);
    await advanceUntil(page, () => page.locator('#gameover-back-button').isVisible(), 5000);
    await page.clock.runFor(1000);
    await page.locator('#gameover-back-button').click();
    await advanceUntil(page, async () => (await live(page)).status === 'title', 2000);
    expect((await demo(page)).shown).toBe(false);
    await waitForDemo(page);
    // From the start, not resumed: how many ticks the wait itself lets play
    // varies with when the replay's answer lands, so compare with a margin.
    const again = (await demo(page)).ticks!;
    expect(again).toBeLessThan(20);
    expect(again).toBeLessThan(before);
    await expect(page.locator('#title-demo-label')).toBeVisible();
    expect(asked).toEqual(['row0']);
  });

  test('the end of the record holds its last board, then plays it again from the start without a new request', async ({ page }) => {
    await mockBoard(page, fullBoard());
    const asked = await mockReplays(page);
    await open(page);
    await waitForDemo(page);
    await advanceUntil(page, async () => (await demo(page)).state === 'ended', 20_000, 250);
    const end = await demo(page);
    expect(end.shown).toBe(true);
    await page.clock.runFor(1000); // within the 2s end hold
    expect(await demo(page)).toMatchObject({ state: 'ended', shown: true, ticks: end.ticks, marker: end.marker });
    await advanceUntil(page, async () => (await demo(page)).state === 'playing', 4000);
    expect((await demo(page)).ticks!).toBeLessThan(end.ticks!);
    await expect(page.locator('#title-demo-label')).toBeVisible();
    expect(asked).toEqual(['row0']);
  });

  test('a ranking REPLAY plays as before, with no veil or tag; leaving it brings the demo back', async ({ page }) => {
    await mockBoard(page, fullBoard());
    const asked = await mockReplays(page);
    await open(page);
    await waitForDemo(page);
    await page.clock.runFor(1000);
    const before = (await demo(page)).ticks!;
    expect(before).toBeGreaterThan(30);
    await page.locator('#ranking-button').click();
    await page.clock.runFor(200);
    await page.getByRole('button', { name: 'REPLAY' }).first().click();
    await advanceUntil(page, () => page.locator('#replay-stage-label').isVisible(), 3000);
    await page.clock.runFor(500);
    const during = await demo(page);
    expect(during.shown).toBe(false);
    expect(during.veil).toBe(0);
    await expect(page.locator('#title-demo-label')).toBeHidden();
    await page.getByRole('button', { name: 'EXIT' }).click();
    await page.clock.runFor(200);
    await expect(page.getByRole('button', { name: 'CLOSE' })).toBeVisible(); // EXIT goes back to the list
    await waitForDemo(page);
    // From the start, not resumed (with a margin for the wait itself, as above).
    const again = (await demo(page)).ticks!;
    expect(again).toBeLessThan(20);
    expect(again).toBeLessThan(before);
    // The demo's one request and the ranking REPLAY's own.
    expect(asked).toEqual(['row0', 'row0']);
  });

  test('tries the next candidate when the first replay is missing', async ({ page }) => {
    const board = fullBoard();
    board[1] = { ...board[1], replayAvailable: true };
    await mockBoard(page, board);
    const asked = await mockReplays(page, (id, route) =>
      id === 'row0' ? route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' }) : okReplay(route)
    );
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await open(page);
    await waitForDemo(page);
    expect(asked).toEqual(['row0', 'row1']);
    await expect(page.locator('#title-demo-label')).toBeVisible();
    expect(errors).toEqual([]);
  });

  const stillCases: { name: string; board: Entry[] | 'fail'; replay?: (route: Route) => Promise<void> }[] = [
    { name: 'the board fails to load', board: 'fail' },
    { name: 'the board is empty', board: [] },
    { name: 'no row has a replay', board: fullBoard(false) },
    { name: 'the replay is 404', board: fullBoard(), replay: (route) => route.fulfill({ status: 404, body: '{}' }) },
    { name: 'the replay is 410', board: fullBoard(), replay: (route) => route.fulfill({ status: 410, contentType: 'application/json', body: '{"error":"gone"}' }) },
    { name: 'the replay is broken', board: fullBoard(), replay: (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"seed":' }) },
    {
      name: 'the replay cannot be decoded',
      board: fullBoard(),
      replay: (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ seed: 1, rleBase64: '!!!not-base64!!!', rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
        }),
    },
  ];
  for (const c of stillCases) {
    test(`keeps the still Title board, silently, when ${c.name}`, async ({ page }) => {
      await mockBoard(page, c.board);
      const asked = await mockReplays(page, (_id, route) => (c.replay ?? okReplay)(route));
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await open(page);
      const textBefore = await page.locator('body').innerText();
      await page.clock.runFor(5000);
      const state = await demo(page);
      expect(state.shown).toBe(false);
      expect(state.veil).toBe(0);
      await expect(page.locator('#title-demo-label')).toBeHidden();
      expect(await page.locator('body').innerText()).toBe(textBefore);
      expect(errors).toEqual([]);
      if (c.replay) {
        expect(asked).toEqual(['row0']);
        expect(state.state).toBe('off');
      } else {
        expect(asked).toEqual([]);
      }
    });
  }

  test('with reduced motion there is no demo and no replay request', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockBoard(page, fullBoard());
    const asked = await mockReplays(page);
    await open(page);
    await page.clock.runFor(5000);
    expect((await demo(page)).shown).toBe(false);
    await expect(page.locator('#title-demo-label')).toBeHidden();
    expect(asked).toEqual([]);
  });

  test('a ?seed= page has no demo and no replay request', async ({ page }) => {
    await mockBoard(page, fullBoard());
    const asked = await mockReplays(page);
    await open(page, '?seed=123');
    await page.clock.runFor(5000);
    expect((await demo(page)).shown).toBe(false);
    await expect(page.locator('#title-demo-label')).toBeHidden();
    expect(asked).toEqual([]);
  });
});

// The DEMO tag sits inside the field's box, clear of the title text and both
// Title buttons, on every supported shape; the field and the HUD lines keep
// the layout they have without the demo.
const LAYOUTS = [
  { viewport: { width: 1280, height: 800 }, hasTouch: false, field: { width: 1021, height: 766, left: 129.5, top: 34 } },
  { viewport: { width: 390, height: 844 }, hasTouch: true, field: { width: 390, height: 292, left: 0, top: 190 } },
  { viewport: { width: 844, height: 390 }, hasTouch: true, field: { width: 380, height: 285, left: 232, top: 82.5 } },
  { viewport: { width: 667, height: 375 }, hasTouch: true, field: { width: 203, height: 152, left: 232, top: 132.5 } },
];
for (const c of LAYOUTS) {
  for (const locale of ['en-US', 'ja-JP']) {
    test(`the DEMO tag at ${c.viewport.width}x${c.viewport.height} (${locale}) stays on the field, clear of the title text and buttons`, async ({ browser }) => {
      const context = await browser.newContext({ locale, viewport: c.viewport, hasTouch: c.hasTouch });
      const page = await context.newPage();
      await mockBoard(page, fullBoard());
      await mockReplays(page);
      await open(page);
      const modeBefore = await hudMode(page);
      await waitForDemo(page);
      await page.clock.runFor(FRAME_MS * 2);
      expect(await fieldBox(page)).toEqual(c.field);
      expect(await hudMode(page)).toEqual(modeBefore);
      const boxes = await page.evaluate(() => {
        const r = (id: string) => {
          const b = document.getElementById(id)!.getBoundingClientRect();
          return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
        };
        return {
          field: r('game-canvas'),
          label: r('title-demo-label'),
          fontSize: getComputedStyle(document.getElementById('title-demo-label')!).fontSize,
          others: { screen: r('screen'), howToPlay: r('how-to-play-button'), ranking: r('ranking-button') },
        };
      });
      expect(boxes.label.left).toBeGreaterThanOrEqual(boxes.field.left);
      expect(boxes.label.top).toBeGreaterThanOrEqual(boxes.field.top);
      expect(boxes.label.right).toBeLessThanOrEqual(boxes.field.right);
      expect(boxes.label.bottom).toBeLessThanOrEqual(boxes.field.bottom);
      // In the bottom-left corner.
      expect(boxes.label.left - boxes.field.left).toBeLessThan(20);
      expect(boxes.field.bottom - boxes.label.bottom).toBeLessThan(20);
      expect(boxes.fontSize).toBe(c.field.height < 200 ? '10px' : '12px');
      for (const [name, other] of Object.entries(boxes.others)) {
        const overlaps =
          boxes.label.left < other.right && other.left < boxes.label.right && boxes.label.top < other.bottom && other.top < boxes.label.bottom;
        expect(overlaps, `DEMO overlaps ${name}`).toBe(false);
      }
      await context.close();
    });
  }
}
