// Where GameSession starts each stage's marker (core/markerStart.ts,
// GameSession.chooseMarkerStart()): stage 1 at the middle of the top edge
// without touching the rng, every later stage at one of the candidates (the
// middle of each edge), drawn from the stage's own rng with one call made
// before the Wisps'.
import { describe, it, expect } from 'vitest';
import { GameSession } from './session';
import { markerStartCandidates } from './markerStart';
import { mulberry32, deriveStageSeed } from './rng';
import { getStageConfig } from './stage';
import { GRID_WIDTH, GRID_HEIGHT } from '../config';
import { clearFromStart, sessionAtStage } from './stageStartFixture';

const CANDIDATES = markerStartCandidates(GRID_WIDTH, GRID_HEIGHT);
const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;

describe('GameSession — the marker start of each stage', () => {
  it('starts stage 1 at the middle of the top edge on every seed and field', () => {
    for (let seed = 0; seed < 50; seed++) {
      for (const [fieldWidth, fieldHeight] of [
        [GRID_WIDTH, GRID_HEIGHT],
        [49, 30],
      ]) {
        const session = new GameSession({ seed, fieldWidth, fieldHeight });
        expect(session.getMarkerStart()).toEqual({ edge: 'top', point: { x: Math.floor(fieldWidth / 2), y: 0 } });
        expect(session.getGame().getMarker().getPosition()).toEqual({ x: Math.floor(fieldWidth / 2), y: 0 });
      }
    }
  });

  it('starts every later stage on one of the candidates, the one the stage rng draws first', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const session = sessionAtStage(2, { seed });
      for (let stage = 2; stage <= 6; stage++) {
        const start = session.getMarkerStart()!;
        const index = Math.floor(mulberry32(deriveStageSeed(seed, stage))() * CANDIDATES.length);
        expect(start).toEqual(CANDIDATES[index]);
        expect(session.getGame().getMarker().getPosition()).toEqual(start.point);
        seen.add(key(start.point));
        if (stage < 6) {
          clearFromStart(session);
          session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
        }
      }
    }
    expect([...seen].sort()).toEqual(CANDIDATES.map((c) => key(c.point)).sort());
  });

  it('starts the same seed and stage at the same place every time', () => {
    for (const seed of [3, 77, 1046]) {
      const a = sessionAtStage(4, { seed });
      const b = sessionAtStage(4, { seed });
      expect(a.getMarkerStart()).toEqual(b.getMarkerStart());
      expect(a.getGame().getWisps().map((w) => w.getPosition())).toEqual(b.getGame().getWisps().map((w) => w.getPosition()));
    }
  });

});

describe('GameSession — the order the stage rng is drawn in', () => {
  /** An rng that returns queued values first, then 0.5, counting every call. */
  function queuedRng() {
    const queue: number[] = [];
    const state = { calls: 0 };
    const rng = () => {
      state.calls++;
      return queue.length > 0 ? queue.shift()! : 0.5;
    };
    return { rng, queue, state };
  }

  it('does not draw the start on stage 1: only the Wisps draw (center x, center y, one heading each)', () => {
    const { rng, state } = queuedRng();
    const session = new GameSession({ rng });
    expect(state.calls).toBe(2 + getStageConfig(1).wispCount);
    expect(session.getMarkerStart()!.point).toEqual({ x: 80, y: 0 });
  });

  it('draws the start exactly once on a later stage, before anything the Wisps draw', () => {
    for (let index = 0; index < CANDIDATES.length; index++) {
      const { rng, queue, state } = queuedRng();
      // Play stage 1 on the queued rng, then queue the start pick and the
      // cluster center (0, 0: the top-left corner of the spawn area) for the
      // stage-2 build; the headings after them read the default 0.5.
      const session = new GameSession({ rng });
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
      clearFromStart(session);
      const before = state.calls;
      queue.push((index + 0.5) / CANDIDATES.length, 0, 0);
      session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
      expect(session.getStage()).toBe(2);
      expect(state.calls - before).toBe(1 + 2 + getStageConfig(2).wispCount);
      expect(session.getMarkerStart()).toEqual(CANDIDATES[index]);
      expect(queue).toEqual([]);
      // The center's y is the second value after the pick: the top of the
      // spawn area (a top/bottom start never moves the row).
      if (CANDIDATES[index].edge === 'top' || CANDIDATES[index].edge === 'bottom') {
        for (const wisp of session.getGame().getWisps()) expect(wisp.getPosition().y).toBe(30);
      }
    }
  });
});
