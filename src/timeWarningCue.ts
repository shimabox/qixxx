// Decides, tick by tick, which TIME countdown warning sound (if any) is due.
//
// A run ends the instant its time budget reaches 0, whatever lives are left,
// and the HUD's TIME turning red is easy to miss while watching the board.
// So the last stretch is also announced by ear: an alarm when 30 seconds are
// left and again at 15, then a beep on every whole second from 10 down to 1.
//
// The live driver (src/main.ts's update()) calls the tracker once per tick,
// right after GameSession.update(), and hands any cue to
// SfxEngine.playTimeWarning(). Replay viewing never reaches that call, so
// replays stay silent. Nothing here touches src/core/: the decision reads
// only the remaining ticks and the session status, and leaves scoring, replay
// reproduction and ranking verification untouched.
//
// Kept as a standalone, DOM-free module (like src/replayStageClearHold.ts) so
// this logic has direct unit test coverage — src/main.ts itself is DOM-only
// orchestration with no dedicated test file.
import type { SessionStatus } from './core/session';
import {
  TICK_RATE,
  HUD_TIME_WARNING_TICKS,
  SFX_TIME_WARNING_SECOND_ALARM_SEC,
  SFX_TIME_WARNING_BEEP_FROM_SEC,
  SFX_TIME_WARNING_HIGH_FROM_SEC,
} from './config';

export type TimeWarningCue = 'alarm' | 'beep' | 'beep-high';

/**
 * The cue that belongs to exactly `remainingTicks` left, or null.
 *
 * Only whole seconds carry a cue: the alarm at HUD_TIME_WARNING_TICKS (the
 * tick the HUD's TIME turns red) and again at
 * SFX_TIME_WARNING_SECOND_ALARM_SEC, a beep at each second from
 * SFX_TIME_WARNING_BEEP_FROM_SEC down to 1, at the higher pitch from
 * SFX_TIME_WARNING_HIGH_FROM_SEC. 0 has none — that tick is the TIME UP
 * gameover itself.
 */
export function cueAtTicks(remainingTicks: number): TimeWarningCue | null {
  if (remainingTicks === HUD_TIME_WARNING_TICKS) return 'alarm';
  if (remainingTicks === SFX_TIME_WARNING_SECOND_ALARM_SEC * TICK_RATE) return 'alarm';
  if (remainingTicks <= 0 || remainingTicks % TICK_RATE !== 0) return null;
  const seconds = remainingTicks / TICK_RATE;
  if (seconds > SFX_TIME_WARNING_BEEP_FROM_SEC) return null;
  return seconds <= SFX_TIME_WARNING_HIGH_FROM_SEC ? 'beep-high' : 'beep';
}

export class TimeWarningCueTracker {
  // Remaining ticks seen by the previous step(), or null while unarmed.
  private lastRemainingTicks: number | null = null;

  /**
   * Call once per tick, after GameSession.update(). Returns the cue to play
   * on this tick, or null.
   *
   * A cue is only ever returned when the remaining time has just counted down
   * by exactly one tick during play. Every other change re-arms silently:
   * - the first playing tick of a run, so a run started with less time than a
   *   threshold never announces the thresholds it was already past;
   * - a jump in either direction (the debug panel changing the time limit
   *   mid-run), so skipped thresholds neither sound nor pile up — while a
   *   threshold crossed again after the time was raised does sound again;
   * - a tick on which the time stood still (the STAGE CLEAR screen), after
   *   which the countdown simply carries on from where it stopped.
   */
  step(remainingTicks: number, status: SessionStatus): TimeWarningCue | null {
    // No run in progress: forget it, so the next run starts unarmed.
    if (status === 'title' || status === 'gameover') {
      this.lastRemainingTicks = null;
      return null;
    }
    const countedDown = this.lastRemainingTicks !== null && remainingTicks === this.lastRemainingTicks - 1;
    this.lastRemainingTicks = remainingTicks;
    if (!countedDown) return null;
    // The tick that clears a stage still counts down, but its cue is dropped:
    // the stage-clear jingle is what plays there.
    return status === 'playing' ? cueAtTicks(remainingTicks) : null;
  }

  /** Back to unarmed, as before the first tick of a run. */
  reset(): void {
    this.lastRemainingTicks = null;
  }
}
