// HOW TO PLAY's PLAY WITH HINTS (src/ui/howToPlay.ts): forgets the in-play
// hints already seen and starts a run the way a confirm on the Title screen
// does. Runs on a faked page clock (tests/e2e/support/fakeClock.ts), so
// budgets are game time.
import { test, expect, type Page, type Browser } from '@playwright/test';
import { advanceUntil } from './support/fakeClock';

declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getScore: () => number;
        getLives: () => number;
        getTotalTicks: () => number;
        getGame: () => {
          getMarker: () => { getPosition: () => { x: number; y: number }; isDrawing: () => boolean };
          getWisps: () => Array<{ getPosition: () => { x: number; y: number } }>;
          getOccupancy: () => number;
        };
      };
      getHint: () => { id: string } | null;
      getConfirmCount: () => number;
    };
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const ALL_HINTS = ['draw', 'claimSide', 'slow', 'split', 'ember', 'blaze', 'igniter'];
const SEEN_KEY = 'qixxx.hintsSeen';

const VIEWPORTS = [
  { width: 1280, height: 800, hasTouch: false },
  { width: 390, height: 844, hasTouch: true },
  { width: 844, height: 390, hasTouch: true },
  { width: 667, height: 375, hasTouch: true },
];

const DRAW_HINT = {
  key: { 'en-US': 'HOLD SPACE + ARROW KEYS TO DRAW A LINE', 'ja-JP': 'Space を押しながら矢印キーで線を引こう' },
  touch: { 'en-US': 'HOLD FAST + A DIRECTION TO DRAW A LINE', 'ja-JP': 'FAST を押しながら方向ボタンで線を引こう' },
} as const;

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

/** Opens the page on a faked clock, every hint already seen unless `seen` is false. */
async function open(page: Page, query = '?seed=1', seen = true): Promise<void> {
  if (seen) await page.addInitScript(([key, ids]) => localStorage.setItem(key as string, JSON.stringify(ids)), [SEEN_KEY, ALL_HINTS] as const);
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
}

async function openPanel(page: Page): Promise<void> {
  await page.locator('#how-to-play-button').click();
  await expect(page.locator('#how-to-play')).toBeVisible();
}

const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());
const seenHints = (page: Page) => page.evaluate((key) => localStorage.getItem(key), SEEN_KEY);
const rect = (page: Page, selector: string) => page.locator(selector).evaluate((el) => el.getBoundingClientRect().toJSON() as Box);
const intersects = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function newPage(browser: Browser, locale: string, viewport: { width: number; height: number; hasTouch: boolean }): Promise<Page> {
  const context = await browser.newContext({ locale, viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.hasTouch });
  return context.newPage();
}

/** The run started from PLAY WITH HINTS: playing, nothing seen, the drawing hint on the bar. */
async function expectStartedWithHints(page: Page, drawText: string): Promise<void> {
  await expect(page.locator('#how-to-play')).toBeHidden();
  await advanceUntil(page, async () => (await status(page)) === 'playing', 500, FRAME_MS * 2);
  expect([null, '[]']).toContain(await seenHints(page));
  await advanceUntil(page, async () => (await page.evaluate(() => window.__game__!.getHint()?.id)) === 'draw', 1_000, FRAME_MS * 4);
  await expect(page.locator('#hint-bar')).toBeVisible();
  await expect(page.locator('#hint-bar')).toHaveText(drawText);
}

