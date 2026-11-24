// Where GameSession spawns each stage's Wisp cluster relative to the
// marker's start (GameSession.buildWisps()): the cluster center keeps
// WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN columns from a top/bottom start
// column and WISP_SPAWN_MIN_OFFSET_FROM_MARKER_ROW rows from a left/right
// start row, so one straight line in from the start cannot cut it apart.
import { describe, it, expect } from 'vitest';
import { GameSession } from './session';
import { sessionAtStage, clearFromStart } from './stageStartFixture';
import { Point } from './field';
import { markerStartCandidates, MarkerStartEdge } from './markerStart';
import { getStageConfig } from './stage';
import {
  GRID_WIDTH,
  GRID_HEIGHT,
  WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN,
  WISP_SPAWN_MIN_OFFSET_FROM_MARKER_ROW,
} from '../config';

const positions = (session: GameSession): Point[] => session.getGame().getWisps().map((w) => w.getPosition());

describe("GameSession — stage 1's Wisp is where the seed puts it", () => {
  // Stage 1 always starts at the top middle and has one Wisp, so a seed puts
  // that Wisp in one fixed place, pinned here — on the default field, and on
  // a 49-wide one where the push away from the start column (24 +/- 15)
  // leaves the spawn area (x in [9.8, 39.2]) on the left.
  const STAGE_1: ReadonlyArray<{ seed: number; width?: number; height?: number; wisps: Point[] }> = [
    { seed: 1, wisps: [{ x: 122, y: 50 }] },
    { seed: 3, wisps: [{ x: 53, y: 64 }] },
    { seed: 42, wisps: [{ x: 119, y: 39 }] },
    { seed: 542, wisps: [{ x: 41, y: 60 }] },
    { seed: 9999, wisps: [{ x: 105, y: 52 }] },
    // These two draw a center near the start column, so it is pushed away (left, then right).
    { seed: 10, wisps: [{ x: 65, y: 87 }] },
    { seed: 12, wisps: [{ x: 95, y: 65 }] },
    { seed: 1, width: 49, height: 30, wisps: [{ x: 39, y: 13 }] },
    { seed: 3, width: 49, height: 30, wisps: [{ x: 9, y: 16 }] },
    { seed: 42, width: 49, height: 30, wisps: [{ x: 39, y: 10 }] },
    { seed: 120, width: 49, height: 30, wisps: [{ x: 9, y: 15 }] },
    { seed: 1352, width: 49, height: 30, wisps: [{ x: 39, y: 9 }] },
  ];

  for (const { seed, width, height, wisps } of STAGE_1) {
    it(`seed ${seed} on ${width ?? GRID_WIDTH}x${height ?? GRID_HEIGHT}`, () => {
      const session = new GameSession({ seed, fieldWidth: width, fieldHeight: height });
      expect(session.getMarkerStart()!.point).toEqual({ x: Math.floor((width ?? GRID_WIDTH) / 2), y: 0 });
      expect(positions(session)).toEqual(wisps);
    });
  }
});

describe('GameSession — Wisps keep away from the line straight in from any start', () => {
  /** Every Wisp is inside the field's interior (never on a border cell). */
  function expectInside(wisps: Point[], width: number, height: number, label: string): void {
    for (const { x, y } of wisps) {
      expect(x, label).toBeGreaterThanOrEqual(1);
      expect(x, label).toBeLessThanOrEqual(width - 2);
      expect(y, label).toBeGreaterThanOrEqual(1);
      expect(y, label).toBeLessThanOrEqual(height - 2);
    }
  }

  it('keeps the cluster center 15+ columns from a top/bottom start and 15+ rows from a left/right start, stages 2-15 over many seeds', () => {
    const edgesSeen = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const session = sessionAtStage(2, { seed });
      for (let stage = 2; stage <= 15; stage++) {
        const start = session.getMarkerStart()!;
        const wisps = positions(session);
        const label = `seed ${seed} stage ${stage} start ${JSON.stringify(start)} wisps ${JSON.stringify(wisps)}`;
        expect(wisps).toHaveLength(getStageConfig(stage).wispCount);
        expectInside(wisps, GRID_WIDTH, GRID_HEIGHT, label);
        if (start.edge === 'top' || start.edge === 'bottom') {
          // The center is halfway between the outermost Wisps; rounding each
          // to a whole cell moves that point by up to half a cell.
          const xs = wisps.map((w) => w.x);
          const center = (Math.min(...xs) + Math.max(...xs)) / 2;
          expect(Math.abs(center - start.point.x), label).toBeGreaterThanOrEqual(WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN - 0.5);
        } else {
          // The Wisps stand in one row: the center's row.
          expect(new Set(wisps.map((w) => w.y)).size, label).toBe(1);
          expect(Math.abs(wisps[0].y - start.point.y), label).toBeGreaterThanOrEqual(WISP_SPAWN_MIN_OFFSET_FROM_MARKER_ROW);
        }
        edgesSeen.add(start.edge);
        if (stage < 15) {
          clearFromStart(session);
          session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
        }
      }
    }
    expect([...edgesSeen].sort()).toEqual(['bottom', 'left', 'right', 'top']);
  });

  it('keeps every Wisp inside a small field, from any start', () => {
    for (let seed = 0; seed < 20; seed++) {
      const session = sessionAtStage(2, { seed, fieldWidth: 49, fieldHeight: 30 });
      for (let stage = 2; stage <= 6; stage++) {
        expectInside(positions(session), 49, 30, `seed ${seed} stage ${stage}`);
        if (stage < 6) {
          clearFromStart(session);
          session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
        }
      }
    }
  });
});

