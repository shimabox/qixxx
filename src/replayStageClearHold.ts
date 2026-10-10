// Pure tick counter behind replay viewing's STAGE CLEAR pause.
//
// ReplayEngine.stepTick() confirms a pending StageClear and consumes the next
// recorded input in the same call, so a replay driven once per tick shows the
// next stage on the very frame the previous one was cleared — the clear itself
// never reaches the screen. The viewer's driver (src/main.ts's update())
// therefore asks this counter, every tick, whether to withhold stepTick():
// while it says yes the replay session is not touched at all, so its tick
// count, score, RNG state and consumed-input position stand still and the
// playback that follows is the one that would have happened without the
// pause.
//
// Counted in fixed ticks rather than wall-clock time, so the pause shares the
// game loop's single time axis. Kept as a standalone, DOM-free module (like
// src/runMode.ts) so this logic has direct unit test coverage — src/main.ts
// itself is DOM-only orchestration with no dedicated test file.
import type { SessionStatus } from './core/session';

export interface ReplayHoldState {
  /** The replay session's current status. */
  status: SessionStatus;
  /** ReplayEngine.isFinished(): no recorded input is left to play. */
  finished: boolean;
}

export class ReplayStageClearHold {
  private held = 0;

  constructor(private readonly holdTicks: number) {}

  /**
   * Call once per tick, before stepTick(). True means "skip stepTick() this
   * tick"; false means "call it" — which, on the tick a hold expires, is what
   * confirms the StageClear and starts the next stage.
   *
   * A finished replay never holds: with no input left there is no next stage
   * to pause before, and stepTick() has to run so its `false` can end
   * playback.
   */
  shouldHold(state: ReplayHoldState): boolean {
    if (state.status !== 'stageclear' || state.finished) {
      this.held = 0;
      return false;
    }
    if (this.held < this.holdTicks) {
      this.held++;
      return true;
    }
    this.held = 0;
    return false;
  }

  /** Forgets a hold in progress, so the next StageClear gets its full pause. */
  reset(): void {
    this.held = 0;
  }
}
