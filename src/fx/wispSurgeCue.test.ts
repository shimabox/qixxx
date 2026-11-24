// The Wisp surge cue (the ring from every Wisp head and the surge sound),
// through a live tick's back half (applyImpactNotices()) with a real
// GameSession and FxDirector: once for a claim that raises the surge level
// and leaves play going on, and never for anything else. A ranking replay
// and the Title demo (both a ReplayEngine's session) color the heads by the
// level but never get a cue.
import { describe, it, expect } from 'vitest';
import { GameSession, SessionInput, SessionOptions } from '../core/session';
import { Game } from '../core/game';
import { Field } from '../core/field';
import { Wisp } from '../core/enemy';
import { encodeRle } from '../core/rle';
import { ReplayEngine } from '../core/replayEngine';
import { lateSurgeRises, playSurgeRun } from '../core/surgeRunFixture';
import type { WispSurgeFeedback } from '../core/feedback';
import { FxDirector } from './director';
import { HitStop } from './hitStop';
import { createDefaultFxParams } from './params';
import { applyImpactNotices } from './liveTick';
import { wispHeadColor } from '../render/wispShape';
import {
  boardFxFrame,
  boardWispDraws,
  BoardSources,
  drawnBoardGame,
  renderedFxFrame,
  shownTitleDemoEngine,
  stepReplayView,
} from '../replayView';
import { ReplayStageClearHold } from '../replayStageClearHold';
import { TitleDemo } from '../titleDemo';
import { surgeCueLineWidth, surgeCueRings } from '../render/surgeCueLayer';
import { hintMarkShapes, HINT_RING_OUTLINE_WIDTH_PX } from '../render/hintLayer';
import { COLOR_WISP_HEAD, COLOR_WISP_HEAD_SURGE_1, COLOR_WISP_HEAD_SURGE_2, FX_START_CUE_MIN_LINE_DISPLAY_PX, RENDER_SCALE } from '../config';

const CONFIRM: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: true };
const W = 21;
const H = 12;

/**
 * A 21 x 12 stage (190 claimable cells) whose Wisps go straight up and down
 * their own columns, with the marker on the top edge at x=2: closing one
 * full-height strip after another from the left gives occupancies of 10, 30,
 * 50, 70, 90, 110 and 130 / 190. On a goal of 0.70 the fourth strip raises
 * the level to 1 and the seventh to 2.
 */
function stripGame(options: { requiredOccupancy?: number; wispColumns?: number[] } = {}) {
  return (_stage: number, carry: { score: number; lives: number; multiplier: number }) => {
    const wisps = (options.wispColumns ?? [18, 17]).map((x, i) => new Wisp({ x, y: 3 + i * 2 }, () => 0.5, Math.PI / 2));
    return new Game(new Field(W, H), { x: 2, y: 0 }, undefined, () => 0.5, {
      wisps,
      requiredOccupancy: options.requiredOccupancy ?? 0.7,
      emberSpawnIntervalTicks: 1_000_000,
      captureFeedback: true,
      wispSurge: true,
      ...carry,
    });
  };
}

/** A live run: every tick goes through applyImpactNotices() as main.ts's does; every cue started is counted. */
class LiveRun {
  readonly session: GameSession;
  readonly fx = new FxDirector(createDefaultFxParams());
  readonly cues: Array<1 | 2> = [];
  readonly sounds: Array<1 | 2> = [];
  private readonly hitStop = new HitStop();

  constructor(options: SessionOptions) {
    this.session = new GameSession({ captureFeedback: true, ...options });
    this.tick(CONFIRM);
  }

  tick(input: SessionInput): void {
    this.fx.tick();
    this.session.update(input);
    this.session.drainEvents();
    this.session.drainDespawnedEmberPositions();
    const fx = {
      onClaim: this.fx.onClaim.bind(this.fx),
      onMiss: this.fx.onMiss.bind(this.fx),
      onWispSurge: (notice: WispSurgeFeedback) => {
        this.cues.push(notice.level);
        this.fx.onWispSurge(notice);
      },
    };
    applyImpactNotices(this.session, fx, this.hitStop, {
      playClaim: () => {},
      playSplitImpact: () => {},
      playWispSurge: (level) => this.sounds.push(level),
    });
  }

