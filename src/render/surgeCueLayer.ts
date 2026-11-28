// Draws the Wisp surge cue (src/fx/director.ts's FxSurgeRing): a ring
// spreading out around each Wisp head as a claim raised the surge level, in
// that level's head color. Each ring is centred on its Wisp's head as the
// frame is drawn, so it stays on the Wisp as it moves; one whose Wisp is
// gone stays where the head was. Logical (CANVAS_WIDTH x CANVAS_HEIGHT)
// coordinates; clipped to the field. No text.
import type { FxSurgeRing } from '../fx/director';
import type { Point } from '../core/field';
import { CANVAS_WIDTH, CANVAS_HEIGHT, RENDER_SCALE, WISP_SURGE_CUE_LINE_WIDTH_PX, WISP_SURGE_CUE_GLOW_BLUR } from '../config';
import { wispHeadColor } from './wispShape';

/** One ring drawn for one frame, in logical canvas px. */
export interface SurgeCueRing {
  /** Centre: the middle of the head's cell. */
  x: number;
  y: number;
  radius: number;
  alpha: number;
  color: string;
}

/**
 * The rings to draw for `rings`, leaving out the ones with nothing to show.
 * Ring i is centred on `heads[i]` (the Wisps' heads, in order, as drawn this
 * frame) when there is one, else on where its head was as the level rose.
 */
export function surgeCueRings(rings: readonly FxSurgeRing[], heads: ReadonlyArray<Readonly<Point> | undefined> = []): SurgeCueRing[] {
  const shown: SurgeCueRing[] = [];
  rings.forEach((ring, i) => {
    if (ring.alpha <= 0 || ring.radiusCells <= 0) return;
    const center = heads[i] ?? ring.center;
    shown.push({
      x: (center.x + 0.5) * RENDER_SCALE,
      y: (center.y + 0.5) * RENDER_SCALE,
      radius: ring.radiusCells * RENDER_SCALE,
      alpha: Math.min(1, ring.alpha),
      color: wispHeadColor(ring.level),
    });
  });
  return shown;
}

/**
 * The rings' line width (logical px): WISP_SURGE_CUE_LINE_WIDTH_PX, or
 * `minLineWidthPx` when that is wider.
 */
export function surgeCueLineWidth(minLineWidthPx = 0): number {
  return Math.max(WISP_SURGE_CUE_LINE_WIDTH_PX, Number.isFinite(minLineWidthPx) ? minLineWidthPx : 0);
}

/**
 * Draws every ring, clipped to the field, leaving the context as it found it.
 * `minLineWidthPx` (logical px) keeps the line from thinning out on a field
 * shown small, as for the start cue (Renderer.setStartCueMinLineWidthPx()).
 */
export function drawSurgeRings(ctx: CanvasRenderingContext2D, rings: readonly SurgeCueRing[], minLineWidthPx = 0): void {
  const lineWidth = surgeCueLineWidth(minLineWidthPx);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.clip();
  for (const ring of rings) {
    ctx.globalAlpha = ring.alpha;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
    // All in the level's color, glow included, so it reads as the head's.
    ctx.shadowColor = ring.color;
    ctx.shadowBlur = WISP_SURGE_CUE_GLOW_BLUR;
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
  ctx.restore();
}
