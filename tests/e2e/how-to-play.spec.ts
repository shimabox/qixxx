// HOW TO PLAY (src/ui/howToPlay.ts): the Title menu's first button, its
// one-screen panel, and the confirms it holds back. Plus the
// in-play hints staying off a replay. Runs on a faked page clock
// (tests/e2e/support/fakeClock.ts), so budgets are game time.
import { test, expect, type Page, type Browser } from '@playwright/test';
import { GameSession } from '../../src/core/session';
import { encodeRle, type InputSample } from '../../src/core/rle';
import { RULESET_VERSION, REPLAY_FORMAT_VERSION, TITLE_BUTTON_COMPACT_FONT_PX, TITLE_MENU_FONT_PX } from '../../src/config';
import { advanceUntil, loseAllLivesToIgniter } from './support/fakeClock';

declare global {
  interface Window {
    __game__?: {
      session: { getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover' };
      getHint: () => { id: string } | null;
      getHintMarks: () => unknown;
    };
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;

const VIEWPORTS = [
  { width: 1280, height: 800, hasTouch: false },
  { width: 390, height: 844, hasTouch: true },
  { width: 844, height: 390, hasTouch: true },
  { width: 667, height: 375, hasTouch: true },
];

const LINES = {
  'en-US': [
    'HOLD SPACE AND MOVE TO DRAW A LINE',
    'REACH THE BORDER AGAIN TO CLAIM THE AREA',
    'YOU GET THE SIDE WITHOUT ENEMIES',
    'SPLIT THE WISPS TO CLEAR AT ONCE',
  ],
  'ja-JP': ['Space を押しながら動くと線が引ける', '線を枠までつなぐと陣地になる', '敵のいない側が自分の陣地', 'ウィスプを切り分けると一発クリア'],
} as const;
const TOUCH_FIRST_LINE = { 'en-US': 'HOLD FAST AND MOVE TO DRAW A LINE', 'ja-JP': 'FAST を押しながら動くと線が引ける' } as const;
const GOAL = {
  'en-US': 'FILL UP TO THE GOAL % TO CLEAR. ONE RUN IS 3 MINUTES',
  'ja-JP': '目標の % まで囲むとクリア。1 プレイは 3 分',
} as const;
// The line below the goal on how to pause, per input.
const PAUSE_LINE = {
  key: { 'en-US': 'PRESS P OR ESC TO PAUSE', 'ja-JP': 'P か Esc キーで一時停止' },
  touch: { 'en-US': 'TAP PAUSE TO PAUSE', 'ja-JP': 'PAUSE を押すと一時停止' },
} as const;

async function open(page: Page, query = ''): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
}

const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());
const rect = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => el.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number; width: number; height: number });

async function newPage(browser: Browser, locale: string, viewport: { width: number; height: number; hasTouch: boolean }): Promise<Page> {
  const context = await browser.newContext({ locale, viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.hasTouch });
  return context.newPage();
}

