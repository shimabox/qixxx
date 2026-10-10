import { describe, it, expect } from 'vitest';
import { GameSession } from './core/session';
import { encodeRle, InputSample } from './core/rle';
import { ReplayEngine } from './core/replayEngine';
import { REPLAY_STAGE_CLEAR_HOLD_SECONDS, REPLAY_STAGE_CLEAR_HOLD_TICKS, TICK_RATE } from './config';
import { ReplayStageClearHold } from './replayStageClearHold';

const HOLD_TICKS = REPLAY_STAGE_CLEAR_HOLD_TICKS;

const STAGE_CLEAR = { status: 'stageclear' as const, finished: false };
const PLAYING = { status: 'playing' as const, finished: false };

/** How many consecutive ticks `hold` withholds stepTick() for, starting now. */
function countHeldTicks(hold: ReplayStageClearHold, limit = HOLD_TICKS * 3): number {
  let held = 0;
  while (held < limit && hold.shouldHold(STAGE_CLEAR)) held++;
  return held;
}

describe('REPLAY_STAGE_CLEAR_HOLD_TICKS', () => {
  it('is 1.5 seconds of ticks', () => {
    expect(REPLAY_STAGE_CLEAR_HOLD_SECONDS).toBe(1.5);
    expect(REPLAY_STAGE_CLEAR_HOLD_TICKS).toBe(90);
    expect(REPLAY_STAGE_CLEAR_HOLD_TICKS).toBe(REPLAY_STAGE_CLEAR_HOLD_SECONDS * TICK_RATE);
  });
});

describe('ReplayStageClearHold', () => {
  it('never holds while playing', () => {
    const hold = new ReplayStageClearHold(HOLD_TICKS);
    for (let i = 0; i < HOLD_TICKS * 2; i++) expect(hold.shouldHold(PLAYING)).toBe(false);
  });

  it('never holds on gameover or title either', () => {
    const hold = new ReplayStageClearHold(HOLD_TICKS);
    expect(hold.shouldHold({ status: 'gameover', finished: true })).toBe(false);
    expect(hold.shouldHold({ status: 'title', finished: false })).toBe(false);
  });

  it('holds a StageClear for exactly the configured ticks, then lets the next tick through', () => {
    const hold = new ReplayStageClearHold(HOLD_TICKS);
    for (let i = 0; i < HOLD_TICKS; i++) expect(hold.shouldHold(STAGE_CLEAR)).toBe(true);
    expect(hold.shouldHold(STAGE_CLEAR)).toBe(false);
  });

  it('holds the next StageClear for the full length again', () => {
    const hold = new ReplayStageClearHold(HOLD_TICKS);
    expect(countHeldTicks(hold)).toBe(HOLD_TICKS);
    // The tick that was let through confirmed the clear; the stage that
    // followed plays for a while and is cleared in turn.
    for (let i = 0; i < 5; i++) expect(hold.shouldHold(PLAYING)).toBe(false);
    expect(countHeldTicks(hold)).toBe(HOLD_TICKS);
  });

  it('holds again in full even when the next StageClear follows with no playing tick in between', () => {
    const hold = new ReplayStageClearHold(HOLD_TICKS);
    expect(countHeldTicks(hold)).toBe(HOLD_TICKS);
    expect(countHeldTicks(hold)).toBe(HOLD_TICKS);
  });

  it('does not hold a StageClear the replay has no input left to follow', () => {
    const hold = new ReplayStageClearHold(HOLD_TICKS);
    for (let i = 0; i < HOLD_TICKS * 2; i++) expect(hold.shouldHold({ status: 'stageclear', finished: true })).toBe(false);
  });

  it('reset() discards a hold in progress', () => {
    const hold = new ReplayStageClearHold(HOLD_TICKS);
    for (let i = 0; i < 40; i++) expect(hold.shouldHold(STAGE_CLEAR)).toBe(true);
    hold.reset();
    expect(countHeldTicks(hold)).toBe(HOLD_TICKS);
  });

  it('drops a hold in progress when the StageClear is settled some other way', () => {
    const hold = new ReplayStageClearHold(HOLD_TICKS);
    for (let i = 0; i < 40; i++) expect(hold.shouldHold(STAGE_CLEAR)).toBe(true);
    // e.g. a skip confirmed the clear while the driver was suspended.
    expect(hold.shouldHold(PLAYING)).toBe(false);
    expect(countHeldTicks(hold)).toBe(HOLD_TICKS);
  });
});

