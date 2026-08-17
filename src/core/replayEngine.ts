// Deterministic (seed + input list) resimulation (docs/plans/2026-08-16-
// score-ranking task 2). Pure logic — no DOM/localStorage/fetch dependency.
//
// Two entry points, matching the request's "ヘッドレス(検証・スコア導出
// 用)と描画付き(視聴用)の両モード":
//   - `simulateReplayFromRle()`: headless, security-sensitive path. Walks
//     core/rle.ts's decodeRleRuns() generator directly (one run at a time,
//     "検証しながら展開" — never materializes the full expanded sample
//     array) and drives a GameSession tick-by-tick. Used both by this
//     module's own ReplayEngine (for its one-time pre-pass, see below) and
//     directly by functions/_lib/verifyReplay.ts (server-side POST
//     verification, where an attacker-controlled RLE blob must never be
//     fully expanded before it's validated).
//   - `ReplayEngine`: viewing path. Decodes the *whole* replay once (a
//     already-fetched, presumed-valid replay — a materialized ~10800-sample
//     array is a non-issue client-side) and exposes stepTick() for a
//     per-rendered-frame driver (src/main.ts's replay controller, task 4),
//     plus skipToFinalStage() built on the pre-pass's stage boundaries.
//
// Both follow the same fixed protocol for turning a recorded sample list
// back into ticks (task 2's confirmed spec): auto-confirm Title into
// Playing before tick 1, auto-confirm every StageClear, then feed the next
// recorded sample as a separate tick.
import { GameSession, SessionInput, SessionOptions, GameOverReason } from './session';
import { GameEvent } from './events';
import { InputSample, decodeRleRuns, decodeRleToSamples } from './rle';
import { MAX_INPUT_SAMPLES } from '../config';

const CONFIRM: SessionInput = { dx: 0, dy: 0, drawHeld: false, confirm: true };

export interface ReplayStageBoundary {
  stage: number;
  /** GameSession.getTotalTicks() value the instant this stage started (0 for stage 1). */
  startTick: number;
}

export interface ReplayResult {
  score: number;
  stage: number;
  durationTicks: number;
  gameOverReason: GameOverReason;
  totalClaims: number;
  /** True iff the session actually reached 'gameover' by the time input ran out (as opposed to input running out mid-'playing', or a caller-requested early stop). */
  reachedGameOver: boolean;
  /**
   * How many recorded samples remained *after* the tick that reached
   * 'gameover' (0 for a well-formed replay — task 3's confirmed spec: "最後
   * の入力サンプルで必ずgameoverに到達している...到達後の余剰入力は拒否
   * する"). Still validated/counted via decodeRleRuns()'s own format checks
   * even though they're never actually simulated once gameover has been
   * reached. Always 0 if `reachedGameOver` is false (nothing to count past
   * a gameover that never happened) or if a caller-supplied `onTick` cut the
   * simulation short first (that's a different rejection reason entirely).
   */
  excessSamplesAfterGameover: number;
  stageBoundaries: ReplayStageBoundary[];
}

export interface ReplaySimOptions {
  seed: number;
  maxTicks?: number;
  fieldWidth?: number;
  fieldHeight?: number;
  /** Test hook (mirrors SessionOptions.timeLimitTicks) — never set by production call sites, which always use the real TIME_LIMIT_TICKS default. */
  timeLimitTicks?: number;
  /**
   * Bench/test-only state injection (docs/plans/2026-08-16-score-ranking
   * task 1's isolation requirement — never constructed by production code
   * outside this optional pass-through). Left undefined by every real
   * (production) call site.
   */
  gameFactory?: SessionOptions['gameFactory'];
  /**
   * Called once per consumed tick, after that tick's events have been
   * drained. Returning `true` stops the simulation immediately (before any
   * further ticks are consumed) — used by verifyReplay.ts to enforce
   * MAX_VERIFIED_CLAIMS without simulating the rest of a rejected replay.
   */
  onTick?: (info: { totalClaimsSoFar: number; events: GameEvent[]; session: GameSession }) => boolean | void;
}

/**
 * Headless resimulation directly off RLE bytes (see this module's doc
 * comment for why this is the security-sensitive entry point). Drains
 * GameSession's internal event queues every tick (docs/plans/2026-08-16-
 * score-ranking's "ヘッドレス実行時は...毎tick drainすること" requirement)
 * to avoid unbounded memory growth across a full 10800-tick run.
 */
