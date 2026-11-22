// The in-play hints: a short line, the first time a situation comes up, on
// how to draw, which side becomes yours, the slow line's double points, the
// split clear and the three enemies. No DOM here — main.ts hands in what
// each live tick did and draws whatever comes back (the line, a mark on the
// field, a glowing touch button). Display only: nothing here reaches the
// input, the run, its recording or its score.
//
// Two kinds of hint, one shown at a time:
// - continuing (draw, slow): shown for as long as they are due, whenever no
//   other hint is shown or waiting. draw is due until the first claim; slow
//   from the run's second claim until a slow-line claim, or until it has
//   been shown HINT_SLOW_MAX_TICKS. Neither is marked seen before that, so a
//   run that ends first shows it again next time.
// - timed (claimSide, split, ember, blaze, igniter): shown in the order they
//   come up, for HINT_TIMED_TICKS (split: HINT_SPLIT_TICKS), and marked seen
//   as they appear. One that comes up while another is shown waits; one that
//   has waited longer than HINT_QUEUE_MAX_WAIT_TICKS is dropped unseen.
//
// Hints are shown only while the live run is playing: the tick it stops (a
// clear, a GAME OVER, the title) drops the shown hint and the waiting ones.
// Every tick is stepped, hit-stopped ones included, so the hints' time runs
// like the effects'.
import type { GameEvent } from '../core/events';
import type { LineSpeed } from '../core/claim';
import type { MessageKey } from '../i18n';
import {
  HINT_TIMED_TICKS,
  HINT_SPLIT_TICKS,
  HINT_SLOW_MAX_TICKS,
  HINT_QUEUE_MAX_WAIT_TICKS,
  HINT_RING_TICKS,
} from '../config';

export type HintId = 'draw' | 'claimSide' | 'slow' | 'split' | 'ember' | 'blaze' | 'igniter';

export const HINT_IDS: readonly HintId[] = ['draw', 'claimSide', 'slow', 'split', 'ember', 'blaze', 'igniter'];

/** Where a hint's seen ids are kept (src/storage/hints.ts's HintSeenStore). */
export interface HintSeen {
  has(id: string): boolean;
  markSeen(id: string): void;
}

/** What one live tick did. `T` is the Ember type (an object reference). */
export interface HintStep<T> {
  /** The live run is playing this tick (not a replay, not title / STAGE CLEAR / GAME OVER). */
  playing: boolean;
  /** 'run': the first tick of a new run's play; 'stage': of a later stage's; null otherwise. */
  stageStart: 'run' | 'stage' | null;
  /** The Wisps on the field (read when a stage starts). */
  wispCount: number;
  /** This tick's claims. */
  claims: ReadonlyArray<{ lineSpeed: LineSpeed }>;
  /** This tick's game events. */
  events: readonly GameEvent[];
  /** The Ember that spawned this tick (the last of the field's Embers), for its ring. */
  spawnedEmber: T | null;
  /** A touch device: the touch sentences and the button glow. */
  touch: boolean;
}

export type HintRingTarget<T> = { kind: 'ring'; target: 'wisps' } | { kind: 'ring'; target: 'igniter' } | { kind: 'ring'; target: 'ember'; ember: T };

/** The mark on the field: the arrow from the marker, or a ring around the target. */
export type HintMark<T> = { kind: 'arrow' } | HintRingTarget<T>;

export interface HintView<T> {
  id: HintId;
  textKey: MessageKey;
  /** Ticks shown so far: 0 on the tick it appears. */
  age: number;
  /** A timed hint's ticks left, this one included; null for a continuing hint. */
  remaining: number | null;
  /** The mark on the field; a ring only for its first HINT_RING_TICKS. */
  mark: HintMark<T> | null;
  /** The touch button to light (touch devices only). */
  glow: 'fast' | 'slow' | null;
}

interface Timed<T> {
  id: HintId;
  duration: number;
  ring: HintRingTarget<T>;
  /** Ticks shown (the shown one) or waited (a waiting one). */
  ticks: number;
}

export class HintDirector<T> {
  private readonly seen: HintSeen;
  private timed: Timed<T> | null = null;
  private queue: Timed<T>[] = [];
  private continuing: { id: 'draw' | 'slow'; age: number } | null = null;
  private claimCount = 0;
  private slowShownTicks = 0;
  private lastView: HintView<T> | null = null;

  constructor(seen: HintSeen) {
    this.seen = seen;
  }