  /** Closes strip `strip` of stripGame() (down on even strips, up on odd ones), then steps two cells right. */
  closeStrip(strip: number): void {
    const dy = strip % 2 === 0 ? 1 : -1;
    for (let i = 0; i < H - 1; i++) this.tick({ dx: 0, dy, drawHeld: true, slow: false, confirm: false });
    for (let i = 0; i < 2; i++) this.tick({ dx: 1, dy: 0, drawHeld: true, slow: false, confirm: false });
  }
}

describe('the Wisp surge cue in live play', () => {
  it('starts the ring from every Wisp head and the sound once each, on the claim that raises the level, and on no other claim', () => {
    const run = new LiveRun({ gameFactory: stripGame() });
    // The stage start: nothing.
    expect(run.cues).toEqual([]);
    expect(run.fx.getFrame().surgeRings).toEqual([]);
    for (let strip = 0; strip < 3; strip++) run.closeStrip(strip);
    expect(run.cues).toEqual([]);
    expect(run.sounds).toEqual([]);

    // The fourth strip's closing tick: level 1.
    for (let i = 0; i < H - 1; i++) run.tick({ dx: 0, dy: -1, drawHeld: true, slow: false, confirm: false });
    expect(run.session.getGame().getWispSurgeLevel()).toBe(1);
    expect(run.cues).toEqual([1]);
    expect(run.sounds).toEqual([1]);
    const rings = run.fx.getFrame().surgeRings;
    const heads = run.session.getGame().getWisps().map((w) => w.getPosition());
    expect(rings.map((r) => r.center)).toEqual(heads);
    expect(rings.every((r) => r.level === 1 && r.alpha === 1)).toBe(true);
    expect(surgeCueRings(rings).map((r) => r.color)).toEqual([COLOR_WISP_HEAD_SURGE_1, COLOR_WISP_HEAD_SURGE_1]);
    expect(surgeCueRings(rings)[0].x).toBe((heads[0].x + 0.5) * RENDER_SCALE);

    // The ring is shown for 30 ticks.
    const idle: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };
    for (let i = 0; i < 29; i++) run.tick(idle);
    expect(run.fx.getFrame().surgeRings).toHaveLength(2);
    run.tick(idle);
    expect(run.fx.getFrame().surgeRings).toEqual([]);

    // Strips 5 and 6 stay on level 1: nothing more.
    for (let i = 0; i < 2; i++) run.tick({ dx: 1, dy: 0, drawHeld: true, slow: false, confirm: false });
    run.closeStrip(4);
    run.closeStrip(5);
    expect(run.session.getGame().getWispSurgeLevel()).toBe(1);
    expect(run.cues).toEqual([1]);
    expect(run.fx.getFrame().surgeRings).toEqual([]);

    // The seventh: level 2, once more.
    run.closeStrip(6);
    expect(run.session.getGame().getWispSurgeLevel()).toBe(2);
    expect(run.session.getStatus()).toBe('playing');
    expect(run.cues).toEqual([1, 2]);
    expect(run.sounds).toEqual([1, 2]);
  });

  it('plays the cue on a seeded NORMAL run too (the seed changes nothing about it), from stage 6', () => {
    const run = new LiveRun({ seed: 5 });
    const inward = { top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0] } as const;
    /** From where the marker stands on the stage's start edge: two cells in, two along the edge and back out. */
    const box = (): void => {
      const [ix, iy] = inward[run.session.getMarkerStart()!.edge];
      const [ax, ay] = ix === 0 ? [1, 0] : [0, 1];
      for (const [dx, dy] of [[ix, iy], [ix, iy], [ax, ay], [ax, ay], [-ix, -iy], [-ix, -iy]]) {
        run.tick({ dx: dx as -1 | 0 | 1, dy: dy as -1 | 0 | 1, drawHeld: true, slow: false, confirm: false });
      }
    };
    // Stages 1 to 5, each cleared by a box on a goal lowered to almost nothing.
    for (let stage = 1; stage <= 5; stage++) {
      expect(run.session.getStage()).toBe(stage);
      run.session.applyDebugOverrides({ requiredOccupancy: 0.00001 });
      box();
      expect(run.session.getStatus()).toBe('stageclear');
      run.tick(CONFIRM);
    }
    expect(run.session.getStage()).toBe(6);
    expect(run.cues).toEqual([]);
    // A goal out of reach for the first box; then a goal of four times its
    // occupancy, under half of which it is; the second box, sharing its
    // side, brings it to three times.
    run.session.applyDebugOverrides({ requiredOccupancy: 0.99 });
    box();
    run.session.applyDebugOverrides({ requiredOccupancy: run.session.getGame().getOccupancy() * 4 });
    expect(run.cues).toEqual([]);
    box();
    expect(run.session.getStatus()).toBe('playing');
    expect(run.session.getGame().getWispSurgeLevel()).toBe(2);
    expect(run.cues).toEqual([2]);
    expect(run.sounds).toEqual([2]);
  });

  it('plays no cue for a claim that clears the stage on occupancy, though it raises the level', () => {
    const run = new LiveRun({ gameFactory: stripGame({ requiredOccupancy: 0.15 }) });
    run.closeStrip(0);
    run.closeStrip(1);
    expect(run.session.getStatus()).toBe('stageclear');
    expect(run.session.getGame().getWispSurgeLevel()).toBe(2);
    expect(run.cues).toEqual([]);
    expect(run.sounds).toEqual([]);
  });

  it('plays no cue for a claim that clears the stage with a split, though it raises the level', () => {
    const run = new LiveRun({ gameFactory: stripGame({ requiredOccupancy: 0.6, wispColumns: [7, 18] }) });
    for (let strip = 0; strip < 4; strip++) run.closeStrip(strip);
    expect(run.session.getStatus()).toBe('stageclear');
    expect(run.session.getGame().getLastClearWasSplit()).toBe(true);
    expect(run.session.getGame().getWispSurgeLevel()).toBe(2);
    expect(run.cues).toEqual([]);
    expect(run.sounds).toEqual([]);
  });

  it('plays no cue when time runs out on the very tick of the claim that raises the level', () => {
    // Three strips (13 ticks each), then the fourth strip's 11 ticks: tick 50 closes it.
    const upToClaim = (run: LiveRun) => {
      for (let strip = 0; strip < 3; strip++) run.closeStrip(strip);
      for (let i = 0; i < H - 1; i++) run.tick({ dx: 0, dy: -1, drawHeld: true, slow: false, confirm: false });
    };
    const timedOut = new LiveRun({ gameFactory: stripGame(), timeLimitTicks: 50 });
    upToClaim(timedOut);
    expect(timedOut.session.getTotalTicks()).toBe(50);
    expect(timedOut.session.getStatus()).toBe('gameover');
    expect(timedOut.session.getGameOverReason()).toBe('time');
    expect(timedOut.session.getGame().getWispSurgeLevel()).toBe(1);
    expect(timedOut.cues).toEqual([]);
    expect(timedOut.sounds).toEqual([]);

    // One tick more of time, and the same claim plays it.
    const inTime = new LiveRun({ gameFactory: stripGame(), timeLimitTicks: 51 });
    upToClaim(inTime);
    expect(inTime.session.getStatus()).toBe('playing');
    expect(inTime.cues).toEqual([1]);
    expect(inTime.sounds).toEqual([1]);
  });

  it('plays no cue when a debug override changes the level, up or down', () => {
    const run = new LiveRun({ gameFactory: stripGame() });
    for (let strip = 0; strip < 3; strip++) run.closeStrip(strip);
    expect(run.session.getGame().getWispSurgeLevel()).toBe(0);
    run.session.applyDebugOverrides({ requiredOccupancy: 0.3 });
    expect(run.session.getGame().getWispSurgeLevel()).toBe(2);
    run.tick({ dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false });
    run.session.applyDebugOverrides({ requiredOccupancy: 0.9 });
    expect(run.session.getGame().getWispSurgeLevel()).toBe(0);
    run.tick({ dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false });
    expect(run.cues).toEqual([]);
    expect(run.sounds).toEqual([]);
    expect(run.fx.getFrame().surgeRings).toEqual([]);
  });
});

