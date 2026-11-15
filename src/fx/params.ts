// The run-time tunable numbers of the impact feedback (hit stop, fill reveal,
// popup, flashes, shakes, shards, split banner). Starts from src/config.ts's
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
  FxShakeSpec,
} from '../config';

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