describe('GameSession — the push away from a left/right start row', () => {
  /** An rng that returns queued values first, then 0.5. */
  function queuedRng() {
    const queue: number[] = [];
    return { rng: () => (queue.length > 0 ? queue.shift()! : 0.5), queue };
  }

  /** Stage 2 built from the queued start pick and cluster center draws. */
  function stage2With(pick: number, centerX: number, centerY: number, field: { fieldWidth?: number; fieldHeight?: number } = {}) {
    const { rng, queue } = queuedRng();
    const session = new GameSession({ rng, ...field });
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    clearFromStart(session);
    queue.push(pick, centerX, centerY);
    session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
    return session;
  }

  /** The start-pick draw that selects the candidate on `edge`. */
  function pickOf(edge: MarkerStartEdge, width = GRID_WIDTH, height = GRID_HEIGHT): number {
    const candidates = markerStartCandidates(width, height);
    const index = candidates.findIndex((c) => c.edge === edge);
    return (index + 0.5) / candidates.length;
  }
  // On the default field both side starts are at y = 60, and the center's y
  // is round(30 + r * 60) for the cluster-center draw r.
  const rFor = (y: number) => (y - 30) / 60;

  it('moves a center at or below the start row to start + 15, and one above it to start - 15', () => {
    // Left, y = 60: a center on the row goes down; just above goes up.
    expect(positions(stage2With(pickOf('left'), 0.5, rFor(60)))[0].y).toBe(75);
    expect(positions(stage2With(pickOf('left'), 0.5, rFor(59)))[0].y).toBe(45);
    expect(positions(stage2With(pickOf('left'), 0.5, rFor(70)))[0].y).toBe(75);
    // Right, y = 60: already 15 away stays put; 14 away goes out to 15.
    expect(positions(stage2With(pickOf('right'), 0.5, rFor(45)))[0].y).toBe(45);
    expect(positions(stage2With(pickOf('right'), 0.5, rFor(46)))[0].y).toBe(45);
    expect(positions(stage2With(pickOf('right'), 0.5, rFor(75)))[0].y).toBe(75);
    expect(positions(stage2With(pickOf('right'), 0.5, rFor(74)))[0].y).toBe(75);
  });

  it('does not push the other way when the push leaves the field, and only the clamp keeps it inside', () => {
    // On a 40 x 30 field the side starts are at y = 15 and the center's y is
    // round(7.5 + r * 15), in [8, 23]. Pushed 15 rows from the start row it
    // lands on y = 30 or 0, outside the field, and the clamp brings it back
    // to the last row inside on the same side.
    const small = { fieldWidth: 40, fieldHeight: 30 };
    const rSmall = (y: number) => (y - 7.5) / 15;
    for (const edge of ['left', 'right'] as const) {
      expect(markerStartCandidates(40, 30).find((c) => c.edge === edge)!.point.y).toBe(15);
      expect(positions(stage2With(pickOf(edge, 40, 30), 0.5, rSmall(15), small))[0].y, edge).toBe(28);
      expect(positions(stage2With(pickOf(edge, 40, 30), 0.5, rSmall(22), small))[0].y, edge).toBe(28);
      expect(positions(stage2With(pickOf(edge, 40, 30), 0.5, rSmall(14), small))[0].y, edge).toBe(1);
      expect(positions(stage2With(pickOf(edge, 40, 30), 0.5, rSmall(8), small))[0].y, edge).toBe(1);
    }
  });

  it('leaves the x of a left/right start cluster alone', () => {
    // The center's x is round(32 + r * 96); a left start at x = 0 or a
    // right start at x = 159 is far from it either way.
    const xs = positions(stage2With(pickOf('left'), 0.5, rFor(60))).map((w) => w.x);
    // round(32 + 0.5 * 96) = 80, give or take the half cell the rounding of each Wisp adds.
    expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 80)).toBeLessThanOrEqual(0.5);
  });
});
