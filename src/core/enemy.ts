// Wisp: the line-dwelling wandering enemy. Pure logic — no DOM/Canvas
// dependencies. docs/plan.md §3.4 describes this creature as "QIX"; per §1
// the original name is never used in code/UI, so it is called "Wisp" here.
//
// Movement model (docs/plan.md §4.3): the head advances along a continuous
// heading vector, with a small random angle jitter applied every tick. If
// the next step would land on a wall cell — BORDER or CLAIMED_FAST/SLOW —
// it reflects off the offending axis, the same way a ball bounces off a
// wall, rather than entering it. Because the debug panel (§12.4) allows
// speed multipliers high enough for a single tick to cross several cells,
// "the next step" is not just the destination cell: tryStep() sweeps the
// whole move segment (see its doc comment) so a fast head can never tunnel
// through a one-cell-wide wall between two ticks. In-progress LINE cells are
// deliberately NOT walls: the Wisp may drift onto them, which is exactly the
// §3.4 miss condition ("引いている途中のラインに触れたらミス") detected by
// collision.ts each tick. A history of the most recent *distinct* grid
// cells the head has occupied is retained (one entry per cell change,
// capped at WISP_HISTORY_LENGTH), so the trail spans multiple cells — this
// produces the line-creature "afterimage" look (§3.4) and doubles as the
// body for collision checks (§4.3).
import { Field, Point, UNCLAIMED, LINE } from './field';
import { WISP_SPEED, WISP_TURN_JITTER, WISP_HISTORY_LENGTH } from '../config';

/** Random number generator hook, injectable so tests can be deterministic. */
export type Rng = () => number;

// Maximum sampling interval (grid cells) used by tryStep() to sweep a move
// segment for walls instead of checking only the destination cell. Must be
// strictly < 1 cell: with a gap g between consecutive samples, every
// unit-wide wall a segment crosses is guaranteed to contain at least one
// sample only when g < 1 (a gap of exactly 1 could straddle a 1-cell-wide
// wall entirely). 0.5 leaves comfortable margin below that bound while
// keeping the per-tick sample count (and thus cost) low at the debug panel's
// max speed multiplier. See tryStep()'s doc comment for the full rationale.
const WISP_STEP_SAMPLE = 0.5;

export class Wisp {
  private pos: { x: number; y: number };
  private angle: number;
  private history: Point[];
  private readonly rng: Rng;
  private speedMultiplier: number;

  /**
   * @param start Initial head position (must be an UNCLAIMED cell).
   * @param rng Random source for heading jitter and the initial heading
   *   (when `initialAngle` is omitted). Defaults to `Math.random`; tests
   *   should inject a deterministic function.
   * @param initialAngle Optional fixed starting heading in radians. Useful
   *   for deterministic tests that also want a deterministic first move.
   * @param speedMultiplier Scales WISP_SPEED (docs/plan.md §12.7 stage
   *   progression: interpolates from x1.0 at stage 1 up to
   *   WISP_SPEED_MULTIPLIER_MAX at stage STAGE_MAX_DIFFICULTY).
   *   Defaults to 1 (the M1-M3 baseline speed).
   */
  constructor(start: Point, rng: Rng = Math.random, initialAngle?: number, speedMultiplier = 1) {
    this.pos = { x: start.x, y: start.y };
    this.rng = rng;
    this.angle = initialAngle ?? rng() * Math.PI * 2;
    this.history = [this.getPosition()];
    this.speedMultiplier = speedMultiplier;
  }

  /** Current head position, snapped to the grid. */
  getPosition(): Point {
    return { x: Math.round(this.pos.x), y: Math.round(this.pos.y) };
  }

  /**
   * The head's current grid cell followed by the previously occupied
   * distinct cells (most recent first), capped at WISP_HISTORY_LENGTH
   * entries. A new entry is recorded only when the head moves to a
   * different cell, so the trail genuinely stretches across the field.
   * Used both for the trailing afterimage render and as the body polyline
   * for collision checks (consecutive entries may be diagonal or, at high
   * speeds, further apart — collision code interpolates between them).
   */
  getTrail(): Point[] {
    return this.history.map((p) => ({ ...p }));
  }

  /**
   * Non-cloning view of the same trail as getTrail(): returns the internal
   * `history` array itself, not a copy.
   *
   * Hot path (used by the per-tick collision check and per-frame render).
   * Callers must NEVER mutate the returned array or any of its elements —
   * use getTrail() instead if a defensive copy is needed.
   */
  getTrailRef(): ReadonlyArray<Readonly<Point>> {
    return this.history;
  }

  /** Current speed multiplier (docs/plan.md §6 M10 debug panel reads this for the effective-params export). */
  getSpeedMultiplier(): number {
    return this.speedMultiplier;
  }

  /**
   * Overrides the speed multiplier at runtime (docs/plan.md §6 M10 / §12.4:
   * the debug panel's "Wisp 速度倍率" slider). Applies from the next
   * `update()` call onward — purely a tuning knob, no other state changes.
   */
  setSpeedMultiplier(multiplier: number): void {
    this.speedMultiplier = multiplier;
  }

