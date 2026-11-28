// The HUD's score counting up to the real score after points are added. Pure
// and tick-driven: no DOM, no clock. main.ts ticks it once per live tick
// (next to FxDirector.tick(), so it keeps counting through a hit stop) and
// hands it the session's real score after each tick. Only the HUD's SCORE
// number reads value(); everything that keeps or shares the score (the high
// score, the GAME OVER modal, the X share, the ranking) reads the session.
export class ScoreRoll {
  private from = 0;
  private target = 0;
  private age = 0;
  private duration = 0;

  /**
   * Follows the real score. An increase starts counting from the value shown
   * right now to the new score over `rollTicks` ticks (a new increase while
   * still counting starts again from the current value). A decrease, a
   * reset to 0 (a new run) or `rollTicks` <= 0 shows the real score at once.
   */
  setTarget(actual: number, rollTicks: number): void {
    if (actual === this.target) return;
    if (actual < this.target || actual === 0 || rollTicks <= 0) {
      this.snap(actual);
      return;
    }
    this.from = this.value();
    this.target = actual;
    this.age = 0;
    this.duration = Math.round(rollTicks);
  }

  /** Shows `actual` at once and stops counting. */
  snap(actual: number): void {
    this.from = actual;
    this.target = actual;
    this.age = 0;
    this.duration = 0;
  }

  /** Advances the count by one fixed tick. */
  tick(): void {
    if (this.isRolling()) this.age++;
  }

  isRolling(): boolean {
    return this.age < this.duration;
  }

  /** The score to show: a whole number between the value counting started from and the real score. */
  value(): number {
    if (!this.isRolling()) return this.target;
    return Math.floor(this.from + ((this.target - this.from) * this.age) / this.duration);
  }
}
