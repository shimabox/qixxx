// The front half of every live-play tick (src/main.ts's update()): ages the
// impact effects, spends a hit-stop tick, and decides which `confirm` may
// reach the core. Kept apart from main.ts so it can be unit tested with a
// real GameSession, InputRecorder and KeyboardInput.
//
// Replay viewing never goes through here.
import type { SessionInput, SessionStatus, GameOverReason } from '../core/session';
import type { ClaimFeedback, MissFeedback, WispSurgeFeedback } from '../core/feedback';
import type { LineSpeed } from '../core/claim';
import type { HitStop } from './hitStop';
import type { FxDirector } from './director';

/** The parts of FxDirector a live tick needs. */
export interface LiveTickFx {
  tick(): void;
  isConfirmLocked(): boolean;
  isGameOverHeld(): boolean;
}

/**
 * What, besides the impact holds, keeps a GAME OVER confirm from the
 * keyboard, the field and the touch buttons away from the core.
 */
export interface RetryHold {
  /** Confirms are dropped for this many ticks from the modal appearing (RETRY_CONFIRM_GUARD_TICKS). */
  guardTicks: number;
  /** The ranking check (/api/ranking) is still in flight (RankingUI.isSubmissionCheckPending()). */
  checkPending: boolean;
  /** The longest the check may hold confirms, counted from the modal appearing (RETRY_OFFER_WAIT_MAX_TICKS). */
  checkWaitMaxTicks: number;
  /** The submission panel is on screen (RankingUI.isSubmissionBlockingRetry() beyond the check). */
  formShown: boolean;
  /**
   * The check has decided to open the submission panel, which waits for the
   * GAME OVER result to be read (RankingUI.isSubmissionOfferWaiting()). Not
   * bounded by `checkWaitMaxTicks`: it ends when the panel opens. False when
   * omitted.
   */
  offerWaiting?: boolean;
}

const NO_RETRY_HOLD: RetryHold = { guardTicks: 0, checkPending: false, checkWaitMaxTicks: 0, formShown: false };

/**
 * The GAME OVER modal's RETRY button skips the gate below (it is no stray
 * press), except while a submission panel is waiting to open: a run that
 * may be posted is not left by a press made just before its panel appears.
 * TITLE always works.
 */
export function acceptsModalAction(action: 'retry' | 'title', hold: Pick<RetryHold, 'offerWaiting'>): boolean {
  return action === 'title' || hold.offerWaiting !== true;
}

/**
 * Decides which GAME OVER confirm may reach the core — where a confirm now
 * starts the next run at once (src/retryFlow.ts), so a stray one must not.
 *
 * Every confirm is dropped, never kept for later: while the game-ending miss
 * plays out, until the modal has been drawn, for `guardTicks` ticks after
 * that (a player still hammering the touch buttons, every one of which is a
 * confirm, would otherwise retry before seeing the modal), while the ranking
 * check is in flight (for at most `checkWaitMaxTicks` from the modal
 * appearing, so a reply that never comes cannot lock the keys), while the
 * submission panel the check decided on waits to open, and while the
 * submission panel is on screen. The modal's own RETRY / TITLE buttons do not
 * go through here (src/main.ts, acceptsModalAction()).
 */
export class GameOverConfirmGate {
  private modalShown = false;
  private ticksSinceModal = 0;

  /** The render layer calls this on the frame the GAME OVER modal is shown. */
  markModalShown(): void {
    this.modalShown = true;
    this.ticksSinceModal = 0;
  }

  isModalShown(): boolean {
    return this.modalShown;
  }

  /** Called when the run leaves GAME OVER (or the live view is reset). */
  reset(): void {
    this.modalShown = false;
    this.ticksSinceModal = 0;
  }

  /** Applies the gate to `input` read on a tick that starts in `status`. */
  filter(input: SessionInput, status: SessionStatus, fx: LiveTickFx, hold: RetryHold = NO_RETRY_HOLD): SessionInput {
    if (status !== 'gameover') {
      return fx.isConfirmLocked() && input.confirm ? { ...input, confirm: false } : input;
    }
    const drop = input.confirm ? { ...input, confirm: false } : input;
    // Pressed while the game-ending miss is still playing out, or before the
    // modal is on screen: dropped.
    if (fx.isGameOverHeld() || fx.isConfirmLocked() || !this.modalShown) return drop;
    this.ticksSinceModal++;
    if (this.ticksSinceModal <= hold.guardTicks) return drop;
    if (hold.checkPending && this.ticksSinceModal <= hold.checkWaitMaxTicks) return drop;
    if (hold.offerWaiting || hold.formShown) return drop;
    return input;
  }
}