test.describe('the HOW TO PLAY button', () => {
  test('shows on Title only: not while playing, not on GAME OVER', async ({ page }) => {
    await open(page, '?seed=1');
    const button = page.locator('#how-to-play-button');
    await expect(button).toBeVisible();
    await expect(button).toHaveText('HOW TO PLAY');
    await page.keyboard.press('Enter');
    await page.clock.runFor(100);
    expect(await status(page)).toBe('playing');
    await expect(button).toBeHidden();
    await loseAllLivesToIgniter(page);
    await page.clock.runFor(1_000);
    await expect(page.locator('#gameover-modal')).toBeVisible();
    await expect(button).toBeHidden();
  });

  for (const locale of ['en-US', 'ja-JP'] as const) {
    for (const viewport of VIEWPORTS) {
      test(`stays clear of RANKING and the title text, both whole and pressable, at ${viewport.width}x${viewport.height} (${locale})`, async ({ browser }) => {
        const page = await newPage(browser, locale, viewport);
        await open(page);
        const field = await rect(page, '#game-canvas');
        const root = await rect(page, '#game-root');
        const how = await rect(page, '#how-to-play-button');
        const ranking = await rect(page, '#ranking-button');
        const intersects = (a: typeof how, b: typeof how) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const within = (a: typeof how, b: typeof how) =>
          a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
        const screenBox = { left: 0, top: 0, right: viewport.width, bottom: viewport.height, width: viewport.width, height: viewport.height };
        // On the field where the Title menu sits under the title text; just
        // under it on a field too small for that (667x375). Either way whole
        // inside #game-root, on screen, and pressed where it shows.
        const onField = within(how, field) && within(ranking, field);
        expect(onField).toBe(viewport.width !== 667);
        for (const [id, r] of [
          ['how-to-play-button', how],
          ['ranking-button', ranking],
        ] as const) {
          expect(within(r, root)).toBe(true);
          expect(within(r, screenBox)).toBe(true);
          const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
          expect(hit).toBe(id);
        }
        expect(intersects(how, ranking)).toBe(false);
        // Same build as RANKING.
        expect(Math.abs(how.height - ranking.height)).toBeLessThanOrEqual(1);
        // Neither covers the title text (QIXXX, HI SCORE, the start line):
        // not #screen's box, nor any line of its text.
        await expect(page.locator('#screen')).toContainText('QIXXX');
        const text = await page.evaluate(() => {
          const screen = document.getElementById('screen')!;
          const range = document.createRange();
          range.selectNodeContents(screen);
          const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => r.toJSON() as DOMRect);
          return { box: screen.getBoundingClientRect().toJSON() as DOMRect, lines };
        });
        expect(text.lines.length).toBeGreaterThan(0);
        for (const r of [how, ranking]) {
          expect(intersects(r, text.box)).toBe(false);
          for (const line of text.lines) expect(intersects(r, line)).toBe(false);
        }
        // The title text stays on the field.
        expect(text.box.top).toBeGreaterThanOrEqual(field.top);
        expect(text.box.bottom).toBeLessThanOrEqual(field.bottom);
        // In one row, HOW TO PLAY on the left and RANKING on the right, the
        // same size: small on a field too narrow for the roomy row.
        expect(Math.abs(how.top - ranking.top)).toBeLessThanOrEqual(1);
        expect(how.right).toBeLessThanOrEqual(ranking.left);
        const fontPx = (selector: string) => page.locator(selector).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        const size = viewport.width === 667 ? TITLE_BUTTON_COMPACT_FONT_PX : TITLE_MENU_FONT_PX;
        expect(await fontPx('#how-to-play-button')).toBe(size);
        expect(await fontPx('#ranking-button')).toBe(size);
        await page.context().close();
      });
    }
  }
});

