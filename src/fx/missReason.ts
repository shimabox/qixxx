// What a miss was caused by, as the one-line reason shown next to the
// contact (FxDirector.onMiss()'s `reason`). Read from the miss notice and the
// Embers of the same tick only — the run itself is never touched.
import type { MissFeedback } from '../core/feedback';
import type { Point } from '../core/field';
import type { MessageKey } from '../i18n';

/** The parts of an Ember (core/patrol.ts) the reason reads. */
export interface MissReasonEmber {
  getPosition(): Point;
  isBlaze(): boolean;
}

/**
 * The text table key of the reason for `feedback`: a Wisp touching the line
 * or the marker, the Igniter catching up with a marker that stood still, or
 * an Ember — a Blaze when the Ember on the contact cell this tick is one (a
 * plain Ember when it is not, or when none is found there).
 */
export function missReasonKey(feedback: Pick<MissFeedback, 'cause' | 'position'>, embers: readonly MissReasonEmber[]): MessageKey {
  switch (feedback.cause) {
    case 'wisp':
      return 'miss.wisp';
    case 'igniter':
      return 'miss.igniter';
    case 'ember': {
      const { x, y } = feedback.position;
      const hit = embers.find((ember) => {
        const p = ember.getPosition();
        return p.x === x && p.y === y;
      });
      return hit?.isBlaze() ? 'miss.blaze' : 'miss.ember';
    }
  }
}
