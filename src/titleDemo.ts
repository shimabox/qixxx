// The Title screen's demo: one of the ranking board's best runs, replayed
// silently behind the title text so a first-time visitor sees the game move.
//
// DOM-free, like src/replayStageClearHold.ts: main.ts hands it the tick's
// situation once per fixed tick (step()) and draws whichever engine
// getShownEngine() returns. The network and ReplayEngine.create() come in
// through `deps`, so every rule below is unit-tested (src/titleDemo.test.ts).
//
// The demo runs on its own ReplayEngine with its own GameSession: it never
// reads or writes the live run, its input, its high score or its ranking
// submission, and every event its session raises is drained here and
// dropped, so it makes no sound.
//
// The life of a demo:
// - waiting: on the live Title screen it counts ticks; after startDelayTicks,
//   with at least one candidate, it starts preparing.
// - preparing: fetches the candidates' replays in board order (each at most
//   once per page), keeps the first one this build can play, and builds an
//   engine from it. A failed fetch, an unplayable payload or a failed build
//   moves on to the next candidate; when none is left the demo is off.
// - playing: one recorded tick per tick, holding each STAGE CLEAR like the
//   ranking's replay viewer does.
// - ended: the run's last board stays up while the next engine is built from
//   the same record; once endHoldTicks have passed and it is ready, playback
//   starts again from the beginning. If that build fails the demo is off.
// - off: for the rest of the page load.
// Leaving the Title screen (a run starts, a ranking replay opens) or losing
// permission (reduced motion turned on) drops the engines, aborts any build
// in progress and goes back to waiting; the fetched record is kept.
import type { SessionStatus } from './core/session';
import { ReplayStageClearHold } from './replayStageClearHold';

/** What the demo needs from a replay engine (src/core/replayEngine.ts's ReplayEngine has it). */
export interface TitleDemoEngine {
  stepTick(): boolean;
  isFinished(): boolean;
  getSession(): {
    getStatus(): SessionStatus;
    drainEvents(): unknown[];
    drainDespawnedEmberPositions(): unknown[];
  };
}

/** A fetched replay this build can play: the seed and the RLE-encoded input. */
export interface TitleDemoRecord {
  seed: number;
  rle: Uint8Array;
}

export interface TitleDemoDeps<E extends TitleDemoEngine> {
  /** GET /api/ranking/{id}/replay: the parsed body, or null for a non-2xx answer. May throw. */
  fetchReplay(id: string): Promise<unknown>;
  /** isReplayPayloadPlayable() against this build's versions. */
  isPlayable(payload: unknown): payload is { seed: number; rleBase64: string };
  /** base64 -> bytes. May throw on a malformed string. */
  decode(rleBase64: string): Uint8Array;
  /** ReplayEngine.create(); rejects when `signal` aborts it. */
  createEngine(record: TitleDemoRecord, signal: AbortSignal): Promise<E>;
  startDelayTicks: number;
  endHoldTicks: number;
  stageClearHoldTicks: number;
}

export interface TitleDemoTick {
  /** The live run is on its Title screen and no ranking replay is being viewed. */
  onTitle: boolean;
  /** False with reduced motion or on a `?seed=` page: no demo at all. */
  allowed: boolean;
  /** The board's replayable ids, best first (RankingUI.getDemoCandidateIds()). */
  candidates: readonly string[];
}

export type TitleDemoState = 'waiting' | 'preparing' | 'playing' | 'ended' | 'off';

export class TitleDemo<E extends TitleDemoEngine> {
  private state: TitleDemoState = 'waiting';
  private titleTicks = 0;
  private endTicks = 0;
  // Bumped whenever the demo leaves a preparing/ended state, so an async
  // result that belongs to an abandoned attempt is dropped.
  private generation = 0;
  private abort: AbortController | null = null;
  private engine: E | null = null;
  private nextEngine: E | null = null;
  private nextFailed = false;
  private readonly stageClearHold: ReplayStageClearHold;

  // The candidates as they stood when preparation first began, and the next
  // one to try. A candidate is fetched at most once per page.
  private candidates: readonly string[] | null = null;
  private candidateIndex = 0;
  private fetchInFlight: Promise<TitleDemoRecord | null> | null = null;
  // The current candidate's fetched record, before an engine was built from it.
  private fetched: TitleDemoRecord | null = null;
  // The record an engine was built from: the demo for the rest of the page.
  private record: TitleDemoRecord | null = null;

  constructor(private readonly deps: TitleDemoDeps<E>) {
    this.stageClearHold = new ReplayStageClearHold(deps.stageClearHoldTicks);
  }

  getState(): TitleDemoState {
    return this.state;
  }

  /** The engine to draw this frame (playing, or holding the last board), else null. */
  getShownEngine(): E | null {
    return this.state === 'playing' || this.state === 'ended' ? this.engine : null;
  }

