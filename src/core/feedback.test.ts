// Claim/miss notices (core/feedback.ts): turning them on must not change a run
// at all, and each notice must describe what actually happened.
import { describe, it, expect } from 'vitest';
import { Field } from './field';
import { Game, GameOptions } from './game';
import { GameSession } from './session';
import { Wisp } from './enemy';
import { Ember } from './patrol';
import { scoreAreaClaim, scoreStageClearBonus } from './scoring';
import { runScriptedSession } from './scriptedRun';
import { ClaimFeedback, MissFeedback } from './feedback';
import { IGNITER_SPAWN_STILL_TICKS, INITIAL_LIVES } from '../config';

const SCRIPTED_CASES = [
  { seed: 20261114, fieldWidth: 40, fieldHeight: 30 },
  { seed: 77, fieldWidth: 40, fieldHeight: 30 },
  { seed: 7 },
];

describe('captureFeedback does not change the run', () => {
  for (const options of SCRIPTED_CASES) {
    it(`seed ${options.seed}: identical summary (score, stage, lives, board, event order) with and without capture`, () => {
      const without = runScriptedSession({ ...options });
      const withCapture = runScriptedSession({ ...options, captureFeedback: true });
      expect(withCapture).toEqual(without);
    });
  }

  it('produces nothing when capture is off: every drain is empty on every tick', () => {
    let ticks = 0;
    runScriptedSession({
      seed: 20261114,
      fieldWidth: 40,
      fieldHeight: 30,
      onTick: (session) => {
        ticks++;
        expect(session.drainClaimFeedback()).toEqual([]);
        expect(session.drainMissFeedback()).toEqual([]);
        expect(session.getGame().drainClaimFeedback()).toEqual([]);
        expect(session.getGame().drainMissFeedback()).toEqual([]);
        expect(session.getGame().isCapturingFeedback()).toBe(false);
      },
    });
    expect(ticks).toBeGreaterThan(100);
  });

  it('forwards one claim notice per area-claimed and one miss notice per miss when capture is on', () => {
    let claims = 0;
    let misses = 0;
    const summary = runScriptedSession({
      seed: 77,
      fieldWidth: 40,
      fieldHeight: 30,
      captureFeedback: true,
      onTick: (session) => {
        claims += session.drainClaimFeedback().length;
        misses += session.drainMissFeedback().length;
      },
    });
    expect(claims).toBe(summary.claims);
    expect(misses).toBe(summary.misses);
    expect(claims).toBeGreaterThan(0);
    expect(misses).toBeGreaterThan(0);
  });

  it('accounts for every point: per tick, the score rises by the notices areaScore plus the excess-occupancy bonus', () => {
    for (const options of SCRIPTED_CASES) {
      let lastScore = 0;
      let claimsSeen = 0;
      runScriptedSession({
        ...options,
        captureFeedback: true,
        onTick: (session) => {
          const notices = session.drainClaimFeedback();
          const required = session.getGame().getRequiredOccupancy();
          let expected = 0;
          for (const n of notices) {
            expected += n.areaScore;
            if (n.stageCleared && !n.split) expected += scoreStageClearBonus(n.occupancyAfter, required);
          }
          claimsSeen += notices.length;
          expect(session.getScore() - lastScore).toBe(expected);
          lastScore = session.getScore();
        },
      });
      expect(claimsSeen).toBeGreaterThan(0);
    }
  });

  it('stageClearBonus is the tick score gain minus areaScore on an occupancy clear, 0 on every other claim', () => {
    let occupancyClears = 0;
    let otherClaims = 0;
    for (const options of SCRIPTED_CASES) {
      let lastScore = 0;
      runScriptedSession({
        ...options,
        captureFeedback: true,
        onTick: (session) => {
          const notices = session.drainClaimFeedback();
          const gain = session.getScore() - lastScore;
          lastScore = session.getScore();
          for (const n of notices) {
            if (n.stageCleared && !n.split) {
              occupancyClears++;
              expect(notices).toHaveLength(1);
              expect(n.stageClearBonus).toBe(gain - n.areaScore);
            } else {
              otherClaims++;
              expect(n.stageClearBonus).toBe(0);
            }
          }
        },
      });
    }
    expect(occupancyClears).toBeGreaterThan(0);
    expect(otherClaims).toBeGreaterThan(0);
  });
});

function drawDown(game: Game, ticks: number): void {
  for (let i = 0; i < ticks; i++) game.update({ dx: 0, dy: 1, drawHeld: true });
}

