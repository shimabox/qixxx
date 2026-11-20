// The goals in the HUD (goal slot, occupancy left, lives marks, the gauge),
// the one-confirm retry from GAME OVER and its guard, the modal's buttons and
// NEW RECORD, the counted clear screen on small fields, and the effects' text
// size on a phone. Everything runs on a faked page clock
// (tests/e2e/support/fakeClock.ts), so budgets are game time.
import { test, expect, type Page } from '@playwright/test';
import { advanceUntil, finishGameOverResult, loseAllLivesToIgniter } from './support/fakeClock';

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
        getHighScore: () => number;
        getTotalTicks: () => number;
        isRunTainted: () => boolean;
        setDebugTimeLimitTicks: (ticks: number) => void;
        applyDebugOverrides: (overrides: { requiredOccupancy?: number }) => void;
        getGame: () => { getMarker: () => { getPosition: () => Point } };
      };
    };
    __titleSeen__?: number;
    __popupDraws__?: Array<{ left: number; right: number; top: number; bottom: number; fontPx: number }>;
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const TICK_MS = 1000 / 60;
const GUARD_TICKS = 24; // RETRY_CONFIRM_GUARD_TICKS

const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());
const marker = (page: Page) => page.evaluate(() => window.__game__!.session.getGame().getMarker().getPosition());

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

/** Ends the run on TIME UP within a few ticks (a debug override: the run is tainted). */
async function timeUpSoon(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = window.__game__!.session;
    s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
  });
  await advanceUntil(page, async () => (await status(page)) === 'gameover', 1_000, FRAME_MS);
  await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 500, FRAME_MS);
}