  /** Call once per fixed tick, after the live tick ran. */
  step(tick: TitleDemoTick): void {
    if (this.state === 'off') return;
    if (!tick.onTitle || !tick.allowed) {
      this.leave();
      return;
    }
    switch (this.state) {
      case 'waiting':
        this.titleTicks++;
        if (this.titleTicks < this.deps.startDelayTicks) return;
        if (this.record === null && this.fetched === null) {
          if (this.candidates === null) {
            if (tick.candidates.length === 0) return;
            this.candidates = [...tick.candidates];
          }
          if (this.candidateIndex >= this.candidates.length && this.fetchInFlight === null) {
            this.turnOff();
            return;
          }
        }
        this.beginPreparing();
        return;
      case 'preparing':
        return;
      case 'playing':
        this.stepEngine();
        return;
      case 'ended':
        if (this.nextFailed) {
          this.turnOff();
          return;
        }
        if (this.endTicks < this.deps.endHoldTicks) this.endTicks++;
        if (this.endTicks >= this.deps.endHoldTicks && this.nextEngine !== null) {
          const next = this.nextEngine;
          this.nextEngine = null;
          this.abort = null;
          this.startPlaying(next);
        }
        return;
    }
  }

  private stepEngine(): void {
    const engine = this.engine;
    if (!engine) return;
    const session = engine.getSession();
    const holding = this.stageClearHold.shouldHold({ status: session.getStatus(), finished: engine.isFinished() });
    if (!holding) engine.stepTick();
    // Drained every tick and dropped: the demo is silent, and the queues
    // would otherwise grow without bound.
    session.drainEvents();
    session.drainDespawnedEmberPositions();
    if (engine.isFinished()) this.beginEnded();
  }

  private startPlaying(engine: E): void {
    this.engine = engine;
    this.state = 'playing';
    this.stageClearHold.reset();
  }

  private beginEnded(): void {
    this.state = 'ended';
    this.endTicks = 0;
    this.nextEngine = null;
    this.nextFailed = false;
    const record = this.record;
    if (!record) {
      this.nextFailed = true;
      return;
    }
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.deps.createEngine(record, abort.signal).then(
      (engine) => {
        if (this.generation !== generation || abort.signal.aborted) return;
        this.nextEngine = engine;
      },
      () => {
        if (this.generation !== generation || abort.signal.aborted) return;
        this.nextFailed = true;
      }
    );
  }

  private beginPreparing(): void {
    this.state = 'preparing';
    const abort = new AbortController();
    this.abort = abort;
    void this.prepare(this.generation, abort.signal);
  }

  private async prepare(generation: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (this.generation !== generation) return;
      let record = this.record ?? this.fetched;
      if (record === null) {
        const candidates = this.candidates ?? [];
        if (this.candidateIndex >= candidates.length && this.fetchInFlight === null) {
          this.turnOff();
          return;
        }
        record = await this.fetchCandidate();
        if (this.generation !== generation) return;
        if (record === null) continue;
      }
      try {
        const engine = await this.deps.createEngine(record, signal);
        if (this.generation !== generation || signal.aborted) return;
        this.record = record;
        this.fetched = null;
        this.abort = null;
        this.startPlaying(engine);
        return;
      } catch {
        // An abort keeps the record for the next Title screen.
        if (this.generation !== generation || signal.aborted) return;
        if (this.record !== null) {
          // The record that played before no longer builds: stop for good.
          this.turnOff();
          return;
        }
        this.fetched = null;
        this.candidateIndex++;
      }
    }
  }

  /**
   * Fetches the current candidate, or joins its fetch already in flight (one
   * started before the Title screen was left runs on, and its result is
   * kept). A failure or an unplayable payload moves on to the next candidate.
   */
  private fetchCandidate(): Promise<TitleDemoRecord | null> {
    if (this.fetchInFlight) return this.fetchInFlight;
    const id = (this.candidates ?? [])[this.candidateIndex];
    const request = (async (): Promise<TitleDemoRecord | null> => {
      let record: TitleDemoRecord | null = null;
      try {
        const payload = await this.deps.fetchReplay(id);
        if (this.deps.isPlayable(payload)) record = { seed: payload.seed, rle: this.deps.decode(payload.rleBase64) };
      } catch {
        record = null;
      }
      this.fetchInFlight = null;
      if (record) this.fetched = record;
      else this.candidateIndex++;
      return record;
    })();
    this.fetchInFlight = request;
    return request;
  }

  private leave(): void {
    if (this.state === 'waiting') {
      this.titleTicks = 0;
      return;
    }
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.engine = null;
    this.nextEngine = null;
    this.nextFailed = false;
    this.titleTicks = 0;
    this.state = 'waiting';
  }

  private turnOff(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.engine = null;
    this.nextEngine = null;
    this.state = 'off';
  }
}
