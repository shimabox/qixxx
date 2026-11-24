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
  LATE_STAGE_WISP_COUNT_MAX,
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

  it('exports the Wisps’ own speed multiplier while the surge has them moving faster, and says the surge applies on top on NORMAL from stage 6', () => {
    // Stage 6 (two Wisps); on seed 5 it starts on the left edge.
    const session = sessionAtStage(6, { seed: 5 });
    expect(session.getMarkerStart()!.edge).toBe('left');
    // A goal out of reach, then a small box straight in from the start, along
    // the edge and back out, then a goal low enough to put that occupancy
    // within the final margin.
    session.applyDebugOverrides({ requiredOccupancy: 0.99 });
    for (const [dx, dy] of [[1, 0], [1, 0], [0, 1], [0, 1], [-1, 0], [-1, 0]] as const) {
      session.update({ dx, dy, drawHeld: true, confirm: false });
    }
    expect(session.getGame().getOccupancy()).toBeGreaterThan(0);
    session.applyDebugOverrides({ requiredOccupancy: session.getGame().getOccupancy() * 1.5, wispSpeedMultiplier: 2 });
    expect(session.getStage()).toBe(6);
    expect(session.getStatus()).toBe('playing');
    expect(session.getGame().getWispSurgeLevel()).toBe(2);
    expect(session.getGame().getWisps().map((w) => w.getSpeedMultiplier())).toEqual([2.6, 2.6]);
    const payload = buildExportPayload(
      session.getEffectiveDebugParams(),
      session.getTimeLimitTicks(),
      undefined,
      undefined,
      session.getDebugOverrides(),
      session.getStage()
    ) as Record<string, unknown> & { _notes: Record<string, string> };
    expect(payload.WISP_SPEED_MULTIPLIER).toBe(2);
    const note = payload._notes.WISP_SPEED_MULTIPLIER;
    expect(note).toContain('NORMAL from stage 6 (WISP_SURGE_FIRST_STAGE) on');
    expect(note).toContain('WISP_SURGE_MULTIPLIERS');
  });

  it('exported on stage 18, has 10 Wisps and says how the count past the table is made', () => {
    const session = sessionAtStage(18, { seed: 1 });
    // Back to the stage's own values: the walk on lowered every goal.
    session.resetDebugOverrides();
    const payload = buildExportPayload(
      session.getEffectiveDebugParams(),
      session.getTimeLimitTicks(),
      undefined,
      undefined,
      session.getDebugOverrides(),
      session.getStage()
    ) as Record<string, unknown> & { _notes: Record<string, string> };
    expect(payload.STAGE).toBe(18);
    expect(payload.WISP_COUNT).toBe(10);
    expect(session.getGame().getWisps()).toHaveLength(10);
    // The note says the count is not the table's row from stage 16 on: the
    // last row's count plus one a stage, held at LATE_STAGE_WISP_COUNT_MAX.
    const note = payload._notes.WISP_COUNT;
    expect(note).toContain('STAGE_TABLE');
    expect(note).toMatch(/stage 16/);
    expect(note).toMatch(/plus one for each stage past 15/);
    expect(note).toContain('LATE_STAGE_WISP_COUNT_MAX');
    expect(note).toContain(`(${LATE_STAGE_WISP_COUNT_MAX})`);
    expect(LATE_STAGE_WISP_COUNT_MAX).toBe(10);
    expect(payload._notes.STAGE).toContain('WISP_COUNT');
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
