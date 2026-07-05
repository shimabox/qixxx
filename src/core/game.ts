// Game state coordinator. Pure logic — no DOM/Canvas dependencies.
// Owns the field + marker + enemies, drives movement, triggers claimArea when
// a line closes, and resolves collisions into misses/lives/stage-clear. A
// full Title/StageClear/GameOver state machine arrives in M4 (docs/plan.md
// §6) — this is the minimal subset needed for the M3 acceptance criteria.
import { Field, Point, pointsEqual } from './field';
import { Marker, MarkerMoveResult, Axis } from './marker';
import { claimArea, ClaimResult, LineSpeed } from './claim';
import { Wisp, Rng } from './enemy';
import { Ember, Heading } from './patrol';
import { Igniter, shouldSpawnIgniter } from './fuse';
import { checkCollision } from './collision';
import { scoreAreaClaim, scoreStageClearBonus, DEFAULT_SCORE_MULTIPLIER } from './scoring';
import {
  MARKER_MOVE_TICKS_FAST,
  MARKER_MOVE_TICKS_SLOW,
  INITIAL_LIVES,
  MISS_GRACE_TICKS,
  DEFAULT_REQUIRED_OCCUPANCY,
  EMBER_SPAWN_INTERVAL_TICKS,
} from '../config';

export interface GameInput {
  dx: Axis;
  dy: Axis;
  drawHeld: boolean;
  /**
   * True while the slow-line button is held (docs/plan.md §5.1: Z/Shift).
   * Optional and defaults to falsy so existing fast-only callers/tests are
   * unaffected — omitting it (or passing false) always means "fast".
   */
  slow?: boolean;
}

/**
 * Minimal game status for M2/M3. The full Title/Playing/StageClear/GameOver
 * state machine (with transitions back to Playing / Title) is M4 scope
 * (docs/plan.md §4.4 / §6) — for now, once the game leaves 'playing' it
 * simply stops advancing.
 */
export type GameStatus = 'playing' | 'gameover' | 'stageclear';

export interface GameOptions {
  /**
   * Pre-existing Embers to start the game with (test hook). When omitted, no
   * Embers exist until the first EMBER_SPAWN_INTERVAL_TICKS elapse.
   */
  embers?: Ember[];
  /** Overrides EMBER_SPAWN_INTERVAL_TICKS (test hook, avoids waiting out the real 30s interval). */
  emberSpawnIntervalTicks?: number;
  /** Initial score multiplier (test hook for exercising the miss-reset path; docs/plan.md §3.5/§3.6). */
  multiplier?: number;
}

export class Game {
  private field: Field;
  private marker: Marker;
  private wisp: Wisp;
  private embers: Ember[];
  private emberSpawnIntervalTicks: number;
  private emberSpawnCooldownTicks: number;
  private igniter: Igniter | null = null;
  private stillTicks = 0;
  private occupancy = 0;
  private moveCooldownTicks = 0;
  private lives: number = INITIAL_LIVES;
  private status: GameStatus = 'playing';
  private score = 0;
  private multiplier: number;
  // Remaining post-miss grace ticks (docs/plan.md §3.5): while > 0, all miss
  // detection (Wisp x line, Ember x marker, Igniter catch-up) is suspended so
  // a single sustained contact costs exactly one life, not one per tick.
  private graceTicks = 0;

