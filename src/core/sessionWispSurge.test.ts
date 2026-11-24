// GameSession and the Wisp surge (core/wispSurge.ts): a NORMAL run's stages
// speed their Wisps up toward the goal, an EASY run's never do, and every
// stage starts again on level 0.
import { describe, it, expect } from 'vitest';
import { GameSession, SessionInput } from './session';
import { getStageConfig } from './stage';
import { clearFromStart } from './stageStartFixture';
import { Difficulty } from './difficulty';
import { EASY_WISP_SPEED_FACTOR } from '../config';

const CONFIRM: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: true };

const speeds = (session: GameSession) => session.getGame().getWisps().map((w) => w.getSpeedMultiplier());

/** From where the marker stands on the top edge: two cells down, two right and back up (stage 1 starts at the middle of the top edge). */
function claimBox(session: GameSession): void {
  const steps: Array<Pick<SessionInput, 'dx' | 'dy'>> = [
    { dx: 0, dy: 1 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: 0, dy: -1 },
  ];
  for (const step of steps) session.update({ ...step, drawHeld: true, slow: false, confirm: false });
  expect(session.getGame().getMarker().isDrawing()).toBe(false);
}

/**
 * Stage 1, the goal lowered to four times the first box's occupancy: that is
 * short of half of it (level 0). The second box, sharing the first one's
 * side, brings occupancy to three times the first: past half of the goal,
 * within 0.10 of it, and short of it.
 */
function playTwoBoxes(difficulty: Difficulty): { session: GameSession; afterFirst: number[]; levelAfterFirst: number } {
  const session = new GameSession({ seed: 5, difficulty, captureFeedback: true });
  session.update(CONFIRM);
  claimBox(session);
  const first = session.getGame().getOccupancy();
  expect(first).toBeGreaterThan(0);
  session.applyDebugOverrides({ requiredOccupancy: first * 4 });
  const afterFirst = speeds(session);
  const levelAfterFirst = session.getGame().getWispSurgeLevel();
  claimBox(session);
  expect(session.getGame().getOccupancy()).toBeCloseTo(first * 3, 12);
  expect(session.getStatus()).toBe('playing');
  return { session, afterFirst, levelAfterFirst };
}

describe('GameSession — the Wisp surge', () => {
  it('speeds a NORMAL stage’s Wisps up on the claim that crosses, and starts the next stage on level 0 at the table speed', () => {
    const table1 = getStageConfig(1);
    const { session, afterFirst, levelAfterFirst } = playTwoBoxes('normal');
    expect(session.getGame().isWispSurgeEnabled()).toBe(true);
    expect(levelAfterFirst).toBe(0);
    expect(afterFirst).toEqual(Array(table1.wispCount).fill(table1.wispSpeedMultiplier));
    expect(session.getGame().getWispSurgeLevel()).toBe(2);
    expect(speeds(session)).toEqual(Array(table1.wispCount).fill(table1.wispSpeedMultiplier * 1.3));
    expect(session.getEffectiveDebugParams().wispSpeedMultiplier).toBe(table1.wispSpeedMultiplier);
    expect(session.drainWispSurgeFeedback().map((n) => n.level)).toEqual([2]);

    clearFromStart(session);
    session.update(CONFIRM);
    const table2 = getStageConfig(2);
    expect(session.getStage()).toBe(2);
    expect(session.getGame().getWispSurgeLevel()).toBe(0);
    expect(speeds(session)).toEqual(Array(table2.wispCount).fill(table2.wispSpeedMultiplier));
  });

  it('never speeds an EASY stage’s Wisps up', () => {
    const table1 = getStageConfig(1);
    const { session, levelAfterFirst } = playTwoBoxes('easy');
    expect(session.getGame().isWispSurgeEnabled()).toBe(false);
    expect(levelAfterFirst).toBe(0);
    expect(session.getGame().getWispSurgeLevel()).toBe(0);
    expect(speeds(session)).toEqual(Array(table1.wispCount).fill(table1.wispSpeedMultiplier * EASY_WISP_SPEED_FACTOR));
    expect(session.drainWispSurgeFeedback()).toEqual([]);

    clearFromStart(session);
    session.update(CONFIRM);
    const table2 = getStageConfig(2);
    expect(session.getGame().getWispSurgeLevel()).toBe(0);
    expect(speeds(session)).toEqual(Array(table2.wispCount).fill(table2.wispSpeedMultiplier * EASY_WISP_SPEED_FACTOR));
  });
});
