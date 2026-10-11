import { describe, it, expect } from 'vitest';
import type { SessionStatus } from './core/session';
import {
  TICK_RATE,
  HUD_TIME_WARNING_TICKS,
  SFX_TIME_WARNING_SECOND_ALARM_SEC,
  SFX_TIME_WARNING_BEEP_FROM_SEC,
  SFX_TIME_WARNING_HIGH_FROM_SEC,
} from './config';
import { cueAtTicks, TimeWarningCue, TimeWarningCueTracker } from './timeWarningCue';

const sec = (seconds: number): number => seconds * TICK_RATE;

/** A cue together with the remaining ticks it was returned on. */
type Heard = [remainingTicks: number, cue: TimeWarningCue];

const ALARMS: Heard[] = [30, 15].map((s) => [sec(s), 'alarm']);
const BEEPS: Heard[] = [10, 9, 8, 7, 6].map((s) => [sec(s), 'beep']);
const HIGH_BEEPS: Heard[] = [5, 4, 3, 2, 1].map((s) => [sec(s), 'beep-high']);

/**
 * Counts a run down one tick at a time from `fromTicks` to `toTicks`
 * (inclusive), the way GameSession does while playing: the tick that reaches
 * 0 is the TIME UP gameover.
 */
function countDown(tracker: TimeWarningCueTracker, fromTicks: number, toTicks = 0): Heard[] {
  const heard: Heard[] = [];
  for (let remaining = fromTicks; remaining >= toTicks; remaining--) {
    const status: SessionStatus = remaining === 0 ? 'gameover' : 'playing';
    const cue = tracker.step(remaining, status);
    if (cue) heard.push([remaining, cue]);
  }
  return heard;
}

describe('time warning thresholds', () => {
  it('alarms at 30 and 15 seconds, beeps from 10 and switches to the high beep from 5', () => {
    expect(HUD_TIME_WARNING_TICKS).toBe(sec(30));
    expect(SFX_TIME_WARNING_SECOND_ALARM_SEC).toBe(15);
    expect(SFX_TIME_WARNING_BEEP_FROM_SEC).toBe(10);
    expect(SFX_TIME_WARNING_HIGH_FROM_SEC).toBe(5);
  });
});

