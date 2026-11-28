// When the ranking submission panel opens over the GAME OVER result, and what
// confirms do until then (src/gameOverResult.ts's submissionOfferAge(),
// src/ui/ranking.ts's DeferredSubmissionOffer, src/fx/liveTick.ts): the panel
// opens RANKING_OFFER_DELAY_TICKS after the result's last line is due, or as
// a late reply lands; while it waits, keys, field taps and the modal's RETRY
// start nothing, TITLE still works; a run that is not offered keeps the input
// timing it always had. GET /api/ranking is mocked. Everything runs on a faked
// page clock (tests/e2e/support/fakeClock.ts), so budgets are game time and
// the result's age is read from window.__game__, never the session's ticks.
import { test, expect, type Page } from '@playwright/test';
import { RANKING_OFFER_DELAY_TICKS, RULESET_VERSION } from '../../src/config';
import {
  advancePastOfferTime,
  advanceToSubmissionPanel,
  advanceUntil,
  gameOverTiming,
  loseAllLivesToIgniter,
  rankingOffer,
  runOneGameOverTick,
} from './support/fakeClock';

interface Point {
  x: number;
  y: number;
}

declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getScore: () => number;
        getTotalTicks: () => number;
        isRunTainted: () => boolean;
        setDebugTimeLimitTicks: (ticks: number) => void;
        getGame: () => { getMarker: () => { getPosition: () => Point } };
      };
      getConfirmCount: () => number;
      getGameOverResult: () => { active: boolean; score: number; finished: boolean; best: string | null };
    };
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const TICK_MS = 1000 / 60;
const GUARD_TICKS = 24; // RETRY_CONFIRM_GUARD_TICKS
const PANEL = '#ranking-submit-panel';

const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());
const marker = (page: Page) => page.evaluate(() => window.__game__!.session.getGame().getMarker().getPosition());
const score = (page: Page) => page.evaluate(() => window.__game__!.session.getScore());
const confirms = (page: Page) => page.evaluate(() => window.__game__!.getConfirmCount());

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

interface Board {
  /** GET /api/ranking requests seen so far. */
  gets: () => number;
  /** Of those, the ones answered so far. */
  answered: () => number;
  /** From now on, each GET waits until release(). */
  hold: () => void;
  release: () => void;
}

/**
 * GET /api/ranking: an empty board (every untainted NORMAL run is in range),
 * a full board whose 10th place the run ties ('tie', not offered), or a 503.
 */
async function mockBoard(page: Page, kind: 'open' | 'tie' | 'fail' = 'open'): Promise<Board> {
  let gets = 0;
  let answered = 0;
  let held = false;
  let release: () => void = () => {};
  let released = Promise.resolve();
  await page.route('**/api/ranking', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    gets++;
    if (held) await released;
    if (kind === 'fail') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      answered++;
      return;
    }
    let entries: unknown[] = [];
    if (kind === 'tie') {
      const tenth = await page.evaluate(() => window.__game__?.session.getScore() ?? 0);
      entries = Array.from({ length: 10 }, (_, i) => ({
        id: `full${i}`,
        createdAt: '2026-01-01T12:00:00Z',
        score: tenth + (9 - i),
        stage: 1,
        name: `RIVAL${i}`,
        xHandle: null,
        replayAvailable: false,
      }));
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries, displayEntries: entries.map((e) => ({ ...(e as object), status: 'verified' })) }),
    });
    answered++;
  });
  return {
    gets: () => gets,
    answered: () => answered,
    hold: () => {
      held = true;
      released = new Promise<void>((resolve) => (release = resolve));
    },
    release: () => release(),
  };
}

async function open(page: Page, query = ''): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
  await advanceUntil(page, () => page.evaluate(() => Boolean(window.__game__)), 2_000, 100);
}

async function start(page: Page): Promise<void> {
  await page.keyboard.press('Space'); // Title -> Playing
  await page.clock.runFor(100);
  expect(await status(page)).toBe('playing');
}

