// The GAME OVER retry, end to end against the server's own replay verifier:
// a run started by a retry must record exactly the inputs that reproduce it.
import { describe, it, expect } from 'vitest';
import { GameSession, SessionInput } from './core/session';
import { buildStageScript } from './core/scriptedRun';
import { stepLiveSession, LiveRunTracker, RETRY_CONFIRM_INPUT, freezeRunSnapshot, keepsInPlayLog } from './retryFlow';
import { isSnapshotEligible } from './ui/ranking';
import type { Difficulty } from './core/difficulty';

// src/ is type-checked on its own (tsconfig rootDir ./src), so the server
// module is loaded by a runtime path the compiler does not follow. The test
// still runs the real functions/_lib/ranking/verifyReplay.ts.
const VERIFY_REPLAY_MODULE = '../functions/_lib/ranking/verifyReplay';
type VerifyReplay = (
  seed: number,
  rle: Uint8Array
) => { ok: true; score: number; stage: number; durationTicks: number } | { ok: false; reason: string };

async function loadVerifyReplay(): Promise<VerifyReplay> {
  const mod = (await import(/* @vite-ignore */ VERIFY_REPLAY_MODULE)) as { verifyReplay: VerifyReplay };
  return mod.verifyReplay;
}

const IDLE: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };
const CONFIRM: SessionInput = { ...IDLE, confirm: true };

/** The live driver main.ts runs, minus the DOM: one stepLiveSession() + tracker.observe() per tick. */
class Driver {
  readonly tracker = new LiveRunTracker();
  freshRuns = 0;
  constructor(readonly session: GameSession) {}

  tick(input: SessionInput, retry = true): ReturnType<typeof stepLiveSession> {
    const result = stepLiveSession(this.session, input, {
      retry,
      onFreshRun: () => {
        this.freshRuns++;
        this.tracker.startFreshRun();
      },
    });
    this.tracker.observe(this.session, input, this.session.drainEvents());
    this.session.drainDespawnedEmberPositions();
    return result;
  }

  /** Plays the scripted inputs (core/scriptedRun.ts) until GAME OVER, confirming each STAGE CLEAR. */
  playToGameOver(): void {
    const field = this.session.getGame().getField();
    const script = buildStageScript(field.getWidth(), field.getHeight());
    let guard = 0;
    while (this.session.getStatus() !== 'gameover') {
      if (guard++ > 30000) throw new Error('run did not end');
      if (this.session.getStatus() === 'stageclear') {
        this.tick(CONFIRM);
        continue;
      }
      this.tick(scriptInput(script, this.session.getStageTicks()));
    }
  }
}

function scriptInput(script: ReturnType<typeof buildStageScript>, tick: number): SessionInput {
  let remaining = tick;
  for (const s of script) {
    if (remaining < s.ticks) return { dx: s.dx, dy: s.dy, drawHeld: s.drawHeld, slow: s.slow, confirm: false };
    remaining -= s.ticks;
  }
  return IDLE;
}

describe('stepLiveSession', () => {
  it('a retry confirm goes from GAME OVER to stage 1 in one tick, through the fresh-run reset', () => {
    const session = new GameSession({ seed: 11 });
    const driver = new Driver(session);
    driver.tick(CONFIRM);
    driver.playToGameOver();

    const result = driver.tick(CONFIRM);
    expect(result).toEqual({ freshRun: true, retried: true });
    expect(session.getStatus()).toBe('playing');
    expect(session.getStage()).toBe(1);
    expect(session.getScore()).toBe(0);
    expect(session.getTotalTicks()).toBe(0);
    expect(driver.freshRuns).toBe(1);
  });

  it('without retry (the TITLE button) the run stops at Title', () => {
    const session = new GameSession({ seed: 11 });
    const driver = new Driver(session);
    driver.tick(CONFIRM);
    driver.playToGameOver();

    expect(driver.tick(CONFIRM, false)).toEqual({ freshRun: true, retried: false });
    expect(session.getStatus()).toBe('title');
  });

  it('leaves every other tick to a single update', () => {
    const calls: SessionInput[] = [];
    let status: 'title' | 'playing' = 'title';
    const fake = {
      getStatus: () => status,
      update: (input: SessionInput) => {
        calls.push(input);
        if (input.confirm) status = 'playing';
      },
    };
    const onFreshRun = () => {
      throw new Error('not a fresh run');
    };
    expect(stepLiveSession(fake, CONFIRM, { retry: true, onFreshRun })).toEqual({ freshRun: false, retried: false });
    expect(stepLiveSession(fake, IDLE, { retry: true, onFreshRun })).toEqual({ freshRun: false, retried: false });
    expect(calls).toHaveLength(2);
  });

  it("a retry's second input is confirm alone", () => {
    expect(RETRY_CONFIRM_INPUT).toEqual(CONFIRM);
  });
});

