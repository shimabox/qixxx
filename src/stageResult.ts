// The live STAGE CLEAR result: what the stage scored (AREA, BONUS, TOTAL)
// and the next stage's multiplier, counted up from 0 when the clear screen
// appears. Pure and tick-driven — no DOM, no clock — so the totals and the
// count-up have direct unit test coverage (src/stageResult.test.ts). Replay
// viewing keeps its own plain clear text (src/stageClearText.ts).
import { t } from './i18n';
import { ScreenText, screenTextString } from './screenText';

/** The parts of a claim notice (core/feedback.ts's ClaimFeedback) the result adds up. */
export interface StageResultNotice {
  areaScore: number;
  nearMissBonus: number;
  stageClearBonus: number;
}

/**
 * The points one stage has scored so far: the claims' area points (close-call
 * bonuses included, counted in AREA rather than a row of their own) and the
 * excess-occupancy bonus of the claim that cleared it. Reset when the next
 * stage starts and when a new run starts.
 */
export class StageResultTally {
  private area = 0;
  private bonus = 0;

  add(notice: StageResultNotice): void {
    this.area += notice.areaScore + notice.nearMissBonus;
    this.bonus += notice.stageClearBonus;
  }

  reset(): void {
    this.area = 0;
    this.bonus = 0;
  }

  getArea(): number {
    return this.area;
  }

  getBonus(): number {
    return this.bonus;
  }

  /** AREA + BONUS: every point the stage scored. */
  getTotal(): number {
    return this.area + this.bonus;
  }
}

export interface StageResultValues {
  area: number;
  bonus: number;
  total: number;
}

/**
 * Counts the result up from 0 over the given ticks once the clear screen is
 * visible, with the same progression as the HUD score (src/fx/scoreRoll.ts):
 * floor(final * age / duration). A confirm while counting shows the final
 * values at once (finish()).
 */
export class StageResultCounter {
  private started = false;
  private finished = false;
  private age = 0;
  private duration = 0;

  /**
   * Once per live tick. `onStageClear`: the session is on STAGE CLEAR;
   * `visible`: the clear screen is on screen this tick (SPLIT! is not
   * covering it). Starts counting on the first visible tick, then advances
   * one tick per call. Leaving STAGE CLEAR clears it for the next one.
   */
  step(onStageClear: boolean, visible: boolean, rollTicks: number): void {
    if (!onStageClear) {
      this.clear();
      return;
    }
    if (!visible) return;
    if (!this.started) {
      this.started = true;
      this.age = 0;
      this.duration = Math.max(0, Math.round(rollTicks));
      if (this.finished || this.duration === 0) this.finished = true;
      return;
    }
    if (!this.finished) {
      this.age++;
      if (this.age >= this.duration) this.finished = true;
    }
  }

  /** True until the count has reached the final values (also before it has started). */
  isCounting(): boolean {
    return !this.finished;
  }

  /** Shows the final values at once; a clear screen not shown yet appears with them. */
  finish(): void {
    this.finished = true;
  }

  /** Back to the start (a new run, the next stage, a replay). */
  clear(): void {
    this.started = false;
    this.finished = false;
    this.age = 0;
    this.duration = 0;
  }

  /** The values to show for these final values. */
  values(final: StageResultValues): StageResultValues {
    if (this.finished) return { ...final };
    // Not started yet: the screen can be drawn once before its first tick.
    if (!this.started || this.duration === 0) return { area: 0, bonus: 0, total: 0 };
    const at = (v: number) => Math.floor((v * this.age) / this.duration);
    return { area: at(final.area), bonus: at(final.bonus), total: at(final.total) };
  }
}

export interface StageResultTextInput {
  stage: number;
  values: StageResultValues;
  /** The cleared stage's multiplier. */
  multiplierBefore: number;
  /** The next stage's (higher after a split). */
  multiplierNext: number;
  /** Leave out the blank lines (a small field). */
  tight: boolean;
}

/**
 * The live clear screen:
 *
 * ```
 * STAGE 3 CLEAR!
 *
 * AREA    12340
 * BONUS    1500
 * TOTAL   13840
 * NEXT       x2
 *
 * PRESS ANY KEY OR TAP FOR NEXT STAGE
 * ```
 *
 * The rows share one width so they line up in the monospace face. NEXT reads
 * `x1 > x2` when a split raised it.
 */
export function stageResultText(input: StageResultTextInput): string {
  return screenTextString(stageResultScreen(input));
}

/** stageResultText() split into the heading and rows (`body`) and the prompt under them (`hint`). */
export function stageResultScreen(input: StageResultTextInput): ScreenText {
  const { values } = input;
  const next =
    input.multiplierNext !== input.multiplierBefore
      ? `${t('hud.multiplier', input.multiplierBefore)} > ${t('hud.multiplier', input.multiplierNext)}`
      : t('hud.multiplier', input.multiplierNext);
  const cells = [String(values.area), String(values.bonus), String(values.total), next];
  const width = Math.max(8, ...cells.map((c) => c.length + 1));
  const row = (label: string, value: string) => `${label.padEnd(5)}${value.padStart(width)}`;
  const gap = input.tight ? '\n' : '\n\n';
  const rows = [
    row(t('stageResult.area'), cells[0]),
    row(t('stageResult.bonus'), cells[1]),
    row(t('stageResult.total'), cells[2]),
    row(t('stageResult.next'), cells[3]),
  ];
  return {
    body: [t('stageClear.heading', input.stage), gap, rows.join('\n'), gap].join(''),
    hint: t('stageClear.next'),
  };
}
