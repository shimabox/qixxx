// Game state coordinator for a single stage. Pure logic — no DOM/Canvas
// dependencies. Owns the field + marker + enemies, drives movement, triggers
// claimArea when a line closes (including the M4 split-clear path for 2-Wisp
// stages, docs/plan.md §4.2), and resolves collisions into misses/lives/
// stage-clear. The full Title/Playing/StageClear/GameOver state machine that
// strings stages together across a run (docs/plan.md §4.4 / §6 M4) lives one
// level up, in core/session.ts's GameSession — this class only ever knows
// about 'playing' | 'stageclear' | 'gameover' for the stage it's running.
import { Field, Point, pointsEqual, UNCLAIMED, BORDER } from './field';
import { Marker, MarkerMoveResult, Axis } from './marker';
import { claimArea, ClaimResult, LineSpeed } from './claim';
import { Wisp, Rng } from './enemy';
import { Ember, Heading } from './patrol';
import { Igniter, shouldSpawnIgniter } from './fuse';
import { checkCollision } from './collision';
import { scoreAreaClaim, scoreStageClearBonus, DEFAULT_SCORE_MULTIPLIER } from './scoring';
import { EventQueue, GameEvent } from './events';
import {
  MARKER_MOVE_TICKS_FAST,
  MARKER_MOVE_TICKS_SLOW,
  INITIAL_LIVES,
  MISS_GRACE_TICKS,
  DEFAULT_REQUIRED_OCCUPANCY,
  EMBER_SPAWN_INTERVAL_TICKS,
  EMBER_MOVE_TICKS,
  EMBER_BRANCH_CHASE_PROBABILITY,
  EMBER_MAX_CONCURRENT_STAGE1,
  TICK_RATE,
} from '../config';

/**
 * Runtime tuning overrides for the dev-only debug panel (docs/plan.md §6
 * M10 / §12.4). Every field is optional: `undefined` means "no override,
 * use this stage's own default". Plain data — this type has no DOM
 * dependency, so `src/core/` stays DOM-free even though `src/debug/panel.ts`
 * is the only thing that ever constructs one of these outside tests.
 */
export interface DebugOverrides {
  /** Number of Wisps present (0-10 per the panel's slider range). */
  wispCount?: number;
  /** Multiplies WISP_SPEED for every Wisp (0.25-5.0 per the panel). */
  wispSpeedMultiplier?: number;
  /** Number of Embers present (0-10 per the panel's slider range). */
  emberCount?: number;
  /** Ticks per BORDER-cell step for every Ember (1-10 per the panel). */
  emberMoveTicks?: number;
  /** Seconds between fresh Ember-pair spawns. */
  emberSpawnIntervalSec?: number;
  /** Branch-chase probability [0,1] for every Ember (see patrol.ts). */
  emberBranchChaseProbability?: number;
  /** Required occupancy fraction [0.10, 0.90] to clear the stage. */
  requiredOccupancy?: number;
}

/**
 * The actually-in-effect value of every debug-tunable parameter right now —
 * whichever is active between an override and the stage's own default
 * (docs/plan.md §6 M10). Read by the debug panel both to seed its sliders
 * on mount and to build the EXPORT JSON blob.
 */
