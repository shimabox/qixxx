// The impact feedback's neon text and the extras added on top of it: the
// bundled display face (and the game carrying on without it), the HUD score
// counting up while everything that keeps or shares the score reads the real
// one, the multiplier flying to the HUD in the display face, and the debug
// panel's new FX values (praise, sparks, chain).
//
// Like tests/e2e/impact-feedback.spec.ts, every gameplay test runs on a
// faked, paused page clock and counts fixed ticks by wrapping fx.tick(),
// which main.ts calls once per live tick (stopped ticks included). Nothing
// waits on the wall clock.
import { test, expect, type Page } from '@playwright/test';
import { advanceUntil } from './support/fakeClock';

interface Point {
  x: number;
  y: number;
}
interface FrameView {
  popups: Array<{ text: string; praise: string | null; chain: string | null }>;
  sparks: unknown[];
  splitBanner: { age: number; glitch: { bands: unknown[] } } | null;
  multiplierFly: { text: string; age: number; channelOffset: number } | null;
}
interface ClaimNotice {
  claimedCells: number;
  occupancyBefore: number;
  occupancyAfter: number;
  lineSpeed: 'fast' | 'slow';
  areaScore: number;
  multiplier: number;
  split: boolean;
  stageCleared: boolean;
  closedLine: Point[];
}
interface TickLog {
  ticks: number;
  claims: Array<{ tick: number; score: number }>;
}

declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getScore: () => number;
        getHighScore: () => number;
        getTotalTicks: () => number;
        getGameOverReason: () => 'life' | 'time' | null;
        isRunTainted: () => boolean;
        hasActiveDebugOverrides: () => boolean;
        setDebugTimeLimitTicks: (ticks: number) => void;
        getGame: () => { getMarker: () => { getPosition: () => Point } };
      };
      fx: {
        tick: () => void;
        onClaim: (notice: ClaimNotice, context: { nextMultiplier: number }) => { hitStopTicks: number; chain: number };
        getFrame: () => FrameView;
        isSplitBannerActive: () => boolean;
      };
    };
    __tickLog__?: TickLog;
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const SCORE_ROLL_TICKS = 18;

/** Loads the page on a paused fake clock, starts counting ticks and claims, and starts the run. */
async function startRun(page: Page, query: string): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.evaluate(() => {
    const g = window.__game__!;
    const log: TickLog = { ticks: 0, claims: [] };
    const tick = g.fx.tick.bind(g.fx);
    g.fx.tick = () => {
      log.ticks++;
      tick();
    };
    const onClaim = g.fx.onClaim.bind(g.fx);
    g.fx.onClaim = (notice, context) => {
      log.claims.push({ tick: log.ticks, score: g.session.getScore() });
      return onClaim(notice, context);
    };
    window.__tickLog__ = log;
  });
  await page.keyboard.press('Space'); // Title -> Playing
  await page.clock.runFor(100);
  expect(await page.evaluate(() => window.__game__!.session.getStatus())).toBe('playing');
}

const log = (page: Page) => page.evaluate(() => window.__tickLog__!);
const frame = (page: Page) => page.evaluate(() => window.__game__!.fx.getFrame());
const marker = (page: Page) => page.evaluate(() => window.__game__!.session.getGame().getMarker().getPosition());
const sessionScore = (page: Page) => page.evaluate(() => window.__game__!.session.getScore());
const hudScore = (page: Page) =>
  page.evaluate(() => {
    const el = document.getElementById('hud-score')!;
    return { value: Number(el.textContent), glow: el.style.textShadow };
  });

async function ticksSinceClaim(page: Page): Promise<number> {
  const l = await log(page);
  return l.ticks - l.claims[l.claims.length - 1].tick;
}

/** The scripted claim of tests/e2e/smoke.spec.ts on `?seed=1`: a small box off the top border. */
async function claimSmallBox(page: Page): Promise<void> {
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
  await advanceUntil(page, async () => (await log(page)).claims.length > 0, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('Space');
}

/** Shows the director a split straight away (a made-up notice; the run itself is not touched). */
async function fireSplit(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__game__!.fx.onClaim(
      {
        claimedCells: 0,
        occupancyBefore: 0,
        occupancyAfter: 0.05,
        lineSpeed: 'fast',
        areaScore: 0,
        multiplier: 1,
        split: true,
        stageCleared: true,
        closedLine: Array.from({ length: 40 }, (_, i) => ({ x: 80, y: 1 + i })),
      },
      { nextMultiplier: 2 }
    );
  });
}