  /** Advances one live tick and returns the hint to show, or null. */
  step(input: HintStep<T>): HintView<T> | null {
    this.age();

    if (input.stageStart === 'run') {
      this.claimCount = 0;
      this.slowShownTicks = 0;
    }
    // The split hint waits for a later stage's start: every stage has two
    // Wisps or more, and a first run must begin with how to draw.
    if (input.stageStart === 'stage' && input.wispCount >= 2) this.enqueue('split', HINT_SPLIT_TICKS, { kind: 'ring', target: 'wisps' });
    for (const claim of input.claims) this.onClaim(claim.lineSpeed);
    for (const event of input.events) {
      if (event === 'ember-spawned' || event === 'ember-blaze-spawned') {
        const ring: HintRingTarget<T> | null = input.spawnedEmber === null ? null : { kind: 'ring', target: 'ember', ember: input.spawnedEmber };
        this.enqueue(event === 'ember-spawned' ? 'ember' : 'blaze', HINT_TIMED_TICKS, ring);
      } else if (event === 'igniter-spawned') {
        this.enqueue('igniter', HINT_TIMED_TICKS, { kind: 'ring', target: 'igniter' });
      }
    }

    if (!input.playing) {
      this.reset();
      return null;
    }

    if (this.timed === null && this.queue.length > 0) {
      this.timed = this.queue.shift()!;
      this.timed.ticks = 0;
      this.seen.markSeen(this.timed.id);
    }
    if (this.timed !== null) {
      this.continuing = null;
      return this.setView(this.timedView(this.timed));
    }
    return this.setView(this.continuingView(input.touch));
  }

  /** The hint returned by the last step(), or null. */
  current(): HintView<T> | null {
    return this.lastView;
  }

  /** Drops the shown hint and the waiting ones (entering a replay, say). Seen ids are kept. */
  reset(): void {
    this.timed = null;
    this.queue = [];
    this.continuing = null;
    this.lastView = null;
  }

  private setView(view: HintView<T> | null): HintView<T> | null {
    this.lastView = view;
    return view;
  }

  private age(): void {
    if (this.timed !== null) {
      this.timed.ticks++;
      if (this.timed.ticks >= this.timed.duration) this.timed = null;
    }
    for (const waiting of this.queue) waiting.ticks++;
    this.queue = this.queue.filter((waiting) => waiting.ticks <= HINT_QUEUE_MAX_WAIT_TICKS);
    if (this.continuing !== null) this.continuing.age++;
  }

  private onClaim(lineSpeed: LineSpeed): void {
    const before = this.claimCount;
    this.claimCount++;
    if (!this.seen.has('draw')) this.seen.markSeen('draw');
    if (before === 0) this.enqueue('claimSide', HINT_TIMED_TICKS, { kind: 'ring', target: 'wisps' });
    // A slow-line claim once slow is due: the player has done what it says.
    if (lineSpeed === 'slow' && before >= 2 && !this.seen.has('slow')) this.seen.markSeen('slow');
  }

  private enqueue(id: HintId, duration: number, ring: HintRingTarget<T> | null): void {
    if (ring === null || this.seen.has(id)) return;
    if (this.timed?.id === id || this.queue.some((waiting) => waiting.id === id)) return;
    this.queue.push({ id, duration, ring, ticks: 0 });
  }

  private timedView(timed: Timed<T>): HintView<T> {
    return {
      id: timed.id,
      textKey: `hint.${timed.id}` as MessageKey,
      age: timed.ticks,
      remaining: timed.duration - timed.ticks,
      mark: timed.ticks < HINT_RING_TICKS ? timed.ring : null,
      glow: null,
    };
  }

  private continuingView(touch: boolean): HintView<T> | null {
    const due = this.dueContinuing();
    if (due === null) {
      this.continuing = null;
      return null;
    }
    if (due === 'slow') {
      if (this.slowShownTicks >= HINT_SLOW_MAX_TICKS) {
        this.seen.markSeen('slow');
        this.continuing = null;
        return null;
      }
      this.slowShownTicks++;
    }
    if (this.continuing?.id !== due) this.continuing = { id: due, age: 0 };
    const input = touch ? 'touch' : 'key';
    return {
      id: due,
      textKey: `hint.${due}.${input}` as MessageKey,
      age: this.continuing.age,
      remaining: null,
      mark: due === 'draw' ? { kind: 'arrow' } : null,
      glow: touch ? (due === 'draw' ? 'fast' : 'slow') : null,
    };
  }

  private dueContinuing(): 'draw' | 'slow' | null {
    if (!this.seen.has('draw')) return 'draw';
    if (this.claimCount >= 2 && !this.seen.has('slow')) return 'slow';
    return null;
  }
}