for (const locale of ['en-US', 'ja-JP'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`CLOSE sits left of PLAY WITH HINTS in one row, on the panel, Tab going CLOSE then PLAY WITH HINTS, at ${viewport.width}x${viewport.height} (${locale})`, async ({ browser }) => {
      const page = await newPage(browser, locale, viewport);
      await open(page, '');
      await openPanel(page);
      const play = page.locator('#how-to-play-with-hints');
      await expect(play).toHaveText('PLAY WITH HINTS');
      await expect(page.locator('#how-to-play-close')).toHaveText('CLOSE');
      const measure = () =>
        page.evaluate(() => {
          const box = (id: string) => document.getElementById(id)!.getBoundingClientRect().toJSON() as Box;
          const fits = (id: string) => {
            const el = document.getElementById(id)!;
            return el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1;
          };
          const body = document.getElementById('how-to-play-body')!;
          return {
            play: box('how-to-play-with-hints'),
            close: box('how-to-play-close'),
            panel: box('how-to-play-panel'),
            body: box('how-to-play-body'),
            textFits: fits('how-to-play-with-hints') && fits('how-to-play-close'),
            inBody: body.contains(document.getElementById('how-to-play-with-hints')) || body.contains(document.getElementById('how-to-play-close')),
            fontPx: ['how-to-play-with-hints', 'how-to-play-close'].map((id) => parseFloat(getComputedStyle(document.getElementById(id)!).fontSize)),
          };
        });
      const m = await measure();
      // One row, CLOSE on the left, the two apart and the same height.
      expect(Math.abs(m.play.top - m.close.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.play.height - m.close.height)).toBeLessThanOrEqual(1);
      expect(m.close.right).toBeLessThanOrEqual(m.play.left);
      expect(intersects(m.play, m.close)).toBe(false);
      expect(m.textFits).toBe(true);
      for (const px of m.fontPx) expect(px).toBeGreaterThanOrEqual(12);
      // On the panel, below its scrolling contents, on the screen.
      expect(m.inBody).toBe(false);
      for (const b of [m.play, m.close]) {
        expect(b.left).toBeGreaterThanOrEqual(m.panel.left);
        expect(b.right).toBeLessThanOrEqual(m.panel.right);
        expect(b.top).toBeGreaterThanOrEqual(m.body.bottom);
        expect(b.bottom).toBeLessThanOrEqual(m.panel.bottom);
        expect(b.right).toBeLessThanOrEqual(viewport.width);
        expect(b.bottom).toBeLessThanOrEqual(viewport.height);
      }
      // Wherever the contents are scrolled, the buttons stay where they are.
      await page.locator('#how-to-play-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
      const scrolled = await measure();
      expect(scrolled.play).toEqual(m.play);
      expect(scrolled.close).toEqual(m.close);
      // Tab goes the way they read: focus starts on CLOSE, then PLAY WITH HINTS.
      const focusedId = () => page.evaluate(() => document.activeElement?.id ?? '');
      expect(await focusedId()).toBe('how-to-play-close');
      await page.keyboard.press('Tab');
      expect(await focusedId()).toBe('how-to-play-with-hints');
      await expect(page.locator('#how-to-play')).toBeVisible();
      await page.context().close();
    });
  }
}

test.describe('PLAY WITH HINTS', () => {
  test('a click: forgets the seen hints, closes the panel and starts a run with the first hint', async ({ page }) => {
    await open(page);
    expect(JSON.parse((await seenHints(page))!)).toEqual(ALL_HINTS);
    await openPanel(page);
    // Opening the panel leaves the seen hints alone.
    expect(JSON.parse((await seenHints(page))!)).toEqual(ALL_HINTS);
    await page.locator('#how-to-play-with-hints').click();
    await expectStartedWithHints(page, DRAW_HINT.key['en-US']);
  });

  test('Space held from the press: starts the run, but draws only once released and pressed again', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await page.locator('#how-to-play-with-hints').focus();
    await page.keyboard.down('Space');
    await expectStartedWithHints(page, DRAW_HINT.key['en-US']);
    const start = await page.evaluate(() => window.__game__!.session.getGame().getMarker().getPosition());
    // Space still held, its auto-repeat arriving, and a direction pressed
    // into the field: no line.
    await page.keyboard.down('ArrowDown');
    for (let i = 0; i < 4; i++) {
      await page.clock.runFor(FRAME_MS * 15);
      await page.keyboard.down('Space');
    }
    const held = await page.evaluate(() => {
      const marker = window.__game__!.session.getGame().getMarker();
      return { drawing: marker.isDrawing(), y: marker.getPosition().y };
    });
    expect(held).toEqual({ drawing: false, y: start.y });
    // Released and pressed again: the line starts.
    await page.keyboard.up('Space');
    await page.clock.runFor(FRAME_MS * 2);
    await page.keyboard.down('Space');
    await advanceUntil(page, async () => page.evaluate(() => window.__game__!.session.getGame().getMarker().isDrawing()), 1_000, FRAME_MS * 2);
  });

  test('Enter held from the press: starts the run, and passes no further confirm until pressed again', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await page.locator('#how-to-play-with-hints').focus();
    const before = await page.evaluate(() => window.__game__!.getConfirmCount());
    await page.keyboard.down('Enter');
    await expectStartedWithHints(page, DRAW_HINT.key['en-US']);
    const started = await page.evaluate(() => window.__game__!.getConfirmCount());
    // The confirm that started the run.
    expect(started).toBe(before + 1);
    // 120 ticks with Enter held, its auto-repeat arriving all along.
    for (let i = 0; i < 6; i++) {
      await page.clock.runFor(FRAME_MS * 20);
      await page.keyboard.down('Enter');
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', repeat: true })));
    }
    await page.clock.runFor(FRAME_MS * 4);
    expect(await page.evaluate(() => window.__game__!.getConfirmCount())).toBe(started);
    expect(await status(page)).toBe('playing');
    // Released and pressed again, it counts as usual.
    await page.keyboard.up('Enter');
    await page.keyboard.press('Enter');
    await advanceUntil(page, async () => (await page.evaluate(() => window.__game__!.getConfirmCount())) > started, 500, FRAME_MS * 2);
  });

  test('CLOSE, a press outside the panel and Esc leave the seen hints and the Title screen as they are', async ({ page }) => {
    await open(page);
    const field = await rect(page, '#game-canvas');
    const closers: Array<[string, () => Promise<void>]> = [
      ['CLOSE', () => page.locator('#how-to-play-close').click()],
      ['outside', () => page.mouse.click(field.left + 4, field.top + field.height - 4)],
      ['Esc', () => page.keyboard.press('Escape')],
    ];
    for (const [name, closeIt] of closers) {
      await openPanel(page);
      await closeIt();
      await expect(page.locator('#how-to-play'), name).toBeHidden();
      await page.clock.runFor(FRAME_MS * 30);
      expect(await status(page), name).toBe('title');
      expect(JSON.parse((await seenHints(page))!), name).toEqual(ALL_HINTS);
    }
  });

  test.describe('on a touch device (390x844)', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, locale: 'ja-JP' });

    test('a tap starts the run with the first hint', async ({ page }) => {
      await open(page);
      await openPanel(page);
      const box = await rect(page, '#how-to-play-with-hints');
      await page.touchscreen.tap(box.left + box.width / 2, box.top + box.height / 2);
      await expectStartedWithHints(page, DRAW_HINT.touch['ja-JP']);
    });
  });
});

