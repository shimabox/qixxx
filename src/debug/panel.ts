// Dev-only debug tuning panel (docs/plan.md §6 M10 / §12.4). Loaded via a
// dynamic `import()` gated by `import.meta.env.DEV && ?debug` in main.ts, so
// Vite tree-shakes this entire module (and everything it imports that isn't
// already pulled in elsewhere) out of production builds — nothing in here
// ever ships to players. It's the one place in the codebase allowed to sit
// between DOM and `src/core/`: it only ever talks to GameSession's plain
// data-in/data-out debug API (applyDebugOverrides/resetDebugOverrides/
// getEffectiveDebugParams), so `src/core/` itself stays exactly as DOM-free
// as it was before M10.
import { GameSession } from '../core/session';
import type { DebugOverrides, EffectiveDebugParams } from '../core/game';
import type { ClaimFeedback, MissFeedback } from '../core/feedback';
import type { LineSpeed } from '../core/claim';
import type { Point } from '../core/field';
import type { FxDirector } from '../fx/director';
import type { HitStop } from '../fx/hitStop';
import type { FxParams } from '../fx/params';
import { resetSfxLevels, type SfxLevels } from '../audio/sfxLevels';
import {
  TICK_RATE,
  SPLIT_MULTIPLIER_CAP,
  PLAY_LOG_MAX_RUNS,
  PLAY_LOG_STREAK_STAGE,
  BGM_GAIN_TENSE,
  BGM_GAIN_ACID,
  BGM_GAIN_HUNT,
} from '../config';
import { t } from '../i18n';
import type { PlayLogFile } from '../playLog/record';
import { summarizePlayLog, trailingRunsAtOrBelow } from '../playLog/summary';

/**
 * What the panel's PLAY LOG section works on: the on-device play log
 * (src/storage/playLog.ts). Reading or clearing it never touches the
 * GameSession, so it never counts as a debug override.
 */
export interface DebugPlayLogHooks {
  /** The kept runs as stored, `{ v: 1, runs }`. */
  getFile: () => PlayLogFile;
  /** Forgets every kept run. */
  clear: () => void;
  /** `listener` is called whenever a run is kept or the log is cleared. */
  onChange: (listener: () => void) => void;
}

/**
 * What the panel's FX section works on: the live fxParams it tunes, and the
 * director, hit stop and sounds its TEST buttons fire directly. Nothing in
 * the FX section touches the GameSession, so using it never counts as a
 * debug override (the run stays eligible for high-score saving and ranking).
 */
export interface DebugFxHooks {
  params: FxParams;
  fx: FxDirector;
  hitStop: HitStop;
  playClaim: (claim: { share: number; speed: LineSpeed; chain: number }) => void;
  playSplitImpact: () => void;
  playMiss: () => void;
}

/**
 * Slider ranges per docs/plan.md §12.4's "調整項目（初期セット）" list.
 * wispCount/wispSpeedMultiplier/emberCount's upper bounds were widened
 * (2026-07-07 feedback, docs/plan.md §6 M11 orchestration follow-up) so the
 * panel can push well past normal per-stage values for stress-testing —
 * core (Game.setWispCount/setEmberCount) only ever floors at 0, it has no
 * upper clamp of its own, so these panel-side maxes are the only limit.
 *
 * wispCount/wispSpeedMultiplier/emberCount/requiredOccupancyPercent's upper
 * bounds were widened again to 3x their earlier stage-10
 * values (2026-07-11 feedback: wispCount 10->30, wispSpeedMultiplier
 * 5.0->15.0, emberCount 10->30, requiredOccupancyPercent 90->99 — 99 rather
 * than a literal 3x270 since occupancy is a percentage and 100% is the
 * logical ceiling). The other fields (emberMoveTicks, emberSpawnIntervalSec,
 * emberBranchChaseProbability) are left as-is: they're already at or past
 * their logical ceiling (1 tick/cell is the fastest possible move rate, 0-1
 * is branch-chase probability's full range) so widening them further has no
 * effect. Pushing wispSpeedMultiplier this high requires Wisp.tryStep
 * (src/core/enemy.ts) to sweep-check the whole move segment rather than
 * just the destination cell, or a fast Wisp could tunnel clean through a
 * one-cell-wide BORDER/CLAIMED wall in a single tick — see that method's
 * doc comment.
 */
const RANGES = {
  wispCount: { min: 0, max: 30, step: 1 },
  wispSpeedMultiplier: { min: 0.25, max: 15.0, step: 0.05 },
  emberCount: { min: 0, max: 30, step: 1 },
  emberMoveTicks: { min: 1, max: 10, step: 1 },
  emberSpawnIntervalSec: { min: 1, max: 60, step: 1 },
  emberBranchChaseProbability: { min: 0, max: 1, step: 0.05 },
  requiredOccupancyPercent: { min: 10, max: 99, step: 1 },
  // Time limit (docs/plans/2026-08-13-time-limit-mode), in seconds: mainly
  // for pulling the run's time budget way down (e.g. 5s) so a tester can
  // reach TIME UP! without waiting out the real 180s (3min) default — the
  // upper end (10min) is there for symmetry/tuning but isn't the primary
  // use case. 5s step keeps the slider's range of motion manageable at
  // either end.
  timeLimitSec: { min: 5, max: 600, step: 5 },
} as const;

interface SliderField {
  key: keyof EffectiveDebugParams;
  label: string;
  range: { min: number; max: number; step: number };
  /** Converts the effective param value (game units) to the slider's own displayed/stepped units. */
  toSlider: (value: number) => number;
  /** Converts a slider value back into the game-unit value passed to applyDebugOverrides. */
  fromSlider: (value: number) => number;
  /** Overrides object key this field writes to (differs from `key` only for requiredOccupancy's %-vs-fraction split). */
  overrideKey: keyof DebugOverrides;
  format: (value: number) => string;
}

const FIELDS: SliderField[] = [
  {
    key: 'wispCount',
    overrideKey: 'wispCount',
    label: 'Wisp count',
    range: RANGES.wispCount,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => String(v),
  },
  {
    key: 'wispSpeedMultiplier',
    overrideKey: 'wispSpeedMultiplier',
    label: 'Wisp speed x',
    range: RANGES.wispSpeedMultiplier,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'emberCount',
    overrideKey: 'emberCount',
    label: 'Ember count',
    range: RANGES.emberCount,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => String(v),
  },
  {
    key: 'emberMoveTicks',
    overrideKey: 'emberMoveTicks',
    label: 'Ember move ticks',
    range: RANGES.emberMoveTicks,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => String(v),
  },
  {
    key: 'emberSpawnIntervalSec',
    overrideKey: 'emberSpawnIntervalSec',
    label: 'Ember spawn interval (s)',
    range: RANGES.emberSpawnIntervalSec,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => `${v}s`,
  },
  {
    key: 'emberBranchChaseProbability',
    overrideKey: 'emberBranchChaseProbability',
    label: 'Branch-chase probability',
    range: RANGES.emberBranchChaseProbability,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'requiredOccupancy',
    overrideKey: 'requiredOccupancy',
    label: 'Required occupancy',
    range: RANGES.requiredOccupancyPercent,
    toSlider: (v) => Math.round(v * 100),
    fromSlider: (v) => v / 100,
    format: (v) => `${Math.round(v * 100)}%`,
  },
];

