// Ember: the border-patrolling enemy. Pure logic — no DOM/Canvas dependencies.
// docs/plan.md §3.4 (2) describes this creature as "Sparx"; per §1 the
// original name is never used in code/UI, so it is called "Ember" here.
//
// Movement model (docs/plan.md §4.3): Ember walks the BORDER cell graph, one
// cell per EMBER_MOVE_TICKS ticks (slower than the marker). Each tick it
// prefers to keep its current heading; at a branch (more than one
// non-reversing BORDER neighbor) it picks whichever branch points most
// toward the marker (largest dot product with the direction-to-marker
// vector), and it never immediately backs into the cell it just came from
// unless that is the only option (a dead end). This deliberately isn't a
// shortest-path search — docs/plan.md §4.3/§8 call that unnecessary; the
// original game's Sparx use the same simple heuristic.
import { Field, Point, BORDER, pointsEqual } from './field';
import { EMBER_MOVE_TICKS } from '../config';

export interface Heading {
  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
}

interface Candidate {
  dir: Heading;
  point: Point;
}

// Fixed iteration order (up, right, down, left) makes branch tie-breaks deterministic.
const DIRECTIONS: readonly Heading[] = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

export class Ember {
  private pos: Point;
  private heading: Heading;
  private cameFrom: Point;
  private cooldownTicks = 0;

  /**
   * @param start Initial position, must be a BORDER cell.
   * @param initialHeading Initial direction of travel along the border.
   */
  constructor(start: Point, initialHeading: Heading) {
    this.pos = { ...start };
    this.heading = initialHeading;
    // No real "previous cell" yet; using the start position itself means the
    // came-from exclusion below never accidentally rules out a real neighbor.
    this.cameFrom = { ...start };
  }

  getPosition(): Point {
    return { ...this.pos };
  }

  getHeading(): Heading {
    return { ...this.heading };
  }

  /**
   * Advances Ember by one tick, throttled to one BORDER-cell step per
   * EMBER_MOVE_TICKS ticks. `targetPos` (the marker's position) only
   * influences which branch to take at a fork — Ember never leaves the
   * BORDER graph to chase it directly (docs/plan.md §4.3).
   */
  update(field: Field, targetPos: Point): void {
    if (this.cooldownTicks > 0) {
      this.cooldownTicks--;
      return;
    }
    this.cooldownTicks = EMBER_MOVE_TICKS - 1;

    const candidates: Candidate[] = DIRECTIONS.map((dir) => ({
      dir,
      point: { x: this.pos.x + dir.dx, y: this.pos.y + dir.dy },
    })).filter((c) => field.isInBounds(c.point) && field.get(c.point) === BORDER);

    if (candidates.length === 0) {
      // Boxed in — shouldn't normally happen on a connected border graph.
      // Hold position for this tick rather than crashing or teleporting.
      return;
    }

    const nonReversing = candidates.filter((c) => !pointsEqual(c.point, this.cameFrom));
    const pool = nonReversing.length > 0 ? nonReversing : candidates;

    const maintainingHeading = pool.find((c) => c.dir.dx === this.heading.dx && c.dir.dy === this.heading.dy);
    const chosen = maintainingHeading ?? this.pickTowardTarget(pool, targetPos);

    this.cameFrom = this.pos;
    this.pos = chosen.point;
    this.heading = chosen.dir;
  }

  private pickTowardTarget(pool: Candidate[], targetPos: Point): Candidate {
    const vx = targetPos.x - this.pos.x;
    const vy = targetPos.y - this.pos.y;

    let best = pool[0];
    let bestScore = best.dir.dx * vx + best.dir.dy * vy;
    for (let i = 1; i < pool.length; i++) {
      const score = pool[i].dir.dx * vx + pool[i].dir.dy * vy;
      if (score > bestScore) {
        best = pool[i];
        bestScore = score;
      }
    }
    return best;
  }
}
