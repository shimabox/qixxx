// GameSession's difficulty (core/difficulty.ts): an EASY run's Wisps move at
// the stage table's speed times EASY_WISP_SPEED_FACTOR, it starts with
// EASY_INITIAL_LIVES carried across stages, and every stage starts at the
// middle of the top edge without drawing the start from the rng; everything
// else is NORMAL's. The next run's difficulty is picked ahead and fixed where
// a new run is built.
import { describe, it, expect } from 'vitest';
import { GameSession, SessionInput } from './session';
import { getStageConfig } from './stage';
import { mulberry32 } from './rng';
import { stepLiveSession } from '../retryFlow';
import { clearFromStart, sessionAtStage } from './stageStartFixture';
import { EASY_INITIAL_LIVES, EASY_WISP_SPEED_FACTOR, GRID_WIDTH, INITIAL_LIVES } from '../config';

const CONFIRM: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: true };
const IDLE: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };
const TOP_CENTER = { edge: 'top', point: { x: Math.floor(GRID_WIDTH / 2), y: 0 } };

const speeds = (session: GameSession) => session.getGame().getWisps().map((w) => w.getSpeedMultiplier());

/** An rng counting its calls, over a seeded stream. */
function countingRng(seed: number) {
  const inner = mulberry32(seed);
  const state = { calls: 0 };
  return { rng: () => (state.calls++, inner()), state };
}

/** From the middle of the top edge: a slow `size` x `size` box straight down, right and back up (claims size² cells, ~size² points). */
function claimBox(session: GameSession, size: number): void {
  const steps: Array<Pick<SessionInput, 'dx' | 'dy'>> = [
    ...Array(size).fill({ dx: 0, dy: 1 }),
    ...Array(size).fill({ dx: 1, dy: 0 }),
    ...Array(size).fill({ dx: 0, dy: -1 }),
  ];
  for (const step of steps) session.update({ ...IDLE, ...step, drawHeld: true, slow: true });
}

/** Plays the current stage until one life is lost to the Igniter (a one-cell stub, then still), and waits out the grace. */
function loseOneLife(session: GameSession): void {
  const lives = session.getLives();
  session.update({ dx: 0, dy: 1, drawHeld: true, slow: false, confirm: false });
  for (let i = 0; i < 5_000 && session.getLives() === lives; i++) session.update(IDLE);
  expect(session.getLives()).toBe(lives - 1);
  for (let i = 0; i < 5_000 && session.getGame().getGraceTicks() > 0; i++) session.update(IDLE);
  expect(session.getStatus()).toBe('playing');
}

