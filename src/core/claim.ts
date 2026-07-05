// Area-claiming algorithm. Pure logic — no DOM/Canvas dependencies.
// See docs/plan.md §4.2 for the specification this module implements.
import { Field, Point, UNCLAIMED, BORDER, CLAIMED_FAST, CLAIMED_SLOW } from './field';

export type LineSpeed = 'fast' | 'slow';

export interface ClaimResult {
  claimedCells: number;
  occupancy: number;
  /**
   * True when at least 2 enemy positions were passed to `claimArea` and, once
   * the line closed, one of them ended up outside the connected UNCLAIMED
   * component containing the first (docs/plan.md §4.2 "2匹 QIX への拡張":
   * splitting the enemies apart is an instant stage-clear, tracked one level
   * up by whoever calls `claimArea`). Always false for 0 or 1 enemies.
   */
  split: boolean;
}

const FOUR_NEIGHBOR_DELTAS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
];

/**
 * Flood fill (4-connected) over UNCLAIMED cells starting at `start`.
 * Returns the set of reachable cell indices (y * width + x).
 * If `start` is not itself UNCLAIMED, returns an empty set.
 */
export function floodFillUnclaimed(field: Field, start: Point): Set<number> {
  const width = field.getWidth();
  const visited = new Set<number>();

  if (field.get(start) !== UNCLAIMED) {
    return visited;
  }

  const stack: Point[] = [start];
  visited.add(start.y * width + start.x);

  while (stack.length > 0) {
    const p = stack.pop() as Point;
    for (const { dx, dy } of FOUR_NEIGHBOR_DELTAS) {
      const next: Point = { x: p.x + dx, y: p.y + dy };
      if (!field.isInBounds(next)) continue;

      const idx = next.y * width + next.x;
      if (visited.has(idx)) continue;
      if (field.get(next) !== UNCLAIMED) continue;

      visited.add(idx);
      stack.push(next);
    }
  }

  return visited;
}

/**
 * Converts BORDER cells that no longer border any UNCLAIMED cell (8-neighborhood)
 * into claimed cells. This keeps the border graph representative of the actual
 * remaining play area (important for future border-walking enemies).
 *
 * docs/plan.md §4.2 describes this as pruning "a line that has become fully
 * embedded" in claimed area — i.e. former in-progress lines, not the field's
 * permanent outer wall. The permanent boundary (x=0, x=width-1, y=0,
 * y=height-1) is therefore never a candidate: without this exclusion, a
 * field that becomes almost entirely claimed would also convert its entire
 * outer ring to CLAIMED_*, which — combined with Field.getOccupancy()'s
 * fixed interior-only denominator — could push occupancy past 100%.
 *
 * The claimed state chosen for a pruned cell follows the majority of its
 * claimed neighbors (ties resolve to CLAIMED_FAST).
 */
interface NeighborStats {
  hasUnclaimedNeighbor: boolean;
  fastCount: number;
  slowCount: number;
}

function collectNeighborStats(field: Field, p: Point): NeighborStats {
  const stats: NeighborStats = { hasUnclaimedNeighbor: false, fastCount: 0, slowCount: 0 };

  for (let dy = -1; dy <= 1 && !stats.hasUnclaimedNeighbor; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const neighbor: Point = { x: p.x + dx, y: p.y + dy };
      if (!field.isInBounds(neighbor)) continue;

      const state = field.get(neighbor);
      if (state === UNCLAIMED) {
        stats.hasUnclaimedNeighbor = true;
        break;
      } else if (state === CLAIMED_FAST) {
        stats.fastCount++;
      } else if (state === CLAIMED_SLOW) {
        stats.slowCount++;
      }
    }
  }

  return stats;
}

export function pruneDeadBorders(field: Field): void {
  const width = field.getWidth();
  const height = field.getHeight();
  const borderCells = field.getCellsOfState(BORDER);

  for (const p of borderCells) {
    const isPermanentBoundary = p.x === 0 || p.x === width - 1 || p.y === 0 || p.y === height - 1;
    if (isPermanentBoundary) continue;

    const { hasUnclaimedNeighbor, fastCount, slowCount } = collectNeighborStats(field, p);
    if (!hasUnclaimedNeighbor) {
      field.set(p, slowCount > fastCount ? CLAIMED_SLOW : CLAIMED_FAST);
    }
  }
}

/**
 * Closes a line and claims the resulting area.
 *
 * 1. All `line` cells become BORDER.
 * 2. UNCLAIMED cells reachable (4-connected) from the first enemy position
 *    stay UNCLAIMED.
 * 3. All other UNCLAIMED cells become CLAIMED_FAST/CLAIMED_SLOW (per `speed`).
 * 4. Dead borders (fully surrounded by claimed area) are pruned.
 *
 * `line` should contain only the interior cells drawn while off the border
 * (the start/end border points are already BORDER and don't need to be
 * included, though including them is harmless).
 *
 * `enemyPos` accepts either a single position (the M1-M3 single-Wisp shape,
 * kept for backward compatibility) or an array of positions (docs/plan.md
 * §4.2 "2匹 QIX への拡張"). When 2+ positions are given:
 *
 * - If every position lands in the same connected UNCLAIMED component
 *   (the common case), that single component is exactly "reachable from any
 *   enemy" per §4.2 — UNCLAIMED connectivity is symmetric, so there's no
 *   separate union to compute — and claiming proceeds exactly as the
 *   single-enemy case, anchored on the first position.
 * - If a later position ends up in a *different* component than the first,
 *   that's a split (`result.split = true`): the caller (docs/plan.md's
 *   session/game layer) is expected to treat this as an instant stage clear.
 *   The claim itself still anchors on the first position (its side stays
 *   UNCLAIMED; every other component, including the split-off enemy's, is
 *   claimed) so a split still yields a well-defined, scorable area.
 *
 * A boundary case (docs/plan.md §7.1) is deliberately excluded from split
 * detection: an enemy position that is no longer UNCLAIMED once the line
 * cells above are set (e.g. the line ran directly through it) can't be a
 * legitimate half of a split — the field state doesn't actually contain that
 * enemy in either resulting region — so it's ignored rather than reported as
 * a (false-positive) split.
 */
export function claimArea(field: Field, line: Point[], enemyPos: Point | Point[], speed: LineSpeed): ClaimResult {
  for (const p of line) {
    field.set(p, BORDER);
  }

  const positions = Array.isArray(enemyPos) ? enemyPos : [enemyPos];
  const width = field.getWidth();

  const reachable = floodFillUnclaimed(field, positions[0]);

  let split = false;
  for (let i = 1; i < positions.length; i++) {
    const other = positions[i];
    if (field.get(other) !== UNCLAIMED) continue; // boundary case: not a real half of a split (§7.1)
    const idx = other.y * width + other.x;
    if (!reachable.has(idx)) {
      split = true;
    }
  }

  const claimState = speed === 'slow' ? CLAIMED_SLOW : CLAIMED_FAST;

  let claimedCells = 0;
  for (const p of field.getCellsOfState(UNCLAIMED)) {
    const idx = p.y * width + p.x;
    if (!reachable.has(idx)) {
      field.set(p, claimState);
      claimedCells++;
    }
  }

  pruneDeadBorders(field);

  return { claimedCells, occupancy: field.getOccupancy(), split };
}
