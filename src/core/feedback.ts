// Read-only notices of what a tick's claim or miss looked like, for the
// presentation layer (hit stop, fill reveal, score popup, shards, sounds).
// Pure data — no DOM/Canvas dependencies. Only produced when a Game/
// GameSession is constructed with `captureFeedback: true`; the server-side
// replay verification, replay viewing and every other caller leave it off and
// pay nothing for it. Producing a notice never touches the rng, the board,
// the score or the order of GameEvents, so a run plays out identically
// whether or not it is captured.
import type { Point } from './field';
import type { LineSpeed } from './claim';

/** What a life was lost to. */
export type MissCause = 'wisp' | 'ember' | 'igniter';

export interface ClaimFeedback {
  /** claimArea()'s claimedCells for this claim. */
  claimedCells: number;
  /** Occupancy (0-1) right before this claim. */
  occupancyBefore: number;
  /** Occupancy (0-1) right after this claim. */
  occupancyAfter: number;
  lineSpeed: LineSpeed;
  /** Area points this claim scored (the stage-clear excess bonus is not included). */
  areaScore: number;
  /** The score multiplier applied to `areaScore`. */
  multiplier: number;
  /** True when this claim split the Wisps apart. */
  split: boolean;
  /** True when this claim cleared the stage (by occupancy or by a split). */
  stageCleared: boolean;
  /** The cells of the line that closed (a copy). */
  closedLine: Point[];
}

export interface MissFeedback {
  cause: MissCause;
  /** Where the contact happened: the hitting Wisp's head for 'wisp', the marker for 'ember' and 'igniter'. */
  position: Point;
  /** The in-progress line's cells right before it vanished (a copy; empty when no line was being drawn). */
  line: Point[];
}