/**
 * config.ts constant names the EXPORT JSON keys map to (docs/plan.md §6 M10
 * / §12.4: "JSON のキーは config.ts の定数名と一致させる"). Fields with no
 * single 1:1 config constant (stage-dependent counts, dynamic Ember count)
 * use the closest/most-descriptive name plus a `_notes` explanation instead,
 * exactly as the plan permits ("対応する config 定数名か注記付きキー").
 *
 * `timeLimitTicks` (docs/plans/2026-08-13-time-limit-mode P3 review fix) is
 * threaded in as its own parameter, separately from `params`
 * (EffectiveDebugParams) — the run's time budget is a GameSession-level
 * concern (GameSession.getTimeLimitTicks()), not one of Game's own
 * EffectiveDebugParams, exactly like the time-limit slider itself (see
 * buildPanel()'s `timeLimit` row) — but it still needs to end up in this
 * same EXPORT payload, under the exact `TIME_LIMIT_TICKS` name, so the
 * existing EXPORT-JSON -> config.ts tuning workflow picks it up like every
 * other slider here.
 */
function buildExportPayload(
  params: EffectiveDebugParams,
  timeLimitTicks: number,
  fxParams?: FxParams,
  sound?: Record<string, number | string>
): Record<string, unknown> {
  return {
    ...(fxParams ? buildFxExportPayload(fxParams) : {}),
    ...(sound ?? {}),
    WISP_COUNT: params.wispCount,
    WISP_SPEED_MULTIPLIER: params.wispSpeedMultiplier,
    EMBER_COUNT: params.emberCount,
    EMBER_MOVE_TICKS: params.emberMoveTicks,
    EMBER_SPAWN_INTERVAL_SEC: params.emberSpawnIntervalSec,
    EMBER_BRANCH_CHASE_PROBABILITY: params.emberBranchChaseProbability,
    DEFAULT_REQUIRED_OCCUPANCY: params.requiredOccupancy,
    TIME_LIMIT_TICKS: timeLimitTicks,
    _notes: {
      WISP_COUNT:
        "Number of Wisps this stage. config.ts has no single constant for this — it is the current stage's wispCount in STAGE_TABLE.",
      WISP_SPEED_MULTIPLIER:
        "Effective multiplier on WISP_SPEED for the current stage. config.ts has no single constant for this — it is the current stage's wispSpeedMultiplier in STAGE_TABLE.",
      EMBER_COUNT:
        "Current live Ember count. Embers spawn dynamically in pairs (see EMBER_SPAWN_INTERVAL_SEC), capped by the current stage's maxConcurrentEmbers in STAGE_TABLE rather than a fixed config constant.",
      DEFAULT_REQUIRED_OCCUPANCY:
        "Effective required occupancy for the current stage. config.ts has no single constant for this — it is the current stage's requiredOccupancy in STAGE_TABLE (DEFAULT_REQUIRED_OCCUPANCY is stage 1's).",
      TIME_LIMIT_TICKS:
        "The run's current effective time budget, in ticks (60 tick = 1s at TICK_RATE) — matches config.ts's TIME_LIMIT_TICKS constant exactly (name and unit), unlike this payload's other stage-dependent keys. Reflects the time-limit slider above, whether or not it's been touched from its config.ts default.",
    },
  };
}

/** The impact feedback numbers, keyed by their config.ts FX_* constant names. */
function buildFxExportPayload(p: FxParams): Record<string, unknown> {
  return {
    FX_CLAIM_SHARE_MID: p.claimShareMid,
    FX_CLAIM_SHARE_LARGE: p.claimShareLarge,
    FX_HITSTOP_CLAIM_SMALL_TICKS: p.hitStopClaimSmallTicks,
    FX_HITSTOP_CLAIM_MID_TICKS: p.hitStopClaimMidTicks,
    FX_HITSTOP_CLAIM_LARGE_TICKS: p.hitStopClaimLargeTicks,
    FX_HITSTOP_SPLIT_TICKS: p.hitStopSplitTicks,
    FX_HITSTOP_MISS_TICKS: p.hitStopMissTicks,
    FX_LINE_FLASH_TICKS: p.lineFlashTicks,
    FX_FILL_REVEAL_TICKS: p.fillRevealTicks,
    FX_POPUP_TICKS: p.popupTicks,
    FX_SHAKE_SMALL: { ...p.shakeSmall },
    FX_SHAKE_MEDIUM: { ...p.shakeMedium },
    FX_SHAKE_LARGE: { ...p.shakeLarge },
    FX_MISS_FLASH_TICKS: p.missFlashTicks,
    FX_SHARD_TICKS: p.shardTicks,
    FX_SPLIT_BANNER_TICKS: p.splitBannerTicks,
    FX_SPLIT_FLASH_TICKS: p.splitFlashTicks,
    FX_SPLIT_CONFIRM_LOCK_TICKS: p.splitConfirmLockTicks,
    FX_MULTIPLIER_FLY_TICKS: p.multiplierFlyTicks,
    FX_MULTIPLIER_HIGHLIGHT_TICKS: p.multiplierHighlightTicks,
    FX_GAMEOVER_HOLD_TICKS: p.gameOverHoldTicks,
    FX_CLAIM_SHARE_HUGE: p.claimShareHuge,
    FX_TEXT_GLITCH_BANNER_TICKS: p.textGlitchBannerTicks,
    FX_TEXT_GLITCH_POPUP_TICKS: p.textGlitchPopupTicks,
    FX_POPUP_BOUNCE_SCALE: p.popupBounceScale,
    FX_POPUP_BOUNCE_TICKS: p.popupBounceTicks,
    FX_SPARK_MAX: p.sparkMax,
    FX_SPARK_TICKS: p.sparkTicks,
    FX_SPARK_DISTANCE_CELLS: p.sparkDistanceCells,
    FX_CHAIN_WINDOW_TICKS: p.chainWindowTicks,
    FX_CHAIN_PITCH_MAX_STEPS: p.chainPitchMaxSteps,
    FX_SCORE_ROLL_TICKS: p.scoreRollTicks,
    HUD_MULTIPLIER_EMPHASIS_TICKS: p.multiplierEmphasisTicks,
    STAGE_RESULT_ROLL_TICKS: p.stageResultRollTicks,
    RETRY_OFFER_WAIT_MAX_TICKS: p.retryOfferWaitMaxTicks,
    RETRY_CONFIRM_GUARD_TICKS: p.retryConfirmGuardTicks,
    FX_TEXT_MIN_DISPLAY_PX: p.fxTextMinDisplayPx,
    FX_MISS_REASON_TICKS: p.missReasonTicks,
    FX_MISS_REASON_MIN_DISPLAY_PX: p.missReasonMinDisplayPx,
    GAMEOVER_COUNT_TICKS: p.gameOverCountTicks,
    GAMEOVER_POP_TICKS: p.gameOverPopTicks,
    GAMEOVER_SPARK_TICKS: p.gameOverSparkTicks,
  };
}

