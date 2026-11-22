// Draws the start cue (src/fx/director.ts's FxStartCue): a neon ring around
// the marker as a stage starts. The ring takes its centre from the marker's
// position when the frame is drawn, so it stays on the marker if the player
// moves during the cue. Logical (CANVAS_WIDTH x CANVAS_HEIGHT) coordinates;
// the ring is clipped to the field, so on a start at an edge only the half
// inside the field shows.
import type { Point } from '../core/field';
import type { FxStartCue } from '../fx/director';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  RENDER_SCALE,
  COLOR_FX_START_CUE,
  COLOR_FX_NEON_CORE,
  FX_START_CUE_LINE_WIDTH_PX,
  FX_START_CUE_CORE_WIDTH_RATIO,
  FX_START_CUE_GLOW_BLUR,
} from '../config';

/** The ring drawn for one frame, in logical canvas px. */
export interface StartCueRing {
  /** Centre: the middle of the marker's cell. */
  x: number;
  y: number;
  radius: number;
  alpha: number;
}

/** Where `cue`'s ring goes around a marker at `marker`, or null when there is nothing to draw. */
export function startCueRing(cue: FxStartCue | null, marker: Point | undefined): StartCueRing | null {
  if (!cue || !marker || cue.alpha <= 0 || cue.radiusCells <= 0) return null;
  return {
    x: (marker.x + 0.5) * RENDER_SCALE,
    y: (marker.y + 0.5) * RENDER_SCALE,
    radius: cue.radiusCells * RENDER_SCALE,
    alpha: Math.min(1, cue.alpha),
  };
}

/** The ring's line width (logical px): FX_START_CUE_LINE_WIDTH_PX, or `minPx` when that is thicker. */
export function startCueLineWidth(minPx = 0): number {
  return Math.max(FX_START_CUE_LINE_WIDTH_PX, Number.isFinite(minPx) ? minPx : 0);
}

/**
 * Draws `ring`, clipped to the field, leaving the context as it found it.
 * `minLineWidthPx` (logical px) keeps the line from thinning out on a field
 * shown small — see Renderer.setStartCueMinLineWidthPx().
 */
export function drawStartCue(ctx: CanvasRenderingContext2D, ring: StartCueRing, minLineWidthPx = 0): void {
  const lineWidth = startCueLineWidth(minLineWidthPx);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.clip();
  ctx.globalAlpha = ring.alpha;
  ctx.beginPath();
  ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
  // A cyan glow with a thin white core, like the effects' neon text.
  ctx.shadowColor = COLOR_FX_START_CUE;
  ctx.shadowBlur = FX_START_CUE_GLOW_BLUR;
  ctx.strokeStyle = COLOR_FX_START_CUE;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = COLOR_FX_NEON_CORE;
  ctx.lineWidth = lineWidth * FX_START_CUE_CORE_WIDTH_RATIO;
  ctx.stroke();
  ctx.restore();
}
