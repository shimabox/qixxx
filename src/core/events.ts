// Discrete "something just happened" occurrences that Game/GameSession can
// produce during a tick. This is the entire core -> audio bridge (docs/plan.md
// §3.8 / §9.9): core only ever appends event names to a queue here — it never
// imports or references AudioContext, `window`, or any other DOM/Web Audio
// API. main.ts drains the queue once per rendered frame and hands the result
// to src/audio/sfx.ts, which decides what (if anything) to actually play.
//
// Continuous *states* — e.g. "currently drawing a line, at fast/slow speed" —
// are deliberately NOT modeled as events: callers can already read that
// directly off Marker.isDrawing()/the current input each tick, and turning a
// steady state into a repeated per-tick event would just be queue busywork.
// Only edge-triggered occurrences (a claim just closed, a life was just
// lost, ...) belong here.
export type GameEvent =
  | 'area-claimed'
  | 'stage-clear'
  | 'split-clear'
  | 'miss'
  | 'igniter-spawned'
  | 'igniter-approaching'
  | 'ember-spawned'
  // A fresh Ember spawned this generation is a "Blaze" (docs/plan.md §14
  // M6-1: EMBER_LINE_ENTRY_GENERATION onward) — pushed instead of, never
  // alongside, 'ember-spawned' for that same spawn cycle.
  | 'ember-blaze-spawned'
  // A Blaze just stepped from a BORDER cell onto a LINE cell (docs/plan.md
  // §14 M6-1): edge-triggered, pushed exactly once per BORDER->LINE
  // transition, not on every tick it remains on LINE afterward.
  | 'ember-entered-line'
  // An Ember was despawned because the BORDER cell it stood on got claimed
  // out from under it (docs/plan.md §6 M11 / §12.6). This is the audio half
  // of that occurrence — the accompanying *position* (for the render
  // layer's vanish effect) is a payload no plain string event can carry, so
  // it travels alongside this event via a separate position queue (see
  // Game.drainDespawnedEmberPositions()/GameSession's forwarding of the
  // same) rather than turning GameEvent itself into a discriminated union.
  | 'ember-despawned';

/**
 * A minimal FIFO queue of items queued since the last drain. Pure data
 * structure — no DOM/timing assumptions — so it's equally usable by Game
 * (per-stage events) and GameSession (which forwards each stage's Game's
 * events up to whatever drains GameSession.drainEvents(), e.g. main.ts).
 */
export class EventQueue<T> {
  private items: T[] = [];

  push(item: T): void {
    this.items.push(item);
  }

  /**
   * Returns every item queued since the last drain, in the order they were
   * pushed, and clears the queue. Returns a fresh empty array (rather than
   * the internal buffer) so a caller mutating the result can never corrupt
   * queue state.
   */
  drain(): T[] {
    if (this.items.length === 0) return [];
    const drained = this.items;
    this.items = [];
    return drained;
  }

  /** True if nothing is queued. Mostly useful for tests/assertions. */
  isEmpty(): boolean {
    return this.items.length === 0;
  }
}
