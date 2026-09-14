import { describe, expect, it } from 'vitest';
import { resolveTouchLayout } from './touch';

describe('resolveTouchLayout', () => {
  it.each([
    [{ touchCapable: true, viewportWidth: 400, viewportHeight: 399 }, 'bottom'],
    [{ touchCapable: true, viewportWidth: 703, viewportHeight: 300 }, 'bottom'],
    [{ touchCapable: true, viewportWidth: 704, viewportHeight: 300 }, 'side'],
    [{ touchCapable: true, viewportWidth: 672, viewportHeight: 672 }, 'bottom'],
    [{ touchCapable: true, viewportWidth: 802, viewportHeight: 293 }, 'side'],
    [{ touchCapable: false, viewportWidth: 1280, viewportHeight: 720 }, 'bottom'],
  ] as const)('resolves %o as %s', (input, expected) => {
    expect(resolveTouchLayout(input)).toBe(expected);
  });
});
