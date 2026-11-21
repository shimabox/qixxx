import { describe, it, expect } from 'vitest';
import { PlayLogRecorder } from './recorder';
import type { ClaimFeedback, MissCause, MissFeedback } from '../core/feedback';
import { GameSession, type SessionInput } from '../core/session';
import { buildStageScript } from '../core/scriptedRun';
import { INITIAL_LIVES } from '../config';

function claim(overrides: Partial<ClaimFeedback> = {}): ClaimFeedback {
  return {
    claimedCells: 10,
    occupancyBefore: 0,
    occupancyAfter: 0.05,
    lineSpeed: 'fast',
    areaScore: 50,
    bigClaim: false,
    nearMissBonus: 0,
    stageClearBonus: 0,
    multiplier: 1,
    split: false,
    stageCleared: false,
    closedLine: [],
    ...overrides,
  };
}

function miss(cause: MissCause): MissFeedback {
  return { cause, position: { x: 1, y: 1 }, line: [] };
}

const FINISH = { stage: 1, score: 0, end: 'life' as const, endedAt: 1000 };

describe('PlayLogRecorder', () => {
  it('adds claims, splits, misses by cause and clears to the stage the tick started on', () => {
    const r = new PlayLogRecorder();
    r.startRun();
    r.observeTick({ stageBefore: 1, statusBefore: 'playing', claims: [claim()], misses: [miss('wisp')] });
    r.observeTick({ stageBefore: 1, statusBefore: 'playing', claims: [], misses: [miss('ember'), miss('igniter')] });
    // The claim that clears stage 1 counts for stage 1.
    r.observeTick({ stageBefore: 1, statusBefore: 'playing', claims: [claim({ split: true, stageCleared: true })], misses: [] });
    // The confirm on STAGE CLEAR (advancing to stage 2) is still stage 1's tick.
    r.observeTick({ stageBefore: 1, statusBefore: 'stageclear', claims: [], misses: [] });
    r.observeTick({ stageBefore: 2, statusBefore: 'playing', claims: [claim()], misses: [miss('wisp')] });
    const record = r.finish({ stage: 2, score: 300, end: 'life', endedAt: 1234 });
    expect(record).toEqual({
      endedAt: 1234,
      stage: 2,
      score: 300,
      end: 'life',
      ticks: 5,
      stages: [
        { stage: 1, claims: 2, splits: 1, misses: { wisp: 1, ember: 1, igniter: 1 }, cleared: true },
        { stage: 2, claims: 1, splits: 0, misses: { wisp: 1, ember: 0, igniter: 0 }, cleared: false },
      ],
    });
  });

  it('counts only ticks that started playing or on STAGE CLEAR', () => {
    const r = new PlayLogRecorder();
    r.startRun();
    r.observeTick({ stageBefore: 1, statusBefore: 'title', claims: [], misses: [] });
    r.observeTick({ stageBefore: 1, statusBefore: 'playing', claims: [], misses: [] });
    r.observeTick({ stageBefore: 1, statusBefore: 'playing', claims: [], misses: [] });
    r.observeTick({ stageBefore: 1, statusBefore: 'stageclear', claims: [], misses: [] });
    r.observeTick({ stageBefore: 2, statusBefore: 'gameover', claims: [claim()], misses: [miss('wisp')] });
    const record = r.finish({ ...FINISH, stage: 2 });
    expect(record?.ticks).toBe(3);
    expect(record?.stages.map((s) => s.claims)).toEqual([0, 0]);
  });

  it('lists every stage entered from 1 in order, even one with nothing in it', () => {
    const r = new PlayLogRecorder();
    r.startRun();
    r.observeTick({ stageBefore: 3, statusBefore: 'playing', claims: [], misses: [] });
    const record = r.finish({ ...FINISH, stage: 4 });
    expect(record?.stages.map((s) => s.stage)).toEqual([1, 2, 3, 4]);
  });

  it('returns a run only once, and nothing before a run starts', () => {
    const r = new PlayLogRecorder();
    expect(r.finish(FINISH)).toBeNull();
    r.startRun();
    expect(r.finish(FINISH)).not.toBeNull();
    expect(r.finish(FINISH)).toBeNull();
    // Ticks after the end are not kept for anything.
    r.observeTick({ stageBefore: 1, statusBefore: 'playing', claims: [claim()], misses: [] });
    expect(r.finish(FINISH)).toBeNull();
  });

  it('startRun() drops what the previous run left', () => {
    const r = new PlayLogRecorder();
    r.startRun();
    r.observeTick({ stageBefore: 2, statusBefore: 'playing', claims: [claim()], misses: [miss('wisp')] });
    r.startRun();
    r.observeTick({ stageBefore: 1, statusBefore: 'playing', claims: [], misses: [] });
    expect(r.finish(FINISH)).toEqual({
      ...FINISH,
      ticks: 1,
      stages: [{ stage: 1, claims: 0, splits: 0, misses: { wisp: 0, ember: 0, igniter: 0 }, cleared: false }],
    });
  });

  it('a record holds only the fields of the play log format', () => {
    const r = new PlayLogRecorder();
    r.startRun();
    r.observeTick({ stageBefore: 1, statusBefore: 'playing', claims: [claim()], misses: [] });
    const record = r.finish(FINISH)!;
    // No seed, no inputs, no submitter id, no user agent or screen size.
    expect(Object.keys(record).sort()).toEqual(['end', 'endedAt', 'score', 'stage', 'stages', 'ticks']);
    expect(Object.keys(record.stages[0]).sort()).toEqual(['claims', 'cleared', 'misses', 'splits', 'stage']);
    expect(Object.keys(record.stages[0].misses).sort()).toEqual(['ember', 'igniter', 'wisp']);
    // JSON as it is.
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});

/**
 * Drives a real GameSession through the rule-invariance script (the same
 * stage script, a StageClear confirmed on its own tick) with the recorder
 * observing every tick the way the live loop does.
 */
function runRecorded(options: { seed: number; timeLimitTicks?: number }) {
  const session = new GameSession({ ...options, fieldWidth: 40, fieldHeight: 30, captureFeedback: true });
  const recorder = new PlayLogRecorder();
  recorder.startRun();
  const script = buildStageScript(40, 30);
  const inputAt = (tick: number): SessionInput => {
    let remaining = tick;
    for (const s of script) {
      if (remaining < s.ticks) return { dx: s.dx, dy: s.dy, drawHeld: s.drawHeld, slow: s.slow, confirm: false };
      remaining -= s.ticks;
    }
    return { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };
  };
  const confirm: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: true };

  let claimNotices = 0;
  let livesLost = 0;
  let clearedStages = 0;
  let guard = 0;
  const step = (input: SessionInput) => {
    const stageBefore = session.getStage();
    const statusBefore = session.getStatus();
    const livesBefore = session.getLives();
    session.update(input);
    const claims = session.drainClaimFeedback();
    const misses = session.drainMissFeedback();
    session.drainEvents();
    session.drainDespawnedEmberPositions();
    claimNotices += claims.length;
    if (statusBefore === 'playing') livesLost += Math.max(0, livesBefore - session.getLives());
    if (statusBefore === 'playing' && session.getStatus() === 'stageclear') clearedStages++;
    recorder.observeTick({ stageBefore, statusBefore, claims, misses });
  };
  step(confirm); // Title -> playing
  while (session.getStatus() !== 'gameover' && guard++ < 20000) {
    step(session.getStatus() === 'stageclear' ? confirm : inputAt(session.getStageTicks()));
  }
  const reason = session.getGameOverReason();
  const record = recorder.finish({ stage: session.getStage(), score: session.getScore(), end: reason ?? 'life', endedAt: 1 });
  return { session, record: record!, claimNotices, livesLost, clearedStages };
}

describe('PlayLogRecorder on a real GameSession', () => {
  it('a run lost on lives: the record matches the session', () => {
    const { session, record, claimNotices, livesLost, clearedStages } = runRecorded({ seed: 20261114 });
    expect(session.getGameOverReason()).toBe('life');
    expect(record.end).toBe('life');
    expect(record.stage).toBe(session.getStage());
    expect(record.score).toBe(session.getScore());
    expect(record.stages.map((s) => s.stage)).toEqual(Array.from({ length: session.getStage() }, (_, i) => i + 1));
    expect(claimNotices).toBeGreaterThan(0);
    expect(record.stages.reduce((n, s) => n + s.claims, 0)).toBe(claimNotices);
    const misses = record.stages.reduce((n, s) => n + s.misses.wisp + s.misses.ember + s.misses.igniter, 0);
    expect(misses).toBe(INITIAL_LIVES);
    expect(misses).toBe(livesLost);
    expect(record.stages.filter((s) => s.cleared).length).toBe(clearedStages);
    expect(record.stages[record.stages.length - 1].cleared).toBe(false);
    // This seed clears stage 2 by a split.
    expect(record.stages.reduce((n, s) => n + s.splits, 0)).toBeGreaterThan(0);
    // Every playing tick plus each STAGE CLEAR's confirm tick.
    expect(record.ticks).toBe(session.getTotalTicks() + clearedStages);
  });

  it('a run that runs out of time: the record matches the session', () => {
    const { session, record, claimNotices, livesLost } = runRecorded({ seed: 20261114, timeLimitTicks: 500 });
    expect(session.getGameOverReason()).toBe('time');
    expect(record.end).toBe('time');
    expect(record.stage).toBe(session.getStage());
    expect(record.score).toBe(session.getScore());
    expect(record.stages.reduce((n, s) => n + s.claims, 0)).toBe(claimNotices);
    const misses = record.stages.reduce((n, s) => n + s.misses.wisp + s.misses.ember + s.misses.igniter, 0);
    expect(misses).toBe(livesLost);
    expect(session.getLives()).toBeGreaterThan(0);
  });
});