describe('a run started by RETRY', () => {
  it('records the seed and inputs that the server verifier accepts, with the same score and stage', async () => {
    const verifyReplay = await loadVerifyReplay();
    const firstSeed = 20261115;
    const secondSeed = 777;
    const session = new GameSession({ seed: firstSeed, captureFeedback: true });
    const driver = new Driver(session);
    driver.tick(CONFIRM);
    driver.playToGameOver();
    const firstRunId = driver.tracker.getRunId();
    const firstScore = session.getScore();
    expect(driver.tracker.getClaims()).toBeGreaterThan(0);

    // main.ts queues the next normal run's seed every tick while on GAME OVER.
    session.setNextSeed(secondSeed);
    driver.tick(CONFIRM);
    expect(session.getStatus()).toBe('playing');
    expect(session.getSeed()).toBe(secondSeed);
    // A different run id, and the claims count from 0.
    expect(driver.tracker.getRunId()).not.toBe(firstRunId);
    expect(driver.tracker.getClaims()).toBe(0);
    expect(driver.tracker.recorder.getSamples()).toEqual([]);

    driver.playToGameOver();
    const verdict = verifyReplay(secondSeed, driver.tracker.recorder.encode());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.score).toBe(session.getScore());
    expect(verdict.stage).toBe(session.getStage());
    expect(verdict.durationTicks).toBe(session.getTotalTicks());
    expect(driver.tracker.getClaims()).toBeGreaterThan(0);
    // The second run really is a different board from the first.
    expect(session.getScore()).not.toBe(firstScore);
  }, 30_000);
});

describe('the run frozen at GAME OVER', () => {
  /** A live session played to GAME OVER on `difficulty` (no seed param, no debug override). */
  function endedRun(difficulty: Difficulty) {
    const session = new GameSession({ seed: 77, captureFeedback: true, timeLimitTicks: 400, difficulty });
    const driver = new Driver(session);
    driver.tick(CONFIRM);
    driver.playToGameOver();
    return { session, driver };
  }

  it('posts a NORMAL run and keeps it in the play log; never an EASY one', () => {
    const normal = endedRun('normal');
    expect(normal.session.getScore()).toBeGreaterThan(0);
    const normalSnapshot = freezeRunSnapshot(normal.session, normal.driver.tracker, 'normal');
    expect(normalSnapshot).toMatchObject({ difficulty: 'normal', tainted: false, score: normal.session.getScore() });
    expect(isSnapshotEligible(normalSnapshot)).toBe(true);
    expect(keepsInPlayLog(normal.session, 'normal')).toBe(true);

    const easy = endedRun('easy');
    expect(easy.session.getScore()).toBeGreaterThan(0);
    const easySnapshot = freezeRunSnapshot(easy.session, easy.driver.tracker, 'normal');
    expect(easySnapshot).toMatchObject({ difficulty: 'easy', tainted: false, runMode: 'normal' });
    expect(isSnapshotEligible(easySnapshot)).toBe(false);
    expect(keepsInPlayLog(easy.session, 'normal')).toBe(false);
  });

  it('keeps neither a `?seed=` run nor a debug-tuned run in the play log', () => {
    const seeded = endedRun('normal');
    expect(keepsInPlayLog(seeded.session, 'seeded')).toBe(false);
    const tuned = new GameSession({ seed: 77, timeLimitTicks: 5 });
    tuned.update(CONFIRM);
    tuned.applyDebugOverrides({ wispSpeedMultiplier: 1 });
    tuned.resetDebugOverrides();
    while (tuned.getStatus() === 'playing') tuned.update(IDLE);
    expect(keepsInPlayLog(tuned, 'normal')).toBe(false);
  });

  it('stays as it ended when the next run’s difficulty is picked on GAME OVER, which goes into the next run', () => {
    for (const [from, to] of [
      ['easy', 'normal'],
      ['normal', 'easy'],
    ] as const) {
      for (const retry of [true, false]) {
        const { session, driver } = endedRun(from);
        const snapshot = freezeRunSnapshot(session, driver.tracker, 'normal');
        const frozen = { ...snapshot, rle: new Uint8Array(snapshot.rle) };
        const ended = { score: session.getScore(), difficulty: session.getDifficulty() };
        session.setNextDifficulty(to);
        expect({ score: session.getScore(), difficulty: session.getDifficulty() }).toEqual(ended);
        expect(freezeRunSnapshot(session, driver.tracker, 'normal')).toEqual(frozen);
        driver.tick(CONFIRM, retry);
        expect(session.getStatus()).toBe(retry ? 'playing' : 'title');
        expect(session.getDifficulty()).toBe(to);
        expect(snapshot).toEqual(frozen);
        expect(isSnapshotEligible(snapshot)).toBe(from === 'normal');
      }
    }
  });
});
