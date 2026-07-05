// Game state coordinator. Pure logic — no DOM/Canvas dependencies.
// Owns the field + marker + Wisp, drives movement, triggers claimArea when a
// line closes, and (M2) resolves collisions into misses/lives/stage-clear.
// A full Title/StageClear/GameOver state machine arrives in M4 (docs/plan.md
// §6) — this is the minimal subset needed for the M2 acceptance criteria.
import { Field, Point } from './field';
import { Marker, MarkerMoveResult, Axis } from './marker';
import { claimArea, ClaimResult, LineSpeed } from './claim';
import { Wisp, Rng } from './enemy';
import { checkCollision } from './collision';
import { MARKER_MOVE_TICKS_FAST, INITIAL_LIVES, DEFAULT_REQUIRED_OCCUPANCY } from '../config';

export interface GameInput {
  dx: Axis;
  dy: Axis;
  drawHeld: boolean;
}

/**
 * Minimal game status for M2. The full Title/Playing/StageClear/GameOver
 * state machine (with transitions back to Playing / Title) is M4 scope
 * (docs/plan.md §4.4 / §6) — for now, once the game leaves 'playing' it
 * simply stops advancing.
 */
export type GameStatus = 'playing' | 'gameover' | 'stageclear';

export class Game {
  private field: Field;
  private marker: Marker;
  private wisp: Wisp;
  private occupancy = 0;
  private moveCooldownTicks = 0;
  private lives: number = INITIAL_LIVES;
  private status: GameStatus = 'playing';

  constructor(field: Field = new Field(), markerStart?: Point, wisp?: Wisp, rng?: Rng) {
    this.field = field;
    const start = markerStart ?? { x: Math.floor(field.getWidth() / 2), y: 0 };
    this.marker = new Marker(start);

    const wispStart: Point = {
      x: Math.floor(field.getWidth() / 2),
      y: Math.floor(field.getHeight() / 2),
    };
    this.wisp = wisp ?? new Wisp(wispStart, rng);
  }

  getField(): Field {
    return this.field;
  }

  getMarker(): Marker {
    return this.marker;
  }

  getWisp(): Wisp {
    return this.wisp;
  }

  getOccupancy(): number {
    return this.occupancy;
  }

  getLives(): number {
    return this.lives;
  }

  getStatus(): GameStatus {
    return this.status;
  }

  /**
   * Advances the game by one fixed tick given the current input state.
   * Returns the marker move result (or null if no move was attempted this
   * tick, e.g. no direction held, still on movement cooldown, or the game
   * has already ended). The Wisp always advances (and can trigger a miss)
   * regardless of marker input, as long as the game is still 'playing'.
   */
  update(input: GameInput): MarkerMoveResult | null {
    if (this.status !== 'playing') {
      return null;
    }

    this.wisp.update(this.field);

    let result: MarkerMoveResult | null = null;

    if (input.dx === 0 && input.dy === 0) {
      this.moveCooldownTicks = 0;
    } else if (this.moveCooldownTicks > 0) {
      this.moveCooldownTicks--;
    } else {
      result = this.marker.tryMove(this.field, input.dx, input.dy, input.drawHeld);
      // Only "fast" speed is implemented in M1/M2; slow (half-speed) lines arrive in M3.
      this.moveCooldownTicks = MARKER_MOVE_TICKS_FAST - 1;

      if (result.lineClosed && result.closedLine) {
        const speed: LineSpeed = 'fast';
        const claimResult: ClaimResult = claimArea(this.field, result.closedLine, this.wisp.getPosition(), speed);
        this.occupancy = claimResult.occupancy;
        if (this.occupancy >= DEFAULT_REQUIRED_OCCUPANCY) {
          this.status = 'stageclear';
        }
      }
    }

    if (this.status === 'playing' && checkCollision(this.field, this.wisp.getTrail(), this.marker.getPosition())) {
      this.handleMiss();
    }

    return result;
  }

  /**
   * Miss handling (docs/plan.md §3.5): the in-progress line vanishes, the
   * marker snaps back to where the line began, and a life is lost. Score
   * multiplier reset is out of scope until scoring lands in M4.
   */
  private handleMiss(): void {
    this.marker.cancelLine(this.field);
    this.lives -= 1;
    if (this.lives <= 0) {
      this.status = 'gameover';
    }
  }
}
