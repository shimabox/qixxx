// TIME countdown warning sounds: the alarm when 30 and 15 seconds are left and
// the per-second beeps from 10 seconds down (src/timeWarningCue.ts decides the
// tick, SfxEngine.playTimeWarning() plays it).
//
// Sound itself can't be asserted from a page, so each test wraps
// window.__game__.sfx.playTimeWarning — the hook main.ts already publishes,
// no test-only code in the app — with a recorder that still calls the real
// method, and reads back which cue was asked for on which remaining tick.
//
// Every test runs on a faked, paused page clock (see
// tests/e2e/gameover-share.spec.ts for the full rationale): the game only
// advances through page.clock.runFor(), so the countdown is an exact number
// of ticks and every budget below is game time, not a wall-clock wait.
//
// The run's time limit is shortened through GameSession's own
// setDebugTimeLimitTicks() rather than the debug panel's slider, which only
// moves in 5-second steps and so can't set the 12 and 8 seconds used here.
import { test, expect, type Page } from '@playwright/test';
import { TICK_RATE } from '../../src/config';
import { advanceUntil } from './support/fakeClock';

type Cue = 'alarm' | 'beep' | 'beep-high';
interface HeardCue {
  cue: Cue;
  /** GameSession.getRemainingTicks() at the moment the cue was played. */
  remainingTicks: number;
}

// Minimal shape of the window.__game__ debug hook main.ts publishes, matching
// the other specs' own local (not imported) declarations.
declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getRemainingTicks: () => number;
        getGameOverReason: () => 'life' | 'time' | null;
        setDebugTimeLimitTicks: (ticks: number) => void;
      };
      sfx: {
        playTimeWarning: (cue: Cue) => void;
        setMuted: (muted: boolean) => void;
      };
    };
    /** This spec's own recording of playTimeWarning() calls. */
    __timeWarningHeard__?: HeardCue[];
  }
}

// The marker is left idle on the border for the whole run. Nothing can hit it
// there for the first 30 seconds: that is when the first Embers appear, at
// the top corners, and they then need about 4 more seconds to reach the
// marker at the top center. Only the 35-second run lasts that long; it loses
// at most one life in its final second (the grace period after a miss outlasts
// the rest of the run), so it still ends on TIME UP, and a miss neither stops
// the countdown nor plays a time warning.
const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');

const sec = (seconds: number): number => seconds * TICK_RATE;
const heardAt = (cue: Cue, seconds: number[]): HeardCue[] =>
  seconds.map((s) => ({ cue, remainingTicks: sec(s) }));

/**
 * Loads the title screen on a paused fake clock, shortens the run's time
 * limit to `limitSeconds`, starts recording playTimeWarning() calls, and
 * starts the run.
 */
async function startRunWithTimeLimit(page: Page, limitSeconds: number): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(APP_URL);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));

  await page.evaluate((limitTicks) => {
    const { session, sfx } = window.__game__!;
    session.setDebugTimeLimitTicks(limitTicks);
    // Sound is off until the player turns it on; turned on here so the
    // recorded calls also run the real Web Audio path.
    sfx.setMuted(false);
    const heard: HeardCue[] = [];
    const playTimeWarning = sfx.playTimeWarning.bind(sfx);
    sfx.playTimeWarning = (cue) => {
      heard.push({ cue, remainingTicks: session.getRemainingTicks() });
      playTimeWarning(cue);
    };
    window.__timeWarningHeard__ = heard;
  }, sec(limitSeconds));

  await page.keyboard.press('Space'); // Title -> Playing
  await page.clock.runFor(100);
  expect(await getStatus(page)).toBe('playing');
}

const getStatus = (page: Page) => page.evaluate(() => window.__game__?.session.getStatus());
const getRemainingTicks = (page: Page) => page.evaluate(() => window.__game__!.session.getRemainingTicks());
const getHeard = (page: Page) => page.evaluate(() => window.__timeWarningHeard__!);

/** Advances the clock until the run ends, and checks it ended on TIME UP. */
async function playUntilTimeUp(page: Page, limitSeconds: number): Promise<void> {
  await advanceUntil(page, async () => (await getStatus(page)) === 'gameover', (limitSeconds + 1) * 1000, 250);
  expect(await page.evaluate(() => window.__game__!.session.getGameOverReason())).toBe('time');
}

test.describe('TIME countdown warning sounds', () => {
  let pageErrors: Error[];

  test.beforeEach(({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  test('plays the alarm exactly twice, on the ticks 30 and 15 seconds are left', async ({ page }) => {
    await startRunWithTimeLimit(page, 35);
    expect(await getHeard(page)).toEqual([]);

    // Past 30 seconds, and well short of the second alarm at 15.
    await advanceUntil(page, async () => (await getRemainingTicks(page)) <= sec(28), 8_000, 250);

    expect(await getStatus(page)).toBe('playing');
    expect(await getHeard(page)).toEqual(heardAt('alarm', [30]));

    await playUntilTimeUp(page, 35);

    expect(await getHeard(page)).toEqual([
      ...heardAt('alarm', [30, 15]),
      ...heardAt('beep', [10, 9, 8, 7, 6]),
      ...heardAt('beep-high', [5, 4, 3, 2, 1]),
    ]);
  });

  test('beeps once a second from 10 seconds, higher from 5, and not at 0', async ({ page }) => {
    await startRunWithTimeLimit(page, 12);

    await playUntilTimeUp(page, 12);

    expect(await getHeard(page)).toEqual([
      ...heardAt('beep', [10, 9, 8, 7, 6]),
      ...heardAt('beep-high', [5, 4, 3, 2, 1]),
    ]);
  });

  test('skips the seconds a run started at or below', async ({ page }) => {
    // The title screen sits on exactly 8 seconds, so 8 is not counted down
    // onto — and 10 and 9 were never reached at all.
    await startRunWithTimeLimit(page, 8);
    expect(await getHeard(page)).toEqual([]);

    await playUntilTimeUp(page, 8);

    expect(await getHeard(page)).toEqual([
      ...heardAt('beep', [7, 6]),
      ...heardAt('beep-high', [5, 4, 3, 2, 1]),
    ]);
  });
});
