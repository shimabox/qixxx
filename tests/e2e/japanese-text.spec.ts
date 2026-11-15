// The page in Japanese (a ja-JP browser, or ?lang=ja): the sentences —
// directions, notices, status and error lines — are Japanese, while the HUD,
// headings, buttons and the field's size stay as they are in English. Also
// checks that the share text and what is sent to the server do not change
// with the language. Everything runs on a faked page clock
// (tests/e2e/support/fakeClock.ts), so budgets are game time.
import { test, expect, type Page } from '@playwright/test';
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
        getHighScore: () => number;
        getTotalTicks: () => number;
        isRunTainted: () => boolean;
        setDebugTimeLimitTicks: (ticks: number) => void;
        applyDebugOverrides: (overrides: { requiredOccupancy?: number }) => void;
        getGame: () => { getMarker: () => { getPosition: () => Point } };
      };
    };
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;

const JA = {
  start: 'キーを押すかタップでスタート',
  next: 'キーかタップで次のステージへ',
  retry: 'キーか盤面のタップでもう一度',
  notice:
    'X のハンドルは自己申告で、本人確認はしていません。スコアは投稿後に検査されることがあり、無効と分かった記録は削除されます。',
  empty: 'まだ記録がありません',
  needName: '名前か X のハンドルを入力してください',
  accepted: '投稿しました',
};
const JA_FONTS = ['Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic', 'Meiryo', 'monospace'];
/** A computed font-family as its list of names (the browser decides which names it quotes). */
const fontList = (family: string) => family.split(',').map((f) => f.trim().replace(/^"|"$/g, ''));

const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());
const marker = (page: Page) => page.evaluate(() => window.__game__!.session.getGame().getMarker().getPosition());

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
  await page.keyboard.press('Space');
  await page.clock.runFor(100);
  expect(await status(page)).toBe('playing');
}

async function timeUpSoon(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = window.__game__!.session;
    s.setDebugTimeLimitTicks(s.getTotalTicks() + 2);
  });
  await advanceUntil(page, async () => (await status(page)) === 'gameover', 1_000, FRAME_MS);
  await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 500, FRAME_MS);
}

/** tests/e2e/goals-and-retry.spec.ts's scripted claim on seed 1: a small box off the top border. */
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

/** `id`'s box is wholly inside the field's on-screen box. */
async function expectInsideField(page: Page, id: string): Promise<void> {
  const boxes = await page.evaluate((target: string) => {
    const r = (el: Element) => el.getBoundingClientRect();
    return { canvas: r(document.getElementById('game-canvas')!), box: r(document.getElementById(target)!) };
  }, id);
  expect(boxes.box.left).toBeGreaterThanOrEqual(boxes.canvas.left);
  expect(boxes.box.right).toBeLessThanOrEqual(boxes.canvas.right);
  expect(boxes.box.top).toBeGreaterThanOrEqual(boxes.canvas.top);
  expect(boxes.box.bottom).toBeLessThanOrEqual(boxes.canvas.bottom);
}

// The field's on-screen size in English (tests/e2e/goals-and-retry.spec.ts,
// measured on the base commit).
const FIELD_SIZES = [
  { name: '1280x800', viewport: { width: 1280, height: 800 }, hasTouch: false, field: { width: 1021, height: 766 } },
  { name: '390x844 touch', viewport: { width: 390, height: 844 }, hasTouch: true, field: { width: 390, height: 292 } },
  { name: '667x375 touch', viewport: { width: 667, height: 375 }, hasTouch: true, field: { width: 203, height: 152 } },
];

