// The start cue (FxDirector.onStageStart() -> FxFrame.startCue, drawn by
// src/render/startCueLayer.ts): rings closing in on the marker for the stage
// title's time as each stage starts, centred on wherever the marker is.
import { describe, it, expect } from 'vitest';
import { FxDirector, FxStartCue } from './director';
import { createDefaultFxParams } from './params';
import { startCueRing, startCueLineWidth } from '../render/startCueLayer';
import { markerStartCandidates } from '../core/markerStart';
import {
  FX_STAGE_TITLE_TICKS,
  FX_START_CUE_PULSES,
  FX_START_CUE_FROM_RADIUS_CELLS,
  FX_START_CUE_TO_RADIUS_CELLS,
  FX_START_CUE_REDUCED_RADIUS_CELLS,
  FX_START_CUE_LINE_WIDTH_PX,
  GRID_WIDTH,
  GRID_HEIGHT,
  RENDER_SCALE,
} from '../config';

/** The cue on every tick from the stage start until it is gone (index = ticks since the start). */
function cueTicks(reducedMotion: boolean, extra = 5): Array<FxStartCue | null> {
  const fx = new FxDirector(createDefaultFxParams(), { reducedMotion });
  fx.onStageStart('STAGE 2', 'NAME');
  const frames: Array<FxStartCue | null> = [];
  for (let i = 0; i < FX_STAGE_TITLE_TICKS + extra; i++) {
    frames.push(fx.getFrame().startCue);
    fx.tick();
  }
  return frames;
}

describe('FxDirector — the start cue', () => {
  it('is not there before a stage starts', () => {
    expect(new FxDirector(createDefaultFxParams()).getFrame().startCue).toBeNull();
  });

  it('shows for the stage title\'s 60 ticks from the stage start, then goes', () => {
    expect(FX_STAGE_TITLE_TICKS).toBe(60);
    for (const reduced of [false, true]) {
      const frames = cueTicks(reduced);
      for (let i = 0; i < FX_STAGE_TITLE_TICKS; i++) expect(frames[i], `tick ${i}`).not.toBeNull();
      for (let i = FX_STAGE_TITLE_TICKS; i < frames.length; i++) expect(frames[i], `tick ${i}`).toBeNull();
    }
  });

  it('closes in twice: each pulse shrinks from the large ring toward the marker and brightens', () => {
    expect(FX_START_CUE_PULSES).toBe(2);
    const frames = cueTicks(false).slice(0, FX_STAGE_TITLE_TICKS) as FxStartCue[];
    const pulse = FX_STAGE_TITLE_TICKS / FX_START_CUE_PULSES;
    let restarts = 0;
    for (let i = 1; i < frames.length; i++) {
      if (i % pulse === 0) {
        restarts++;
        expect(frames[i].radiusCells).toBe(FX_START_CUE_FROM_RADIUS_CELLS);
        continue;
      }
      expect(frames[i].radiusCells, `tick ${i}`).toBeLessThan(frames[i - 1].radiusCells);
      expect(frames[i].alpha, `tick ${i}`).toBeGreaterThan(frames[i - 1].alpha);
    }
    expect(restarts).toBe(FX_START_CUE_PULSES - 1);
    expect(frames[0].radiusCells).toBe(FX_START_CUE_FROM_RADIUS_CELLS);
    for (const f of frames) {
      expect(f.radiusCells).toBeGreaterThan(FX_START_CUE_TO_RADIUS_CELLS - 1e-9);
      expect(f.alpha).toBeGreaterThan(0);
      expect(f.alpha).toBeLessThanOrEqual(1);
    }
  });

  it('with reduced motion keeps one size and fades out', () => {
    const frames = cueTicks(true).slice(0, FX_STAGE_TITLE_TICKS) as FxStartCue[];
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i].radiusCells).toBe(FX_START_CUE_REDUCED_RADIUS_CELLS);
      if (i > 0) expect(frames[i].alpha).toBeLessThan(frames[i - 1].alpha);
    }
    expect(frames[0].alpha).toBe(1);
  });

  it('starts again on the next stage, and is dropped by a reset (back to Title, into a replay)', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onStageStart('STAGE 1', 'A');
    for (let i = 0; i < 40; i++) fx.tick();
    fx.onStageStart('STAGE 2', 'B');
    expect(fx.getFrame().startCue).toMatchObject({ age: 0, radiusCells: FX_START_CUE_FROM_RADIUS_CELLS });
    fx.reset();
    expect(fx.getFrame().startCue).toBeNull();
  });

  it('is not shown when the stage title is turned off', () => {
    const params = createDefaultFxParams();
    params.stageTitleTicks = 0;
    const fx = new FxDirector(params);
    fx.onStageStart('STAGE 2', 'B');
    expect(fx.getFrame().startCue).toBeNull();
  });
});

describe('startCueRing — the ring is centred on the marker', () => {
  const middleOf = (p: { x: number; y: number }) => ({ x: (p.x + 0.5) * RENDER_SCALE, y: (p.y + 0.5) * RENDER_SCALE });

  it('on every start, on every tick, with and without reduced motion', () => {
    for (const reduced of [false, true]) {
      const frames = cueTicks(reduced, 0);
      for (const { edge, point } of markerStartCandidates(GRID_WIDTH, GRID_HEIGHT)) {
        for (const [i, cue] of frames.entries()) {
          const ring = startCueRing(cue, point);
          expect(ring, `${edge} tick ${i}`).not.toBeNull();
          expect({ x: ring!.x, y: ring!.y }).toEqual(middleOf(point));
          expect(ring!.radius).toBeCloseTo(cue!.radiusCells * RENDER_SCALE);
        }
      }
    }
  });

  it('follows the marker when it moves during the cue, on each of the four edges', () => {
    const inward = { top: { x: 0, y: 1 }, bottom: { x: 0, y: -1 }, left: { x: 1, y: 0 }, right: { x: -1, y: 0 } } as const;
    for (const reduced of [false, true]) {
      const frames = cueTicks(reduced, 0);
      for (const { edge, point } of markerStartCandidates(GRID_WIDTH, GRID_HEIGHT)) {
        // Walk in from the start one cell a tick, then along the edge.
        let marker = { ...point };
        for (const [i, cue] of frames.entries()) {
          const ring = startCueRing(cue, marker)!;
          expect({ x: ring.x, y: ring.y }, `${edge} tick ${i}`).toEqual(middleOf(marker));
          const step = i < 10 ? inward[edge] : { x: inward[edge].y, y: inward[edge].x };
          marker = { x: marker.x + step.x, y: marker.y + step.y };
        }
      }
    }
  });

  it('keeps its line at FX_START_CUE_LINE_WIDTH_PX, thicker only when a small field needs it', () => {
    expect(startCueLineWidth()).toBe(FX_START_CUE_LINE_WIDTH_PX);
    expect(startCueLineWidth(1)).toBe(FX_START_CUE_LINE_WIDTH_PX);
    expect(startCueLineWidth(6.5)).toBe(6.5);
    expect(startCueLineWidth(Number.NaN)).toBe(FX_START_CUE_LINE_WIDTH_PX);
  });

  it('draws nothing without a cue or a marker', () => {
    expect(startCueRing(null, { x: 1, y: 0 })).toBeNull();
    expect(startCueRing({ age: 0, radiusCells: 5, alpha: 1 }, undefined)).toBeNull();
    expect(startCueRing({ age: 59, radiusCells: 5, alpha: 0 }, { x: 1, y: 0 })).toBeNull();
  });
});
