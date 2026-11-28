// Test support: a NORMAL run on the full-size field, with no debug override,
// that plays on to stage 6 and there raises the Wisp surge (core/wispSurge.ts)
// to level 1 and then to level 2, each on a claim that leaves play going on,
// then waits on the border until GAME OVER. Used by the tests that need the
// surge in a real run: the server check (functions/_lib/ranking), the rule
// baseline, captureFeedback's no-change check, and the replay view and
// Title demo tests.
//
// The input is a plan of straight lines (SURGE_RUN_LINES), each played the
// same way by playLine(): onto the top or the bottom edge (up the side or
// the last line first when the marker is on neither), along it to the
// line's column, `wait` idle ticks, then one fast line straight across to
// the opposite edge. A StageClear is confirmed on its own tick and not
// recorded, as the replay protocol re-supplies it. The marker's moves read
// the board only to know where it stands, and the run is fixed by its seed,
// so the recorded samples are the same on every run.
import { GameSession, SessionInput } from './session';
import type { InputSample } from './rle';
import type { GameEvent } from './events';
import { hashEvents, hashField, ScriptedRunSummary, StageSummary } from './scriptedRun';
import type { Axis } from './marker';

export interface SurgeRunLine {
  /** The column the line is drawn at. */
  x: number;
  /** Idle ticks on the border before the line starts. */
  wait: number;
}

/** A claim that raised the surge level: on which stage and tick, to which level, and the session's status at that tick's end. */
export interface SurgeRise {
  stage: number;
  tick: number;
  level: number;
  status: string;
}

export const SURGE_RUN_SEED = 30;

/**
 * Seed 30's plan. Lines 1 and 2 clear stages 1 and 2 on occupancy; lines 3
 * and 4 clear stages 3 and 4 by splitting the Wisps; line 5 claims on stage
 * 5 and line 6 clears it with a split. On stage 6 (goal 0.60), line 7 takes
 * occupancy past half of the goal (level 1, tick 1635) and line 8 within
 * 0.10 of it (level 2, tick 1908), neither reaching it. The marker then waits
 * on the border, where the Embers take its three lives (GAME OVER at tick
 * 3962), the Wisps moving at the surge's speed all the while.
 */
export const SURGE_RUN_LINES: readonly SurgeRunLine[] = [
  { x: 50, wait: 0 },
  { x: 32, wait: 20 },
  { x: 48, wait: 0 },
  { x: 68, wait: 0 },
  { x: 34, wait: 0 },
  { x: 110, wait: 80 },
  { x: 64, wait: 0 },
  { x: 138, wait: 80 },
];

const CONFIRM: SessionInput = { dx: 0, dy: 0, drawHeld: false, slow: false, confirm: true };

/** Plays SURGE_RUN_LINES on a fresh session, or replays recorded samples, and keeps what the tests compare. */
class SurgeRunPlayer {
  readonly session: GameSession;
  readonly samples: InputSample[] = [];
  readonly rises: SurgeRise[] = [];
  private readonly events: GameEvent[] = [];
  private readonly stages: StageSummary[] = [];
  private claims = 0;
  private misses = 0;
  private splits = 0;

  constructor(
    seed: number,
    captureFeedback: boolean,
    private readonly onTick?: (session: GameSession) => void
  ) {
    this.session = new GameSession({ seed, captureFeedback });
    this.session.update(CONFIRM);
  }

  /** One recorded tick; a StageClear it ends on is confirmed straight after, unrecorded. */
  input(sample: InputSample): void {
    this.samples.push(sample);
    const before = this.session.getGame().getWispSurgeLevel();
    this.session.update({ ...sample, confirm: false });
    this.onTick?.(this.session);
    const after = this.session.getGame().getWispSurgeLevel();
    if (after > before) {
      this.rises.push({ stage: this.session.getStage(), tick: this.session.getTotalTicks(), level: after, status: this.session.getStatus() });
    }
    for (const ev of this.session.drainEvents()) {
      this.events.push(ev);
      if (ev === 'area-claimed') this.claims++;
      if (ev === 'miss') this.misses++;
      if (ev === 'split-clear') this.splits++;
    }
    this.session.drainDespawnedEmberPositions();
    if (this.session.getStatus() === 'stageclear') {
      this.stages.push({
        stage: this.session.getStage(),
        score: this.session.getScore(),
        lives: this.session.getLives(),
        totalTicks: this.session.getTotalTicks(),
        fieldHash: hashField(this.session.getGame().getField()),
        split: this.session.getGame().getLastClearWasSplit(),
      });
      this.session.update(CONFIRM);
      this.session.drainEvents();
      this.session.drainDespawnedEmberPositions();
    }
  }

