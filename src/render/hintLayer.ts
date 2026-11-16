// The in-play hints' marks on the field (src/hints/): a white ring around
// the hint's target, and the drawing hint's arrow from the marker into the
// field. Drawn by Renderer over everything else and outside the shake, like
// the miss reason, since it is there to be seen. The shapes are worked out
// here as plain numbers (unit tested), then drawn.
//
// Both pulse from the hint's own age in ticks, so they never depend on the
// frame rate; with reduced motion they hold still.
import { Field, Point, UNCLAIMED } from '../core/field';
import { HINT_ARROW_LENGTH_CELLS, HINT_RING_RADIUS_CELLS, RENDER_SCALE } from '../config';

/** One pulse every this many ticks. */
const PULSE_PERIOD_TICKS = 40;
const RING_COLOR = '#ffffff';
const RING_OUTLINE = 'rgba(10, 14, 39, 0.85)';
// The arrow starts this far from the marker's center, so it does not cover it.
const ARROW_START_CELLS = 2;

export interface HintRingShape {
  x: number;
  y: number;
  radius: number;
  alpha: number;
}

export interface HintArrowShape {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  alpha: number;
}

/** What Renderer draws for the hint this frame, in canvas (logical) px. */
export interface HintMarkShapes {
  rings: HintRingShape[];
  arrow: HintArrowShape | null;
}

/** The mark's target, resolved to cells by main.ts. */
export type ResolvedHintMark =
  | { kind: 'ring'; centers: ReadonlyArray<Readonly<Point>> }
  | { kind: 'arrow'; from: Readonly<Point>; dir: { dx: number; dy: number } };

/** 0..1, from the hint's age; 1 (held) with reduced motion. */
export function hintPulse(age: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  return 0.5 + 0.5 * Math.cos((age * 2 * Math.PI) / PULSE_PERIOD_TICKS);
}

function cellCenter(c: Readonly<Point>): { x: number; y: number } {
  return { x: (c.x + 0.5) * RENDER_SCALE, y: (c.y + 0.5) * RENDER_SCALE };
}

export function hintMarkShapes(mark: ResolvedHintMark | null, age: number, reducedMotion: boolean): HintMarkShapes | null {
  if (mark === null) return null;
  const pulse = hintPulse(age, reducedMotion);
  if (mark.kind === 'ring') {
    if (mark.centers.length === 0) return null;
    const radius = HINT_RING_RADIUS_CELLS * RENDER_SCALE * (0.85 + 0.15 * pulse);
    const alpha = 0.55 + 0.45 * pulse;
    return { rings: mark.centers.map((c) => ({ ...cellCenter(c), radius, alpha })), arrow: null };
  }
  const from = cellCenter(mark.from);
  const start = ARROW_START_CELLS * RENDER_SCALE;
  const end = (ARROW_START_CELLS + HINT_ARROW_LENGTH_CELLS) * RENDER_SCALE;
  return {
    rings: [],
    arrow: {
      x0: from.x + mark.dir.dx * start,
      y0: from.y + mark.dir.dy * start,
      x1: from.x + mark.dir.dx * end,
      y1: from.y + mark.dir.dy * end,
      alpha: 0.55 + 0.45 * pulse,
    },
  };
}

const DIRECTIONS = [
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
] as const;

/**
 * The way into the field from the marker for the drawing hint's arrow:
 * a direction whose next cell is unclaimed. Several (a corner) go to the one
 * across the nearer outer edge, i.e. away from it. Null when none — the
 * arrow is then left out and the line alone is shown.
 */
export function hintArrowDirection(field: Field, marker: Readonly<Point>): { dx: number; dy: number } | null {
  const open = DIRECTIONS.filter((d) => field.getAt(marker.x + d.dx, marker.y + d.dy) === UNCLAIMED);
  if (open.length === 0) return null;
  if (open.length === 1) return { ...open[0] };
  const w = field.getWidth();
  const h = field.getHeight();
  // Distance to the outer edge each direction points away from.
  const awayFrom = (d: { dx: number; dy: number }): number =>
    d.dy === 1 ? marker.y : d.dy === -1 ? h - 1 - marker.y : d.dx === 1 ? marker.x : w - 1 - marker.x;
  let best = open[0];
  for (const d of open) if (awayFrom(d) < awayFrom(best)) best = d;
  return { ...best };
}

/** Draws the shapes (Renderer.render(), last). */
export function drawHintMarks(ctx: CanvasRenderingContext2D, shapes: HintMarkShapes): void {
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const ring of shapes.rings) {
    ctx.globalAlpha = ring.alpha;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
    ctx.lineWidth = RENDER_SCALE * 1.2;
    ctx.strokeStyle = RING_OUTLINE;
    ctx.stroke();
    ctx.lineWidth = RENDER_SCALE * 0.6;
    ctx.strokeStyle = RING_COLOR;
    ctx.stroke();
  }
  const arrow = shapes.arrow;
  if (arrow) {
    const angle = Math.atan2(arrow.y1 - arrow.y0, arrow.x1 - arrow.x0);
    const head = RENDER_SCALE * 2.5;
    const path = (): void => {
      ctx.beginPath();
      ctx.moveTo(arrow.x0, arrow.y0);
      ctx.lineTo(arrow.x1, arrow.y1);
      ctx.moveTo(arrow.x1 - head * Math.cos(angle - Math.PI / 5), arrow.y1 - head * Math.sin(angle - Math.PI / 5));
      ctx.lineTo(arrow.x1, arrow.y1);
      ctx.lineTo(arrow.x1 - head * Math.cos(angle + Math.PI / 5), arrow.y1 - head * Math.sin(angle + Math.PI / 5));
    };
    ctx.globalAlpha = arrow.alpha;
    path();
    ctx.lineWidth = RENDER_SCALE * 1.4;
    ctx.strokeStyle = RING_OUTLINE;
    ctx.stroke();
    path();
    ctx.lineWidth = RENDER_SCALE * 0.7;
    ctx.strokeStyle = RING_COLOR;
    ctx.stroke();
  }
  ctx.restore();
}