export interface LiveTickDeps {
  fx: LiveTickFx;
  hitStop: HitStop;
  gate: GameOverConfirmGate;
  /** The session's status at the start of this tick. */
  status: SessionStatus;
  /** Polls input; must not be called on a stopped tick (it consumes the confirm edge). */
  readInput: () => SessionInput;
  /** The GAME OVER retry holds (see GameOverConfirmGate); none when omitted. */
  retryHold?: () => RetryHold;
}

/**
 * Runs the front half of a live tick. Returns null on a hit-stopped tick —
 * the caller must then skip input polling, GameSession.update(), input
 * recording and the time warning for this tick, so the run's tick count and
 * recorded samples do not advance. Otherwise returns the input to pass to
 * GameSession.update(), with `confirm` cleared while it must not reach the
 * core. A confirm pressed during a stop is still pending in the input
 * source, so it arrives exactly once on the first tick after the stop.
 */
export function beginLiveTick(deps: LiveTickDeps): SessionInput | null {
  deps.fx.tick();
  if (deps.hitStop.consume()) return null;
  return deps.gate.filter(deps.readInput(), deps.status, deps.fx, deps.retryHold?.());
}

/** The parts of GameSession the impact feedback reads after a tick. */
export interface FeedbackSource {
  drainClaimFeedback(): ClaimFeedback[];
  drainMissFeedback(): MissFeedback[];
  getMultiplier(): number;
  getStatus(): SessionStatus;
  getGameOverReason(): GameOverReason;
  /** The tick's Wisp surge notices (GameSession.drainWispSurgeFeedback()); a source without any may leave it out. */
  drainWispSurgeFeedback?(): WispSurgeFeedback[];
}

/** The claim/split sounds (SfxEngine); the miss sound stays with its 'miss' GameEvent. */
export interface ImpactSounds {
  /** `chain`: the claim's place in a row of claims (FxDirector.onClaim()), raising its pitch. */
  playClaim(claim: { share: number; speed: LineSpeed; chain: number }): void;
  playSplitImpact(): void;
  /** The Wisp surge sound (SfxEngine.playWispSurge()); optional for callers that never pass surge notices. */
  playWispSurge?(level: 1 | 2): void;
}

/**
 * The back half of a live tick, after GameSession.update(): turns the tick's
 * claim/miss notices into effects, a hit stop and the claim/split sounds. A
 * split replaces the claim sound with the split's, which does not change
 * with the chain. A miss that ended the run on lives holds the GAME OVER
 * modal (FxDirector.onMiss()). `missReason` gives a miss's one-line reason
 * (src/fx/missReason.ts), shown next to the contact; none when omitted.
 * Returns the tick's claim and miss notices — drained here, once — for the
 * STAGE CLEAR result (src/stageResult.ts) and the play log
 * (src/playLog/recorder.ts).
 *
 * A Wisp surge notice (a claim raised the surge level) starts the surge
 * ring and sound once — only while the session is still playing at the end
 * of the tick: a TIME UP on the same tick ends the run after the claim, and
 * then neither appears.
 */
export function applyImpactNotices(
  session: FeedbackSource,
  fx: Pick<FxDirector, 'onClaim' | 'onMiss' | 'onWispSurge'>,
  hitStop: HitStop,
  sounds: ImpactSounds,
  missReason?: (notice: MissFeedback) => string | null
): { claims: ClaimFeedback[]; misses: MissFeedback[] } {
  const claims = session.drainClaimFeedback();
  for (const notice of claims) {
    // After a split, getMultiplier() already reads the next stage's value.
    const { hitStopTicks, chain } = fx.onClaim(notice, { nextMultiplier: session.getMultiplier() });
    hitStop.request(hitStopTicks);
    if (notice.split) {
      sounds.playSplitImpact();
    } else {
      sounds.playClaim({ share: notice.occupancyAfter - notice.occupancyBefore, speed: notice.lineSpeed, chain });
    }
  }
  const misses = session.drainMissFeedback();
  for (const notice of misses) {
    const gameOver = session.getStatus() === 'gameover' && session.getGameOverReason() === 'life';
    hitStop.request(fx.onMiss(notice, { gameOver, reason: missReason?.(notice) ?? null }).hitStopTicks);
  }
  const surges = session.drainWispSurgeFeedback?.() ?? [];
  if (session.getStatus() === 'playing') {
    for (const notice of surges) {
      fx.onWispSurge(notice);
      sounds.playWispSurge?.(notice.level);
    }
  }
  return { claims, misses };
}