/** tests/e2e/impact-feedback.spec.ts's scripted claim on seed 1: a small box off the top border. */
async function claimSmallBox(page: Page): Promise<void> {
  const scoreBefore = await page.evaluate(() => window.__game__!.session.getScore());
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
  await advanceUntil(page, async () => (await page.evaluate(() => window.__game__!.session.getScore())) > scoreBefore, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('Space');
}

/** The field, the HUD row and the gauge, in CSS px. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const r = (id: string) => {
      const b = document.getElementById(id)!.getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
    };
    const lines = ['hud-line1', 'hud-line2', 'hud-line3']
      .map((id) => document.getElementById(id) as HTMLElement)
      .filter((el) => el.style.display !== 'none');
    return {
      canvas: r('game-canvas'),
      hudRow: r('hud-row'),
      gauge: r('hud-gauge'),
      goal: r('hud-gauge-goal'),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      clipped: lines.some((el) => el.scrollWidth > el.clientWidth + 1),
      text: lines.map((el) => el.textContent).join('\n'),
    };
  });
}

// The field's on-screen size before this change (measured on the base
// commit with the same viewports).
const FIELD_SIZES = [
  { name: '1280x800', viewport: { width: 1280, height: 800 }, hasTouch: false, field: { width: 1021, height: 766 } },
  { name: '390x844 touch', viewport: { width: 390, height: 844 }, hasTouch: true, field: { width: 390, height: 292 } },
  { name: '667x375 touch', viewport: { width: 667, height: 375 }, hasTouch: true, field: { width: 203, height: 152 } },
  { name: '667x375', viewport: { width: 667, height: 375 }, hasTouch: false, field: { width: 420, height: 315 } },
];

for (const c of FIELD_SIZES) {
  test.describe(`HUD goals at ${c.name}`, () => {
    test.use({ viewport: c.viewport, hasTouch: c.hasTouch });

    test('the field keeps its size; the HUD and the gauge stay on screen and off the field', async ({ page }) => {
      await open(page);
      await start(page);
      const l = await layout(page);
      expect({ width: l.canvas.width, height: l.canvas.height }).toEqual(c.field);
      expect(l.clipped).toBe(false);
      expect(l.text).toContain('0%/65% 65% LEFT');
      expect(l.text).toContain('◆◆◆');
      // No best yet: the goal slot is the plain HI until the first point.
      expect(l.text).toContain('HI 0');
      expect(l.text).not.toContain('TO BEST');
      // The gauge: in the gap between the HUD row and the field, as wide as the field.
      expect(l.gauge.height).toBe(4);
      expect(l.gauge.left).toBeCloseTo(l.canvas.left, 0);
      expect(l.gauge.width).toBeCloseTo(l.canvas.width, 0);
      expect(l.gauge.top).toBeGreaterThanOrEqual(l.hudRow.bottom);
      expect(l.gauge.bottom).toBeLessThanOrEqual(l.canvas.top);
      for (const box of [l.hudRow, l.gauge]) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(l.viewport.width);
        expect(box.bottom).toBeLessThanOrEqual(l.viewport.height);
      }
      // The goal mark sits at the goal share of the field's width.
      expect(l.goal.left + l.goal.width / 2).toBeCloseTo(l.canvas.left + l.canvas.width * 0.65, 0);
    });
  });
}

test.describe('retry from GAME OVER', () => {
  test('one Enter after the modal starts stage 1 without Title ever showing', async ({ page }) => {
    await open(page, '?seed=1');
    await start(page);
    await timeUpSoon(page);
    await page.evaluate(() => {
      window.__titleSeen__ = 0;
      const screen = document.getElementById('screen')!;
      new MutationObserver(() => {
        if ((screen.textContent ?? '').includes('PRESS ANY KEY OR TAP TO START')) window.__titleSeen__!++;
      }).observe(screen, { childList: true, characterData: true, subtree: true });
    });
    await page.clock.runFor(Math.ceil((GUARD_TICKS + 2) * TICK_MS));
    await page.keyboard.press('Enter');
    await page.clock.runFor(100);
    expect(await status(page)).toBe('playing');
    expect(await page.evaluate(() => window.__game__!.session.getStage())).toBe(1);
    expect(await page.evaluate(() => window.__game__!.session.getScore())).toBe(0);
    expect(await page.evaluate(() => window.__titleSeen__)).toBe(0);
    await expect(page.locator('#gameover-modal')).toBeHidden();
  });

  test('the RETRY button starts the next run, the TITLE button returns to Title', async ({ page }) => {
    await open(page, '?seed=1');
    await start(page);
    await timeUpSoon(page);
    await page.locator('#gameover-retry-button').click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('playing');

    await timeUpSoon(page);
    await page.locator('#gameover-back-button').click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('title');
    await expect(page.locator('#screen')).toContainText('PRESS ANY KEY OR TAP TO START');
  });

  test.describe('with touch', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('touch buttons and field taps do nothing for 24 ticks from the modal; afterwards a touch button retries', async ({ page }) => {
      await open(page, '?seed=1');
      await start(page);
      await timeUpSoon(page);
      const dpadUp = page.locator('#touch-dpad button').first();
      const field = page.locator('#game-canvas');
      // Inside the guard: hammering the controls is dropped, never kept.
      for (let i = 0; i < 4; i++) {
        await dpadUp.tap({ force: true });
        await page.clock.runFor(FRAME_MS);
        await field.tap({ position: { x: 4, y: 4 }, force: true });
        await page.clock.runFor(FRAME_MS);
      }
      expect(await status(page)).toBe('gameover');
      await page.clock.runFor(Math.ceil(GUARD_TICKS * TICK_MS));
      expect(await status(page)).toBe('gameover');
      // After it: any touch button is a confirm, and starts the next run.
      await dpadUp.tap({ force: true });
      await page.clock.runFor(100);
      expect(await status(page)).toBe('playing');
      expect(await page.evaluate(() => window.__game__!.session.getStage())).toBe(1);
    });

    test('touch buttons and field taps made before the modal appears do not retry once it is up', async ({ page }) => {
      await open(page, '?seed=1');
      await start(page);
      // A 'life' GAME OVER: the modal waits out the last miss (hit stop and
      // the game-over hold) before it appears.
      await loseAllLivesToIgniter(page);
      const modal = page.locator('#gameover-modal');
      expect(await modal.isVisible()).toBe(false);
      const dpadUp = page.locator('#touch-dpad button').first();
      const field = page.locator('#game-canvas');
      // From GAME OVER until the modal is drawn: tap a control and the field
      // every frame.
      let taps = 0;
      while (!(await modal.isVisible())) {
        expect(taps).toBeLessThan(200);
        await dpadUp.tap({ force: true });
        await field.tap({ position: { x: 4, y: 4 }, force: true });
        await page.clock.runFor(FRAME_MS);
        taps++;
      }
      expect(taps).toBeGreaterThan(0);
      // Nothing touched since: well past the guard, still on GAME OVER.
      await page.clock.runFor(Math.ceil((GUARD_TICKS + 60) * TICK_MS));
      expect(await status(page)).toBe('gameover');
      await expect(modal).toBeVisible();
    });
  });
});

/** GET /api/ranking with an empty board (every untainted run is in range), and POST /api/scores answered through the returned `release()`. */
async function mockOpenBoard(page: Page) {
  let releasePost: (() => void) | null = null;
  let posts = 0;
  await page.route('**/api/ranking', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seasonId: 1, rulesetVersion: 2, entries: [], displayEntries: [] }) }),
  );
  await page.route('**/api/scores', async (route) => {
    posts++;
    await new Promise<void>((resolve) => (releasePost = resolve));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: true, status: 'verified' }) });
  });
  return {
    posts: () => posts,
    release: () => releasePost?.(),
  };
}

