// The GAME OVER result (src/gameOverResult.ts, src/ui/gameOverModal.ts): the
// closing sound, the score counting up from 0, the run's highlight, NEW
// RECORD or the distance to the best, and that none of it slows the retry.
// Everything runs on a faked page clock (tests/e2e/support/fakeClock.ts), so
// budgets are game time.
import { test, expect, type Page } from '@playwright/test';
import { advanceUntil, finishGameOverResult, loseAllLivesToIgniter } from './support/fakeClock';

interface Point {
  x: number;
  y: number;
}

interface ResultState {
  active: boolean;
  score: number;
  finished: boolean;
  highlight: string | null;
  best: string | null;
}

interface GameHandle {
  session: {
    getStatus: () => string;
    getScore: () => number;
    getStage: () => number;
    getTotalTicks: () => number;
    isRunTainted: () => boolean;
    setDebugTimeLimitTicks: (ticks: number) => void;
    getGameOverReason: () => string | null;
    getGame: () => { getMarker: () => { getPosition: () => Point }; getOccupancy: () => number };
  };
  getGameOverResult: () => ResultState;
  getSfxLog: () => string[];
}


const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const TICK_MS = 1000 / 60;
const GUARD_TICKS = 24; // RETRY_CONFIRM_GUARD_TICKS

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

async function soundOn(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('qixxx.muted', 'false'));
}

/** GET /api/ranking fails: no submission panel opens over the modal. */
async function failRankingCheck(page: Page): Promise<void> {
  await page.route('**/api/ranking', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
}

async function open(page: Page, query = ''): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
}

async function start(page: Page): Promise<void> {
  await page.keyboard.press('Space');
  await page.clock.runFor(100);
  expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getStatus())).toBe('playing');
}

const marker = (page: Page) => page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getGame().getMarker().getPosition());
const result = (page: Page) => page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.getGameOverResult());
const sfxLog = (page: Page) => page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.getSfxLog());

/** tests/e2e/impact-feedback.spec.ts's scripted claim on seed 1: a small box off the top border. */
async function claimSmallBox(page: Page): Promise<void> {
  const scoreBefore = await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getScore());
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
  await advanceUntil(page, async () => (await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getScore())) > scoreBefore, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('Space');
}

const modalVisible = (page: Page) => page.locator('#gameover-modal').isVisible();

/** Ends the run on a 'life' GAME OVER and stops on the first frame the modal is drawn. */
async function toModal(page: Page): Promise<void> {
  await loseAllLivesToIgniter(page);
  await advanceUntil(page, () => modalVisible(page), 2_000, FRAME_MS);
}

/** Ends a run on TIME UP within a few ticks (a debug override: the run is tainted). */
async function timeUpToModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = (window as unknown as { __game__: GameHandle }).__game__.session;
    s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
  });
  await advanceUntil(page, async () => (await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getStatus())) === 'gameover', 1_000, FRAME_MS);
  await advanceUntil(page, () => modalVisible(page), 500, FRAME_MS);
}

const buttonBoxes = (page: Page) =>
  page.evaluate(() =>
    ['gameover-retry-button', 'gameover-back-button', 'gameover-share-button'].map((id) => {
      const b = document.getElementById(id)!.getBoundingClientRect();
      return [b.left, b.top, b.width, b.height];
    })
  );

const count = (log: string[], name: string) => log.filter((n) => n === name).length;