for (const locale of ['en-US', 'ja-JP'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`the panel (${locale}, ${viewport.width}x${viewport.height}): four pictures and lines, the goal and pause lines and CLOSE, on screen, 12px or more`, async ({ browser }) => {
      const page = await newPage(browser, locale, viewport);
      await open(page);
      await page.locator('#how-to-play-button').click();
      const panel = page.locator('#how-to-play-panel');
      await expect(panel).toBeVisible();
      await expect(panel.locator('figure svg')).toHaveCount(4);
      const lines = [...LINES[locale]];
      if (viewport.hasTouch) lines[0] = TOUCH_FIRST_LINE[locale];
      await expect(panel.locator('figcaption')).toHaveText(lines);
      await expect(page.locator('#how-to-play-goal')).toHaveText(GOAL[locale]);
      await expect(page.locator('#how-to-play-pause')).toHaveText(PAUSE_LINE[viewport.hasTouch ? 'touch' : 'key'][locale]);
      // Read like the goal line, right below it, overlapping nothing.
      const pauseLine = await page.evaluate(() => {
        const style = (id: string) => {
          const s = getComputedStyle(document.getElementById(id)!);
          return { fontSize: s.fontSize, color: s.color, opacity: s.opacity };
        };
        const pause = document.getElementById('how-to-play-pause')!;
        const box = pause.getBoundingClientRect();
        const others = [...document.querySelectorAll<HTMLElement>('#how-to-play-body > div:first-child, .how-to-play-step, #how-to-play-goal, #how-to-play-close')];
        return {
          goal: style('how-to-play-goal'),
          pause: style('how-to-play-pause'),
          afterGoal: pause.previousElementSibling?.id,
          overlaps: others
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.left < box.right && box.left < r.right && r.top < box.bottom && box.top < r.bottom).length,
          overflows: pause.scrollWidth > pause.clientWidth + 1,
        };
      });
      expect(pauseLine.pause).toEqual(pauseLine.goal);
      expect(pauseLine).toMatchObject({ afterGoal: 'how-to-play-goal', overlaps: 0, overflows: false });
      await expect(panel.getByText('HOW TO PLAY', { exact: true })).toBeVisible();
      await expect(panel.locator('#how-to-play-close')).toHaveText('CLOSE');

      const box = await rect(page, '#how-to-play-panel');
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(viewport.width);
      expect(box.bottom).toBeLessThanOrEqual(viewport.height);
      const fonts = await panel.evaluate((el) =>
        [...el.querySelectorAll<HTMLElement>('figcaption, #how-to-play-goal, #how-to-play-pause, #how-to-play-close, div')].map((node) => parseFloat(getComputedStyle(node).fontSize))
      );
      for (const px of fonts) expect(px).toBeGreaterThanOrEqual(12);
      if (locale === 'ja-JP') {
        expect(await panel.locator('figcaption').first().evaluate((el) => (el as HTMLElement).lang)).toBe('ja');
      }

      // All of it on screen at once, without scrolling: the heading, the four
      // pictures and lines, the goal and pause lines and CLOSE.
      const boxes = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('#how-to-play-body > div:first-child, .how-to-play-step, .how-to-play-step svg, #how-to-play-goal, #how-to-play-pause, #how-to-play-close')].map(
          (el) => ({ id: el.id || el.className || el.tagName, ...(el.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number }) })
        )
      );
      expect(boxes).toHaveLength(1 + 4 + 4 + 1 + 1 + 1);
      for (const b of boxes) {
        expect(b.left, b.id).toBeGreaterThanOrEqual(0);
        expect(b.top, b.id).toBeGreaterThanOrEqual(0);
        expect(b.right, b.id).toBeLessThanOrEqual(viewport.width);
        expect(b.bottom, b.id).toBeLessThanOrEqual(viewport.height);
      }
      // Nothing is left over to scroll, in the panel or its contents.
      for (const selector of ['#how-to-play-panel', '#how-to-play-body']) {
        const fit = await page.locator(selector).evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
        expect(fit.scroll, selector).toBeLessThanOrEqual(fit.client);
      }
      // CLOSE sits below the contents, at the panel's bottom.
      const body = await rect(page, '#how-to-play-body');
      const closeBox = await rect(page, '#how-to-play-close');
      expect(closeBox.top).toBeGreaterThanOrEqual(body.bottom);
      expect(closeBox.bottom).toBeLessThanOrEqual(box.bottom);
      const close = page.locator('#how-to-play-close');
      await close.click();
      await expect(panel).toBeHidden();
      await page.context().close();
    });
  }
}

for (const viewport of VIEWPORTS) {
  test(`the split picture at ${viewport.width}x${viewport.height}: CLEAR! clear of both wisps, one wisp each side of the line`, async ({ browser }) => {
    const page = await newPage(browser, 'ja-JP', viewport);
    await open(page);
    await page.locator('#how-to-play-button').click();
    await expect(page.locator('#how-to-play-panel')).toBeVisible();
    const split = page.locator('.how-to-play-step').nth(3);
    const box = (el: Element) => el.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number };
    const mark = await split.locator('.how-to-play-clear-mark').evaluate(box);
    const wisps = await split.locator('.how-to-play-wisp').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number }));
    const line = await split.locator('polyline').evaluate(box);
    const picture = await split.locator('svg').evaluate(box);
    expect(wisps).toHaveLength(2);
    expect(mark.right - mark.left).toBeGreaterThan(0);
    for (const w of wisps) {
      const overlaps = mark.left < w.right && w.left < mark.right && mark.top < w.bottom && w.top < mark.bottom;
      expect(overlaps, JSON.stringify({ mark, w })).toBe(false);
    }
    const lineX = (line.left + line.right) / 2;
    expect(wisps.filter((w) => w.right < lineX)).toHaveLength(1);
    expect(wisps.filter((w) => w.left > lineX)).toHaveLength(1);
    // The mark stays inside the picture.
    expect(mark.left).toBeGreaterThanOrEqual(picture.left);
    expect(mark.right).toBeLessThanOrEqual(picture.right);
    expect(mark.top).toBeGreaterThanOrEqual(picture.top);
    await page.context().close();
  });

  test(`the lines at ${viewport.width}x${viewport.height} (ja-JP): balanced, no last line of a character or two`, async ({ browser }) => {
    const page = await newPage(browser, 'ja-JP', viewport);
    await open(page);
    await page.locator('#how-to-play-button').click();
    await expect(page.locator('#how-to-play-panel')).toBeVisible();
    const texts = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#how-to-play .how-to-play-text')].map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        // One width per line: the line's boxes, grouped by their top.
        const widths = new Map<number, number>();
        for (const r of range.getClientRects()) {
          if (r.width === 0) continue;
          const top = Math.round(r.top);
          widths.set(top, (widths.get(top) ?? 0) + r.width);
        }
        return {
          text: el.textContent ?? '',
          wrap: el.style.getPropertyValue('text-wrap'),
          fontPx: parseFloat(getComputedStyle(el).fontSize),
          widths: [...widths.values()],
        };
      })
    );
    expect(texts).toHaveLength(6);
    for (const { text, wrap, fontPx, widths } of texts) {
      expect(wrap, text).toBe('balance');
      if (widths.length < 2) continue;
      // No line is a character or two (full-width characters are 1em wide)
      // or under a third of the longest.
      const detail = `${text}: ${widths.join(', ')}`;
      expect(Math.min(...widths), detail).toBeGreaterThanOrEqual(fontPx * 3);
      expect(Math.min(...widths) / Math.max(...widths), detail).toBeGreaterThanOrEqual(1 / 3);
    }
    await page.context().close();
  });
}