/** Plays an untainted normal run to GAME OVER and waits for the submission panel. */
async function reachSubmissionPanel(page: Page): Promise<void> {
  await start(page);
  await loseAllLivesToIgniter(page);
  expect(await page.evaluate(() => window.__game__!.session.isRunTainted())).toBe(false);
  await advanceUntil(page, async () => page.locator('#ranking-submit-panel').isVisible(), 2_000, FRAME_MS);
  await expect(page.locator('#ranking-submit-panel')).toContainText('YOU MADE THE TOP 10!');
}

test.describe("the submission panel's RETRY and TITLE", () => {
  test('RETRY starts the next run and TITLE returns to Title, without closing the panel first; neither leaves the panel behind', async ({ page }) => {
    await mockOpenBoard(page);
    await pinNormalSeed(page, 1);
    await open(page);
    const panel = page.locator('#ranking-submit-panel');

    await reachSubmissionPanel(page);
    await page.getByPlaceholder('NAME').fill('RUN A');
    await page.locator('#ranking-submit-retry-button').click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('playing');
    expect(await page.evaluate(() => window.__game__!.session.getStage())).toBe(1);
    await expect(panel).toBeHidden();
    await expect(page.locator('#gameover-modal')).toBeHidden();

    // The next run's panel starts empty, and its TITLE goes back to Title.
    await loseAllLivesToIgniter(page);
    await advanceUntil(page, async () => panel.isVisible(), 2_000, FRAME_MS);
    await expect(page.getByPlaceholder('NAME')).toHaveValue('');
    await page.locator('#ranking-submit-title-button').click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('title');
    await expect(page.locator('#screen')).toContainText('PRESS ANY KEY OR TAP TO START');
    await expect(panel).toBeHidden();
    await expect(page.locator('#gameover-modal')).toBeHidden();
  });

  test('both are off while the POST is in flight and on again once it is answered', async ({ page }) => {
    const api = await mockOpenBoard(page);
    await pinNormalSeed(page, 1);
    await open(page);
    await reachSubmissionPanel(page);
    const retry = page.locator('#ranking-submit-retry-button');
    const title = page.locator('#ranking-submit-title-button');
    await expect(retry).toBeEnabled();
    await expect(title).toBeEnabled();

    await page.getByPlaceholder('NAME').fill('INFLIGHT');
    await page.getByRole('button', { name: 'SUBMIT' }).click();
    await expect.poll(api.posts).toBe(1);
    await expect(retry).toBeDisabled();
    await expect(title).toBeDisabled();
    await retry.click({ force: true });
    await title.click({ force: true });
    await page.clock.runFor(200);
    expect(await status(page)).toBe('gameover');

    api.release();
    await expect(page.locator('#ranking-submit-panel')).toContainText('SUBMITTED.');
    await expect(retry).toBeEnabled();
    await expect(title).toBeEnabled();
    // The finished POST's result is still up: RETRY works from it.
    await retry.click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('playing');
    await expect(page.locator('#ranking-submit-panel')).toBeHidden();
  });
});

