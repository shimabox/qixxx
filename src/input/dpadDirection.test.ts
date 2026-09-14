import { describe, expect, it } from 'vitest';
import { DpadPointerState, resolveDpadDirection } from './touch';

describe('resolveDpadDirection', () => {
  it.each([
    [0, 0],
    [15, 0],
    [0, -16],
  ])('returns null inside the dead zone at (%i, %i)', (dx, dy) => {
    expect(resolveDpadDirection(dx, dy, 16)).toBeNull();
  });

  it('resolves a point one pixel beyond the dead-zone radius', () => {
    expect(resolveDpadDirection(0, -17, 16)).toBe('up');
  });

  it.each([
    [0, -40, 'up'],
    [0, 40, 'down'],
    [-40, 0, 'left'],
    [40, 0, 'right'],
    [30, 30, 'down'],
    [30, -30, 'up'],
    [31, 30, 'right'],
    [-31, 30, 'left'],
  ] as const)('resolves (%i, %i) as %s', (dx, dy, direction) => {
    expect(resolveDpadDirection(dx, dy, 16)).toBe(direction);
  });
});

describe('DpadPointerState', () => {
  it('ignores another pointer until the owner is released', () => {
    const state = new DpadPointerState();
    expect(state.down(1, 'up')).toEqual({ keyup: null, keydown: 'up' });
    expect(state.down(2, 'right')).toBeNull();
    expect(state.up(2)).toBeNull();
    expect(state.move(2, 'left')).toBeNull();
    expect(state.up(1)).toEqual({ keyup: 'up', keydown: null });
  });

  it('returns keyup then keydown directions when sliding', () => {
    const state = new DpadPointerState();
    state.down(1, 'up');
    expect(state.move(1, 'right')).toEqual({ keyup: 'up', keydown: 'right' });
  });

  it('returns the appropriate transition when entering and leaving the dead zone', () => {
    const state = new DpadPointerState();
    state.down(1, 'left');
    expect(state.move(1, null)).toEqual({ keyup: 'left', keydown: null });
    expect(state.move(1, 'down')).toEqual({ keyup: null, keydown: 'down' });
  });

  it('allows another pointer to own the d-pad after release', () => {
    const state = new DpadPointerState();
    state.down(1, null);
    expect(state.up(1)).toBeNull();
    expect(state.down(2, 'right')).toEqual({ keyup: null, keydown: 'right' });
  });
});