test.describe('confirms while HOW TO PLAY is open', () => {
  test('Enter and Space close it without starting a run; a key 12 ticks later starts one', async ({ page }) => {
    await open(page);
    for (const key of ['Enter', 'Space']) {
      await page.locator('#how-to-play-button').click();
      await expect(page.locator('#how-to-play')).toBeVisible();
      await page.keyboard.press(key);
      await expect(page.locator('#how-to-play')).toBeHidden();
      await page.clock.runFor(FRAME_MS * 20);
      expect(await status(page), key).toBe('title');
    }
    // Within the wait after closing, a key is dropped too.
    await page.locator('#how-to-play-button').click();
    await page.keyboard.press('KeyA');
    await page.clock.runFor(FRAME_MS * 4);
    await page.keyboard.press('Enter');
    await page.clock.runFor(FRAME_MS * 20);
    expect(await status(page)).toBe('title');
    // Past it, the next key starts the run as always.
    await page.keyboard.press('Enter');
    await advanceUntil(page, async () => (await status(page)) === 'playing', 500, FRAME_MS);
  });

  test('opened from the keyboard (Tab, Enter), it keeps Tab inside and a closing key leaves it closed', async ({ page }) => {
    await open(page);
    const focused = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        return { id: el?.id ?? '', inPanel: document.getElementById('how-to-play')!.contains(el) };
      });
    for (const key of ['Enter', 'Space']) {
      // Tab to HOW TO PLAY, as a keyboard player would, and press it.
      for (let i = 0; i < 8 && (await focused()).id !== 'how-to-play-button'; i++) await page.keyboard.press('Tab');
      expect((await focused()).id).toBe('how-to-play-button');
      await page.keyboard.press(key);
      await expect(page.locator('#how-to-play')).toBeVisible();
      expect((await focused()).id).toBe('how-to-play-close');
      // Tab never lands on the buttons behind the panel.
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab');
        const now = await focused();
        expect(['how-to-play-button', 'ranking-button', 'mute-button'], `Tab ${i + 1}`).not.toContain(now.id);
        expect(now.inPanel || now.id === '', `Tab ${i + 1}: ${now.id}`).toBe(true);
      }
      expect(await page.evaluate(() => (document.getElementById('how-to-play-button') as HTMLElement & { inert: boolean }).closest('[inert]') !== null)).toBe(true);
      // Back on CLOSE (or wherever Tab left it), the key closes the panel,
      // its default action (pressing the focused button) stopped...
      await page.locator('#how-to-play-close').focus();
      await page.evaluate(() => {
        const w = window as unknown as { __closeKeyPrevented__?: boolean };
        delete w.__closeKeyPrevented__;
        window.addEventListener('keydown', (e) => (w.__closeKeyPrevented__ ??= e.defaultPrevented), { capture: true, once: true });
      });
      await page.keyboard.press(key);
      expect(await page.evaluate(() => (window as unknown as { __closeKeyPrevented__?: boolean }).__closeKeyPrevented__), key).toBe(true);
      // ...and it stays closed: the key does not press a button again.
      for (let i = 0; i < 4; i++) {
        await page.clock.runFor(FRAME_MS * 10);
        await expect(page.locator('#how-to-play'), key).toBeHidden();
      }
      // Nor does it start a run.
      expect(await status(page), key).toBe('title');
      expect(await page.evaluate(() => document.querySelector('[inert]'))).toBeNull();
    }
    // The next key starts the run as always.
    await page.keyboard.press('Enter');
    await advanceUntil(page, async () => (await status(page)) === 'playing', 500, FRAME_MS);
  });

  for (const key of ['Enter', 'Space']) {
    test(`${key} held down past the wait, auto-repeating, leaves it closed on Title; released and pressed again, it starts a run`, async ({ page }) => {
      await open(page);
      await page.locator('#how-to-play-button').click();
      await expect(page.locator('#how-to-play')).toBeVisible();
      await page.keyboard.down(key);
      await expect(page.locator('#how-to-play')).toBeHidden();
      // Counts the repeat key-downs that arrive, to be sure they did.
      await page.evaluate(() => {
        const w = window as unknown as { __repeats__: number };
        w.__repeats__ = 0;
        window.addEventListener('keydown', (e) => (w.__repeats__ += e.repeat ? 1 : 0), true);
      });
      // 120 ticks, ten times the wait. The key's auto-repeat starts past the
      // wait, as a browser's does (about half a second in), and arrives all
      // along: Playwright's own (keyboard.down() again on the held key) and a
      // repeat key-down sent to the window.
      await page.clock.runFor(FRAME_MS * 30);
      for (let i = 0; i < 9; i++) {
        await page.clock.runFor(FRAME_MS * 10);
        await page.keyboard.down(key);
        await page.evaluate((code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'Space' ? ' ' : code, repeat: true })), key);
        await expect(page.locator('#how-to-play'), `${key} ${i}`).toBeHidden();
        expect(await status(page), `${key} ${i}`).toBe('title');
      }
      await page.clock.runFor(FRAME_MS * 10);
      expect(await page.evaluate(() => (window as unknown as { __repeats__: number }).__repeats__)).toBeGreaterThanOrEqual(18);
      await expect(page.locator('#how-to-play')).toBeHidden();
      expect(await status(page)).toBe('title');
      // Released and pressed again: the run starts as always.
      await page.keyboard.up(key);
      await page.clock.runFor(FRAME_MS * 2);
      expect(await status(page)).toBe('title');
      await page.keyboard.press(key);
      await advanceUntil(page, async () => (await status(page)) === 'playing', 500, FRAME_MS);
    });
  }

  test('a press on the field closes it without starting a run; CLOSE does the same', async ({ page }) => {
    await open(page);
    await page.locator('#how-to-play-button').click();
    const field = await rect(page, '#game-canvas');
    await page.mouse.click(field.left + field.width / 2, field.top + field.height - 10);
    await expect(page.locator('#how-to-play')).toBeHidden();
    await page.clock.runFor(FRAME_MS * 30);
    expect(await status(page)).toBe('title');
    await page.locator('#how-to-play-button').click();
    await page.locator('#how-to-play-close').click();
    await expect(page.locator('#how-to-play')).toBeHidden();
    await page.clock.runFor(FRAME_MS * 30);
    expect(await status(page)).toBe('title');
  });

  test.describe('on a touch device (390x844)', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('taps on the field or the touch buttons close it without starting a run', async ({ page }) => {
      await open(page);
      for (const target of ['#game-canvas', '#touch-controls button[data-code="Space"]', '#touch-dpad']) {
        await page.locator('#how-to-play-button').click();
        await expect(page.locator('#how-to-play')).toBeVisible();
        const box = await rect(page, target);
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        // The panel may cover the spot: a tap on it leaves it open, a tap on
        // the backdrop closes it. Neither reaches what is beneath.
        const onPanel = await page.evaluate(([px, py]) => document.getElementById('how-to-play-panel')!.contains(document.elementFromPoint(px, py)), [x, y]);
        await page.touchscreen.tap(x, y);
        await page.clock.runFor(FRAME_MS * 30);
        expect(await status(page), target).toBe('title');
        if (onPanel) {
          await expect(page.locator('#how-to-play'), target).toBeVisible();
          await page.locator('#how-to-play-close').click();
        }
        await expect(page.locator('#how-to-play'), target).toBeHidden();
        await page.clock.runFor(FRAME_MS * 30);
        expect(await status(page), target).toBe('title');
      }
      // Once closed, a tap on the field starts the run as always.
      const field = await rect(page, '#game-canvas');
      await page.touchscreen.tap(field.left + field.width / 2, field.top + field.height / 2);
      await advanceUntil(page, async () => (await status(page)) === 'playing', 500, FRAME_MS);
    });
  });
});