export function simulateReplayFromRle(seed: number, rle: Uint8Array, options: Omit<ReplaySimOptions, 'seed'> = {}): ReplayResult {
  // chunkTicks: Infinity — the generator never yields, so this is a single
  // next() call and behaves exactly like a plain loop. The server path pays
  // nothing for the chunking machinery the viewer needs.
  const steps = replaySimulationSteps(seed, rle, options, Number.POSITIVE_INFINITY);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Ticks simulated between yields when chunking. Small enough that one chunk is a few ms even on a slow phone, large enough that a full 10800-tick replay is ~40 yields rather than thousands. */
export const REPLAY_CHUNK_TICKS = 256;

export interface ChunkedSimOptions extends Omit<ReplaySimOptions, 'seed'> {
  /** Ticks per chunk before yielding to the event loop. Defaults to REPLAY_CHUNK_TICKS. */
  chunkTicks?: number;
  /** How to yield between chunks. Defaults to a macrotask (`setTimeout(0)`); injectable so tests can run without real timers. */
  yieldToEventLoop?: () => Promise<void>;
  /** Called after each chunk with the number of ticks simulated so far — for a progress/LOADING display. */
  onProgress?: (ticksSimulated: number) => void;
  /**
   * Aborts the simulation at the next chunk boundary.
   *
   * Chunking alone only keeps the page *responsive*; the work still runs to
   * completion. A viewer who closes the list or starts a run has no further
   * use for the result, and on a phone letting up to 10800 ticks grind on in
   * the background is exactly the cost the chunking was meant to avoid — it
   * lands on the freshly-started live game instead of on the loading screen.
   */
  signal?: AbortSignal;
}

/** Thrown by the chunked drivers when their AbortSignal fires. Callers treat it as "the user moved on", not as an error to report. */
export class ReplayAbortedError extends Error {
  constructor() {
    super('replay: simulation aborted');
    this.name = 'ReplayAbortedError';
  }
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Same simulation as simulateReplayFromRle(), but handing control back to the
 * event loop every `chunkTicks` ticks.
 *
 * Exists for the *viewing* path only. A replay is up to 10800 ticks, and
 * running that as one synchronous loop blocks the main thread for as long as
 * it takes — on a phone, seconds of a frozen page with no way to show so much
 * as a spinner. The server path must stay synchronous (a Worker has no
 * reason to yield, and verifyReplay() is a pure function), hence two drivers
 * over one generator rather than making everything async.
 */
export async function simulateReplayFromRleChunked(
  seed: number,
  rle: Uint8Array,
  options: ChunkedSimOptions = {}
): Promise<ReplayResult> {
  const { chunkTicks = REPLAY_CHUNK_TICKS, yieldToEventLoop = defaultYield, onProgress, signal, ...simOptions } = options;
  if (signal?.aborted) throw new ReplayAbortedError();
  const steps = replaySimulationSteps(seed, rle, simOptions, chunkTicks);
  let step = steps.next();
  while (!step.done) {
    onProgress?.(step.value);
    await yieldToEventLoop();
    if (signal?.aborted) {
      // Closes the generator (running its `finally` blocks) so the abandoned
      // GameSession becomes collectable immediately.
      steps.return(undefined as never);
      throw new ReplayAbortedError();
    }
    step = steps.next();
  }
  return step.value;
}

/**
 * The single implementation behind both drivers above. Yields the running
 * tick count every `chunkTicks` simulated ticks and returns the final
 * ReplayResult; pass `Infinity` to make it a plain uninterrupted loop.
 */
function* replaySimulationSteps(
  seed: number,
  rle: Uint8Array,
  options: Omit<ReplaySimOptions, 'seed'>,
  chunkTicks: number
): Generator<number, ReplayResult, void> {
  const maxTicks = options.maxTicks ?? MAX_INPUT_SAMPLES;
  const session = new GameSession({
    seed,
    fieldWidth: options.fieldWidth,
    fieldHeight: options.fieldHeight,
    timeLimitTicks: options.timeLimitTicks,
    gameFactory: options.gameFactory,
  });
  session.update(CONFIRM); // Title -> Playing

  let totalClaims = 0;
  let excessSamplesAfterGameover = 0;
  let stoppedByOnTick = false;
  let ticksSimulated = 0;
  let ticksSinceYield = 0;
  const stageBoundaries: ReplayStageBoundary[] = [{ stage: 1, startTick: 0 }];

  outer: for (const { sample, runLength } of decodeRleRuns(rle, maxTicks)) {
    for (let i = 0; i < runLength; i++) {
      if (session.getStatus() === 'gameover') {
        // Still walking (and thus still validating) the rest of the RLE
        // stream — see ReplayResult.excessSamplesAfterGameover's doc
        // comment — just no longer simulating anything past this point.
        excessSamplesAfterGameover++;
        continue;
      }
      let guard = 0;
      while (session.getStatus() !== 'playing') {
        // Only 'stageclear' can reach here: 'title' was already left before
        // this loop started, and 'gameover' is handled by the branch above.
        const prevStage = session.getStage();
        session.update(CONFIRM);
        if (session.getStage() !== prevStage) {
          stageBoundaries.push({ stage: session.getStage(), startTick: session.getTotalTicks() });
        }
        guard++;
        if (guard > 10) throw new Error('replay: stuck advancing through a non-playing state');
      }
      const input: SessionInput = { dx: sample.dx, dy: sample.dy, drawHeld: sample.drawHeld, slow: sample.slow, confirm: false };
      session.update(input);
      const events = session.drainEvents();
      for (const ev of events) if (ev === 'area-claimed') totalClaims++;
      session.drainDespawnedEmberPositions();
      // A caller-requested early stop (verifyReplay.ts's MAX_VERIFIED_CLAIMS
      // check) is a genuine `break outer` — unlike the gameover case above,
      // this deliberately abandons the rest of the RLE stream unread/
      // unvalidated, since the entire point is avoiding the cost of
      // processing a replay already known to be invalid.
      if (options.onTick?.({ totalClaimsSoFar: totalClaims, events, session })) {
        stoppedByOnTick = true;
        break outer;
      }

      ticksSimulated++;
      if (++ticksSinceYield >= chunkTicks) {
        ticksSinceYield = 0;
        yield ticksSimulated;
      }
    }
  }

  return {
    score: session.getScore(),
    stage: session.getStage(),
    durationTicks: session.getTotalTicks(),
    gameOverReason: session.getGameOverReason(),
    totalClaims,
    reachedGameOver: !stoppedByOnTick && session.getStatus() === 'gameover',
    excessSamplesAfterGameover: stoppedByOnTick ? 0 : excessSamplesAfterGameover,
    stageBoundaries,
  };
}

export interface ReplayEngineOptions {
  fieldWidth?: number;
  fieldHeight?: number;
  /** Test hook (mirrors SessionOptions.timeLimitTicks) — never set by production call sites. */
  timeLimitTicks?: number;
}

/**
 * Viewing-mode driver (see this module's doc comment). Runs a one-time
 * headless pre-pass at construction to discover the replay's final
 * score/stage/duration and stage-boundary ticks, then exposes stepTick()
 * for a fresh, second GameSession driven one tick per call (e.g. once per
 * rendered frame) — the same call sequence a live player's session
 * receives, so the exact same renderer code (src/main.ts) can draw it.
 */
export class ReplayEngine {
  private readonly seed: number;
  private readonly samples: readonly InputSample[];
  private readonly session: GameSession;
  private index = 0;
  private readonly preResult: ReplayResult;

  private constructor(seed: number, samples: readonly InputSample[], preResult: ReplayResult, options: ReplayEngineOptions) {
    this.seed = seed;
    this.samples = samples;
    this.preResult = preResult;
    this.session = new GameSession({
      seed,
      fieldWidth: options.fieldWidth,
      fieldHeight: options.fieldHeight,
      timeLimitTicks: options.timeLimitTicks,
    });
    this.session.update(CONFIRM); // Title -> Playing, mirroring simulateReplayFromRle()'s own first step
  }

  /**
   * Builds an engine, running the one-time pre-pass in chunks so the page
   * stays responsive.
   *
   * Async (rather than a plain constructor) because that pre-pass resimulates
   * the entire replay — up to 10800 ticks — to discover its final
   * score/stage/duration and stage boundaries. Doing that synchronously froze
   * the main thread for the whole duration, which on a phone is seconds of a
   * dead page that can't even paint a spinner. `onProgress` lets the caller
   * show one instead (src/ui/ranking.ts's LOADING state).
   */
  static async create(seed: number, rle: Uint8Array, options: ReplayEngineOptions & ChunkedSimOptions = {}): Promise<ReplayEngine> {
    const samples = decodeRleToSamples(rle);
    // Throws ReplayAbortedError if options.signal fires — the caller is
    // expected to treat that as "the viewer moved on", not as a failure.
    const preResult = await simulateReplayFromRleChunked(seed, rle, options);
    return new ReplayEngine(seed, samples, preResult, options);
  }

  /** The GameSession this engine is driving — pass straight to the existing renderer. */
  getSession(): GameSession {
    return this.session;
  }

  /** The pre-pass result (final score/stage/duration/stage boundaries) — available immediately, before any stepTick() call. */
  getResult(): ReplayResult {
    return this.preResult;
  }

  /** True once every recorded sample has been consumed by stepTick(). */
  isFinished(): boolean {
    return this.index >= this.samples.length || this.session.getStatus() === 'gameover';
  }

  /**
   * Advances the live session by exactly one recorded tick (auto-confirming
   * through Title/StageClear first, per this module's fixed protocol).
   * Returns false (without doing anything) once isFinished() is already
   * true. Caller (src/main.ts's replay controller) is responsible for
   * draining/forwarding events for rendering, same as a live run.
   */
  stepTick(): boolean {
    if (this.isFinished()) return false;
    let guard = 0;
    while (this.session.getStatus() !== 'playing') {
      if (this.session.getStatus() === 'gameover') return false;
      this.session.update(CONFIRM);
      guard++;
      if (guard > 10) throw new Error('replay: stuck advancing through a non-playing state');
    }
    const s = this.samples[this.index++];
    this.session.update({ dx: s.dx, dy: s.dy, drawHeld: s.drawHeld, slow: s.slow, confirm: false });
    return true;
  }

  /**
   * Fast-forwards (headless — draining event queues rather than rendering
   * them) to the tick the *final* stage reached in this replay begins at.
   * No-op if already at or past that tick. Intended for a "SKIP TO FINAL
   * STAGE" viewer control (task 4) — after this returns, the caller should
   * resume normal per-frame stepTick() calls to keep playing from there.
   */
  async skipToFinalStage(options: Pick<ChunkedSimOptions, 'chunkTicks' | 'yieldToEventLoop' | 'onProgress' | 'signal'> = {}): Promise<void> {
    const { chunkTicks = REPLAY_CHUNK_TICKS, yieldToEventLoop = defaultYield, onProgress, signal } = options;
    const boundaries = this.preResult.stageBoundaries;
    const finalBoundary = boundaries[boundaries.length - 1];
    const targetTick = finalBoundary?.startTick ?? 0;
    const targetStage = finalBoundary?.stage ?? 1;
    let sinceYield = 0;
    // Chunked for the same reason create() is (see its doc comment): skipping
    // to the final stage of a long replay can be most of a 10800-tick
    // resimulation, and doing it in one synchronous burst froze the page.
    //
    // The stage condition is not redundant with the tick one. A stage
    // boundary's startTick is the tick count at which the *previous* stage
    // ended, and stepTick() only auto-confirms the pending StageClear on its
    // next call — so stopping the instant totalTicks reaches targetTick can
    // leave the viewer looking at the previous stage's finished board rather
    // than the final stage this method promises.
    while (!this.isFinished() && (this.session.getTotalTicks() < targetTick || this.session.getStage() < targetStage)) {
      this.stepTick();
      this.session.drainEvents();
      this.session.drainDespawnedEmberPositions();
      if (++sinceYield >= chunkTicks) {
        sinceYield = 0;
        onProgress?.(this.session.getTotalTicks());
        await yieldToEventLoop();
        // Aborting mid-skip leaves the session at whatever tick it reached —
        // a legitimate replay position, just not the final stage. That is the
        // right behavior for EXIT, whose whole point is that this engine is
        // about to be discarded.
        if (signal?.aborted) throw new ReplayAbortedError();
      }
    }
  }
}
