import { describe, it, expect } from 'vitest';
import { stageClearText } from './stageClearText';

function source(stage: number, split: boolean) {
  return { getStage: () => stage, getGame: () => ({ getLastClearWasSplit: () => split }) };
}

describe('stageClearText', () => {
  describe('live play (withPrompt: true)', () => {
    it('asks for a key press under the stage line', () => {
      expect(stageClearText(source(3, false), { withPrompt: true })).toBe('STAGE 3 CLEAR!\n\nPRESS ANY KEY OR TAP FOR NEXT STAGE');
    });

    it('notes a split clear between the stage line and the prompt', () => {
      expect(stageClearText(source(3, true), { withPrompt: true })).toBe(
        'STAGE 3 CLEAR!\n(SPLIT CLEAR!)\n\nPRESS ANY KEY OR TAP FOR NEXT STAGE'
      );
    });
  });

  describe('replay viewing (withPrompt: false)', () => {
    it('is the stage line alone', () => {
      expect(stageClearText(source(3, false), { withPrompt: false })).toBe('STAGE 3 CLEAR!');
    });

    it('notes a split clear on its own line', () => {
      expect(stageClearText(source(3, true), { withPrompt: false })).toBe('STAGE 3 CLEAR!\n(SPLIT CLEAR!)');
    });

    it('never asks for a key press, since a replay advances by itself', () => {
      for (const split of [false, true]) {
        expect(stageClearText(source(3, split), { withPrompt: false })).not.toContain('PRESS ANY KEY');
      }
    });
  });
});