for (const c of [
  { name: '390x844', viewport: { width: 390, height: 844 } },
  { name: '667x375', viewport: { width: 667, height: 375 } },
]) {
  test.describe(`the submission panel on a phone ${c.name}`, () => {
    test.use({ viewport: c.viewport, hasTouch: true });

    test('fits on screen with all of its buttons in view, also with a finished POST', async ({ page }) => {
      const api = await mockOpenBoard(page);
      await pinNormalSeed(page, 1);
      await open(page);
      await reachSubmissionPanel(page);
      const measure = () =>
        page.evaluate(() => {
          const panel = document.getElementById('ranking-submit-panel')!;
          const r = (el: Element) => el.getBoundingClientRect();
          const buttons = [...panel.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
          return {
            panel: r(panel),
            overflow: panel.scrollHeight - panel.clientHeight,
            buttons: buttons.map((b) => ({ text: b.textContent, box: r(b) })),
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        });
      const expectFits = async (labels: string[]) => {
        const m = await measure();
        expect(m.overflow).toBeLessThanOrEqual(1);
        expect(m.panel.left).toBeGreaterThanOrEqual(0);
        expect(m.panel.top).toBeGreaterThanOrEqual(0);
        expect(m.panel.right).toBeLessThanOrEqual(m.viewport.width);
        expect(m.panel.bottom).toBeLessThanOrEqual(m.viewport.height);
        expect(m.buttons.map((b) => b.text)).toEqual(labels);
        for (const b of m.buttons) {
          expect(b.box.top).toBeGreaterThanOrEqual(m.panel.top);
          expect(b.box.bottom).toBeLessThanOrEqual(m.panel.bottom);
        }
      };
      await expectFits(['SKIP', 'SUBMIT', 'RETRY', 'TITLE']);
      await page.getByPlaceholder('NAME').fill('FIT');
      await page.getByRole('button', { name: 'SUBMIT' }).click();
      await expect.poll(api.posts).toBe(1);
      api.release();
      await expect(page.locator('#ranking-submit-panel')).toContainText('SUBMITTED.');
      await expectFits(['OK', 'RETRY', 'TITLE']);
    });
  });
}

/** GET /api/ranking answers 503: the GAME OVER ranking check fails and no submission panel opens over the modal. */
async function failRankingCheck(page: Page): Promise<void> {
  await page.route('**/api/ranking', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
}

/** The modal and its three buttons fit on the field, each button at least 44px tall. */
async function expectModalFits(page: Page): Promise<void> {
  const boxes = await page.evaluate(() => {
    const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return {
      canvas: r('game-canvas'),
      modal: r('gameover-modal'),
      buttons: ['gameover-retry-button', 'gameover-back-button', 'gameover-share-button'].map(r),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  expect(boxes.modal.left).toBeGreaterThanOrEqual(boxes.canvas.left);
  expect(boxes.modal.right).toBeLessThanOrEqual(boxes.canvas.right);
  expect(boxes.modal.top).toBeGreaterThanOrEqual(boxes.canvas.top);
  expect(boxes.modal.bottom).toBeLessThanOrEqual(boxes.canvas.bottom);
  for (const b of boxes.buttons) {
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.left).toBeGreaterThanOrEqual(0);
    expect(b.top).toBeGreaterThanOrEqual(0);
    expect(b.right).toBeLessThanOrEqual(boxes.viewport.width);
    expect(b.bottom).toBeLessThanOrEqual(boxes.viewport.height);
  }
}

const gameOverReason = (page: Page) =>
  page.evaluate(() => (window.__game__!.session as unknown as { getGameOverReason(): string }).getGameOverReason());

// TIME UP! and NEW RECORD together need an untainted run played for the
// whole time limit (the shorter limit is a debug override, which taints the
// run and so drops NEW RECORD) — minutes of game time, past the default test
// timeout. The two lines are checked here on the runs that do produce them
// quickly: NEW RECORD on a 'life' GAME OVER, TIME UP! on a shortened one.
for (const c of [
  { name: '390x844', viewport: { width: 390, height: 844 } },
  { name: '667x375', viewport: { width: 667, height: 375 } },
]) {
  test.describe(`GAME OVER modal on a phone ${c.name}`, () => {
    test.use({ viewport: c.viewport, hasTouch: true });

    test('NEW RECORD and all three buttons fit on the field, each at least 44px tall', async ({ page }) => {
      await failRankingCheck(page);
      await pinNormalSeed(page, 1);
      await open(page);
      await start(page);
      await claimSmallBox(page);
      expect(await page.evaluate(() => window.__game__!.session.getScore())).toBeGreaterThan(0);
      // An untainted run, burnt by the Igniter three times.
      await loseAllLivesToIgniter(page);
      expect(await page.evaluate(() => window.__game__!.session.isRunTainted())).toBe(false);
      await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
      const finalScore = await page.evaluate(() => window.__game__!.session.getScore());
      expect(await gameOverReason(page)).toBe('life');
      // NEW RECORD shows once the score has counted up.
      await finishGameOverResult(page);
      await expect(page.locator('#gameover-new-record')).toHaveText(`NEW RECORD +${finalScore}`);
      await expect(page.locator('#gameover-reason')).toBeHidden();
      await expectModalFits(page);
    });

    test('TIME UP! and all three buttons fit on the field, each at least 44px tall', async ({ page }) => {
      await open(page, '?seed=1');
      await start(page);
      await claimSmallBox(page);
      await timeUpSoon(page);
      expect(await gameOverReason(page)).toBe('time');
      await expect(page.locator('#gameover-reason')).toHaveText('TIME UP!');
      await expectModalFits(page);
    });
  });
}

test.describe('NEW RECORD only for a beaten best that may be saved', () => {
  test('a seeded run never shows it', async ({ page }) => {
    await open(page, '?seed=1');
    await start(page);
    await claimSmallBox(page);
    expect(await page.evaluate(() => window.__game__!.session.getScore())).toBeGreaterThan(0);
    await timeUpSoon(page);
    await expect(page.locator('#gameover-modal')).toBeVisible();
    await expect(page.locator('#gameover-new-record')).toBeHidden();
  });

  test('a normal run that does not beat the best it started from does not show it', async ({ page }) => {
    await failRankingCheck(page);
    await page.addInitScript(() => localStorage.setItem('qixxx.highScore', '999999'));
    await pinNormalSeed(page, 1);
    await open(page);
    await start(page);
    await claimSmallBox(page);
    await loseAllLivesToIgniter(page);
    expect(await page.evaluate(() => window.__game__!.session.isRunTainted())).toBe(false);
    await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
    await expect(page.locator('#gameover-modal')).toContainText('999999');
    await expect(page.locator('#gameover-new-record')).toBeHidden();
  });
});

for (const c of [
  { name: '390x844', viewport: { width: 390, height: 844 } },
  { name: '667x375', viewport: { width: 667, height: 375 } },
]) {
  test.describe(`STAGE CLEAR on a phone ${c.name}`, () => {
    test.use({ viewport: c.viewport, hasTouch: true });

    test('the counted result fits on the field; a confirm completes it, the next one moves on', async ({ page }) => {
      await open(page, '?seed=1');
      await start(page);
      await page.evaluate(() => window.__game__!.session.applyDebugOverrides({ requiredOccupancy: 0.01 }));
      await claimSmallBox(page);
      expect(await status(page)).toBe('stageclear');
      const screen = page.locator('#screen');
      await advanceUntil(page, async () => ((await screen.textContent()) ?? '').includes('TOTAL'), 1_000, FRAME_MS);
      const total = await page.evaluate(() => window.__game__!.session.getScore());
      expect(await screen.textContent()).not.toMatch(new RegExp(`TOTAL\\s+${total}\\b`));

      // Read on the first tick after the claim's hit stop.
      await page.keyboard.press('Enter');
      await advanceUntil(page, async () => new RegExp(`TOTAL\\s+${total}\\b`).test((await screen.textContent()) ?? ''), 500, FRAME_MS);
      await page.clock.runFor(100);
      expect(await status(page)).toBe('stageclear');
      for (const label of ['AREA', 'BONUS', 'NEXT', 'PRESS ANY KEY OR TAP FOR NEXT STAGE']) {
        expect(await screen.textContent()).toContain(label);
      }
      const fit = await page.evaluate(() => {
        const canvas = document.getElementById('game-canvas')!.getBoundingClientRect();
        const text = document.getElementById('screen')!.getBoundingClientRect();
        return { canvas, text };
      });
      expect(fit.text.left).toBeGreaterThanOrEqual(fit.canvas.left);
      expect(fit.text.right).toBeLessThanOrEqual(fit.canvas.right);
      expect(fit.text.top).toBeGreaterThanOrEqual(fit.canvas.top);
      expect(fit.text.bottom).toBeLessThanOrEqual(fit.canvas.bottom);

      await page.keyboard.press('Enter');
      await page.clock.runFor(100);
      expect(await page.evaluate(() => window.__game__!.session.getStage())).toBe(2);
    });
  });
}

test.describe('effects text on a phone (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the claim popup is drawn inside the field, at least 11 CSS px tall', async ({ page }) => {
    await open(page, '?seed=1');
    await start(page);
    // Records every fillText of the popup text ("+<score>", letter by letter
    // or whole) in canvas device px, with its font size in CSS px.
    await page.evaluate(() => {
      window.__popupDraws__ = [];
      const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
      const cssScale = canvas.getBoundingClientRect().width / canvas.width;
      const proto = CanvasRenderingContext2D.prototype;
      const fillText = proto.fillText;
      proto.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
        const font = /(\d+(?:\.\d+)?)px/.exec(this.font);
        if (this.canvas === canvas && font && /^[+0-9]+$/.test(text)) {
          const t = this.getTransform();
          const w = this.measureText(text).width;
          const fontPx = Number(font[1]);
          const p0 = t.transformPoint(new DOMPoint(x, y - fontPx / 2));
          const p1 = t.transformPoint(new DOMPoint(x + w, y + fontPx / 2));
          window.__popupDraws__!.push({
            left: Math.min(p0.x, p1.x),
            right: Math.max(p0.x, p1.x),
            top: Math.min(p0.y, p1.y),
            bottom: Math.max(p0.y, p1.y),
            fontPx: Math.abs(p1.y - p0.y) * cssScale,
          });
        }
        return maxWidth === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, maxWidth);
      };
    });
    await claimSmallBox(page);
    await page.clock.runFor(FRAME_MS * 3);
    const { draws, width, height } = await page.evaluate(() => {
      const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
      return { draws: window.__popupDraws__!, width: canvas.width, height: canvas.height };
    });
    expect(draws.length).toBeGreaterThan(0);
    for (const d of draws) {
      expect(d.left).toBeGreaterThanOrEqual(0);
      expect(d.right).toBeLessThanOrEqual(width);
      expect(d.top).toBeGreaterThanOrEqual(0);
      expect(d.bottom).toBeLessThanOrEqual(height);
      expect(d.fontPx).toBeGreaterThanOrEqual(11 - 0.01);
    }
  });
});