  private move(dx: Axis, dy: Axis, drawHeld: boolean): void {
    this.input({ dx, dy, drawHeld, slow: false });
  }

  private position() {
    return this.session.getGame().getMarker().getPosition();
  }

  /** Plays one line of the plan (see the file comment). Throws if the marker cannot get to its start. */
  playLine({ x, wait }: SurgeRunLine): void {
    const height = this.session.getGame().getField().getHeight();
    const stage = this.session.getStage();
    const lives = this.session.getLives();
    const going = () => this.session.getStatus() === 'playing' && this.session.getStage() === stage && this.session.getLives() === lives;
    for (let guard = 0; guard < 400 && going(); guard++) {
      const p = this.position();
      if (p.y === 0 || p.y === height - 1) break;
      this.move(0, -1, false);
      if (this.position().y === p.y) {
        this.move(0, 1, false);
        if (this.position().y === p.y) throw new Error(`stuck at ${JSON.stringify(p)}`);
      }
    }
    for (let guard = 0; guard < 400 && going(); guard++) {
      const p = this.position();
      if (p.x === x) break;
      this.move(p.x < x ? 1 : -1, 0, false);
      if (this.position().x === p.x) throw new Error(`cannot reach column ${x} from ${JSON.stringify(p)}`);
    }
    for (let i = 0; i < wait && going(); i++) this.move(0, 0, false);
    if (!going()) return;
    const dy: Axis = this.position().y === 0 ? 1 : -1;
    for (let guard = 0; guard < height + 5 && going(); guard++) {
      this.move(0, dy, true);
      if (!this.session.getGame().getMarker().isDrawing()) break;
    }
  }

  /** Idle on the border until GAME OVER. */
  finish(): void {
    for (let guard = 0; guard < 20_000 && this.session.getStatus() !== 'gameover'; guard++) this.move(0, 0, false);
  }

  summary(): ScriptedRunSummary {
    return {
      score: this.session.getScore(),
      stage: this.session.getStage(),
      lives: this.session.getLives(),
      claims: this.claims,
      misses: this.misses,
      splits: this.splits,
      totalTicks: this.session.getTotalTicks(),
      status: this.session.getStatus(),
      gameOverReason: this.session.getGameOverReason(),
      fieldHash: hashField(this.session.getGame().getField()),
      eventsHash: hashEvents(this.events),
      stages: [...this.stages],
    };
  }
}

export interface SurgeRunRecord {
  seed: number;
  /** Every recorded tick to GAME OVER (StageClear confirms not included). */
  samples: InputSample[];
  /** Every claim that raised the surge level, in order. */
  rises: SurgeRise[];
  summary: ScriptedRunSummary;
  /** The session the run was played on, at GAME OVER. */
  session: GameSession;
}

/** Plays a seed's plan of lines (SURGE_RUN_SEED's by default) and then waits until GAME OVER. */
export function playSurgeRun(
  options: { seed?: number; lines?: readonly SurgeRunLine[]; captureFeedback?: boolean; onTick?: (session: GameSession) => void } = {}
): SurgeRunRecord {
  const seed = options.seed ?? SURGE_RUN_SEED;
  const player = new SurgeRunPlayer(seed, options.captureFeedback ?? false, options.onTick);
  for (const line of options.lines ?? SURGE_RUN_LINES) player.playLine(line);
  player.finish();
  return { seed, samples: player.samples, rises: player.rises, summary: player.summary(), session: player.session };
}

/** Feeds recorded `samples` to a fresh session of `seed` (a StageClear confirmed on its own tick), and summarizes the run. */
export function replaySurgeRun(seed: number, samples: readonly InputSample[], captureFeedback: boolean): Omit<SurgeRunRecord, 'seed'> {
  const player = new SurgeRunPlayer(seed, captureFeedback);
  for (const sample of samples) player.input(sample);
  return { samples: player.samples, rises: player.rises, summary: player.summary(), session: player.session };
}

/**
 * The rises on stage 6 or later whose claim left play going on: the first
 * to level 1 and the first to level 2, or null for a level never reached so.
 */
export function lateSurgeRises(rises: readonly SurgeRise[]): { level1: SurgeRise | null; level2: SurgeRise | null } {
  const late = rises.filter((r) => r.stage >= 6 && r.status === 'playing');
  return { level1: late.find((r) => r.level === 1) ?? null, level2: late.find((r) => r.level === 2) ?? null };
}
