// Area-claiming algorithm. Pure logic — no DOM/Canvas dependencies.
// See docs/plan.md §4.2 for the specification this module implements.
import { Field, Point, UNCLAIMED, BORDER, LINE, CLAIMED_FAST, CLAIMED_SLOW } from './field';

export type LineSpeed = 'fast' | 'slow';

export type ClaimResult =
  | { accepted: false; claimedCells: 0; occupancy: number; split: false }
  | { accepted: true; claimedCells: number; occupancy: number; split: boolean };

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
 * When called from claimArea(), a pruned border takes the colour of the claim
 * that made it obsolete. This makes a later claim visually own the former
 * boundary instead of leaving a one-cell bite of the older colour. Standalone
 * callers without a claim state fall back to the majority of claimed
 * neighbors; fallback ties resolve to CLAIMED_FAST.
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

export function pruneDeadBorders(
  field: Field,
  claimState?: typeof CLAIMED_FAST | typeof CLAIMED_SLOW
): void {
  const width = field.getWidth();
  const height = field.getHeight();
  const borderCells = field.getCellsOfState(BORDER);

  for (const p of borderCells) {
    const isPermanentBoundary = p.x === 0 || p.x === width - 1 || p.y === 0 || p.y === height - 1;
    if (isPermanentBoundary) continue;

    const { hasUnclaimedNeighbor, fastCount, slowCount } = collectNeighborStats(field, p);
    if (!hasUnclaimedNeighbor) {
      field.set(p, claimState ?? (slowCount > fastCount ? CLAIMED_SLOW : CLAIMED_FAST));
    }
  }
}

/**
 * Closes a line and claims the resulting area.
 *
 * Enemy positions are valid only while in bounds, currently UNCLAIMED, and
 * outside the closing line. Invalid positions are ignored without changing
 * the relative order of the remaining positions; the first valid position is
 * the flood-fill anchor and later valid positions participate in split
 * detection.
 *
 * If no valid position remains, the claim is rejected. Only cells from `line`
 * that are currently LINE are restored to UNCLAIMED; existing BORDER and
 * claimed cells are preserved, and neither claiming nor dead-border pruning
 * runs. Accepted claims convert in-bounds line cells to BORDER, preserve the
 * anchor's connected UNCLAIMED component, claim all other UNCLAIMED cells,
 * and prune dead borders.
 *
 * `enemyPos` accepts either a single position or an array for backward
 * compatibility. The result's `accepted` discriminator tells callers whether
 * field and score state may advance.
 */
export function claimArea(field: Field, line: Point[], enemyPos: Point | Point[], speed: LineSpeed): ClaimResult {
  const claimState = speed === 'slow' ? CLAIMED_SLOW : CLAIMED_FAST;
  const width = field.getWidth();
  const lineIndices = new Set<number>();

  for (const p of line) {
    if (field.isInBounds(p)) {
      lineIndices.add(p.y * width + p.x);
    }
  }

  const positions = Array.isArray(enemyPos) ? enemyPos : [enemyPos];
  const validPositions = positions.filter(
    (position) =>
      field.isInBounds(position) &&
      field.get(position) === UNCLAIMED &&
      !lineIndices.has(position.y * width + position.x)
  );

  if (validPositions.length === 0) {
    for (const p of line) {
      if (field.isInBounds(p) && field.get(p) === LINE) {
        field.set(p, UNCLAIMED);
      }
    }
    return { accepted: false, claimedCells: 0, occupancy: field.getOccupancy(), split: false };
  }

  for (const p of line) {
    if (field.isInBounds(p)) {
      field.set(p, BORDER);
    }
  }

  const reachable = floodFillUnclaimed(field, validPositions[0]);

  let split = false;
  for (let i = 1; i < validPositions.length; i++) {
    const other = validPositions[i];
    const idx = other.y * width + other.x;
    if (!reachable.has(idx)) {
      split = true;
    }
  }

  let claimedCells = 0;
  for (const p of field.getCellsOfState(UNCLAIMED)) {
    const idx = p.y * width + p.x;
    if (!reachable.has(idx)) {
      field.set(p, claimState);
      claimedCells++;
    }
  }

  pruneDeadBorders(field, claimState);

  return { accepted: true, claimedCells, occupancy: field.getOccupancy(), split };
}