describe('FxDirector — the Wisp surge rings', () => {
  const notice: WispSurgeFeedback = { level: 2, positions: [{ x: 4, y: 5 }] };

  it('spread from 7.5 to 12 cells while fading over 30 ticks, and stay 8 cells with reduced motion', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onWispSurge(notice);
    expect(fx.getFrame().surgeRings).toEqual([{ center: { x: 4, y: 5 }, radiusCells: 7.5, alpha: 1, level: 2 }]);
    for (let i = 0; i < 15; i++) fx.tick();
    expect(fx.getFrame().surgeRings).toEqual([{ center: { x: 4, y: 5 }, radiusCells: 9.75, alpha: 0.5, level: 2 }]);

    const reduced = new FxDirector(createDefaultFxParams(), { reducedMotion: true });
    reduced.onWispSurge(notice);
    for (let i = 0; i < 15; i++) reduced.tick();
    expect(reduced.getFrame().surgeRings).toEqual([{ center: { x: 4, y: 5 }, radiusCells: 8, alpha: 0.5, level: 2 }]);
  });

  it('stay clear of the hint ring around the same Wisp, line widths included, on every tick and with reduced motion', () => {
    const head = { x: 40, y: 30 };
    // The thinnest field shown (a phone held sideways, ~0.3x) gives the widest surge line.
    const lineWidths = [surgeCueLineWidth(0), surgeCueLineWidth(FX_START_CUE_MIN_LINE_DISPLAY_PX / 0.3)];
    for (const reducedMotion of [false, true]) {
      // The hint ring's outer edge, over a whole pulse of its age.
      let hintOuter = 0;
      for (let age = 0; age < 80; age++) {
        const ring = hintMarkShapes({ kind: 'ring', centers: [head] }, age, reducedMotion)!.rings[0];
        hintOuter = Math.max(hintOuter, ring.radius + HINT_RING_OUTLINE_WIDTH_PX / 2);
      }
      const fx = new FxDirector(createDefaultFxParams(), { reducedMotion });
      fx.onWispSurge({ level: 1, positions: [head] });
      let frames = 0;
      while (fx.getFrame().surgeRings.length > 0) {
        const [ring] = surgeCueRings(fx.getFrame().surgeRings, [head]);
        if (ring) {
          frames++;
          for (const lineWidth of lineWidths) expect(ring.radius - lineWidth / 2).toBeGreaterThan(hintOuter);
        }
        fx.tick();
      }
      expect(frames).toBe(30);
    }
  });

  it('are drawn on each Wisp head as it is now, or where the head was when its Wisp is gone', () => {
    const rings = [
      { center: { x: 4, y: 5 }, radiusCells: 3, alpha: 0.5, level: 1 as const },
      { center: { x: 9, y: 9 }, radiusCells: 3, alpha: 0.5, level: 1 as const },
    ];
    const drawn = surgeCueRings(rings, [{ x: 6, y: 7 }]);
    expect(drawn.map((r) => ({ x: r.x, y: r.y }))).toEqual([
      { x: 6.5 * RENDER_SCALE, y: 7.5 * RENDER_SCALE },
      { x: 9.5 * RENDER_SCALE, y: 9.5 * RENDER_SCALE },
    ]);
    expect(drawn.map((r) => r.radius)).toEqual([3 * RENDER_SCALE, 3 * RENDER_SCALE]);
    expect(drawn.map((r) => r.color)).toEqual([COLOR_WISP_HEAD_SURGE_1, COLOR_WISP_HEAD_SURGE_1]);
    // A faded-out ring is not drawn.
    expect(surgeCueRings([{ ...rings[0], alpha: 0 }])).toEqual([]);
  });

  it('go with the board: dropped as the next stage starts and on a reset', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onWispSurge(notice);
    fx.resetBoard();
    expect(fx.getFrame().surgeRings).toEqual([]);
    fx.onWispSurge(notice);
    fx.reset();
    expect(fx.getFrame().surgeRings).toEqual([]);
  });
});

