// Marker (player) movement and line-drawing logic. Pure logic — no DOM/Canvas dependencies.
// See docs/plan.md §3.1 / §3.2 for the specification this module implements.
import { Field, Point, UNCLAIMED, BORDER, LINE, CLAIMED_FAST, CLAIMED_SLOW } from './field';
import { LineSpeed } from './claim';

export type Axis = -1 | 0 | 1;

export interface MarkerOptions {
  /**
   * Whether retract (backing up along the drawn line) is permitted.
   * Design hook for M3: this will be set to false once a fuse-equivalent
   * enemy has spawned on the current line. Not enforced by any other
   * system in M1.
   */
  retractEnabled?: boolean;
}

export interface MarkerMoveResult {
  /** True if the marker's position (or line) actually changed. */
  moved: boolean;
  /** True when this move reached a border point and closed the line. */
  lineClosed: boolean;
  /**
   * The interior line cells drawn during this line (excludes the border
   * start point) — pass this directly to `claimArea` when `lineClosed`.
   * Null unless `lineClosed` is true.
   */
  closedLine: Point[] | null;
  /**
   * The speed to score/claim this line at once closed (docs/plan.md §3.2):
   * 'fast' if *any* cell of the line was drawn at fast speed, 'slow' only if
   * every cell was drawn slow. Null unless `lineClosed` is true.
   */
  lineSpeed: LineSpeed | null;
  /** True when this move retracted (undid) the last drawn line cell. */
  retracted: boolean;
}

const NO_MOVE: MarkerMoveResult = {
  moved: false,
  lineClosed: false,
  closedLine: null,
  lineSpeed: null,
  retracted: false,
};

export class Marker {
  private position: Point;
  private line: Point[] = [];
  // Parallel to `line`: the speed used to draw each corresponding cell
  // (docs/plan.md §3.2 "速度を切り替えた場合、最終的に高速で囲んだ扱い").
  // Kept in lockstep with `line` (same push on draw, same pop on retract) so
  // a retracted fast cell no longer counts once undone.
  private lineSpeeds: LineSpeed[] = [];
  private lineStart: Point | null = null;
  private drawing = false;
  private retractEnabled: boolean;
  // Whether entering an UNCLAIMED cell (starting a new line) is permitted
  // (docs/plan.md §3.5 grace-period exploit fix, "案B"). Set to false by
  // Game while the post-miss grace period is active: BORDER movement stays
  // free (the player can still reposition to safety), but the invincibility
  // window can no longer be used to draw. Independent of `retractEnabled` —
  // the two flags can be false at the same time (e.g. an Igniter was active
  // when the miss happened) and neither affects the other.
  private lineEntryEnabled = true;

  constructor(start: Point, options: MarkerOptions = {}) {
    this.position = { ...start };
    this.retractEnabled = options.retractEnabled ?? true;
  }

  getPosition(): Point {
    return { ...this.position };
  }

  /** Interior line cells drawn so far during the current line (empty when not drawing). */
  getLine(): Point[] {
    return this.line.map((p) => ({ ...p }));
  }

  /**
   * Non-cloning view of the same line as getLine(): returns the internal
   * `line` array itself, not a copy.
   *
   * Hot path (used by the per-tick Igniter update and per-frame Igniter
   * position lookup). Callers must NEVER mutate the returned array or any of
   * its elements — use getLine() instead if a defensive copy is needed.
   */
  getLineRef(): ReadonlyArray<Readonly<Point>> {
    return this.line;
  }

  isDrawing(): boolean {
    return this.drawing;
  }

  setRetractEnabled(enabled: boolean): void {
    this.retractEnabled = enabled;
  }

  /**
   * Enables/disables entering UNCLAIMED cells, i.e. starting a new line
   * (docs/plan.md §3.5 grace-period exploit fix). BORDER movement is never
   * affected. See `lineEntryEnabled`'s doc comment for when Game toggles
   * this.
   */
  setLineEntryEnabled(enabled: boolean): void {
    this.lineEntryEnabled = enabled;
  }

  /**
   * Cancels the in-progress line (M2 miss handling, docs/plan.md §3.5): every
   * drawn LINE cell reverts to UNCLAIMED and the marker snaps back to the
   * border point where the line began. No-op (and returns the current
   * position unchanged) if the marker isn't currently drawing.
   */
  cancelLine(field: Field): Point {
    if (!this.drawing || !this.lineStart) {
      return this.getPosition();
    }

    for (const p of this.line) {
      field.set(p, UNCLAIMED);
    }

    this.position = { ...this.lineStart };
    this.line = [];
    this.lineSpeeds = [];
    this.drawing = false;
    this.lineStart = null;
    return this.getPosition();
  }

