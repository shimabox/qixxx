// Impact feedback on claims, splits and misses (src/fx/): the hit stop, the
// score popup, line shards, SPLIT!, the confirm holds and the GAME OVER modal
// delay, and reduced motion.
//
// Every test runs on a faked, paused page clock (see
// tests/e2e/gameover-share.spec.ts for the rationale): the game only advances
// through page.clock.runFor(), so durations are exact tick counts, budgets
// are game time, and nothing waits on the wall clock. Effects are checked
// through the director's state (window.__game__.fx) and the HUD/DOM, never
// through pixels. Each test counts fixed ticks by wrapping fx.tick(), which
// main.ts calls once per live tick, including the ticks a hit stop freezes.
import { test, expect, type Page } from '@playwright/test';
import { advanceUntil } from './support/fakeClock';

interface Point {
  x: number;
  y: number;
}
interface FrameView {
  shake: Point;
  flash: { kind: string };
  popups: Array<{ text: string }>;
  shards: unknown[];
  splitBanner: { progress: number } | null;
  multiplierFly: { text: string } | null;
}
interface ClaimNotice {
  split: boolean;
  areaScore: number;
}
interface FxLog {
  ticks: number;
  claims: Array<{ tick: number; hitStopTicks: number; totalTicks: number; areaScore: number; score: number }>;
  misses: Array<{ tick: number; cause: string; gameOver: boolean; hitStopTicks: number; totalTicks: number; lives: number }>;
}

declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getStage: () => number;
        getScore: () => number;
        getLives: () => number;
        getTotalTicks: () => number;
        isRunTainted: () => boolean;
        hasActiveDebugOverrides: () => boolean;
        applyDebugOverrides: (overrides: { wispCount?: number; requiredOccupancy?: number }) => void;
        getGame: () => {
          getOccupancy: () => number;
          getGraceTicks: () => number;
          getMarker: () => { getPosition: () => Point };
        };
      };
      fx: {
        tick: () => void;
        onClaim: (notice: ClaimNotice, context: { nextMultiplier: number }) => { hitStopTicks: number };
        onMiss: (notice: { cause: string }, context: { gameOver: boolean }) => { hitStopTicks: number };
        getFrame: () => FrameView;
        isSplitBannerActive: () => boolean;
        isReducedMotion: () => boolean;
      };
      hitStop: { getRemaining: () => number };
    };
    __fxLog__?: FxLog;
  }
}

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;

/** Loads the page on a paused fake clock, starts the run and starts counting ticks/claims/misses. */
async function startRun(page: Page, query: string, options: { splitClaims?: boolean } = {}): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.evaluate((splitClaims) => {
    const g = window.__game__!;
    const log: FxLog = { ticks: 0, claims: [], misses: [] };
    const tick = g.fx.tick.bind(g.fx);
    g.fx.tick = () => {
      log.ticks++;
      tick();
    };
    const onClaim = g.fx.onClaim.bind(g.fx);
    g.fx.onClaim = (notice, context) => {
      // For the SPLIT! test: present this tick's real claim to the director
      // as a split (the director is the only thing that reacts to it).
      const result = splitClaims ? onClaim({ ...notice, split: true }, { nextMultiplier: 2 }) : onClaim(notice, context);
      log.claims.push({
        tick: log.ticks,
        hitStopTicks: result.hitStopTicks,
        totalTicks: g.session.getTotalTicks(),
        areaScore: notice.areaScore,
        // Read on the claim tick itself (the director hears of a claim right
        // after the session.update() that made it).
        score: g.session.getScore(),
      });
      return result;
    };
    const onMiss = g.fx.onMiss.bind(g.fx);
    g.fx.onMiss = (notice, context) => {
      const result = onMiss(notice, context);
      log.misses.push({
        tick: log.ticks,
        cause: notice.cause,
        gameOver: context.gameOver,
        hitStopTicks: result.hitStopTicks,
        totalTicks: g.session.getTotalTicks(),
        lives: g.session.getLives(),
      });
      return result;
    };
    window.__fxLog__ = log;
  }, options.splitClaims ?? false);
  await page.keyboard.press('Space'); // Title -> Playing
  await page.clock.runFor(100);
  expect(await page.evaluate(() => window.__game__!.session.getStatus())).toBe('playing');
}

const log = (page: Page) => page.evaluate(() => window.__fxLog__!);
const frame = (page: Page) => page.evaluate(() => window.__game__!.fx.getFrame());
const marker = (page: Page) => page.evaluate(() => window.__game__!.session.getGame().getMarker().getPosition());
const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());

