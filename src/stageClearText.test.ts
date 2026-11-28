import { describe, it, expect } from 'vitest';
import { stageClearText } from './stageClearText';

function source(stage: number, split: boolean) {
  return { getStage: () => stage, getGame: () => ({ getLastClearWasSplit: () => split }) };
}

const LIVE = { withPrompt: true, withSplitNote: false };
const REPLAY = { withPrompt: false, withSplitNote: true };

describe('stageClearText', () => {
  describe('live play (withPrompt: true, withSplitNote: false)', () => {
    it('asks for a key press under the stage line', () => {
      expect(stageClearText(source(3, false), LIVE)).toBe('STAGE 3 CLEAR!\n\nPRESS ANY KEY OR TAP FOR NEXT STAGE');
    });

    it('leaves the split note out: the SPLIT! banner already announced it', () => {
      expect(stageClearText(source(3, true), LIVE)).toBe('STAGE 3 CLEAR!\n\nPRESS ANY KEY OR TAP FOR NEXT STAGE');
    });

    it('can still note a split between the stage line and the prompt when asked', () => {
      expect(stageClearText(source(3, true), { withPrompt: true, withSplitNote: true })).toBe(
        'STAGE 3 CLEAR!\n(SPLIT CLEAR!)\n\nPRESS ANY KEY OR TAP FOR NEXT STAGE'
      );
    });
  });

  describe('replay viewing (withPrompt: false, withSplitNote: true)', () => {
    it('is the stage line alone', () => {
      expect(stageClearText(source(3, false), REPLAY)).toBe('STAGE 3 CLEAR!');
    });

    it('notes a split clear on its own line', () => {
      expect(stageClearText(source(3, true), REPLAY)).toBe('STAGE 3 CLEAR!\n(SPLIT CLEAR!)');
    });

    it('never asks for a key press, since a replay advances by itself', () => {
      for (const split of [false, true]) {
        expect(stageClearText(source(3, split), REPLAY)).not.toContain('PRESS ANY KEY');
      }
    });
  });
});
