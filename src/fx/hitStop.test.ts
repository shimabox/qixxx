import { describe, it, expect } from 'vitest';
import { HitStop } from './hitStop';

describe('HitStop', () => {
  it('consumes exactly the requested number of ticks', () => {
    const stop = new HitStop();
    stop.request(3);
    expect([stop.consume(), stop.consume(), stop.consume(), stop.consume()]).toEqual([true, true, true, false]);
    expect(stop.getRemaining()).toBe(0);
  });

  it('keeps the longer of overlapping requests instead of adding them up', () => {
    const stop = new HitStop();
    stop.request(10);
    stop.consume(); // 9 left
    stop.request(6);
    expect(stop.getRemaining()).toBe(9);
    stop.request(12);
    expect(stop.getRemaining()).toBe(12);
  });

  it('clear() ends the stop at once', () => {
    const stop = new HitStop();
    stop.request(20);
    stop.clear();
    expect(stop.consume()).toBe(false);
  });

  it('ignores zero and negative requests', () => {
    const stop = new HitStop();
    stop.request(0);
    stop.request(-5);
    expect(stop.consume()).toBe(false);
  });
});
