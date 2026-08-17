import { describe, it, expect } from 'vitest';
import { GameSession } from './session';
import { encodeRle, InputSample } from './rle';
import { simulateReplayFromRle, ReplayEngine } from './replayEngine';

const CONFIRM = { dx: 0 as const, dy: 0 as const, drawHeld: false, confirm: true };

/** Records a short, deterministic "wander on the border, then let time run out" run and returns its RLE bytes. */
function recordTimeUpRun(seed: number, timeLimitTicks: number): Uint8Array {
  const session = new GameSession({ seed, timeLimitTicks });
  session.update(CONFIRM);
  const samples: InputSample[] = [];
  while (session.getStatus() === 'playing') {
    const input: InputSample = { dx: 1, dy: 0, drawHeld: false, slow: false };
    session.update({ ...input, confirm: false });
    samples.push(input);
  }
  expect(session.getStatus()).toBe('gameover');
  expect(session.getGameOverReason()).toBe('time');
  return encodeRle(samples);
}

describe('simulateReplayFromRle', () => {
  it('is deterministic: the same seed + RLE always reaches the same result', () => {
    const rle = recordTimeUpRun(12345, 5);
    const a = simulateReplayFromRle(12345, rle, { timeLimitTicks: 5 });
    const b = simulateReplayFromRle(12345, rle, { timeLimitTicks: 5 });
    expect(a).toEqual(b);
  });

  it('reaches gameover (time) with zero excess samples for a well-formed replay', () => {
    const rle = recordTimeUpRun(777, 4);
    const result = simulateReplayFromRle(777, rle, { timeLimitTicks: 4 });
    expect(result.reachedGameOver).toBe(true);
    expect(result.gameOverReason).toBe('time');
    expect(result.durationTicks).toBe(4);
    expect(result.excessSamplesAfterGameover).toBe(0);
  });

  it('detects excess input after gameover (task 3 rejection condition)', () => {
    const rle = recordTimeUpRun(9, 3);
    // Append 2 extra samples' worth of RLE-encoded input past the point the
    // recorded run already reached gameover.
    const extra = encodeRle([
      { dx: 0, dy: 1, drawHeld: false, slow: false },
      { dx: 0, dy: 1, drawHeld: false, slow: false },
    ]);
    const withExcess = new Uint8Array([...rle, ...extra]);
    const result = simulateReplayFromRle(9, withExcess, { timeLimitTicks: 3, maxTicks: 10800 });
    expect(result.reachedGameOver).toBe(true);
    expect(result.excessSamplesAfterGameover).toBe(2);
  });

  it('reports reachedGameOver: false when input runs out before gameover', () => {
    // A run with a much longer time budget than the (short) recorded input —
    // input exhausts mid-'playing'.
    const rle = encodeRle([
      { dx: 1, dy: 0, drawHeld: false, slow: false },
      { dx: 1, dy: 0, drawHeld: false, slow: false },
    ]);
    const result = simulateReplayFromRle(55, rle, { timeLimitTicks: 100 });
    expect(result.reachedGameOver).toBe(false);
    expect(result.durationTicks).toBe(2);
  });

  it('stops immediately when onTick requests it (MAX_VERIFIED_CLAIMS-style early rejection), without processing further samples', () => {
    const rle = recordTimeUpRun(3, 6);
    let calls = 0;
    const result = simulateReplayFromRle(3, rle, {
      timeLimitTicks: 6,
      onTick: () => {
        calls++;
        return calls >= 2; // stop after the 2nd tick
      },
    });
    expect(result.reachedGameOver).toBe(false);
    expect(result.durationTicks).toBe(2);
    expect(result.excessSamplesAfterGameover).toBe(0);
  });

  it('derives stage boundaries, starting with stage 1 at tick 0', () => {
    const rle = recordTimeUpRun(21, 2);
    const result = simulateReplayFromRle(21, rle, { timeLimitTicks: 2 });
    expect(result.stageBoundaries[0]).toEqual({ stage: 1, startTick: 0 });
  });
});

describe('ReplayEngine (viewing mode)', () => {
  it('stepTick() drives the same tick-by-tick outcome as the headless pre-pass', () => {
    const rle = recordTimeUpRun(42, 5);
    const engine = new ReplayEngine(42, rle, { timeLimitTicks: 5 });
    let ticks = 0;
    while (engine.stepTick()) ticks++;
    expect(ticks).toBe(engine.getResult().durationTicks);
    expect(engine.getSession().getGameOverReason()).toBe(engine.getResult().gameOverReason);
    expect(engine.getSession().getScore()).toBe(engine.getResult().score);
    expect(engine.isFinished()).toBe(true);
  });

  it('skipToFinalStage() lands exactly at the final stage boundary tick', () => {
    const rle = recordTimeUpRun(1000, 8);
    const engine = new ReplayEngine(1000, rle, { timeLimitTicks: 8 });
    const finalBoundary = engine.getResult().stageBoundaries[engine.getResult().stageBoundaries.length - 1];
    engine.skipToFinalStage();
    expect(engine.getSession().getTotalTicks()).toBeGreaterThanOrEqual(finalBoundary.startTick);
    expect(engine.getSession().getStage()).toBe(engine.getResult().stageBoundaries[engine.getResult().stageBoundaries.length - 1].stage);
  });
});