  constructor(
    field: Field = new Field(),
    markerStart?: Point,
    wisp?: Wisp,
    rng?: Rng,
    options: GameOptions = {}
  ) {
    this.field = field;
    const start = markerStart ?? { x: Math.floor(field.getWidth() / 2), y: 0 };
    this.marker = new Marker(start);

    const wispStart: Point = {
      x: Math.floor(field.getWidth() / 2),
      y: Math.floor(field.getHeight() / 2),
    };
    this.wisp = wisp ?? new Wisp(wispStart, rng);

    this.embers = options.embers ? [...options.embers] : [];
    this.emberSpawnIntervalTicks = options.emberSpawnIntervalTicks ?? EMBER_SPAWN_INTERVAL_TICKS;
    this.emberSpawnCooldownTicks = this.emberSpawnIntervalTicks;
    this.multiplier = options.multiplier ?? DEFAULT_SCORE_MULTIPLIER;
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

  getEmbers(): Ember[] {
    return this.embers;
  }

  getEmberPositions(): Point[] {
    return this.embers.map((e) => e.getPosition());
  }

  getIgniter(): Igniter | null {
    return this.igniter;
  }

  /** The Igniter's current position along the marker's line, or null if none is active. */
  getIgniterPosition(): Point | null {
    if (!this.igniter) return null;
    const line = this.marker.getLine();
    return line[this.igniter.getIndex()] ?? null;
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

  getScore(): number {
    return this.score;
  }

  getMultiplier(): number {
    return this.multiplier;
  }

  /**
   * Advances the game by one fixed tick given the current input state.
   * Returns the marker move result (or null if no move was attempted this
   * tick, e.g. no direction held, still on movement cooldown, or the game
   * has already ended). Enemies always advance (and can trigger a miss)
   * regardless of marker input, as long as the game is still 'playing'.
   */
  update(input: GameInput): MarkerMoveResult | null {
    if (this.status !== 'playing') {
      return null;
    }

    const markerPositionBeforeMove = this.marker.getPosition();
    this.wisp.update(this.field);
    for (const ember of this.embers) {
      ember.update(this.field, markerPositionBeforeMove);
    }
    this.maybeSpawnEmbers();

    const holdingDirection = input.dx !== 0 || input.dy !== 0;
    let result: MarkerMoveResult | null = null;

    if (!holdingDirection) {
      this.moveCooldownTicks = 0;
    } else if (this.moveCooldownTicks > 0) {
      this.moveCooldownTicks--;
    } else {
      const speed: LineSpeed = input.slow ? 'slow' : 'fast';
      result = this.marker.tryMove(this.field, input.dx, input.dy, input.drawHeld, speed);
      this.moveCooldownTicks = (input.slow ? MARKER_MOVE_TICKS_SLOW : MARKER_MOVE_TICKS_FAST) - 1;

      if (result.lineClosed && result.closedLine) {
        const lineSpeed: LineSpeed = result.lineSpeed ?? 'fast';
        const claimResult: ClaimResult = claimArea(this.field, result.closedLine, this.wisp.getPosition(), lineSpeed);
        this.occupancy = claimResult.occupancy;
        this.score += scoreAreaClaim(claimResult.claimedCells, lineSpeed, this.multiplier);
        this.despawnIgniter();
        if (this.occupancy >= DEFAULT_REQUIRED_OCCUPANCY) {
          this.score += scoreStageClearBonus(this.occupancy, DEFAULT_REQUIRED_OCCUPANCY);
          this.status = 'stageclear';
        }
      }
    }

    // Post-miss grace (docs/plan.md §3.5): while active, every miss check
    // below is skipped so a sustained contact (e.g. an Ember sitting on the
    // stationary marker's cell for several ticks) costs exactly one life.
    // Note everything above — enemy movement, marker movement, line
    // drawing/claiming — still ran normally this tick; only miss *detection*
    // is suspended. The Igniter lifecycle is also still driven during grace
    // (via updateIgniter below); its catch-up result is simply not acted on
    // until the grace period ends.
    const inGrace = this.graceTicks > 0;
    if (inGrace) {
      this.graceTicks--;
    }

    let missedThisTick = false;
    if (this.status === 'playing' && this.updateIgniter(holdingDirection) && !inGrace) {
      this.handleMiss();
      missedThisTick = true;
    }

    if (
      !inGrace &&
      !missedThisTick &&
      this.status === 'playing' &&
      (checkCollision(this.field, this.wisp.getTrail(), this.marker.getPosition()) ||
        this.embers.some((e) => pointsEqual(e.getPosition(), this.marker.getPosition())))
    ) {
      this.handleMiss();
    }

    return result;
  }

  /**
   * Spawns a fresh pair of Embers from the top of the field's border every
   * EMBER_SPAWN_INTERVAL_TICKS ticks (docs/plan.md §3.4 (2) / §3.7 stage 1:
   * 30s), starting from opposite top corners and heading toward each other.
   */
  private maybeSpawnEmbers(): void {
    if (this.emberSpawnCooldownTicks > 0) {
      this.emberSpawnCooldownTicks--;
      return;
    }
    const width = this.field.getWidth();
    const rightHeading: Heading = { dx: 1, dy: 0 };
    const leftHeading: Heading = { dx: -1, dy: 0 };
    this.embers.push(new Ember({ x: 0, y: 0 }, rightHeading));
    this.embers.push(new Ember({ x: width - 1, y: 0 }, leftHeading));
    this.emberSpawnCooldownTicks = this.emberSpawnIntervalTicks;
  }

  /**
   * Drives the Igniter lifecycle (docs/plan.md §3.4 (3)): tracks how long
   * the player has been stationary mid-line, spawns an Igniter (and disables
   * retract, §3.2) once the threshold is met, and advances the existing one.
   * Returns true if the Igniter just caught up to the marker (a miss).
   */
  private updateIgniter(holdingDirection: boolean): boolean {
    if (!this.marker.isDrawing()) {
      this.stillTicks = 0;
      // Any Igniter still active despite no line in progress was already
      // cleared by despawnIgniter() at the claim/miss call site.
      return false;
    }

    if (!this.igniter) {
      this.stillTicks = holdingDirection ? 0 : this.stillTicks + 1;
      if (shouldSpawnIgniter(this.stillTicks)) {
        this.igniter = new Igniter();
        this.marker.setRetractEnabled(false);
      }
      return false;
    }

    const maxIndex = this.marker.getLine().length - 1;
    return this.igniter.update(!holdingDirection, maxIndex);
  }

  private despawnIgniter(): void {
    this.igniter = null;
    this.stillTicks = 0;
    this.marker.setRetractEnabled(true);
  }

  /**
   * Miss handling (docs/plan.md §3.5): the in-progress line vanishes, the
   * marker snaps back to where the line began, the Igniter (if any)
   * vanishes and retract is re-enabled, a life is lost, the score
   * multiplier resets to 1, and a grace period starts during which no
   * further miss can be triggered (so one sustained contact = one life).
   */
  private handleMiss(): void {
    this.marker.cancelLine(this.field);
    this.despawnIgniter();
    this.multiplier = DEFAULT_SCORE_MULTIPLIER;
    this.graceTicks = MISS_GRACE_TICKS;
    this.lives -= 1;
    if (this.lives <= 0) {
      this.status = 'gameover';
    }
  }
}