export interface EffectiveDebugParams {
  wispCount: number;
  wispSpeedMultiplier: number;
  emberCount: number;
  emberMoveTicks: number;
  emberSpawnIntervalSec: number;
  emberBranchChaseProbability: number;
  requiredOccupancy: number;
}

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
   * Wisps present this stage (docs/plan.md §12.7: stage n = n Wisps, capped
   * at STAGE_MAX_DIFFICULTY — see core/stage.ts). Takes precedence over the
   * single `wisp` constructor parameter when provided. Defaults to a single
   * Wisp (the `wisp` param, or a freshly-constructed one) so single-Wisp
   * callers/tests are unaffected.
   */
  wisps?: Wisp[];
  /**
   * Required occupancy to clear this stage (docs/plan.md §12.7): 65% at
   * stage 1, escalating to 90% by stage 10. Defaults to
   * DEFAULT_REQUIRED_OCCUPANCY.
   */
  requiredOccupancy?: number;
  /**
   * Ticks per BORDER-cell step for every Ember spawned/overridden this stage
   * (docs/plan.md §12.7: 3 at stage 1, down to 1 by stage 10 — see
   * core/stage.ts). Defaults to EMBER_MOVE_TICKS (the stage-1 baseline).
   */
  emberMoveTicks?: number;
  /**
   * Branch-chase probability for every Ember spawned/overridden this stage
   * (docs/plan.md §12.7: 0.7 at stage 1, up to 1.0 by stage 10). Defaults to
   * EMBER_BRANCH_CHASE_PROBABILITY (the stage-1 baseline).
   */
  emberBranchChaseProbability?: number;
  /**
   * Max Embers allowed alive at once before maybeSpawnEmbers() starts
   * skipping spawns (docs/plan.md §12.7 "Ember 同時数上限": 2 at stage 1, up
   * to 10 by stage 10). Bypassed while a debug emberCount override is active
   * (see maybeSpawnEmbers()). Defaults to EMBER_MAX_CONCURRENT_STAGE1.
   */
  maxConcurrentEmbers?: number;
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
  // Shared rng, also handed to every Wisp (constructor param) and every
  // Ember spawned by maybeSpawnEmbers (docs/plan.md §6 M8: Ember's branch-
  // chase roll). Keeping one rng per Game (rather than a fresh Math.random
  // per enemy) is what makes a whole stage's simulation reproducible when a
  // deterministic rng is injected (debugging/tests).
  private readonly rng: Rng;
  // True when the most recent area claim cleared the stage by splitting the
  // Wisps apart rather than by reaching requiredOccupancy (docs/plan.md
  // §4.2/§3.6 "2匹 QIX への拡張"). Consumed by the session/stage layer to
  // decide whether to bump the next stage's score multiplier.
  private lastClearWasSplit = false;
  // Remaining post-miss grace ticks (docs/plan.md §3.5): while > 0, all miss
  // detection (Wisp x line, Ember x marker, Igniter catch-up) is suspended so
  // a single sustained contact costs exactly one life, not one per tick.
  private graceTicks = 0;
  // Discrete occurrences this stage's simulation has produced but that
  // nobody has drained yet (docs/plan.md §3.8/§9.9: this is the entire
  // core -> audio bridge — Game never touches AudioContext itself). See
  // core/events.ts for what belongs here vs. what's a plain getter instead.
  private events = new EventQueue<GameEvent>();
  // Positions where an Ember was just despawned (docs/plan.md §6 M11 /
  // §12.6), queued alongside (not instead of) the 'ember-despawned' entries
  // pushed to `events` above. GameEvent stays a plain string union (the
  // audio bridge's whole contract) so the one occurrence that needs a
  // payload — the render layer's vanish-effect position — gets its own
  // parallel queue rather than turning every event into a discriminated
  // union. See drainDespawnedEmberPositions() below and GameSession's
  // forwarding of the same.
  private despawnedEmberPositions = new EventQueue<Point>();

  // Debug-panel overrides (docs/plan.md §6 M10 / §12.4). `debugOverrides`
  // holds only the fields the panel has actually touched; everything else
  // falls back to this stage's own "base" value, captured once at
  // construction time below and restored verbatim by resetDebugOverrides().
  private debugOverrides: DebugOverrides = {};
  private readonly baseWispCount: number;
  private readonly baseWispSpeedMultiplier: number;
  private readonly baseEmberCount: number;
  private readonly baseEmberMoveTicks: number;
  private readonly baseEmberSpawnIntervalTicks: number;
  private readonly baseEmberBranchChaseProbability: number;
  private readonly baseRequiredOccupancy: number;
  // Ember concurrency cap (docs/plan.md §6 M12 / §12.7): not debug-overridable
  // itself (there's no panel slider for it), just the stage's own fixed
  // value for the lifetime of this Game instance. See maybeSpawnEmbers().
  private readonly maxConcurrentEmbers: number;

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
    this.rng = rng ?? Math.random;

    this.embers = options.embers ? [...options.embers] : [];
    this.emberSpawnIntervalTicks = options.emberSpawnIntervalTicks ?? EMBER_SPAWN_INTERVAL_TICKS;
    this.emberSpawnCooldownTicks = this.emberSpawnIntervalTicks;
    this.multiplier = options.multiplier ?? DEFAULT_SCORE_MULTIPLIER;
    this.requiredOccupancy = options.requiredOccupancy ?? DEFAULT_REQUIRED_OCCUPANCY;
    this.score = options.score ?? 0;
    this.lives = options.lives ?? INITIAL_LIVES;

    // Snapshot this stage's own defaults (docs/plan.md §6 M10 "RESET は
    // ステージ既定値に戻す") before any debug override can touch them.
    this.baseWispCount = this.wisps.length;
    this.baseWispSpeedMultiplier = this.wisps[0]?.getSpeedMultiplier() ?? 1;
    this.baseEmberCount = this.embers.length;
    this.baseEmberMoveTicks = options.emberMoveTicks ?? EMBER_MOVE_TICKS;
    this.baseEmberSpawnIntervalTicks = this.emberSpawnIntervalTicks;
    this.baseEmberBranchChaseProbability = options.emberBranchChaseProbability ?? EMBER_BRANCH_CHASE_PROBABILITY;
    this.baseRequiredOccupancy = this.requiredOccupancy;
    this.maxConcurrentEmbers = options.maxConcurrentEmbers ?? EMBER_MAX_CONCURRENT_STAGE1;
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

  /** All Wisps present this stage (docs/plan.md §12.7: stage n = n Wisps, capped at STAGE_MAX_DIFFICULTY). */
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
   * Remaining post-miss grace ticks (0 when not in grace). Exposed purely as
   * a render/feedback hook (docs/plan.md §6 M5 "ミス時の簡易フィードバック":
   * the marker can blink while this is > 0) — nothing in Game itself reads
   * it externally.
   */
  getGraceTicks(): number {
    return this.graceTicks;
  }

  /**
   * Drains (returns and clears) every GameEvent queued since the last call
   * (docs/plan.md §3.8/§9.9). Pure data — see core/events.ts. Callers (e.g.
   * GameSession, which forwards these up to main.ts's audio layer) should
   * call this once per tick so nothing is lost across a stage transition.
   */
  drainEvents(): GameEvent[] {
    return this.events.drain();
  }

  /**
   * Drains (returns and clears) every position where an Ember has just been
   * despawned since the last call (docs/plan.md §6 M11 / §12.6). The render
   * layer uses these to spawn a short "vanish" visual effect; core itself
   * holds no drawing state, just the plain position. Callers should drain
   * this once per tick, same as drainEvents() — see that method's doc
   * comment for why (GameSession forwards both up to main.ts identically).
   */
  drainDespawnedEmberPositions(): Point[] {
    return this.despawnedEmberPositions.drain();
  }

  /**
   * Applies dev-only debug-panel overrides (docs/plan.md §6 M10 / §12.4):
   * merges `overrides` into whatever's already active, then immediately
   * reconciles the running stage to match (spawning/despawning Wisps and
   * Embers on the spot, retuning speed/timing/probability knobs on every
   * existing entity). Fields omitted from `overrides` are left as they
   * currently are — pass an explicit value to change one, call
   * `resetDebugOverrides()` to drop them all back to this stage's defaults.
   */
  applyDebugOverrides(overrides: Partial<DebugOverrides>): void {
    this.debugOverrides = { ...this.debugOverrides, ...overrides };
    this.reconcileDebugOverrides();
  }

  /**
   * Drops every active debug override, restoring this stage's own defaults
   * (docs/plan.md §6 M10 "RESET ボタン"): Wisp/Ember counts and every
   * speed/timing/probability knob revert to what this stage was
   * constructed with.
   */
  resetDebugOverrides(): void {
    this.debugOverrides = {};
    this.reconcileDebugOverrides();
  }

  /** The debug overrides currently active (only the fields the panel has touched). */
  getDebugOverrides(): DebugOverrides {
    return { ...this.debugOverrides };
  }

  /**
   * True while at least one debug override is active. Used to gate high
   * -score persistence (docs/plan.md §6 M10: "デバッグパネル使用中はハイス
   * コアを保存しない") — main.ts checks this (via GameSession) before
   * writing to localStorage.
   */
  hasActiveDebugOverrides(): boolean {
    return Object.keys(this.debugOverrides).length > 0;
  }

  /**
   * The actually-in-effect value of every debug-tunable parameter right
   * now (docs/plan.md §6 M10): read directly off the live entities/state
   * rather than just echoing `debugOverrides`, so it stays correct even
   * when, say, `emberCount` has never been overridden (falls back to
   * however many Embers have naturally spawned so far). Used by the debug
   * panel both to seed its sliders on mount and to build the EXPORT JSON.
   */
  getEffectiveDebugParams(): EffectiveDebugParams {
    return {
      wispCount: this.wisps.length,
      wispSpeedMultiplier: this.wisps[0]?.getSpeedMultiplier() ?? this.debugOverrides.wispSpeedMultiplier ?? this.baseWispSpeedMultiplier,
      emberCount: this.embers.length,
      emberMoveTicks: this.embers[0]?.getMoveTicks() ?? this.debugOverrides.emberMoveTicks ?? this.baseEmberMoveTicks,
      emberSpawnIntervalSec: this.emberSpawnIntervalTicks / TICK_RATE,
      emberBranchChaseProbability:
        this.embers[0]?.getBranchChaseProbability() ??
        this.debugOverrides.emberBranchChaseProbability ??
        this.baseEmberBranchChaseProbability,
      requiredOccupancy: this.requiredOccupancy,
    };
  }

  /**
   * Reconciles every debug-overridable knob to its currently-effective
   * value (override, if set, else this stage's base) — called after any
   * change to `debugOverrides` (docs/plan.md §6 M10's "即時反映").
   */
  private reconcileDebugOverrides(): void {
    const o = this.debugOverrides;

    const targetWispSpeed = o.wispSpeedMultiplier ?? this.baseWispSpeedMultiplier;
    this.setWispCount(o.wispCount ?? this.baseWispCount, targetWispSpeed);
    for (const wisp of this.wisps) {
      wisp.setSpeedMultiplier(targetWispSpeed);
    }

    const targetMoveTicks = o.emberMoveTicks ?? this.baseEmberMoveTicks;
    const targetBranchProbability = o.emberBranchChaseProbability ?? this.baseEmberBranchChaseProbability;
    this.setEmberCount(o.emberCount ?? this.baseEmberCount, targetMoveTicks, targetBranchProbability);
    for (const ember of this.embers) {
      ember.setMoveTicks(targetMoveTicks);
      ember.setBranchChaseProbability(targetBranchProbability);
    }

    this.emberSpawnIntervalTicks =
      o.emberSpawnIntervalSec !== undefined
        ? Math.round(o.emberSpawnIntervalSec * TICK_RATE)
        : this.baseEmberSpawnIntervalTicks;

    this.requiredOccupancy = o.requiredOccupancy ?? this.baseRequiredOccupancy;
  }

  /** Spawns/despawns Wisps until exactly `target` remain (docs/plan.md §6 M10). */
  private setWispCount(target: number, speedMultiplier: number): void {
    const clamped = Math.max(0, Math.floor(target));
    while (this.wisps.length > clamped) {
      this.wisps.pop();
    }
    while (this.wisps.length < clamped) {
      this.wisps.push(new Wisp(this.findUnclaimedSpawnCell(), this.rng, undefined, speedMultiplier));
    }
  }

  /** Spawns/despawns Embers until exactly `target` remain (docs/plan.md §6 M10). */
  private setEmberCount(target: number, moveTicks: number, branchChaseProbability: number): void {
    const clamped = Math.max(0, Math.floor(target));
    while (this.embers.length > clamped) {
      this.embers.pop();
    }
    while (this.embers.length < clamped) {
      const width = this.field.getWidth();
      const spawnOnRight = this.embers.length % 2 === 1;
      const start: Point = spawnOnRight ? { x: width - 1, y: 0 } : { x: 0, y: 0 };
      const heading: Heading = spawnOnRight ? { dx: -1, dy: 0 } : { dx: 1, dy: 0 };
      this.embers.push(new Ember(start, heading, this.rng, moveTicks, branchChaseProbability));
    }
  }

  /**
   * Finds a reasonable UNCLAIMED cell to drop a debug-spawned Wisp on: the
   * field's center if it's still UNCLAIMED (the common case, matching where
   * every stage's own Wisps start), otherwise the UNCLAIMED cell closest to
   * it (mid-game, most of the field may already be claimed/BORDER/LINE).
   */
  private findUnclaimedSpawnCell(): Point {
    const center: Point = { x: Math.floor(this.field.getWidth() / 2), y: Math.floor(this.field.getHeight() / 2) };
    if (this.field.get(center) === UNCLAIMED) {
      return center;
    }

    const unclaimedCells = this.field.getCellsOfState(UNCLAIMED);
    if (unclaimedCells.length === 0) {
      return center; // No UNCLAIMED cell left at all — shouldn't happen while still 'playing'.
    }

    let closest = unclaimedCells[0];
    let closestDistSq = distanceSquared(closest, center);
    for (const cell of unclaimedCells) {
      const d = distanceSquared(cell, center);
      if (d < closestDistSq) {
        closest = cell;
        closestDistSq = d;
      }
    }
    return closest;
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
        this.despawnTrappedEmbers();
        this.events.push('area-claimed');
        this.lastClearWasSplit = claimResult.split;
        if (claimResult.split) {
          // Splitting the Wisps apart clears the stage instantly, regardless
          // of occupancy (docs/plan.md §4.2/§3.6). The multiplier bump for
          // next stage is the session layer's responsibility (it owns the
          // split-success streak across stage boundaries).
          this.status = 'stageclear';
          this.events.push('split-clear');
        } else if (this.occupancy >= this.requiredOccupancy) {
          this.score += scoreStageClearBonus(this.occupancy, this.requiredOccupancy);
          this.status = 'stageclear';
          this.events.push('stage-clear');
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
   * EMBER_SPAWN_INTERVAL_TICKS ticks (docs/plan.md §3.4 (2) / §12.7 stage 1:
   * 30s, down to 5s by stage 10), starting from opposite top corners and
   * heading toward each other.
   *
   * Concurrency-capped (docs/plan.md §6 M12 / §12.7 "Ember 同時数上限"): once
   * `maxConcurrentEmbers` are already alive, this cycle's spawn is skipped
   * entirely (the cooldown still resets, so the cap is re-checked every
   * interval — an Ember despawning in the meantime, e.g. via
   * despawnTrappedEmbers(), naturally lets the next cycle top back up). If
   * only one slot of room remains, only one of the usual pair spawns rather
   * than pushing past the cap. The cap is bypassed entirely while a debug
   * emberCount override is active (docs/plan.md §6 M10) — that's an explicit
   * developer action, not the natural stage curve, so it's never
   * second-guessed here.
   */
  private maybeSpawnEmbers(): void {
    if (this.emberSpawnCooldownTicks > 0) {
      this.emberSpawnCooldownTicks--;
      return;
    }
    this.emberSpawnCooldownTicks = this.emberSpawnIntervalTicks;

    const capActive = this.debugOverrides.emberCount === undefined;
    const room = capActive ? Math.max(0, this.maxConcurrentEmbers - this.embers.length) : 2;
    if (room === 0) {
      return;
    }

    const width = this.field.getWidth();
    const rightHeading: Heading = { dx: 1, dy: 0 };
    const leftHeading: Heading = { dx: -1, dy: 0 };
    // Newly, naturally-spawned Embers pick up whatever moveTicks/branch-chase
    // override is currently active (docs/plan.md §6 M10), same as every
    // existing Ember — otherwise an Ember spawned mid-debug-session would
    // silently ignore the panel's settings until the next slider change.
    const moveTicks = this.debugOverrides.emberMoveTicks ?? this.baseEmberMoveTicks;
    const branchChaseProbability = this.debugOverrides.emberBranchChaseProbability ?? this.baseEmberBranchChaseProbability;
    this.embers.push(new Ember({ x: 0, y: 0 }, rightHeading, this.rng, moveTicks, branchChaseProbability));
    if (room >= 2) {
      this.embers.push(new Ember({ x: width - 1, y: 0 }, leftHeading, this.rng, moveTicks, branchChaseProbability));
    }
    this.events.push('ember-spawned');
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
        this.events.push('igniter-spawned');
      }
      return false;
    }

    const maxIndex = this.marker.getLine().length - 1;
    const indexBefore = this.igniter.getIndex();
    const caughtUp = this.igniter.update(!holdingDirection, maxIndex);
    // Each step the Igniter actually advances is treated as "getting closer"
    // (docs/plan.md §3.8 "ヒューズ...接近"): emitted once per line-cell it
    // climbs, not once per tick it merely sits still waiting to advance.
    if (this.igniter.getIndex() > indexBefore) {
      this.events.push('igniter-approaching');
    }
    return caughtUp;
  }

  private despawnIgniter(): void {
    this.igniter = null;
    this.stillTicks = 0;
    this.marker.setRetractEnabled(true);
  }

  /**
   * Removes any Ember whose current cell is no longer BORDER after the
   * claimArea() call just above pruned it into a claimed state (docs/plan.md
   * §6 M11 / §12.6). Left unhandled, such an Ember's `update()` finds zero
   * BORDER neighbors to step onto and holds position forever — visibly
   * frozen inside the newly-claimed area, which real playtesting flagged as
   * looking like a bug. Queues one 'ember-despawned' event (audio) and one
   * despawn position (the render layer's vanish effect) per Ember removed;
   * no special respawn handling is needed since the periodic
   * maybeSpawnEmbers() pair-spawn continues on its own schedule regardless.
   */
  private despawnTrappedEmbers(): void {
    this.embers = this.embers.filter((ember) => {
      if (this.field.get(ember.getPosition()) === BORDER) {
        return true;
      }
      this.despawnedEmberPositions.push(ember.getPosition());
      this.events.push('ember-despawned');
      return false;
    });
  }

  /**
   * Miss handling (docs/plan.md §3.5): the in-progress line vanishes, the
   * marker snaps back to where the line began, the Igniter (if any)
   * vanishes and retract is re-enabled, a life is lost, the score
   * multiplier resets to 1, and a grace period starts during which no
   * further miss can be triggered (so one sustained contact = one life).
   */
  private handleMiss(): void {
    this.events.push('miss');
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

/** Squared Euclidean distance between two grid points (avoids a sqrt call for pure comparisons). */
function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
