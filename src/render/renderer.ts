import { Field, Point, BORDER, CLAIMED_FAST, CLAIMED_SLOW, LINE, UNCLAIMED, CellState } from '../core/field';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  RENDER_SCALE,
  COLOR_BACKGROUND,
  COLOR_BORDER,
  COLOR_CLAIMED_FAST,
  COLOR_CLAIMED_SLOW,
  COLOR_GRID_LINE,
  COLOR_LINE,
  COLOR_MARKER,
} from '../config';

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private backgroundLayer: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context from canvas');
    }
    this.ctx = ctx;

    // Pre-render the static background (fill + subtle grid pattern) once.
    // Per-frame rendering becomes a single drawImage instead of ~19k strokeRect calls.
    this.backgroundLayer = this.createBackgroundLayer();
  }

  private createBackgroundLayer(): HTMLCanvasElement {
    const layer = document.createElement('canvas');
    layer.width = CANVAS_WIDTH;
    layer.height = CANVAS_HEIGHT;

    const ctx = layer.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context for background layer');
    }

    ctx.fillStyle = COLOR_BACKGROUND;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Subtle grid pattern drawn as full-length lines (one-time cost)
    ctx.strokeStyle = COLOR_GRID_LINE;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = 0; x <= CANVAS_WIDTH; x += RENDER_SCALE) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_HEIGHT);
    }
    for (let y = 0; y <= CANVAS_HEIGHT; y += RENDER_SCALE) {
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_WIDTH, y);
    }
    ctx.stroke();

    return layer;
  }

  render(field: Field, markerPosition?: Point): void {
    // Static background (fill + grid pattern) in a single draw call
    this.ctx.drawImage(this.backgroundLayer, 0, 0);
    this.drawField(field);
    if (markerPosition) {
      this.drawMarker(markerPosition);
    }
  }

  private drawField(field: Field): void {
    const width = field.getWidth();
    const height = field.getHeight();

    // Direct double loop - no intermediate array allocation per frame.
    // UNCLAIMED cells show the pre-rendered background, so only other states need fillRect.
    for (let y = 0; y < height; y++) {
      const py = y * RENDER_SCALE;
      for (let x = 0; x < width; x++) {
        const state: CellState = field.getAt(x, y);
        if (state === UNCLAIMED) continue;

        switch (state) {
          case BORDER:
            this.ctx.fillStyle = COLOR_BORDER;
            break;
          case CLAIMED_FAST:
            this.ctx.fillStyle = COLOR_CLAIMED_FAST;
            break;
          case CLAIMED_SLOW:
            this.ctx.fillStyle = COLOR_CLAIMED_SLOW;
            break;
          case LINE:
            this.ctx.fillStyle = COLOR_LINE;
            break;
          default:
            continue;
        }
        this.ctx.fillRect(x * RENDER_SCALE, py, RENDER_SCALE, RENDER_SCALE);
      }
    }
  }

  private drawMarker(position: Point): void {
    this.ctx.fillStyle = COLOR_MARKER;
    this.ctx.fillRect(position.x * RENDER_SCALE, position.y * RENDER_SCALE, RENDER_SCALE, RENDER_SCALE);
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
}
