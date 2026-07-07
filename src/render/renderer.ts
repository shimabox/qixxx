import { Field, Point, BORDER, CLAIMED_FAST, CLAIMED_SLOW, LINE, UNCLAIMED, CellState } from '../core/field';
import type { Ember } from '../core/patrol';
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
  COLOR_EMBER_BLAZE,
  COLOR_IGNITER,
  GLOW_BLUR_ENTITY,
  GLOW_BLUR_LINE,
  GLOW_BLUR_FIELD_EDGE,
  WISP_TRAIL_ALPHA_NEAR,
  WISP_TRAIL_ALPHA_FAR,
  MARKER_DIAMOND_RADIUS_CELLS,
  MARKER_GLOW_BLUR,
  MARKER_PULSE_AMPLITUDE,
  MARKER_PULSE_SPEED,
  WISP_HEAD_HALO_RADIUS_CELLS,
  WISP_HEAD_CORE_RADIUS_CELLS,
  WISP_HEAD_HALO_ALPHA,
  EMBER_RADIUS_CELLS,
  EMBER_CORE_RADIUS_CELLS,
  EMBER_HALO_ALPHA_BASE,
  EMBER_HALO_ALPHA_VARIANCE,
  EMBER_FLICKER_SPEED,
  EMBER_FLICKER_PHASE_STEP,
  EMBER_BLAZE_FLICKER_SPEED,
  IGNITER_RADIUS_CELLS,
  IGNITER_CORE_RADIUS_CELLS,
  IGNITER_HALO_ALPHA_BASE,
  IGNITER_BLINK_SPEED,
  IGNITER_BLINK_MIN_ALPHA,
  EMBER_DESPAWN_EFFECT_DURATION_FRAMES,
  EMBER_DESPAWN_EFFECT_MAX_RADIUS_CELLS,
} from '../config';

// Parsed once so the Igniter halo (docs/plan.md §6 M9 / §12.3) can be drawn
// as a translucent rgba() fill under the opaque core. Unlike the Wisp trail/
// Ember halo below, IGNITER_HALO_ALPHA_BASE never varies per frame (only the
// blink, applied separately via ctx.globalAlpha, does) so the rgba() string
// itself is cacheable as a single module-level constant — see
// IGNITER_HALO_COLOR below (docs/plan.md §13.3 P3: avoids rebuilding this
// string every rendered frame).
const IGNITER_RGB = hexToRgb(COLOR_IGNITER);
const IGNITER_HALO_COLOR = `rgba(${IGNITER_RGB.r}, ${IGNITER_RGB.g}, ${IGNITER_RGB.b}, ${IGNITER_HALO_ALPHA_BASE})`;

// A single queued Ember-despawn vanish effect (docs/plan.md §6 M11 / §12.6):
// a position + the renderer's own `frameCount` value at the moment it was
// queued. Entirely renderer-owned state — core never sees this, it only
// ever hands up the position via Game.drainDespawnedEmberPositions().
interface DespawnEffect {
  position: Point;
  startFrame: number;
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private backgroundLayer: HTMLCanvasElement;
  // Drives every M9 (docs/plan.md §12.3) animation (marker idle pulse, Ember
  // flicker, Igniter blink) via deterministic sin()/cos() functions of this
  // counter — no state lives in src/core/, and no Math.random is involved.
  private frameCount = 0;
  // Ember despawn vanish effects currently animating (docs/plan.md §6 M11 /
  // §12.6), pruned in drawEmberDespawnEffects() as they age out. Queued via
  // spawnEmberDespawnEffect() at tick granularity (main.ts, mirroring how
  // GameSession's events reach SfxEngine) rather than only inside render()'s
  // once-per-rendered-frame cadence, so an effect is never dropped even if
  // several Embers despawn within the ticks between two rendered frames.
  private emberDespawnEffects: DespawnEffect[] = [];

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

  /**
   * Queues a short expanding-and-fading ring "vanish" effect at `position`
   * (docs/plan.md §6 M11 / §12.6): called once per Ember the core despawns
   * (main.ts, draining Game/GameSession's despawn-position queue at tick
   * granularity). Purely additive here — drawEmberDespawnEffects() is what
   * actually ages/prunes/draws the queued effects, once per render() call.
   */
  spawnEmberDespawnEffect(position: Point): void {
    this.emberDespawnEffects.push({ position: { ...position }, startFrame: this.frameCount });
  }

