// GameSession and the Wisp surge (core/wispSurge.ts): a NORMAL run's stages
// speed their Wisps up toward the goal from stage 6 on (stages 1 to 5 never
// do), an EASY run's never do, and every stage starts again on level 0.
import { describe, it, expect } from 'vitest';
import { GameSession, SessionInput } from './session';
import { clearFromStart, sessionAtStage } from './stageStartFixture';
import { MarkerStartEdge } from './markerStart';
import { Axis } from './marker';

const CONFIRM: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: true };

const speeds = (session: GameSession) => session.getGame().getWisps().map((w) => w.getSpeedMultiplier());

const move = (session: GameSession, dx: Axis, dy: Axis, drawHeld: boolean): void =>
  session.update({ dx, dy, drawHeld, slow: false, confirm: false });

const INWARD: Record<MarkerStartEdge, { dx: Axis; dy: Axis }> = {
  top: { dx: 0, dy: 1 },
  bottom: { dx: 0, dy: -1 },
  left: { dx: 1, dy: 0 },
  right: { dx: -1, dy: 0 },
};

/**
 * From where the marker stands on the stage's start edge: two cells in, two
 * along the edge and back out. A second box from where the first one ends
 * shares its side, and brings occupancy to three times the first.
 */
function claimBox(session: GameSession): void {
  const edge = session.getMarkerStart()!.edge;
  const inward = INWARD[edge];
  const along = inward.dx === 0 ? { dx: 1 as Axis, dy: 0 as Axis } : { dx: 0 as Axis, dy: 1 as Axis };
  for (let i = 0; i < 2; i++) move(session, inward.dx, inward.dy, true);
  for (let i = 0; i < 2; i++) move(session, along.dx, along.dy, true);
  for (let i = 0; i < 2; i++) move(session, -inward.dx as Axis, -inward.dy as Axis, true);
  expect(session.getGame().getMarker().isDrawing()).toBe(false);
}

/**
 * Two boxes from the start, the goal set between them to four times the
 * first box's occupancy (short of half of it). The second box brings
 * occupancy to three times the first: past half of the goal, within 0.10 of
 * it, and short of it — level 2 wherever the surge applies.
 */
function playTwoBoxes(session: GameSession): { afterFirst: number[]; levelAfterFirst: number } {
  // A goal out of reach first, so the first box cannot clear the stage.
  session.applyDebugOverrides({ requiredOccupancy: 0.99 });
  claimBox(session);
  const first = session.getGame().getOccupancy();
  expect(first).toBeGreaterThan(0);
  session.applyDebugOverrides({ requiredOccupancy: first * 4 });
  const afterFirst = speeds(session);
  const levelAfterFirst = session.getGame().getWispSurgeLevel();
  claimBox(session);
  expect(session.getGame().getOccupancy()).toBeCloseTo(first * 3, 12);
  expect(session.getStatus()).toBe('playing');
  return { afterFirst, levelAfterFirst };
}

/**
 * From where the marker stands (any edge, or the bottom of the last strip's
 * line), along the border to (`x`, 0) on the top edge — up where it can, else
 * left — then one fast line straight down to the bottom edge: the full height
 * strip left of `x` is claimed (the Wisps are on its right).
 */
function claimStripAt(session: GameSession, x: number): void {
  const height = session.getGame().getField().getHeight();
  const position = () => session.getGame().getMarker().getPosition();
  for (let guard = 0; guard < 1_000; guard++) {
    const p = position();
    if (p.x === x && p.y === 0) break;
    if (p.y === 0) {
      move(session, p.x > x ? -1 : 1, 0, false);
      continue;
    }
    move(session, 0, -1, false);
    if (position().y === p.y) move(session, -1, 0, false);
  }
  expect(session.getGame().getMarker().getPosition()).toEqual({ x, y: 0 });
  for (let i = 0; i < height - 1; i++) move(session, 0, 1, true);
  expect(session.getGame().getMarker().isDrawing()).toBe(false);
}

/**
 * Stage 6 on the full-size field (158 x 118 claimable cells), the goal set
 * to 0.23 before the first claim: the strip left of x=20 (19 of 158 columns)
 * is past half of the goal and more than 0.10 short of it (level 1), the
 * strip left of x=24 (23 of 158 columns) within 0.10 of it (level 2).
 */
function playTwoStrips(session: GameSession): { after: Array<{ occupancy: number; level: number; speeds: number[]; status: string }> } {
  session.applyDebugOverrides({ requiredOccupancy: 0.23 });
  const after: Array<{ occupancy: number; level: number; speeds: number[]; status: string }> = [];
  const lives = session.getLives();
  for (const x of [20, 24]) {
    claimStripAt(session, x);
    after.push({
      occupancy: session.getGame().getOccupancy(),
      level: session.getGame().getWispSurgeLevel(),
      speeds: speeds(session),
      status: session.getStatus(),
    });
  }
  expect(after.map((a) => a.occupancy)).toEqual([19 / 158, 23 / 158]);
  expect(after.map((a) => a.status)).toEqual(['playing', 'playing']);
  expect(session.getLives()).toBe(lives);
  return { after };
}

