// The live run's session step and its run bookkeeping, including the GAME
// OVER retry: one confirm at GAME OVER starts stage 1 directly instead of
// stopping at Title. DOM-free, so the whole flow — the reset at the run
// boundary, the recorded inputs, and the run that follows — is unit tested
// against the server's own replay verifier (src/retryFlow.test.ts).
//
// The core is untouched: GAME OVER -> Title still happens exactly as before,
// with every fresh-run reset in the same order, and a retry then hands the
// session one more confirm-only input in the same tick, taking Title ->
// Playing before a single frame of Title is drawn. Title -> Playing plays no
// tick of its own (core/session.ts's 'title' case only flips the status), so
// the recorded inputs and the run's tick count are the same as if the player
// had pressed confirm again on Title.
import type { SessionInput, SessionStatus } from './core/session';
import { InputRecorder, type TickSource } from './core/inputRecorder';
import type { GameEvent } from './core/events';
import type { Difficulty } from './core/difficulty';
import type { RunMode } from './runMode';
import type { RunSubmissionSnapshot } from './ui/ranking';

/** What the GAME OVER edge reads off the live session about the run that just ended. */
export interface FinishedRunSession {
  getSeed(): number | undefined;
  getScore(): number;
  getStage(): number;
  isRunTainted(): boolean;
  getDifficulty(): Difficulty;
}

/**
 * Everything the ranking offer may ever read about the run that just ended,
 * frozen on the frame it ends (see RunSubmissionSnapshot): later changes to
 * the session — the next run's difficulty picked, a new run begun — never
 * reach it.
 */
export function freezeRunSnapshot(session: FinishedRunSession, tracker: LiveRunTracker, runMode: RunMode): RunSubmissionSnapshot {
  return {
    runId: tracker.getRunId(),
    seed: session.getSeed(),
    rle: tracker.recorder.encode(),
    score: session.getScore(),
    stage: session.getStage(),
    runMode,
    tainted: session.isRunTainted(),
    difficulty: session.getDifficulty(),
    claims: tracker.getClaims(),
  };
}

/**
 * Whether the run that just ended is kept in the play log: a normal
 * (non-`?seed=`) NORMAL-difficulty run that no debug override ever touched.
 */
export function keepsInPlayLog(session: Pick<FinishedRunSession, 'isRunTainted' | 'getDifficulty'>, runMode: RunMode): boolean {
  return runMode === 'normal' && session.getDifficulty() === 'normal' && !session.isRunTainted();
}

/** The parts of GameSession a live step drives. */
export interface LiveStepSession {
  getStatus(): SessionStatus;
  update(input: SessionInput): void;
}

/** The second input of a retry: confirm and nothing else. */
export const RETRY_CONFIRM_INPUT: Readonly<SessionInput> = Object.freeze({
  dx: 0,
  dy: 0,
  drawHeld: false,
  slow: false,
  confirm: true,
});

export interface LiveStepOptions {
  /**
   * When this step's confirm ends GAME OVER: true goes on to stage 1 in the
   * same tick (RETRY, a key, a tap on the field); false stops at Title (the
   * modal's TITLE button).
   */
  retry: boolean;
  /**
   * Called on the GAME OVER -> Title boundary, after the session's own reset
   * and before a retry's second update: everything that belongs to the run
   * that just ended is reset here (see LiveRunTracker.startFreshRun()).
   */
  onFreshRun: () => void;
}

export interface LiveStepResult {
  /** The run ended at GAME OVER and a fresh one began (Title, or stage 1 on a retry). */
  freshRun: boolean;
  /** A retry took the fresh run straight to stage 1. */
  retried: boolean;
}

/** One live tick's GameSession update(s). */
export function stepLiveSession(session: LiveStepSession, input: SessionInput, options: LiveStepOptions): LiveStepResult {
  const before = session.getStatus();
  session.update(input);
  if (before !== 'gameover' || session.getStatus() !== 'title') return { freshRun: false, retried: false };
  options.onFreshRun();
  if (!options.retry) return { freshRun: true, retried: false };
  session.update({ ...RETRY_CONFIRM_INPUT });
  return { freshRun: true, retried: session.getStatus() === 'playing' };
}

/**
 * The live run's own bookkeeping: its id, its recorded inputs (for the
 * ranking submission) and its successful area claims (checked against
 * MAX_VERIFIED_CLAIMS before offering a submission). startFreshRun() is the
 * only place a new run begins.
 */
export class LiveRunTracker {
  readonly recorder = new InputRecorder();
  private runId = 1;
  private claims = 0;

  getRunId(): number {
    return this.runId;
  }

  getClaims(): number {
    return this.claims;
  }

  /**
   * A brand-new run begins (GameSession's resetToFreshRun() just ran): the
   * recorder is cleared — otherwise its "already seen this tick" guard would
   * refuse the new run's early ticks — the claims count from 0, and the id
   * moves on, so an /api/ranking reply for the run that ended can be told
   * apart from the new one (src/ui/ranking.ts's decideSubmissionOffer()).
   */
  startFreshRun(): void {
    this.recorder.reset();
    this.claims = 0;
    this.runId++;
  }

  /** After the tick's update(s): records a played tick's input and counts its claims. */
  observe(session: TickSource, input: SessionInput, events: readonly GameEvent[]): void {
    this.recorder.observe(session, input);
    for (const ev of events) if (ev === 'area-claimed') this.claims++;
  }
}
