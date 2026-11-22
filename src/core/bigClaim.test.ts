// Big claims in a running Game: one claim of at least BIG_CLAIM_SHARE of the
// field scores its area points x BIG_CLAIM_MULTIPLIER, truncated once.
import { describe, it, expect } from 'vitest';
import { Field } from './field';
import { Game, GameOptions } from './game';
import { Wisp } from './enemy';

// 22 x 7: the interior is 20 x 5 = 100 cells, so N cells is N%. A straight
// line down column k claims the (k - 1) x 5 cells left of it.
const WIDTH = 22;
const HEIGHT = 7;

function claimLeftOf(column: number, options: GameOptions = {}, slow = false): { game: Game; gained: number } {
  const field = new Field(WIDTH, HEIGHT);
  expect(field.getClaimableCellCount()).toBe(100);
  // A Wisp bouncing straight up and down at the far right, out of the way.
  const wisp = new Wisp({ x: 19, y: 3 }, () => 0.5, Math.PI / 2);
  const game = new Game(field, { x: column, y: 0 }, wisp, () => 0.5, {
    requiredOccupancy: 0.99,
    captureFeedback: true,
    ...options,
  });
  const before = game.getScore();
  for (let i = 0; i < HEIGHT - 1; i++) {
    game.update({ dx: 0, dy: 1, drawHeld: true, slow });
    if (slow) game.update({ dx: 0, dy: 1, drawHeld: true, slow });
  }
  return { game, gained: game.getScore() - before };
}

describe('big claims in a Game', () => {
  it('below the threshold: 10 cells (10%) score 10 x 0.5 = 5', () => {
    const { game, gained } = claimLeftOf(3);
    const [notice] = game.drainClaimFeedback();
    expect(notice.claimedCells).toBe(10);
    expect(notice.bigClaim).toBe(false);
    expect(gained).toBe(5);
    expect(notice.areaScore).toBe(5);
  });

  it('exactly at the threshold: 15 cells (15%) count, floor(15 x 0.5 x 1.5) = 11', () => {
    const { game, gained } = claimLeftOf(4);
    const [notice] = game.drainClaimFeedback();
    expect(notice.claimedCells).toBe(15);
    expect(notice.bigClaim).toBe(true);
    expect(gained).toBe(11);
    expect(notice.areaScore).toBe(11);
  });

  it('above the threshold: 20 cells, floor(20 x 0.5 x 1.5) = 15', () => {
    const { game, gained } = claimLeftOf(5);
    const [notice] = game.drainClaimFeedback();
    expect(notice.claimedCells).toBe(20);
    expect(notice.bigClaim).toBe(true);
    expect(gained).toBe(15);
  });

  it('a slow line: 15 cells, floor(15 x 1.0 x 1.5) = 22', () => {
    const { game, gained } = claimLeftOf(4, {}, true);
    const [notice] = game.drainClaimFeedback();
    expect(notice.lineSpeed).toBe('slow');
    expect(notice.bigClaim).toBe(true);
    expect(gained).toBe(22);
  });

  it('with a multiplier: 15 cells at x2, floor(15 x 0.5 x 2 x 1.5) = 22; at x3 floor(33.75) = 33', () => {
    expect(claimLeftOf(4, { multiplier: 2 }).gained).toBe(22);
    expect(claimLeftOf(4, { multiplier: 3 }).gained).toBe(33);
    // Below the threshold the multiplier alone applies: 10 x 0.5 x 3 = 15.
    expect(claimLeftOf(3, { multiplier: 3 }).gained).toBe(15);
  });

  it('keeps the score an integer, and scores the same with or without the notices', () => {
    for (let column = 2; column <= 8; column++) {
      for (const multiplier of [1, 2, 3]) {
        for (const slow of [false, true]) {
          const captured = claimLeftOf(column, { multiplier }, slow);
          const plain = claimLeftOf(column, { multiplier, captureFeedback: false }, slow);
          expect(Number.isInteger(captured.game.getScore())).toBe(true);
          expect(plain.game.getScore()).toBe(captured.game.getScore());
        }
      }
    }
  });
});
