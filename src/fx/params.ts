// The run-time tunable numbers of the impact feedback (hit stop, fill reveal,
// popup, flashes, shakes, shards, split banner, the text glitch and bounce,
// sparks, claim chains and the HUD score count-up), plus the HUD multiplier
// emphasis, the STAGE CLEAR result count-up, the GAME OVER retry waits, the
// effects' smallest on-screen text size and the miss reason's length and
// smallest on-screen size, the stage title's and the claim tags' lengths, and
// the GAME OVER result's count-up, pop and
// sparks. Starts from src/config.ts's
// FX_* constants; the dev-only debug panel changes `fxParams` in place, and
// FxDirector reads it on every new effect, so a change applies from the next
// claim/split/miss. Nothing here touches src/core/ or the simulation.
import {
  FX_CLAIM_SHARE_MID,
  FX_CLAIM_SHARE_LARGE,
  FX_HITSTOP_CLAIM_SMALL_TICKS,
  FX_HITSTOP_CLAIM_MID_TICKS,
  FX_HITSTOP_CLAIM_LARGE_TICKS,
  FX_HITSTOP_SPLIT_TICKS,
  FX_HITSTOP_MISS_TICKS,
  FX_LINE_FLASH_TICKS,
  FX_FILL_REVEAL_TICKS,
  FX_POPUP_TICKS,
  FX_SHAKE_SMALL,
  FX_SHAKE_MEDIUM,
  FX_SHAKE_LARGE,
  FX_MISS_FLASH_TICKS,
  FX_SHARD_TICKS,
  FX_SPLIT_BANNER_TICKS,
  FX_SPLIT_FLASH_TICKS,
  FX_SPLIT_CONFIRM_LOCK_TICKS,
  FX_MULTIPLIER_FLY_TICKS,
  FX_MULTIPLIER_HIGHLIGHT_TICKS,
  FX_GAMEOVER_HOLD_TICKS,
  FX_CLAIM_SHARE_HUGE,
  FX_TEXT_GLITCH_BANNER_TICKS,
  FX_TEXT_GLITCH_POPUP_TICKS,
  FX_POPUP_BOUNCE_SCALE,
  FX_POPUP_BOUNCE_TICKS,
  FX_SPARK_MAX,
  FX_SPARK_TICKS,
  FX_SPARK_DISTANCE_CELLS,
  FX_CHAIN_WINDOW_TICKS,
  FX_CHAIN_PITCH_MAX_STEPS,
  FX_SCORE_ROLL_TICKS,
  HUD_MULTIPLIER_EMPHASIS_TICKS,
  STAGE_RESULT_ROLL_TICKS,
  RETRY_OFFER_WAIT_MAX_TICKS,
  RETRY_CONFIRM_GUARD_TICKS,
  FX_TEXT_MIN_DISPLAY_PX,
  FX_MISS_REASON_TICKS,
  FX_MISS_REASON_MIN_DISPLAY_PX,
  FX_STAGE_TITLE_TICKS,
  FX_CLAIM_TAG_TICKS,
  GAMEOVER_COUNT_TICKS,
  GAMEOVER_POP_TICKS,
  GAMEOVER_SPARK_TICKS,
  FxShakeSpec,
} from '../config';
import { t, type MessageKey } from '../i18n';

export type { FxShakeSpec };

export interface FxParams {
  claimShareMid: number;
  claimShareLarge: number;
  hitStopClaimSmallTicks: number;
  hitStopClaimMidTicks: number;
  hitStopClaimLargeTicks: number;
  hitStopSplitTicks: number;
  hitStopMissTicks: number;
  lineFlashTicks: number;
  fillRevealTicks: number;
  popupTicks: number;
  shakeSmall: FxShakeSpec;
  shakeMedium: FxShakeSpec;
  shakeLarge: FxShakeSpec;
  missFlashTicks: number;
  shardTicks: number;
  splitBannerTicks: number;
  splitFlashTicks: number;
  splitConfirmLockTicks: number;
  multiplierFlyTicks: number;
  multiplierHighlightTicks: number;
  gameOverHoldTicks: number;
  claimShareHuge: number;
  textGlitchBannerTicks: number;
  textGlitchPopupTicks: number;
  popupBounceScale: number;
  popupBounceTicks: number;
  sparkMax: number;
  sparkTicks: number;
  sparkDistanceCells: number;
  chainWindowTicks: number;
  chainPitchMaxSteps: number;
  scoreRollTicks: number;
  /** The HUD multiplier emphasis after it rises or falls back to x1. */
  multiplierEmphasisTicks: number;
  /** The STAGE CLEAR result count-up. */
  stageResultRollTicks: number;
  /** GAME OVER: the longest the keyboard and the field wait for the ranking check. */
  retryOfferWaitMaxTicks: number;
  /** GAME OVER: confirm is dropped this long from the modal appearing. */
  retryConfirmGuardTicks: number;
  /** The effects' text is drawn at least this many CSS px tall on screen. */
  fxTextMinDisplayPx: number;
  /** The miss reason is shown this many ticks from the miss. */
  missReasonTicks: number;
  /** The miss reason is drawn at least this many CSS px tall on screen. */
  missReasonMinDisplayPx: number;
  /** The stage's title is shown this many ticks from the stage's start. */
  stageTitleTicks: number;
  /** BIG CLAIM / CLOSE CALL are shown this many ticks from the claim. */
  claimTagTicks: number;
  /** GAME OVER: the score counts up from 0 over this many ticks. */
  gameOverCountTicks: number;
  /** GAME OVER: the score and NEW RECORD pop for this many ticks. */
  gameOverPopTicks: number;
  /** GAME OVER: the sparks around NEW RECORD last this many ticks. */
  gameOverSparkTicks: number;
}