describe('GameSession — an EASY run', () => {
  it('moves every stage’s Wisps, 1 to 16, at the table speed times EASY_WISP_SPEED_FACTOR, as many as NORMAL’s (16 past the table’s last row)', () => {
    const easy = sessionAtStage(1, { seed: 5, difficulty: 'easy' });
    const normal = sessionAtStage(1, { seed: 5 });
    for (let stage = 1; stage <= 16; stage++) {
      const table = getStageConfig(stage);
      expect(easy.getStage()).toBe(stage);
      expect(speeds(easy)).toEqual(Array(table.wispCount).fill(table.wispSpeedMultiplier * EASY_WISP_SPEED_FACTOR));
      expect(easy.getEffectiveDebugParams().wispSpeedMultiplier).toBe(table.wispSpeedMultiplier * EASY_WISP_SPEED_FACTOR);
      expect(normal.getStage()).toBe(stage);
      expect(speeds(normal)).toEqual(Array(table.wispCount).fill(table.wispSpeedMultiplier));
      if (stage < 16) {
        for (const session of [easy, normal]) {
          clearFromStart(session);
          session.update(CONFIRM);
        }
      }
    }
    // Past the table only the Wisp count still rises (8 on stage 16, held at
    // 10 from stage 18); every other value is the same on 16 and 99.
    expect(getStageConfig(16).wispCount).toBe(8);
    expect(getStageConfig(99).wispCount).toBe(10);
    expect({ ...getStageConfig(16), stage: 0, wispCount: 0 }).toEqual({ ...getStageConfig(99), stage: 0, wispCount: 0 });
  });

  it('starts every stage, 1 to 16, at the middle of the top edge and never draws the start from the rng', () => {
    const { rng, state } = countingRng(7);
    const session = new GameSession({ rng, difficulty: 'easy' });
    expect(state.calls).toBe(2 + getStageConfig(1).wispCount);
    session.update(CONFIRM);
    for (let stage = 1; stage <= 16; stage++) {
      expect(session.getStage()).toBe(stage);
      expect(session.getMarkerStart()).toEqual(TOP_CENTER);
      expect(session.getGame().getMarker().getPosition()).toEqual(TOP_CENTER.point);
      if (stage === 16) break;
      clearFromStart(session);
      const before = state.calls;
      session.update(CONFIRM); // builds the next stage, plays none of it
      // The Wisps' center (x, y) and one heading each — no start pick.
      expect(state.calls - before).toBe(2 + getStageConfig(stage + 1).wispCount);
    }
  });

  it('starts with EASY_INITIAL_LIVES and carries them across a stage clear like NORMAL', () => {
    const easy = new GameSession({ seed: 11, difficulty: 'easy' });
    expect(easy.getLives()).toBe(EASY_INITIAL_LIVES);
    easy.update(CONFIRM);
    loseOneLife(easy);
    clearFromStart(easy);
    easy.update(CONFIRM);
    expect(easy.getStage()).toBe(2);
    expect(easy.getLives()).toBe(EASY_INITIAL_LIVES - 1);

    const normal = new GameSession({ seed: 11 });
    expect(normal.getLives()).toBe(INITIAL_LIVES);
  });

  it('keeps NORMAL’s time, Embers, goals and scoring', () => {
    const easy = sessionAtStage(1, { seed: 21, difficulty: 'easy' });
    const normal = sessionAtStage(1, { seed: 21 });
    expect(easy.getTimeLimitTicks()).toBe(normal.getTimeLimitTicks());
    const { wispSpeedMultiplier: easySpeed, ...easyRest } = easy.getEffectiveDebugParams();
    const { wispSpeedMultiplier: normalSpeed, ...normalRest } = normal.getEffectiveDebugParams();
    expect(easySpeed).toBeLessThan(normalSpeed);
    expect(easyRest).toEqual(normalRest);
    // Stage 1 is the same board on the same seed: the same claim scores the same.
    claimBox(easy, 4);
    claimBox(normal, 4);
    expect(easy.getScore()).toBeGreaterThan(0);
    expect(easy.getScore()).toBe(normal.getScore());
  });

  it('keeps every stage’s other parameters, 1 to 16, the table’s own', () => {
    const easy = sessionAtStage(1, { seed: 3, difficulty: 'easy' });
    const normal = sessionAtStage(1, { seed: 3 });
    for (let stage = 1; stage <= 16; stage++) {
      const table = getStageConfig(stage);
      // Walking on clears each stage with a lowered goal (a debug override):
      // dropped here so the stage's own values show.
      easy.resetDebugOverrides();
      normal.resetDebugOverrides();
      const { wispSpeedMultiplier: easySpeed, ...easyRest } = easy.getEffectiveDebugParams();
      const { wispSpeedMultiplier: normalSpeed, ...normalRest } = normal.getEffectiveDebugParams();
      expect(easySpeed).toBe(normalSpeed * EASY_WISP_SPEED_FACTOR);
      expect(easyRest).toEqual(normalRest);
      expect(easy.getGame().getRequiredOccupancy()).toBe(table.requiredOccupancy);
      expect(easy.getRemainingTicks()).toBe(normal.getRemainingTicks());
      if (stage < 16) {
        for (const session of [easy, normal]) {
          clearFromStart(session);
          session.update(CONFIRM);
        }
      }
    }
  });

  it('returns the debug panel’s Wisp speed RESET to the table speed times EASY_WISP_SPEED_FACTOR', () => {
    for (const stage of [1, 2, 7]) {
      const session = sessionAtStage(stage, { seed: 9, difficulty: 'easy' });
      const easySpeed = getStageConfig(stage).wispSpeedMultiplier * EASY_WISP_SPEED_FACTOR;
      session.applyDebugOverrides({ wispSpeedMultiplier: 3 });
      expect(speeds(session).every((s) => s === 3)).toBe(true);
      session.resetDebugOverrides();
      expect(session.getEffectiveDebugParams().wispSpeedMultiplier).toBe(easySpeed);
      expect(speeds(session).every((s) => s === easySpeed)).toBe(true);
    }
  });
});

