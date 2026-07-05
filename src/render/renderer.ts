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
  COLOR_WISP_HEAD,
  COLOR_EMBER,
  COLOR_IGNITER,
  GLOW_BLUR_ENTITY,
  GLOW_BLUR_LINE,
  GLOW_BLUR_FIELD_EDGE,
  WISP_TRAIL_ALPHA_NEAR,
  WISP_TRAIL_ALPHA_FAR,
} from '../config';

// Parsed once from COLOR_WISP_HEAD so the trail's per-segment fade (docs/plan.md
// §6 M5 "Wispの残像表現の強化") can build an rgba() string with a varying
// alpha instead of drawing every segment at the same flat opacity.
const WISP_TRAIL_RGB = hexToRgb(COLOR_WISP_HEAD);

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private backgroundLayer: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // devicePixelRatio support (docs/plan.md §5.3): the internal resolution
    // is scaled up by the device pixel ratio for crispness on high-DPI
    // screens, then ctx.scale() folds that factor back in so every existing
    // draw call below keeps using the same logical (grid-cell * RENDER_SCALE)
    // coordinate system — nothing downstream needs to know DPR exists.
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = CANVAS_WIDTH * dpr;
    this.canvas.height = CANVAS_HEIGHT * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context from canvas');
    }
    ctx.scale(dpr, dpr);
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

  render(
    field: Field,
    markerPosition?: Point,
    wispTrails?: Point[][],
    emberPositions?: Point[],
    igniterPosition?: Point | null,
    markerVisible = true
  ): void {
    // Static background (fill + grid pattern) in a single draw call
    this.ctx.drawImage(this.backgroundLayer, 0, 0);
    this.drawField(field);
    this.drawFieldEdgeGlow();
    if (wispTrails) {
      // docs/plan.md §3.7/§4.2: stage 3+ has 2 Wisps; each gets its own
      // afterimage trail + head, drawn independently.
      for (const trail of wispTrails) {
        if (trail.length > 0) {
          this.drawWisp(trail);
        }
      }
    }
    if (emberPositions && emberPositions.length > 0) {
      this.drawEmbers(emberPositions);
    }
    if (igniterPosition) {
      this.drawIgniter(igniterPosition);
    }
    // Post-miss grace feedback (docs/plan.md §6 M5): the caller blinks the
    // marker by toggling `markerVisible` off every few ticks; omitting the
    // draw call entirely (rather than e.g. changing color) makes it a true
    // blink against the field/background behind it.
    if (markerPosition && markerVisible) {
      this.drawMarker(markerPosition);
    }
  }

  // A single cheap (O(1), not O(cells)) neon glow stroke around the whole
  // playfield (docs/plan.md §1/§6 M5 "ネオングロー表現"). Kept separate from
  // the per-cell BORDER fill in drawField() below, which stays glow-free —
  // shadowBlur on every one of the (up to tens of thousands of) BORDER/
  // CLAIMED cells would be the single easiest way to blow the 60fps budget
  // (docs/plan.md §7.3).
  private drawFieldEdgeGlow(): void {
    this.ctx.save();
    this.ctx.shadowColor = COLOR_BORDER;
    this.ctx.shadowBlur = GLOW_BLUR_FIELD_EDGE;
    this.ctx.strokeStyle = COLOR_BORDER;
    this.ctx.lineWidth = RENDER_SCALE;
    this.ctx.strokeRect(
      RENDER_SCALE / 2,
      RENDER_SCALE / 2,
      CANVAS_WIDTH - RENDER_SCALE,
      CANVAS_HEIGHT - RENDER_SCALE
    );
    this.ctx.restore();
  }

  private drawField(field: Field): void {
    const width = field.getWidth();
    const height = field.getHeight();

    // Direct double loop - no intermediate array allocation per frame.
    // UNCLAIMED cells show the pre-rendered background, so only other states need fillRect.
    // LINE is drawn with a small glow (docs/plan.md §6 M5): its cell count is
    // bounded by the in-progress line's length, never the full field, so
    // shadowBlur here stays cheap — unlike BORDER/CLAIMED below, which are
    // deliberately left glow-free (see drawFieldEdgeGlow's comment).
    this.ctx.save();
    this.ctx.shadowColor = COLOR_LINE;
    this.ctx.shadowBlur = GLOW_BLUR_LINE;
    for (let y = 0; y < height; y++) {
      const py = y * RENDER_SCALE;
      for (let x = 0; x < width; x++) {
        const state: CellState = field.getAt(x, y);
        if (state === UNCLAIMED) continue;

        switch (state) {
          case BORDER:
            this.ctx.shadowBlur = 0;
            this.ctx.fillStyle = COLOR_BORDER;
            break;
          case CLAIMED_FAST:
            this.ctx.shadowBlur = 0;
            this.ctx.fillStyle = COLOR_CLAIMED_FAST;
            break;
          case CLAIMED_SLOW:
            this.ctx.shadowBlur = 0;
            this.ctx.fillStyle = COLOR_CLAIMED_SLOW;
            break;
          case LINE:
            this.ctx.shadowBlur = GLOW_BLUR_LINE;
            this.ctx.fillStyle = COLOR_LINE;
            break;
          default:
            continue;
        }
        this.ctx.fillRect(x * RENDER_SCALE, py, RENDER_SCALE, RENDER_SCALE);
      }
    }
    this.ctx.restore();
  }

  // Draws the Wisp's afterimage trail (older history first, more transparent
  // — docs/plan.md §6 M5 "Wispの残像表現の強化") followed by a glowing head,
  // so the head is always painted on top and brightest.
  private drawWisp(trail: Point[]): void {
    for (let i = trail.length - 1; i >= 1; i--) {
      const p = trail[i];
      // Older (higher index) segments fade toward WISP_TRAIL_ALPHA_FAR;
      // the segment right behind the head sits near WISP_TRAIL_ALPHA_NEAR.
      const t = trail.length > 2 ? (i - 1) / (trail.length - 2) : 0;
      const alpha = WISP_TRAIL_ALPHA_NEAR + (WISP_TRAIL_ALPHA_FAR - WISP_TRAIL_ALPHA_NEAR) * t;
      this.ctx.fillStyle = `rgba(${WISP_TRAIL_RGB.r}, ${WISP_TRAIL_RGB.g}, ${WISP_TRAIL_RGB.b}, ${alpha})`;
      this.ctx.fillRect(p.x * RENDER_SCALE, p.y * RENDER_SCALE, RENDER_SCALE, RENDER_SCALE);
    }

    this.ctx.save();
    this.ctx.shadowColor = COLOR_WISP_HEAD;
    this.ctx.shadowBlur = GLOW_BLUR_ENTITY;
    this.ctx.fillStyle = COLOR_WISP_HEAD;
    const head = trail[0];
    this.ctx.fillRect(head.x * RENDER_SCALE, head.y * RENDER_SCALE, RENDER_SCALE, RENDER_SCALE);
    this.ctx.restore();
  }

  // Draws each Ember (border-patrol enemy) as a glowing solid cell.
  private drawEmbers(positions: Point[]): void {
    this.ctx.save();
    this.ctx.shadowColor = COLOR_EMBER;
    this.ctx.shadowBlur = GLOW_BLUR_ENTITY;
    this.ctx.fillStyle = COLOR_EMBER;
    for (const p of positions) {
      this.ctx.fillRect(p.x * RENDER_SCALE, p.y * RENDER_SCALE, RENDER_SCALE, RENDER_SCALE);
    }
    this.ctx.restore();
  }

  // Draws the Igniter (line-chasing enemy) as a glowing solid cell along the line it's climbing.
  private drawIgniter(position: Point): void {
    this.ctx.save();
    this.ctx.shadowColor = COLOR_IGNITER;
    this.ctx.shadowBlur = GLOW_BLUR_ENTITY;
    this.ctx.fillStyle = COLOR_IGNITER;
    this.ctx.fillRect(position.x * RENDER_SCALE, position.y * RENDER_SCALE, RENDER_SCALE, RENDER_SCALE);
    this.ctx.restore();
  }

  private drawMarker(position: Point): void {
    this.ctx.save();
    this.ctx.shadowColor = COLOR_MARKER;
    this.ctx.shadowBlur = GLOW_BLUR_ENTITY;
    this.ctx.fillStyle = COLOR_MARKER;
    this.ctx.fillRect(position.x * RENDER_SCALE, position.y * RENDER_SCALE, RENDER_SCALE, RENDER_SCALE);
    this.ctx.restore();
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}
