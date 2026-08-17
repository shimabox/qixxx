import { describe, it, expect } from 'vitest';
import { GameSession } from './session';
import { encodeRle, InputSample } from './rle';
import { simulateReplayFromRle, simulateReplayFromRleChunked, ReplayEngine } from './replayEngine';

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

describe('chunked simulation (viewer responsiveness)', () => {
  it('produces exactly the same result as the synchronous driver', async () => {
    const rle = recordTimeUpRun(7, 40);
    const sync = simulateReplayFromRle(7, rle, { timeLimitTicks: 40 });
    const chunked = await simulateReplayFromRleChunked(7, rle, {
      timeLimitTicks: 40,
      chunkTicks: 8,
      yieldToEventLoop: () => Promise.resolve(),
    });
    expect(chunked).toEqual(sync);
  });

  it('actually yields between chunks rather than running straight through', async () => {
    const rle = recordTimeUpRun(7, 40);
    let yields = 0;
    const progress: number[] = [];
    await simulateReplayFromRleChunked(7, rle, {
      timeLimitTicks: 40,
      chunkTicks: 8,
      yieldToEventLoop: () => {
        yields++;
        return Promise.resolve();
      },
      onProgress: (ticks) => progress.push(ticks),
    });
    // 40 ticks at 8 per chunk: several hand-backs to the event loop, each
    // reporting a strictly increasing tick count.
    expect(yields).toBeGreaterThanOrEqual(4);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress[0]).toBe(8);
  });

  it('lets other work interleave while the pre-pass runs (the whole point on a phone)', async () => {
    const rle = recordTimeUpRun(7, 40);
    const order: string[] = [];
    const done = simulateReplayFromRleChunked(7, rle, {
      timeLimitTicks: 40,
      chunkTicks: 8,
      yieldToEventLoop: () => new Promise((resolve) => setTimeout(resolve, 0)),
      onProgress: () => order.push('chunk'),
    });
    // Queued after the first chunk's yield — a synchronous pre-pass could
    // never let this run before the simulation finished.
    setTimeout(() => order.push('interleaved'), 0);
    await done;
    expect(order).toContain('interleaved');
    expect(order.indexOf('interleaved')).toBeLessThan(order.length - 1);
  });

  it('never yields when driven synchronously (the server path pays nothing)', () => {
    // simulateReplayFromRle() drives the same generator with an infinite
    // chunk size; if that ever regressed, this would loop-yield instead.
    const rle = recordTimeUpRun(7, 40);
    const result = simulateReplayFromRle(7, rle, { timeLimitTicks: 40 });
    expect(result.durationTicks).toBe(40);
  });
});

describe('ReplayEngine (viewing mode)', () => {
  it('stepTick() drives the same tick-by-tick outcome as the headless pre-pass', async () => {
    const rle = recordTimeUpRun(42, 5);
    const engine = await ReplayEngine.create(42, rle, { timeLimitTicks: 5 });
    let ticks = 0;
    while (engine.stepTick()) ticks++;
    expect(ticks).toBe(engine.getResult().durationTicks);
    expect(engine.getSession().getGameOverReason()).toBe(engine.getResult().gameOverReason);
    expect(engine.getSession().getScore()).toBe(engine.getResult().score);
    expect(engine.isFinished()).toBe(true);
  });

  it('skipToFinalStage() lands exactly at the final stage boundary tick', async () => {
    const rle = recordTimeUpRun(1000, 8);
    const engine = await ReplayEngine.create(1000, rle, { timeLimitTicks: 8 });
    const finalBoundary = engine.getResult().stageBoundaries[engine.getResult().stageBoundaries.length - 1];
    await engine.skipToFinalStage();
    expect(engine.getSession().getTotalTicks()).toBeGreaterThanOrEqual(finalBoundary.startTick);
    expect(engine.getSession().getStage()).toBe(engine.getResult().stageBoundaries[engine.getResult().stageBoundaries.length - 1].stage);
  });
});
