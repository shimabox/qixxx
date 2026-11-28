// Hit stop: a few fixed ticks during which the live run's simulation is not
// advanced (main.ts skips input polling, GameSession.update() and input
// recording for that tick), so a claim, a split or a miss lands with weight.
// Only counts ticks — it never reads the clock.
export class HitStop {
  private remaining = 0;

  /** Extends the stop to at least `ticks` remaining. Overlapping requests keep the longer one; they never add up. */
  request(ticks: number): void {
    this.remaining = Math.max(this.remaining, Math.max(0, Math.floor(ticks)));
  }

  /** Spends one stopped tick: true (and one fewer remaining) while stopped, false once nothing remains. */
  consume(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }

  clear(): void {
    this.remaining = 0;
  }

  getRemaining(): number {
    return this.remaining;
  }
}
