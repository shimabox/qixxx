// The debug panel's rule overrides: big claims, close calls, the post-miss
// wait and the first Ember's wait, applied to the running play and treated
// like every other debug override (the run is tainted and no high score is
// kept).
import { describe, it, expect } from 'vitest';
import { Field } from './field';
import { Game } from './game';
import { GameSession } from './session';
import { Wisp } from './enemy';
import {
  BIG_CLAIM_MULTIPLIER,
  BIG_CLAIM_SHARE,
  EMBER_FIRST_SPAWN_SEC,
  MISS_GRACE_TICKS,
  MISS_LINE_LOCK_TICKS,
  NEAR_MISS_BONUS,
  NEAR_MISS_DISTANCE_CELLS,
  TICK_RATE,
} from '../config';

const IDLE = { dx: 0 as const, dy: 0 as const, drawHeld: false };
const DOWN = { dx: 0 as const, dy: 1 as const, drawHeld: true };

/** A 22 x 7 field (100 interior cells) with a still Wisp at the far right; the marker on top of column `column`. */
function smallGame(column: number): Game {
  return new Game(new Field(22, 7), { x: column, y: 0 }, undefined, () => 0.5, {
    wisps: [new Wisp({ x: 19, y: 3 }, () => 0.5, 0, 0)],
    requiredOccupancy: 0.99,
    captureFeedback: true,
  });
}

function drawDown(game: Game): void {
  for (let i = 0; i < 6; i++) game.update(DOWN);
}

describe('rule overrides on a Game', () => {
  it('report the config.ts values when not overridden', () => {
    const params = smallGame(3).getEffectiveDebugParams();
    expect(params).toMatchObject({
      bigClaimShare: BIG_CLAIM_SHARE,
      bigClaimMultiplier: BIG_CLAIM_MULTIPLIER,
      nearMissDistanceCells: NEAR_MISS_DISTANCE_CELLS,
      nearMissBonus: NEAR_MISS_BONUS,
      missGraceTicks: MISS_GRACE_TICKS,
      missLineLockTicks: MISS_LINE_LOCK_TICKS,
    });
  });

  it('the big-claim share and multiplier apply to the next claim', () => {
    const game = smallGame(3); // 10 cells: not big at 15%
    game.applyDebugOverrides({ bigClaimShare: 0.1, bigClaimMultiplier: 3 });
    drawDown(game);
    const [notice] = game.drainClaimFeedback();
    expect(notice.bigClaim).toBe(true);
    expect(notice.areaScore).toBe(15); // 10 * 0.5 * 3
  });

  it('the close-call distance and bonus apply to the line being drawn', () => {
    const game = smallGame(12); // 7 columns from the Wisp: no close call at 3
    game.applyDebugOverrides({ nearMissDistanceCells: 8, nearMissBonus: 50 });
    drawDown(game);
    expect(game.drainClaimFeedback()[0].nearMissBonus).toBe(50);
  });

  it('the post-miss wait applies from the next miss', () => {
    const game = new Game(new Field(40, 20), { x: 20, y: 0 }, undefined, () => 0.5, {
      wisps: [new Wisp({ x: 20, y: 2 }, () => 0.5, 0, 0)],
    });
    game.applyDebugOverrides({ missGraceTicks: 10, missLineLockTicks: 4 });
    game.update(DOWN);
    game.update(DOWN); // onto the Wisp: a miss
    expect(game.getLives()).toBe(2);
    expect(game.getGraceTicks()).toBe(10);
    expect(game.getLineLockTicks()).toBe(4);
    for (let i = 0; i < 4; i++) {
      game.update(DOWN);
      expect(game.getMarker().isDrawing()).toBe(false);
    }
    game.update(DOWN);
    expect(game.getMarker().isDrawing()).toBe(true);
  });

  it('RESET brings every rule back to config.ts', () => {
    const game = smallGame(3);
    game.applyDebugOverrides({ bigClaimShare: 0.5, nearMissBonus: 0, missGraceTicks: 1, firstEmberSec: 2 });
    expect(game.hasActiveDebugOverrides()).toBe(true);
    game.resetDebugOverrides();
    expect(game.getEffectiveDebugParams()).toMatchObject({ bigClaimShare: BIG_CLAIM_SHARE, nearMissBonus: NEAR_MISS_BONUS, missGraceTicks: MISS_GRACE_TICKS });
    expect(game.hasActiveDebugOverrides()).toBe(false);
  });
});