type FxNumberKey = {
  [K in keyof FxParams]: FxParams[K] extends number ? K : never;
}[keyof FxParams];
type FxShakeKey = 'shakeSmall' | 'shakeMedium' | 'shakeLarge';

const FX_TICKS_RANGE = { min: 0, max: 120, step: 1 } as const;
const FX_NUMBER_FIELDS: ReadonlyArray<{ key: FxNumberKey; label: string; range: { min: number; max: number; step: number } }> = [
  { key: 'claimShareMid', label: 'Claim mid from (share)', range: { min: 0, max: 1, step: 0.01 } },
  { key: 'claimShareLarge', label: 'Claim large from (share)', range: { min: 0, max: 1, step: 0.01 } },
  { key: 'hitStopClaimSmallTicks', label: 'Stop: claim S (t)', range: FX_TICKS_RANGE },
  { key: 'hitStopClaimMidTicks', label: 'Stop: claim M (t)', range: FX_TICKS_RANGE },
  { key: 'hitStopClaimLargeTicks', label: 'Stop: claim L (t)', range: FX_TICKS_RANGE },
  { key: 'hitStopSplitTicks', label: 'Stop: split (t)', range: FX_TICKS_RANGE },
  { key: 'hitStopMissTicks', label: 'Stop: miss (t)', range: FX_TICKS_RANGE },
  { key: 'lineFlashTicks', label: 'Line flash (t)', range: FX_TICKS_RANGE },
  { key: 'fillRevealTicks', label: 'Fill reveal (t)', range: FX_TICKS_RANGE },
  { key: 'popupTicks', label: 'Popup (t)', range: FX_TICKS_RANGE },
  { key: 'missFlashTicks', label: 'Miss flash (t)', range: FX_TICKS_RANGE },
  { key: 'shardTicks', label: 'Shards (t)', range: FX_TICKS_RANGE },
  { key: 'splitBannerTicks', label: 'SPLIT! banner (t)', range: FX_TICKS_RANGE },
  { key: 'splitFlashTicks', label: 'Split flash (t)', range: FX_TICKS_RANGE },
  { key: 'splitConfirmLockTicks', label: 'Split confirm lock (t)', range: FX_TICKS_RANGE },
  { key: 'multiplierFlyTicks', label: 'Multiplier fly (t)', range: FX_TICKS_RANGE },
  { key: 'multiplierHighlightTicks', label: 'Multiplier highlight (t)', range: FX_TICKS_RANGE },
  { key: 'gameOverHoldTicks', label: 'GAME OVER hold (t)', range: FX_TICKS_RANGE },
  { key: 'claimShareHuge', label: 'AWESOME! from (share)', range: { min: 0, max: 1, step: 0.01 } },
  { key: 'textGlitchBannerTicks', label: 'SPLIT! glitch (t)', range: FX_TICKS_RANGE },
  { key: 'textGlitchPopupTicks', label: 'Popup colour split (t)', range: FX_TICKS_RANGE },
  { key: 'popupBounceScale', label: 'Popup bounce (x)', range: { min: 1, max: 3, step: 0.05 } },
  { key: 'popupBounceTicks', label: 'Popup bounce (t)', range: FX_TICKS_RANGE },
  { key: 'sparkMax', label: 'Sparks (max)', range: { min: 0, max: 100, step: 1 } },
  { key: 'sparkTicks', label: 'Sparks (t)', range: FX_TICKS_RANGE },
  { key: 'sparkDistanceCells', label: 'Sparks distance (cells)', range: { min: 0, max: 20, step: 0.5 } },
  { key: 'chainWindowTicks', label: 'Chain window (t)', range: { min: 0, max: 600, step: 1 } },
  { key: 'chainPitchMaxSteps', label: 'Chain pitch steps (max)', range: { min: 0, max: 12, step: 1 } },
  { key: 'scoreRollTicks', label: 'HUD score count-up (t)', range: FX_TICKS_RANGE },
  { key: 'multiplierEmphasisTicks', label: 'HUD multiplier emphasis (t)', range: FX_TICKS_RANGE },
  { key: 'stageResultRollTicks', label: 'Clear result count-up (t)', range: FX_TICKS_RANGE },
  { key: 'retryOfferWaitMaxTicks', label: 'Retry: ranking check wait (t)', range: { min: 0, max: 600, step: 1 } },
  { key: 'retryConfirmGuardTicks', label: 'Retry: confirm guard (t)', range: FX_TICKS_RANGE },
  { key: 'fxTextMinDisplayPx', label: 'Effect text min (CSS px)', range: { min: 0, max: 32, step: 1 } },
  { key: 'missReasonTicks', label: 'Miss reason (t)', range: { min: 0, max: 300, step: 1 } },
  { key: 'missReasonMinDisplayPx', label: 'Miss reason min (CSS px)', range: { min: 0, max: 32, step: 1 } },
  { key: 'gameOverCountTicks', label: 'GAME OVER count-up (t)', range: FX_TICKS_RANGE },
  { key: 'gameOverPopTicks', label: 'GAME OVER pop (t)', range: FX_TICKS_RANGE },
  { key: 'gameOverSparkTicks', label: 'GAME OVER sparks (t)', range: FX_TICKS_RANGE },
];
const FX_SHAKE_FIELDS: ReadonlyArray<{ key: FxShakeKey; label: string }> = [
  { key: 'shakeSmall', label: 'Shake S' },
  { key: 'shakeMedium', label: 'Shake M' },
  { key: 'shakeLarge', label: 'Shake L' },
];

/** A made-up line down the middle of the field, for the TEST buttons. */
function testLine(session: GameSession, fromY = 1): Point[] {
  const field = session.getGame().getField();
  const x = Math.floor(field.getWidth() / 2);
  const line: Point[] = [];
  for (let y = fromY; y < field.getHeight() - 1; y++) line.push({ x, y });
  return line;
}

/**
 * The FX section: one slider per fxParams value (applied from the next
 * effect) and TEST buttons that fire a claim (small / mid / large), a split
 * or a miss straight into the director, the hit stop and the sounds, with
 * made-up notices. The session is only read (for the field size, marker and
 * multiplier), never changed.
 */
