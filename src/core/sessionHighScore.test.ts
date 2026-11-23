// Which runs' scores GameSession's high score takes in: a NORMAL run no debug
// override has touched. An EASY run's score, or one played with a debug
// override at any point (a RESET mid-run included), never reaches it — during
// the run, at its GAME OVER, or in any run after it — so main.ts can never
// save it.
import { describe, it, expect } from 'vitest';
import { GameSession, SessionInput } from './session';
import type { Difficulty } from './difficulty';

const CONFIRM: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: true };
const IDLE: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };

/** From the middle of the top edge: an 8 x 8 box straight down, right and back up (24 points). */
function claimBox(session: GameSession): void {
  const steps = [...Array(8).fill({ dx: 0, dy: 1 }), ...Array(8).fill({ dx: 1, dy: 0 }), ...Array(8).fill({ dx: 0, dy: -1 })];
  for (const step of steps) session.update({ ...IDLE, ...step, drawHeld: true });
}

/** A session on its first run's stage 1, with a short time budget. */
function playing(difficulty: Difficulty, highScore: number): GameSession {
  const session = new GameSession({ seed: 8, highScore, timeLimitTicks: 60, difficulty });
  session.update(CONFIRM);
  return session;
}

function runOutTheTime(session: GameSession): void {
  while (session.getStatus() === 'playing') session.update(IDLE);
  expect(session.getStatus()).toBe('gameover');
}

/** GAME OVER -> Title -> stage 1 of the next run, at `difficulty`. */
function nextRun(session: GameSession, difficulty: Difficulty): void {
  session.setNextDifficulty(difficulty);
  session.update(CONFIRM);
  session.update(CONFIRM);
  expect(session.getStatus()).toBe('playing');
  expect(session.getDifficulty()).toBe(difficulty);
}

describe('GameSession — the high score', () => {
  it('takes in a NORMAL run’s score past it, during the run and at its GAME OVER', () => {
    const session = playing('normal', 3);
    expect(session.countsTowardHighScore()).toBe(true);
    claimBox(session);
    expect(session.getScore()).toBeGreaterThan(3);
    expect(session.getHighScore()).toBe(session.getScore());
    runOutTheTime(session);
    expect(session.getHighScore()).toBe(session.getScore());
  });

  it('never takes in an EASY run’s score, nor gives it to the NORMAL run after it', () => {
    const session = playing('easy', 3);
    expect(session.countsTowardHighScore()).toBe(false);
    claimBox(session);
    expect(session.getScore()).toBeGreaterThan(3);
    expect(session.getHighScore()).toBe(3);
    runOutTheTime(session);
    expect(session.getHighScore()).toBe(3);
    nextRun(session, 'normal');
    expect(session.countsTowardHighScore()).toBe(true);
    expect(session.getHighScore()).toBe(3);
    runOutTheTime(session); // scores 0
    expect(session.getHighScore()).toBe(3);
  });

  it('never takes in a debug-tuned run’s score — after a RESET mid-run, at its GAME OVER, or in the clean run after it', () => {
    const session = playing('normal', 3);
    session.applyDebugOverrides({ wispSpeedMultiplier: 1 });
    expect(session.countsTowardHighScore()).toBe(false);
    claimBox(session);
    expect(session.getScore()).toBeGreaterThan(3);
    expect(session.getHighScore()).toBe(3);
    // (a) RESET in the same run: no override is active any more, but the run was tuned.
    session.resetDebugOverrides();
    expect(session.hasActiveDebugOverrides()).toBe(false);
    expect(session.getHighScore()).toBe(3);
    runOutTheTime(session);
    expect(session.getHighScore()).toBe(3);
    // (b) The next run, with no override.
    nextRun(session, 'normal');
    expect(session.isRunTainted()).toBe(false);
    expect(session.getHighScore()).toBe(3);
  });

  it('keeps the score a run reached before its first debug override, and only that', () => {
    const session = new GameSession({ seed: 8, highScore: 3, timeLimitTicks: 120 });
    session.update(CONFIRM);
    claimBox(session);
    const beforeOverride = session.getScore();
    expect(beforeOverride).toBeGreaterThan(3);
    expect(session.getHighScore()).toBe(beforeOverride);
    // (a) An override mid-run: the score reached so far stays the high score;
    // what the run adds from here does not raise it.
    session.applyDebugOverrides({ wispSpeedMultiplier: 1 });
    expect(session.getHighScore()).toBe(beforeOverride);
    claimBox(session);
    expect(session.getScore()).toBeGreaterThan(beforeOverride);
    expect(session.getHighScore()).toBe(beforeOverride);
    session.resetDebugOverrides();
    expect(session.getHighScore()).toBe(beforeOverride);
    runOutTheTime(session);
    expect(session.getHighScore()).toBe(beforeOverride);
    // (b) The next run, with no override: the high score it chases is still that score.
    nextRun(session, 'normal');
    expect(session.isRunTainted()).toBe(false);
    expect(session.getHighScore()).toBe(beforeOverride);
    runOutTheTime(session); // scores 0
    expect(session.getHighScore()).toBe(beforeOverride);
  });

  it('keeps the score reached before a debug time-limit override the same way', () => {
    const session = new GameSession({ seed: 8, highScore: 3, timeLimitTicks: 120 });
    session.update(CONFIRM);
    claimBox(session);
    const beforeOverride = session.getScore();
    session.setDebugTimeLimitTicks(120);
    claimBox(session);
    expect(session.getScore()).toBeGreaterThan(beforeOverride);
    expect(session.getHighScore()).toBe(beforeOverride);
  });

  it('keeps a debug-tuned run’s score out even with the override left on into GAME OVER, then RESET there', () => {
    const session = playing('normal', 3);
    session.applyDebugOverrides({ wispSpeedMultiplier: 1 });
    claimBox(session);
    runOutTheTime(session);
    session.resetDebugOverrides();
    expect(session.getHighScore()).toBe(3);
    nextRun(session, 'normal');
    expect(session.getHighScore()).toBe(3);
  });
});