test.describe('HOW TO PLAY and the ranking list', () => {
  test('one closes the other', async ({ page }) => {
    await page.route('**/api/ranking', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries: [], displayEntries: [] }) })
    );
    await open(page);
    await page.locator('#ranking-button').click();
    await expect(page.locator('#ranking-list-body')).toBeVisible();
    // With the list open, HOW TO PLAY is reached from the keyboard (the
    // Title menu takes no press of the mouse then).
    const focused = () => page.evaluate(() => document.activeElement?.id ?? '');
    for (let i = 0; i < 20 && (await focused()) !== 'how-to-play-button'; i++) await page.keyboard.press('Tab');
    expect(await focused()).toBe('how-to-play-button');
    await page.keyboard.press('Enter');
    await expect(page.locator('#how-to-play')).toBeVisible();
    await expect(page.locator('#ranking-list-body')).toBeHidden();
    // The panel covers the page; close it, then open the list.
    await page.locator('#how-to-play-close').click();
    await page.locator('#how-to-play-button').click();
    await expect(page.locator('#how-to-play')).toBeVisible();
    await page.evaluate(() => (document.getElementById('ranking-button') as HTMLButtonElement).click());
    await expect(page.locator('#ranking-list-body')).toBeVisible();
    await expect(page.locator('#how-to-play')).toBeHidden();
  });
});

