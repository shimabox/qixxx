// How hard a run is: NORMAL, the game as it is ranked, or EASY, an entry for
// players who keep ending in the first stages — slower Wisps, more lives, and
// every stage starting from the middle of the top edge. A separate axis from
// RunMode (src/runMode.ts, normal / `?seed=`): an EASY run can be seeded too.
// EASY never changes what a NORMAL run plays like, scores or records, and an
// EASY run is never saved as a high score, posted to the ranking or kept in
// the play log.
//
// DOM-free (core/session.ts reads it), so it never pulls storage into the
// server's type check.
import { EASY_INITIAL_LIVES, EASY_WISP_SPEED_FACTOR, INITIAL_LIVES } from '../config';

export type Difficulty = 'normal' | 'easy';

/** The lives a new run of `difficulty` starts with. */
export function initialLivesFor(difficulty: Difficulty): number {
  return difficulty === 'easy' ? EASY_INITIAL_LIVES : INITIAL_LIVES;
}

/** A stage's Wisp speed (core/stage.ts's table value) in a run of `difficulty`. */
export function wispSpeedFor(difficulty: Difficulty, tableSpeed: number): number {
  return difficulty === 'easy' ? tableSpeed * EASY_WISP_SPEED_FACTOR : tableSpeed;
}

/** `value` when it names a difficulty, else NORMAL. */
export function parseDifficulty(value: unknown): Difficulty {
  return value === 'easy' ? 'easy' : 'normal';
}