describe('claim notices', () => {
  const capture: GameOptions = { captureFeedback: true };

  it('describes an ordinary claim that clears the stage by occupancy', () => {
    const field = new Field(10, 5); // interior x=1..8, y=1..3 -> 24 UNCLAIMED cells
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 7, y: 0 }, wisp, undefined, capture);

    drawDown(game, 4); // straight line at x=7, closes on the bottom border

    const [notice, ...rest] = game.drainClaimFeedback();
    expect(rest).toEqual([]);
    expect(notice).toEqual<ClaimFeedback>({
      claimedCells: notice.claimedCells,
      occupancyBefore: 0,
      occupancyAfter: game.getOccupancy(),
      lineSpeed: 'fast',
      areaScore: scoreAreaClaim(notice.claimedCells, 'fast', 1),
      stageClearBonus: scoreStageClearBonus(game.getOccupancy(), game.getRequiredOccupancy()),
      multiplier: 1,
      split: false,
      stageCleared: true,
      closedLine: [
        { x: 7, y: 1 },
        { x: 7, y: 2 },
        { x: 7, y: 3 },
      ],
    });
    expect(notice.claimedCells).toBeGreaterThan(0);
    expect(notice.occupancyAfter).toBeGreaterThan(notice.occupancyBefore);
    // Draining again yields nothing.
    expect(game.drainClaimFeedback()).toEqual([]);
  });

  it('describes a claim that does not clear the stage, with its multiplier and slow speed', () => {
    const field = new Field(10, 5);
    const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 7, y: 0 }, wisp, undefined, { ...capture, requiredOccupancy: 0.9, multiplier: 3 });

    for (let i = 0; i < 8; i++) game.update({ dx: 0, dy: 1, drawHeld: true, slow: true });

    const [notice] = game.drainClaimFeedback();
    expect(notice.lineSpeed).toBe('slow');
    expect(notice.multiplier).toBe(3);
    expect(notice.areaScore).toBe(scoreAreaClaim(notice.claimedCells, 'slow', 3));
    expect(notice.stageCleared).toBe(false);
    expect(notice.split).toBe(false);
    expect(notice.stageClearBonus).toBe(0);
    expect(game.getStatus()).toBe('playing');
  });

  it('describes a split clear', () => {
    const field = new Field(10, 5);
    const leftWisp = new Wisp({ x: 2, y: 2 }, () => 0.5, Math.PI / 2);
    const rightWisp = new Wisp({ x: 7, y: 2 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 5, y: 0 }, undefined, undefined, { ...capture, wisps: [leftWisp, rightWisp] });

    drawDown(game, 4);

    const [notice] = game.drainClaimFeedback();
    expect(notice.split).toBe(true);
    expect(notice.stageCleared).toBe(true);
    expect(notice.stageClearBonus).toBe(0);
    expect(notice.closedLine).toEqual([
      { x: 5, y: 1 },
      { x: 5, y: 2 },
      { x: 5, y: 3 },
    ]);
    expect(game.getLastClearWasSplit()).toBe(true);
  });
});