/** A fresh copy of the config.ts starting values. */
export function createDefaultFxParams(): FxParams {
  return {
    claimShareMid: FX_CLAIM_SHARE_MID,
    claimShareLarge: FX_CLAIM_SHARE_LARGE,
    hitStopClaimSmallTicks: FX_HITSTOP_CLAIM_SMALL_TICKS,
    hitStopClaimMidTicks: FX_HITSTOP_CLAIM_MID_TICKS,
    hitStopClaimLargeTicks: FX_HITSTOP_CLAIM_LARGE_TICKS,
    hitStopSplitTicks: FX_HITSTOP_SPLIT_TICKS,
    hitStopMissTicks: FX_HITSTOP_MISS_TICKS,
    lineFlashTicks: FX_LINE_FLASH_TICKS,
    fillRevealTicks: FX_FILL_REVEAL_TICKS,
    popupTicks: FX_POPUP_TICKS,
    shakeSmall: { ...FX_SHAKE_SMALL },
    shakeMedium: { ...FX_SHAKE_MEDIUM },
    shakeLarge: { ...FX_SHAKE_LARGE },
    missFlashTicks: FX_MISS_FLASH_TICKS,
    shardTicks: FX_SHARD_TICKS,
    splitBannerTicks: FX_SPLIT_BANNER_TICKS,
    splitFlashTicks: FX_SPLIT_FLASH_TICKS,
    splitConfirmLockTicks: FX_SPLIT_CONFIRM_LOCK_TICKS,
    multiplierFlyTicks: FX_MULTIPLIER_FLY_TICKS,
    multiplierHighlightTicks: FX_MULTIPLIER_HIGHLIGHT_TICKS,
    gameOverHoldTicks: FX_GAMEOVER_HOLD_TICKS,
    claimShareHuge: FX_CLAIM_SHARE_HUGE,
    textGlitchBannerTicks: FX_TEXT_GLITCH_BANNER_TICKS,
    textGlitchPopupTicks: FX_TEXT_GLITCH_POPUP_TICKS,
    popupBounceScale: FX_POPUP_BOUNCE_SCALE,
    popupBounceTicks: FX_POPUP_BOUNCE_TICKS,
    sparkMax: FX_SPARK_MAX,
    sparkTicks: FX_SPARK_TICKS,
    sparkDistanceCells: FX_SPARK_DISTANCE_CELLS,
    chainWindowTicks: FX_CHAIN_WINDOW_TICKS,
    chainPitchMaxSteps: FX_CHAIN_PITCH_MAX_STEPS,
    scoreRollTicks: FX_SCORE_ROLL_TICKS,
    multiplierEmphasisTicks: HUD_MULTIPLIER_EMPHASIS_TICKS,
    stageResultRollTicks: STAGE_RESULT_ROLL_TICKS,
    retryOfferWaitMaxTicks: RETRY_OFFER_WAIT_MAX_TICKS,
    retryConfirmGuardTicks: RETRY_CONFIRM_GUARD_TICKS,
    fxTextMinDisplayPx: FX_TEXT_MIN_DISPLAY_PX,
    missReasonTicks: FX_MISS_REASON_TICKS,
    missReasonMinDisplayPx: FX_MISS_REASON_MIN_DISPLAY_PX,
    stageTitleTicks: FX_STAGE_TITLE_TICKS,
    claimTagTicks: FX_CLAIM_TAG_TICKS,
    gameOverCountTicks: GAMEOVER_COUNT_TICKS,
    gameOverPopTicks: GAMEOVER_POP_TICKS,
    gameOverSparkTicks: GAMEOVER_SPARK_TICKS,
  };
}

/** The live, mutable parameters the game reads. */
export const fxParams: FxParams = createDefaultFxParams();

export type ClaimSize = 'small' | 'mid' | 'large';

/** A claim's size from the occupancy it added (0-1). */
export function classifyClaimShare(share: number, params: Pick<FxParams, 'claimShareMid' | 'claimShareLarge'>): ClaimSize {
  if (share >= params.claimShareLarge) return 'large';
  if (share >= params.claimShareMid) return 'mid';
  return 'small';
}

/** Which praise a claim earns. An identifier: the word drawn for it comes from the text table (praiseText()). */
export type ClaimPraise = 'NICE!' | 'GREAT!' | 'AWESOME!';

const PRAISE_TEXT_KEYS = {
  'NICE!': 'fx.praiseNice',
  'GREAT!': 'fx.praiseGreat',
  'AWESOME!': 'fx.praiseAwesome',
} as const satisfies Record<ClaimPraise, MessageKey>;

/** The word drawn for `praise`. */
export function praiseText(praise: ClaimPraise): string {
  return t(PRAISE_TEXT_KEYS[praise]);
}

/** The word a claim of this added occupancy (0-1) is praised with, or null below claimShareMid. */
export function praiseForClaimShare(
  share: number,
  params: Pick<FxParams, 'claimShareMid' | 'claimShareLarge' | 'claimShareHuge'>
): ClaimPraise | null {
  if (share >= params.claimShareHuge) return 'AWESOME!';
  if (share >= params.claimShareLarge) return 'GREAT!';
  if (share >= params.claimShareMid) return 'NICE!';
  return null;
}
