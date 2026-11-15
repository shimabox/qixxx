// The front half of every live-play tick (src/main.ts's update()): ages the
// impact effects, spends a hit-stop tick, and decides which `confirm` may
// reach the core. Kept apart from main.ts so it can be unit tested with a
// real GameSession, InputRecorder and KeyboardInput.
//
// Replay viewing never goes through here.
import type { SessionInput, SessionStatus, GameOverReason } from '../core/session';
import type { ClaimFeedback, MissFeedback } from '../core/feedback';
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
 * Keeps a GAME OVER confirm from reaching the core before the GAME OVER
 * modal has actually been drawn, so a key pressed while the run is ending can
 * never skip the modal (and with it the score and the ranking offer) by
 * jumping straight back to Title.
 *
 * A confirm read after any game-ending hold but before the modal is on
 * screen is kept (one at most) and handed over on the first tick after the
 * modal was drawn.
 */
export class GameOverConfirmGate {
  private modalShown = false;
  private pendingConfirm = false;

  /** The render layer calls this on the frame the GAME OVER modal is shown. */
  markModalShown(): void {
    this.modalShown = true;
  }

  isModalShown(): boolean {
    return this.modalShown;
  }

  /** Called when the run leaves GAME OVER (or the live view is reset). */
  reset(): void {
    this.modalShown = false;
    this.pendingConfirm = false;
  }

  /** Applies the gate to `input` read on a tick that starts in `status`. */
  filter(input: SessionInput, status: SessionStatus, fx: LiveTickFx): SessionInput {
    if (status !== 'gameover') {
      return fx.isConfirmLocked() && input.confirm ? { ...input, confirm: false } : input;
    }
    if (fx.isGameOverHeld() || fx.isConfirmLocked()) {
      // Pressed while the game-ending miss is still playing out: dropped.
      return input.confirm ? { ...input, confirm: false } : input;
    }
    if (!this.modalShown) {
      if (input.confirm) this.pendingConfirm = true;
      return input.confirm ? { ...input, confirm: false } : input;
    }
    if (this.pendingConfirm) {
      this.pendingConfirm = false;
      return { ...input, confirm: true };
    }
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
  return deps.gate.filter(deps.readInput(), deps.status, deps.fx);
}

/** The parts of GameSession the impact feedback reads after a tick. */
export interface FeedbackSource {
  drainClaimFeedback(): ClaimFeedback[];
  drainMissFeedback(): MissFeedback[];
  getMultiplier(): number;
  getStatus(): SessionStatus;
  getGameOverReason(): GameOverReason;
}

/** The claim/split sounds (SfxEngine); the miss sound stays with its 'miss' GameEvent. */
export interface ImpactSounds {
  playClaim(claim: { share: number; speed: LineSpeed }): void;
  playSplitImpact(): void;
}

/**
 * The back half of a live tick, after GameSession.update(): turns the tick's
 * claim/miss notices into effects, a hit stop and the claim/split sounds. A
 * split replaces the claim sound with the split's. A miss that ended the
 * run on lives holds the GAME OVER modal (FxDirector.onMiss()).
 */
export function applyImpactNotices(
  session: FeedbackSource,
  fx: Pick<FxDirector, 'onClaim' | 'onMiss'>,
  hitStop: HitStop,
  sounds: ImpactSounds
): void {
  for (const notice of session.drainClaimFeedback()) {
    // After a split, getMultiplier() already reads the next stage's value.
    const { hitStopTicks } = fx.onClaim(notice, { nextMultiplier: session.getMultiplier() });
    hitStop.request(hitStopTicks);
    if (notice.split) {
      sounds.playSplitImpact();
    } else {
      sounds.playClaim({ share: notice.occupancyAfter - notice.occupancyBefore, speed: notice.lineSpeed });
    }
  }
  for (const notice of session.drainMissFeedback()) {
    const gameOver = session.getStatus() === 'gameover' && session.getGameOverReason() === 'life';
    hitStop.request(fx.onMiss(notice, { gameOver }).hitStopTicks);
  }
}
