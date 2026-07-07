// Wisp: the line-dwelling wandering enemy. Pure logic — no DOM/Canvas
// dependencies. docs/plan.md §3.4 describes this creature as "QIX"; per §1
// the original name is never used in code/UI, so it is called "Wisp" here.
//
// Movement model (docs/plan.md §4.3): the head advances along a continuous
// heading vector, with a small random angle jitter applied every tick. If
// the next step would land on a wall cell — BORDER or CLAIMED_FAST/SLOW —
// it reflects off the offending axis, the same way a ball bounces off a
// wall, rather than entering it. In-progress LINE cells are deliberately
// NOT walls: the Wisp may drift onto them, which is exactly the §3.4 miss
// condition ("引いている途中のラインに触れたらミス") detected by
// collision.ts each tick. A history of the most recent *distinct* grid
// cells the head has occupied is retained (one entry per cell change,
// capped at WISP_HISTORY_LENGTH), so the trail spans multiple cells — this
// produces the line-creature "afterimage" look (§3.4) and doubles as the
// body for collision checks (§4.3).
import { Field, Point, UNCLAIMED, LINE } from './field';
import { WISP_SPEED, WISP_TURN_JITTER, WISP_HISTORY_LENGTH } from '../config';

/** Random number generator hook, injectable so tests can be deterministic. */
export type Rng = () => number;

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

  private tryStep(field: Field, dx: number, dy: number): { x: number; y: number; angle: number } | null {
    const x = this.pos.x + dx;
    const y = this.pos.y + dy;
    // field.getAt(x, y) is the allocation-free lookup (no Point object
    // needed) — equivalent to field.get({x, y}) for in-bounds coordinates,
    // and both return BORDER when out of bounds, matching this hot path's
    // needs identically.
    const state = field.getAt(Math.round(x), Math.round(y));
    if (state !== UNCLAIMED && state !== LINE) {
      return null;
    }
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
