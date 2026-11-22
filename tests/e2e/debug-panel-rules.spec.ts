// The `?debug` panel's sliders for the scoring and miss rules (src/debug/panel.ts:
// the big claim's share and multiplier, the close call's distance and bonus,
// the miss's invincibility and line lock, the first Ember's wait), driven
// through the sliders themselves: found by what they set, moved during play,
// read back from the live session, and put back by RESET. `?debug` is only on
// with Vite's dev server, which is what the E2E suite runs against. On a
// faked page clock (tests/e2e/support/fakeClock.ts).
import { test, expect, type Page } from '@playwright/test';

interface RuleParams {
  bigClaimShare: number;
  bigClaimMultiplier: number;
  nearMissDistanceCells: number;
  nearMissBonus: number;
  missGraceTicks: number;
  missLineLockTicks: number;
  firstEmberSec: number;
}

declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getEffectiveDebugParams: () => RuleParams & Record<string, number>;
        isRunTainted: () => boolean;
        hasActiveDebugOverrides: () => boolean;
      };
    };
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const RULE_KEYS = [
  'bigClaimShare',
  'bigClaimMultiplier',
  'nearMissDistanceCells',
  'nearMissBonus',
  'missGraceTicks',
  'missLineLockTicks',
  'firstEmberSec',
] as const;

const params = (page: Page) => page.evaluate(() => window.__game__!.session.getEffectiveDebugParams());
const tainted = (page: Page) => page.evaluate(() => window.__game__!.session.isRunTainted());
const overridden = (page: Page) => page.evaluate(() => window.__game__!.session.hasActiveDebugOverrides());
const slider = (page: Page, key: string) => page.locator(`#debug-panel input[data-debug-key="${key}"]`);
const pick = (p: Record<string, number>) => Object.fromEntries(RULE_KEYS.map((k) => [k, p[k]])) as unknown as RuleParams;

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}?debug`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
}

test.describe('the debug panel: scoring and miss rule sliders', () => {
  test('all seven are there, show the live values, change the play under way, taint it, and RESET puts them back', async ({
    page,
  }) => {
    await open(page);
    await page.keyboard.press('Space'); // Title -> Playing
    await page.clock.runFor(100);
    expect(await page.evaluate(() => window.__game__!.session.getStatus())).toBe('playing');
    expect(await tainted(page)).toBe(false);
    const defaults = pick(await params(page));

    // Each of the seven, once, showing the session's own value (in the
    // slider's units: the big claim's share as a percentage).
    for (const key of RULE_KEYS) {
      await expect(slider(page, key), key).toHaveCount(1);
      await expect(slider(page, key), key).toBeVisible();
      const shown = Number(await slider(page, key).inputValue());
      const expected = key === 'bigClaimShare' ? Math.round(defaults[key] * 100) : defaults[key];
      expect(shown, key).toBe(expected);
    }

    // The close call's bonus, moved with the slider itself: the live play
    // takes it, nothing else changes, and the run is now an overridden one.
    const bonus = defaults.nearMissBonus + 300;
    await slider(page, 'nearMissBonus').fill(String(bonus));
    expect((await params(page)).nearMissBonus).toBe(bonus);
    expect(pick(await params(page))).toEqual({ ...defaults, nearMissBonus: bonus });
    expect(await tainted(page)).toBe(true);
    expect(await overridden(page)).toBe(true);

    // One step down with the keyboard on the line lock, too.
    await slider(page, 'missLineLockTicks').focus();
    await page.keyboard.press('ArrowLeft');
    expect((await params(page)).missLineLockTicks).toBe(defaults.missLineLockTicks - 1);

    // EXPORT names them as config.ts does.
    await page.locator('#debug-panel').getByRole('button', { name: 'EXPORT', exact: true }).click();
    const exported = JSON.parse(await page.locator('#debug-export-output').inputValue()) as Record<string, unknown>;
    expect(exported).toMatchObject({ NEAR_MISS_BONUS: bonus, MISS_LINE_LOCK_TICKS: defaults.missLineLockTicks - 1 });

    // RESET: back to the defaults, in the session and on the sliders. The
    // run stays an overridden one — it was played with them.
    await page.locator('#debug-panel').getByRole('button', { name: 'RESET', exact: true }).click();
    expect(pick(await params(page))).toEqual(defaults);
    expect(await overridden(page)).toBe(false);
    expect(await tainted(page)).toBe(true);
    await expect(slider(page, 'nearMissBonus')).toHaveValue(String(defaults.nearMissBonus));
    await expect(slider(page, 'missLineLockTicks')).toHaveValue(String(defaults.missLineLockTicks));
  });
});