  /**
   * Advances the Wisp by one fixed tick: applies a small random heading
   * change, then attempts to step forward. If the direct step is blocked, it
   * tries reflecting off one axis at a time and finally both (a corner);
   * if every option is blocked it holds its position for this tick. Never
   * moves onto a cell other than UNCLAIMED or LINE — an in-progress LINE
   * cell is not a wall, so the Wisp is free to drift onto it (that is
   * exactly the §3.4 miss condition, detected elsewhere by collision.ts).
   */
  update(field: Field): void {
    this.angle += (this.rng() * 2 - 1) * WISP_TURN_JITTER;

    const dx = Math.cos(this.angle) * WISP_SPEED * this.speedMultiplier;
    const dy = Math.sin(this.angle) * WISP_SPEED * this.speedMultiplier;

    const step =
      this.tryStep(field, dx, dy) ??
      this.tryStep(field, -dx, dy) ??
      this.tryStep(field, dx, -dy) ??
      this.tryStep(field, -dx, -dy);

    if (step) {
      // `step` already carries exactly {x, y, angle} — reusing it directly
      // as the new `pos` (its extra `angle` field is simply ignored by
      // `pos`'s type) avoids a redundant clone.
      this.pos = step;
      this.angle = step.angle;
    }
    // If every reflection is also blocked (fully boxed in), stay put this
    // tick rather than escaping UNCLAIMED territory.

    this.recordCellIfChanged();
  }

  /**
   * Checks whether the straight-line move (dx, dy) from the current head
   * position is unobstructed, and returns the landing point if so.
   *
   * At WISP_SPEED's base multiplier (x1) a tick advances well under one
   * cell, so checking only the destination cell was sufficient. But the
   * debug panel (docs/plan.md §12.4) allows pushing the speed multiplier
   * far past that (up to its RANGES.wispSpeedMultiplier.max, currently
   * 15.0 — see src/debug/panel.ts), at which a single tick can cross
   * several cells — a naive single-point check would let the head "jump"
   * clean over a one-cell-wide BORDER/CLAIMED wall (checking only where it
   * lands, never the wall cell itself) and reappear on the far side. To
   * prevent that, the segment from the current position to the candidate
   * destination is sampled at intervals of at most WISP_STEP_SAMPLE cells —
   * chosen below 1 so that two consecutive samples can never straddle an
   * entire 1-cell-wide wall without either one landing inside it (a gap of
   * width g guarantees every unit-wide rounding zone the segment crosses
   * contains at least one sample as long as g < 1; 0.5 leaves comfortable
   * margin). If any sampled cell is a wall, the whole step is rejected
   * (returns null) exactly as a single blocked destination cell would be —
   * update() then falls back to trying a reflection candidate, so a
   * suddenly-invalid fast step behaves the same as the pre-existing
   * "blocked step" case, no new state machine needed.
   *
   * At low speed (move distance <= WISP_STEP_SAMPLE) this reduces to
   * exactly one sample at the full destination — identical to the previous
   * single-point check — so existing WISP_SPEED (x1) behavior/tests are
   * unaffected.
   *
   * Hot path: called every tick for every Wisp, up to 4 times per tick. No
   * object allocation inside the sampling loop (docs/plan.md §13) — only
   * numeric locals.
   */
  private tryStep(field: Field, dx: number, dy: number): { x: number; y: number; angle: number } | null {
    const distance = Math.max(Math.abs(dx), Math.abs(dy));
    const steps = Math.max(1, Math.ceil(distance / WISP_STEP_SAMPLE));
    for (let i = 1; i <= steps; i++) {
      const fraction = i / steps;
      const sampleX = this.pos.x + dx * fraction;
      const sampleY = this.pos.y + dy * fraction;
      // field.getAt(x, y) is the allocation-free lookup (no Point object
      // needed) — equivalent to field.get({x, y}) for in-bounds coordinates,
      // and both return BORDER when out of bounds, matching this hot path's
      // needs identically.
      const state = field.getAt(Math.round(sampleX), Math.round(sampleY));
      if (state !== UNCLAIMED && state !== LINE) {
        return null;
      }
    }
    const x = this.pos.x + dx;
    const y = this.pos.y + dy;
    return { x, y, angle: Math.atan2(dy, dx) };
  }

  // Records the head's grid cell into the trail history, but only when it
  // differs from the current head entry — the trail is a sequence of
  // distinct cells, not of per-tick samples (which would collapse into a
  // single dot at sub-cell speeds). Compares rounded coordinates directly
  // (rather than via getPosition()) so the common no-change tick allocates
  // nothing.
  private recordCellIfChanged(): void {
    const cx = Math.round(this.pos.x);
    const cy = Math.round(this.pos.y);
    const head = this.history[0];
    if (head && head.x === cx && head.y === cy) {
      return;
    }
    this.history.unshift({ x: cx, y: cy });
    if (this.history.length > WISP_HISTORY_LENGTH) {
      this.history.length = WISP_HISTORY_LENGTH;
    }
  }
}
