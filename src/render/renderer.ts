import { Field, Point, BORDER, CLAIMED_FAST, CLAIMED_SLOW, LINE, UNCLAIMED, CellState } from '../core/field';
import type { Ember } from '../core/patrol';
import type { FxClaimTags, FxFrame, FxFillReveal, FxPopup } from '../fx/director';
import {
  drawClaimTags,
  drawFlash,
  drawLineGlows,
  drawMissReason,
  drawPopups,
  drawShards,
  drawSparks,
  drawSplitBanner,
  drawStageTitle,
  type FxAvoidBand,
  type FxTextBox,
} from './fxLayer';
import { drawHintMarks, type HintMarkShapes } from './hintLayer';
import { drawStartCue, startCueLineWidth, startCueRing, type StartCueRing } from './startCueLayer';
import { wispTrailAlpha, wispTrailColor, wispTrailFillCells, wispTrailGlowAlpha } from './wispShape';

/** One Wisp to draw: its trail (Wisp.getTrailRef()) and speed multiplier (Wisp.getSpeedMultiplier()). */
export interface WispDraw {
  trail: ReadonlyArray<Readonly<Point>>;
  speedMultiplier: number;
}
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
  WISP_TRAIL_GLOW_CELLS,
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

// Fill reveal bookkeeping: -1 marks a cell that is not part of the reveal,
// UNREACHED a newly claimed cell whose distance is not known yet.
const UNREACHED = -2;