/** tests/e2e/goals-and-retry.spec.ts's scripted claim on seed 1: a small box off the top border. */
async function claimSmallBox(page: Page): Promise<void> {
  const before = await score(page);
  await page.keyboard.down('ArrowLeft');
  await advanceUntil(page, async () => (await marker(page)).x <= 30, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.down('Space');
  await page.keyboard.down('ArrowDown');
  await advanceUntil(page, async () => (await marker(page)).y >= 25, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowDown');
  await page.keyboard.down('ArrowRight');
  await advanceUntil(page, async () => (await marker(page)).x >= 55, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.down('ArrowUp');
  await advanceUntil(page, async () => (await score(page)) > before, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('Space');
}

/** An untainted NORMAL run with points, burnt by the Igniter: its GAME OVER modal is up (result age 0). */
async function scoredGameOver(page: Page): Promise<void> {
  await start(page);
  await claimSmallBox(page);
  expect(await score(page)).toBeGreaterThan(0);
  await loseAllLivesToIgniter(page, 90_000);
  expect(await page.evaluate(() => window.__game__!.session.isRunTainted())).toBe(false);
  await advanceUntil(page, () => page.locator('#gameover-modal').isVisible(), 3_000, FRAME_MS);
}

/** The ranking reply has come in (no game time passes): the panel it decided on waits. */
async function replyIn(page: Page): Promise<void> {
  await expect.poll(async () => (await rankingOffer(page)).waiting).toBe(true);
}

/** One tick at a time until the result's age is `age`. */
async function stepToAge(page: Page, age: number): Promise<void> {
  while ((await gameOverTiming(page)).age < age) await runOneGameOverTick(page, FRAME_MS);
  expect((await gameOverTiming(page)).age).toBe(age);
}

const tapField = async (page: Page) => {
  const box = (await page.locator('#game-canvas').boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + box.height - 4);
};

test.describe('the ranking submission panel waits for the GAME OVER result', () => {
  test('one tick per frame: the best line shows on its tick, the panel RANKING_OFFER_DELAY_TICKS after, over a finished result', async ({ page }) => {
    await mockBoard(page);
    await pinNormalSeed(page, 1);
    await open(page);
    await scoredGameOver(page);
    await replyIn(page);
    const timing = await gameOverTiming(page);
    expect(timing.age).toBe(0);
    expect(timing.offerAge).toBe(timing.lastLineAge + RANKING_OFFER_DELAY_TICKS);
    const bestLine = page.locator('#gameover-new-record');

    await stepToAge(page, timing.lastLineAge - 1);
    await expect(bestLine).toBeHidden();
    await runOneGameOverTick(page, FRAME_MS);
    await expect(bestLine).toBeVisible();
    expect(await page.evaluate(() => window.__game__!.getGameOverResult().best)).toBe('new-record');

    // Read with the panel about to open: the keys wait for it.
    await stepToAge(page, timing.offerAge - 1);
    await expect(page.locator(PANEL)).toBeHidden();
    expect(await rankingOffer(page)).toEqual({ checkPending: false, waiting: true, panelShown: false });
    // The retry hint is not seen while the keys do nothing.
    await expect(page.locator('#gameover-hint')).toBeHidden();
    await runOneGameOverTick(page, FRAME_MS);
    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.locator('#gameover-hint')).toBeVisible();
    await expect(page.locator('#gameover-hint')).toHaveText('POST OR SKIP TO CONTINUE');
    await expect(page.locator(PANEL)).toContainText('YOU MADE THE TOP 10!');
    expect(await rankingOffer(page)).toEqual({ checkPending: false, waiting: false, panelShown: true });
    // Under it, the result is final: the count done, the best line out.
    const result = await page.evaluate(() => window.__game__!.getGameOverResult());
    expect(result).toMatchObject({ finished: true, score: await score(page), best: 'new-record' });
    await expect(bestLine).toBeVisible();
  });

  test('a best line first drawn late, by a frame of several ticks: the panel still opens counted from the tick the line was due', async ({ page }) => {
    await mockBoard(page);
    await pinNormalSeed(page, 1);
    await open(page);
    await scoredGameOver(page);
    await replyIn(page);
    const { offerAge, lastLineAge } = await gameOverTiming(page);
    // One frame of about six ticks draws the best line a few ticks after it was due.
    await stepToAge(page, lastLineAge - 2);
    await expect(page.locator('#gameover-new-record')).toBeHidden();
    await page.clock.fastForward(100);
    const seenAt = (await gameOverTiming(page)).age;
    expect(seenAt).toBeGreaterThan(lastLineAge);
    await expect(page.locator('#gameover-new-record')).toBeVisible();
    expect((await gameOverTiming(page)).offerAge).toBe(offerAge);
    // Opened on the tick counted from when the line was due — sooner than
    // RANKING_OFFER_DELAY_TICKS after the frame that drew it.
    await stepToAge(page, offerAge - 1);
    await expect(page.locator(PANEL)).toBeHidden();
    await runOneGameOverTick(page, FRAME_MS);
    await expect(page.locator(PANEL)).toBeVisible();
    expect(offerAge).toBeLessThan(seenAt + RANKING_OFFER_DELAY_TICKS);
  });

  test('several ticks in one frame: the first frame past the open tick opens it', async ({ page }) => {
    await mockBoard(page);
    await pinNormalSeed(page, 1);
    await open(page);
    await scoredGameOver(page);
    await replyIn(page);
    const { offerAge } = await gameOverTiming(page);
    await stepToAge(page, offerAge - 2);
    await expect(page.locator(PANEL)).toBeHidden();
    // One frame of about six ticks crosses the open tick.
    await page.clock.fastForward(100);
    expect((await gameOverTiming(page)).age).toBeGreaterThan(offerAge);
    await expect(page.locator(PANEL)).toBeVisible();
  });

  test('a reply that comes after the open tick opens the panel as it lands', async ({ page }) => {
    const board = await mockBoard(page);
    await pinNormalSeed(page, 1);
    await open(page);
    board.hold();
    await scoredGameOver(page);
    await expect.poll(board.gets).toBeGreaterThanOrEqual(2); // the page load's and this GAME OVER's
    await advancePastOfferTime(page);
    expect(await rankingOffer(page)).toMatchObject({ checkPending: true, waiting: false });
    await expect(page.locator(PANEL)).toBeHidden();
    const age = (await gameOverTiming(page)).age;
    board.release();
    // No game time passes: it opens with the reply.
    await expect(page.locator(PANEL)).toBeVisible();
    expect((await gameOverTiming(page)).age).toBe(age);
  });

  test('reduced motion: the panel opens RANKING_OFFER_DELAY_TICKS after the modal', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockBoard(page);
    await pinNormalSeed(page, 1);
    await open(page);
    await scoredGameOver(page);
    await replyIn(page);
    const timing = await gameOverTiming(page);
    expect(timing.lastLineAge).toBe(0);
    await expect(page.locator('#gameover-new-record')).toBeVisible();
    await stepToAge(page, RANKING_OFFER_DELAY_TICKS - 1);
    await expect(page.locator(PANEL)).toBeHidden();
    await runOneGameOverTick(page, FRAME_MS);
    await expect(page.locator(PANEL)).toBeVisible();
  });
});

const LAYOUTS = [
  { name: '1280x800', viewport: { width: 1280, height: 800 }, hasTouch: false },
  { name: '390x844 touch', viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: '844x390 touch', viewport: { width: 844, height: 390 }, hasTouch: true },
  { name: '667x375 touch', viewport: { width: 667, height: 375 }, hasTouch: true },
];
const RETRY_HINT = { en: 'PRESS ANY KEY OR TAP FIELD TO RETRY', ja: 'キーか盤面のタップでもう一度' };

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The GAME OVER modal's box and its three buttons'. */
function modalBoxes(page: Page): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const out: Record<string, Box> = {};
    for (const id of ['gameover-modal', 'gameover-retry-button', 'gameover-back-button', 'gameover-share-button']) {
      const r = document.getElementById(id)!.getBoundingClientRect();
      out[id] = { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    return out;
  });
}

for (const c of LAYOUTS) {
  for (const lang of ['en', 'ja'] as const) {
    test.describe(`while the panel waits at ${c.name} (${lang})`, () => {
      test.use({ viewport: c.viewport, hasTouch: c.hasTouch });

      test('the modal and its buttons keep the boxes they had before the reply; the retry hint is not seen', async ({ page }) => {
        const board = await mockBoard(page);
        await pinNormalSeed(page, 1);
        await open(page, `?lang=${lang}`);
        board.hold();
        // No points, on an empty board: in range, with the shortest result.
        await start(page);
        await loseAllLivesToIgniter(page, 90_000);
        expect(await score(page)).toBe(0);
        await advanceUntil(page, () => page.locator('#gameover-modal').isVisible(), 3_000, FRAME_MS);
        await expect.poll(board.gets).toBeGreaterThanOrEqual(2); // the page load's and this GAME OVER's
        await runOneGameOverTick(page, FRAME_MS);
        expect(await rankingOffer(page)).toMatchObject({ checkPending: true, waiting: false });
        const hint = page.locator('#gameover-hint');
        await expect(hint).toBeVisible();
        await expect(hint).toHaveText(RETRY_HINT[lang]);
        const before = await modalBoxes(page);

        board.release();
        await replyIn(page);
        await runOneGameOverTick(page, FRAME_MS);
        expect(await rankingOffer(page)).toEqual({ checkPending: false, waiting: true, panelShown: false });
        expect(await modalBoxes(page)).toEqual(before);
        await expect(hint).toBeHidden();
        // Still the same on the last frame before the panel opens.
        await stepToAge(page, (await gameOverTiming(page)).offerAge - 1);
        await expect(page.locator(PANEL)).toBeHidden();
        await expect(hint).toBeHidden();
        expect(await modalBoxes(page)).toEqual(before);
        await runOneGameOverTick(page, FRAME_MS);
        await expect(page.locator(PANEL)).toBeVisible();
      });
    });
  }
}

test.describe('until the panel opens', () => {
  test('keys, field taps and the modal RETRY start nothing, even past a short check wait; the panel then opens as usual', async ({ page }) => {
    await mockBoard(page);
    await pinNormalSeed(page, 1);
    await open(page, '?debug');
    // The ranking check's own limit far below the wait (an effect timing: the run stays untainted).
    await page.locator('#debug-fx-retryOfferWaitMaxTicks').fill('10');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await scoredGameOver(page);
    await replyIn(page);
    const { offerAge } = await gameOverTiming(page);
    await stepToAge(page, GUARD_TICKS + 20);
    const before = await confirms(page);
    await page.keyboard.press('Enter');
    await runOneGameOverTick(page, FRAME_MS);
    await tapField(page);
    await runOneGameOverTick(page, FRAME_MS);
    await page.locator('#gameover-retry-button').click();
    await runOneGameOverTick(page, FRAME_MS);
    await runOneGameOverTick(page, FRAME_MS);
    expect(await status(page)).toBe('gameover');
    expect(await confirms(page)).toBe(before);
    expect((await gameOverTiming(page)).age).toBeLessThan(offerAge);

    await advanceToSubmissionPanel(page);
    expect((await gameOverTiming(page)).age).toBe(offerAge);
    // Open: its own hold, as before; its RETRY starts the next run.
    await page.keyboard.press('Enter');
    await page.clock.runFor(200);
    expect(await status(page)).toBe('gameover');
    await page.locator('#ranking-submit-retry-button').click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('playing');
  });

  test('TITLE works while it waits; a new run started from Title never gets the old panel', async ({ page }) => {
    const board = await mockBoard(page);
    await pinNormalSeed(page, 1);
    await open(page);
    await scoredGameOver(page);
    await replyIn(page);
    await stepToAge(page, GUARD_TICKS + 2);
    await page.locator('#gameover-back-button').click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('title');
    expect(await rankingOffer(page)).toEqual({ checkPending: false, waiting: false, panelShown: false });
    const gets = board.gets();
    await start(page);
    await page.clock.runFor(4_000);
    expect(await status(page)).toBe('playing');
    await expect(page.locator(PANEL)).toBeHidden();
    expect(board.gets()).toBe(gets);
  });

  test('while the ranking check is in flight the modal RETRY starts the next run at once; the late reply opens nothing', async ({ page }) => {
    const board = await mockBoard(page);
    await pinNormalSeed(page, 1);
    await open(page);
    board.hold();
    await scoredGameOver(page);
    await expect.poll(board.gets).toBeGreaterThanOrEqual(2);
    expect(await rankingOffer(page)).toMatchObject({ checkPending: true });
    await page.locator('#gameover-retry-button').click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('playing');
    board.release();
    await page.clock.runFor(4_000);
    await expect(page.locator(PANEL)).toBeHidden();
  });
});

/**
 * A scored run played to its GAME OVER modal on a board that will not offer
 * it: the modal's own GET /api/ranking went out, was answered (the full board
 * or the 503) and the page has finished with the answer.
 */
async function askedAndAnsweredGameOver(page: Page, board: Board): Promise<void> {
  const getsBefore = board.gets();
  await scoredGameOver(page);
  await expect.poll(board.gets).toBe(getsBefore + 1);
  await expect.poll(board.answered).toBe(getsBefore + 1);
  await expect.poll(async () => (await rankingOffer(page)).checkPending).toBe(false);
}

test.describe('a run that is not offered keeps its input timing', () => {
  for (const kind of ['tie', 'fail'] as const) {
    test(`asked and not offered (${kind === 'tie' ? 'ties a full board' : 'the check fails'}): no panel past its time; a key right after the guard retries`, async ({ page }) => {
      const board = await mockBoard(page, kind);
      await pinNormalSeed(page, 1);
      await open(page);
      // That GAME OVER's check went out and has answered.
      await askedAndAnsweredGameOver(page, board);
      expect(await rankingOffer(page)).toEqual({ checkPending: false, waiting: false, panelShown: false });
      // The guard ends on the same tick as it always did: a key read on tick
      // GUARD_TICKS is dropped, one read on the tick after it is delivered.
      await stepToAge(page, GUARD_TICKS - 1);
      const before = await confirms(page);
      await page.keyboard.press('Enter');
      await runOneGameOverTick(page, FRAME_MS);
      expect(await status(page)).toBe('gameover');
      expect(await confirms(page)).toBe(before);
      expect((await gameOverTiming(page)).age).toBe(GUARD_TICKS);
      await page.keyboard.press('Enter');
      await page.clock.runFor(Math.ceil(TICK_MS * 2));
      expect(await status(page)).toBe('playing');
      expect(await confirms(page)).toBe(before + 1);
    });

    test(`asked and not offered (${kind === 'tie' ? 'ties a full board' : 'the check fails'}): no panel once its time has passed`, async ({ page }) => {
      const board = await mockBoard(page, kind);
      await pinNormalSeed(page, 1);
      await open(page);
      await askedAndAnsweredGameOver(page, board);
      await advancePastOfferTime(page);
      await expect(page.locator(PANEL)).toBeHidden();
      expect(await rankingOffer(page)).toEqual({ checkPending: false, waiting: false, panelShown: false });
      await expect(page.locator('#gameover-hint')).toHaveText('PRESS ANY KEY OR TAP FIELD TO RETRY');
    });
  }

  /**
   * A run with points that never asks the ranking, played to its GAME OVER
   * modal; returns the GETs seen before it ended. Only the debug override case
   * overrides anything: the seeded and EASY runs end to the Igniter untainted,
   * so each is left out of the ranking for its own reason alone.
   */
  async function unaskedGameOver(page: Page, board: Board, kind: 'seeded' | 'debug override' | 'EASY'): Promise<number> {
    await pinNormalSeed(page, 1);
    await open(page, kind === 'seeded' ? '?seed=1' : '');
    if (kind === 'EASY') {
      await page.locator('#difficulty-button').click();
      await page.clock.runFor(50);
      await expect(page.locator('#difficulty-button')).toHaveText('MODE: EASY');
    }
    await start(page);
    await claimSmallBox(page);
    const gets = board.gets();
    if (kind === 'debug override') {
      // TIME UP in a few ticks, by a debug override on a NORMAL run.
      await page.evaluate(() => {
        const s = window.__game__!.session;
        s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
      });
    } else {
      await loseAllLivesToIgniter(page, kind === 'EASY' ? 120_000 : 90_000);
    }
    await advanceUntil(page, () => page.locator('#gameover-modal').isVisible(), 3_000, FRAME_MS);
    expect(await page.evaluate(() => window.__game__!.session.isRunTainted())).toBe(kind === 'debug override');
    return gets;
  }

  for (const kind of ['seeded', 'debug override', 'EASY'] as const) {
    test(`never asked (${kind}): no GET /api/ranking at GAME OVER; a key right after the guard retries`, async ({ page }) => {
      const board = await mockBoard(page);
      const gets = await unaskedGameOver(page, board, kind);
      expect(board.gets()).toBe(gets);
      expect(await rankingOffer(page)).toEqual({ checkPending: false, waiting: false, panelShown: false });
      await expect(page.locator(PANEL)).toBeHidden();
      // The guard ends on the same tick as it always did: a key read on tick
      // GUARD_TICKS is dropped, one read on the tick after it is delivered.
      await stepToAge(page, GUARD_TICKS - 1);
      const before = await confirms(page);
      await page.keyboard.press('Enter');
      await runOneGameOverTick(page, FRAME_MS);
      expect(await status(page)).toBe('gameover');
      expect(await confirms(page)).toBe(before);
      expect((await gameOverTiming(page)).age).toBe(GUARD_TICKS);
      await page.keyboard.press('Enter');
      await page.clock.runFor(Math.ceil(TICK_MS * 2));
      expect(await status(page)).toBe('playing');
      expect(await confirms(page)).toBe(before + 1);
      expect(board.gets()).toBe(gets);
    });

    test(`never asked (${kind}): no GET /api/ranking at GAME OVER, no panel once its time has passed`, async ({ page }) => {
      const board = await mockBoard(page);
      const gets = await unaskedGameOver(page, board, kind);
      await advancePastOfferTime(page);
      expect(board.gets()).toBe(gets);
      await expect(page.locator(PANEL)).toBeHidden();
      expect(await rankingOffer(page)).toEqual({ checkPending: false, waiting: false, panelShown: false });
      // A key retries as soon as the guard is over (long over by now).
      await page.keyboard.press('Enter');
      await page.clock.runFor(100);
      expect(await status(page)).toBe('playing');
    });
  }
});

test.describe('the delay on the ?debug panel', () => {
  test('applies from the next GAME OVER, and EXPORT carries it', async ({ page }) => {
    await mockBoard(page);
    await pinNormalSeed(page, 1);
    await open(page, '?debug');
    const slider = page.locator('#debug-fx-rankingOfferDelayTicks');
    await expect(slider).toHaveValue(String(RANKING_OFFER_DELAY_TICKS));
    await slider.fill('30');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await scoredGameOver(page);
    await replyIn(page);
    const timing = await gameOverTiming(page);
    expect(timing.offerAge).toBe(timing.lastLineAge + 30);
    // Moved again on this GAME OVER: this one keeps the delay it started with.
    await slider.fill('200');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect((await gameOverTiming(page)).offerAge).toBe(timing.lastLineAge + 30);
    await stepToAge(page, timing.offerAge - 1);
    await expect(page.locator(PANEL)).toBeHidden();
    await runOneGameOverTick(page, FRAME_MS);
    await expect(page.locator(PANEL)).toBeVisible();
    expect(await page.evaluate(() => window.__game__!.session.isRunTainted())).toBe(false);

    await page.locator('#debug-panel').getByRole('button', { name: 'EXPORT', exact: true }).click();
    const exported = JSON.parse(await page.locator('#debug-export-output').inputValue()) as Record<string, unknown>;
    expect(exported).toMatchObject({ RANKING_OFFER_DELAY_TICKS: 200 });
  });
});