/**
 * The scripted claim from tests/e2e/smoke.spec.ts on `?seed=1` (a seed whose
 * Wisp keeps clear of this path): along the top border, then a small box
 * down, right and back up to close it.
 */
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

/** Walks left on the border, draws a short line down, lets go and waits for the Igniter to catch up. */
async function missToIgniter(page: Page, missesBefore: number): Promise<void> {
  await advanceUntil(page, async () => page.evaluate(() => window.__game__!.session.getGame().getGraceTicks() === 0), 4_000, FRAME_MS);
  await page.keyboard.down('Space');
  await page.keyboard.down('ArrowDown');
  await advanceUntil(page, async () => (await marker(page)).y >= 8, 4_000, FRAME_MS);
  await page.keyboard.up('ArrowDown');
  await page.keyboard.up('Space');
  await advanceUntil(page, async () => (await log(page)).misses.length > missesBefore, 6_000, FRAME_MS);
}

/** Ticks since the most recent claim (or miss) was handed to the director. */
async function ticksSince(page: Page, kind: 'claims' | 'misses'): Promise<number> {
  const l = await log(page);
  const list = l[kind];
  return l.ticks - list[list.length - 1].tick;
}

test.describe('impact feedback', () => {
  let pageErrors: Error[];

  test.beforeEach(({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  test('a real claim: occupancy and the session score update on the claim tick, the HUD score 18 ticks later, a hit stop holds the run, the popup lasts 40 ticks', async ({
    page,
  }) => {
    await startRun(page, '?seed=1');
    await claimSmallBox(page);

    const [claim] = (await log(page)).claims;
    expect([3, 6, 10]).toContain(claim.hitStopTicks);

    // Occupancy and the HUD's occupancy already show the claim, and the
    // session's score was updated on the claim tick itself.
    const { occupancy, score } = await page.evaluate(() => ({
      occupancy: window.__game__!.session.getGame().getOccupancy(),
      score: window.__game__!.session.getScore(),
    }));
    expect(occupancy).toBeGreaterThan(0);
    expect(score).toBeGreaterThan(0);
    expect(claim.score).toBe(score);
    await expect(page.locator('#hud')).toContainText(`${Math.floor(occupancy * 100 + 1e-9)}%/`);
    expect((await frame(page)).popups).toEqual([expect.objectContaining({ text: `+${claim.areaScore}` })]);

    // The run stands still for exactly the stop, then moves again.
    for (;;) {
      const since = await ticksSince(page, 'claims');
      const total = await page.evaluate(() => window.__game__!.session.getTotalTicks());
      expect(total - claim.totalTicks).toBe(Math.max(0, since - claim.hitStopTicks));
      if (since > claim.hitStopTicks + 2) break;
      await page.clock.runFor(FRAME_MS);
    }

    // The HUD's score number counts up and matches the score 18 ticks after
    // the claim. The popup is gone after 40 ticks.
    let hudChecked = false;
    for (;;) {
      const since = await ticksSince(page, 'claims');
      if (since >= 18 && !hudChecked) {
        await expect(page.locator('#hud')).toContainText(`SCORE ${score}`);
        hudChecked = true;
      }
      const popups = (await frame(page)).popups;
      if (since < 40) {
        expect(popups).toHaveLength(1);
      } else {
        expect(popups).toEqual([]);
        break;
      }
      await page.clock.runFor(FRAME_MS);
    }
    expect(hudChecked).toBe(true);
  });

  test('standing still mid-line until the Igniter catches up: a hit stop, shards, a shake, one life lost', async ({ page }) => {
    await startRun(page, '?seed=1');
    await page.evaluate(() => window.__game__!.session.applyDebugOverrides({ wispCount: 0 }));
    const livesBefore = await page.evaluate(() => window.__game__!.session.getLives());
    await page.keyboard.down('ArrowLeft');
    await advanceUntil(page, async () => (await marker(page)).x <= 30, 4_000, FRAME_MS);
    await page.keyboard.up('ArrowLeft');

    await missToIgniter(page, 0);

    const [miss] = (await log(page)).misses;
    expect(miss.cause).toBe('igniter');
    expect(miss.hitStopTicks).toBe(12);
    expect(miss.lives).toBe(livesBefore - 1);
    const shown = await frame(page);
    expect(shown.shards.length).toBeGreaterThan(0);
    expect(shown.shake.x !== 0 || shown.shake.y !== 0).toBe(true);
    // Frozen during the stop.
    const since = await ticksSince(page, 'misses');
    expect(since).toBeLessThan(12);
    expect(await page.evaluate(() => window.__game__!.session.getTotalTicks())).toBe(miss.totalTicks);
    expect(await page.evaluate(() => window.__game__!.hitStop.getRemaining())).toBe(12 - since);
    // Shards are gone after 20 ticks.
    await advanceUntil(page, async () => (await ticksSince(page, 'misses')) >= 20, 1_000, FRAME_MS);
    expect((await frame(page)).shards).toEqual([]);
    expect(await page.evaluate(() => window.__game__!.session.getLives())).toBe(livesBefore - 1);
  });

  test('a game-ending miss holds the GAME OVER modal for 32 ticks and drops confirm meanwhile', async ({ page }) => {
    await startRun(page, '?seed=1');
    await page.evaluate(() => window.__game__!.session.applyDebugOverrides({ wispCount: 0 }));
    await page.keyboard.down('ArrowLeft');
    await advanceUntil(page, async () => (await marker(page)).x <= 30, 4_000, FRAME_MS);
    await page.keyboard.up('ArrowLeft');

    const lives = await page.evaluate(() => window.__game__!.session.getLives());
    for (let i = 0; i < lives; i++) await missToIgniter(page, i);

    const misses = (await log(page)).misses;
    expect(misses[misses.length - 1].gameOver).toBe(true);
    expect(await status(page)).toBe('gameover');

    const modal = page.locator('#gameover-modal');
    let pressedDuringHold = 0;
    for (;;) {
      const since = await ticksSince(page, 'misses');
      if (since < 32) {
        await expect(modal).toBeHidden();
        if (since >= 14 && pressedDuringHold < 2) {
          await page.keyboard.press('Enter'); // must not reach the core
          pressedDuringHold++;
        }
      } else {
        await expect(modal).toBeVisible();
        break;
      }
      await page.clock.runFor(FRAME_MS);
    }
    expect(pressedDuringHold).toBe(2);
    // The presses during the hold were dropped, not kept.
    await page.clock.runFor(500);
    expect(await status(page)).toBe('gameover');
    await expect(modal).toBeVisible();

    // After the retry guard (24 ticks from the modal), one confirm starts
    // the next run: GAME OVER -> stage 1, never stopping at Title.
    await page.keyboard.press('Enter');
    await page.clock.runFor(100);
    expect(await status(page)).toBe('playing');
    expect(await page.evaluate(() => window.__game__!.session.getStage())).toBe(1);
  });

  test('SPLIT! shows for 60 ticks and holds the stage-clear text back; confirm is dropped for 40 ticks', async ({ page }) => {
    // The stage is cleared by a real claim (the required occupancy is
    // lowered through the session's debug hook) and the director is shown
    // that claim as a split.
    await startRun(page, '?seed=1', { splitClaims: true });
    await page.evaluate(() => window.__game__!.session.applyDebugOverrides({ requiredOccupancy: 0.01 }));
    await claimSmallBox(page);
    expect(await status(page)).toBe('stageclear');
    expect((await log(page)).claims[0].hitStopTicks).toBe(20);

    const screen = page.locator('#screen');
    let pressedWhileLocked = false;
    let sawMultiplierFly = false;
    for (;;) {
      const since = await ticksSince(page, 'claims');
      const active = await page.evaluate(() => window.__game__!.fx.isSplitBannerActive());
      if (since < 60) {
        expect(active).toBe(true);
        await expect(screen).not.toContainText('CLEAR');
        if (await page.locator('#fx-multiplier').isVisible()) sawMultiplierFly = true;
        if (since >= 24 && since < 36 && !pressedWhileLocked) {
          await page.keyboard.press('Enter'); // inside the 40-tick lock: dropped
          pressedWhileLocked = true;
        }
      } else {
        expect(active).toBe(false);
        break;
      }
      await page.clock.runFor(FRAME_MS);
    }
    expect(pressedWhileLocked).toBe(true);
    expect(sawMultiplierFly).toBe(true);
    expect(await status(page)).toBe('stageclear');
    await expect(screen).toContainText('STAGE 1 CLEAR!');
    await expect(screen).toContainText('PRESS ANY KEY OR TAP FOR NEXT STAGE');
    await expect(screen).not.toContainText('(SPLIT CLEAR!)');

    // The result counts up from the tick SPLIT! has gone: a confirm while it
    // counts only completes it (TOTAL is the stage's real score gain), the
    // next one starts the next stage.
    const total = await page.evaluate(() => window.__game__!.session.getScore());
    await expect(screen).toContainText('TOTAL');
    expect(await screen.textContent()).not.toMatch(new RegExp(`TOTAL\\s+${total}\\b`));
    await page.keyboard.press('Enter');
    await page.clock.runFor(FRAME_MS);
    expect(await status(page)).toBe('stageclear');
    expect(await screen.textContent()).toMatch(new RegExp(`TOTAL\\s+${total}\\b`));

    await page.keyboard.press('Enter');
    await page.clock.runFor(100);
    expect(await page.evaluate(() => window.__game__!.session.getStage())).toBe(2);
    expect(await status(page)).toBe('playing');
  });

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('the field never shakes and nothing flashes on a claim or a miss', async ({ page }) => {
      await startRun(page, '?seed=1');
      expect(await page.evaluate(() => window.__game__!.fx.isReducedMotion())).toBe(true);
      const sampled: FrameView[] = [];
      const sample = async () => sampled.push(await frame(page));

      await claimSmallBox(page);
      for (let i = 0; i < 20; i++) {
        await sample();
        await page.clock.runFor(FRAME_MS);
      }
      expect((await log(page)).claims).toHaveLength(1);

      await page.evaluate(() => window.__game__!.session.applyDebugOverrides({ wispCount: 0 }));
      // Off the claimed box's edge, back onto the open top border.
      await page.keyboard.down('ArrowRight');
      await advanceUntil(page, async () => (await marker(page)).x >= 64, 2_000, FRAME_MS);
      await page.keyboard.up('ArrowRight');
      await missToIgniter(page, 0);
      for (let i = 0; i < 30; i++) {
        await sample();
        await page.clock.runFor(FRAME_MS);
      }
      expect((await log(page)).misses).toHaveLength(1);

      for (const f of sampled) {
        expect(f.shake).toEqual({ x: 0, y: 0 });
        expect(f.flash).toEqual({ kind: 'none' });
      }
      // The rest of the feedback still plays.
      expect(sampled.some((f) => f.popups.length > 0)).toBe(true);
      expect(sampled.some((f) => f.shards.length > 0)).toBe(true);
    });

    test('follows the setting when it changes', async ({ page }) => {
      await startRun(page, '');
      expect(await page.evaluate(() => window.__game__!.fx.isReducedMotion())).toBe(true);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await advanceUntil(page, async () => !(await page.evaluate(() => window.__game__!.fx.isReducedMotion())), 1_000, FRAME_MS);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await advanceUntil(page, async () => page.evaluate(() => window.__game__!.fx.isReducedMotion()), 1_000, FRAME_MS);
    });
  });

  test('the debug panel FX section tunes the next effect and fires tests without tainting the run', async ({ page }) => {
    await startRun(page, '?debug&seed=1');
    await expect(page.locator('#debug-fx-section')).toBeVisible();

    await page.locator('#debug-fx-hitStopClaimSmallTicks').fill('15');
    await page.locator('#debug-fx-test-claim-s').click();
    expect(await page.evaluate(() => window.__game__!.hitStop.getRemaining())).toBe(15);
    expect((await frame(page)).popups).toHaveLength(1);

    await page.locator('#debug-fx-test-split').click();
    expect(await page.evaluate(() => window.__game__!.fx.isSplitBannerActive())).toBe(true);
    await page.locator('#debug-fx-test-miss').click();
    expect((await frame(page)).shards.length).toBeGreaterThan(0);
    await page.locator('#debug-fx-test-claim-m').click();
    await page.locator('#debug-fx-test-claim-l').click();

    expect(
      await page.evaluate(() => ({
        tainted: window.__game__!.session.isRunTainted(),
        overrides: window.__game__!.session.hasActiveDebugOverrides(),
        status: window.__game__!.session.getStatus(),
      }))
    ).toEqual({ tainted: false, overrides: false, status: 'playing' });

    await page.locator('#debug-panel button', { hasText: /^EXPORT$/ }).click();
    const exported = JSON.parse(await page.locator('#debug-export-output').inputValue());
    expect(exported.FX_HITSTOP_CLAIM_SMALL_TICKS).toBe(15);
    expect(exported.FX_SHAKE_LARGE).toEqual({ ticks: 16, amplitudePx: 6, axes: 'xy' });
  });
});