function isClaimed(state: CellState): boolean {
  return state === CLAIMED_FAST || state === CLAIMED_SLOW;
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
  // Per-cell-edge physical-pixel boundaries, snapped for the constructor's
  // `dpr` and precomputed once so drawField()/drawWisp() never allocate or
  // call Math.round() in their per-cell hot loops (see buildCellBoundaries()
  // below for why this exists and how it's indexed at each call site).
  private readonly cellBoundaries: Float64Array;
  // Fill reveal (only while an FxFrame is passed to render()): every cell's
  // state as drawn on the previous frame, so the frame a claim arrives on can
  // tell which cells just became claimed. `revealDistance` holds, for those
  // cells, how far (4-neighbor steps) each one is from the closed line, and
  // -1 for every other cell; a revealing cell is held back until the
  // reveal's progress reaches it.
  private prevCells: Uint8Array | null = null;
  private revealId = -1;
  private revealDistance: Int32Array | null = null;
  private revealMaxDistance = 0;
  private revealThreshold = Number.POSITIVE_INFINITY;
  // Center (in cells) of each reveal's new cells, for its "+score" popup.
  private revealCentroids = new Map<number, { x: number; y: number }>();

  private fxTextMinFontPx = 0;
  private missReasonMinFontPx = 0;
  private fxAvoidBand: FxAvoidBand | null = null;
  private lastFxTextBoxes: { stageTitle: FxTextBox | null; claimTags: FxTextBox[] } = { stageTitle: null, claimTags: [] };
  private lastStartCue: StartCueRing | null = null;
  private startCueMinLineWidthPx = 0;
  private hintMarks: HintMarkShapes | null = null;
  private veilAlpha = 0;
  private lastVeilAlpha = 0;
  private readonly wispTrailColors = new Map<number, string>();

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
    this.cellBoundaries = buildCellBoundaries(dpr);

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

  /**
   * The smallest canvas font size for the effects' text (+score, x2, the
   * praise word, CHAIN xN): main.ts sets FX_TEXT_MIN_DISPLAY_PX divided by
   * the field's display scale (on-screen width / CANVAS_WIDTH), so on a
   * phone, where the field is drawn at ~0.6x, the text never shows smaller
   * than that many CSS px. Drawing only — see fxLayer.ts's popupFontSizes().
   */
  setFxTextMinFontPx(px: number): void {
    this.fxTextMinFontPx = Number.isFinite(px) && px > 0 ? px : 0;
  }

  /** The same for the miss reason (FX_MISS_REASON_MIN_DISPLAY_PX / the display scale) — see fxLayer.ts's missReasonFontPx(). */
  setMissReasonMinFontPx(px: number): void {
    this.missReasonMinFontPx = Number.isFinite(px) && px > 0 ? px : 0;
  }

  /**
   * Forgets the board-bound fill-reveal state. Call whenever the board is
   * replaced (the next stage starts, back to Title, entering or leaving a
   * replay) so the next frame is not compared against an unrelated board.
   */
  resetBoard(): void {
    this.prevCells = null;
    this.clearReveal();
    this.revealCentroids.clear();
  }

  /**
   * Draws one frame. `fx` (live play only) adds the impact feedback: the
   * whole field shakes by `fx.shake`, newly claimed cells are revealed
   * outward from the closed line, and fxLayer.ts's glows, shards, sparks,
   * popups, SPLIT! and flash are drawn in their place in the order. Without `fx`
   * (replay viewing) the frame is drawn exactly as before.
   */
  render(
    field: Field,
    markerPosition?: Point,
    wisps?: ReadonlyArray<WispDraw>,
    embers?: ReadonlyArray<Ember>,
    igniterPosition?: Point | null,
    markerVisible = true,
    fx?: FxFrame
  ): void {
    this.frameCount++;

    // Static background (fill + grid pattern) in a single draw call
    this.ctx.drawImage(this.backgroundLayer, 0, 0);
    // The shake moves the board and everything on it, not the background, so
    // the background shows along whichever edge the board moved away from.
    const shaking = fx !== undefined && (fx.shake.x !== 0 || fx.shake.y !== 0);
    if (shaking) {
      this.ctx.save();
      this.ctx.translate(fx.shake.x, fx.shake.y);
    }
    if (fx) this.updateReveal(field, fx.fillReveal);
    // hasLineCells doubles as "is the marker currently drawing a line"
    // (docs/plan.md §12.3 marker idle pulse): only Marker.tryMove ever writes
    // the LINE cell state (src/core/marker.ts), and it's present on the field
    // for exactly as long as Marker.isDrawing() is true, so this reuses the
    // full-field scan drawField() already does rather than adding a new
    // render() parameter.
    const hasLineCells = this.drawField(field, fx !== undefined);
    this.drawFieldEdgeGlow();
    if (wisps) {
      // docs/plan.md §12.7/§4.2: stage n has n Wisps (2+ from stage 2); each
      // gets its own afterimage trail + head, drawn independently.
      for (const wisp of wisps) {
        if (wisp.trail.length > 0) {
          this.drawWisp(wisp.trail, wisp.speedMultiplier);
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
    if (fx) {
      drawLineGlows(this.ctx, fx.lineGlows);
      drawShards(this.ctx, fx.shards);
      drawSparks(this.ctx, fx.sparks);
    }
    // Post-miss grace feedback (docs/plan.md §6 M5): the caller blinks the
    // marker by toggling `markerVisible` off every few ticks; omitting the
    // draw call entirely (rather than e.g. changing color) makes it a true
    // blink against the field/background behind it.
    if (markerPosition && markerVisible) {
      this.drawMarker(markerPosition, !hasLineCells);
    }
    if (fx) {
      drawPopups(this.ctx, fx.popups, (popup) => this.popupPosition(popup), this.fxTextMinFontPx);
      if (fx.splitBanner) drawSplitBanner(this.ctx, fx.splitBanner);
      // Over SPLIT!, so a split's BIG CLAIM / CLOSE CALL under it stay readable.
      this.lastFxTextBoxes.claimTags = drawClaimTags(
        this.ctx,
        fx.claimTags,
        (item) => this.popupPosition(item),
        this.fxTextMinFontPx,
        this.fxAvoidBand
      );
      this.pruneCentroids(fx.popups, fx.claimTags);
      drawFlash(this.ctx, fx.flash);
    }
    if (shaking) {
      this.ctx.restore();
    }
    if (!fx) this.lastFxTextBoxes.claimTags = [];
    // The stage's title: outside the shake, like the miss reason, since it is
    // there to be read.
    this.lastFxTextBoxes.stageTitle = fx?.stageTitle
      ? drawStageTitle(this.ctx, fx.stageTitle, this.fxTextMinFontPx, this.fxAvoidBand)
      : null;
    // The start cue: on the marker wherever it is now (even on a blinked-off
    // frame), over the stage title shown at the same time so a start near
    // the title is never hidden by it, and moved with the board when it
    // shakes, so it stays on the marker.
    this.lastStartCue = startCueRing(fx?.startCue ?? null, markerPosition);
    if (this.lastStartCue) {
      this.ctx.save();
      if (shaking) this.ctx.translate(fx.shake.x, fx.shake.y);
      drawStartCue(this.ctx, this.lastStartCue, this.startCueMinLineWidthPx);
      this.ctx.restore();
    }
    // The miss reason: over the flash so the burst never washes it out, and
    // outside the shake, since it is there to be read.
    if (fx?.missReason) drawMissReason(this.ctx, fx.missReason, this.missReasonMinFontPx);
    // The in-play hint's mark (live play only — main.ts never sets one for a
    // replay): on top, and outside the shake like the miss reason.
    if (this.hintMarks) drawHintMarks(this.ctx, this.hintMarks);
    // The Title demo's veil (setVeil()): last, over the board and its frame,
    // so the title text and the buttons above the canvas stay readable.
    this.lastVeilAlpha = this.veilAlpha;
    if (this.veilAlpha > 0) {
      this.ctx.save();
      this.ctx.globalAlpha = this.veilAlpha;
      this.ctx.fillStyle = COLOR_BACKGROUND;
      this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      this.ctx.restore();
    }
  }

  /** A veil of the background color over the whole frame at `alpha` (0 for none), from the next render() on. */
  setVeil(alpha: number): void {
    this.veilAlpha = Number.isFinite(alpha) && alpha > 0 ? Math.min(alpha, 1) : 0;
  }

  /** The veil's opacity on the last frame drawn (0 for none). */
  getLastVeilAlpha(): number {
    return this.lastVeilAlpha;
  }

  /** The in-play hint's ring or arrow for the next frames (src/render/hintLayer.ts), or null for none. */
  setHintMarks(shapes: HintMarkShapes | null): void {
    this.hintMarks = shapes;
  }

  /**
   * The band of the field (logical canvas px) the stage title and the claim
   * tags keep out of — the hint line while it is shown — or null.
   */
  setFxAvoidBand(band: FxAvoidBand | null): void {
    this.fxAvoidBand = band;
  }

  /**
   * The thinnest line the start cue is drawn with (logical px): main.ts sets
   * FX_START_CUE_MIN_LINE_DISPLAY_PX divided by the field's display scale, so
   * the ring stays visible on a field shown small. Drawing only.
   */
  setStartCueMinLineWidthPx(px: number): void {
    this.startCueMinLineWidthPx = Number.isFinite(px) && px > 0 ? px : 0;
  }

  /** The start cue's ring the last frame drew (logical canvas px, with its line width), or null, for tests. */
  getLastStartCue(): (StartCueRing & { lineWidth: number }) | null {
    return this.lastStartCue ? { ...this.lastStartCue, lineWidth: startCueLineWidth(this.startCueMinLineWidthPx) } : null;
  }

  /** Where the last frame drew the stage title and the claim tags (logical canvas px), for tests. */
  getLastFxTextBoxes(): { stageTitle: FxTextBox | null; claimTags: FxTextBox[] } {
    return { stageTitle: this.lastFxTextBoxes.stageTitle, claimTags: [...this.lastFxTextBoxes.claimTags] };
  }

  private popupPosition(popup: { revealId: number; anchor: Point }): { x: number; y: number } {
    return this.revealCentroids.get(popup.revealId) ?? popup.anchor;
  }

  private pruneCentroids(popups: readonly FxPopup[], claimTags: readonly FxClaimTags[]): void {
    if (this.revealCentroids.size === 0) return;
    for (const id of this.revealCentroids.keys()) {
      if (!popups.some((p) => p.revealId === id) && !claimTags.some((c) => c.revealId === id)) {
        this.revealCentroids.delete(id);
      }
    }
  }

  private clearReveal(): void {
    this.revealId = -1;
    this.revealDistance = null;
    this.revealMaxDistance = 0;
    this.revealThreshold = Number.POSITIVE_INFINITY;
  }

  /**
   * Starts a new reveal on the first frame a claim's reveal id appears —
   * the new cells are those claimed now but not on the previous frame (a
   * reveal still running is thereby finished: its cells were already
   * claimed last frame) — and updates how far out the reveal has reached.
   */
  private updateReveal(field: Field, reveal: FxFillReveal | null): void {
    if (!reveal) {
      if (this.revealId !== -1) this.clearReveal();
      return;
    }
    if (reveal.id !== this.revealId) {
      this.startReveal(field, reveal);
    }
    this.revealThreshold =
      this.revealDistance === null ? Number.POSITIVE_INFINITY : reveal.progress * (this.revealMaxDistance + 1);
  }

  private startReveal(field: Field, reveal: FxFillReveal): void {
    this.clearReveal();
    this.revealId = reveal.id;
    const prev = this.prevCells;
    const width = field.getWidth();
    const height = field.getHeight();
    if (!prev || prev.length !== width * height) return;

    const distance = new Int32Array(width * height).fill(-1);
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (isClaimed(field.getAt(x, y)) && !isClaimed(prev[i] as CellState)) {
          distance[i] = UNREACHED; // new, distance not known yet
          count++;
          sumX += x;
          sumY += y;
        }
      }
    }
    if (count === 0) return;
    this.revealCentroids.set(reveal.id, { x: sumX / count, y: sumY / count });

    // Breadth-first from the closed line through the new cells (4 neighbors).
    const queue = new Int32Array(count);
    let head = 0;
    let tail = 0;
    const visit = (x: number, y: number, d: number): void => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = y * width + x;
      if (distance[i] !== UNREACHED) return;
      distance[i] = d;
      queue[tail++] = i;
    };
    for (const c of reveal.line) {
      visit(c.x + 1, c.y, 0);
      visit(c.x - 1, c.y, 0);
      visit(c.x, c.y + 1, 0);
      visit(c.x, c.y - 1, 0);
    }
    let maxDistance = 0;
    while (head < tail) {
      const i = queue[head++];
      const d = distance[i];
      if (d > maxDistance) maxDistance = d;
      const x = i % width;
      const y = (i - x) / width;
      visit(x + 1, y, d + 1);
      visit(x - 1, y, d + 1);
      visit(x, y + 1, d + 1);
      visit(x, y - 1, d + 1);
    }
    // New cells the line does not reach (should not happen) appear last.
    for (let i = 0; i < distance.length; i++) {
      if (distance[i] === UNREACHED) distance[i] = maxDistance;
    }
    this.revealDistance = distance;
    this.revealMaxDistance = maxDistance;
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
  //
  // With `trackCells` (live play), also records every cell's state for the
  // next frame's fill reveal, and holds back the newly claimed cells the
  // running reveal has not reached yet (they show the background, as they
  // did a frame ago).
  private drawField(field: Field, trackCells = false): boolean {
    const width = field.getWidth();
    const height = field.getHeight();
    let hasLineCells = false;
    let snapshot: Uint8Array | null = null;
    if (trackCells) {
      if (!this.prevCells || this.prevCells.length !== width * height) {
        this.prevCells = new Uint8Array(width * height);
      }
      snapshot = this.prevCells;
    }
    const revealDistance = trackCells ? this.revealDistance : null;
    const revealThreshold = this.revealThreshold;

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
      // Physical-pixel-snapped span for this row (see buildCellBoundaries's
      // comment on why this prevents seams at fractional devicePixelRatio
      // values) — computed once per row, not per cell.
      const py = this.cellBoundaries[y];
      const ch = this.cellBoundaries[y + 1] - py;
      for (let x = 0; x < width; x++) {
        const state: CellState = field.getAt(x, y);
        if (snapshot) snapshot[y * width + x] = state;
        if (state === UNCLAIMED) continue;
        if (revealDistance && revealDistance[y * width + x] >= revealThreshold) continue;

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
        const px = this.cellBoundaries[x];
        const cw = this.cellBoundaries[x + 1] - px;
        this.ctx.fillRect(px, py, cw, ch);
      }
    }
    this.ctx.restore();
    return hasLineCells;
  }

  // The trail color for a speed multiplier (wispTrailColor()), built once per
  // multiplier rather than every frame.
  private wispTrailColorFor(speedMultiplier: number): string {
    let color = this.wispTrailColors.get(speedMultiplier);
    if (color === undefined) {
      color = wispTrailColor(speedMultiplier);
      this.wispTrailColors.set(speedMultiplier, color);
    }
    return color;
  }

  // Draws the Wisp's afterimage trail (older history first, more transparent
  // — docs/plan.md §6 M5 "Wispの残像表現の強化") followed by a glowing head,
  // so the head is always painted on top and brightest. The trail covers
  // every cell it can hit (src/render/wispShape.ts) — the cells between two
  // trail points too, which a fast Wisp leaves — in a color that follows the
  // Wisp's speed, over a fainter glow that makes it read thicker than a line.
  private drawWisp(trail: ReadonlyArray<Readonly<Point>>, speedMultiplier: number): void {
    const cells = wispTrailFillCells(trail);
    const count = trail.length;
    this.ctx.save();
    // An opaque color string painted through ctx.globalAlpha, rather than a
    // new `rgba(r, g, b, alpha)` string per cell, every frame (docs/plan.md
    // §13.3 P3).
    this.ctx.fillStyle = this.wispTrailColorFor(speedMultiplier);

    // The glow: each stretch of the trail (a trail point and the cells
    // between it and the point before) is one path of cells grown by
    // WISP_TRAIL_GLOW_CELLS on every side, filled once, so overlapping
    // neighbors never pile their glow up. Drawing only.
    const grow = WISP_TRAIL_GLOW_CELLS * RENDER_SCALE;
    const size = RENDER_SCALE + grow * 2;
    let stretch = -1;
    for (const cell of cells) {
      const at = Math.ceil(cell.at);
      if (at !== stretch) {
        if (stretch !== -1) this.ctx.fill();
        stretch = at;
        this.ctx.globalAlpha = wispTrailGlowAlpha(wispTrailAlpha(at, count));
        this.ctx.beginPath();
      }
      this.ctx.rect(cell.x * RENDER_SCALE - grow, cell.y * RENDER_SCALE - grow, size, size);
    }
    if (stretch !== -1) this.ctx.fill();

    // The cells themselves, which are what hits. Physical-pixel-snapped
    // spans, same as drawField()'s cell fills and for the same reason
    // (fractional devicePixelRatio seams).
    for (const cell of cells) {
      this.ctx.globalAlpha = wispTrailAlpha(cell.at, count);
      const px = this.cellBoundaries[cell.x];
      const py = this.cellBoundaries[cell.y];
      const cw = this.cellBoundaries[cell.x + 1] - px;
      const ch = this.cellBoundaries[cell.y + 1] - py;
      this.ctx.fillRect(px, py, cw, ch);
    }
    this.ctx.restore();

    // Head enlarged to a halo + bright core (docs/plan.md §6 M9 / §12.3),
    // centered on the head's grid cell so the visible footprint grows
    // without moving the collision-relevant position. Its color stays
    // COLOR_WISP_HEAD whatever the speed.
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

// Precomputes, once per Renderer instance, a lookup table of cell-grid-line
// positions snapped to physical-pixel boundaries under `dpr` — the fix for
// the dark grid-like seams reported inside occupied-area fills at
// fractional devicePixelRatio values (e.g. 1.875, 2.2 — real values seen
// under Windows display scaling and on some Android devices; confirmed via
// getImageData() to *not* occur at integer dpr like 1.0/2.0).
//
// Why this happens: the constructor's `ctx.scale(dpr, dpr)` means every
// draw call's logical coordinates get multiplied by `dpr` before the
// browser rasterizes them. drawField()/drawWisp() paint the grid one cell
// at a time via `fillRect(x * RENDER_SCALE, y * RENDER_SCALE, RENDER_SCALE,
// RENDER_SCALE)`. At an integer dpr, `x * RENDER_SCALE * dpr` is always a
// whole physical pixel, so every cell's edges land exactly on pixel
// boundaries and adjacent same-color cells butt together with no seam. At a
// fractional dpr (1.875, 2.2, ...), that product is usually *not* a whole
// pixel, so each fillRect's edge gets a half-covered, anti-aliased fringe
// pixel; two adjacent cells each contribute their own independent fringe
// along the shared edge, and those two partial-alpha fringes composite into
// a visibly darker seam line — even though both cells are filled with the
// exact same opaque color.
//
// The fix: instead of deriving each cell's rectangle from its own edge
// only, derive both the cell's start-edge *and* the next cell's start-edge
// by rounding each to the nearest physical pixel independently, then use
// the *difference* between those two rounded values as the width/height.
// Adjacent cells then always share the exact same rounded boundary
// coordinate (there's only one rounded value for any given edge, however
// many cells touch it), so there is neither a gap nor an overlap between
// them, and no fractional-pixel fringe is ever drawn on an *interior*
// shared edge.
//
// `boundaries[i]` is a *logical* (pre-ctx.scale) coordinate chosen so that
// `boundaries[i] * dpr` is exactly (modulo an epsilon far smaller than a
// physical pixel) the physical pixel at index `Math.round(i * RENDER_SCALE
// * dpr)` — i.e. dividing back by `dpr` after rounding, so the existing
// `ctx.scale(dpr, dpr)` transform (left untouched, along with every other
// draw call in this file) reproduces that exact physical pixel again when
// it re-multiplies by `dpr`.
//
// Built once per Renderer instance (dpr is fixed for the instance's
// lifetime) as a flat Float64Array indexed by cell coordinate, so
// drawField()'s and drawWisp()'s per-cell, every-frame hot loops do plain
// array lookups + a subtraction instead of calling Math.round() (or
// allocating an object) per cell, per frame — consistent with this
// project's earlier per-frame-allocation cleanup (docs/plan.md §13.3 M13).
//
// One table serves both the x and y axes: RENDER_SCALE is the same for
// both, so `boundaries[i]` is valid as either a column or a row index.
// Sized to `max(grid width, grid height) + 1` so index `i + 1` is always
// valid for the largest cell index either axis ever draws.
function buildCellBoundaries(dpr: number): Float64Array {
  const gridWidth = CANVAS_WIDTH / RENDER_SCALE;
  const gridHeight = CANVAS_HEIGHT / RENDER_SCALE;
  const count = Math.max(gridWidth, gridHeight) + 1;
  const boundaries = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    boundaries[i] = Math.round(i * RENDER_SCALE * dpr) / dpr;
  }
  return boundaries;
}
