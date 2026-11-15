import { describe, expect, it } from 'vitest';
import { missReasonKey, type MissReasonEmber } from './missReason';

const ember = (x: number, y: number, blaze: boolean): MissReasonEmber => ({
  getPosition: () => ({ x, y }),
  isBlaze: () => blaze,
});

describe('missReasonKey', () => {
  it('names a Wisp and the Igniter by the cause alone', () => {
    expect(missReasonKey({ cause: 'wisp', position: { x: 3, y: 4 } }, [ember(3, 4, true)])).toBe('miss.wisp');
    expect(missReasonKey({ cause: 'igniter', position: { x: 3, y: 4 } }, [ember(3, 4, true)])).toBe('miss.igniter');
  });

  it('names a Blaze when the Ember on the contact cell is one', () => {
    const embers = [ember(0, 0, false), ember(10, 20, true)];
    expect(missReasonKey({ cause: 'ember', position: { x: 10, y: 20 } }, embers)).toBe('miss.blaze');
  });

  it('names a plain Ember when the Ember on the contact cell is not a Blaze', () => {
    const embers = [ember(10, 20, false), ember(11, 20, true)];
    expect(missReasonKey({ cause: 'ember', position: { x: 10, y: 20 } }, embers)).toBe('miss.ember');
  });

  it('falls back to a plain Ember when no Ember is on the contact cell', () => {
    expect(missReasonKey({ cause: 'ember', position: { x: 5, y: 5 } }, [ember(6, 5, true)])).toBe('miss.ember');
    expect(missReasonKey({ cause: 'ember', position: { x: 5, y: 5 } }, [])).toBe('miss.ember');
  });
});