function buildFxSection(getSession: () => GameSession, hooks: DebugFxHooks): HTMLDivElement {
  const section = document.createElement('div');
  section.id = 'debug-fx-section';
  section.style.marginTop = '10px';
  section.style.paddingTop = '8px';
  section.style.borderTop = '1px solid rgba(255, 224, 102, 0.4)';

  const heading = document.createElement('div');
  heading.textContent = 'FX';
  heading.style.fontWeight = 'bold';
  heading.style.color = '#ffe066';
  heading.style.marginBottom = '6px';
  section.appendChild(heading);

  const buttons = document.createElement('div');
  buttons.style.display = 'flex';
  buttons.style.flexWrap = 'wrap';
  buttons.style.gap = '4px';
  buttons.style.marginBottom = '8px';

  const fireClaim = (share: number, areaScore: number): void => {
    const session = getSession();
    const notice: ClaimFeedback = {
      claimedCells: 0,
      occupancyBefore: 0,
      occupancyAfter: share,
      lineSpeed: 'fast',
      areaScore,
      stageClearBonus: 0,
      multiplier: session.getMultiplier(),
      split: false,
      stageCleared: false,
      closedLine: testLine(session),
    };
    // Pressed again within the chain window, the test claims chain like real
    // ones: CHAIN xN under the popup and a rising claim sound.
    const { hitStopTicks, chain } = hooks.fx.onClaim(notice, { nextMultiplier: session.getMultiplier() });
    hooks.hitStop.request(hitStopTicks);
    hooks.playClaim({ share, speed: 'fast', chain });
  };
  const addTest = (id: string, label: string, onClick: () => void): void => {
    const button = buildButton(label, onClick);
    button.id = id;
    button.style.flex = '1 1 30%';
    buttons.appendChild(button);
  };
  addTest('debug-fx-test-claim-s', 'TEST CLAIM S', () => fireClaim(0.02, 120));
  addTest('debug-fx-test-claim-m', 'TEST CLAIM M', () => fireClaim(0.1, 600));
  addTest('debug-fx-test-claim-l', 'TEST CLAIM L', () => fireClaim(0.3, 1800));
  addTest('debug-fx-test-split', 'TEST SPLIT', () => {
    const session = getSession();
    const notice: ClaimFeedback = {
      claimedCells: 0,
      occupancyBefore: 0,
      occupancyAfter: 0.05,
      lineSpeed: 'fast',
      areaScore: 0,
      stageClearBonus: 0,
      multiplier: session.getMultiplier(),
      split: true,
      stageCleared: true,
      closedLine: testLine(session),
    };
    const next = Math.min(session.getMultiplier() + 1, SPLIT_MULTIPLIER_CAP);
    hooks.hitStop.request(hooks.fx.onClaim(notice, { nextMultiplier: next }).hitStopTicks);
    hooks.playSplitImpact();
  });
  addTest('debug-fx-test-miss', 'TEST MISS', () => {
    const session = getSession();
    const line = testLine(session, 1).slice(0, 30);
    const notice: MissFeedback = {
      cause: 'wisp',
      position: line.length > 0 ? line[line.length - 1] : session.getGame().getMarker().getPosition(),
      line,
    };
    // With its reason, so the reason's length and size can be tuned from here.
    hooks.hitStop.request(hooks.fx.onMiss(notice, { gameOver: false, reason: t('miss.wisp') }).hitStopTicks);
    hooks.playMiss();
  });
  section.appendChild(buttons);

  for (const field of FX_NUMBER_FIELDS) {
    const format = (v: number): string => (field.range.step < 1 ? v.toFixed(2) : String(v));
    const { row, input, readout } = buildRawSliderRow(field.label, field.range, format, (v) => {
      hooks.params[field.key] = v;
    });
    input.id = `debug-fx-${field.key}`;
    input.value = String(hooks.params[field.key]);
    readout.textContent = format(hooks.params[field.key]);
    section.appendChild(row);
  }
  for (const field of FX_SHAKE_FIELDS) {
    const ticks = buildRawSliderRow(`${field.label} (t)`, FX_TICKS_RANGE, String, (v) => {
      hooks.params[field.key] = { ...hooks.params[field.key], ticks: v };
    });
    ticks.input.id = `debug-fx-${field.key}-ticks`;
    ticks.input.value = String(hooks.params[field.key].ticks);
    ticks.readout.textContent = String(hooks.params[field.key].ticks);
    section.appendChild(ticks.row);
    const amplitude = buildRawSliderRow(`${field.label} (px, ${hooks.params[field.key].axes})`, { min: 0, max: 20, step: 0.5 }, String, (v) => {
      hooks.params[field.key] = { ...hooks.params[field.key], amplitudePx: v };
    });
    amplitude.input.id = `debug-fx-${field.key}-amplitude`;
    amplitude.input.value = String(hooks.params[field.key].amplitudePx);
    amplitude.readout.textContent = String(hooks.params[field.key].amplitudePx);
    section.appendChild(amplitude.row);
  }
  return section;
}

/** Groups `items` into lines of `perLine`, each joined by two spaces. */
/** The SOUND TEST buttons, each playing one sound by itself (no effect). */
export const SOUND_TEST_BUTTONS = [
  { id: 'claim-small', label: 'CLAIM S' },
  { id: 'claim-mid', label: 'CLAIM M' },
  { id: 'claim-large', label: 'CLAIM L' },
  { id: 'split', label: 'SPLIT' },
  { id: 'miss', label: 'MISS' },
  { id: 'stage-clear', label: 'STAGE CLEAR' },
  { id: 'gameover-life', label: 'GAME OVER' },
  { id: 'gameover-time', label: 'TIME UP' },
  { id: 'count', label: 'COUNT' },
  { id: 'new-record', label: 'NEW RECORD' },
  { id: 'alarm', label: 'ALARM' },
  { id: 'beep', label: 'BEEP' },
  { id: 'beep-high', label: 'BEEP HI' },
  { id: 'igniter-spawn', label: 'IGNITER' },
  { id: 'igniter-approach', label: 'APPROACH' },
  { id: 'ember-spawn', label: 'EMBER' },
  { id: 'blaze-spawn', label: 'BLAZE' },
  { id: 'ember-line', label: 'EMBER LINE' },
  { id: 'ember-out', label: 'EMBER OUT' },
  { id: 'draw', label: 'DRAW' },
] as const;

export type SoundTestId = (typeof SOUND_TEST_BUTTONS)[number]['id'];

/**
 * What the panel's SOUND section works on: the live sound levels it tunes
 * and the sound test. None of it goes through the session's debug overrides,
 * so using it never taints the run, never starts one and is never a game
 * input.
 */
export interface DebugSoundHooks {
  levels: SfxLevels;
  /** Applies `levels.master` to the master gain at once. */
  applyMaster: () => void;
  /** Plays one sound by itself (nothing while muted). */
  play: (id: SoundTestId) => void;
  /**
   * The music's switch and level (on, and 1, on every page load): the level
   * is a factor on every tune's own gain (BGM_GAIN_TENSE / ACID / HUNT).
   */
  bgm?: {
    isEnabled: () => boolean;
    setEnabled: (on: boolean) => void;
    getLevel: () => number;
    setLevel: (level: number) => void;
  };
}

