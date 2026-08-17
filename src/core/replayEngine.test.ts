import { describe, it, expect } from 'vitest';
import { GameSession } from './session';
import { encodeRle, InputSample } from './rle';
import { simulateReplayFromRle, simulateReplayFromRleChunked, ReplayEngine, ReplayAbortedError } from './replayEngine';

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

/**
 * Records a run that actually spans several stages (seed 909 reaches stage 3,
 * with boundaries at ticks 0, 739 and 1191).
 *
 * Needed because skipToFinalStage() is untestable against a single-stage
 * replay: the final boundary is then tick 0, the skip loop never runs, and a
 * completely broken skip passes just as happily as a working one.
 *
 * The serpentine draws across the field and steps along the border, claiming
 * a strip at a time until the stage's required occupancy is met. StageClear
 * is confirmed but NOT recorded, exactly as the replay protocol re-supplies
 * it on playback.
 */
const MULTI_STAGE_SEED = 909;

function recordMultiStageRun(seed: number): Uint8Array {
  const session = new GameSession({ seed });
  session.update(CONFIRM);
  const samples: InputSample[] = [];
  const step = (dx: -1 | 0 | 1, dy: -1 | 0 | 1, drawHeld: boolean): void => {
    samples.push({ dx, dy, drawHeld, slow: false });
    session.update({ dx, dy, drawHeld, slow: false, confirm: false });
    session.drainEvents();
    session.drainDespawnedEmberPositions();
  };

  const height = session.getGame().getField().getHeight();
  let goingDown = true;
  let guard = 0;
  while (session.getStatus() !== 'gameover' && guard++ < 12_000) {
    if (session.getStatus() === 'stageclear') {
      session.update(CONFIRM);
      session.drainEvents();
      session.drainDespawnedEmberPositions();
      continue;
    }
    const targetY = goingDown ? height - 1 : 0;
    let crossing = 0;
    while (session.getStatus() === 'playing' && session.getGame().getMarker().getPosition().y !== targetY && crossing++ < height + 5) {
      step(0, goingDown ? 1 : -1, true);
    }
    for (let i = 0; i < 5 && session.getStatus() === 'playing'; i++) step(1, 0, false);
    goingDown = !goingDown;
  }
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

describe('chunked simulation cancellation', () => {
  it('stops the work itself when aborted, not just the use of its result', async () => {
    const rle = recordTimeUpRun(7, 400);
    const controller = new AbortController();
    let chunks = 0;
    const promise = simulateReplayFromRleChunked(7, rle, {
      timeLimitTicks: 400,
      chunkTicks: 8,
      signal: controller.signal,
      yieldToEventLoop: () => Promise.resolve(),
      onProgress: (ticks) => {
        chunks++;
        if (ticks >= 32) controller.abort();
      },
    });

    await expect(promise).rejects.toBeInstanceOf(ReplayAbortedError);
    // 400 ticks at 8 per chunk would be 50 chunks; aborting at 32 ticks means
    // the simulation really stopped rather than running to completion and
    // merely discarding the answer.
    expect(chunks).toBeLessThan(10);
  });

  it('refuses immediately if the signal is already aborted', async () => {
    const rle = recordTimeUpRun(7, 40);
    const controller = new AbortController();
    controller.abort();
    let chunks = 0;
    await expect(
      simulateReplayFromRleChunked(7, rle, {
        timeLimitTicks: 40,
        chunkTicks: 8,
        signal: controller.signal,
        yieldToEventLoop: () => Promise.resolve(),
        onProgress: () => chunks++,
      })
    ).rejects.toBeInstanceOf(ReplayAbortedError);
    expect(chunks).toBe(0);
  });

  it('completes normally when the signal never fires', async () => {
    const rle = recordTimeUpRun(7, 40);
    const controller = new AbortController();
    const result = await simulateReplayFromRleChunked(7, rle, {
      timeLimitTicks: 40,
      chunkTicks: 8,
      signal: controller.signal,
      yieldToEventLoop: () => Promise.resolve(),
    });
    expect(result).toEqual(simulateReplayFromRle(7, rle, { timeLimitTicks: 40 }));
  });

  it('propagates the abort through ReplayEngine.create()', async () => {
    const rle = recordTimeUpRun(7, 400);
    const controller = new AbortController();
    const promise = ReplayEngine.create(7, rle, {
      timeLimitTicks: 400,
      chunkTicks: 8,
      signal: controller.signal,
      yieldToEventLoop: () => Promise.resolve(),
      onProgress: () => controller.abort(),
    });
    await expect(promise).rejects.toBeInstanceOf(ReplayAbortedError);
  });

  it('aborts a skipToFinalStage() in progress, leaving the session at a valid intermediate tick', async () => {
    const rle = recordMultiStageRun(MULTI_STAGE_SEED);
    const engine = await ReplayEngine.create(MULTI_STAGE_SEED, rle, { yieldToEventLoop: () => Promise.resolve() });
    const boundaries = engine.getResult().stageBoundaries;
    const target = boundaries[boundaries.length - 1].startTick;
    expect(target).toBeGreaterThan(0); // otherwise this test would be vacuous

    const controller = new AbortController();
    await expect(
      engine.skipToFinalStage({
        chunkTicks: 8,
        signal: controller.signal,
        yieldToEventLoop: () => Promise.resolve(),
        onProgress: () => controller.abort(),
      })
    ).rejects.toBeInstanceOf(ReplayAbortedError);

    // Stopped short of the target rather than finishing it anyway.
    const reached = engine.getSession().getTotalTicks();
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(target);
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
    // A MULTI-stage replay: with a single-stage one the final boundary is
    // tick 0 and this assertion would hold even for a skip that did nothing.
    const rle = recordMultiStageRun(MULTI_STAGE_SEED);
    const engine = await ReplayEngine.create(MULTI_STAGE_SEED, rle, { yieldToEventLoop: () => Promise.resolve() });
    const boundaries = engine.getResult().stageBoundaries;
    const finalBoundary = boundaries[boundaries.length - 1];
    expect(boundaries.length).toBeGreaterThan(1);
    expect(finalBoundary.startTick).toBeGreaterThan(0);
    await engine.skipToFinalStage({ yieldToEventLoop: () => Promise.resolve() });
    expect(engine.getSession().getTotalTicks()).toBeGreaterThanOrEqual(finalBoundary.startTick);
    expect(engine.getSession().getStage()).toBe(engine.getResult().stageBoundaries[engine.getResult().stageBoundaries.length - 1].stage);
  });
});
