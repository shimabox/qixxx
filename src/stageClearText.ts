// The STAGE CLEAR overlay's wording, shared by live play and replay viewing.
//
// Kept as a standalone, DOM-free module (like src/runMode.ts) so the exact
// strings have direct unit test coverage: the live wording is asserted on by
// the E2E suite, and src/main.ts itself has no dedicated test file.

/** The part of a GameSession this wording is built from — the live session and a replay's own session both satisfy it. */
export interface StageClearTextSource {
  getStage(): number;
  getGame(): { getLastClearWasSplit(): boolean };
}

/**
 * `STAGE n CLEAR!`, plus `(SPLIT CLEAR!)` on its own line when the stage was
 * cleared by a split.
 *
 * `withPrompt` appends the "press any key" line. Live play waits for that
 * input; a replay moves on by itself, so it must not ask for one.
 */
export function stageClearText(source: StageClearTextSource, options: { withPrompt: boolean }): string {
  const splitNote = source.getGame().getLastClearWasSplit() ? '\n(SPLIT CLEAR!)' : '';
  const prompt = options.withPrompt ? '\n\nPRESS ANY KEY OR TAP FOR NEXT STAGE' : '';
  return `STAGE ${source.getStage()} CLEAR!${splitNote}${prompt}`;
}
