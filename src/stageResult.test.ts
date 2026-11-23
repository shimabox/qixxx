import { describe, it, expect } from 'vitest';
import { GameSession, SessionInput } from './core/session';
import { buildStageScript } from './core/scriptedRun';
import { StageResultTally, StageResultCounter, stageResultText } from './stageResult';
import { STAGE_RESULT_ROLL_TICKS } from './config';

const IDLE: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };

function scriptInput(script: ReturnType<typeof buildStageScript>, tick: number): SessionInput {
  let remaining = tick;
  for (const s of script) {
    if (remaining < s.ticks) return { dx: s.dx, dy: s.dy, drawHeld: s.drawHeld, slow: s.slow, confirm: false };
    remaining -= s.ticks;
  }
  return IDLE;
}

describe('StageResultTally on a scripted run', () => {
  // The rule invariance cases (core/rulesInvariance.test.ts): both clear
  // stages by occupancy, and 10505 clears one by a split as well.
  for (const options of [{ seed: 10505, fieldWidth: 40, fieldHeight: 30 }, { seed: 735, fieldWidth: 40, fieldHeight: 30 }]) {
    it(`seed ${options.seed}: TOTAL is every point the stage added, AREA + BONUS, close calls and big claims included`, () => {
      const session = new GameSession({ ...options, captureFeedback: true });
      session.update({ ...IDLE, confirm: true });
      const field = session.getGame().getField();
      // Each stage's script starts from that stage's marker start.
      const scriptFor = () => buildStageScript(field.getWidth(), field.getHeight(), session.getMarkerStart()!.point);
      let script = scriptFor();
      const tally = new StageResultTally();
      let stageStartScore = 0;
      let clears = 0;
      let bonusSeen = false;
      let closeCallSeen = false;
      let bigClaimSeen = false;
      let guard = 0;
      while (session.getStatus() !== 'gameover' && guard++ < 30000) {
        if (session.getStatus() === 'stageclear') {
          clears++;
          expect(tally.getTotal()).toBe(session.getScore() - stageStartScore);
          expect(tally.getTotal()).toBe(tally.getArea() + tally.getBonus());
          if (tally.getBonus() > 0) bonusSeen = true;
          session.update({ ...IDLE, confirm: true });
          script = scriptFor();
          tally.reset();
          stageStartScore = session.getScore();
          continue;
        }
        session.update(scriptInput(script, session.getStageTicks()));
        for (const notice of session.drainClaimFeedback()) {
          if (notice.nearMissBonus > 0) closeCallSeen = true;
          if (notice.bigClaim) bigClaimSeen = true;
          tally.add(notice);
        }
        session.drainEvents();
      }
      expect(clears).toBeGreaterThan(0);
      expect(closeCallSeen).toBe(true);
      expect(bigClaimSeen).toBe(true);
      // A stage that ends in GAME OVER still adds up.
      expect(tally.getTotal()).toBe(session.getScore() - stageStartScore);
      expect(bonusSeen).toBe(true);
    });
  }
});

describe('StageResultTally after a split clear', () => {
  it("seed 699: the stage after the split adds up its one x2 claim, 456 points", () => {
    // 699 (core/rulesInvariance.test.ts) clears stage 3 with a split and, on
    // stage 4 at x2, scores one 56-cell fast line with a close call:
    // (56 x 0.5 + 200) x 2 = 456, with no stage-clear bonus (it ends in GAME OVER).
    const session = new GameSession({ seed: 699, fieldWidth: 40, fieldHeight: 30, captureFeedback: true });
    session.update({ ...IDLE, confirm: true });
    const field = session.getGame().getField();
    const scriptFor = () => buildStageScript(field.getWidth(), field.getHeight(), session.getMarkerStart()!.point);
    let script = scriptFor();
    const tally = new StageResultTally();
    let stageStartScore = 0;
    let clears = 0;
    let guard = 0;
    while (session.getStatus() !== 'gameover' && guard++ < 30000) {
      if (session.getStatus() === 'stageclear') {
        clears++;
        expect(tally.getTotal()).toBe(session.getScore() - stageStartScore);
        session.update({ ...IDLE, confirm: true });
        script = scriptFor();
        tally.reset();
        stageStartScore = session.getScore();
        continue;
      }
      session.update(scriptInput(script, session.getStageTicks()));
      for (const notice of session.drainClaimFeedback()) tally.add(notice);
      session.drainEvents();
    }
    expect(clears).toBe(3);
    expect(session.getStage()).toBe(4);
    expect(tally.getArea()).toBe(456);
    expect(tally.getBonus()).toBe(0);
    expect(tally.getTotal()).toBe(456);
    expect(tally.getTotal()).toBe(session.getScore() - stageStartScore);
  });
});

