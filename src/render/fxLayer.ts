// Draws the impact feedback (src/fx/director.ts's FxFrame) on the game
// canvas: the closed line's glow and the split flash, the vanished line's
// shards, the "+score" popups, SPLIT! and the miss flash. Called by Renderer
// in its draw order; every function takes logical (CANVAS_WIDTH x
// CANVAS_HEIGHT) coordinates and leaves the context state as it found it.
import type { Point } from '../core/field';
import type { FxFlash, FxLineGlow, FxPopup, FxShard } from '../fx/director';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  RENDER_SCALE,
  COLOR_LINE,
  COLOR_FX_FLASH_LIGHT,
  COLOR_FX_FLASH_DARK,
  COLOR_FX_OUTLINE,
  COLOR_FX_POPUP,
  COLOR_FX_SPLIT,
  COLOR_CLAIMED_SLOW,
} from '../config';

const GRID_W = CANVAS_WIDTH / RENDER_SCALE;
const GRID_H = CANVAS_HEIGHT / RENDER_SCALE;
const POPUP_FONT_PX = 22;
const POPUP_NOTE_FONT_PX = 14;
const POPUP_RISE_PX = 28;
const SPLIT_TEXT = 'SPLIT!';
const SPLIT_WIDTH_SHARE = 0.6; // of the field width

function cellCenter(c: Point): { x: number; y: number } {
  return { x: (c.x + 0.5) * RENDER_SCALE, y: (c.y + 0.5) * RENDER_SCALE };
}