describe('GameSession — the next run’s difficulty', () => {
  it('is NORMAL by default, and a session built without one plays as before', () => {
    const session = new GameSession({ seed: 4 });
    expect(session.getDifficulty()).toBe('normal');
    expect(session.getNextDifficulty()).toBe('normal');
    expect(session.getLives()).toBe(INITIAL_LIVES);
  });

  it('never changes the run being played', () => {
    const session = new GameSession({ seed: 4, timeLimitTicks: 30 });
    session.update(CONFIRM);
    const before = { lives: session.getLives(), speeds: speeds(session) };
    session.setNextDifficulty('easy');
    expect(session.getNextDifficulty()).toBe('easy');
    expect(session.getDifficulty()).toBe('normal');
    session.update(IDLE);
    expect({ lives: session.getLives(), speeds: speeds(session) }).toEqual(before);
    session.rebuildTitleRun(); // not on Title: a no-op
    expect(session.getStatus()).toBe('playing');
    expect({ lives: session.getLives(), speeds: speeds(session) }).toEqual(before);
  });

  it('never changes a run ended on GAME OVER, and goes into the next run on TITLE', () => {
    const session = new GameSession({ seed: 4, timeLimitTicks: 20 });
    session.update(CONFIRM);
    claimBox(session, 4);
    while (session.getStatus() === 'playing') session.update(IDLE);
    expect(session.getStatus()).toBe('gameover');
    const ended = { score: session.getScore(), stage: session.getStage(), difficulty: session.getDifficulty(), lives: session.getLives() };
    expect(ended.score).toBeGreaterThan(0);
    session.setNextDifficulty('easy');
    session.rebuildTitleRun(); // not on Title: a no-op
    expect({ score: session.getScore(), stage: session.getStage(), difficulty: session.getDifficulty(), lives: session.getLives() }).toEqual(ended);

    const step = stepLiveSession(session, CONFIRM, { retry: false, onFreshRun: () => {} });
    expect(step).toEqual({ freshRun: true, retried: false });
    expect(session.getStatus()).toBe('title');
    expect(session.getDifficulty()).toBe('easy');
    expect(session.getLives()).toBe(EASY_INITIAL_LIVES);
    expect(speeds(session)).toEqual(speeds(session).map(() => getStageConfig(1).wispSpeedMultiplier * EASY_WISP_SPEED_FACTOR));
  });

  it('goes into the next run on RETRY too, and back to NORMAL the same way', () => {
    const session = new GameSession({ seed: 4, timeLimitTicks: 3, difficulty: 'easy' });
    expect(session.getLives()).toBe(EASY_INITIAL_LIVES);
    session.update(CONFIRM);
    while (session.getStatus() === 'playing') session.update(IDLE);
    session.setNextDifficulty('normal');
    expect(session.getDifficulty()).toBe('easy');
    const step = stepLiveSession(session, CONFIRM, { retry: true, onFreshRun: () => {} });
    expect(step).toEqual({ freshRun: true, retried: true });
    expect(session.getStatus()).toBe('playing');
    expect(session.getDifficulty()).toBe('normal');
    expect(session.getLives()).toBe(INITIAL_LIVES);
    expect(speeds(session)).toEqual(speeds(session).map(() => getStageConfig(1).wispSpeedMultiplier));
  });

  it('keeps the pick for every later run until it is picked again', () => {
    const session = new GameSession({ seed: 4, timeLimitTicks: 2 });
    session.setNextDifficulty('easy');
    for (let run = 0; run < 3; run++) {
      session.update(CONFIRM);
      while (session.getStatus() === 'playing') session.update(IDLE);
      stepLiveSession(session, CONFIRM, { retry: false, onFreshRun: () => {} });
      expect(session.getDifficulty()).toBe('easy');
    }
  });

  it('rebuilds the run waiting on Title on the same seed with the new lives and Wisp speed', () => {
    const session = new GameSession({ seed: 12345 });
    const before = {
      seed: session.getSeed(),
      wisps: session.getGame().getWisps().map((w) => w.getPosition()),
    };
    session.setNextDifficulty('easy');
    session.rebuildTitleRun();
    expect(session.getStatus()).toBe('title');
    expect(session.getDifficulty()).toBe('easy');
    expect(session.getSeed()).toBe(before.seed);
    expect(session.getGame().getWisps().map((w) => w.getPosition())).toEqual(before.wisps);
    expect(session.getLives()).toBe(EASY_INITIAL_LIVES);
    expect(speeds(session)).toEqual(before.wisps.map(() => getStageConfig(1).wispSpeedMultiplier * EASY_WISP_SPEED_FACTOR));

    // Starting from Title plays what is shown.
    session.update(CONFIRM);
    expect(session.getStatus()).toBe('playing');
    expect(session.getDifficulty()).toBe('easy');
    expect(session.getLives()).toBe(EASY_INITIAL_LIVES);

    const back = new GameSession({ seed: 12345, difficulty: 'easy' });
    back.setNextDifficulty('normal');
    back.rebuildTitleRun();
    expect(back.getSeed()).toBe(12345);
    expect(back.getLives()).toBe(INITIAL_LIVES);
    expect(speeds(back)).toEqual(before.wisps.map(() => getStageConfig(1).wispSpeedMultiplier));
  });

  it('keeps the run’s seed on a Title rebuild even with a seed queued for the next run', () => {
    const session = new GameSession({ seed: 1 });
    session.setNextSeed(2);
    session.setNextDifficulty('easy');
    session.rebuildTitleRun();
    expect(session.getSeed()).toBe(1);
  });
});
