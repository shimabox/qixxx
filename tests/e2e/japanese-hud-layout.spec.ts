// On a Japanese page (<html lang="ja">) the HUD stays English, so its
// one-line / stacked choice and the field's on-screen size must match the
// English page at the same viewport — including just either side of the
// point where the one-line HUD stops fitting, by width and by height.
//
// The choice measures the one-line HUD text in an off-screen probe
// (main.ts's measureRequiredSingleLineWidth()). Where the generic `monospace`
// is the same face in both languages, a probe measured in Japanese reads the
// same width as one measured in English, and nothing would show here. So
// each page gets a stylesheet that makes Japanese-language text wider and
// English-language text unchanged — standing in for a device whose Japanese
// monospace is another, wider face. Anything that measures English-only text
// in the Japanese context then decides differently from the English page.
//
// Everything runs on a faked page clock (tests/e2e/support/fakeClock.ts's
// approach), so nothing waits on the wall clock.
import { test, expect, type Browser } from '@playwright/test';

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');

/** Japanese-language text wider than English-language text (see the module comment). */
const WIDER_JAPANESE_CSS = ':lang(ja) { letter-spacing: 0.2em; } :lang(en) { letter-spacing: normal; }';

interface Layout {
  /** Whether the HUD is on one line. */
  singleLine: boolean;
  field: { width: number; height: number };
  /** The HUD row's other items, whose widths the one-line choice subtracts. */
  muteWidth: number;
  creditWidth: number;
  /** The `lang` each one-line HUD probe was measured under on this page. */
  probeLangs: string[];
}

async function layoutAt(
  browser: Browser,
  locale: 'en-US' | 'ja-JP',
  viewport: { width: number; height: number },
  hasTouch: boolean,
): Promise<Layout> {
  const context = await browser.newContext({ locale, viewport, hasTouch });
  try {
    const page = await context.newPage();
    await page.addInitScript((css: string) => {
      const probeLangs: string[] = [];
      (window as unknown as { __probeLangs__: string[] }).__probeLangs__ = probeLangs;
      // The probe is a hidden span added to <body> and removed again at once;
      // the observer still sees it, and its own `lang` (empty = inherited
      // from <html>) is the language it was measured under.
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof HTMLSpanElement && node.style.visibility === 'hidden') {
              probeLangs.push(node.lang || `inherited:${document.documentElement.lang}`);
            }
          }
        }
      }).observe(document, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
      });
    }, WIDER_JAPANESE_CSS);
    await page.clock.install({ time: CLOCK_START });
    await page.goto(APP_URL);
    await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
    await page.clock.runFor(100);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe(locale === 'ja-JP' ? 'ja' : 'en');
    return await page.evaluate(() => {
      const field = document.getElementById('game-canvas')!.getBoundingClientRect();
      return {
        singleLine: document.getElementById('hud-line2')!.style.display === 'none',
        field: { width: field.width, height: field.height },
        muteWidth: document.getElementById('mute-button')!.getBoundingClientRect().width,
        creditWidth: document.getElementById('credit-link')!.getBoundingClientRect().width,
        probeLangs: [...(window as unknown as { __probeLangs__: string[] }).__probeLangs__],
      };
    });
  } finally {
    await context.close();
  }
}

// `singleLine` is the English page's own choice, checked so the cases keep
// straddling the point where the one-line HUD stops fitting.
const CASES = [
  { name: '850x800 (just too narrow for one line)', viewport: { width: 850, height: 800 }, hasTouch: false, singleLine: false },
  { name: '860x800 (just wide enough for one line)', viewport: { width: 860, height: 800 }, hasTouch: false, singleLine: true },
  { name: '1100x670 (just too short for one line)', viewport: { width: 1100, height: 670 }, hasTouch: false, singleLine: false },
  { name: '1100x680 (just tall enough for one line)', viewport: { width: 1100, height: 680 }, hasTouch: false, singleLine: true },
  { name: '1280x800', viewport: { width: 1280, height: 800 }, hasTouch: false, singleLine: true },
  { name: '390x844 touch', viewport: { width: 390, height: 844 }, hasTouch: true, singleLine: false },
  { name: '844x390 touch', viewport: { width: 844, height: 390 }, hasTouch: true, singleLine: false },
];

for (const c of CASES) {
  test(`at ${c.name}, the Japanese page lays out the HUD and the field as the English page does`, async ({ browser }) => {
    const en = await layoutAt(browser, 'en-US', c.viewport, c.hasTouch);
    const ja = await layoutAt(browser, 'ja-JP', c.viewport, c.hasTouch);

    expect(en.singleLine).toBe(c.singleLine);
    expect(ja.singleLine).toBe(en.singleLine);
    expect(ja.field).toEqual(en.field);
    expect(ja.muteWidth).toBe(en.muteWidth);
    expect(ja.creditWidth).toBe(en.creditWidth);

    // Every probe on the Japanese page was measured in English.
    expect(ja.probeLangs.length).toBeGreaterThan(0);
    expect(new Set(ja.probeLangs)).toEqual(new Set(['en']));
  });
}