/** The closed line glowing white (and, for a split, extended to the field edges). */
export function drawLineGlows(ctx: CanvasRenderingContext2D, glows: readonly FxLineGlow[]): void {
  if (glows.length === 0) return;
  ctx.save();
  ctx.fillStyle = COLOR_FX_FLASH_LIGHT;
  ctx.strokeStyle = COLOR_FX_FLASH_LIGHT;
  ctx.shadowColor = COLOR_FX_FLASH_LIGHT;
  for (const glow of glows) {
    if (glow.cells.length === 0 || glow.intensity <= 0) continue;
    ctx.globalAlpha = Math.min(1, glow.intensity);
    if (glow.extendToEdges) {
      ctx.shadowBlur = 16;
      ctx.lineWidth = RENDER_SCALE * 1.5;
      ctx.lineCap = 'square';
      ctx.beginPath();
      for (const [from, dir] of lineEnds(glow.cells)) {
        const start = cellCenter(from);
        const end = cellCenter(walkToEdge(from, dir));
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 8;
    const pad = RENDER_SCALE * 0.25;
    for (const c of glow.cells) {
      ctx.fillRect(c.x * RENDER_SCALE - pad, c.y * RENDER_SCALE - pad, RENDER_SCALE + pad * 2, RENDER_SCALE + pad * 2);
    }
  }
  ctx.restore();
}

/** Both ends of a line with the direction pointing away from the line. */
function lineEnds(cells: readonly Point[]): Array<[Point, { dx: number; dy: number }]> {
  if (cells.length === 1) {
    return [
      [cells[0], { dx: 0, dy: -1 }],
      [cells[0], { dx: 0, dy: 1 }],
    ];
  }
  const first = cells[0];
  const second = cells[1];
  const last = cells[cells.length - 1];
  const beforeLast = cells[cells.length - 2];
  return [
    [first, { dx: Math.sign(first.x - second.x), dy: Math.sign(first.y - second.y) }],
    [last, { dx: Math.sign(last.x - beforeLast.x), dy: Math.sign(last.y - beforeLast.y) }],
  ];
}

function walkToEdge(from: Point, dir: { dx: number; dy: number }): Point {
  if (dir.dx === 0 && dir.dy === 0) return from;
  let x = from.x;
  let y = from.y;
  while (x + dir.dx >= 0 && x + dir.dx < GRID_W && y + dir.dy >= 0 && y + dir.dy < GRID_H) {
    x += dir.dx;
    y += dir.dy;
  }
  return { x, y };
}

/** The vanished line's cells, breaking away and fading. */
export function drawShards(ctx: CanvasRenderingContext2D, shards: readonly FxShard[]): void {
  if (shards.length === 0) return;
  ctx.save();
  ctx.fillStyle = COLOR_LINE;
  ctx.shadowColor = COLOR_LINE;
  ctx.shadowBlur = 4;
  for (const s of shards) {
    if (s.alpha <= 0) continue;
    ctx.globalAlpha = s.alpha;
    const size = RENDER_SCALE * (0.6 + 0.4 * s.alpha);
    const cx = (s.x + 0.5 + s.offsetX) * RENDER_SCALE;
    const cy = (s.y + 0.5 + s.offsetY) * RENDER_SCALE;
    ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
  }
  ctx.restore();
}

/**
 * "+score" popups, floating up and fading out. `positionOf` gives the
 * popup's center in cells (the centroid of the cells it was scored for).
 */
export function drawPopups(
  ctx: CanvasRenderingContext2D,
  popups: readonly FxPopup[],
  positionOf: (popup: FxPopup) => { x: number; y: number }
): void {
  if (popups.length === 0) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COLOR_FX_OUTLINE;
  for (const popup of popups) {
    const at = positionOf(popup);
    const x = clamp((at.x + 0.5) * RENDER_SCALE, 48, CANVAS_WIDTH - 48);
    const y = clamp((at.y + 0.5) * RENDER_SCALE - popup.progress * POPUP_RISE_PX, 20, CANVAS_HEIGHT - 28);
    ctx.globalAlpha = popup.progress < 0.7 ? 1 : Math.max(0, (1 - popup.progress) / 0.3);
    ctx.font = `bold ${POPUP_FONT_PX}px monospace`;
    ctx.lineWidth = 5;
    ctx.strokeText(popup.text, x, y);
    ctx.fillStyle = COLOR_FX_POPUP;
    ctx.fillText(popup.text, x, y);
    if (popup.note) {
      ctx.font = `bold ${POPUP_NOTE_FONT_PX}px monospace`;
      ctx.lineWidth = 4;
      const ny = y + POPUP_FONT_PX * 0.85;
      ctx.strokeText(popup.note, x, ny);
      ctx.fillStyle = COLOR_CLAIMED_SLOW;
      ctx.fillText(popup.note, x, ny);
    }
  }
  ctx.restore();
}

/** SPLIT!, sized to SPLIT_WIDTH_SHARE of the field's width. */
export function drawSplitBanner(ctx: CanvasRenderingContext2D, progress: number): void {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.font = 'bold 100px monospace';
  const naturalWidth = ctx.measureText(SPLIT_TEXT).width || 1;
  // A quick pop-in over the first tenth, a fade over the last fifth.
  const pop = progress < 0.1 ? 1.25 - 2.5 * progress : 1;
  const fontPx = Math.round(((100 * CANVAS_WIDTH * SPLIT_WIDTH_SHARE) / naturalWidth) * pop);
  ctx.font = `bold ${fontPx}px monospace`;
  ctx.globalAlpha = progress < 0.8 ? 1 : Math.max(0, (1 - progress) / 0.2);
  ctx.lineWidth = Math.max(6, fontPx * 0.12);
  ctx.strokeStyle = COLOR_FX_OUTLINE;
  ctx.strokeText(SPLIT_TEXT, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
  ctx.shadowColor = COLOR_FX_SPLIT;
  ctx.shadowBlur = 18;
  ctx.fillStyle = COLOR_FX_SPLIT;
  ctx.fillText(SPLIT_TEXT, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
  ctx.restore();
}

/** The miss flash: a light burst, then a dark one, centered on the contact. */
export function drawFlash(ctx: CanvasRenderingContext2D, flash: FxFlash): void {
  if (flash.kind === 'none' || flash.intensity <= 0) return;
  const center = flash.center ? cellCenter(flash.center) : { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
  const radius = Math.hypot(CANVAS_WIDTH, CANVAS_HEIGHT);
  const gradient = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
  const color = flash.kind === 'light' ? COLOR_FX_FLASH_LIGHT : COLOR_FX_FLASH_DARK;
  const inner = flash.kind === 'light' ? 0.85 : 0.15;
  const outer = flash.kind === 'light' ? 0.2 : 0.7;
  gradient.addColorStop(0, withAlpha(color, inner * flash.intensity));
  gradient.addColorStop(1, withAlpha(color, outer * flash.intensity));
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(-RENDER_SCALE * 4, -RENDER_SCALE * 4, CANVAS_WIDTH + RENDER_SCALE * 8, CANVAS_HEIGHT + RENDER_SCALE * 8);
  ctx.restore();
}

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
