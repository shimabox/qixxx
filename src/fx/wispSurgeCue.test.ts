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
import { encodeRle, InputSample } from '../core/rle';
import { ReplayEngine } from '../core/replayEngine';
import type { WispSurgeFeedback } from '../core/feedback';
import { FxDirector } from './director';
import { HitStop } from './hitStop';
import { createDefaultFxParams } from './params';
import { applyImpactNotices } from './liveTick';
import { wispHeadColor } from '../render/wispShape';
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

  it('plays the cue on a seeded NORMAL run too (the seed changes nothing about it)', () => {
    const run = new LiveRun({ seed: 5 });
    const box = (): void => {
      for (const [dx, dy] of [[0, 1], [0, 1], [1, 0], [1, 0], [0, -1], [0, -1]] as const) {
        run.tick({ dx, dy, drawHeld: true, slow: false, confirm: false });
      }
    };
    box();
    // The first box's occupancy is under half of a goal of four times it;
    // the second box, sharing its side, brings it to three times.
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
   * A NORMAL run on seed 1981, recorded as a live run would be: strips down
   * and up the field from the stage's start, two cells apart, until the
   * claim that raises stage 1's level to 1 (with play going on), then a few
   * idle ticks.
   */
  function recordRunToLevelOne(seed: number): { rle: Uint8Array; levelTick: number } {
    const session = new GameSession({ seed });
    session.update(CONFIRM);
    const samples: InputSample[] = [];
    const step = (dx: -1 | 0 | 1, dy: -1 | 0 | 1, drawHeld: boolean): void => {
      samples.push({ dx, dy, drawHeld, slow: false });
      session.update({ dx, dy, drawHeld, slow: false, confirm: false });
    };
    const height = session.getGame().getField().getHeight();
    let down = true;
    let levelTick = -1;
    for (let strip = 0; strip < 60 && levelTick < 0; strip++) {
      for (let i = 0; i < height - 1 && session.getStatus() === 'playing'; i++) {
        step(0, down ? 1 : -1, true);
        if (session.getGame().getWispSurgeLevel() > 0) {
          levelTick = session.getTotalTicks();
          break;
        }
      }
      if (session.getStatus() !== 'playing') break;
      if (levelTick < 0) for (let i = 0; i < 4; i++) step(-1, 0, true);
      down = !down;
    }
    for (let i = 0; i < 10; i++) step(0, 0, false);
    return { rle: encodeRle(samples), levelTick };
  }

  it('colors the heads by the level, which rises as in the live run, and queues no notice for a cue', async () => {
    const { rle, levelTick } = recordRunToLevelOne(1981);
    expect(levelTick).toBeGreaterThan(0);
    const engine = await ReplayEngine.create(1981, rle);
    const session = engine.getSession();
    let seenLevel = 0;
    while (engine.stepTick()) {
      const level = session.getGame().getWispSurgeLevel();
      if (session.getTotalTicks() === levelTick) {
        expect(level).toBe(1);
        expect(session.getStatus()).toBe('playing');
      }
      seenLevel = Math.max(seenLevel, level);
      expect(session.drainWispSurgeFeedback()).toEqual([]);
    }
    expect(seenLevel).toBe(1);
    expect(wispHeadColor(session.getGame().getWispSurgeLevel())).toBe(COLOR_WISP_HEAD_SURGE_1);
  });
});
