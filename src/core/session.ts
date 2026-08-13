// Top-level game state machine (docs/plan.md §4.4 / §6 M4):
//   Title -> Playing -> (StageClear -> Playing) | (GameOver -> Title)
// Pure logic — no DOM/Canvas/localStorage dependencies. `GameSession`
// orchestrates stage-to-stage progression (docs/plan.md §12.7) by
// constructing a fresh per-stage `Game` for each stage (see core/stage.ts
// for the difficulty curve), carrying score/lives/multiplier/split-streak
// across stage boundaries, and tracking a high-score *value* only —
// persisting it to localStorage is main.ts's job (docs/plan.md's "core never
// touches localStorage" invariant; see src/storage/highscore.ts).
import { Field, Point } from './field';
import { Game, GameInput, DebugOverrides, EffectiveDebugParams } from './game';
import { Wisp, Rng } from './enemy';
import { getStageConfig, StageConfig } from './stage';
import { EventQueue, GameEvent } from './events';
import { mulberry32, deriveStageSeed } from './rng';
import {
  INITIAL_LIVES,
  DEFAULT_SCORE_MULTIPLIER,
  SPLIT_MULTIPLIER_CAP,
  GRID_WIDTH,
  GRID_HEIGHT,
  WISP_SPAWN_MARGIN_X_RATIO,
  WISP_SPAWN_MARGIN_Y_RATIO,
  WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN,
  TIME_LIMIT_TICKS,
} from '../config';

export type SessionStatus = 'title' | 'playing' | 'stageclear' | 'gameover';

/**
 * Why the current (or most recent) run ended in 'gameover'
 * (docs/plans/2026-08-13-time-limit-mode): 'life' when lives reached 0
 * (core/game.ts's own gameover), 'time' when GameSession's own run-wide
 * time budget (see `timeLimitTicks`/getRemainingTicks() below) hit 0 first —
 * the latter always wins regardless of lives remaining, even if a stage
 * clear or a life-loss gameover happened on that exact same tick (see
 * update()'s 'playing' case). `null` before any run has ever ended.
 */
export type GameOverReason = 'life' | 'time' | null;

export interface SessionInput extends GameInput {
  /**
   * Edge-triggered "confirm / any key" signal (docs/plan.md §4.4): advances
   * Title -> Playing, StageClear -> the next stage's Playing, and
   * GameOver -> Title. Ignored while `status === 'playing'`.
   *
   * Callers (e.g. input/keyboard.ts) MUST pass true only on the tick a
   * key/button transitions from up to down, not for every tick it's held —
   * otherwise holding a key down across a screen transition would fire the
   * *next* transition too (e.g. skipping straight through a StageClear
   * screen the instant it appears).
   */
  confirm: boolean;
}

export interface SessionOptions {
  /** Random source threaded into every stage's Wisps. Defaults to Math.random. */
  rng?: Rng;
  /**
   * Deterministic seed for a fully reproducible run (docs/plans/2026-08-11-
   * daily-seed-time-attack request task 2: `?seed=`). When set, every stage
   * builds its own rng from `deriveStageSeed(seed, stage)` (core/rng.ts)
   * rather than sharing one continuous stream — see that function's doc
   * comment for why (a stage's starting layout must not depend on how many
   * rng calls the *previous* stage's simulation happened to consume). Takes
   * priority over `rng` above when both are supplied — `rng` remains
   * available on its own for tests that want to inject an arbitrary
   * generator directly instead of going through a numeric seed.
   */
  seed?: number;
  /** Field size used for every stage (test hook). Defaults to config GRID_WIDTH/GRID_HEIGHT. */
  fieldWidth?: number;
  fieldHeight?: number;
  /**
   * Known high score to seed with — e.g. loaded from localStorage by
   * main.ts/src/storage/highscore.ts before constructing the session. Core
   * itself never reads storage. Defaults to 0.
   */
  highScore?: number;
  /**
   * Test hook: overrides how each stage's `Game` is built. Receives the
   * stage number and the score/lives/multiplier to carry into it (the same
   * values the default builder threads through via GameOptions). Defaults
   * to the real per-stage builder (docs/plan.md §12.7's difficulty curve via
   * core/stage.ts + core/enemy.ts's Wisp). Lets tests drive the
   * Title/Playing/StageClear/GameOver state machine with a small,
   * deterministic `Game` instead of needing to choreograph real Wisp
   * movement/line-drawing through a full-size field.
   */
  gameFactory?: (stage: number, carry: { score: number; lives: number; multiplier: number }) => Game;
  /**
   * Test hook (docs/plans/2026-08-13-time-limit-mode): overrides the run's
   * time budget, in ticks, in place of config.ts's TIME_LIMIT_TICKS —
   * lets unit tests exercise the time-up transition without waiting out
   * 18000 real ticks. The debug panel applies its own override the same way
   * production code would (see setDebugTimeLimitTicks() below), separately
   * from this constructor-time option.
   */
  timeLimitTicks?: number;
}