// A replay that spans four stages (three StageClears), recorded with the
// real game settings so it genuinely reaches gameover on playback. Same
// serpentine and seed as tests/e2e/ranking.spec.ts's recordMultiStageReplay:
// draw across the field, step along the border, claim a strip at a time.
// StageClear is confirmed but NOT recorded, exactly as the replay protocol
// re-supplies it on playback.
const MULTI_STAGE_SEED = 377;
const MULTI_STAGE_STRIP_WIDTH = 4;
const MULTI_STAGE_FINAL_STAGE = 4;

const CONFIRM = { dx: 0 as const, dy: 0 as const, drawHeld: false, slow: false, confirm: true };

function recordMultiStageSamples(seed: number): InputSample[] {
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
    for (let i = 0; i < MULTI_STAGE_STRIP_WIDTH && session.getStatus() === 'playing'; i++) step(1, 0, false);
    goingDown = !goingDown;
  }
  return samples;
}

/** The leading samples of `samples` up to and including the one that clears stage 1 — a recording cut off on a StageClear. */
function truncateAtFirstStageClear(seed: number, samples: readonly InputSample[]): InputSample[] {
  const session = new GameSession({ seed });
  session.update(CONFIRM);
  let consumed = 0;
  while (session.getStatus() === 'playing' && consumed < samples.length) {
    session.update({ ...samples[consumed++], confirm: false });
    session.drainEvents();
    session.drainDespawnedEmberPositions();
  }
  expect(session.getStatus()).toBe('stageclear');
  return samples.slice(0, consumed);
}

const noYield = (): Promise<void> => Promise.resolve();

function createEngine(seed: number, samples: readonly InputSample[]): Promise<ReplayEngine> {
  return ReplayEngine.create(seed, encodeRle([...samples]), { yieldToEventLoop: noYield });
}

interface Playback {
  /** stepTick() calls that advanced the replay — i.e. recorded samples consumed. */
  steps: number;
  /** Ticks on which stepTick() was withheld. */
  heldTicks: number;
  /** Separate holds those ticks belong to. */
  holds: number;
  /** The session's state after every advancing stepTick(), in order. */
  trail: string[];
}

/**
 * Drives `engine` to the end of playback one tick at a time, the way
 * src/main.ts's update() does in replay mode: ask `hold` first, and call
 * stepTick() only when it does not withhold the tick. `hold: null` is the
 * driver with no STAGE CLEAR pause at all.
 */
function playToEnd(engine: ReplayEngine, hold: ReplayStageClearHold | null): Playback {
  const session = engine.getSession();
  const playback: Playback = { steps: 0, heldTicks: 0, holds: 0, trail: [] };
  let holding = false;
  for (let tick = 0; tick < 50_000; tick++) {
    if (hold?.shouldHold({ status: session.getStatus(), finished: engine.isFinished() })) {
      if (!holding) playback.holds++;
      holding = true;
      playback.heldTicks++;
      continue;
    }
    holding = false;
    if (!engine.stepTick()) return playback;
    session.drainEvents();
    session.drainDespawnedEmberPositions();
    playback.steps++;
    playback.trail.push(`${session.getTotalTicks()}|${session.getScore()}|${session.getStage()}|${session.getStatus()}`);
  }
  throw new Error('playToEnd: playback did not end');
}

function outcome(engine: ReplayEngine): { score: number; stage: number; totalTicks: number } {
  const session = engine.getSession();
  return { score: session.getScore(), stage: session.getStage(), totalTicks: session.getTotalTicks() };
}