const SOUND_LEVEL_FIELDS: ReadonlyArray<{ key: keyof SfxLevels; label: string; exportKey: string }> = [
  { key: 'master', label: 'Master', exportKey: 'SFX_MASTER_GAIN' },
  { key: 'split', label: 'Split', exportKey: 'SFX_LEVEL_SPLIT' },
  { key: 'impact', label: 'Impact', exportKey: 'SFX_LEVEL_IMPACT' },
  { key: 'warning', label: 'Warning', exportKey: 'SFX_LEVEL_WARNING' },
  { key: 'enemy', label: 'Enemy', exportKey: 'SFX_LEVEL_ENEMY' },
  { key: 'draw', label: 'Draw', exportKey: 'SFX_LEVEL_DRAW' },
];
const SOUND_LEVEL_RANGE = { min: 0, max: 0.5, step: 0.01 } as const;
// The music's level: a factor on all three tunes' own gains.
const BGM_LEVEL_RANGE = { min: 0, max: 3, step: 0.05 } as const;
const BGM_LEVEL_DEFAULT = 1;
const BGM_TRACK_GAIN_KEYS: ReadonlyArray<[string, number]> = [
  ['BGM_GAIN_TENSE', BGM_GAIN_TENSE],
  ['BGM_GAIN_ACID', BGM_GAIN_ACID],
  ['BGM_GAIN_HUNT', BGM_GAIN_HUNT],
];

/**
 * The SOUND section: a slider per sound level (the master applies at once,
 * a tier from its next sound), the music's switch and level, and the
 * SOUND TEST buttons. RESET puts the levels back; EXPORT adds them under
 * their config.ts names.
 */
function buildSoundSection(hooks: DebugSoundHooks): {
  section: HTMLDivElement;
  reset: () => void;
  exportPayload: () => Record<string, number>;
} {
  const section = document.createElement('div');
  section.id = 'debug-sound-section';
  section.style.marginTop = '10px';
  section.style.paddingTop = '8px';
  section.style.borderTop = '1px solid rgba(255, 224, 102, 0.4)';

  const heading = document.createElement('div');
  heading.textContent = 'SOUND';
  heading.style.fontWeight = 'bold';
  heading.style.color = '#ffe066';
  heading.style.marginBottom = '6px';
  section.appendChild(heading);

  const format = (v: number): string => v.toFixed(2);
  const rows: Array<{ key: keyof SfxLevels; input: HTMLInputElement; readout: HTMLSpanElement }> = [];
  for (const field of SOUND_LEVEL_FIELDS) {
    const { row, input, readout } = buildRawSliderRow(field.label, SOUND_LEVEL_RANGE, format, (v) => {
      hooks.levels[field.key] = v;
      if (field.key === 'master') hooks.applyMaster();
    });
    input.id = `debug-sound-${field.key}`;
    rows.push({ key: field.key, input, readout });
    section.appendChild(row);
  }
  const sync = (): void => {
    for (const row of rows) {
      row.input.value = String(hooks.levels[row.key]);
      row.readout.textContent = format(hooks.levels[row.key]);
    }
  };
  sync();

  // The music: a switch (to silence it alone while developing) and its level.
  const bgm = hooks.bgm;
  const bgmFormat = (v: number): string => `x${v.toFixed(2)}`;
  let bgmLevel: { input: HTMLInputElement; readout: HTMLSpanElement } | null = null;
  if (bgm) {
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '6px';
    label.style.margin = '4px 0 6px';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'debug-bgm-enabled';
    toggle.checked = bgm.isEnabled();
    toggle.addEventListener('change', () => {
      bgm.setEnabled(toggle.checked);
      toggle.blur();
    });
    label.appendChild(toggle);
    label.appendChild(document.createTextNode('BGM (not saved)'));
    section.appendChild(label);
    const { row, input, readout } = buildRawSliderRow('BGM', BGM_LEVEL_RANGE, bgmFormat, (v) => bgm.setLevel(v));
    input.id = 'debug-sound-bgm';
    input.value = String(bgm.getLevel());
    readout.textContent = bgmFormat(bgm.getLevel());
    bgmLevel = { input, readout };
    section.appendChild(row);
  }

  const testHeading = document.createElement('div');
  testHeading.textContent = 'SOUND TEST';
  testHeading.style.color = '#ffe066';
  testHeading.style.margin = '6px 0 4px';
  section.appendChild(testHeading);
  const buttons = document.createElement('div');
  buttons.id = 'debug-sound-test';
  buttons.style.display = 'flex';
  buttons.style.flexWrap = 'wrap';
  buttons.style.gap = '4px';
  for (const test of SOUND_TEST_BUTTONS) {
    // Blurred after the press, so a later Space / Enter meant for the game
    // does not press it again.
    const button = buildButton(test.label, () => {
      hooks.play(test.id);
      button.blur();
    });
    button.id = `debug-sound-test-${test.id}`;
    button.style.flex = '1 1 30%';
    buttons.appendChild(button);
  }
  section.appendChild(buttons);

  return {
    section,
    reset: () => {
      resetSfxLevels();
      hooks.applyMaster();
      sync();
      if (bgm && bgmLevel) {
        bgm.setLevel(BGM_LEVEL_DEFAULT);
        bgmLevel.input.value = String(BGM_LEVEL_DEFAULT);
        bgmLevel.readout.textContent = bgmFormat(BGM_LEVEL_DEFAULT);
      }
    },
    // The tunes' gains with the factor applied, rounded off the float noise
    // of the product (0.18 x 1.5 gives 0.27, not 0.27000000000000002).
    exportPayload: () => ({
      ...Object.fromEntries(SOUND_LEVEL_FIELDS.map((f) => [f.exportKey, hooks.levels[f.key]])),
      ...(bgm ? Object.fromEntries(BGM_TRACK_GAIN_KEYS.map(([key, gain]) => [key, Number((gain * bgm.getLevel()).toFixed(4))])) : {}),
    }),
  };
}

function chunkLines(items: string[], perLine: number, indent: string): string[] {
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += perLine) lines.push(indent + items.slice(i, i + perLine).join('  '));
  return lines;
}