  /**
   * Attempts to move the marker one grid cell in direction (dx, dy).
   * (dx, dy) must be a single-axis unit step (e.g. {1,0}, {0,-1}); anything
   * else (including {0,0} or a diagonal) is rejected.
   *
   * Movement rules (docs/plan.md §3.1/§3.2):
   * - BORDER cells are always freely walkable.
   * - UNCLAIMED cells can only be entered while `drawHeld` is true *and*
   *   `lineEntryEnabled` is true (docs/plan.md §3.5 grace-period exploit
   *   fix); doing so draws a LINE cell (starting a new line if not already
   *   drawing).
   * - CLAIMED_FAST/CLAIMED_SLOW cells are impassable (they are filled area,
   *   not a walkable path).
   * - Stepping onto the marker's own in-progress LINE is rejected as a
   *   self-intersection, *unless* it is the immediately preceding cell
   *   (retract), in which case the trailing LINE cell is undone.
   * - Reaching a BORDER cell while drawing closes the line and returns the
   *   drawn cells via `closedLine` for the caller to hand to `claimArea`,
   *   along with the overall `lineSpeed` to score/claim it at.
   *
   * `speed` (docs/plan.md §3.2/§5.1) only matters while actually drawing
   * into an UNCLAIMED cell; it's ignored for BORDER movement and retracts.
   * Defaults to 'fast' (the only speed that existed before M3).
   */
  tryMove(field: Field, dx: Axis, dy: Axis, drawHeld: boolean, speed: LineSpeed = 'fast'): MarkerMoveResult {
    if ((dx === 0 && dy === 0) || (dx !== 0 && dy !== 0)) {
      return NO_MOVE;
    }

    const next: Point = { x: this.position.x + dx, y: this.position.y + dy };
    if (!field.isInBounds(next)) {
      return NO_MOVE;
    }

    if (this.drawing) {
      // The retract target is the cell immediately behind the marker: the
      // second-to-last drawn cell, or the line's border start point if only
      // one cell has been drawn so far. Note this can be a BORDER cell (the
      // 1-cell-line case) — it must still be treated as "stepping backward",
      // not as "reaching a border point" (which would incorrectly close the
      // line as a zero-length loop) when retract is disabled.
      const retractTarget = this.line.length >= 2 ? this.line[this.line.length - 2] : this.lineStart;
      if (retractTarget && retractTarget.x === next.x && retractTarget.y === next.y) {
        if (!this.retractEnabled) {
          return NO_MOVE;
        }
        return this.performRetract(field, retractTarget);
      }
    }

    const nextState = field.get(next);

    if (nextState === CLAIMED_FAST || nextState === CLAIMED_SLOW) {
      return NO_MOVE;
    }

    if (nextState === LINE) {
      // Any LINE cell other than the retract target is a self-intersection.
      return NO_MOVE;
    }

    if (nextState === BORDER) {
      if (this.drawing) {
        const closedLine = this.getLine();
        // Mixed-speed line closes as 'fast' if any cell was drawn fast
        // (docs/plan.md §3.2), 'slow' only if every cell was drawn slow.
        const lineSpeed: LineSpeed = this.lineSpeeds.some((s) => s === 'fast') ? 'fast' : 'slow';
        this.position = next;
        this.drawing = false;
        this.line = [];
        this.lineSpeeds = [];
        this.lineStart = null;
        return { moved: true, lineClosed: true, closedLine, lineSpeed, retracted: false };
      }
      this.position = next;
      return { moved: true, lineClosed: false, closedLine: null, lineSpeed: null, retracted: false };
    }

    // nextState === UNCLAIMED
    if (!drawHeld || !this.lineEntryEnabled) {
      return NO_MOVE;
    }
    if (!this.drawing) {
      this.drawing = true;
      this.lineStart = { ...this.position };
      this.line = [];
      this.lineSpeeds = [];
    }
    this.line.push(next);
    this.lineSpeeds.push(speed);
    field.set(next, LINE);
    this.position = next;
    return { moved: true, lineClosed: false, closedLine: null, lineSpeed: null, retracted: false };
  }

  /** Undoes the trailing drawn cell, moving the marker back to `retractTarget`. */
  private performRetract(field: Field, retractTarget: Point): MarkerMoveResult {
    const removed = this.line.pop();
    this.lineSpeeds.pop();
    if (removed) {
      field.set(removed, UNCLAIMED);
    }
    this.position = { ...retractTarget };
    if (this.line.length === 0) {
      // Fully retracted back to the border point where the line started.
      this.drawing = false;
      this.lineStart = null;
    }
    return { moved: true, lineClosed: false, closedLine: null, lineSpeed: null, retracted: true };
  }
}
