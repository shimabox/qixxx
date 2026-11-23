// The debug panel's EXPORT JSON carries the scoring and miss rules under their
// config.ts names.
import { describe, it, expect } from 'vitest';
import { buildExportPayload } from './panel';
import { GameSession } from '../core/session';
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
