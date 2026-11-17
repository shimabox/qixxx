// The live run's pause: when it may be paused, whether it is, and the pause
// keys. No DOM — main.ts hands it the keys, the buttons and the page being
// hidden, and runs the fixed-step update only while it says so.
//
// A pause only stops ticks: while paused nothing reads the input, steps the
// session or records a sample, so a run paused along the way records exactly
// the inputs it would have recorded unpaused, and replays to the same result.
import type { GameSession } from './core/session';

export type SessionStatus = ReturnType<GameSession['getStatus']>;

/** What decides whether the run may be paused now. */
export interface PauseContext {
  /** The live run is on screen (not a ranking replay). */
  live: boolean;
  status: SessionStatus;
}

export type PauseToggle = 'paused' | 'resumed';

const PAUSE_KEYS: readonly string[] = ['KeyP', 'Escape'];

/** P and Escape pause and resume. */
export function isPauseKey(code: string): boolean {
  return PAUSE_KEYS.includes(code);
}

export class PauseControl {
  private paused = false;
  // The pause keys currently held, so holding one (its auto-repeat) never
  // resumes and pauses again.
  private readonly heldKeys = new Set<string>();

  /** Only live play can be paused: not Title, STAGE CLEAR, GAME OVER or a replay. */
  static canPause(ctx: PauseContext): boolean {
    return ctx.live && ctx.status === 'playing';
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Whether the fixed-step loop runs this frame's ticks. */
  shouldStep(): boolean {
    return !this.paused;
  }

  /** Pauses the run if it may be paused and is not already. True if it paused now. */
  requestPause(ctx: PauseContext): boolean {
    if (this.paused || !PauseControl.canPause(ctx)) return false;
    this.paused = true;
    return true;
  }

  /** Resumes a paused run. True if it resumed now. */
  requestResume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    return true;
  }

  /** Pauses a playing run or resumes a paused one; null if neither happened. */
  toggle(ctx: PauseContext): PauseToggle | null {
    if (this.paused) return this.requestResume() ? 'resumed' : null;
    return this.requestPause(ctx) ? 'paused' : null;
  }

  /**
   * A key went down. A new press of a pause key toggles; a pause key already
   * held (its auto-repeat, flagged `repeat` or not) does nothing.
   */
  keyDown(code: string, repeat: boolean, ctx: PauseContext): PauseToggle | null {
    if (!isPauseKey(code)) return null;
    if (repeat || this.heldKeys.has(code)) return null;
    this.heldKeys.add(code);
    return this.toggle(ctx);
  }

  keyUp(code: string): void {
    this.heldKeys.delete(code);
  }

  /** Every key counts as released (the page lost focus). */
  releaseKeys(): void {
    this.heldKeys.clear();
  }

  /**
   * Whether a pause key is kept from the game's own input: wherever it pauses
   * or resumes, so it never also reaches the run as a press. On every other
   * screen P and Escape work as any other key.
   */
  consumesKey(code: string, ctx: PauseContext): boolean {
    return isPauseKey(code) && (this.paused || PauseControl.canPause(ctx));
  }
}