/** The x offsets of every shadow in a computed `text-shadow`. */
function shadowOffsets(textShadow: string): number[] {
  return [...textShadow.matchAll(/(-?[\d.]+)px (-?[\d.]+)px [\d.]+px/g)].map((m) => Number(m[1]));
}

test.describe('neon text', () => {
  let pageErrors: Error[];

  test.beforeEach(({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  test('the bundled display face is loaded after the page loads', async ({ page }) => {
    const fontRequests: string[] = [];
    page.on('request', (request) => {
      if (/\.(ttf|woff2?|otf)(\?|$)/.test(request.url())) fontRequests.push(request.url());
    });
    await page.goto(APP_URL);
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('900 16px "Orbitron"') && document.fonts.check('700 16px "Orbitron"');
    });
    expect(loaded).toBe(true);
    // Only from this site.
    expect(fontRequests.length).toBeGreaterThan(0);
    for (const url of fontRequests) expect(new URL(url).origin).toBe(new URL(APP_URL).origin);
  });

  test('without the font (404), there is no page error and a claim and a split play out in full', async ({ page }) => {
    await page.route('**/fonts/Orbitron-wght.ttf', (route) => route.fulfill({ status: 404, body: '' }));
    await startRun(page, '?seed=1');
    await claimSmallBox(page);
    expect((await frame(page)).popups).toHaveLength(1);
    await advanceUntil(page, async () => (await ticksSinceClaim(page)) >= 40, 2_000, FRAME_MS);
    expect((await frame(page)).popups).toEqual([]);

    await fireSplit(page);
    await page.clock.runFor(FRAME_MS);
    expect(await page.evaluate(() => window.__game__!.fx.isSplitBannerActive())).toBe(true);
    await advanceUntil(page, async () => !(await page.evaluate(() => window.__game__!.fx.isSplitBannerActive())), 2_000, FRAME_MS);
    await advanceUntil(page, async () => (await frame(page)).multiplierFly === null, 2_000, FRAME_MS);
    expect(await page.evaluate(() => window.__game__!.session.getStatus())).toBe('playing');
  });

  test('a real claim: the HUD score counts up over 18 ticks, glowing, then equals the real score', async ({ page }) => {
    await startRun(page, '?seed=1');
    await claimSmallBox(page);
    const score = await sessionScore(page);
    expect(score).toBeGreaterThan(0);
    expect((await log(page)).claims[0].score).toBe(score);

    let previous = -1;
    let sawMidway = false;
    for (;;) {
      const since = await ticksSinceClaim(page);
      const shown = await hudScore(page);
      expect(await sessionScore(page)).toBe(score);
      if (since < SCORE_ROLL_TICKS) {
        expect(shown.value).toBeLessThan(score);
        expect(shown.value).toBeGreaterThanOrEqual(previous);
        expect(shown.glow).not.toBe('');
        if (shown.value > 0) sawMidway = true;
      } else {
        expect(shown.value).toBe(score);
        expect(shown.glow).toBe('');
        break;
      }
      previous = shown.value;
      await page.clock.runFor(FRAME_MS);
    }
    expect(sawMidway).toBe(true);
    await expect(page.locator('#hud')).toContainText(`SCORE: ${score}`);
  });

  test('mid-count, the GAME OVER modal and the HUD HI show the real score', async ({ page }) => {
    await startRun(page, '?seed=1');
    await claimSmallBox(page);
    const score = await sessionScore(page);
    // End the run on time a tick after the claim's hit stop.
    await page.evaluate(() => {
      const s = window.__game__!.session;
      s.setDebugTimeLimitTicks(s.getTotalTicks() + 1);
    });
    const hi = await page.evaluate(() => window.__game__!.session.getHighScore());
    expect(hi).toBe(score);
    await expect(page.locator('#hud')).toContainText(`HI: ${hi}`);
    expect((await hudScore(page)).value).toBeLessThan(score);

    await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 1_000, FRAME_MS);
    expect(await page.evaluate(() => window.__game__!.session.getGameOverReason())).toBe('time');
    expect(await ticksSinceClaim(page)).toBeLessThan(SCORE_ROLL_TICKS);
    expect((await hudScore(page)).value).toBeLessThan(score); // still counting
    await expect(page.locator('#gameover-modal')).toContainText(`SCORE: ${score}`);
    await expect(page.locator('#gameover-modal')).toContainText(`HI SCORE: ${score}`);
  });

  test('the multiplier flying to the HUD is in the display face, its glow split apart for 6 ticks only', async ({ page }) => {
    await startRun(page, '?seed=1');
    await fireSplit(page);
    const fly = page.locator('#fx-multiplier');
    const seenAges = new Set<number>();
    for (;;) {
      const f = await frame(page);
      if (!f.multiplierFly) break;
      const style = await fly.evaluate((el) => {
        const cs = window.getComputedStyle(el);
        return { fontFamily: cs.fontFamily, textShadow: cs.textShadow, display: cs.display };
      });
      if (style.display !== 'none') {
        const age = f.multiplierFly.age;
        seenAges.add(age);
        expect(style.fontFamily).toContain('Orbitron');
        const offsets = shadowOffsets(style.textShadow);
        expect(offsets).toHaveLength(2);
        if (age >= 6) {
          expect(offsets.every((o) => o === 0)).toBe(true);
        } else {
          expect(offsets[0]).toBeLessThan(0); // cyan to the left
          expect(offsets[1]).toBeGreaterThan(0); // magenta to the right
        }
      }
      await page.clock.runFor(FRAME_MS);
    }
    expect([...seenAges].some((a) => a < 6)).toBe(true);
    expect([...seenAges].some((a) => a >= 6)).toBe(true);
  });

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('no tearing and no colour split; the HUD score still counts up', async ({ page }) => {
      await startRun(page, '?seed=1');
      await claimSmallBox(page);
      expect((await hudScore(page)).glow).not.toBe('');
      expect((await hudScore(page)).value).toBeLessThan(await sessionScore(page));
      expect((await frame(page)).popups).toHaveLength(1);

      await fireSplit(page);
      await page.clock.runFor(FRAME_MS);
      const f = await frame(page);
      expect(f.splitBanner?.age).toBeLessThan(9);
      expect(f.splitBanner?.glitch.bands).toHaveLength(1);
      expect(f.multiplierFly?.channelOffset).toBe(0);
      const shadow = await page.locator('#fx-multiplier').evaluate((el) => window.getComputedStyle(el).textShadow);
      expect(shadowOffsets(shadow).every((o) => o === 0)).toBe(true);
    });
  });

  test('debug panel FX: new values tune the effects, TEST CLAIM shows praise, sparks and a chain, without tainting the run', async ({
    page,
  }) => {
    await startRun(page, '?debug&seed=1');
    await expect(page.locator('#debug-fx-section')).toBeVisible();
    for (const key of [
      'claimShareHuge',
      'textGlitchBannerTicks',
      'textGlitchPopupTicks',
      'popupBounceScale',
      'popupBounceTicks',
      'sparkMax',
      'sparkTicks',
      'sparkDistanceCells',
      'chainWindowTicks',
      'chainPitchMaxSteps',
      'scoreRollTicks',
    ]) {
      await expect(page.locator(`#debug-fx-${key}`)).toBeVisible();
    }

    await page.locator('#debug-fx-sparkMax').fill('7');
    await page.locator('#debug-fx-test-claim-l').click();
    let f = await frame(page);
    expect(f.popups.at(-1)).toEqual(expect.objectContaining({ praise: 'AWESOME!', chain: null }));
    expect(f.sparks).toHaveLength(7);

    await page.locator('#debug-fx-test-claim-m').click();
    f = await frame(page);
    expect(f.popups.at(-1)).toEqual(expect.objectContaining({ praise: 'NICE!', chain: 'CHAIN x2' }));
    await page.locator('#debug-fx-test-claim-s').click();
    f = await frame(page);
    expect(f.popups.at(-1)).toEqual(expect.objectContaining({ praise: null, chain: 'CHAIN x3' }));

    await page.locator('#debug-fx-test-split').click();
    f = await frame(page);
    expect(f.splitBanner?.glitch.bands).toHaveLength(3);

    expect(
      await page.evaluate(() => ({
        tainted: window.__game__!.session.isRunTainted(),
        overrides: window.__game__!.session.hasActiveDebugOverrides(),
      }))
    ).toEqual({ tainted: false, overrides: false });

    await page.locator('#debug-panel button', { hasText: 'EXPORT' }).click();
    const exported = JSON.parse(await page.locator('#debug-export-output').inputValue());
    expect(exported.FX_SPARK_MAX).toBe(7);
    expect(exported.FX_SCORE_ROLL_TICKS).toBe(18);
    expect(exported.FX_CLAIM_SHARE_HUGE).toBe(0.3);
  });
});
