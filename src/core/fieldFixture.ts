// Test-support helpers for building/asserting Field state from ASCII art.
// Used by claim.test.ts and marker.test.ts (docs/plan.md §7.1).
//
// Legend:
//   #  BORDER
//   .  UNCLAIMED
//   f  CLAIMED_FAST
//   s  CLAIMED_SLOW
//   L  LINE
// Any other single character is treated as an UNCLAIMED cell whose position
// is recorded under that character (e.g. 'Q' for an enemy position, 'M' for
// a marker start position).
import { Field, Point, CellState, UNCLAIMED, CLAIMED_FAST, CLAIMED_SLOW, BORDER, LINE } from './field';

const CHAR_TO_STATE: Record<string, CellState> = {
  '#': BORDER,
  '.': UNCLAIMED,
  f: CLAIMED_FAST,
  s: CLAIMED_SLOW,
  L: LINE,
};

const STATE_TO_CHAR = new Map<CellState, string>([
  [BORDER, '#'],
  [UNCLAIMED, '.'],
  [CLAIMED_FAST, 'f'],
  [CLAIMED_SLOW, 's'],
  [LINE, 'L'],
]);

export interface ParsedField {
  field: Field;
  markers: Map<string, Point[]>;
}

/** Parses an indented, multi-line ASCII-art block into a Field + marker positions. */
export function parseField(art: string): ParsedField {
  const lines = art
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('parseField: empty field art');
  }

  const height = lines.length;
  const width = lines[0].length;
  const field = new Field(width, height);
  const markers = new Map<string, Point[]>();

  for (let y = 0; y < height; y++) {
    const row = lines[y];
    if (row.length !== width) {
      throw new Error(`parseField: row ${y} has length ${row.length}, expected ${width}`);
    }
    for (let x = 0; x < width; x++) {
      const ch = row[x];
      const state = CHAR_TO_STATE[ch];
      const point: Point = { x, y };
      if (state !== undefined) {
        field.set(point, state);
      } else {
        field.set(point, UNCLAIMED);
        const existing = markers.get(ch);
        if (existing) {
          existing.push(point);
        } else {
          markers.set(ch, [point]);
        }
      }
    }
  }

  return { field, markers };
}

/** Renders a Field back into ASCII art (one row per line, no indentation). */
export function renderField(field: Field): string {
  const width = field.getWidth();
  const height = field.getHeight();
  const rows: string[] = [];

  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      row += STATE_TO_CHAR.get(field.getAt(x, y)) ?? '?';
    }
    rows.push(row);
  }

  return rows.join('\n');
}

/** Returns the single recorded position for `char` (throws if not found or ambiguous). */
export function markerAt(parsed: ParsedField, char: string): Point {
  const positions = parsed.markers.get(char);
  if (!positions || positions.length === 0) {
    throw new Error(`markerAt: no marker '${char}' found in fixture`);
  }
  if (positions.length > 1) {
    throw new Error(`markerAt: multiple markers '${char}' found in fixture, use markersAt`);
  }
  return positions[0];
}

/** Returns all recorded positions for `char`. */
export function markersAt(parsed: ParsedField, char: string): Point[] {
  return parsed.markers.get(char) ?? [];
}

/**
 * Builds a path of grid points from a compact spec string, e.g.:
 *   pathFrom("(4,0) D D D") -> [{x:4,y:1}, {x:4,y:2}, {x:4,y:3}]
 * Directions: U (up/-y), D (down/+y), L (left/-x), R (right/+x).
 * The starting point itself is not included in the returned path.
 */
export function pathFrom(spec: string): Point[] {
  const tokens = spec.trim().split(/\s+/);
  const startMatch = tokens[0]?.match(/^\((\d+),(\d+)\)$/);
  if (!startMatch) {
    throw new Error(`pathFrom: invalid start point token "${tokens[0]}"`);
  }

  let x = parseInt(startMatch[1], 10);
  let y = parseInt(startMatch[2], 10);
  const points: Point[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const dir = tokens[i].toUpperCase();
    switch (dir) {
      case 'U':
        y -= 1;
        break;
      case 'D':
        y += 1;
        break;
      case 'L':
        x -= 1;
        break;
      case 'R':
        x += 1;
        break;
      default:
        throw new Error(`pathFrom: invalid direction token "${tokens[i]}"`);
    }
    points.push({ x, y });
  }

  return points;
}