// A run's inputs keyed to its own ticks, so two pages get the very same input
// on the very same tick however their clocks line up: a driver on each frame
// (at most one tick per frame at FRAME_MS) sends the next key change once the
// run has played the tick it is due after, and keeps the state at `snapAt`.
const SCRIPT: Array<{ at: number; code: string; down: boolean }> = [
  { at: 0, code: 'KeyX', down: true },
  { at: 0, code: 'ArrowDown', down: true },
  { at: 14, code: 'ArrowDown', down: false },
  { at: 14, code: 'ArrowRight', down: true },
  { at: 30, code: 'ArrowRight', down: false },
  { at: 30, code: 'ArrowUp', down: true },
  { at: 70, code: 'ArrowUp', down: false },
  { at: 70, code: 'KeyX', down: false },
  { at: 70, code: 'ArrowLeft', down: true },
  { at: 110, code: 'ArrowLeft', down: false },
];
const SNAP_AT = 160;

/** Installs the driver on the Title screen: it waits for the run to start. */
async function installScript(page: Page): Promise<void> {
  await page.evaluate(
    ([script, snapAt]) => {
      const w = window as unknown as { __snap__?: unknown };
      const session = window.__game__!.session;
      let next = 0;
      const drive = () => {
        if (session.getStatus() !== 'playing') {
          requestAnimationFrame(drive);
          return;
        }
        const tick = session.getTotalTicks();
        while (next < script.length && script[next].at <= tick) {
          const { code, down } = script[next++];
          window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code }));
        }
        if (tick === snapAt && w.__snap__ === undefined) {
          const game = session.getGame();
          w.__snap__ = {
            tick,
            score: session.getScore(),
            lives: session.getLives(),
            occupancy: game.getOccupancy(),
            marker: game.getMarker().getPosition(),
            wisps: game.getWisps().map((wisp) => wisp.getPosition()),
          };
        }
        if (w.__snap__ === undefined) requestAnimationFrame(drive);
      };
      requestAnimationFrame(drive);
    },
    [SCRIPT, SNAP_AT] as const
  );
}

/** Plays the run on to the snapshot and returns it. */
async function playScript(page: Page): Promise<unknown> {
  await advanceUntil(page, async () => page.evaluate(() => (window as unknown as { __snap__?: unknown }).__snap__ !== undefined), 10_000, 500);
  return page.evaluate(() => (window as unknown as { __snap__?: unknown }).__snap__);
}

test('a run from PLAY WITH HINTS plays like one started from the Title screen on the same seed', async ({ browser }) => {
  const viewport = { width: 1280, height: 800, hasTouch: false };
  const fromButton = await newPage(browser, 'en-US', viewport);
  const fromTitle = await newPage(browser, 'en-US', viewport);
  await open(fromButton, '?seed=7');
  await open(fromTitle, '?seed=7');
  await installScript(fromButton);
  await installScript(fromTitle);
  await openPanel(fromButton);
  await fromButton.locator('#how-to-play-with-hints').click();
  await fromTitle.keyboard.press('Enter');
  const a = (await playScript(fromButton)) as { score: number; occupancy: number };
  const b = await playScript(fromTitle);
  expect(a).toEqual(b);
  // The script claims an area: the two runs are compared after real play.
  expect(a.score).toBeGreaterThan(0);
  expect(a.occupancy).toBeGreaterThan(0);
  await fromButton.context().close();
  await fromTitle.context().close();
});