describe('STAGE CLEAR hold leaves replay playback unchanged', () => {
  it('reaches the same score, stage and tick count, through the same per-tick states, as playback with no hold and as the pre-pass', async () => {
    const samples = recordMultiStageSamples(MULTI_STAGE_SEED);

    const plainEngine = await createEngine(MULTI_STAGE_SEED, samples);
    const plain = playToEnd(plainEngine, null);

    const heldEngine = await createEngine(MULTI_STAGE_SEED, samples);
    const held = playToEnd(heldEngine, new ReplayStageClearHold(HOLD_TICKS));

    // Not vacuous: the fixture really does clear three stages, and each clear
    // really was held for the full length.
    const result = heldEngine.getResult();
    expect(result.stage).toBe(MULTI_STAGE_FINAL_STAGE);
    expect(result.stageBoundaries).toHaveLength(MULTI_STAGE_FINAL_STAGE);
    expect(result.reachedGameOver).toBe(true);
    expect(held.holds).toBe(MULTI_STAGE_FINAL_STAGE - 1);
    expect(held.heldTicks).toBe(HOLD_TICKS * (MULTI_STAGE_FINAL_STAGE - 1));
    expect(plain.heldTicks).toBe(0);

    // Every recorded sample is consumed, once, in both.
    expect(held.steps).toBe(samples.length);
    expect(plain.steps).toBe(samples.length);
    expect(held.trail).toEqual(plain.trail);

    const expected = { score: result.score, stage: result.stage, totalTicks: result.durationTicks };
    expect(outcome(heldEngine)).toEqual(expected);
    expect(outcome(plainEngine)).toEqual(expected);
    expect(heldEngine.getSession().getStatus()).toBe('gameover');
    expect(heldEngine.getSession().getGameOverReason()).toBe(result.gameOverReason);
    expect(heldEngine.getResult()).toEqual(plainEngine.getResult());
  });

  it('skipToFinalStage() lands on the same tick and stage from the middle of a hold as from the middle of play', async () => {
    const samples = recordMultiStageSamples(MULTI_STAGE_SEED);

    const fromPlay = await createEngine(MULTI_STAGE_SEED, samples);
    for (let i = 0; i < 10; i++) expect(fromPlay.stepTick()).toBe(true);
    expect(fromPlay.getSession().getStatus()).toBe('playing');
    await fromPlay.skipToFinalStage({ yieldToEventLoop: noYield });

    const fromHold = await createEngine(MULTI_STAGE_SEED, samples);
    const hold = new ReplayStageClearHold(HOLD_TICKS);
    const session = fromHold.getSession();
    let heldTicks = 0;
    while (heldTicks < 30) {
      if (hold.shouldHold({ status: session.getStatus(), finished: fromHold.isFinished() })) {
        heldTicks++;
      } else {
        expect(fromHold.stepTick()).toBe(true);
        session.drainEvents();
        session.drainDespawnedEmberPositions();
      }
    }
    expect(session.getStatus()).toBe('stageclear');
    expect(session.getStage()).toBe(1);
    await fromHold.skipToFinalStage({ yieldToEventLoop: noYield });

    const boundaries = fromHold.getResult().stageBoundaries;
    const finalBoundary = boundaries[boundaries.length - 1];
    expect(finalBoundary.startTick).toBeGreaterThan(0);
    expect(outcome(fromHold)).toEqual(outcome(fromPlay));
    expect(session.getTotalTicks()).toBe(finalBoundary.startTick);
    expect(session.getStage()).toBe(finalBoundary.stage);
    expect(session.getStatus()).toBe('playing');

    // Resuming with the same counter, still carrying the interrupted hold's
    // partial count: it is dropped on the first playing tick, and the rest of
    // the run (the final stage, which ends in gameover) plays out to the
    // pre-pass result.
    const rest = playToEnd(fromHold, hold);
    const result = fromHold.getResult();
    expect(rest.heldTicks).toBe(0);
    expect(outcome(fromHold)).toEqual({ score: result.score, stage: result.stage, totalTicks: result.durationTicks });
  });

  it('ends a recording cut off on a StageClear straight away, with no hold and no stage change', async () => {
    const samples = truncateAtFirstStageClear(MULTI_STAGE_SEED, recordMultiStageSamples(MULTI_STAGE_SEED));
    const engine = await createEngine(MULTI_STAGE_SEED, samples);
    const playback = playToEnd(engine, new ReplayStageClearHold(HOLD_TICKS));

    expect(playback.steps).toBe(samples.length);
    expect(playback.heldTicks).toBe(0);
    expect(engine.getSession().getStatus()).toBe('stageclear');
    expect(engine.isFinished()).toBe(true);
    // The viewed session and the pre-pass agree on the stage the recording
    // stops on (neither confirms the trailing StageClear).
    expect(engine.getSession().getStage()).toBe(engine.getResult().stage);
    expect(engine.getResult().reachedGameOver).toBe(false);
  });
});