describe('miss notices name the cause', () => {
  const capture: GameOptions = { captureFeedback: true };

  it('wisp: the marker steps onto a Wisp — position is the Wisp head, line is the line drawn so far', () => {
    const field = new Field(6, 5);
    const wisp = new Wisp({ x: 2, y: 1 }, () => 0.5, 0);
    const game = new Game(field, { x: 2, y: 0 }, wisp, undefined, capture);

    game.update({ dx: 0, dy: 1, drawHeld: true });

    expect(game.getLives()).toBe(INITIAL_LIVES - 1);
    const notices = game.drainMissFeedback();
    expect(notices).toEqual<MissFeedback[]>([{ cause: 'wisp', position: wisp.getPosition(), line: [{ x: 2, y: 1 }] }]);
  });

  it('wisp: a Wisp drifting into an open line before the marker moves', () => {
    // Same setup as game.test.ts's "resolves a Wisp entering the open line on
    // its closing tick as a miss before claiming".
    const field = new Field(10, 5);
    const leadingWisp = new Wisp({ x: 4, y: 3 }, () => 0.5, 0, 0.5);
    const rightWisp = new Wisp({ x: 7, y: 2 }, () => 0.5, Math.PI / 2, 0.1);
    const game = new Game(field, { x: 5, y: 0 }, undefined, undefined, { ...capture, wisps: [leadingWisp, rightWisp] });

    drawDown(game, 4);

    const [notice, ...rest] = game.drainMissFeedback();
    expect(rest).toEqual([]);
    expect(notice.cause).toBe('wisp');
    expect(notice.position).toEqual(leadingWisp.getPosition());
    expect(notice.line).toEqual([
      { x: 5, y: 1 },
      { x: 5, y: 2 },
      { x: 5, y: 3 },
    ]);
    expect(game.drainClaimFeedback()).toEqual([]);
  });

  it('ember: an Ember walks onto the idle marker — position is the marker, no line', () => {
    const field = new Field(6, 5);
    const wisp = new Wisp({ x: 3, y: 2 }, () => 0.5, 0);
    const ember = new Ember({ x: 2, y: 0 }, { dx: 1, dy: 0 });
    const game = new Game(field, { x: 3, y: 0 }, wisp, undefined, { ...capture, embers: [ember] });

    game.update({ dx: 0, dy: 0, drawHeld: false });

    expect(game.getLives()).toBe(INITIAL_LIVES - 1);
    expect(game.drainMissFeedback()).toEqual<MissFeedback[]>([{ cause: 'ember', position: { x: 3, y: 0 }, line: [] }]);
  });

  it('igniter: standing still mid-line until the Igniter catches up — position is the marker, line is the whole line', () => {
    const field = new Field(20, 20);
    const wisp = new Wisp({ x: 15, y: 15 }, () => 0.5, Math.PI / 2);
    const game = new Game(field, { x: 2, y: 0 }, wisp, undefined, capture);

    drawDown(game, 3); // line (2,1) (2,2) (2,3)
    let guard = 0;
    while (game.getLives() === INITIAL_LIVES && guard++ < IGNITER_SPAWN_STILL_TICKS + 200) {
      game.update({ dx: 0, dy: 0, drawHeld: false });
    }

    expect(game.getLives()).toBe(INITIAL_LIVES - 1);
    expect(game.drainMissFeedback()).toEqual<MissFeedback[]>([
      {
        cause: 'igniter',
        position: { x: 2, y: 3 },
        line: [
          { x: 2, y: 1 },
          { x: 2, y: 2 },
          { x: 2, y: 3 },
        ],
      },
    ]);
  });

  it('leaves the miss itself unchanged: same lives, marker, board and events as without capture', () => {
    const build = (captureFeedback: boolean): Game => {
      const field = new Field(6, 5);
      const wisp = new Wisp({ x: 2, y: 1 }, () => 0.5, 0);
      return new Game(field, { x: 2, y: 0 }, wisp, undefined, { captureFeedback });
    };
    const a = build(false);
    const b = build(true);
    for (const g of [a, b]) g.update({ dx: 0, dy: 1, drawHeld: true });
    expect(b.getLives()).toBe(a.getLives());
    expect(b.getMarker().getPosition()).toEqual(a.getMarker().getPosition());
    expect(b.getField().getAllCells()).toEqual(a.getField().getAllCells());
    expect(b.drainEvents()).toEqual(a.drainEvents());
    expect(a.drainMissFeedback()).toEqual([]);
  });
});

describe('GameSession forwards notices across a stage transition', () => {
  it('keeps the clearing claim notice after the next stage replaces the Game', () => {
    const session = new GameSession({
      captureFeedback: true,
      gameFactory: (_stage, carry) => {
        const field = new Field(10, 5);
        const wisp = new Wisp({ x: 8, y: 2 }, () => 0.5, Math.PI / 2);
        return new Game(field, { x: 7, y: 0 }, wisp, undefined, { ...carry, captureFeedback: true });
      },
    });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    for (let i = 0; i < 4; i++) session.update({ dx: 0, dy: 1, drawHeld: true, confirm: false });
    expect(session.getStatus()).toBe('stageclear');
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true }); // next stage replaces the Game
    expect(session.getStage()).toBe(2);

    const notices = session.drainClaimFeedback();
    expect(notices).toHaveLength(1);
    expect(notices[0].stageCleared).toBe(true);
    expect(session.drainClaimFeedback()).toEqual([]);
  });

  it('builds capturing Games for every stage of a seeded run', () => {
    const session = new GameSession({ seed: 1, captureFeedback: true });
    expect(session.getGame().isCapturingFeedback()).toBe(true);
    expect(new GameSession({ seed: 1 }).getGame().isCapturingFeedback()).toBe(false);
  });
});
