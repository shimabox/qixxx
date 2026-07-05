// Igniter: the enemy that chases up the player's in-progress line from its
// root. Pure logic — no DOM/Canvas dependencies. docs/plan.md §3.4 (3)
// describes this creature as "Fuse"; per §1 the original name is never used
// in code/UI, so it is called "Igniter" here.
//
// Movement model (docs/plan.md §4.3): Igniter doesn't hold its own
// coordinates — it holds an index into the marker's `line: Point[]` array
// (see marker.ts), starting at index 0 (the root of the line, closest to the
// border point it was drawn from). It advances one index per
// IGNITER_ADVANCE_TICKS ticks, but only while the player is stationary;
// while the player is moving it's frozen in place. Once its index reaches
// the line's last index (the marker's current position), it has caught up —
// a miss (docs/plan.md §3.5).
import { IGNITER_SPAWN_STILL_TICKS, IGNITER_ADVANCE_TICKS } from '../config';

/**
 * True once the player has been stationary, mid-line, for long enough for an
 * Igniter to spawn (docs/plan.md §3.4 (3): ~1s). `stillTicks` counts
 * consecutive ticks — while a line is in progress — during which no
 * movement direction was held.
 */
export function shouldSpawnIgniter(stillTicks: number): boolean {
  return stillTicks >= IGNITER_SPAWN_STILL_TICKS;
}

export class Igniter {
  private index = 0;
  private advanceCooldownTicks = 0;

  /** Current index into the marker's line array; `line[getIndex()]` is its position. */
  getIndex(): number {
    return this.index;
  }

  /**
   * Advances by one tick. `playerStill` is true when the player held no
   * movement direction this tick (docs/plan.md §4.3: "プレイヤーが動いてい
   * る間は停止"). `maxIndex` is the marker's current line's last valid index
   * (its current position) — the index never advances past it.
   *
   * Returns true once the Igniter has caught up to (reached) `maxIndex`,
   * i.e. a miss (docs/plan.md §3.5).
   */
  update(playerStill: boolean, maxIndex: number): boolean {
    if (playerStill) {
      if (this.advanceCooldownTicks > 0) {
        this.advanceCooldownTicks--;
      } else if (this.index < maxIndex) {
        this.index++;
        this.advanceCooldownTicks = IGNITER_ADVANCE_TICKS - 1;
      }
    }
    return this.index >= maxIndex;
  }
}