describe('GameSession — the Wisp surge', () => {
  // Stage 1: one Wisp at x1. Stage 5: three Wisps at x2.4.
  for (const { stage, tableSpeeds } of [
    { stage: 1, tableSpeeds: [1] },
    { stage: 5, tableSpeeds: [2.4, 2.4, 2.4] },
  ]) {
    it(`never speeds NORMAL stage ${stage}’s Wisps up, however close occupancy gets to the goal`, () => {
      const session = sessionAtStage(stage, { seed: 5, captureFeedback: true });
      expect(speeds(session)).toEqual(tableSpeeds);
      expect(session.getGame().isWispSurgeEnabled()).toBe(false);
      const { afterFirst, levelAfterFirst } = playTwoBoxes(session);
      expect(levelAfterFirst).toBe(0);
      expect(afterFirst).toEqual(tableSpeeds);
      // Within 0.10 of the goal and past half of it: still level 0.
      expect(session.getGame().getWispSurgeLevel()).toBe(0);
      expect(speeds(session)).toEqual(tableSpeeds);
      // The goal lowered to just above occupancy: level 0 all the same.
      session.applyDebugOverrides({ requiredOccupancy: session.getGame().getOccupancy() + 1e-6 });
      move(session, 0, 0, false);
      expect(session.getStatus()).toBe('playing');
      expect(session.getGame().getWispSurgeLevel()).toBe(0);
      expect(speeds(session)).toEqual(tableSpeeds);
      expect(session.drainWispSurgeFeedback()).toEqual([]);
    });
  }

  it('speeds NORMAL stage 6’s Wisps up to x1.15 and then x1.3 on the claims that cross, and stage 7 starts on level 0 and speeds up too', () => {
    // Seed 5: no Wisp comes near any strip's line on this stage 6.
    const session = sessionAtStage(6, { seed: 5, captureFeedback: true });
    expect(session.getStage()).toBe(6);
    expect(session.getGame().isWispSurgeEnabled()).toBe(true);
    // Stage 6: two Wisps at x1.6.
    expect(speeds(session)).toEqual([1.6, 1.6]);
    const { after } = playTwoStrips(session);
    expect(after.map((a) => a.level)).toEqual([1, 2]);
    expect(after.map((a) => a.speeds)).toEqual([
      [1.6 * 1.15, 1.6 * 1.15],
      [1.6 * 1.3, 1.6 * 1.3],
    ]);
    // The panel and EXPORT keep the stage's own multiplier.
    expect(session.getEffectiveDebugParams().wispSpeedMultiplier).toBe(1.6);
    expect(session.drainWispSurgeFeedback().map((n) => n.level)).toEqual([1, 2]);

    // A third strip on a goal lowered to almost nothing clears stage 6.
    session.applyDebugOverrides({ requiredOccupancy: 0.00001 });
    claimStripAt(session, 28);
    expect(session.getStatus()).toBe('stageclear');
    session.update(CONFIRM);
    expect(session.getStage()).toBe(7);
    expect(session.getGame().isWispSurgeEnabled()).toBe(true);
    expect(session.getGame().getWispSurgeLevel()).toBe(0);
    // Stage 7: four Wisps at x2.4.
    expect(speeds(session)).toEqual([2.4, 2.4, 2.4, 2.4]);
    const { levelAfterFirst } = playTwoBoxes(session);
    expect(levelAfterFirst).toBe(0);
    expect(session.getGame().getWispSurgeLevel()).toBe(2);
    expect(speeds(session)).toEqual([2.4 * 1.3, 2.4 * 1.3, 2.4 * 1.3, 2.4 * 1.3]);
  });

  it('applies on NORMAL from stage 6 on, past the table’s last row too, and on no EASY stage', () => {
    const normal = sessionAtStage(1, { seed: 5 });
    const easy = sessionAtStage(1, { seed: 5, difficulty: 'easy' });
    for (let stage = 1; stage <= 17; stage++) {
      expect(normal.getStage()).toBe(stage);
      expect(normal.getGame().isWispSurgeEnabled(), `NORMAL stage ${stage}`).toBe(stage >= 6);
      expect(easy.getStage()).toBe(stage);
      expect(easy.getGame().isWispSurgeEnabled(), `EASY stage ${stage}`).toBe(false);
      if (stage < 17) {
        for (const session of [normal, easy]) {
          clearFromStart(session);
          session.update(CONFIRM);
        }
      }
    }
  });

  it('never speeds an EASY stage’s Wisps up, on stage 6 neither', () => {
    // Seed 1: no Wisp comes near either strip's line on this EASY stage 6.
    const session = sessionAtStage(6, { seed: 1, difficulty: 'easy', captureFeedback: true });
    expect(session.getGame().isWispSurgeEnabled()).toBe(false);
    // Stage 6 on EASY: two Wisps at x1.6 times 0.7.
    expect(speeds(session)).toEqual([1.6 * 0.7, 1.6 * 0.7]);
    const { after } = playTwoStrips(session);
    expect(after.map((a) => a.level)).toEqual([0, 0]);
    expect(after.map((a) => a.speeds)).toEqual([
      [1.6 * 0.7, 1.6 * 0.7],
      [1.6 * 0.7, 1.6 * 0.7],
    ]);
    expect(session.drainWispSurgeFeedback()).toEqual([]);
  });
});