export class GameSession {
  private status: SessionStatus = 'title';
  private stage = 1;
  // The multiplier to seed the *next* stage's Game with (docs/plan.md
  // §3.6): kept here (rather than only read off the current Game) because a
  // split-clear bumps it to a value the just-finished stage's Game never
  // itself knows about. getMultiplier() always reflects the *current*
  // Game's own multiplier instead — see below.
  private multiplier: number = DEFAULT_SCORE_MULTIPLIER;
  // Consecutive split-stage-clears since the last miss (docs/plan.md §3.6):
  // the *next* stage's multiplier is this + 1, capped at SPLIT_MULTIPLIER_CAP.
  private splitSuccesses = 0;
  private highScore: number;
  private game!: Game; // assigned by resetToFreshRun() below, called from this constructor
  // Forwards every currently-playing stage's Game.drainEvents() up to
  // whoever drains *this* queue (docs/plan.md §3.8/§9.9: main.ts's audio
  // layer). Buffering here — rather than reading straight off `this.game`
  // — means events survive a stage transition even though `this.game` gets
  // replaced by advanceStage() before the caller has had a chance to drain.
  private eventQueue = new EventQueue<GameEvent>();
  // Forwards every currently-playing stage's Game.drainDespawnedEmberPositions()
  // up to whoever drains *this* queue (docs/plan.md §6 M11 / §12.6: main.ts's
  // render layer, for the Ember vanish effect) — mirrors `eventQueue` above
  // for exactly the same reason (surviving a stage transition even though
  // `this.game` gets replaced by advanceStage() before the caller has had a
  // chance to drain).
  private despawnedEmberPositions = new EventQueue<Point>();
  private readonly seed?: number;
  private readonly baseRng?: Rng;
  // The rng actually in effect for the stage currently being built — either
  // a fresh `mulberry32(deriveStageSeed(seed, stage))` (seeded runs) or
  // `baseRng` (the test-hook rng, unseeded runs). Recomputed by
  // buildStageGame() every time a stage's Game is (re)built; buildWisps()
  // and buildDefaultStageGame() read it from here rather than a single
  // session-lifetime rng field, since a seeded run's rng source is itself
  // per-stage (see `seed` above).
  private currentStageRng?: Rng;
  private readonly fieldWidth: number;
  private readonly fieldHeight: number;
  private readonly gameFactory?: SessionOptions['gameFactory'];
  // Tick counters (docs/plans/2026-08-11-daily-seed-time-attack request task
  // 2): both count only ticks spent with status === 'playing' (including
  // post-miss grace ticks — the stage is still 'playing' throughout grace,
  // see game.ts's handleMiss()); title/stageclear/gameover ticks never
  // advance either counter. `stageTicks` resets to 0 every time a stage's
  // Game is (re)built (buildStageGame(), called by both resetToFreshRun()
  // and advanceStage()) — freezing at its final value once the stage leaves
  // 'playing' (stageclear/gameover) makes it double as "how long that stage
  // took", read by main.ts for the StageClear TIME/BEST display.
  // `totalTicks` only resets on a brand-new run (resetToFreshRun()).
  private stageTicks = 0;
  private totalTicks = 0;
  // Debug-panel overrides (docs/plan.md §6 M10 / §12.4), kept here — not just
  // on `this.game` — so they survive advanceStage() replacing `this.game`
  // with a fresh per-stage instance ("オーバーライドはステージをまたいで
  // 維持"): buildStageGame() re-applies this to every newly-built Game.
  private debugOverrides: DebugOverrides = {};
  // The run's time budget, in ticks (docs/plans/2026-08-13-time-limit-mode).
  // `baseTimeLimitTicks` is fixed for the session's lifetime (constructor
  // option or config.ts's TIME_LIMIT_TICKS default); `debugTimeLimitTicks`
  // — undefined unless the debug panel has touched it — takes priority over
  // it when set, mirroring `debugOverrides` above but kept as its own field
  // since a time budget isn't one of Game's own EffectiveDebugParams (it's a
  // session-level concept, not a per-stage Game one). See getTimeLimitTicks()
  // / setDebugTimeLimitTicks() / resetDebugOverrides().
  private readonly baseTimeLimitTicks: number;
  private debugTimeLimitTicks: number | undefined;
  // Set the instant a run ends (docs/plans/2026-08-13-time-limit-mode) —
  // see the GameOverReason type doc comment above for the two causes and
  // their precedence. Reset to null by resetToFreshRun().
  private gameOverReason: GameOverReason = null;

