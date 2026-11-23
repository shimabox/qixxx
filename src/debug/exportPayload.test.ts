// The debug panel's EXPORT JSON carries the scoring and miss rules under their
// config.ts names.
import { describe, it, expect } from 'vitest';
import { buildExportPayload } from './panel';
import { GameSession } from '../core/session';
import { sessionAtStage } from '../core/stageStartFixture';
import { getStageConfig } from '../core/stage';
import {
  BIG_CLAIM_MULTIPLIER,
  BIG_CLAIM_SHARE,
  EMBER_FIRST_SPAWN_SEC,
  GAMEOVER_COUNT_TICKS,
  MISS_GRACE_TICKS,
  MISS_LINE_LOCK_TICKS,
  NEAR_MISS_BONUS,
  NEAR_MISS_DISTANCE_CELLS,
  RANKING_OFFER_DELAY_TICKS,
  TICK_RATE,
} from '../config';
import { createDefaultFxParams } from '../fx/params';

describe('EXPORT', () => {
  it('names the rules as config.ts does, with their values in effect', () => {
    const session = new GameSession({ seed: 1 });
    const plain = buildExportPayload(session.getEffectiveDebugParams(), session.getTimeLimitTicks(), undefined, undefined, session.getDebugOverrides());
    expect(plain).toMatchObject({
      BIG_CLAIM_SHARE,
      BIG_CLAIM_MULTIPLIER,
      NEAR_MISS_DISTANCE_CELLS,
      NEAR_MISS_BONUS,
      MISS_GRACE_TICKS,
      MISS_LINE_LOCK_TICKS,
      EMBER_FIRST_SPAWN_SEC,
    });

    session.applyDebugOverrides({
      bigClaimShare: 0.2,
      bigClaimMultiplier: 2,
      nearMissDistanceCells: 5,
      nearMissBonus: 300,
      missGraceTicks: 90,
      missLineLockTicks: 10,
      firstEmberSec: 8,
    });
    const tuned = buildExportPayload(session.getEffectiveDebugParams(), session.getTimeLimitTicks(), undefined, undefined, session.getDebugOverrides());
    expect(tuned).toMatchObject({
      BIG_CLAIM_SHARE: 0.2,
      BIG_CLAIM_MULTIPLIER: 2,
      NEAR_MISS_DISTANCE_CELLS: 5,
      NEAR_MISS_BONUS: 300,
      MISS_GRACE_TICKS: 90,
      MISS_LINE_LOCK_TICKS: 10,
      EMBER_FIRST_SPAWN_SEC: 8,
    });
    // A run tuned this way keeps no high score and is not ranked.
    expect(session.hasActiveDebugOverrides()).toBe(true);
    expect(session.isRunTainted()).toBe(true);
  });

  it('says which stage the values were exported on, leaving every other item as it is', () => {
    const exportOf = (session: GameSession, stage?: number) =>
      buildExportPayload(session.getEffectiveDebugParams(), session.getTimeLimitTicks(), undefined, undefined, session.getDebugOverrides(), stage);

    const first = new GameSession({ seed: 1 });
    first.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    const onStage1 = exportOf(first, first.getStage());
    expect(onStage1.STAGE).toBe(1);
    // Without a stage the payload is the one EXPORT gave before, item for item.
    const { STAGE: stageItem, _notes: notesWithStage, ...rest } = onStage1 as Record<string, unknown> & { _notes: Record<string, string> };
    expect(stageItem).toBe(1);
    const withoutStage = exportOf(first) as Record<string, unknown> & { _notes: Record<string, string> };
    expect(withoutStage).not.toHaveProperty('STAGE');
    const { _notes: notesWithoutStage, ...restWithoutStage } = withoutStage;
    expect(rest).toEqual(restWithoutStage);
    const { STAGE: stageNote, ...otherNotes } = notesWithStage;
    expect(typeof stageNote).toBe('string');
    expect(otherNotes).toEqual(notesWithoutStage);

    const third = sessionAtStage(3, { seed: 1 });
    const onStage3 = exportOf(third, third.getStage());
    expect(onStage3.STAGE).toBe(3);
    expect(onStage3.WISP_COUNT).toBe(getStageConfig(3).wispCount);
    expect(onStage3.WISP_SPEED_MULTIPLIER).toBe(getStageConfig(3).wispSpeedMultiplier);
  });

  it("says which items are the stage's own values and that EMBER_FIRST_SPAWN_SEC stays stage 1's", () => {
    const exportOf = (session: GameSession) =>
      buildExportPayload(
        session.getEffectiveDebugParams(),
        session.getTimeLimitTicks(),
        undefined,
        undefined,
        session.getDebugOverrides(),
        session.getStage()
      ) as Record<string, unknown> & { _notes: Record<string, string> };

    const second = sessionAtStage(2, { seed: 1 });
    const stage2 = getStageConfig(2);
    const onStage2 = exportOf(second);
    expect(onStage2.STAGE).toBe(2);
    // These are stage 2's own values.
    expect(onStage2.WISP_COUNT).toBe(stage2.wispCount);
    expect(onStage2.WISP_SPEED_MULTIPLIER).toBe(stage2.wispSpeedMultiplier);
    expect(onStage2.EMBER_MOVE_TICKS).toBe(stage2.emberMoveTicks);
    expect(onStage2.EMBER_SPAWN_INTERVAL_SEC).toBe(stage2.emberSpawnIntervalTicks / TICK_RATE);
    expect(onStage2.EMBER_BRANCH_CHASE_PROBABILITY).toBeCloseTo(stage2.emberBranchChaseProbability, 10);
    // Stage 2 waits longer for its first pair than stage 1, yet the item is
    // stage 1's wait: the firstEmberSec slider was never touched.
    expect(second.getDebugOverrides().firstEmberSec).toBeUndefined();
    expect(stage2.firstEmberSpawnTicks / TICK_RATE).toBe(18);
    expect(onStage2.EMBER_FIRST_SPAWN_SEC).toBe(EMBER_FIRST_SPAWN_SEC);
    expect(EMBER_FIRST_SPAWN_SEC).toBe(15);

    // The STAGE note names each of the stage's own items, and only those, as
    // this stage's, and says EMBER_FIRST_SPAWN_SEC is stage 1's.
    const note = onStage2._notes.STAGE;
    const [ownPart, firstSpawnPart] = note.split('EMBER_FIRST_SPAWN_SEC');
    for (const key of [
      'WISP_COUNT',
      'WISP_SPEED_MULTIPLIER',
      'EMBER_MOVE_TICKS',
      'EMBER_SPAWN_INTERVAL_SEC',
      'EMBER_BRANCH_CHASE_PROBABILITY',
      'DEFAULT_REQUIRED_OCCUPANCY',
      'EMBER_COUNT',
    ]) {
      expect(ownPart).toContain(key);
    }
    expect(note).not.toContain('EMBER_*');
    expect(firstSpawnPart).toMatch(/stage 1's/);
    expect(firstSpawnPart).toMatch(/override/);

    // Overridden, the item is the override on every stage.
    second.applyDebugOverrides({ firstEmberSec: 8 });
    expect(exportOf(second).EMBER_FIRST_SPAWN_SEC).toBe(8);
  });

  it('carries the GAME OVER ranking panel delay with the other GAME OVER effect timings', () => {
    const session = new GameSession({ seed: 1 });
    const fx = createDefaultFxParams();
    const plain = buildExportPayload(session.getEffectiveDebugParams(), session.getTimeLimitTicks(), fx);
    expect(plain).toMatchObject({ GAMEOVER_COUNT_TICKS, RANKING_OFFER_DELAY_TICKS });
    fx.rankingOfferDelayTicks = 30;
    expect(buildExportPayload(session.getEffectiveDebugParams(), session.getTimeLimitTicks(), fx)).toMatchObject({
      RANKING_OFFER_DELAY_TICKS: 30,
    });
    // An effect timing: the run stays untainted.
    expect(session.isRunTainted()).toBe(false);
  });
});
