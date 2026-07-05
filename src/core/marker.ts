// Marker (player) movement and line-drawing logic. Pure logic — no DOM/Canvas dependencies.
// See docs/plan.md §3.1 / §3.2 for the specification this module implements.
import { Field, Point, UNCLAIMED, BORDER, LINE, CLAIMED_FAST, CLAIMED_SLOW } from './field';

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
  /** True when this move retracted (undid) the last drawn line cell. */
  retracted: boolean;
}

const NO_MOVE: MarkerMoveResult = { moved: false, lineClosed: false, closedLine: null, retracted: false };

export class Marker {
  private position: Point;
  private line: Point[] = [];
  private lineStart: Point | null = null;
  private drawing = false;
  private retractEnabled: boolean;

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

  isDrawing(): boolean {
    return this.drawing;
  }

  setRetractEnabled(enabled: boolean): void {
    this.retractEnabled = enabled;
  }

  /**
   * Attempts to move the marker one grid cell in direction (dx, dy).
   * (dx, dy) must be a single-axis unit step (e.g. {1,0}, {0,-1}); anything
   * else (including {0,0} or a diagonal) is rejected.
   *
   * Movement rules (docs/plan.md §3.1/§3.2):
   * - BORDER cells are always freely walkable.
   * - UNCLAIMED cells can only be entered while `drawHeld` is true; doing so
   *   draws a LINE cell (starting a new line if not already drawing).
   * - CLAIMED_FAST/CLAIMED_SLOW cells are impassable (they are filled area,
   *   not a walkable path).
   * - Stepping onto the marker's own in-progress LINE is rejected as a
   *   self-intersection, *unless* it is the immediately preceding cell
   *   (retract), in which case the trailing LINE cell is undone.
   * - Reaching a BORDER cell while drawing closes the line and returns the
   *   drawn cells via `closedLine` for the caller to hand to `claimArea`.
   */
  tryMove(field: Field, dx: Axis, dy: Axis, drawHeld: boolean): MarkerMoveResult {
    if ((dx === 0 && dy === 0) || (dx !== 0 && dy !== 0)) {
      return NO_MOVE;
    }

    const next: Point = { x: this.position.x + dx, y: this.position.y + dy };
    if (!field.isInBounds(next)) {
      return NO_MOVE;
    }

    if (this.drawing && this.retractEnabled) {
      const retracted = this.tryRetract(field, next);
      if (retracted) return retracted;
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
        this.position = next;
        this.drawing = false;
        this.line = [];
        this.lineStart = null;
        return { moved: true, lineClosed: true, closedLine, retracted: false };
      }
      this.position = next;
      return { moved: true, lineClosed: false, closedLine: null, retracted: false };
    }

    // nextState === UNCLAIMED
    if (!drawHeld) {
      return NO_MOVE;
    }
    if (!this.drawing) {
      this.drawing = true;
      this.lineStart = { ...this.position };
      this.line = [];
    }
    this.line.push(next);
    field.set(next, LINE);
    this.position = next;
    return { moved: true, lineClosed: false, closedLine: null, retracted: false };
  }

  private tryRetract(field: Field, next: Point): MarkerMoveResult | null {
    const retractTarget = this.line.length >= 2 ? this.line[this.line.length - 2] : this.lineStart;
    if (!retractTarget || next.x !== retractTarget.x || next.y !== retractTarget.y) {
      return null;
    }

    const removed = this.line.pop();
    if (removed) {
      field.set(removed, UNCLAIMED);
    }
    this.position = { ...retractTarget };
    if (this.line.length === 0) {
      // Fully retracted back to the border point where the line started.
      this.drawing = false;
      this.lineStart = null;
    }
    return { moved: true, lineClosed: false, closedLine: null, retracted: true };
  }
}