  render(
    field: Field,
    markerPosition?: Point,
    wispTrails?: ReadonlyArray<ReadonlyArray<Readonly<Point>>>,
    embers?: ReadonlyArray<Ember>,
    igniterPosition?: Point | null,
    markerVisible = true
  ): void {
    this.frameCount++;

    // Static background (fill + grid pattern) in a single draw call
    this.ctx.drawImage(this.backgroundLayer, 0, 0);
    // hasLineCells doubles as "is the marker currently drawing a line"
    // (docs/plan.md §12.3 marker idle pulse): only Marker.tryMove ever writes
    // the LINE cell state (src/core/marker.ts), and it's present on the field
    // for exactly as long as Marker.isDrawing() is true, so this reuses the
    // full-field scan drawField() already does rather than adding a new
    // render() parameter.
    const hasLineCells = this.drawField(field);
    this.drawFieldEdgeGlow();
    if (wispTrails) {
      // docs/plan.md §12.7/§4.2: stage n has n Wisps (2+ from stage 2); each
      // gets its own afterimage trail + head, drawn independently.
      for (const trail of wispTrails) {
        if (trail.length > 0) {
          this.drawWisp(trail);
        }
      }
    }
    if (embers && embers.length > 0) {
      this.drawEmbers(embers);
    }
    if (igniterPosition) {
      this.drawIgniter(igniterPosition);
    }
    this.drawEmberDespawnEffects();
    // Post-miss grace feedback (docs/plan.md §6 M5): the caller blinks the
    // marker by toggling `markerVisible` off every few ticks; omitting the
    // draw call entirely (rather than e.g. changing color) makes it a true
    // blink against the field/background behind it.
    if (markerPosition && markerVisible) {
      this.drawMarker(markerPosition, !hasLineCells);
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

  // Returns true iff at least one LINE cell was drawn (docs/plan.md §12.3:
  // the marker idle-pulse's "is currently drawing" signal piggybacks on this
  // scan — see the render() call site's comment).
  private drawField(field: Field): boolean {
    const width = field.getWidth();
    const height = field.getHeight();
    let hasLineCells = false;

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
            hasLineCells = true;
            break;
          default:
            continue;
        }
        this.ctx.fillRect(x * RENDER_SCALE, py, RENDER_SCALE, RENDER_SCALE);
      }
    }
    this.ctx.restore();
    return hasLineCells;
  }

  // Draws the Wisp's afterimage trail (older history first, more transparent
  // — docs/plan.md §6 M5 "Wispの残像表現の強化") followed by a glowing head,
  // so the head is always painted on top and brightest.
  private drawWisp(trail: ReadonlyArray<Readonly<Point>>): void {
    // COLOR_WISP_HEAD is already an opaque color string, so painting it
    // through ctx.globalAlpha reproduces exactly the same composite as the
    // old per-segment `rgba(r, g, b, alpha)` fillStyle would have — without
    // building a new string every segment, every frame (docs/plan.md §13.3
    // P3). Reset to 1 once the (variable-alpha) trail segments are done so
    // it doesn't leak into the (opaque, save/restore-scoped) head below.
    this.ctx.fillStyle = COLOR_WISP_HEAD;
    for (let i = trail.length - 1; i >= 1; i--) {
      const p = trail[i];
      // Older (higher index) segments fade toward WISP_TRAIL_ALPHA_FAR;
      // the segment right behind the head sits near WISP_TRAIL_ALPHA_NEAR.
      const t = trail.length > 2 ? (i - 1) / (trail.length - 2) : 0;
      const alpha = WISP_TRAIL_ALPHA_NEAR + (WISP_TRAIL_ALPHA_FAR - WISP_TRAIL_ALPHA_NEAR) * t;
      this.ctx.globalAlpha = alpha;
      this.ctx.fillRect(p.x * RENDER_SCALE, p.y * RENDER_SCALE, RENDER_SCALE, RENDER_SCALE);
    }
    this.ctx.globalAlpha = 1;

    // Head enlarged to a ~2x2-cell halo + bright core (docs/plan.md §6 M9 /
    // §12.3), centered on the head's grid cell so the visible footprint
    // grows without moving the collision-relevant position.
    const head = trail[0];
    const cx = (head.x + 0.5) * RENDER_SCALE;
    const cy = (head.y + 0.5) * RENDER_SCALE;
    this.ctx.save();
    this.ctx.shadowColor = COLOR_WISP_HEAD;
    this.ctx.shadowBlur = GLOW_BLUR_ENTITY;
    this.ctx.fillStyle = COLOR_WISP_HEAD;
    this.ctx.globalAlpha = WISP_HEAD_HALO_ALPHA;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, WISP_HEAD_HALO_RADIUS_CELLS * RENDER_SCALE, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = COLOR_WISP_HEAD;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, WISP_HEAD_CORE_RADIUS_CELLS * RENDER_SCALE, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
  }

  // Draws each Ember (border-patrol enemy) as a ~2x2-cell "ember" — a bright
  // core + softer halo circle, both flickering per-frame (docs/plan.md §6 M9
  // / §12.3). Each Ember's flicker phase is offset by its index in `embers`
  // (EMBER_FLICKER_PHASE_STEP) purely so multiple Embers don't flicker in
  // lockstep — still a deterministic function of frameCount, no
  // Math.random. A "Blaze" (docs/plan.md §14 M6-1, Ember.isBlaze()) swaps in
  // COLOR_EMBER_BLAZE and the faster EMBER_BLAZE_FLICKER_SPEED instead —
  // per-Ember state read straight off each Ember (P3's non-cloning
  // getPositionRef()), not a parallel array, so core's Ember stays the
  // single source of truth for which individuals are Blazes.
  private drawEmbers(embers: ReadonlyArray<Ember>): void {
    this.ctx.save();
    this.ctx.shadowBlur = GLOW_BLUR_ENTITY;
    embers.forEach((ember, i) => {
      const isBlaze = ember.isBlaze();
      // Both colors are already opaque, static string constants (never
      // built per-Ember per-frame); the flicker's varying alpha is applied
      // via ctx.globalAlpha instead of an rgba() string (docs/plan.md §13.3 P3).
      const color = isBlaze ? COLOR_EMBER_BLAZE : COLOR_EMBER;
      const flickerSpeed = isBlaze ? EMBER_BLAZE_FLICKER_SPEED : EMBER_FLICKER_SPEED;
      this.ctx.shadowColor = color;
      this.ctx.fillStyle = color;

      const flicker = 0.5 + 0.5 * Math.sin(this.frameCount * flickerSpeed + i * EMBER_FLICKER_PHASE_STEP);
      const haloAlpha = EMBER_HALO_ALPHA_BASE + EMBER_HALO_ALPHA_VARIANCE * flicker;
      const p = ember.getPositionRef();
      const cx = (p.x + 0.5) * RENDER_SCALE;
      const cy = (p.y + 0.5) * RENDER_SCALE;

      this.ctx.globalAlpha = haloAlpha;
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, EMBER_RADIUS_CELLS * RENDER_SCALE, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.globalAlpha = 1;
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, EMBER_CORE_RADIUS_CELLS * RENDER_SCALE, 0, Math.PI * 2);
      this.ctx.fill();
    });
    this.ctx.restore();
  }

  // Draws every queued Ember-despawn vanish effect (docs/plan.md §6 M11 /
  // §12.6) as a ring that expands from 0 to EMBER_DESPAWN_EFFECT_MAX_RADIUS_
  // CELLS while fading from opaque to transparent over
  // EMBER_DESPAWN_EFFECT_DURATION_FRAMES rendered frames, then prunes any
  // effect that has aged out — the same deterministic frameCount-driven
  // approach as the marker pulse/Ember flicker/Igniter blink above, just
  // keyed off each effect's own start frame instead of frameCount directly.
  private drawEmberDespawnEffects(): void {
    if (this.emberDespawnEffects.length === 0) return;

    this.ctx.save();
    this.ctx.lineWidth = 2;
    // COLOR_EMBER is already opaque; the fade-out alpha is applied via
    // ctx.globalAlpha instead of building a new rgba() string per effect per
    // frame (docs/plan.md §13.3 P3) — same composite as before.
    this.ctx.strokeStyle = COLOR_EMBER;
    this.emberDespawnEffects = this.emberDespawnEffects.filter((effect) => {
      const age = this.frameCount - effect.startFrame;
      if (age >= EMBER_DESPAWN_EFFECT_DURATION_FRAMES) return false;

      const t = age / EMBER_DESPAWN_EFFECT_DURATION_FRAMES; // 0 (just spawned) -> 1 (about to expire)
      const radius = EMBER_DESPAWN_EFFECT_MAX_RADIUS_CELLS * RENDER_SCALE * t;
      const alpha = 1 - t;
      const cx = (effect.position.x + 0.5) * RENDER_SCALE;
      const cy = (effect.position.y + 0.5) * RENDER_SCALE;

      this.ctx.globalAlpha = alpha;
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      this.ctx.stroke();
      return true;
    });
    this.ctx.restore();
  }

  // Draws the Igniter (line-chasing enemy) as a ~2x2-cell bright core + halo
  // circle along the line it's climbing, with a fast alpha blink
  // (docs/plan.md §6 M9 / §12.3 "危険が伝わる速めの点滅") so it reads as
  // more urgent than Ember's slower flicker. IGNITER_BLINK_MIN_ALPHA floors
  // the dip so it never fully disappears mid-blink.
  private drawIgniter(position: Point): void {
    const blink = 0.5 + 0.5 * Math.sin(this.frameCount * IGNITER_BLINK_SPEED);
    const alpha = IGNITER_BLINK_MIN_ALPHA + (1 - IGNITER_BLINK_MIN_ALPHA) * blink;
    const cx = (position.x + 0.5) * RENDER_SCALE;
    const cy = (position.y + 0.5) * RENDER_SCALE;

    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.shadowColor = COLOR_IGNITER;
    this.ctx.shadowBlur = GLOW_BLUR_ENTITY;
    // Precomputed once at module load (IGNITER_HALO_COLOR) instead of
    // rebuilt every frame — HALO_BASE never varies, only `alpha` (blink)
    // above does, and that's already applied via globalAlpha, multiplying
    // with this string's own alpha channel exactly as before (docs/plan.md
    // §13.3 P3).
    this.ctx.fillStyle = IGNITER_HALO_COLOR;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, IGNITER_RADIUS_CELLS * RENDER_SCALE, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.fillStyle = COLOR_IGNITER;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, IGNITER_CORE_RADIUS_CELLS * RENDER_SCALE, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
  }

  // Draws the marker as a diamond (◆), ~3x3 cells across, centered on its
  // grid cell (docs/plan.md §6 M9 / §12.3). While idle (not currently
  // drawing a line — see the render() call site's comment on hasLineCells),
  // it breathes via a slow sinusoidal size pulse; while actively drawing, it
  // holds steady at its base size so the pulse doesn't compete visually with
  // line-drawing feedback.
  private drawMarker(position: Point, idle: boolean): void {
    const cx = (position.x + 0.5) * RENDER_SCALE;
    const cy = (position.y + 0.5) * RENDER_SCALE;
    let radius = MARKER_DIAMOND_RADIUS_CELLS * RENDER_SCALE;
    if (idle) {
      const pulse = Math.sin(this.frameCount * MARKER_PULSE_SPEED);
      radius *= 1 + MARKER_PULSE_AMPLITUDE * pulse;
    }

    this.ctx.save();
    this.ctx.shadowColor = COLOR_MARKER;
    this.ctx.shadowBlur = MARKER_GLOW_BLUR;
    this.ctx.fillStyle = COLOR_MARKER;
    this.ctx.beginPath();
    this.ctx.moveTo(cx, cy - radius);
    this.ctx.lineTo(cx + radius, cy);
    this.ctx.lineTo(cx, cy + radius);
    this.ctx.lineTo(cx - radius, cy);
    this.ctx.closePath();
    this.ctx.fill();
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
