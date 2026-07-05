// Top-level game state machine (docs/plan.md §4.4 / §6 M4):
//   Title -> Playing -> (StageClear -> Playing) | (GameOver -> Title)
// Pure logic — no DOM/Canvas/localStorage dependencies. `GameSession`
// orchestrates stage-to-stage progression (docs/plan.md §3.7) by
// constructing a fresh per-stage `Game` for each stage (see core/stage.ts
// for the difficulty curve), carrying score/lives/multiplier/split-streak
// across stage boundaries, and tracking a high-score *value* only —
// persisting it to localStorage is main.ts's job (docs/plan.md's "core never
// touches localStorage" invariant; see src/storage/highscore.ts).
import { Field, Point } from './field';
import { Game, GameInput } from './game';
import { Wisp, Rng } from './enemy';
import { getStageConfig, StageConfig } from './stage';
import { INITIAL_LIVES, DEFAULT_SCORE_MULTIPLIER, SPLIT_MULTIPLIER_CAP, GRID_WIDTH, GRID_HEIGHT } from '../config';

export type SessionStatus = 'title' | 'playing' | 'stageclear' | 'gameover';

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
   * to the real per-stage builder (docs/plan.md §3.7's difficulty curve via
   * core/stage.ts + core/enemy.ts's Wisp). Lets tests drive the
   * Title/Playing/StageClear/GameOver state machine with a small,
   * deterministic `Game` instead of needing to choreograph real Wisp
   * movement/line-drawing through a full-size field.
   */
  gameFactory?: (stage: number, carry: { score: number; lives: number; multiplier: number }) => Game;
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
  private readonly rng?: Rng;
  private readonly fieldWidth: number;
  private readonly fieldHeight: number;
  private readonly gameFactory?: SessionOptions['gameFactory'];

  constructor(options: SessionOptions = {}) {
    this.rng = options.rng;
    this.fieldWidth = options.fieldWidth ?? GRID_WIDTH;
    this.fieldHeight = options.fieldHeight ?? GRID_HEIGHT;
    this.highScore = options.highScore ?? 0;
    this.gameFactory = options.gameFactory;
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
        this.updatePlaying(input);
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
    this.game = this.buildStageGame(this.stage, { score: 0, lives: INITIAL_LIVES, multiplier: this.multiplier });
  }

  private updatePlaying(input: SessionInput): void {
    const livesBefore = this.game.getLives();
    this.game.update(input);

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
    if (this.gameFactory) {
      return this.gameFactory(stage, carry);
    }

    const config = getStageConfig(stage);
    const field = new Field(this.fieldWidth, this.fieldHeight);
    const markerStart: Point = { x: Math.floor(field.getWidth() / 2), y: 0 };
    const wisps = this.buildWisps(field, config);

    return new Game(field, markerStart, undefined, this.rng, {
      wisps,
      emberSpawnIntervalTicks: config.emberSpawnIntervalTicks,
      requiredOccupancy: config.requiredOccupancy,
      // Score, lives, and multiplier carry across a stage-clear into the
      // next stage (docs/plan.md §6 M4); resetToFreshRun() passes fresh
      // starting values for a brand-new run's stage 1.
      score: carry.score,
      lives: carry.lives,
      multiplier: carry.multiplier,
    });
  }

  private buildWisps(field: Field, config: StageConfig): Wisp[] {
    const width = field.getWidth();
    const cx = Math.floor(width / 2);
    const cy = Math.floor(field.getHeight() / 2);
    const spacing = 3;

    const wisps: Wisp[] = [];
    for (let i = 0; i < config.wispCount; i++) {
      // Spread multiple Wisps symmetrically around the field's horizontal
      // center so a 2-Wisp stage (docs/plan.md §3.7 stage 3+) doesn't spawn
      // them on top of each other; clamped to stay within the interior even
      // on the small fields used by tests. For a single Wisp this reduces
      // to exactly the field-center spawn used since M2.
      const rawX = cx + (i - (config.wispCount - 1) / 2) * spacing;
      const x = Math.min(width - 2, Math.max(1, Math.round(rawX)));
      wisps.push(new Wisp({ x, y: cy }, this.rng, undefined, config.wispSpeedMultiplier));
    }
    return wisps;
  }
}