describe('StageResultTally', () => {
  it('counts a close-call bonus in AREA, with no row of its own, and a big claim as scored', () => {
    const tally = new StageResultTally();
    tally.add({ areaScore: 2250, nearMissBonus: 0, stageClearBonus: 0 }); // a big claim, already x1.5
    tally.add({ areaScore: 40, nearMissBonus: 400, stageClearBonus: 0 }); // a close call at x2
    tally.add({ areaScore: 10, nearMissBonus: 0, stageClearBonus: 700 });
    expect(tally.getArea()).toBe(2700);
    expect(tally.getBonus()).toBe(700);
    expect(tally.getTotal()).toBe(3400);
  });
});

describe('StageResultCounter', () => {
  const final = { area: 12340, bonus: 1500, total: 13840 };

  it('counts from 0 to the final values over 30 ticks from the first visible tick', () => {
    const c = new StageResultCounter();
    c.step(true, false, STAGE_RESULT_ROLL_TICKS); // STAGE CLEAR, SPLIT! still up
    expect(c.isCounting()).toBe(true);
    c.step(true, true, STAGE_RESULT_ROLL_TICKS);
    expect(c.values(final)).toEqual({ area: 0, bonus: 0, total: 0 });
    c.step(true, true, STAGE_RESULT_ROLL_TICKS);
    expect(c.values(final).total).toBe(Math.floor(13840 / 30));
    for (let i = 2; i <= STAGE_RESULT_ROLL_TICKS; i++) {
      expect(c.isCounting()).toBe(true);
      c.step(true, true, STAGE_RESULT_ROLL_TICKS);
    }
    expect(c.isCounting()).toBe(false);
    expect(c.values(final)).toEqual(final);
  });

  it('finish() shows the final values at once', () => {
    const c = new StageResultCounter();
    c.step(true, true, STAGE_RESULT_ROLL_TICKS);
    c.step(true, true, STAGE_RESULT_ROLL_TICKS);
    c.finish();
    expect(c.isCounting()).toBe(false);
    expect(c.values(final)).toEqual(final);
  });

  it('finishing before the screen shows (under SPLIT!) shows it complete, and leaving STAGE CLEAR resets it', () => {
    const c = new StageResultCounter();
    c.step(true, false, STAGE_RESULT_ROLL_TICKS);
    c.finish();
    c.step(true, true, STAGE_RESULT_ROLL_TICKS);
    expect(c.isCounting()).toBe(false);
    expect(c.values(final)).toEqual(final);
    c.step(false, false, STAGE_RESULT_ROLL_TICKS);
    expect(c.isCounting()).toBe(true);
    c.step(true, true, STAGE_RESULT_ROLL_TICKS);
    expect(c.values(final)).toEqual({ area: 0, bonus: 0, total: 0 });
  });
});

describe('stageResultText', () => {
  it('lines the rows up and asks for the next stage', () => {
    expect(
      stageResultText({ stage: 3, values: { area: 12340, bonus: 1500, total: 13840 }, multiplierBefore: 2, multiplierNext: 2, tight: false })
    ).toBe(
      'STAGE 3 CLEAR!\n\nAREA    12340\nBONUS    1500\nTOTAL   13840\nNEXT       x2\n\nPRESS ANY KEY OR TAP FOR NEXT STAGE'
    );
  });

  it('shows the multiplier a split raised, and drops the blank lines on a small field', () => {
    const text = stageResultText({ stage: 1, values: { area: 50, bonus: 0, total: 50 }, multiplierBefore: 1, multiplierNext: 2, tight: true });
    expect(text).toBe('STAGE 1 CLEAR!\nAREA       50\nBONUS       0\nTOTAL      50\nNEXT  x1 > x2\nPRESS ANY KEY OR TAP FOR NEXT STAGE');
    const rows = text.split('\n').slice(1, 5);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
  });
});
