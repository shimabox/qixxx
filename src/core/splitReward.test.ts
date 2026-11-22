// What a split adds to the next stage's multiplier: the Wisp count of the
// smaller side (at least 1), capped at SPLIT_MULTIPLIER_CAP, back to x1 on
// any miss.
import { describe, it, expect } from 'vitest';
import { Field, Point } from './field';
import { Game } from './game';
import { GameSession } from './session';
import { Wisp } from './enemy';
import { claimArea } from './claim';
import { SPLIT_MULTIPLIER_CAP } from '../config';

// 16 x 8: the line runs down column 8 from the top border to the bottom one.
const WIDTH = 16;
const HEIGHT = 8;
const LINE_X = 8;

/** `left` Wisps left of the line and `right` right of it, none of them moving. */
function wispPositions(left: number, right: number, leftFirst = true): Point[] {
  const at = (side: 'l' | 'r', i: number): Point => ({ x: side === 'l' ? 2 + (i % 4) : 11 + (i % 4), y: 2 + Math.floor(i / 4) });
  const l = Array.from({ length: left }, (_, i) => at('l', i));
  const r = Array.from({ length: right }, (_, i) => at('r', i));
  return leftFirst ? [...l, ...r] : [...r, ...l];
}

function splitGame(positions: Point[], carry: { score: number; lives: number; multiplier: number }): Game {
  return new Game(new Field(WIDTH, HEIGHT), { x: LINE_X, y: 0 }, undefined, () => 0.5, {
    wisps: positions.map((p) => new Wisp(p, () => 0.5, 0, 0)),
    score: carry.score,
    lives: carry.lives,
    multiplier: carry.multiplier,
    captureFeedback: true,
  });
}

function drawSplitLine(update: () => void): void {
  for (let i = 0; i < HEIGHT - 1; i++) update();
}

function splitGainOf(positions: Point[]): { gain: number; noticeGain: number } {
  const game = splitGame(positions, { score: 0, lives: 3, multiplier: 1 });
  drawSplitLine(() => game.update({ dx: 0, dy: 1, drawHeld: true }));
  expect(game.getStatus()).toBe('stageclear');
  expect(game.getLastClearWasSplit()).toBe(true);
  const [notice] = game.drainClaimFeedback();
  expect(notice.split).toBe(true);
  return { gain: game.getLastSplitMultiplierGain(), noticeGain: notice.splitMultiplierGain };
}

describe('claimArea counts the Wisps on each side of a split', () => {
  it('the side of the first valid position and every other side', () => {
    const field = new Field(WIDTH, HEIGHT);
    const line = Array.from({ length: HEIGHT - 2 }, (_, i) => ({ x: LINE_X, y: i + 1 }));
    for (const p of line) field.set(p, 4);
    const result = claimArea(field, line, [{ x: 0, y: 0 }, ...wispPositions(1, 3)], 'fast');
    // The first position is on the border, so not valid: the anchor is the left Wisp.
    expect(result).toMatchObject({ accepted: true, split: true, anchorSideEnemies: 1, otherSideEnemies: 3 });
  });

  it('counts nothing on the other side when there is no split', () => {
    const field = new Field(WIDTH, HEIGHT);
    const line = Array.from({ length: HEIGHT - 2 }, (_, i) => ({ x: LINE_X, y: i + 1 }));
    for (const p of line) field.set(p, 4);
    const result = claimArea(field, line, wispPositions(0, 3), 'fast');
    expect(result).toMatchObject({ accepted: true, split: false, anchorSideEnemies: 3, otherSideEnemies: 0 });
  });
});

describe('the multiplier a split adds', () => {
  it.each([
    [1, 1, 1],
    [2, 2, 2],
    [1, 3, 1],
    [3, 1, 1],
    [3, 3, 3],
    [4, 4, 4],
    [2, 6, 2],
  ])('%i Wisps against %i adds %i', (left, right, expected) => {
    expect(splitGainOf(wispPositions(left, right))).toEqual({ gain: expected, noticeGain: expected });
    // Whichever side the first Wisp is on.
    expect(splitGainOf(wispPositions(left, right, false))).toEqual({ gain: expected, noticeGain: expected });
  });

  it('is 0 on a claim that is not a split', () => {
    const game = splitGame(wispPositions(0, 2), { score: 0, lives: 3, multiplier: 1 });
    drawSplitLine(() => game.update({ dx: 0, dy: 1, drawHeld: true }));
    const [notice] = game.drainClaimFeedback();
    expect(notice.split).toBe(false);
    expect(notice.splitMultiplierGain).toBe(0);
    expect(game.getLastSplitMultiplierGain()).toBe(0);
  });
});

describe('the multiplier across stages', () => {
  /** A session whose every stage is the split game with these Wisps. */
  function sessionOf(stages: Point[][]): GameSession {
    const session = new GameSession({ gameFactory: (stage, carry) => splitGame(stages[Math.min(stage, stages.length) - 1], carry) });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    return session;
  }

  function clearStage(session: GameSession): void {
    drawSplitLine(() => session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false }));
    expect(session.getStatus()).toBe('stageclear');
  }

  it('adds each split to the next stage: 2 vs 2 (+2) then 3 vs 3 (+3) is x6', () => {
    const session = sessionOf([wispPositions(2, 2), wispPositions(3, 3)]);
    clearStage(session);
    expect(session.getMultiplier()).toBe(3);
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    expect(session.getGame().getMultiplier()).toBe(3);
    clearStage(session);
    expect(session.getMultiplier()).toBe(6);
  });

  it(`never goes past x${SPLIT_MULTIPLIER_CAP}`, () => {
    const session = sessionOf([wispPositions(4, 4)]);
    clearStage(session); // x5
    expect(session.getMultiplier()).toBe(5);
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    clearStage(session); // 5 + 4 = 9
    expect(session.getMultiplier()).toBe(9);
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    clearStage(session); // still 9
    expect(session.getMultiplier()).toBe(SPLIT_MULTIPLIER_CAP);
  });

  it('goes back to x1 on a miss', () => {
    // Stage 2: a Wisp right below the marker, so the first step down is a miss.
    const missStage = [{ x: LINE_X, y: 2 }, ...wispPositions(1, 1)];
    const session = sessionOf([wispPositions(3, 3), missStage]);
    clearStage(session);
    expect(session.getMultiplier()).toBe(4);
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    const lives = session.getLives();
    session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false });
    session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false });
    expect(session.getLives()).toBe(lives - 1);
    expect(session.getMultiplier()).toBe(1);
  });
});