describe('the first Ember override', () => {
  /** Ticks after the start at which the first Ember pair of the current stage appears. */
  function firstSpawnTick(session: GameSession, limit: number): number | null {
    for (let tick = 1; tick <= limit && session.getStatus() === 'playing'; tick++) {
      session.update({ ...IDLE, confirm: false });
      if (session.drainEvents().some((e) => e === 'ember-spawned' || e === 'ember-blaze-spawned')) return tick;
    }
    return null;
  }

  it('set before a stage starts, brings that stage’s first Ember at that many seconds', () => {
    const session = new GameSession({ seed: 3 });
    expect(session.getEffectiveDebugParams().firstEmberSec).toBe(EMBER_FIRST_SPAWN_SEC);
    session.applyDebugOverrides({ firstEmberSec: 4 });
    expect(session.getEffectiveDebugParams().firstEmberSec).toBe(4);
    session.update({ ...IDLE, confirm: true }); // Title -> stage 1
    expect(firstSpawnTick(session, 10 * TICK_RATE)).toBe(4 * TICK_RATE + 1);
  });

  it('changed in the middle of a stage, applies from the next stage', () => {
    // Every stage: a split waiting to happen (a still Wisp either side of
    // the marker's column), and its first Ember after 10s of its own.
    const session = new GameSession({
      gameFactory: (_stage, carry) =>
        new Game(new Field(16, 8), { x: 8, y: 0 }, undefined, () => 0.5, {
          wisps: [new Wisp({ x: 3, y: 3 }, () => 0.5, 0, 0), new Wisp({ x: 12, y: 3 }, () => 0.5, 0, 0)],
          emberSpawnIntervalTicks: 10 * TICK_RATE,
          firstEmberSpawnTicks: 10 * TICK_RATE,
          ...carry,
        }),
    });
    session.update({ ...IDLE, confirm: true });
    session.update({ ...IDLE, confirm: false }); // stage 1 has started
    session.applyDebugOverrides({ firstEmberSec: 2 });
    expect(session.isRunTainted()).toBe(true);
    expect(session.hasActiveDebugOverrides()).toBe(true);
    // Stage 1 keeps its own 10s: nothing within 3s.
    expect(firstSpawnTick(session, 3 * TICK_RATE)).toBeNull();
    for (let i = 0; i < 7; i++) session.update({ ...DOWN, confirm: false }); // the split
    expect(session.getStatus()).toBe('stageclear');
    session.update({ ...IDLE, confirm: true }); // stage 2, built with the override
    expect(session.getStage()).toBe(2);
    expect(firstSpawnTick(session, 5 * TICK_RATE)).toBe(2 * TICK_RATE + 1);
  });

  it('reaches every stage the session builds after it is set', () => {
    let built = 0;
    const games: Game[] = [];
    const session = new GameSession({
      gameFactory: (_stage, carry) => {
        built++;
        const game = new Game(new Field(20, 10), { x: 10, y: 0 }, undefined, () => 0.5, {
          wisps: [new Wisp({ x: 15, y: 5 }, () => 0.5, 0, 0)],
          emberSpawnIntervalTicks: 600,
          firstEmberSpawnTicks: 600,
          ...carry,
        });
        games.push(game);
        return game;
      },
    });
    session.applyDebugOverrides({ firstEmberSec: 2 });
    expect(built).toBe(1);
    expect(games[0].getEffectiveDebugParams().firstEmberSec).toBe(2);
    session.update({ ...IDLE, confirm: true });
    expect(firstSpawnTick(session, 5 * TICK_RATE)).toBe(2 * TICK_RATE + 1);
  });
});
