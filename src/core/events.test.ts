import { describe, it, expect } from 'vitest';
import { EventQueue } from './events';

describe('EventQueue', () => {
  it('starts empty', () => {
    const queue = new EventQueue<string>();
    expect(queue.isEmpty()).toBe(true);
    expect(queue.drain()).toEqual([]);
  });

  it('drains queued items in push order, then clears the queue', () => {
    const queue = new EventQueue<string>();
    queue.push('a');
    queue.push('b');
    queue.push('c');

    expect(queue.isEmpty()).toBe(false);
    expect(queue.drain()).toEqual(['a', 'b', 'c']);
    expect(queue.isEmpty()).toBe(true);
    expect(queue.drain()).toEqual([]);
  });

  it('accumulates pushes across multiple ticks until drained (docs/plan.md §3.8 bridge)', () => {
    const queue = new EventQueue<string>();
    queue.push('tick1-a');
    queue.push('tick2-a');
    queue.push('tick2-b');

    expect(queue.drain()).toEqual(['tick1-a', 'tick2-a', 'tick2-b']);

    // A fresh push after a drain starts a clean batch, not append to the old one.
    queue.push('tick3-a');
    expect(queue.drain()).toEqual(['tick3-a']);
  });

  it('returns a snapshot array unaffected by further pushes', () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    const drained = queue.drain();
    queue.push(2);

    expect(drained).toEqual([1]);
    expect(queue.drain()).toEqual([2]);
  });
});
