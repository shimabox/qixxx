// Run-taint lifecycle (docs/plans/2026-08-16-score-ranking task 2's "ラン単位
// の汚染追跡"/runTainted): what src/ui/ranking.ts's isEligible() reads to
// decide whether a finished run may be POSTed to the ranking at all.
//
// The case this file exists for: debug overrides are *session*-level state
// that deliberately survives a retry (GameSession.buildStageGame() re-applies
// them to every stage of every subsequent run), so resetToFreshRun() must not
// blanket-clear `tainted` — a retry that inherits live overrides is still a
// non-standard run.
import { describe, it, expect } from 'vitest';
import { GameSession, SessionInput } from './session';

const CONFIRM: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: true };
const IDLE: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };

/** Title -> Playing -> (time runs out) -> GameOver, using a tiny time budget so it takes a handful of ticks. */
function playUntilGameOver(session: GameSession): void {
  session.update(CONFIRM);
  let guard = 0;
  while (session.getStatus() !== 'gameover' && guard++ < 1000) {
    session.update(IDLE);
  }
  expect(session.getStatus()).toBe('gameover');
}

/** GameOver -> Title, i.e. the resetToFreshRun() boundary a retry crosses. */
function retryToTitle(session: GameSession): void {
  session.update(CONFIRM);
  expect(session.getStatus()).toBe('title');
}

describe('GameSession run taint', () => {
  it('starts clean and stays clean for a run that never touches the debug panel', () => {
    const session = new GameSession({ seed: 1, timeLimitTicks: 5 });
    expect(session.isRunTainted()).toBe(false);
    playUntilGameOver(session);
    expect(session.isRunTainted()).toBe(false);
    retryToTitle(session);
    expect(session.isRunTainted()).toBe(false);
  });

  it('is tainted the moment a debug override is applied', () => {
    const session = new GameSession({ seed: 1, timeLimitTicks: 5 });
    session.applyDebugOverrides({ wispCount: 0 });
    expect(session.isRunTainted()).toBe(true);
  });

  it('stays tainted for the rest of the run even after the overrides are cleared (sticky within a run)', () => {
    const session = new GameSession({ seed: 1, timeLimitTicks: 5 });
    session.applyDebugOverrides({ wispCount: 0 });
    session.resetDebugOverrides();
    expect(session.hasActiveDebugOverrides()).toBe(false);
    expect(session.isRunTainted()).toBe(true); // the run already happened under non-standard parameters
  });

  it('keeps a RETRY tainted while the overrides are still in effect (regression: reset used to clear the flag unconditionally)', () => {
    const session = new GameSession({ seed: 1, timeLimitTicks: 5 });
    session.applyDebugOverrides({ wispCount: 0 });
    playUntilGameOver(session);
    retryToTitle(session);

    // The overrides were never cleared, and buildStageGame() has already
    // re-applied them to this fresh run's stage-1 board...
    expect(session.hasActiveDebugOverrides()).toBe(true);
    expect(session.getDebugOverrides()).toEqual({ wispCount: 0 });
    // ...so the new run must be tainted too, not reported as clean.
    expect(session.isRunTainted()).toBe(true);

    // Still tainted once that retry is actually played out.
    playUntilGameOver(session);
    expect(session.isRunTainted()).toBe(true);
  });

  it('keeps a RETRY tainted for a debug TIME LIMIT override too (not just Game-level overrides)', () => {
    const session = new GameSession({ seed: 1, timeLimitTicks: 5 });
    session.setDebugTimeLimitTicks(4);
    playUntilGameOver(session);
    retryToTitle(session);
    expect(session.hasActiveDebugOverrides()).toBe(true);
    expect(session.isRunTainted()).toBe(true);
  });

  it('lets a retry start clean once the overrides really are cleared before it begins', () => {
    // The other half of the rule — the flag tracks the overrides actually in
    // effect at the run-start boundary, so it is not simply "true forever".
    const session = new GameSession({ seed: 1, timeLimitTicks: 5 });
    session.applyDebugOverrides({ wispCount: 0 });
    playUntilGameOver(session);
    session.resetDebugOverrides();
    retryToTitle(session);

    expect(session.hasActiveDebugOverrides()).toBe(false);
    expect(session.isRunTainted()).toBe(false);
  });
});
