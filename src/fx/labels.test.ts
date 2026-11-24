// The stage title and BIG CLAIM / CLOSE CALL in FxDirector's frames.
import { describe, it, expect } from 'vitest';
import { FxDirector } from './director';
import { createDefaultFxParams } from './params';
import type { ClaimFeedback } from '../core/feedback';
import { FX_STAGE_TITLE_TICKS, FX_CLAIM_TAG_TICKS } from '../config';

function claim(overrides: Partial<ClaimFeedback> = {}): ClaimFeedback {
  return {
    claimedCells: 100,
    occupancyBefore: 0.1,
    occupancyAfter: 0.2,
    lineSpeed: 'fast',
    areaScore: 50,
    bigClaim: false,
    nearMissBonus: 0,
    stageClearBonus: 0,
    multiplier: 1,
    split: false,
    splitMultiplierGain: 0,
    stageCleared: false,
    closedLine: [
      { x: 10, y: 1 },
      { x: 10, y: 2 },
      { x: 10, y: 3 },
    ],
    ...overrides,
  };
}

const NEXT = { nextMultiplier: 1 };

describe('the stage title', () => {
  it('is shown for 60 ticks from the stage start, then gone', () => {
    expect(FX_STAGE_TITLE_TICKS).toBe(60);
    const fx = new FxDirector(createDefaultFxParams());
    expect(fx.getFrame().stageTitle).toBeNull();
    fx.onStageStart('STAGE 3', 'FAST PAIR');
    expect(fx.getFrame().stageTitle).toMatchObject({ heading: 'STAGE 3', title: 'FAST PAIR', age: 0 });
    for (let i = 1; i < FX_STAGE_TITLE_TICKS; i++) {
      fx.tick();
      expect(fx.getFrame().stageTitle?.age, `tick ${i}`).toBe(i);
    }
    fx.tick();
    expect(fx.getFrame().stageTitle).toBeNull();
  });

  it('pops in and fades out, but neither with reduced motion', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onStageStart('STAGE 1', 'WARM-UP');
    expect(fx.getFrame().stageTitle!.scale).toBeGreaterThan(1);
    for (let i = 0; i < 20; i++) fx.tick();
    expect(fx.getFrame().stageTitle).toMatchObject({ scale: 1, alpha: 1 });
    for (let i = 20; i < FX_STAGE_TITLE_TICKS - 1; i++) fx.tick();
    expect(fx.getFrame().stageTitle!.alpha).toBeLessThan(1);

    const still = new FxDirector(createDefaultFxParams(), { reducedMotion: true });
    still.onStageStart('STAGE 1', 'WARM-UP');
    for (let i = 0; i < FX_STAGE_TITLE_TICKS; i++) {
      expect(still.getFrame().stageTitle).toMatchObject({ scale: 1, alpha: 1 });
      still.tick();
    }
    expect(still.getFrame().stageTitle).toBeNull();
  });

  it('stays through the board change of the stage it opens, and goes with a reset', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onStageStart('STAGE 2', 'SPRINTER');
    fx.resetBoard();
    expect(fx.getFrame().stageTitle).not.toBeNull();
    fx.reset();
    expect(fx.getFrame().stageTitle).toBeNull();
  });

  it('is not shown when its length is set to 0', () => {
    const params = createDefaultFxParams();
    params.stageTitleTicks = 0;
    const fx = new FxDirector(params);
    fx.onStageStart('STAGE 1', 'WARM-UP');
    expect(fx.getFrame().stageTitle).toBeNull();
  });
});

describe('BIG CLAIM / CLOSE CALL', () => {
  it('shows nothing for an ordinary claim', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim(), NEXT);
    expect(fx.getFrame().claimTags).toEqual([]);
  });

  it('shows BIG CLAIM for a big claim and CLOSE CALL +N for a close call, with the claim’s popup', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim({ bigClaim: true, nearMissBonus: 400 }), NEXT);
    const frame = fx.getFrame();
    expect(frame.claimTags).toHaveLength(1);
    expect(frame.claimTags[0].tags).toEqual([
      { kind: 'big', text: 'BIG CLAIM' },
      { kind: 'close', text: 'CLOSE CALL +400' },
    ]);
    expect(frame.claimTags[0].revealId).toBe(frame.popups[0].revealId);
  });

  it(`lasts ${FX_CLAIM_TAG_TICKS} ticks`, () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim({ nearMissBonus: 200 }), NEXT);
    for (let i = 1; i < FX_CLAIM_TAG_TICKS; i++) fx.tick();
    expect(fx.getFrame().claimTags).toHaveLength(1);
    fx.tick();
    expect(fx.getFrame().claimTags).toEqual([]);
  });

  it('shows on a split too, which has no popup', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim({ split: true, stageCleared: true, bigClaim: true }), { nextMultiplier: 2 });
    const frame = fx.getFrame();
    expect(frame.popups).toEqual([]);
    expect(frame.claimTags[0].tags.map((tag) => tag.kind)).toEqual(['big']);
  });

  it('goes with the board', () => {
    const fx = new FxDirector(createDefaultFxParams());
    fx.onClaim(claim({ bigClaim: true }), NEXT);
    fx.resetBoard();
    expect(fx.getFrame().claimTags).toEqual([]);
  });
});