test.describe('GAME OVER result', () => {
  test('a beaten best: the score counts up from 0, then BEST CLAIM and NEW RECORD show, with their sounds, the buttons never moving', async ({ page }) => {
    await failRankingCheck(page);
    await soundOn(page);
    await pinNormalSeed(page, 1);
    await open(page);
    await start(page);
    await claimSmallBox(page);
    const claimPercent = await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getGame().getOccupancy() * 100);
    await toModal(page);
    expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.isRunTainted())).toBe(false);
    const finalScore = await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getScore());
    expect(finalScore).toBeGreaterThan(0);

    // The frame the modal appears: SCORE: 0, the close played once, no lines yet.
    const first = await result(page);
    expect(first).toMatchObject({ active: true, score: 0, finished: false, highlight: null, best: null });
    await expect(page.locator('#gameover-score')).toHaveText('SCORE: 0');
    await expect(page.locator('#gameover-new-record')).toBeHidden();
    await expect(page.locator('#gameover-highlight')).toBeHidden();
    expect(count(await sfxLog(page), 'gameover-life')).toBe(1);
    const buttonsBefore = await buttonBoxes(page);

    // Counting: never falling, never past the final score.
    const seen: number[] = [0];
    for (let i = 0; i < 8; i++) {
      await page.clock.runFor(100);
      seen.push((await result(page)).score);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
      expect(seen[i]).toBeLessThanOrEqual(finalScore);
    }
    expect(seen.some((s) => s > 0 && s < finalScore)).toBe(true);

    await finishGameOverResult(page);
    const done = await result(page);
    expect(done.finished).toBe(true);
    expect(done.score).toBe(finalScore);
    await expect(page.locator('#gameover-score')).toHaveText(`SCORE: ${finalScore}`);
    expect(done.highlight).toBe(`BEST CLAIM ${Math.max(1, Math.round(claimPercent))}%`);
    await expect(page.locator('#gameover-highlight')).toHaveText(done.highlight!);
    await expect(page.locator('#gameover-new-record')).toHaveText(`NEW RECORD +${finalScore}`);
    await expect(page.locator('#gameover-to-best')).toBeHidden();
    expect(done.best).toBe('new-record');
    expect(await buttonBoxes(page)).toEqual(buttonsBefore);

    const log = await sfxLog(page);
    expect(count(log, 'gameover-life')).toBe(1);
    expect(count(log, 'count-tick')).toBeGreaterThan(3);
    expect(count(log, 'count-end')).toBe(1);
    expect(count(log, 'new-record')).toBe(1);
    expect(log.indexOf('count-end')).toBeGreaterThan(log.lastIndexOf('count-tick'));
    expect(log.indexOf('new-record')).toBeGreaterThan(log.indexOf('count-end'));
  });

  test('a best not beaten: the distance to it, no NEW RECORD and no fanfare', async ({ page }) => {
    await failRankingCheck(page);
    await soundOn(page);
    await page.addInitScript(() => localStorage.setItem('qixxx.highScore', '999999'));
    await pinNormalSeed(page, 1);
    await open(page);
    await start(page);
    await claimSmallBox(page);
    await toModal(page);
    const score = await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getScore());
    await expect(page.locator('#gameover-to-best')).toBeHidden();
    await finishGameOverResult(page);
    await expect(page.locator('#gameover-to-best')).toHaveText(`${999999 - score} TO HI SCORE`);
    await expect(page.locator('#gameover-new-record')).toBeHidden();
    expect((await result(page)).best).toBe('to-best');
    const log = await sfxLog(page);
    expect(count(log, 'new-record')).toBe(0);
    expect(count(log, 'count-end')).toBe(1);
  });

  test('a seeded TIME UP: the time-up close and the highlight, neither best line', async ({ page }) => {
    await soundOn(page);
    await open(page, '?seed=1');
    await start(page);
    await claimSmallBox(page);
    await timeUpToModal(page);
    expect(count(await sfxLog(page), 'gameover-time')).toBe(1);
    expect(count(await sfxLog(page), 'gameover-life')).toBe(0);
    await finishGameOverResult(page);
    await expect(page.locator('#gameover-highlight')).toContainText('BEST CLAIM');
    await expect(page.locator('#gameover-new-record')).toBeHidden();
    await expect(page.locator('#gameover-to-best')).toBeHidden();
    expect((await result(page)).best).toBeNull();
  });

  test('muted, with no claim: no sound at all, no highlight', async ({ page }) => {
    await failRankingCheck(page);
    await pinNormalSeed(page, 1);
    await open(page);
    await start(page);
    await toModal(page);
    await finishGameOverResult(page);
    expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getScore())).toBe(0);
    expect(await sfxLog(page)).toEqual([]);
    expect((await result(page)).highlight).toBeNull();
    await expect(page.locator('#gameover-highlight')).toBeHidden();
    await expect(page.locator('#gameover-score')).toHaveText('SCORE: 0');
  });

  test('a confirm right after the guard retries mid-count; one before it does not; the old count goes silent', async ({ page }) => {
    await soundOn(page);
    await open(page, '?seed=1');
    await start(page);
    await claimSmallBox(page);
    await timeUpToModal(page);
    // Inside the guard: dropped.
    await page.clock.runFor(Math.ceil(10 * TICK_MS));
    await page.keyboard.press('Enter');
    await page.clock.runFor(FRAME_MS * 2);
    expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getStatus())).toBe('gameover');
    // Just past it, still counting.
    await page.clock.runFor(Math.ceil((GUARD_TICKS - 10) * TICK_MS));
    expect((await result(page)).finished).toBe(false);
    await page.keyboard.press('Enter');
    await page.clock.runFor(100);
    expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getStatus())).toBe('playing');
    expect(await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getScore())).toBe(0);
    expect((await result(page)).active).toBe(false);
    const logAtRetry = (await sfxLog(page)).length;
    await page.clock.runFor(1_500);
    const after = (await sfxLog(page)).slice(logAtRetry);
    expect(after.filter((n) => n === 'count-tick' || n === 'count-end' || n === 'new-record')).toEqual([]);
  });

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('the final display from the first frame of the modal', async ({ page }) => {
      await failRankingCheck(page);
      await pinNormalSeed(page, 1);
      await open(page);
      await start(page);
      await claimSmallBox(page);
      await toModal(page);
      const score = await page.evaluate(() => (window as unknown as { __game__: GameHandle }).__game__.session.getScore());
      const r = await result(page);
      expect(r).toMatchObject({ score, finished: true, best: 'new-record' });
      expect(r.highlight).toContain('BEST CLAIM');
      await expect(page.locator('#gameover-score')).toHaveText(`SCORE: ${score}`);
      await expect(page.locator('#gameover-new-record')).toBeVisible();
      await expect(page.locator('#gameover-highlight')).toBeVisible();
    });
  });
});