describe('cueAtTicks', () => {
  it('is the alarm at exactly 30 seconds', () => {
    expect(cueAtTicks(HUD_TIME_WARNING_TICKS)).toBe('alarm');
  });

  it('is the alarm again at exactly 15 seconds', () => {
    expect(cueAtTicks(900)).toBe('alarm');
    expect(cueAtTicks(sec(SFX_TIME_WARNING_SECOND_ALARM_SEC))).toBe('alarm');
  });

  it('is a beep at exactly 10, 9, 8, 7 and 6 seconds', () => {
    for (const s of [10, 9, 8, 7, 6]) expect(cueAtTicks(sec(s))).toBe('beep');
  });

  it('is a high beep at exactly 5, 4, 3, 2 and 1 seconds', () => {
    for (const s of [5, 4, 3, 2, 1]) expect(cueAtTicks(sec(s))).toBe('beep-high');
  });

  it('is nothing at 0', () => {
    expect(cueAtTicks(0)).toBeNull();
  });

  it('is nothing one tick either side of a threshold', () => {
    for (const s of [30, 15, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) {
      expect(cueAtTicks(sec(s) + 1)).toBeNull();
      expect(cueAtTicks(sec(s) - 1)).toBeNull();
    }
  });

  it('is nothing on whole seconds outside the table', () => {
    for (const s of [180, 60, 31, 29, 20, 16, 14, 12, 11]) expect(cueAtTicks(sec(s))).toBeNull();
  });

  it('names exactly 12 ticks of a whole run', () => {
    const cued: Heard[] = [];
    for (let remaining = sec(180); remaining >= 0; remaining--) {
      const cue = cueAtTicks(remaining);
      if (cue) cued.push([remaining, cue]);
    }
    expect(cued).toEqual([...ALARMS, ...BEEPS, ...HIGH_BEEPS]);
    expect(cued).toHaveLength(12);
  });
});

describe('TimeWarningCueTracker', () => {
  it('plays each threshold exactly once over a countdown from above 30 seconds', () => {
    // The alarm twice — on 1800 and on 900 — then the ten beeps.
    const tracker = new TimeWarningCueTracker();
    expect(countDown(tracker, sec(35))).toEqual([[1800, 'alarm'], [900, 'alarm'], ...BEEPS, ...HIGH_BEEPS]);
  });

  it('plays each remaining threshold exactly once over a countdown from 1799 ticks', () => {
    // 1799 is already past the first alarm's 1800: the alarm at 900 and the
    // ten beeps are left.
    const tracker = new TimeWarningCueTracker();
    expect(countDown(tracker, sec(30) - 1)).toEqual([[900, 'alarm'], ...BEEPS, ...HIGH_BEEPS]);
  });

  it('stays silent on the first playing tick, even on a threshold', () => {
    for (const s of [30, 15, 10, 5, 1]) {
      const tracker = new TimeWarningCueTracker();
      expect(tracker.step(sec(s), 'playing')).toBeNull();
    }
  });

  it('skips the 15-second alarm when a run starts at or below 15 seconds', () => {
    // A 900-tick limit: the title screen sits on exactly 15 seconds, so that
    // value is never counted down onto.
    const atLimit = new TimeWarningCueTracker();
    expect(atLimit.step(900, 'title')).toBeNull();
    expect(countDown(atLimit, 900)).toEqual([...BEEPS, ...HIGH_BEEPS]);

    const below = new TimeWarningCueTracker();
    expect(below.step(sec(12), 'title')).toBeNull();
    expect(countDown(below, sec(12))).toEqual([...BEEPS, ...HIGH_BEEPS]);
  });

  it('skips the thresholds a run started below, then plays the rest', () => {
    // A 300-tick limit: the title screen sits on exactly 5 seconds, and the
    // first playing tick is already 299.
    const tracker = new TimeWarningCueTracker();
    expect(tracker.step(300, 'title')).toBeNull();
    expect(countDown(tracker, 299)).toEqual([4, 3, 2, 1].map((s) => [sec(s), 'beep-high']));
  });

  it('stays silent when a run starts exactly on a threshold it only sat on at the title', () => {
    // The tick that leaves the title does not count down yet, so the first
    // playing tick still reads the full limit.
    const tracker = new TimeWarningCueTracker();
    expect(tracker.step(sec(8), 'title')).toBeNull();
    expect(countDown(tracker, sec(8))).toEqual([
      [sec(7), 'beep'],
      [sec(6), 'beep'],
      ...HIGH_BEEPS,
    ]);
  });

  it('never plays at the title or on gameover', () => {
    const tracker = new TimeWarningCueTracker();
    tracker.step(sec(10) + 1, 'playing');
    expect(tracker.step(sec(10), 'gameover')).toBeNull();
    expect(tracker.step(sec(10), 'title')).toBeNull();
  });

  it('plays the same thresholds again in the next run', () => {
    const tracker = new TimeWarningCueTracker();
    const firstRun = countDown(tracker, sec(35));
    // GAME OVER and the title in between, both standing still.
    for (let i = 0; i < 3; i++) expect(tracker.step(0, 'gameover')).toBeNull();
    for (let i = 0; i < 3; i++) expect(tracker.step(sec(35), 'title')).toBeNull();
    expect(countDown(tracker, sec(35))).toEqual(firstRun);
    expect(firstRun).toHaveLength(12);
  });

  it('forgets a run that ended on gameover, so the next run starts unarmed', () => {
    const tracker = new TimeWarningCueTracker();
    tracker.step(sec(10) + 1, 'playing');
    tracker.step(sec(10) + 1, 'gameover');
    // Without the reset this would read as a one-tick countdown onto 10s.
    expect(tracker.step(sec(10), 'playing')).toBeNull();
  });

  it('stays silent while the time stands still, then carries on', () => {
    const tracker = new TimeWarningCueTracker();
    // Play down to just above 8 seconds...
    expect(countDown(tracker, sec(9) - 1, sec(8) + 1)).toEqual([]);
    // ...sit on the STAGE CLEAR screen for a while...
    for (let i = 0; i < 120; i++) expect(tracker.step(sec(8) + 1, 'stageclear')).toBeNull();
    // ...and the first playing tick back lands on 8 seconds.
    expect(tracker.step(sec(8), 'playing')).toBe('beep');
    expect(countDown(tracker, sec(8) - 1)).toEqual([
      [sec(7), 'beep'],
      [sec(6), 'beep'],
      ...HIGH_BEEPS,
    ]);
  });

  it('stays silent on a threshold the time stood still on', () => {
    const tracker = new TimeWarningCueTracker();
    tracker.step(sec(7) + 1, 'playing');
    expect(tracker.step(sec(7), 'playing')).toBe('beep');
    for (let i = 0; i < 10; i++) expect(tracker.step(sec(7), 'stageclear')).toBeNull();
    expect(tracker.step(sec(7) - 1, 'playing')).toBeNull();
  });

  it('drops a threshold that lands on the tick a stage is cleared', () => {
    const tracker = new TimeWarningCueTracker();
    tracker.step(sec(8) + 1, 'playing');
    expect(tracker.step(sec(8), 'stageclear')).toBeNull();
    // Not played late either, on the screen or after resuming.
    for (let i = 0; i < 10; i++) expect(tracker.step(sec(8), 'stageclear')).toBeNull();
    expect(countDown(tracker, sec(8) - 1)).toEqual([
      [sec(7), 'beep'],
      [sec(6), 'beep'],
      ...HIGH_BEEPS,
    ]);
  });

  it('drops the 15-second alarm when it lands on the tick a stage is cleared', () => {
    const tracker = new TimeWarningCueTracker();
    tracker.step(sec(15) + 1, 'playing');
    expect(tracker.step(sec(15), 'stageclear')).toBeNull();
    for (let i = 0; i < 10; i++) expect(tracker.step(sec(15), 'stageclear')).toBeNull();
    expect(countDown(tracker, sec(15) - 1)).toEqual([...BEEPS, ...HIGH_BEEPS]);
  });

  it('does not play the thresholds a downward jump skipped', () => {
    const tracker = new TimeWarningCueTracker();
    expect(countDown(tracker, sec(180), sec(170))).toEqual([]);
    // The limit drops from 180 to 10 seconds mid-run: the remaining time
    // jumps past both alarms and lands on 3.5 seconds.
    expect(tracker.step(210, 'playing')).toBeNull();
    expect(countDown(tracker, 209)).toEqual([3, 2, 1].map((s) => [sec(s), 'beep-high']));
  });

  it('stays silent when a downward jump lands exactly on a threshold', () => {
    const tracker = new TimeWarningCueTracker();
    tracker.step(sec(60), 'playing');
    expect(tracker.step(sec(10), 'playing')).toBeNull();
    expect(tracker.step(sec(10) - 1, 'playing')).toBeNull();
  });

  it('stays silent on an upward jump, and plays the alarm again once 30 seconds is crossed again', () => {
    const tracker = new TimeWarningCueTracker();
    expect(countDown(tracker, sec(31), sec(29))).toEqual([[sec(30), 'alarm']]);
    // The limit is raised mid-run: back above 30 seconds.
    expect(tracker.step(sec(40), 'playing')).toBeNull();
    expect(countDown(tracker, sec(40) - 1, sec(29))).toEqual([[sec(30), 'alarm']]);
  });

  it('stays silent on an upward jump, and plays the alarm again once 15 seconds is crossed again', () => {
    const tracker = new TimeWarningCueTracker();
    expect(countDown(tracker, sec(16), sec(14))).toEqual([[sec(15), 'alarm']]);
    // The limit is raised mid-run: back above 15 seconds, still below 30.
    expect(tracker.step(sec(20), 'playing')).toBeNull();
    expect(countDown(tracker, sec(20) - 1, sec(14))).toEqual([[sec(15), 'alarm']]);
  });

  it('stays silent when an upward jump lands exactly on a threshold', () => {
    const tracker = new TimeWarningCueTracker();
    tracker.step(sec(3), 'playing');
    expect(tracker.step(sec(30), 'playing')).toBeNull();
  });

  it('re-arms silently after reset()', () => {
    const tracker = new TimeWarningCueTracker();
    tracker.step(sec(10) + 1, 'playing');
    tracker.reset();
    // Unarmed again: a one-tick countdown onto 10 seconds is not a cue...
    expect(tracker.step(sec(10), 'playing')).toBeNull();
    // ...but everything after it is.
    expect(countDown(tracker, sec(10) - 1)).toEqual([
      [sec(9), 'beep'],
      [sec(8), 'beep'],
      [sec(7), 'beep'],
      [sec(6), 'beep'],
      ...HIGH_BEEPS,
    ]);
  });
});