test.describe('in a Japanese browser', () => {
  test.use({ locale: 'ja-JP' });

  for (const c of FIELD_SIZES) {
    test.describe(`at ${c.name}`, () => {
      test.use({ viewport: c.viewport, hasTouch: c.hasTouch });

      test('Title asks in Japanese, <html lang> is ja, the HUD stays English and the field keeps its size', async ({ page }) => {
        await open(page);
        expect(await page.evaluate(() => document.documentElement.lang)).toBe('ja');
        const screen = page.locator('#screen');
        await expect(screen).toContainText('QIXXX');
        await expect(screen).toContainText('HI SCORE: 0');
        await expect(page.locator('#screen-hint')).toHaveText(JA.start);
        expect(fontList(await page.locator('#screen-hint').evaluate((el) => getComputedStyle(el).fontFamily))).toEqual(JA_FONTS);
        await expectInsideField(page, 'screen');

        await start(page);
        const hud = await page.evaluate(() =>
          ['hud-line1', 'hud-line2', 'hud-line3']
            .map((id) => document.getElementById(id)!)
            .filter((el) => el.style.display !== 'none')
            .map((el) => ({ text: el.textContent ?? '', clipped: el.scrollWidth > el.clientWidth + 1 }))
        );
        const text = hud.map((l) => l.text).join('\n');
        for (const word of ['STAGE 1', 'SCORE', 'HI 0', 'TIME', '0%/65% 65% LEFT', 'x1']) expect(text).toContain(word);
        expect(hud.some((l) => l.clipped)).toBe(false);
        const field = await page.locator('#game-canvas').boundingBox();
        expect({ width: field!.width, height: field!.height }).toEqual(c.field);
        await expect(page.locator('#mute-button')).toHaveText(/^(MUTE|UNMUTE)$/);
      });
    });
  }

  for (const c of [
    { name: '390x844', viewport: { width: 390, height: 844 } },
    { name: '844x390', viewport: { width: 844, height: 390 } },
    { name: '667x375', viewport: { width: 667, height: 375 } },
  ]) {
    test.describe(`GAME OVER on a phone ${c.name}`, () => {
      test.use({ viewport: c.viewport, hasTouch: true });

      test('the hint is Japanese; the modal and its three 44px buttons fit on the field', async ({ page }) => {
        await open(page, '?seed=1');
        await start(page);
        await timeUpSoon(page);
        await expect(page.locator('#gameover-hint')).toHaveText(JA.retry);
        await expect(page.locator('#gameover-modal')).toContainText('GAME OVER');
        await expect(page.locator('#gameover-reason')).toHaveText('TIME UP!');
        await expect(page.locator('#gameover-retry-button')).toHaveText('RETRY');
        await expect(page.locator('#gameover-back-button')).toHaveText('TITLE');
        await expect(page.locator('#gameover-share-button')).toHaveText('POST TO X');
        const boxes = await page.evaluate(() => {
          const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
          return {
            canvas: r('game-canvas'),
            modal: r('gameover-modal'),
            hint: r('gameover-hint'),
            buttons: ['gameover-retry-button', 'gameover-back-button', 'gameover-share-button'].map(r),
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        });
        for (const box of [boxes.modal, boxes.hint]) {
          expect(box.left).toBeGreaterThanOrEqual(boxes.canvas.left);
          expect(box.right).toBeLessThanOrEqual(boxes.canvas.right);
          expect(box.top).toBeGreaterThanOrEqual(boxes.canvas.top);
          expect(box.bottom).toBeLessThanOrEqual(boxes.canvas.bottom);
        }
        for (const b of boxes.buttons) {
          expect(b.height).toBeGreaterThanOrEqual(44);
          expect(b.left).toBeGreaterThanOrEqual(0);
          expect(b.top).toBeGreaterThanOrEqual(0);
          expect(b.right).toBeLessThanOrEqual(boxes.viewport.width);
          expect(b.bottom).toBeLessThanOrEqual(boxes.viewport.height);
        }
      });
    });
  }

  for (const c of [
    { name: '390x844', viewport: { width: 390, height: 844 } },
    { name: '667x375', viewport: { width: 667, height: 375 } },
  ]) {
    test.describe(`STAGE CLEAR on a phone ${c.name}`, () => {
      test.use({ viewport: c.viewport, hasTouch: true });

      test('the prompt is Japanese, the result rows still line up on the right and everything fits on the field', async ({ page }) => {
        await open(page, '?seed=1');
        await start(page);
        await page.evaluate(() => window.__game__!.session.applyDebugOverrides({ requiredOccupancy: 0.01 }));
        await claimSmallBox(page);
        expect(await status(page)).toBe('stageclear');
        const screen = page.locator('#screen');
        await advanceUntil(page, async () => ((await screen.textContent()) ?? '').includes('TOTAL'), 1_000, FRAME_MS);
        // Complete the count-up.
        await page.keyboard.press('Enter');
        await page.clock.runFor(200);
        expect(await status(page)).toBe('stageclear');
        await expect(page.locator('#screen-hint')).toHaveText(JA.next);

        const layout = await page.evaluate(() => {
          const el = document.getElementById('screen')!;
          const body = el.firstChild as Text;
          const text = body.data;
          // The right edge of the last letter of each result row.
          const rights: Record<string, number> = {};
          let offset = 0;
          for (const line of text.split('\n')) {
            const label = ['AREA', 'BONUS', 'TOTAL', 'NEXT'].find((l) => line.startsWith(l));
            if (label) {
              const range = document.createRange();
              range.setStart(body, offset + line.length - 1);
              range.setEnd(body, offset + line.length);
              rights[label] = range.getBoundingClientRect().right;
            }
            offset += line.length + 1;
          }
          return { rights, font: getComputedStyle(el).fontFamily, hintFont: getComputedStyle(document.getElementById('screen-hint')!).fontFamily };
        });
        expect(Object.keys(layout.rights)).toEqual(['AREA', 'BONUS', 'TOTAL', 'NEXT']);
        for (const right of Object.values(layout.rights)) expect(right).toBeCloseTo(layout.rights.AREA, 0);
        expect(layout.font).toBe('monospace');
        expect(fontList(layout.hintFont)).toEqual(JA_FONTS);
        await expectInsideField(page, 'screen');
      });
    });
  }

  test('the ranking list notes its rules and its empty board in Japanese', async ({ page }) => {
    await page.route('**/api/ranking', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seasonId: 1, rulesetVersion: 2, entries: [], displayEntries: [] }) }),
    );
    await open(page);
    await page.locator('#ranking-button').click();
    await page.clock.runFor(100);
    const list = page.locator('#ranking-list-body');
    await expect(list).toHaveText(JA.empty);
    const overlay = list.locator('xpath=..');
    await expect(overlay).toContainText('RANKING');
    await expect(overlay).toContainText(JA.notice);
    await expect(overlay.getByRole('button', { name: 'CLOSE' })).toBeVisible();
  });

  for (const c of [
    { name: '390x844', viewport: { width: 390, height: 844 } },
    { name: '667x375', viewport: { width: 667, height: 375 } },
  ]) {
    test.describe(`the submission form on a phone ${c.name}`, () => {
      test.use({ viewport: c.viewport, hasTouch: true });

      test('its status lines are Japanese, it fits on screen, and what it sends does not depend on the language', async ({ page }) => {
        const posts: unknown[] = [];
        await page.route('**/api/ranking', (route) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seasonId: 1, rulesetVersion: 2, entries: [], displayEntries: [] }) }),
        );
        await page.route('**/api/scores', async (route) => {
          posts.push(route.request().postDataJSON());
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: true, status: 'verified' }) });
        });
        await pinNormalSeed(page, 1);
        await open(page);
        await start(page);
        await loseAllLivesToIgniter(page);
        const panel = page.locator('#ranking-submit-panel');
        await advanceUntil(page, async () => panel.isVisible(), 2_000, FRAME_MS);
        await expect(panel).toContainText('YOU MADE THE TOP 10!');
        // The modal's hint follows the panel on the next frame.
        await page.clock.runFor(100);
        await expect(page.locator('#gameover-hint')).toHaveText('SUBMIT か SKIP で続行');

        const expectFits = async () => {
          const m = await page.evaluate(() => {
            const el = document.getElementById('ranking-submit-panel')!;
            return {
              panel: el.getBoundingClientRect(),
              overflow: el.scrollHeight - el.clientHeight,
              buttons: [...el.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => b.getBoundingClientRect()),
              viewport: { width: window.innerWidth, height: window.innerHeight },
            };
          });
          expect(m.overflow).toBeLessThanOrEqual(1);
          expect(m.panel.left).toBeGreaterThanOrEqual(0);
          expect(m.panel.top).toBeGreaterThanOrEqual(0);
          expect(m.panel.right).toBeLessThanOrEqual(m.viewport.width);
          expect(m.panel.bottom).toBeLessThanOrEqual(m.viewport.height);
          for (const b of m.buttons) {
            expect(b.top).toBeGreaterThanOrEqual(m.panel.top);
            expect(b.bottom).toBeLessThanOrEqual(m.panel.bottom);
          }
        };

        await expect(panel).toContainText('名前のかわりに X のハンドルを使う');
        await page.getByRole('button', { name: 'SUBMIT' }).click();
        await expect(panel).toContainText(JA.needName);
        await expectFits();
        expect(posts).toHaveLength(0);

        await page.getByPlaceholder('NAME').fill('なまえ');
        await page.getByRole('button', { name: 'SUBMIT' }).click();
        await expect(panel).toContainText(JA.accepted);
        await expectFits();
        expect(posts).toHaveLength(1);
        const body = posts[0] as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(
          ['seed', 'rleBase64', 'score', 'stage', 'name', 'rulesetVersion', 'replayFormatVersion', 'submitterToken'].sort()
        );
        expect(body.name).toBe('なまえ');
        expect(body.score).toBe(await page.evaluate(() => window.__game__!.session.getScore()));
      });
    });
  }

  test('POST TO X shares the same text and sends the same score as in English', async ({ page, context }) => {
    const shares: unknown[] = [];
    await page.route('**/share', async (route) => {
      shares.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'e2e-test-id' }) });
    });
    await context.route('https://twitter.com/intent/tweet**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }),
    );
    await open(page, '?seed=1');
    await start(page);
    await claimSmallBox(page);
    await timeUpSoon(page);
    const [stage, score, hi] = await page.evaluate(() => {
      const s = window.__game__!.session;
      return [s.getStage(), s.getScore(), s.getHighScore()];
    });
    expect(score).toBeGreaterThan(0);
    const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('#gameover-share-button').click()]);
    await popup.waitForURL(/^https:\/\/twitter\.com\/intent\/tweet/);
    const url = new URL(popup.url());
    expect(url.searchParams.get('text')).toBe(`QIXXX で STAGE ${stage} / SCORE ${score.toLocaleString('en-US')} を記録！ #QIXXX`);
    expect(url.searchParams.get('url')).toBe('http://localhost:4173/s?id=e2e-test-id');
    expect(shares).toEqual([{ score, stage, hi }]);
    await popup.close();
  });

  test('?lang=en shows English even in a Japanese browser', async ({ page }) => {
    await open(page, '?lang=en');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    await expect(page.locator('#screen')).toHaveText('QIXXX\n\nHI SCORE: 0\n\nPRESS ANY KEY OR TAP TO START');
    await expect(page.locator('#screen-hint')).toHaveCount(0);
  });
});

test.describe('in an English browser', () => {
  test.use({ locale: 'en-US' });

  test('?lang=ja shows Japanese', async ({ page }) => {
    await open(page, '?lang=ja');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ja');
    await expect(page.locator('#screen-hint')).toHaveText(JA.start);
  });

  test('no ?lang= stays English', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    await expect(page.locator('#screen')).toHaveText('QIXXX\n\nHI SCORE: 0\n\nPRESS ANY KEY OR TAP TO START');
  });
});
