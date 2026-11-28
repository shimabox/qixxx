// Builds the play log's record of one live run (src/playLog/record.ts) from
// what each tick did. DOM-free and read-only: it is handed the claim and miss
// notices the impact feedback has already drained (src/fx/liveTick.ts), never
// drains anything itself, and never feeds anything back into the run.
import type { SessionStatus } from '../core/session';
import type { ClaimFeedback, MissFeedback } from '../core/feedback';
import { emptyMissTally, type PlayEnd, type PlayRecord, type StageTally } from './record';

export interface ObserveTickArgs {
  /** session.getStage() read before this tick's core update. */
  stageBefore: number;
  /** session.getStatus() read before this tick's core update. */
  statusBefore: SessionStatus;
  /** The claim notices this tick produced. */
  claims: readonly ClaimFeedback[];
  /** The miss notices this tick produced. */
  misses: readonly MissFeedback[];
}

export interface FinishArgs {
  /** The stage the run ended on. */
  stage: number;
  score: number;
  end: PlayEnd;
  /** Date.now() at the end. */
  endedAt: number;
}

export class PlayLogRecorder {
  private active = false;
  private ticks = 0;
  private stages: StageTally[] = [];

  /** A new run begins: whatever the previous one left is dropped. */
  startRun(): void {
    this.active = true;
    this.ticks = 0;
    this.stages = [];
  }

  /**
   * Called once for every tick the core was updated on. Only ticks that
   * started playing or on STAGE CLEAR count; everything the tick's notices
   * say goes to the stage it started on — so the claim that clears a stage
   * counts for that stage, not the next one.
   */
  observeTick(args: ObserveTickArgs): void {
    if (!this.active) return;
    if (args.statusBefore !== 'playing' && args.statusBefore !== 'stageclear') return;
    this.ticks++;
    const tally = this.tallyFor(args.stageBefore);
    for (const claim of args.claims) {
      tally.claims++;
      if (claim.split) tally.splits++;
      if (claim.stageCleared) tally.cleared = true;
    }
    for (const miss of args.misses) tally.misses[miss.cause]++;
  }

  /**
   * The run ended: returns its record, once. Null when no run was started,
   * or this run's record was already returned.
   */
  finish(args: FinishArgs): PlayRecord | null {
    if (!this.active) return null;
    this.active = false;
    this.tallyFor(args.stage);
    return {
      endedAt: args.endedAt,
      stage: args.stage,
      score: args.score,
      end: args.end,
      ticks: this.ticks,
      stages: this.stages.map((s) => ({ ...s, misses: { ...s.misses } })),
    };
  }

  /** The tally of `stage`, adding every stage up to it that is not there yet. */
  private tallyFor(stage: number): StageTally {
    const n = Math.max(1, Math.floor(stage));
    while (this.stages.length < n) {
      this.stages.push({ stage: this.stages.length + 1, claims: 0, splits: 0, misses: emptyMissTally(), cleared: false });
    }
    return this.stages[n - 1];
  }
}
