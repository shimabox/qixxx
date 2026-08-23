import { describe, it, expect } from 'vitest';
import { KeyboardInput } from './keyboard';

/** Dispatches a key event carrying `code` on the target (Node's Event has no key fields, so the code rides as an expando — KeyboardInput only ever reads `.code`). */
function key(
  target: EventTarget,
  type: 'keydown' | 'keyup',
  code: string,
  init: Partial<KeyboardEvent> = {}
): Event {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { code, ...init });
  target.dispatchEvent(event);
  return event;
}

class ElementTarget extends EventTarget {
  constructor(private readonly selector: string) {
    super();
  }

  closest(selector: string): ElementTarget | null {
    return selector.split(',').some((part) => part.trim() === this.selector) ? this : null;
  }
}

describe('KeyboardInput — confirm keys', () => {
  it('leaves Tab and Shift+Tab to browser focus navigation without confirming', () => {
    const target = new EventTarget();
    const input = new KeyboardInput(target);

    const tab = key(target, 'keydown', 'Tab');
    expect(input.getInput().confirm).toBe(false);
    expect(tab.defaultPrevented).toBe(false);

    key(target, 'keyup', 'Tab');
    const shiftTab = key(target, 'keydown', 'Tab', { shiftKey: true });
    expect(input.getInput().confirm).toBe(false);
    expect(shiftTab.defaultPrevented).toBe(false);
    input.dispose();
  });

  it('continues treating other keys as confirm input', () => {
    const target = new EventTarget();
    const input = new KeyboardInput(target);

    key(target, 'keydown', 'KeyA');
    expect(input.getInput().confirm).toBe(true);
    input.dispose();
  });

  it.each(['button', 'a[href]', 'input'])('ignores keydown from a %s control', (selector) => {
    const target = new ElementTarget(selector);
    const input = new KeyboardInput(target);

    const event = key(target, 'keydown', 'ArrowRight');
    const state = input.getInput();

    expect(state.confirm).toBe(false);
    expect(state.dx).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    input.dispose();
  });

  it('continues treating keydown from document.body as confirm input', () => {
    const document = { body: new ElementTarget('body') };
    const input = new KeyboardInput(document.body);

    key(document.body, 'keydown', 'ArrowRight');
    const state = input.getInput();

    expect(state.confirm).toBe(true);
    expect(state.dx).toBe(1);
    input.dispose();
  });
});

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
