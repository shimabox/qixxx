// Close calls in a running Game: a Wisp head within NEAR_MISS_DISTANCE_CELLS
// of the line being drawn marks it; closing a marked line into an accepted
// claim adds NEAR_MISS_BONUS x the multiplier, once; the mark goes with the
// line.
import { describe, it, expect } from 'vitest';
import { Field, Point } from './field';
import { Game, GameOptions } from './game';
import { Wisp } from './enemy';
import { Axis } from './marker';
import { NEAR_MISS_BONUS, NEAR_MISS_DISTANCE_CELLS, MISS_GRACE_TICKS } from '../config';

const WIDTH = 40;
const HEIGHT = 20;
const STILL = () => 0.5;

/** A Wisp that never moves (speed x0), so its head stays on `at`. */
function stillWisp(at: Point): Wisp {
  return new Wisp(at, STILL, 0, 0);
}

function makeGame(wispAt: Point, markerAt: Point, options: GameOptions = {}): Game {
  return new Game(new Field(WIDTH, HEIGHT), markerAt, undefined, STILL, {
    wisps: [stillWisp(wispAt)],
    requiredOccupancy: 0.99,
    captureFeedback: true,
    ...options,
  });
}

function step(game: Game, dx: Axis, dy: Axis, drawHeld: boolean, times = 1): void {
  for (let i = 0; i < times; i++) game.update({ dx, dy, drawHeld });
}

/** Draws from the top border straight down to the bottom border, closing the line. */
function drawDownAcross(game: Game): void {
  step(game, 0, 1, true, HEIGHT - 1);
  expect(game.getMarker().isDrawing()).toBe(false);
}

/** Walks along the top border to column `x`. */
function walkTopTo(game: Game, x: number): void {
  const from = game.getMarker().getPosition().x;
  step(game, x > from ? 1 : -1, 0, false, Math.abs(x - from));
  expect(game.getMarker().getPosition()).toEqual({ x, y: 0 });
}