/** The PLAY LOG summary as fixed English text, one item per line or block. */
export function playLogSummaryText(file: PlayLogFile): string {
  const runs = file.runs;
  if (runs.length === 0) return 'NO RUNS YET';
  const s = summarizePlayLog(runs);
  const lines = [
    `RUNS ${s.runs} / ${PLAY_LOG_MAX_RUNS}`,
    'END STAGE',
    ...chunkLines(s.endByStage.map((e) => `ST${e.stage} ${e.runs}`), 4, '  '),
    `END BY  LIFE ${s.endReasons.life}  TIME ${s.endReasons.time}`,
    'MISSES',
  ];
  for (const m of s.missesByStage) {
    lines.push(`  ST${m.stage}  (runs ${m.runs})`);
    lines.push(`    WISP ${m.misses.wisp}  EMBER ${m.misses.ember}  IGNITER ${m.misses.igniter}`);
  }
  lines.push('SCORE', `  AVG ${s.score.average}  MED ${s.score.median}  MAX ${s.score.max}`);
  lines.push('PER RUN', `  CLAIMS ${s.claimsPerRun.toFixed(1)}  SPLITS ${s.splitsPerRun.toFixed(1)}`);
  lines.push(`STREAK ≤ ST${PLAY_LOG_STREAK_STAGE}  ${trailingRunsAtOrBelow(runs, PLAY_LOG_STREAK_STAGE)}`);
  return lines.join('\n');
}

/**
 * The PLAY LOG section: the summary of the runs kept on this device, EXPORT
 * LOG (the stored `{ v: 1, runs }` as JSON, into the panel's output box and
 * the clipboard) and CLEAR LOG (no confirmation: a dev panel). Returns the
 * section and a function redrawing its summary.
 */
function buildPlayLogSection(hooks: DebugPlayLogHooks, exportOutput: HTMLTextAreaElement): { section: HTMLDivElement; render: () => void } {
  const section = document.createElement('div');
  section.id = 'debug-play-log';
  section.style.marginTop = '10px';
  section.style.paddingTop = '8px';
  section.style.borderTop = '1px solid rgba(255, 224, 102, 0.4)';

  const heading = document.createElement('div');
  heading.textContent = 'PLAY LOG';
  heading.style.fontWeight = 'bold';
  heading.style.color = '#ffe066';
  heading.style.marginBottom = '6px';
  section.appendChild(heading);

  const summary = document.createElement('div');
  summary.id = 'debug-play-log-summary';
  summary.style.font = '10px monospace';
  summary.style.lineHeight = '1.4';
  summary.style.color = '#00ff41';
  summary.style.whiteSpace = 'pre-wrap';
  summary.style.overflowWrap = 'anywhere';
  summary.style.marginBottom = '8px';
  section.appendChild(summary);

  const render = (): void => {
    summary.textContent = playLogSummaryText(hooks.getFile());
  };

  const buttons = document.createElement('div');
  buttons.style.display = 'flex';
  buttons.style.gap = '6px';
  // Each blurs itself after a click, so a later Enter or Space for the game
  // does not press it again.
  const exportButton = buildButton('EXPORT LOG', () => {
    const json = JSON.stringify(hooks.getFile(), null, 2);
    exportOutput.value = json;
    void copyToClipboard(json);
    exportButton.blur();
  });
  exportButton.id = 'debug-play-log-export';
  const clearButton = buildButton('CLEAR LOG', () => {
    hooks.clear();
    render();
    clearButton.blur();
  });
  clearButton.id = 'debug-play-log-clear';
  buttons.appendChild(exportButton);
  buttons.appendChild(clearButton);
  section.appendChild(buttons);

  hooks.onChange(render);
  render();
  return { section, render };
}

/**
 * Handle returned by initDebugPanel() for a caller to re-sync the panel's
 * sliders if it ever swaps the `GameSession` instance the `getSession`
 * getter passed to initDebugPanel() resolves to (P2 user-review fix,
 * 2026-08-11 — see initDebugPanel()'s doc comment for the full rationale).
 * No current caller does this (main.ts builds `session` once in init() and
 * never reconstructs it), so `refresh` currently goes unused, but the hook
 * stays correct for free if session-swapping is ever reintroduced.
 */
export interface DebugPanelHandle {
  /**
   * Re-syncs every slider's displayed value (and readout text) from
   * whatever `getSession()` currently returns. Would need to be called
   * right after a caller swaps the session `getSession()` resolves to, for
   * a new GameSession instance — the panel's own slider *actions* already
   * always affect whatever `getSession()` currently returns (see
   * initDebugPanel()'s doc comment), but the displayed positions would
   * otherwise still show the previous session's last values until the
   * player touches a slider again. Currently unused, since no caller swaps
   * sessions today.
   */
  refresh: () => void;
}

/**
 * Mounts the debug panel into the page: a "DEBUG" badge/toggle in the HUD
 * row (docs/plan.md §6 M10: "パネル表示中は HUD などに「DEBUG」表示を出す")
 * and a floating, collapsible control panel with one slider per tunable,
 * plus RESET/EXPORT.
 *
 * Takes a `getSession` *getter*, not a `GameSession` instance directly (P2
 * user-review fix, 2026-08-11). At the time, main.ts could swap its own
 * `session` module variable out for a brand-new GameSession mid-page-load
 * (the since-removed DAILY-challenge feature's Title button, plus `?seed=`
 * / falling back to a fresh normal run — see commit 58f2f3a, which dropped
 * that swapping machinery entirely). A plain `session: GameSession`
 * parameter here would have closed over whichever instance existed at
 * `?debug` load time and kept operating on it forever — every slider drag
 * after a swap would silently apply to (and read
 * `hasActiveDebugOverrides()` from) a discarded session, never reaching the
 * real, currently-playing one, and — because the *real* session's
 * `hasActiveDebugOverrides()` would then always read false — never
 * suppressing high-score persistence the way active overrides are supposed
 * to. Calling `getSession()` fresh every time instead means every panel
 * action always targets whatever session is actually live right now.
 *
 * That session-swapping no longer happens today — main.ts now constructs
 * `session` exactly once in init() and never reconstructs it — so the
 * getter is currently equivalent to a plain captured reference. It's kept
 * as a getter anyway since it's harmless either way and stays correct for
 * free should session-swapping ever be reintroduced.
 */
