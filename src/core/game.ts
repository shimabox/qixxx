// Game state coordinator for a single stage. Pure logic — no DOM/Canvas
// dependencies. Owns the field + marker + enemies, drives movement, triggers
// claimArea when a line closes (including the M4 split-clear path for 2-Wisp
// stages, docs/plan.md §4.2), and resolves collisions into misses/lives/
// stage-clear. The full Title/Playing/StageClear/GameOver state machine that
// strings stages together across a run (docs/plan.md §4.4 / §6 M4) lives one
// level up, in core/session.ts's GameSession — this class only ever knows
// about 'playing' | 'stageclear' | 'gameover' for the stage it's running.
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
 * Status of a single stage's simulation. Once it leaves 'playing' this class
 * stops advancing — 'stageclear' -> next stage's Playing and 'gameover' ->
 * Title are decided and driven by GameSession (core/session.ts, docs/plan.md
 * §4.4 / §6 M4), which replaces this Game instance entirely to move on.
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
  /**
   * Starting score (docs/plan.md §6 M4: score carries across a stage-clear
   * into the next stage). Defaults to 0 — the M1-M3 behavior for a
   * standalone Game.
   */
  score?: number;
  /**
   * Starting lives (docs/plan.md §6 M4: lives carry across a stage-clear
   * into the next stage). Defaults to INITIAL_LIVES — the M2-M3 behavior for
   * a standalone Game.
   */
  lives?: number;
  /**
   * Wisps present this stage (docs/plan.md §3.7: 1 for stage 1-2, 2 for
   * stage 3+ — see core/stage.ts). Takes precedence over the single `wisp`
   * constructor parameter when provided. Defaults to a single Wisp (the
   * `wisp` param, or a freshly-constructed one) so single-Wisp callers/tests
   * are unaffected.
   */
  wisps?: Wisp[];
  /**
   * Required occupancy to clear this stage (docs/plan.md §3.7): 65% for
   * stage 1-2, escalating to 75% by stage 3+. Defaults to
   * DEFAULT_REQUIRED_OCCUPANCY.
   */
  requiredOccupancy?: number;
}

export class Game {
  private field: Field;
  private marker: Marker;
  private wisps: Wisp[];
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
  private requiredOccupancy: number;
  // True when the most recent area claim cleared the stage by splitting the
  // Wisps apart rather than by reaching requiredOccupancy (docs/plan.md
  // §4.2/§3.6 "2匹 QIX への拡張"). Consumed by the session/stage layer to
  // decide whether to bump the next stage's score multiplier.
  private lastClearWasSplit = false;
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
    this.wisps = options.wisps ? [...options.wisps] : [wisp ?? new Wisp(wispStart, rng)];

    this.embers = options.embers ? [...options.embers] : [];
    this.emberSpawnIntervalTicks = options.emberSpawnIntervalTicks ?? EMBER_SPAWN_INTERVAL_TICKS;
    this.emberSpawnCooldownTicks = this.emberSpawnIntervalTicks;
    this.multiplier = options.multiplier ?? DEFAULT_SCORE_MULTIPLIER;
    this.requiredOccupancy = options.requiredOccupancy ?? DEFAULT_REQUIRED_OCCUPANCY;
    this.score = options.score ?? 0;
    this.lives = options.lives ?? INITIAL_LIVES;
  }

  getField(): Field {
    return this.field;
  }

  getMarker(): Marker {
    return this.marker;
  }

  /** The first (or only) Wisp — kept for the single-Wisp (stage 1-2) call sites/tests. */
  getWisp(): Wisp {
    return this.wisps[0];
  }

  /** All Wisps present this stage (docs/plan.md §3.7: 1 for stage 1-2, 2 for stage 3+). */
  getWisps(): Wisp[] {
    return this.wisps;
  }

  getRequiredOccupancy(): number {
    return this.requiredOccupancy;
  }

  /** See `lastClearWasSplit` — true iff the stage most recently cleared via a split, not occupancy. */
  getLastClearWasSplit(): boolean {
    return this.lastClearWasSplit;
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
    for (const wisp of this.wisps) {
      wisp.update(this.field);
    }
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
        const wispPositions = this.wisps.map((w) => w.getPosition());
        const claimResult: ClaimResult = claimArea(this.field, result.closedLine, wispPositions, lineSpeed);
        this.occupancy = claimResult.occupancy;
        this.score += scoreAreaClaim(claimResult.claimedCells, lineSpeed, this.multiplier);
        this.despawnIgniter();
        this.lastClearWasSplit = claimResult.split;
        if (claimResult.split) {
          // Splitting the Wisps apart clears the stage instantly, regardless
          // of occupancy (docs/plan.md §4.2/§3.6). The multiplier bump for
          // next stage is the session layer's responsibility (it owns the
          // split-success streak across stage boundaries).
          this.status = 'stageclear';
        } else if (this.occupancy >= this.requiredOccupancy) {
          this.score += scoreStageClearBonus(this.occupancy, this.requiredOccupancy);
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
      (this.wisps.some((w) => checkCollision(this.field, w.getTrail(), this.marker.getPosition())) ||
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
