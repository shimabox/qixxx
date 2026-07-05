// Game state coordinator. Pure logic — no DOM/Canvas dependencies.
// Owns the field + marker, drives marker movement, and triggers claimArea
// when a line closes. Enemy/miss/stage-clear logic is out of scope for M1
// (docs/plan.md §6).
import { Field, Point } from './field';
import { Marker, MarkerMoveResult, Axis } from './marker';
import { claimArea, ClaimResult, LineSpeed } from './claim';
import { MARKER_MOVE_TICKS_FAST } from '../config';

export interface GameInput {
  dx: Axis;
  dy: Axis;
  drawHeld: boolean;
}

export class Game {
  private field: Field;
  private marker: Marker;
  private enemyPos: Point;
  private occupancy = 0;
  private moveCooldownTicks = 0;

  constructor(field: Field = new Field(), markerStart?: Point) {
    this.field = field;
    const start = markerStart ?? { x: Math.floor(field.getWidth() / 2), y: 0 };
    this.marker = new Marker(start);

    // M1 has no enemies yet; the spec calls for the field center to stand
    // in for the (future) enemy head position so claimArea has a target to
    // flood-fill from.
    this.enemyPos = {
      x: Math.floor(field.getWidth() / 2),
      y: Math.floor(field.getHeight() / 2),
    };
  }

  getField(): Field {
    return this.field;
  }

  getMarker(): Marker {
    return this.marker;
  }

  getOccupancy(): number {
    return this.occupancy;
  }

  getEnemyPos(): Point {
    return { ...this.enemyPos };
  }

  /**
   * Advances the game by one fixed tick given the current input state.
   * Returns the marker move result (or null if no move was attempted this
   * tick, e.g. no direction held or still on movement cooldown).
   */
  update(input: GameInput): MarkerMoveResult | null {
    if (input.dx === 0 && input.dy === 0) {
      this.moveCooldownTicks = 0;
      return null;
    }

    if (this.moveCooldownTicks > 0) {
      this.moveCooldownTicks--;
      return null;
    }

    const result = this.marker.tryMove(this.field, input.dx, input.dy, input.drawHeld);
    // Only "fast" speed is implemented in M1; slow (half-speed) lines arrive in M3.
    this.moveCooldownTicks = MARKER_MOVE_TICKS_FAST - 1;

    if (result.lineClosed && result.closedLine) {
      const speed: LineSpeed = 'fast';
      const claimResult: ClaimResult = claimArea(this.field, result.closedLine, this.enemyPos, speed);
      this.occupancy = claimResult.occupancy;
    }

    return result;
  }
}
