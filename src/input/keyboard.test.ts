import { describe, it, expect } from 'vitest';
import { KeyboardInput } from './keyboard';

/** Dispatches a key event carrying `code` on the target (Node's Event has no key fields, so the code rides as an expando — KeyboardInput only ever reads `.code`). */
function key(target: EventTarget, type: 'keydown' | 'keyup', code: string): void {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { code });
  target.dispatchEvent(event);
}

describe('KeyboardInput — blur clears held state (GameOver release gate support, 2026-08-22)', () => {
  it('drops held keys on blur, so a keyup missed while unfocused cannot leave a key stuck down', () => {
    const target = new EventTarget();
    const input = new KeyboardInput(target);
    key(target, 'keydown', 'ArrowRight');
    expect(input.getInput().dx).toBe(1);

    // Focus leaves; the physical release happens elsewhere and its keyup
    // never arrives here.
    target.dispatchEvent(new Event('blur'));
    expect(input.getInput().dx).toBe(0);
    input.dispose();
  });

  it('drops a pending confirm edge on blur rather than firing it on whatever screen shows at refocus', () => {
    const target = new EventTarget();
    const input = new KeyboardInput(target);
    key(target, 'keydown', 'KeyX');
    target.dispatchEvent(new Event('blur'));
    expect(input.getInput().confirm).toBe(false);
    input.dispose();
  });

  it('treats the same key as a fresh edge after blur (the stale entry no longer swallows it)', () => {
    const target = new EventTarget();
    const input = new KeyboardInput(target);
    key(target, 'keydown', 'ArrowRight');
    input.getInput(); // consume the first edge
    target.dispatchEvent(new Event('blur'));

    key(target, 'keydown', 'ArrowRight'); // re-pressed after refocus
    const state = input.getInput();
    expect(state.dx).toBe(1);
    expect(state.confirm).toBe(true);
    input.dispose();
  });
});