function recordReplay(seed: number, ticks: number): string {
  const session = new GameSession({ seed, timeLimitTicks: ticks });
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  const samples: InputSample[] = [];
  while (session.getStatus() === 'playing') {
    const input: InputSample = { dx: 1, dy: 0, drawHeld: false, slow: false };
    session.update({ ...input, confirm: false });
    samples.push(input);
  }
  return Buffer.from(encodeRle(samples)).toString('base64');
}

test.describe('replay viewing', () => {
  test('shows no HOW TO PLAY, no hint line and no hint mark, and leaves the seen hints alone', async ({ page }) => {
    const rleBase64 = recordReplay(2026, 900);
    await page.route('**/api/ranking', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          seasonId: 1,
          rulesetVersion: RULESET_VERSION,
          entries: [],
          displayEntries: [
            { id: 'r1', createdAt: '2026-01-01T12:00:00Z', score: 1, stage: 1, name: 'R', xHandle: null, replayAvailable: true, status: 'verified' },
          ],
        }),
      })
    );
    await page.route('**/api/ranking/*/replay', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ seed: 2026, rleBase64, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION }),
      })
    );
    await open(page);
    expect(await page.evaluate(() => localStorage.getItem('qixxx.hintsSeen'))).toBeNull();
    await page.locator('#ranking-button').click();
    await page.getByRole('button', { name: 'REPLAY' }).click();
    await advanceUntil(page, async () => page.getByRole('button', { name: 'EXIT' }).isVisible(), 5_000, FRAME_MS);
    for (let i = 0; i < 20; i++) {
      await page.clock.runFor(FRAME_MS * 10);
      await expect(page.locator('#how-to-play-button')).toBeHidden();
      await expect(page.locator('#hint-bar')).toBeHidden();
      expect(await page.evaluate(() => window.__game__!.getHint())).toBeNull();
      expect(await page.evaluate(() => window.__game__!.getHintMarks())).toBeNull();
    }
    expect(await page.evaluate(() => localStorage.getItem('qixxx.hintsSeen'))).toBeNull();
    await page.getByRole('button', { name: 'EXIT' }).click();
    await page.clock.runFor(100);
    await expect(page.locator('#how-to-play-button')).toBeVisible();
  });
});