export function initDebugPanel(
  getSession: () => GameSession,
  hudRow: HTMLElement,
  fxHooks?: DebugFxHooks,
  // RESET HINTS: forgets which in-play hints this device has seen (saved and
  // in memory), so the next play shows them again. Display only — not a
  // debug override, the run is untouched.
  resetHints?: () => void,
  // PLAY LOG: the runs kept on this device, summarized, exported and cleared.
  playLogHooks?: DebugPlayLogHooks,
  // SOUND: the sound levels and the sound test (and the music).
  soundHooks?: DebugSoundHooks
): DebugPanelHandle {
  // Collapsible (2026-07-07 feedback: the panel sat on top of the field and
  // got in the way of actually playing). The badge itself doubles as the
  // open/close toggle — one click re-opens a collapsed panel just as easily
  // as it collapses an open one — and the panel also gets its own "x" for
  // closing without reaching back up for the (smaller) badge. Purely a
  // display toggle: collapsing never touches applyDebugOverrides/
  // resetDebugOverrides, so whatever overrides are already active keep
  // affecting the game while the panel is hidden. Open/closed state is
  // in-memory only (no product need for it to survive a reload) and always
  // starts open.
  let isOpen = true;
  const setOpen = (open: boolean): void => {
    isOpen = open;
    panel.style.display = isOpen ? 'block' : 'none';
    badge.textContent = `DEBUG ${isOpen ? '▾' : '▸'}`; // open / closed caret
    if (isOpen) renderPlayLog();
  };

  const badge = buildDebugBadge(() => setOpen(!isOpen));
  const { panel, sync, renderPlayLog } = buildPanel(
    getSession,
    () => setOpen(false),
    fxHooks,
    resetHints,
    playLogHooks,
    soundHooks
  );
  hudRow.appendChild(badge);
  document.body.appendChild(panel);
  setOpen(true);

  // Position tracking (P3 review fix, docs/plans/2026-08-13-time-limit-mode:
  // user-measured overlap at both 1280x720 and 880x700 — panel top 36-39px
  // vs. the actual HUD row bottom at 54px). The panel used to be positioned
  // once, synchronously, right here — using hudRow's rect from *before* the
  // badge above was even appended to it (which can itself grow hudRow, e.g.
  // by pushing a borderline single-line HUD into stacked/3-line mode) and
  // before main.ts's own post-mount fitCanvasToViewport() re-run (see
  // main.ts's init(), right after this function's caller) had a chance to
  // relay it out again.
  const repositionPanel = (): void => {
    const top = hudRow.getBoundingClientRect().bottom + 8;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `calc(100vh - ${top + 8}px)`;
  };
  repositionPanel(); // best-effort immediate placement — the listeners below catch any layout pass this misses

  // A ResizeObserver on hudRow fires whenever hudRow's own *box* changes
  // (a single/stacked HUD mode flip, the DEBUG badge or MUTE label changing
  // hudRow's width) — but a height-only viewport resize (P3 follow-up review
  // fix) can move hudRow's on-screen *position* without changing hudRow's
  // own size at all: #game-root re-centers its flex children vertically
  // (main.ts's getGameRootElement()) as the canvas shrinks/grows to fit the
  // new height, sliding hudRow up or down while its box stays the same
  // size — a case the ResizeObserver alone never fires for. window's own
  // resize/orientationchange events (the same ones main.ts's own
  // fitCanvasToViewport() already listens for, see init()) catch that: by
  // the time this listener runs, main.ts's — registered first, during
  // init(), before this dynamically-imported module ever loads — has
  // already re-laid out the canvas/hudRow for the new size, so hudRow's
  // rect read here is already the final one. Neither listener alone is
  // sufficient (each catches a case the other doesn't) and neither ever
  // polls every frame.
  window.addEventListener('resize', repositionPanel);
  window.addEventListener('orientationchange', repositionPanel);
  new ResizeObserver(repositionPanel).observe(hudRow);

  return { refresh: sync };
}

function buildDebugBadge(onToggle: () => void): HTMLButtonElement {
  const badge = document.createElement('button');
  badge.id = 'debug-badge';
  badge.type = 'button';
  badge.title = 'Toggle the debug panel';
  badge.style.flex = '0 0 auto';
  badge.style.font = 'bold 11px monospace';
  badge.style.color = '#0a0e27';
  badge.style.background = '#ffe066';
  badge.style.border = 'none';
  badge.style.padding = '2px 6px';
  badge.style.borderRadius = '3px';
  badge.style.pointerEvents = 'auto';
  badge.style.cursor = 'pointer';
  badge.style.userSelect = 'none';
  badge.addEventListener('click', onToggle);
  return badge;
}

