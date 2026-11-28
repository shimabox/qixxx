// After a miss: no new line for MISS_LINE_LOCK_TICKS, no further miss for
// MISS_GRACE_TICKS.
import { describe, it, expect } from 'vitest';
import { Field } from './field';
import { Game } from './game';
import { Wisp } from './enemy';
import { MISS_GRACE_TICKS, MISS_LINE_LOCK_TICKS } from '../config';

const DOWN = { dx: 0 as const, dy: 1 as const, drawHeld: true };
const HOLD = { dx: 0 as const, dy: 0 as const, drawHeld: true };

/**
 * A still Wisp 3 cells below the marker. Drawing straight down reaches its
 * cell on the third tick: a miss. Returns the game right after that tick.
 */
function gameAfterMiss(): Game {
  const game = new Game(new Field(40, 20), { x: 20, y: 0 }, undefined, () => 0.5, {
    wisps: [new Wisp({ x: 20, y: 3 }, () => 0.5, 0, 0)],
    requiredOccupancy: 0.99,
  });
  game.update(DOWN);
  game.update(DOWN);
  expect(game.getLives()).toBe(3);
  game.update(DOWN);
  expect(game.getLives()).toBe(2);
  expect(game.getMarker().getPosition()).toEqual({ x: 20, y: 0 });
  return game;
}

describe('after a miss', () => {
  it('uses a 60-tick grace and a 30-tick line lock', () => {
    expect(MISS_GRACE_TICKS).toBe(60);
    expect(MISS_LINE_LOCK_TICKS).toBe(30);
  });

  it('cannot start a line for the 30 ticks after it, and can on the next', () => {
    const game = gameAfterMiss();
    for (let k = 1; k <= MISS_LINE_LOCK_TICKS; k++) {
      game.update(DOWN);
      expect(game.getMarker().isDrawing(), `tick ${k}`).toBe(false);
      expect(game.getMarker().getPosition()).toEqual({ x: 20, y: 0 });
    }
    game.update(DOWN); // tick 31
    expect(game.getMarker().isDrawing()).toBe(true);
    expect(game.getMarker().getPosition()).toEqual({ x: 20, y: 1 });
  });

  it('can still move along the border while lines are locked', () => {
    const game = gameAfterMiss();
    game.update({ dx: 1, dy: 0, drawHeld: false });
    expect(game.getMarker().getPosition()).toEqual({ x: 21, y: 0 });
  });

  it('cannot miss for the 60 ticks after it, and can on the next', () => {
    const game = gameAfterMiss();
    for (let k = 1; k <= MISS_LINE_LOCK_TICKS; k++) game.update(DOWN);
    game.update(DOWN); // 31: (20, 1)
    game.update(DOWN); // 32: (20, 2)
    game.update(DOWN); // 33: onto the Wisp's cell — still protected
    expect(game.getMarker().getPosition()).toEqual({ x: 20, y: 3 });
    for (let k = 34; k <= MISS_GRACE_TICKS; k++) {
      game.update(HOLD); // the Wisp sits on the line all along
      expect(game.getLives(), `tick ${k}`).toBe(2);
    }
    game.update(HOLD); // tick 61: the grace is over
    expect(game.getLives()).toBe(1);
  });

  it('marks a line drawn during the grace as a close call, like any other', () => {
    const game = gameAfterMiss();
    for (let k = 1; k <= MISS_LINE_LOCK_TICKS; k++) game.update(DOWN);
    expect(game.getGraceTicks()).toBeGreaterThan(0);
    game.update(DOWN); // 31: the line starts, 2 cells above the Wisp
    game.update(HOLD); // 32: looked at
    expect(game.getGraceTicks()).toBeGreaterThan(0);
    expect(game.isLineNearMissed()).toBe(true);
  });
});