describe('the Wisp head color', () => {
  it('is COLOR_WISP_HEAD on level 0 and the surge colors above it', () => {
    expect(wispHeadColor(0)).toBe(COLOR_WISP_HEAD);
    expect(wispHeadColor(1)).toBe('#ff6ad5');
    expect(wispHeadColor(2)).toBe('#ff3d81');
    expect(COLOR_WISP_HEAD_SURGE_2).toBe('#ff3d81');
  });
});

describe('the Wisp surge in a replay and the Title demo (a ReplayEngine session)', () => {
  /**
   * The stage 6 surge run (core/surgeRunFixture.ts: a NORMAL run with no
   * debug override, to GAME OVER), played live — every tick through
   * applyImpactNotices(), as main.ts's does — and recorded. Its stage 6
   * claims raise the level to 1 and then to 2, each with play going on.
   */
  function recordSurgeRun(): {
    seed: number;
    rle: Uint8Array;
    level1Tick: number;
    level2Tick: number;
    liveCues: number[];
    liveSounds: number[];
    liveRings: number[];
  } {
    const fx = new FxDirector(createDefaultFxParams());
    const hitStop = new HitStop();
    const liveCues: number[] = [];
    const liveSounds: number[] = [];
    const liveRings: number[] = [];
    let level = 0;
    const run = playSurgeRun({
      captureFeedback: true,
      onTick: (session) => {
        fx.tick();
        applyImpactNotices(
          session,
          {
            onClaim: fx.onClaim.bind(fx),
            onMiss: fx.onMiss.bind(fx),
            onWispSurge: (notice) => {
              liveCues.push(notice.level);
              fx.onWispSurge(notice);
            },
          },
          hitStop,
          { playClaim: () => {}, playSplitImpact: () => {}, playWispSurge: (lv) => liveSounds.push(lv) }
        );
        const now = session.getGame().getWispSurgeLevel();
        if (now > level) liveRings.push(boardFxFrame('live', fx)!.surgeRings.length);
        level = now;
      },
    });
    const { level1, level2 } = lateSurgeRises(run.rises);
    return {
      seed: run.seed,
      rle: encodeRle(run.samples),
      level1Tick: level1?.tick ?? -1,
      level2Tick: level2?.tick ?? -1,
      liveCues,
      liveSounds,
      liveRings,
    };
  }

  /** The live run behind the replay or the demo: built, on its Title screen, so its board is level 0. */
  function liveOnTitle(): GameSession {
    const live = new GameSession({ seed: 5, captureFeedback: true });
    expect(live.getStatus()).toBe('title');
    return live;
  }

  /** The heads drawn: the Wisps main.ts's renderFrame() hands the renderer for this board state, each head's color by its level. */
  const headColorsDrawn = (sources: BoardSources): string[] =>
    boardWispDraws(drawnBoardGame(sources)).map((draw) => wispHeadColor(draw.surgeLevel ?? 0));

  const levelColor = (level: number): string => [COLOR_WISP_HEAD, COLOR_WISP_HEAD_SURGE_1, COLOR_WISP_HEAD_SURGE_2][level];

  it('draws the heads in the level color through the replay view, which rises as in the live run, with no ring and no sound', async () => {
    const recorded = recordSurgeRun();
    expect(recorded.level1Tick).toBeGreaterThan(0);
    expect(recorded.level2Tick).toBeGreaterThan(recorded.level1Tick);
    // Live, the same claims played the cue: a ring on every Wisp and the sound, each time.
    expect(recorded.liveCues).toEqual([1, 2]);
    expect(recorded.liveSounds).toEqual([1, 2]);
    expect(recorded.liveRings).toEqual([2, 2]);

    // The replay view's tick and frame (src/replayView.ts, as main.ts runs
    // them). The tick is given neither the impact effects nor the sounds;
    // even the replay session's notices, handed to them as a live tick's
    // are, start no ring and play no sound. The board is chosen as
    // renderFrame() does (drawnBoardGame()), with the live run behind the
    // replay on level 0 all along.
    const engine = await ReplayEngine.create(recorded.seed, recorded.rle);
    const session = engine.getSession();
    const live = liveOnTitle();
    const sources: BoardSources = { viewMode: 'replay', live, replay: engine, titleDemo: { getShownEngine: () => null } };
    const hold = new ReplayStageClearHold(30);
    const fx = new FxDirector(createDefaultFxParams());
    const hitStop = new HitStop();
    const ringCalls: WispSurgeFeedback[] = [];
    const sounds: number[] = [];
    const fxSinks = {
      onClaim: fx.onClaim.bind(fx),
      onMiss: fx.onMiss.bind(fx),
      onWispSurge: (notice: WispSurgeFeedback) => {
        ringCalls.push(notice);
        fx.onWispSurge(notice);
      },
    };
    const soundSinks = { playClaim: () => {}, playSplitImpact: () => {}, playWispSurge: (level: 1 | 2) => sounds.push(level) };

    expect(drawnBoardGame(sources)).toBe(session.getGame());
    expect(headColorsDrawn(sources).every((color) => color === COLOR_WISP_HEAD)).toBe(true);
    const checked: number[] = [];
    let seenLevel = 0;
    while (stepReplayView(engine, hold)) {
      fx.tick();
      expect(applyImpactNotices(session, fxSinks, hitStop, soundSinks)).toEqual({ claims: [], misses: [] });
      expect(live.getGame().getWispSurgeLevel()).toBe(0);
      const level = session.getGame().getWispSurgeLevel();
      const colors = headColorsDrawn(sources);
      expect(colors.length).toBeGreaterThan(0);
      expect(colors.every((color) => color === levelColor(level))).toBe(true);
      // No frame of impact effects is drawn over a replay, so no ring.
      expect(boardFxFrame('replay', fx)).toBeNull();
      expect(renderedFxFrame(boardFxFrame('replay', fx), shownTitleDemoEngine(sources) !== null)).toBeUndefined();
      for (const [riseLevel, riseTick] of [
        [1, recorded.level1Tick],
        [2, recorded.level2Tick],
      ]) {
        if (session.getTotalTicks() === riseTick && !checked.includes(riseLevel)) {
          checked.push(riseLevel);
          expect(session.getStage()).toBe(6);
          expect(level).toBe(riseLevel);
          expect(session.getStatus()).toBe('playing');
          expect(colors.every((color) => color === levelColor(riseLevel))).toBe(true);
          expect(colors.every((color) => color !== COLOR_WISP_HEAD)).toBe(true);
          expect(ringCalls).toEqual([]);
          expect(fx.getFrame().surgeRings).toEqual([]);
          expect(sounds).toEqual([]);
        }
      }
      seenLevel = Math.max(seenLevel, level);
    }
    expect(checked).toEqual([1, 2]);
    expect(seenLevel).toBe(2);
    expect(session.getStatus()).toBe('gameover');
    expect(ringCalls).toEqual([]);
    expect(fx.getFrame().surgeRings).toEqual([]);
    expect(sounds).toEqual([]);
  });

  it('draws the heads in the level color through the Title demo, which plays on past the claim that raises it, with no ring and no sound', async () => {
    const recorded = recordSurgeRun();
    expect(recorded.level1Tick).toBeGreaterThan(0);
    expect(recorded.level2Tick).toBeGreaterThan(recorded.level1Tick);
    expect(recorded.liveCues).toEqual([1, 2]);

    // The Title demo as main.ts builds it (src/titleDemo.ts, stepped once per
    // tick by step(), which plays the run through its own stepEngine()), over
    // the recorded run's replay and a real ReplayEngine.
    const demo = new TitleDemo<ReplayEngine>({
      fetchReplay: async () => ({ seed: recorded.seed, rleBase64: 'recorded' }),
      isPlayable: (payload): payload is { seed: number; rleBase64: string } => payload !== null,
      decode: () => recorded.rle,
      createEngine: (record, signal) => ReplayEngine.create(record.seed, record.rle, { signal }),
      startDelayTicks: 1,
      endHoldTicks: 1,
      stageClearHoldTicks: 30,
    });
    const onTitle = { onTitle: true, allowed: true, candidates: ['best'] };
    // The live run behind it, on its Title screen, and its tick's back half
    // (main.ts's update(): the live tick, then the demo's), with every ring
    // and sound started counted. The board is chosen as renderFrame() does
    // (drawnBoardGame()), with the live run's own board on level 0 all along.
    const live = liveOnTitle();
    const sources: BoardSources = { viewMode: 'live', live, replay: null, titleDemo: demo };
    const fx = new FxDirector(createDefaultFxParams());
    const hitStop = new HitStop();
    const ringCalls: WispSurgeFeedback[] = [];
    const sounds: number[] = [];
    const fxSinks = {
      onClaim: fx.onClaim.bind(fx),
      onMiss: fx.onMiss.bind(fx),
      onWispSurge: (notice: WispSurgeFeedback) => {
        ringCalls.push(notice);
        fx.onWispSurge(notice);
      },
    };
    const soundSinks = { playClaim: () => {}, playSplitImpact: () => {}, playWispSurge: (level: 1 | 2) => sounds.push(level) };
    const idle: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: false };
    const tick = (): void => {
      fx.tick();
      live.update(idle);
      live.drainEvents();
      live.drainDespawnedEmberPositions();
      applyImpactNotices(live, fxSinks, hitStop, soundSinks);
      demo.step(onTitle);
    };

    for (let i = 0; i < 200 && demo.getState() !== 'playing'; i++) {
      tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(demo.getState()).toBe('playing');
    expect(live.getStatus()).toBe('title');

    const checked: number[] = [];
    let seenLevel = 0;
    let frames = 0;
    while (demo.getState() === 'playing') {
      tick();
      const engine = shownTitleDemoEngine(sources);
      expect(engine).not.toBeNull();
      expect(engine).toBe(demo.getShownEngine());
      const session = engine!.getSession();
      expect(drawnBoardGame(sources)).toBe(session.getGame());
      expect(live.getStatus()).toBe('title');
      expect(live.getGame().getWispSurgeLevel()).toBe(0);
      // Even the demo session's notices, handed to the effects and the sounds
      // as a live tick's are, start no ring and play no sound.
      expect(applyImpactNotices(session, fxSinks, hitStop, soundSinks)).toEqual({ claims: [], misses: [] });
      const level = session.getGame().getWispSurgeLevel();
      const colors = headColorsDrawn(sources);
      expect(colors.length).toBeGreaterThan(0);
      expect(colors.every((color) => color === levelColor(level))).toBe(true);
      // The frame drawn over the demo's board (main.ts's renderFrame()): no
      // impact effects at all, so no ring.
      expect(renderedFxFrame(boardFxFrame(sources.viewMode, fx), shownTitleDemoEngine(sources) !== null)).toBeUndefined();
      for (const [riseLevel, riseTick] of [
        [1, recorded.level1Tick],
        [2, recorded.level2Tick],
      ]) {
        if (session.getTotalTicks() === riseTick && !checked.includes(riseLevel)) {
          checked.push(riseLevel);
          expect(session.getStage()).toBe(6);
          expect(level).toBe(riseLevel);
          // The run plays on past that claim (not a stage clear, not the end).
          expect(session.getStatus()).toBe('playing');
          expect(demo.getState()).toBe('playing');
          expect(colors.every((color) => color === levelColor(riseLevel))).toBe(true);
          expect(ringCalls).toEqual([]);
          expect(fx.getFrame().surgeRings).toEqual([]);
          expect(sounds).toEqual([]);
        }
      }
      seenLevel = Math.max(seenLevel, level);
      frames++;
    }
    expect(demo.getState()).toBe('ended');
    expect(frames).toBeGreaterThan(recorded.level2Tick);
    expect(checked).toEqual([1, 2]);
    expect(seenLevel).toBe(2);
    expect(ringCalls).toEqual([]);
    expect(fx.getFrame().surgeRings).toEqual([]);
    expect(sounds).toEqual([]);
  });
});

describe('renderedFxFrame', () => {
  it('hands the live frame of impact effects to the renderer, and none over the Title demo board', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onWispSurge({ level: 2, positions: [{ x: 4, y: 5 }] });
    const frame = boardFxFrame('live', fx);
    expect(renderedFxFrame(frame, false)).toBe(frame);
    expect(renderedFxFrame(frame, false)!.surgeRings).toHaveLength(1);
    expect(renderedFxFrame(frame, true)).toBeUndefined();
    expect(renderedFxFrame(boardFxFrame('replay', fx), false)).toBeUndefined();
  });
});