function buildPanel(
  getSession: () => GameSession,
  onClose: () => void,
  fxHooks?: DebugFxHooks,
  resetHints?: () => void,
  playLogHooks?: DebugPlayLogHooks,
  soundHooks?: DebugSoundHooks
): { panel: HTMLDivElement; sync: () => void; renderPlayLog: () => void } {
  // SOUND: built up front so RESET and EXPORT (above it on the panel) can reach it.
  const soundSection = soundHooks ? buildSoundSection(soundHooks) : null;
  const panel = document.createElement('div');
  panel.id = 'debug-panel';
  panel.style.position = 'fixed';
  // `top`/`maxHeight` are deliberately left unset here — they depend on
  // hudRow's on-screen bottom edge, which isn't stable yet at build time
  // (docs/plans/2026-08-13-time-limit-mode P3 review fix); initDebugPanel()
  // sets both, and keeps them in sync afterward, via its repositionPanel().
  panel.style.right = '8px';
  panel.style.zIndex = '1000';
  panel.style.width = '260px';
  panel.style.overflowY = 'auto';
  panel.style.background = 'rgba(10, 14, 39, 0.92)';
  panel.style.border = '1px solid #ffe066';
  panel.style.borderRadius = '6px';
  panel.style.padding = '10px';
  panel.style.font = '11px monospace';
  panel.style.color = '#ffffff';
  panel.style.pointerEvents = 'auto';
  panel.style.userSelect = 'none';

  const titleRow = document.createElement('div');
  titleRow.style.display = 'flex';
  titleRow.style.alignItems = 'center';
  titleRow.style.justifyContent = 'space-between';
  titleRow.style.marginBottom = '8px';

  const title = document.createElement('span');
  title.textContent = 'DEBUG PANEL (dev only)';
  title.style.fontWeight = 'bold';
  title.style.color = '#ffe066';
  titleRow.appendChild(title);

  // Closes the panel without touching any override (docs/plan.md §6 M11
  // orchestration follow-up: "閉じてもオーバーライドの効果は維持される") —
  // re-opening is one click on the HUD badge (see initDebugPanel).
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '×';
  closeButton.title = 'Close (overrides stay active)';
  closeButton.style.flex = '0 0 auto';
  closeButton.style.font = 'bold 13px monospace';
  closeButton.style.color = '#ffe066';
  closeButton.style.background = 'transparent';
  closeButton.style.border = 'none';
  closeButton.style.cursor = 'pointer';
  closeButton.style.lineHeight = '1';
  closeButton.style.padding = '0 2px';
  closeButton.addEventListener('click', onClose);
  titleRow.appendChild(closeButton);

  panel.appendChild(titleRow);

  const rows = new Map<keyof EffectiveDebugParams, { input: HTMLInputElement; readout: HTMLSpanElement }>();

  // Reads from `getSession()` fresh every call (not a captured `session`)
  // so a session swap would be picked up automatically if one were ever
  // reintroduced — see initDebugPanel()'s doc comment. Exported as this
  // panel's `sync` (DebugPanelHandle.refresh(), currently unused since no
  // caller swaps sessions today — see that interface's doc comment), for a
  // future caller to invoke right after swapping sessions so the sliders'
  // *displayed* values would catch up to the new session's own (fresh,
  // override-free) defaults immediately, rather than silently showing the
  // discarded session's last values until the player happens to touch a
  // slider again.
  const syncFromEffectiveParams = (): void => {
    const params = getSession().getEffectiveDebugParams();
    for (const field of FIELDS) {
      const row = rows.get(field.key);
      if (!row) continue;
      const sliderValue = field.toSlider(params[field.key]);
      row.input.value = String(sliderValue);
      row.readout.textContent = field.format(params[field.key]);
    }
  };

  for (const field of FIELDS) {
    const { row, input, readout } = buildSliderRow(field, (sliderValue) => {
      getSession().applyDebugOverrides({
        [field.overrideKey]: field.fromSlider(sliderValue),
      } as Partial<DebugOverrides>);
      readout.textContent = field.format(field.fromSlider(sliderValue));
    });
    rows.set(field.key, { input, readout });
    panel.appendChild(row);
  }

  // Time limit (docs/plans/2026-08-13-time-limit-mode): a session-level
  // concern (GameSession.setDebugTimeLimitTicks()), not one of Game's own
  // EffectiveDebugParams — kept out of the FIELDS/rows machinery above
  // (which is keyed off EffectiveDebugParams) and wired up directly instead.
  // Displayed/entered in whole seconds; converted to/from ticks (TICK_RATE)
  // at the boundary.
  const timeLimit = buildRawSliderRow(
    'Time limit (s)',
    RANGES.timeLimitSec,
    (v) => `${v}s`,
    (sliderValueSec) => {
      getSession().setDebugTimeLimitTicks(sliderValueSec * TICK_RATE);
      timeLimit.readout.textContent = `${sliderValueSec}s`;
    }
  );
  // Stable id (docs/plans/2026-08-13-time-limit-mode) so E2E coverage can
  // locate this specific slider directly — the other FIELDS-driven sliders
  // above have no id of their own (nothing has previously needed to target
  // one individually), but this one's the E2E suite's fastest real-time path
  // to a TIME UP! gameover (shrinking the budget down from its 5s minimum).
  timeLimit.input.id = 'debug-time-limit-input';
  panel.appendChild(timeLimit.row);

  const syncTimeLimitRow = (): void => {
    const seconds = Math.round(getSession().getTimeLimitTicks() / TICK_RATE);
    timeLimit.input.value = String(seconds);
    timeLimit.readout.textContent = `${seconds}s`;
  };

  const syncAll = (): void => {
    syncFromEffectiveParams();
    syncTimeLimitRow();
  };

  syncAll();

  const buttonRow = document.createElement('div');
  buttonRow.style.display = 'flex';
  buttonRow.style.gap = '6px';
  buttonRow.style.marginTop = '8px';

  const resetButton = buildButton('RESET', () => {
    getSession().resetDebugOverrides();
    syncAll();
    soundSection?.reset();
    exportOutput.value = '';
  });
  const exportButton = buildButton('EXPORT', () => {
    const session = getSession();
    const payload = buildExportPayload(
      session.getEffectiveDebugParams(),
      session.getTimeLimitTicks(),
      fxHooks?.params,
      soundSection?.exportPayload()
    );
    const json = JSON.stringify(payload, null, 2);
    exportOutput.value = json;
    void copyToClipboard(json);
  });
  buttonRow.appendChild(resetButton);
  buttonRow.appendChild(exportButton);
  if (resetHints) buttonRow.appendChild(buildButton('RESET HINTS', resetHints));
  panel.appendChild(buttonRow);

  const exportOutput = document.createElement('textarea');
  exportOutput.id = 'debug-export-output';
  exportOutput.readOnly = true;
  exportOutput.placeholder = 'EXPORT JSON appears here (also copied to clipboard)';
  exportOutput.style.width = '100%';
  exportOutput.style.marginTop = '8px';
  exportOutput.style.height = '160px';
  exportOutput.style.background = 'rgba(0, 0, 0, 0.5)';
  exportOutput.style.color = '#00ff41';
  exportOutput.style.border = '1px solid rgba(255, 255, 255, 0.2)';
  exportOutput.style.font = '10px monospace';
  exportOutput.style.boxSizing = 'border-box';
  exportOutput.style.resize = 'vertical';
  panel.appendChild(exportOutput);

  if (fxHooks) {
    panel.appendChild(buildFxSection(getSession, fxHooks));
  }
  if (soundSection) panel.appendChild(soundSection.section);

  let renderPlayLog = (): void => {};
  if (playLogHooks) {
    const playLogSection = buildPlayLogSection(playLogHooks, exportOutput);
    panel.appendChild(playLogSection.section);
    renderPlayLog = playLogSection.render;
  }

  return { panel, sync: syncAll, renderPlayLog };
}

function buildSliderRow(
  field: SliderField,
  onChange: (sliderValue: number) => void
): { row: HTMLDivElement; input: HTMLInputElement; readout: HTMLSpanElement } {
  return buildRawSliderRow(field.label, field.range, (v) => field.format(field.fromSlider(v)), onChange);
}

/**
 * Lower-level slider-row builder underlying buildSliderRow() above, taking a
 * plain label/range/format instead of a `SliderField` — used directly by the
 * time-limit slider (docs/plans/2026-08-13-time-limit-mode), which has no
 * `EffectiveDebugParams` key to key a `SliderField` off (it's a session-level
 * concern, see buildPanel()'s `timeLimit` row).
 */
function buildRawSliderRow(
  label: string,
  range: { min: number; max: number; step: number },
  format: (sliderValue: number) => string,
  onChange: (sliderValue: number) => void
): { row: HTMLDivElement; input: HTMLInputElement; readout: HTMLSpanElement } {
  const row = document.createElement('div');
  row.style.marginBottom = '6px';

  const labelRow = document.createElement('div');
  labelRow.style.display = 'flex';
  labelRow.style.justifyContent = 'space-between';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const readout = document.createElement('span');
  readout.style.color = '#00ff41';
  labelRow.appendChild(labelEl);
  labelRow.appendChild(readout);
  row.appendChild(labelRow);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(range.step);
  input.style.width = '100%';
  input.addEventListener('input', () => {
    const value = Number(input.value);
    readout.textContent = format(value);
    onChange(value);
  });
  row.appendChild(input);

  return { row, input, readout };
}

function buildButton(text: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.style.flex = '1 1 auto';
  button.style.font = 'bold 11px monospace';
  button.style.color = '#ffe066';
  button.style.background = 'rgba(10, 14, 39, 0.7)';
  button.style.border = '1px solid #ffe066';
  button.style.borderRadius = '4px';
  button.style.padding = '4px 6px';
  button.style.cursor = 'pointer';
  button.addEventListener('click', onClick);
  return button;
}

/** Best-effort clipboard copy — silently no-ops if the Clipboard API is unavailable (e.g. insecure context). */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best-effort only — the JSON is still visible in the textarea for manual copy.
  }
}