describe('close calls', () => {
  it('uses a distance of 3 cells and a bonus of 200', () => {
    expect(NEAR_MISS_DISTANCE_CELLS).toBe(3);
    expect(NEAR_MISS_BONUS).toBe(200);
  });

  it('marks a line that passes 3 cells from a Wisp head, and adds 200 when it closes', () => {
    // Each tick looks at the line as it stands after the enemies move, before
    // the marker does: a cell drawn on one tick is looked at on the next.
    const game = makeGame({ x: 20, y: 10 }, { x: 17, y: 0 });
    step(game, 0, 1, true, 7); // the line reaches (17, 7); (17, 6) was the last looked at: 4 rows above the head
    expect(game.isLineNearMissed()).toBe(false);
    step(game, 0, 1, true, 1); // (17, 7) looked at: 3 columns left, 3 rows above — within the distance
    expect(game.isLineNearMissed()).toBe(true);
    const before = game.getScore();
    drawDownAcross(game);
    const [notice] = game.drainClaimFeedback();
    expect(notice.nearMissBonus).toBe(200);
    expect(game.getScore() - before).toBe(notice.areaScore + 200);
    expect(game.isLineNearMissed()).toBe(false);
  });

  it('does not mark a line that stays 4 cells away', () => {
    const game = makeGame({ x: 20, y: 10 }, { x: 16, y: 0 });
    drawDownAcross(game);
    const [notice] = game.drainClaimFeedback();
    expect(notice.nearMissBonus).toBe(0);
    expect(game.getScore()).toBe(notice.areaScore);
  });

  it('adds the bonus once per claim, times the multiplier', () => {
    const game = makeGame({ x: 20, y: 10 }, { x: 19, y: 0 }, { multiplier: 3 });
    drawDownAcross(game); // near the head for many ticks, right past it
    const [notice] = game.drainClaimFeedback();
    expect(notice.nearMissBonus).toBe(600);
    expect(game.getScore()).toBe(notice.areaScore + 600);
  });

  it('does not carry the mark to the next line after a claim', () => {
    const game = makeGame({ x: 20, y: 10 }, { x: 18, y: 0 });
    drawDownAcross(game);
    expect(game.drainClaimFeedback()[0].nearMissBonus).toBe(200);
    // The claim took everything left of x=18; the next line runs at x=30, far away.
    step(game, 0, -1, false, HEIGHT - 1); // back up the new border to the top
    walkTopTo(game, 30);
    const before = game.getScore();
    drawDownAcross(game);
    const [notice] = game.drainClaimFeedback();
    expect(notice.nearMissBonus).toBe(0);
    expect(game.getScore() - before).toBe(notice.areaScore);
  });

  it('drops the mark when the line is retracted back to its start', () => {
    const game = makeGame({ x: 20, y: 10 }, { x: 18, y: 0 });
    step(game, 0, 1, true, 9);
    expect(game.isLineNearMissed()).toBe(true);
    step(game, 0, -1, true, 9); // retract all the way back onto the border
    expect(game.getMarker().isDrawing()).toBe(false);
    expect(game.isLineNearMissed()).toBe(false);
    walkTopTo(game, 3);
    drawDownAcross(game);
    const [notice] = game.drainClaimFeedback();
    expect(notice.nearMissBonus).toBe(0);
    expect(game.getScore()).toBe(notice.areaScore);
  });

  it('adds nothing for a miss, and drops the mark with the line', () => {
    const game = makeGame({ x: 20, y: 10 }, { x: 20, y: 0 });
    step(game, 0, 1, true, 8);
    expect(game.isLineNearMissed()).toBe(true);
    const lives = game.getLives();
    step(game, 0, 1, true, 2); // into the Wisp's head: a miss
    expect(game.getLives()).toBe(lives - 1);
    expect(game.getMarker().isDrawing()).toBe(false);
    expect(game.isLineNearMissed()).toBe(false);
    expect(game.getScore()).toBe(0);
    expect(game.drainClaimFeedback()).toEqual([]);
    // Once lines can be drawn again, a far line is not marked.
    step(game, 0, 0, false, MISS_GRACE_TICKS);
    walkTopTo(game, 3);
    drawDownAcross(game);
    const [notice] = game.drainClaimFeedback();
    expect(notice.nearMissBonus).toBe(0);
    expect(game.getScore()).toBe(notice.areaScore);
  });

  it('adds nothing for a rejected claim, and drops the mark with the line', () => {
    // A Wisp head on the top border: harmless, and not a valid position for
    // a claim's flood fill, so every claim is rejected.
    const game = makeGame({ x: 20, y: 0 }, { x: 18, y: 0 });
    step(game, 0, 1, true, 2);
    expect(game.isLineNearMissed()).toBe(true);
    step(game, 0, 1, true, HEIGHT - 3);
    expect(game.getMarker().isDrawing()).toBe(false);
    expect(game.isLineNearMissed()).toBe(false);
    expect(game.drainClaimFeedback()).toEqual([]);
    expect(game.getScore()).toBe(0);
    expect(game.getOccupancy()).toBe(0);
  });

  it('marks a line on the marker alone: the head next to the marker counts', () => {
    // The line's only cell is the one the marker stands on.
    const game = makeGame({ x: 20, y: 4 }, { x: 20, y: 0 });
    step(game, 0, 1, true, 1);
    expect(game.getMarker().getPosition()).toEqual({ x: 20, y: 1 });
    step(game, 0, 0, true, 1); // holding still: the next tick looks
    expect(game.isLineNearMissed()).toBe(true);
  });

  it('does not change the run when the notices are off', () => {
    const run = (captureFeedback: boolean) => {
      const game = makeGame({ x: 20, y: 10 }, { x: 18, y: 0 }, { captureFeedback, multiplier: 2 });
      drawDownAcross(game);
      return game.getScore();
    };
    expect(run(false)).toBe(run(true));
  });
});
