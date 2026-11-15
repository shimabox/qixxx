// The HUD's wording and the multiplier's emphasis timing. Pure and
// tick-driven — no DOM, no clock — so the exact strings and the emphasis
// timing have direct unit test coverage (src/hudText.test.ts). main.ts puts
// the parts into the HUD's line elements. The words come from the text
// table (src/i18n/) and stay English in every language.
import { t } from './i18n';

/** A whole percent of a 0-1 share, rounded down (a hair of tolerance keeps 0.7 from reading 69). */
export function floorPercent(share: number): number {
  return Math.min(100, Math.floor(share * 100 + 1e-9));
}

/** `<current>%/<goal>% <left>% LEFT`, with left = max(0, goal - current) (all whole, rounded-down percents). */
export function occupancyText(currentPercent: number, goalPercent: number): string {
  const left = Math.max(0, goalPercent - currentPercent);
  return t('hud.occupancy', currentPercent, goalPercent, left);
}

/**
 * Lives as `slots` marks: `◆` for each one left, `◇` for each one lost. A
 * value past the slots (a dev-only override) reads `◆x<lives>`.
 */
export function livesText(lives: number, slots: number): string {
  const left = Math.max(0, Math.floor(lives));
  if (left > slots) return `◆x${left}`;
  return '◆'.repeat(left) + '◇'.repeat(slots - left);
}

/** Where main.ts drops its own SCORE and multiplier spans into a line. */
export const HUD_SCORE_SLOT = { slot: 'score' } as const;
export const HUD_MULTIPLIER_SLOT = { slot: 'multiplier' } as const;
/** The lives marks (livesText()): main.ts wraps them so their fallback glyphs cannot make the line taller. */
export const HUD_LIVES_SLOT = { slot: 'lives' } as const;
export type HudPart = string | typeof HUD_SCORE_SLOT | typeof HUD_MULTIPLIER_SLOT | typeof HUD_LIVES_SLOT;

export interface HudTextInput {
  /** runMode.ts's resolveHudModePrefix(): '' or `SEED <n>  `. */
  modePrefix: string;
  stage: number;
  hiScore: number;
  /** hudGoal.ts's hudGoalText(). */
  goal: string;
  /** True when `goal` is itself the high score (`HI <n>`), so two-line mode does not show it twice. */
  goalIsHiScore: boolean;
  /** `M:SS.D`. */
  time: string;
  occupancyPercent: number;
  goalPercent: number;
}

export interface HudLines {
  lines: HudPart[][];
  /** The line carrying TIME (the one the last-30-seconds warning colours). */
  timeLine: number;
}

/**
 * The HUD's lines. One line:
 * `STAGE 3  SCORE 12345  TO BEST 1200  TIME 2:41.3  41%/75% 34% LEFT  ◆◆◇  x2`.
 * Two-line mode (narrow screens) spreads the same fields over three lines:
 * STAGE/SCORE/HI, then occupancy/lives/multiplier, then TIME and the goal.
 */
export function hudLines(input: HudTextInput, twoLine: boolean): HudLines {
  const occupancy = occupancyText(input.occupancyPercent, input.goalPercent);
  if (twoLine) {
    const goal = input.goalIsHiScore ? '' : `  ${input.goal}`;
    return {
      lines: [
        [`${t('hud.stage', input.stage)}  ${t('hud.score')} `, HUD_SCORE_SLOT, `  ${t('hud.hi', input.hiScore)}`],
        [`${occupancy}  `, HUD_LIVES_SLOT, '  ', HUD_MULTIPLIER_SLOT],
        [`${input.modePrefix}${t('hud.time', input.time)}${goal}`],
      ],
      timeLine: 2,
    };
  }
  return {
    lines: [
      [
        `${input.modePrefix}${t('hud.stage', input.stage)}  ${t('hud.score')} `,
        HUD_SCORE_SLOT,
        `  ${input.goal}  ${t('hud.time', input.time)}  ${occupancy}  `,
        HUD_LIVES_SLOT,
        '  ',
        HUD_MULTIPLIER_SLOT,
      ],
    ],
    timeLine: 0,
  };
}

export type MultiplierEmphasisKind = 'up' | 'down';

export interface MultiplierEmphasisFrame {
  kind: MultiplierEmphasisKind;
  /** 1 on its first tick, falling toward 0. */
  strength: number;
}

/**
 * Times the HUD multiplier's emphasis: 'up' right after it rises, 'down'
 * right after it falls (a miss sends it back to x1). A rise that arrives with
 * the multiplier travelling in from the field (after a split) waits for it to
 * land, so the two never show at once.
 */
export class MultiplierEmphasis {
  private last: number | null = null;
  private current: { kind: MultiplierEmphasisKind; age: number; duration: number } | null = null;
  private pendingUp = false;

  /** Ages the emphasis by one fixed tick (every live tick, hit-stopped ones included). */
  tick(): void {
    if (!this.current) return;
    this.current.age++;
    if (this.current.age >= this.current.duration) this.current = null;
  }

  /**
   * After a session update: reacts to the value the multiplier now reads.
   * `flying`: the travelling multiplier is still on its way to the HUD.
   */
  observe(multiplier: number, flying: boolean, durationTicks: number): void {
    if (this.last !== null && multiplier !== this.last) {
      if (multiplier > this.last) {
        if (flying) this.pendingUp = true;
        else this.start('up', durationTicks);
      } else {
        this.pendingUp = false;
        this.start('down', durationTicks);
      }
    } else if (this.pendingUp && !flying) {
      this.start('up', durationTicks);
    }
    this.last = multiplier;
  }

  /** tick() then observe(): one whole tick. */
  step(multiplier: number, flying: boolean, durationTicks: number): void {
    this.tick();
    this.observe(multiplier, flying, durationTicks);
  }

  /** A new run: no emphasis, and `multiplier` is the value to compare against. */
  reset(multiplier: number | null = null): void {
    this.last = multiplier;
    this.current = null;
    this.pendingUp = false;
  }

  frame(): MultiplierEmphasisFrame | null {
    if (!this.current) return null;
    return { kind: this.current.kind, strength: 1 - this.current.age / this.current.duration };
  }

  private start(kind: MultiplierEmphasisKind, durationTicks: number): void {
    this.pendingUp = false;
    const duration = Math.round(durationTicks);
    this.current = duration > 0 ? { kind, age: 0, duration } : null;
  }
}
