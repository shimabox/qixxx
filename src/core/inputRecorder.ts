// Records a normal run's PLAYING-tick inputs for later ranking submission.
// Pure logic — no DOM/
// localStorage/fetch dependency. Deliberately reads GameSession's own tick
// counter (`getTotalTicks()`) to decide whether *this* tick actually
// advanced play, rather than trusting a caller-supplied "were we playing"
// flag — that's the same source of truth core/session.ts's own tick
// counters use, so this can never drift from what a server-side replay of
// the same samples would also count as tick 1..10800.
import { InputSample, encodeRle } from './rle';
import { MAX_INPUT_SAMPLES } from '../config';

export interface RecordableInput {
  dx: InputSample['dx'];
  dy: InputSample['dy'];
  drawHeld: boolean;
  slow?: boolean;
}

/**
 * The minimal slice of GameSession's API observe() actually needs —
 * structural rather than importing the concrete class, so a test can pass a
 * lightweight fake instead of driving a real (real-time-shaped) session up
 * to its 10800-tick cap just to exercise that boundary.
 */
export interface TickSource {
  getTotalTicks(): number;
}

export class InputRecorder {
  private samples: InputSample[] = [];
  private lastTotalTicks = 0;

  /**
   * Call once per tick, immediately after `session.update(input)` — `input`
   * must be the exact object passed to that same call. Records exactly one
   * sample per *new* playing tick (GameSession.getTotalTicks() increasing by
   * 1 — never happens for a title/stageclear/gameover-status tick, matching
   * "PLAYING 中の入力のみ記録する" precisely), and never past
   * MAX_INPUT_SAMPLES (a run's own time budget already prevents this in
   * practice, but this guard keeps the invariant explicit and cheap rather
   * than implicit).
   */
  observe(session: TickSource, input: RecordableInput): void {
    const totalTicks = session.getTotalTicks();
    if (totalTicks > this.lastTotalTicks && this.samples.length < MAX_INPUT_SAMPLES) {
      this.samples.push({ dx: input.dx, dy: input.dy, drawHeld: input.drawHeld, slow: !!input.slow });
    }
    this.lastTotalTicks = totalTicks;
  }

  /** Clears every recorded sample — call whenever a fresh run starts (GameSession.resetToFreshRun()'s boundary; see main.ts's wiring). */
  reset(): void {
    this.samples = [];
    this.lastTotalTicks = 0;
  }

  /** A defensive copy of every sample recorded since the last reset(). */
  getSamples(): InputSample[] {
    return this.samples.map((s) => ({ ...s }));
  }

  /** RLE-encodes every sample recorded since the last reset() (core/rle.ts's encodeRle()). */
  encode(): Uint8Array {
    return encodeRle(this.samples);
  }
}