  constructor(options: SessionOptions = {}) {
    this.seed = options.seed;
    this.baseRng = options.rng;
    this.fieldWidth = options.fieldWidth ?? GRID_WIDTH;
    this.fieldHeight = options.fieldHeight ?? GRID_HEIGHT;
    this.highScore = options.highScore ?? 0;
    this.gameFactory = options.gameFactory;
    this.baseTimeLimitTicks = options.timeLimitTicks ?? TIME_LIMIT_TICKS;
    this.resetToFreshRun();
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  getStage(): number {
    return this.stage;
  }

  /** Always the *current* stage's `Game.getLives()` — there is no separate session-level copy to drift out of sync. */
  getLives(): number {
    return this.game.getLives();
  }

  /** Always the *current* stage's `Game.getScore()` (carried cumulatively across stages via GameOptions). */
  getScore(): number {
    return this.game.getScore();
  }

  /**
   * The active score multiplier. While 'playing', this mirrors the current
   * stage's `Game.getMultiplier()`. The instant a split-clear happens, it
   * jumps ahead to the *next* stage's bumped value (docs/plan.md §3.6)
   * immediately — i.e. it's already showing "2x" on the StageClear screen
   * itself, not just once the next stage actually starts.
   */
  getMultiplier(): number {
    return this.multiplier;
  }

  /** The best of the seeded high score and the current run's score. */
  getHighScore(): number {
    return Math.max(this.highScore, this.game.getScore());
  }

  /**
   * Ticks elapsed since the current stage started (docs/plans/2026-08-11-
   * daily-seed-time-attack request task 2), counting only while
   * `status === 'playing'`. Resets to 0 on every stage transition (fresh run
   * or advanceStage()) and freezes at its final value once the stage leaves
   * 'playing'. No longer surfaced in the UI as of docs/plans/2026-08-13-
   * time-limit-mode (the StageClear screen's TIME/BEST display was removed
   * along with `qixxx.bestTimes`) — kept for tests/future use. Format as
   * `ticks / TICK_RATE` seconds (60 tick = 1s) — no wall-clock time involved.
   */
  getStageTicks(): number {
    return this.stageTicks;
  }

  /**
   * Ticks elapsed since the current run started (docs/plans/2026-08-11-
   * daily-seed-time-attack request task 2), counting only while
   * `status === 'playing'`, summed across every stage of the run. Resets to
   * 0 only on a brand-new run (resetToFreshRun()), not on a per-stage
   * advance.
   */
  getTotalTicks(): number {
    return this.totalTicks;
  }

  /**
   * The run's current time budget, in ticks (docs/plans/2026-08-13-time-
   * limit-mode): the debug panel's override (setDebugTimeLimitTicks()) when
   * one is active, else the constructor's `timeLimitTicks` option/config.ts's
   * TIME_LIMIT_TICKS default. Exposed mainly for the debug panel's own
   * slider readout — most callers want getRemainingTicks() instead.
   */
  getTimeLimitTicks(): number {
    return this.debugTimeLimitTicks ?? this.baseTimeLimitTicks;
  }

  /**
   * Ticks left before the run's time budget expires (docs/plans/2026-08-13-
   * time-limit-mode), counting down from getTimeLimitTicks() as
   * getTotalTicks() advances — so, like getTotalTicks(), only while
   * `status === 'playing'`; frozen otherwise. Clamped at 0 (never negative).
   * Reaching 0 forces a 'gameover' regardless of lives remaining — see
   * update()'s 'playing' case.
   */
  getRemainingTicks(): number {
    return Math.max(0, this.getTimeLimitTicks() - this.totalTicks);
  }

  /**
   * Why the run most recently ended in 'gameover' (docs/plans/2026-08-13-
   * time-limit-mode) — 'life' (lives reached 0), 'time' (the run's time
   * budget reached 0 first, regardless of lives), or `null` before any run
   * has ended. Lets callers (main.ts's GameOverModal) show a distinct
   * "TIME UP!" message instead of the ordinary life-loss GAME OVER.
   */
  getGameOverReason(): GameOverReason {
    return this.gameOverReason;
  }

  /**
   * Debug-panel-only override (docs/plan.md §6 M10 / §12.4 pattern,
   * docs/plans/2026-08-13-time-limit-mode's own tuning item) for the run's
   * time budget, in ticks — takes priority over the constructor's
   * `timeLimitTicks` option/config.ts's TIME_LIMIT_TICKS default until
   * resetDebugOverrides() clears it. Like every other debug override, an
   * active one here also makes hasActiveDebugOverrides() true, so main.ts
   * skips high-score persistence while it's in effect — see that method's
   * doc comment.
   */
  setDebugTimeLimitTicks(ticks: number): void {
    this.debugTimeLimitTicks = ticks;
  }

  /**
   * The current stage's `Game` instance — exposed so the render layer can
   * keep drawing the field/marker/enemies while a StageClear/GameOver
   * overlay is shown (the last-played stage's board stays on screen behind
   * it), and while Title is up (a freshly-built, not-yet-started stage 1).
   */
  getGame(): Game {
    return this.game;
  }

  /**
   * Advances the session by one fixed tick. Behavior depends on `status`:
   * - 'title': `confirm` starts playing the (already fresh) stage-1 game —
   *   see the constructor and `resetToFreshRun()` for where "fresh" comes
   *   from.
   * - 'playing': delegates to the current stage's `Game.update`, then
   *   reacts to a miss (reset the split streak) or a stage end (gameover ->
   *   stop; stageclear -> apply the split-multiplier bump, if any).
   * - 'stageclear': `confirm` advances to the next stage.
   * - 'gameover': `confirm` fully resets the run (docs/plan.md §6 M4: "ゲー
   *   ム全体のリセットが正しく行われること") and returns to Title.
   */
  update(input: SessionInput): void {
    switch (this.status) {
      case 'title':
        if (input.confirm) {
          this.status = 'playing';
        }
        break;
      case 'playing':
        // Tick counters (see the field comments above) only ever advance
        // here — the one branch where status was already 'playing' at the
        // start of this tick, including the tick that itself ends the stage
        // (a stage/split clear or the final miss into gameover), so that
        // tick's own gameplay still counts toward its time.
        this.stageTicks++;
        this.totalTicks++;
        this.updatePlaying(input);
        // Time-up (docs/plans/2026-08-13-time-limit-mode): checked *after*
        // updatePlaying() so it can override whatever that call just decided
        // — including a life-loss gameover or even a stage clear landing on
        // this exact same tick — the instant the run's time budget hits 0,
        // "残機・状態に関係なく" (regardless of lives/other state) per that
        // request's completion criteria. 'time' always wins over 'life' on a
        // tick where both would otherwise apply.
        if (this.getRemainingTicks() <= 0) {
          this.status = 'gameover';
          this.gameOverReason = 'time';
          this.highScore = this.getHighScore();
        }
        break;
      case 'stageclear':
        if (input.confirm) {
          this.advanceStage();
        }
        break;
      case 'gameover':
        if (input.confirm) {
          this.resetToFreshRun();
          this.status = 'title';
        }
        break;
    }
  }

  /**
   * Resets every piece of run state (stage, lives, score, multiplier, split
   * streak) and rebuilds a fresh stage-1 `Game` — used both at construction
   * (so Title has something valid to preview/render) and on GameOver ->
   * Title (docs/plan.md §6 M4's "full reset" requirement).
   */
  private resetToFreshRun(): void {
    this.stage = 1;
    this.multiplier = DEFAULT_SCORE_MULTIPLIER;
    this.splitSuccesses = 0;
    this.totalTicks = 0;
    this.gameOverReason = null;
    this.game = this.buildStageGame(this.stage, { score: 0, lives: INITIAL_LIVES, multiplier: this.multiplier });
  }

  /**
   * Drains (returns and clears) every GameEvent queued by the currently- and
   * previously-playing stages since the last call (docs/plan.md §3.8/§9.9).
   * Intended to be called once per rendered frame by main.ts, which forwards
   * the result to the audio layer.
   */
  drainEvents(): GameEvent[] {
    return this.eventQueue.drain();
  }

  /**
   * Drains (returns and clears) every Ember despawn position queued by the
   * currently- and previously-playing stages since the last call
   * (docs/plan.md §6 M11 / §12.6). Intended to be called once per tick by
   * main.ts, alongside drainEvents() — the render layer uses the result to
   * spawn a short vanish effect at each position.
   */
  drainDespawnedEmberPositions(): Point[] {
    return this.despawnedEmberPositions.drain();
  }

  /**
   * Applies dev-only debug-panel overrides (docs/plan.md §6 M10 / §12.4) to
   * the current stage's Game, and remembers them so every subsequent stage
   * (via advanceStage() -> buildStageGame()) starts with the same overrides
   * already applied ("オーバーライドはステージをまたいで維持").
   */
  applyDebugOverrides(overrides: Partial<DebugOverrides>): void {
    this.debugOverrides = { ...this.debugOverrides, ...overrides };
    this.game.applyDebugOverrides(this.debugOverrides);
  }

  /**
   * Drops every active debug override, in the current stage and every
   * future one, restoring stage defaults — including the time-limit
   * override set via setDebugTimeLimitTicks() (docs/plans/2026-08-13-time-
   * limit-mode), so a single RESET button clears every debug-tunable
   * dimension at once.
   */
  resetDebugOverrides(): void {
    this.debugOverrides = {};
    this.debugTimeLimitTicks = undefined;
    this.game.resetDebugOverrides();
  }

  /** The debug overrides currently active (only the fields the panel has touched). */
  getDebugOverrides(): DebugOverrides {
    return { ...this.debugOverrides };
  }

  /**
   * True while at least one debug override is active — gates high-score
   * persistence (docs/plan.md §6 M10: main.ts skips `saveHighScore` while
   * this is true, so a debug-tuned run never taints the stored high score).
   * Also true while a debug time-limit override is active (docs/plans/
   * 2026-08-13-time-limit-mode's setDebugTimeLimitTicks()) — a run played
   * under a tuned time budget is exactly as untrustworthy for a stored
   * record as one played under any other tuned parameter.
   */
  hasActiveDebugOverrides(): boolean {
    return this.game.hasActiveDebugOverrides() || this.debugTimeLimitTicks !== undefined;
  }

  /** The actually-in-effect value of every debug-tunable parameter right now (docs/plan.md §6 M10). */
  getEffectiveDebugParams(): EffectiveDebugParams {
    return this.game.getEffectiveDebugParams();
  }

  private updatePlaying(input: SessionInput): void {
    const livesBefore = this.game.getLives();
    this.game.update(input);
    for (const event of this.game.drainEvents()) {
      this.eventQueue.push(event);
    }
    for (const pos of this.game.drainDespawnedEmberPositions()) {
      this.despawnedEmberPositions.push(pos);
    }

    // Mirror the stage's own multiplier (it only ever moves to
    // DEFAULT_SCORE_MULTIPLIER, via Game.handleMiss on a miss — docs/plan.md
    // §3.6). The split-clear branch below may immediately overwrite this
    // with the *next* stage's bumped value.
    this.multiplier = this.game.getMultiplier();

    if (this.game.getLives() < livesBefore) {
      // A miss occurred this tick — the split streak resets alongside the
      // multiplier (docs/plan.md §3.6: "1度でもミスすると倍率は1倍に戻る").
      this.splitSuccesses = 0;
    }

    const stageStatus = this.game.getStatus();
    if (stageStatus === 'gameover') {
      this.status = 'gameover';
      this.gameOverReason = 'life';
      this.highScore = this.getHighScore();
    } else if (stageStatus === 'stageclear') {
      if (this.game.getLastClearWasSplit()) {
        this.splitSuccesses = Math.min(this.splitSuccesses + 1, SPLIT_MULTIPLIER_CAP - 1);
        this.multiplier = this.splitSuccesses + 1;
      }
      this.status = 'stageclear';
      this.highScore = this.getHighScore();
    }
  }

  private advanceStage(): void {
    this.stage += 1;
    this.game = this.buildStageGame(this.stage, {
      score: this.game.getScore(),
      lives: this.game.getLives(),
      multiplier: this.multiplier,
    });
    this.status = 'playing';
  }

  private buildStageGame(stage: number, carry: { score: number; lives: number; multiplier: number }): Game {
    this.stageTicks = 0;
    // Seeded runs get a fresh per-stage rng derived from (seed, stage) —
    // never a stream shared/continued across stages — see `seed`'s field
    // comment and core/rng.ts's deriveStageSeed() doc comment for why.
    // Unseeded runs keep using whatever `baseRng` test hook was injected
    // (or undefined, i.e. Math.random downstream) for every stage, exactly
    // as before this feature existed.
    this.currentStageRng = this.seed !== undefined ? mulberry32(deriveStageSeed(this.seed, stage)) : this.baseRng;
    const game = this.gameFactory ? this.gameFactory(stage, carry) : this.buildDefaultStageGame(stage, carry);

    // Debug overrides persist across stages (docs/plan.md §6 M10): a fresh
    // Game (whether from the real per-stage builder or a test's gameFactory)
    // immediately picks up whatever overrides the panel has already set.
    if (Object.keys(this.debugOverrides).length > 0) {
      game.applyDebugOverrides(this.debugOverrides);
    }
    return game;
  }

  private buildDefaultStageGame(stage: number, carry: { score: number; lives: number; multiplier: number }): Game {
    const config = getStageConfig(stage);
    const field = new Field(this.fieldWidth, this.fieldHeight);
    const markerStart: Point = { x: Math.floor(field.getWidth() / 2), y: 0 };
    const wisps = this.buildWisps(field, config);

    return new Game(field, markerStart, undefined, this.currentStageRng, {
      wisps,
      emberSpawnIntervalTicks: config.emberSpawnIntervalTicks,
      emberMoveTicks: config.emberMoveTicks,
      emberBranchChaseProbability: config.emberBranchChaseProbability,
      maxConcurrentEmbers: config.maxConcurrentEmbers,
      requiredOccupancy: config.requiredOccupancy,
      // Score, lives, and multiplier carry across a stage-clear into the
      // next stage (docs/plan.md §6 M4); resetToFreshRun() passes fresh
      // starting values for a brand-new run's stage 1.
      score: carry.score,
      lives: carry.lives,
      multiplier: carry.multiplier,
    });
  }

  /**
   * Builds this stage's Wisp cluster, spawned around a randomized center
   * instead of the field's fixed center (docs/plan.md's anti-exploit fix,
   * see config.ts's WISP_SPAWN_* constants for the full rationale): with the
   * old fixed-center spawn, a single straight line down the marker's own
   * start column reliably split the whole formation and instant-cleared
   * stages 2-6 with little risk. The randomized center is pushed away from
   * the marker's start column by at least WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN
   * cells (best effort on fields too small to fit the full offset) so that
   * exploit no longer works reliably.
   */
  private buildWisps(field: Field, config: StageConfig): Wisp[] {
    const width = field.getWidth();
    const height = field.getHeight();
    const rng = this.currentStageRng ?? Math.random;
    const spacing = 3;

    // Marker always starts at { x: floor(width/2), y: 0 } — see
    // buildDefaultStageGame() above.
    const markerColumn = Math.floor(width / 2);

    // Draw the cluster center from the field's interior, kept off the
    // walls by WISP_SPAWN_MARGIN_X_RATIO/_Y_RATIO on every side.
    const marginX = width * WISP_SPAWN_MARGIN_X_RATIO;
    const marginY = height * WISP_SPAWN_MARGIN_Y_RATIO;
    let cx = Math.round(marginX + rng() * (width - 2 * marginX));
    let cy = Math.round(marginY + rng() * (height - 2 * marginY));

    // The actual anti-exploit guarantee: push the center away from the
    // marker's start column if it landed too close. On a field too narrow
    // for the full offset to fit inside the interior, this is necessarily
    // best-effort — the clamp below still keeps every spawned Wisp safely
    // inside the field regardless.
    if (Math.abs(cx - markerColumn) < WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN) {
      cx =
        cx >= markerColumn
          ? markerColumn + WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN
          : markerColumn - WISP_SPAWN_MIN_OFFSET_FROM_MARKER_COLUMN;
    }

    // Safety clamp for small fields (e.g. tests): keeps the center itself
    // inside the interior even after the push above may have moved it past
    // a margin bound, or past the field edge entirely on a narrow field.
    cx = Math.min(width - 2, Math.max(1, cx));
    cy = Math.min(height - 2, Math.max(1, cy));

    const wisps: Wisp[] = [];
    for (let i = 0; i < config.wispCount; i++) {
      // Spread multiple Wisps symmetrically around the cluster center so a
      // multi-Wisp stage (docs/plan.md §12.7, stage 2+) doesn't spawn them
      // on top of each other; clamped to stay within the interior even on
      // the small fields used by tests.
      const rawX = cx + (i - (config.wispCount - 1) / 2) * spacing;
      const x = Math.min(width - 2, Math.max(1, Math.round(rawX)));
      wisps.push(new Wisp({ x, y: cy }, this.currentStageRng, undefined, config.wispSpeedMultiplier));
    }
    return wisps;
  }
}