const LAYOUTS = [
  { name: '1280x800', viewport: { width: 1280, height: 800 }, hasTouch: false },
  { name: '390x844 touch', viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: '844x390 touch', viewport: { width: 844, height: 390 }, hasTouch: true },
  { name: '667x375 touch', viewport: { width: 667, height: 375 }, hasTouch: true },
];

for (const c of LAYOUTS) {
  for (const lang of ['en', 'ja'] as const) {
    test.describe(`GAME OVER modal with every line at ${c.name} (${lang})`, () => {
      test.use({ viewport: c.viewport, hasTouch: c.hasTouch });

      test('stays on screen, its lines and buttons never overlapping', async ({ page }) => {
        await failRankingCheck(page);
        await page.addInitScript(() => localStorage.setItem('qixxx.highScore', '999999'));
        await pinNormalSeed(page, 1);
        await open(page, `?lang=${lang}`);
        await start(page);
        await claimSmallBox(page);
        await toModal(page);
        const before = await buttonBoxes(page);
        await finishGameOverResult(page);
        await expect(page.locator('#gameover-highlight')).toBeVisible();
        await expect(page.locator('#gameover-to-best')).toBeVisible();
        expect(await buttonBoxes(page)).toEqual(before);
        const m = await page.evaluate(() => {
          const modal = document.getElementById('gameover-modal')!;
          const box = (el: Element) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          };
          // Every visible line and button: the modal's own children, the
          // score row's lines and the best slot's line.
          const parts: Element[] = [];
          const add = (el: Element) => {
            const style = getComputedStyle(el);
            if (style.display === 'none') return;
            // Rows and slots without an id of their own: their lines, one by one.
            if (style.display === 'contents' || (el.id === '' && el.children.length > 0)) {
              for (const child of el.children) add(child);
              return;
            }
            if (style.visibility === 'hidden') return;
            parts.push(el);
          };
          for (const child of modal.children) add(child);
          return {
            modal: box(modal),
            parts: parts.map((el) => ({ id: el.id || el.textContent, ...box(el) })),
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        });
        expect(m.modal.left).toBeGreaterThanOrEqual(0);
        expect(m.modal.top).toBeGreaterThanOrEqual(0);
        expect(m.modal.right).toBeLessThanOrEqual(m.viewport.width);
        expect(m.modal.bottom).toBeLessThanOrEqual(m.viewport.height);
        const ids = m.parts.map((p) => p.id);
        for (const id of ['gameover-highlight', 'gameover-to-best', 'gameover-retry-button', 'gameover-back-button', 'gameover-share-button']) {
          expect(ids).toContain(id);
        }
        for (const p of m.parts) {
          expect(p.left, String(p.id)).toBeGreaterThanOrEqual(m.modal.left - 0.5);
          expect(p.right, String(p.id)).toBeLessThanOrEqual(m.modal.right + 0.5);
          expect(p.top, String(p.id)).toBeGreaterThanOrEqual(m.modal.top - 0.5);
          expect(p.bottom, String(p.id)).toBeLessThanOrEqual(m.modal.bottom + 0.5);
        }
        for (let i = 0; i < m.parts.length; i++) {
          for (let j = i + 1; j < m.parts.length; j++) {
            const a = m.parts[i];
            const b = m.parts[j];
            const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
            expect(overlap, `${a.id} / ${b.id}`).toBe(false);
          }
        }
      });
    });
  }
}

