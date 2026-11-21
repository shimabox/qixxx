// The miss reason: burnt by the Igniter, the field shows STOPPED TOO LONG
// (立ち止まりすぎた in Japanese) next to the contact, wholly on the field and
// at least 13 CSS px tall on a phone. Runs on a faked page clock
// (tests/e2e/support/fakeClock.ts), so budgets are game time.
import { test, expect, type Page } from '@playwright/test';
import { loseAllLivesToIgniter } from './support/fakeClock';

declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
      };
    };
    __reasonDraws__?: Array<{ text: string; left: number; right: number; top: number; bottom: number; fontPx: number }>;
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');

async function open(page: Page, query = ''): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
}

/** Records every fillText of `texts` on the game canvas, in canvas device px, with its font size in CSS px. */
async function recordTextDraws(page: Page, texts: string[]): Promise<void> {
  await page.evaluate((wanted: string[]) => {
    window.__reasonDraws__ = [];
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    const cssScale = canvas.getBoundingClientRect().width / canvas.width;
    const proto = CanvasRenderingContext2D.prototype;
    const fillText = proto.fillText;
    proto.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
      const font = /(\d+(?:\.\d+)?)px/.exec(this.font);
      if (this.canvas === canvas && font && wanted.includes(text)) {
        const t = this.getTransform();
        const w = this.measureText(text).width;
        const fontPx = Number(font[1]);
        const p0 = t.transformPoint(new DOMPoint(x, y - fontPx / 2));
        const p1 = t.transformPoint(new DOMPoint(x + w, y + fontPx / 2));
        window.__reasonDraws__!.push({
          text,
          left: Math.min(p0.x, p1.x),
          right: Math.max(p0.x, p1.x),
          top: Math.min(p0.y, p1.y),
          bottom: Math.max(p0.y, p1.y),
          fontPx: Math.abs(p1.y - p0.y) * cssScale,
        });
      }
      return maxWidth === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, maxWidth);
    };
  }, texts);
}

for (const c of [
  { locale: 'en-US', text: 'STOPPED TOO LONG' },
  { locale: 'ja-JP', text: '立ち止まりすぎた' },
]) {
  test.describe(`burnt by the Igniter (${c.locale}, 390x844)`, () => {
    test.use({ locale: c.locale, viewport: { width: 390, height: 844 }, hasTouch: true });

    test(`the field shows "${c.text}" inside it, at least 13 CSS px tall`, async ({ page }) => {
      // A board whose two Wisps stay clear of the Igniter's line, so every
      // miss is the Igniter's.
      await open(page, '?seed=2');
      await page.keyboard.press('Space');
      await page.clock.runFor(100);
      expect(await page.evaluate(() => window.__game__!.session.getStatus())).toBe('playing');
      await recordTextDraws(page, ['STOPPED TOO LONG', '立ち止まりすぎた', 'WISP HIT YOUR LINE', 'EMBER HIT YOU', 'BLAZE HIT YOU']);
      // Three Igniter burns; the reason of the last one shows while the GAME
      // OVER modal waits.
      await loseAllLivesToIgniter(page);
      await page.clock.runFor(200);
      const { draws, width, height } = await page.evaluate(() => {
        const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
        return { draws: window.__reasonDraws__!, width: canvas.width, height: canvas.height };
      });
      expect(draws.length).toBeGreaterThan(0);
      expect(new Set(draws.map((d) => d.text))).toEqual(new Set([c.text]));
      for (const d of draws) {
        expect(d.left).toBeGreaterThanOrEqual(0);
        expect(d.right).toBeLessThanOrEqual(width);
        expect(d.top).toBeGreaterThanOrEqual(0);
        expect(d.bottom).toBeLessThanOrEqual(height);
        expect(d.fontPx).toBeGreaterThanOrEqual(13 - 0.01);
      }
    });
  });
}
