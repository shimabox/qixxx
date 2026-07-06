// Ember: the border-patrolling enemy. Pure logic — no DOM/Canvas dependencies.
// docs/plan.md §3.4 (2) describes this creature as "Sparx"; per §1 the
// original name is never used in code/UI, so it is called "Ember" here.
//
// Movement model (docs/plan.md §4.3, updated by §6 M8 / §12.2): Ember walks
// the BORDER cell graph, one cell per EMBER_MOVE_TICKS ticks (slower than the
// marker), and it never immediately backs into the cell it just came from
// unless that is the only option (a dead end).
//
// A *branch point* is a cell with 2+ non-reversing candidate cells (i.e.
// there is a real choice to make, not just "continue" vs "reverse"). At a
// branch point, with probability EMBER_BRANCH_CHASE_PROBABILITY Ember picks
// whichever candidate points most toward the marker (largest dot product
// with the direction-to-marker vector) — even if that means turning off its
// current heading. The rest of the time (and always at a non-branch cell) it
// falls back to the pre-M8 heuristic: keep the current heading if possible,
// otherwise pick toward the marker. Without the probabilistic branch-chase,
// an Ember on the outer ring can maintain its heading forever and never turn
// onto the inner border lines created by claimed area, making it a
// non-threat (real-playtest feedback that motivated M8). This deliberately
// isn't a shortest-path search — docs/plan.md §4.3/§8 call that unnecessary;
// the original game's Sparx use a similarly simple heuristic.
import { Field, Point, BORDER, pointsEqual } from './field';
import { EMBER_MOVE_TICKS, EMBER_BRANCH_CHASE_PROBABILITY } from '../config';

export interface Heading {
  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
}

/**
 * Random number generator hook, injectable so tests can be deterministic
 * (docs/plan.md §6 M8: rng drives the branch-chase probability roll).
 * Structurally identical to core/enemy.ts's `Rng` — kept as its own alias
 * here so patrol.ts doesn't depend on enemy.ts.
 */
export type Rng = () => number;

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
  private readonly rng: Rng;
  private moveTicks: number;
  private branchChaseProbability: number;

  /**
   * @param start Initial position, must be a BORDER cell.
   * @param initialHeading Initial direction of travel along the border.
   * @param rng Random source for the M8 branch-chase probability roll.
   *   Defaults to `Math.random`; tests and `Game` (for reproducibility)
   *   should inject a deterministic function. Optional and defaulted so
   *   pre-M8 call sites/tests that only pass (start, initialHeading) keep
   *   compiling and behaving as before.
   * @param moveTicks Overrides EMBER_MOVE_TICKS (docs/plan.md §6 M10 / §12.4:
   *   the debug panel's "Ember 移動間隔 tick" slider). Defaults to the
   *   config constant so pre-M10 call sites are unaffected.
   * @param branchChaseProbability Overrides EMBER_BRANCH_CHASE_PROBABILITY
   *   (docs/plan.md §6 M10 / §12.4: the debug panel's "分岐追跡確率" slider).
   *   Defaults to the config constant so pre-M10 call sites are unaffected.
   */
  constructor(
    start: Point,
    initialHeading: Heading,
    rng: Rng = Math.random,
    moveTicks: number = EMBER_MOVE_TICKS,
    branchChaseProbability: number = EMBER_BRANCH_CHASE_PROBABILITY
  ) {
    this.pos = { ...start };
    this.heading = initialHeading;
    // No real "previous cell" yet; using the start position itself means the
    // came-from exclusion below never accidentally rules out a real neighbor.
    this.cameFrom = { ...start };
    this.rng = rng;
    this.moveTicks = moveTicks;
    this.branchChaseProbability = branchChaseProbability;
  }

  getPosition(): Point {
    return { ...this.pos };
  }

  getHeading(): Heading {
    return { ...this.heading };
  }

  /** Current per-cell move throttle in ticks (docs/plan.md §6 M10 debug panel export). */
  getMoveTicks(): number {
    return this.moveTicks;
  }

  /**
   * Overrides the per-cell move throttle at runtime (docs/plan.md §6 M10 /
   * §12.4). Takes effect the next time the current cooldown elapses and a
   * new one is started — never lengthens/shortens a cooldown already in
   * progress mid-count.
   */
  setMoveTicks(ticks: number): void {
    this.moveTicks = ticks;
  }

  /** Current branch-chase probability (docs/plan.md §6 M10 debug panel export). */
  getBranchChaseProbability(): number {
    return this.branchChaseProbability;
  }

  /** Overrides the branch-chase probability at runtime (docs/plan.md §6 M10 / §12.4). */
  setBranchChaseProbability(probability: number): void {
    this.branchChaseProbability = probability;
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
    this.cooldownTicks = this.moveTicks - 1;

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

    // Branch point (docs/plan.md §6 M8 / §12.2): 2+ non-reversing candidates
    // means Ember has a real choice, not just "continue" vs "reverse". The
    // rng roll — and the marker-chase override it can produce — only ever
    // applies here; a corridor (0 or 1 non-reversing candidates) always
    // keeps the pre-M8 "maintain heading, else chase" behavior.
    const isBranchPoint = nonReversing.length >= 2;
    const rollsChase = isBranchPoint && this.rng() < this.branchChaseProbability;

    let chosen: Candidate;
    if (rollsChase) {
      chosen = this.pickTowardTarget(pool, targetPos);
    } else {
      const maintainingHeading = pool.find((c) => c.dir.dx === this.heading.dx && c.dir.dy === this.heading.dy);
      chosen = maintainingHeading ?? this.pickTowardTarget(pool, targetPos);
    }

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