// A short ranking replay that ends on a 'life' GAME OVER: the marker stubs a
// line into the field and stands on it until the Igniter burns it, three times.
async function recordIgniterReplay(seed: number): Promise<string> {
  const { GameSession } = await import('../../src/core/session');
  const { encodeRle } = await import('../../src/core/rle');
  const session = new GameSession({ seed });
  session.update({ dx: 0, dy: 0, drawHeld: false, slow: false, confirm: true });
  const samples: Array<{ dx: -1 | 0 | 1; dy: -1 | 0 | 1; drawHeld: boolean; slow: boolean }> = [];
  let pulse = 0;
  for (let i = 0; i < 6000 && session.getStatus() !== 'gameover'; i++) {
    const g = session.getGame();
    if (pulse === 0 && !g.getMarker().isDrawing() && g.getGraceTicks() === 0) pulse = 12;
    const down = pulse > 0;
    if (pulse > 0) pulse--;
    const sample = { dx: 0 as const, dy: (down ? 1 : 0) as 0 | 1, drawHeld: down, slow: false };
    samples.push(sample);
    session.update({ ...sample, confirm: false });
    session.drainEvents();
    session.drainDespawnedEmberPositions();
  }
  expect(session.getStatus()).toBe('gameover');
  return Buffer.from(encodeRle(samples)).toString('base64');
}

test('a ranking replay reaching GAME OVER plays no close and no count-up', async ({ page }) => {
  const { RULESET_VERSION, REPLAY_FORMAT_VERSION } = await import('../../src/config');
  const rleBase64 = await recordIgniterReplay(7);
  const entry = { id: 'burnt', createdAt: '2026-01-01T00:00:00Z', score: 0, stage: 1, name: 'BURNT', xHandle: null, replayAvailable: true };
  await page.route('**/api/ranking', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries: [entry], displayEntries: [{ ...entry, status: 'verified' }] }),
    })
  );
  await page.route('**/api/ranking/*/replay', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seed: 7, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
    })
  );
  await soundOn(page);
  await pinNormalSeed(page, 3);
  await open(page);
  await page.locator('#ranking-button').click();
  await advanceUntil(page, () => page.getByRole('button', { name: 'REPLAY' }).isVisible(), 2_000, 100);
  await page.getByRole('button', { name: 'REPLAY' }).click();
  await advanceUntil(page, () => page.getByRole('button', { name: 'EXIT' }).isVisible(), 2_000, 100);
  await advanceUntil(page, async () => ((await page.locator('#screen').textContent()) ?? '').includes('GAME OVER - REPLAY END'), 60_000, 500);
  await page.clock.runFor(1_500);
  expect(await sfxLog(page)).toEqual([]);
  expect((await result(page)).active).toBe(false);
  await expect(page.locator('#gameover-modal')).toBeHidden();
});
