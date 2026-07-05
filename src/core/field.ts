import { GRID_WIDTH as CONFIG_GRID_WIDTH, GRID_HEIGHT as CONFIG_GRID_HEIGHT } from '../config';

// Cell state constants
export const UNCLAIMED = 0;
export const CLAIMED_FAST = 1;
export const CLAIMED_SLOW = 2;
export const BORDER = 3;
export const LINE = 4;

export type CellState = typeof UNCLAIMED | typeof CLAIMED_FAST | typeof CLAIMED_SLOW | typeof BORDER | typeof LINE;

export interface Point {
  x: number;
  y: number;
}

export function pointsEqual(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

export class Field {
  private grid: Uint8Array;
  private width: number;
  private height: number;
  private unclaimedCount: number;

  constructor(width: number = CONFIG_GRID_WIDTH, height: number = CONFIG_GRID_HEIGHT) {
    this.width = width;
    this.height = height;
    this.grid = new Uint8Array(width * height);
    this.unclaimedCount = 0;

    // Initialize: outer ring is BORDER, inner cells are UNCLAIMED
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
          this.set({ x, y }, BORDER);
        } else {
          this.set({ x, y }, UNCLAIMED);
          this.unclaimedCount++;
        }
      }
    }
  }

  isInBounds(p: Point): boolean {
    return p.x >= 0 && p.x < this.width && p.y >= 0 && p.y < this.height;
  }

  getWidth(): number {
    return this.width;
  }

  getHeight(): number {
    return this.height;
  }

  set(p: Point, state: CellState): void {
    if (!this.isInBounds(p)) return;
    const idx = this.pointToIndex(p);
    this.grid[idx] = state;
  }

  get(p: Point): CellState {
    if (!this.isInBounds(p)) return BORDER;
    const idx = this.pointToIndex(p);
    return this.grid[idx] as CellState;
  }

  // Allocation-free read access (no Point object needed) for hot paths like rendering
  getAt(x: number, y: number): CellState {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return BORDER;
    return this.grid[y * this.width + x] as CellState;
  }

  private pointToIndex(p: Point): number {
    return p.y * this.width + p.x;
  }

  private indexToPoint(idx: number): Point {
    return {
      x: idx % this.width,
      y: Math.floor(idx / this.width),
    };
  }

  getAllCells(): { point: Point; state: CellState }[] {
    const cells: { point: Point; state: CellState }[] = [];
    for (let idx = 0; idx < this.grid.length; idx++) {
      cells.push({
        point: this.indexToPoint(idx),
        state: this.grid[idx] as CellState,
      });
    }
    return cells;
  }

  getCellsOfState(state: CellState): Point[] {
    const cells: Point[] = [];
    for (let idx = 0; idx < this.grid.length; idx++) {
      if (this.grid[idx] === state) {
        cells.push(this.indexToPoint(idx));
      }
    }
    return cells;
  }

  // Calculate occupancy: (CLAIMED_FAST + CLAIMED_SLOW cells) / initial UNCLAIMED cells
  getOccupancy(): number {
    if (this.unclaimedCount === 0) return 0;

    let claimedCount = 0;
    for (let idx = 0; idx < this.grid.length; idx++) {
      const state = this.grid[idx];
      if (state === CLAIMED_FAST || state === CLAIMED_SLOW) {
        claimedCount++;
      }
    }

    return claimedCount / this.unclaimedCount;
  }

  // Clone the field for state manipulation
  clone(): Field {
    const cloned = new Field(this.width, this.height);
    for (let idx = 0; idx < this.grid.length; idx++) {
      cloned.grid[idx] = this.grid[idx];
    }
    cloned.unclaimedCount = this.unclaimedCount;
    return cloned;
  }
}
