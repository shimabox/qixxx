// Virtual touch controls (docs/plan.md §5.2): a d-pad (bottom-left) plus
// FAST/SLOW buttons (bottom-right), built as plain DOM elements. DOM-
// dependent by design, exactly like input/keyboard.ts.
//
// Design choice: rather than maintaining a second, parallel input-state
// object that main.ts would have to merge with KeyboardInput's every tick,
// each on-screen button dispatches synthetic KeyboardEvents (keydown on
// press, keyup on release) using the exact same `code` values keyboard.ts
// listens for (see input/keys.ts). KeyboardInput's Set<string> of "currently
// pressed codes" doesn't care whether a given keydown/keyup came from a real
// key or a synthetic one, so this is a complete, zero-glue-code merge of the
// two input sources — including the edge-triggered `confirm` pulse (any new
// code, tracked or not, sets it — see keyboard.ts), which is what makes
// "tapping any control also confirms Title/StageClear/GameOver screens"
// come for free.
//
// Multi-touch (docs/plan.md §5.2 "移動 + ボタン同時押しが必須要件"): each
// button is its own DOM element with its own pointerdown/up/cancel/leave
// listeners and calls setPointerCapture on press. Two fingers pressing two
// different buttons fire on two different elements/pointerIds entirely
// independently — there is no shared "currently touched" state to race on,
// so simultaneous cross-key + FAST/SLOW presses work without any pointerId
// bookkeeping in this module.
import { MOVE_KEYS, DRAW_FAST_KEYS, DRAW_SLOW_KEYS } from './keys';

interface ButtonSpec {
  code: string;
  label: string;
  gridArea: string;
}

const DPAD_BUTTONS: ButtonSpec[] = [
  { code: MOVE_KEYS.up[0], label: '▲', gridArea: 'up' },
  { code: MOVE_KEYS.left[0], label: '◀', gridArea: 'left' },
  { code: MOVE_KEYS.right[0], label: '▶', gridArea: 'right' },
  { code: MOVE_KEYS.down[0], label: '▼', gridArea: 'down' },
];

const ACTION_BUTTONS: ButtonSpec[] = [
  { code: DRAW_SLOW_KEYS[0], label: 'SLOW', gridArea: 'slow' },
  { code: DRAW_FAST_KEYS[0], label: 'FAST', gridArea: 'fast' },
];

/** True on devices where a touch-style pointer is the primary input (docs/plan.md §5.2). */
export function isTouchCapableDevice(): boolean {
  if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) return true;
  if (typeof window !== 'undefined' && 'ontouchstart' in window) return true;
  if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) return true;
  return false;
}

export class TouchControls {
  private container: HTMLDivElement;
  private dispatchTarget: EventTarget;
  private disposers: Array<() => void> = [];

  /**
   * @param dispatchTarget Where synthetic KeyboardEvents are dispatched —
   *   must be the same EventTarget a KeyboardInput instance is listening on
   *   (defaults to `window`, matching KeyboardInput's own default).
   * @param parent Where the control DOM is mounted. Defaults to
   *   `document.body`.
   */
  constructor(dispatchTarget: EventTarget = window, parent: HTMLElement = document.body) {
    this.dispatchTarget = dispatchTarget;
    this.container = this.buildContainer();
    for (const spec of DPAD_BUTTONS) {
      this.container.appendChild(this.buildButton(spec));
    }
    for (const spec of ACTION_BUTTONS) {
      this.container.appendChild(this.buildButton(spec));
    }
    parent.appendChild(this.container);
  }

  getElement(): HTMLDivElement {
    return this.container;
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
    this.container.remove();
  }

  private buildContainer(): HTMLDivElement {
    const el = document.createElement('div');
    el.id = 'touch-controls';
    el.style.display = 'grid';
    el.style.gridTemplateAreas = "'left up right fast' 'left down right slow'";
    el.style.gridTemplateColumns = 'repeat(3, 56px) 1fr';
    el.style.gridTemplateRows = 'repeat(2, 56px)';
    el.style.columnGap = '4px';
    el.style.rowGap = '4px';
    el.style.justifyContent = 'space-between';
    el.style.alignItems = 'center';
    el.style.padding = '8px 16px';
    el.style.touchAction = 'none';
    el.style.userSelect = 'none';
    el.style.width = '100%';
    el.style.boxSizing = 'border-box';
    // Shown only on touch-capable devices (docs/plan.md §5.2); harmless if
    // shown on desktop too, but we default to hiding it there to avoid
    // cluttering a mouse+keyboard session, per the media-query check below.
    // JS re-check backs up the CSS media query for environments (like some
    // automated test harnesses) where `(pointer: coarse)` isn't reported but
    // touch is still emulated.
    el.style.display = isTouchCapableDevice() ? 'grid' : 'none';
    return el;
  }

  private buildButton(spec: ButtonSpec): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.code = spec.code;
    button.textContent = spec.label;
    button.style.gridArea = spec.gridArea;
    button.style.width = '56px';
    button.style.height = '56px';
    button.style.borderRadius = '50%';
    button.style.border = '2px solid #00ff41';
    button.style.background = 'rgba(10, 14, 39, 0.7)';
    button.style.color = '#00ff41';
    button.style.font = '12px monospace';
    button.style.touchAction = 'none';
    button.style.userSelect = 'none';
    button.style.webkitUserSelect = 'none';

    const onDown = (event: PointerEvent): void => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      button.style.background = 'rgba(0, 255, 65, 0.35)';
      this.dispatch('keydown', spec.code);
    };
    const onUp = (event: PointerEvent): void => {
      event.preventDefault();
      button.style.background = 'rgba(10, 14, 39, 0.7)';
      this.dispatch('keyup', spec.code);
    };

    button.addEventListener('pointerdown', onDown);
    button.addEventListener('pointerup', onUp);
    button.addEventListener('pointercancel', onUp);
    button.addEventListener('pointerleave', onUp);
    // Context menu / long-press callouts would interrupt a held button.
    button.addEventListener('contextmenu', (e) => e.preventDefault());

    this.disposers.push(() => {
      button.removeEventListener('pointerdown', onDown);
      button.removeEventListener('pointerup', onUp);
      button.removeEventListener('pointercancel', onUp);
      button.removeEventListener('pointerleave', onUp);
    });

    return button;
  }

  private dispatch(type: 'keydown' | 'keyup', code: string): void {
    this.dispatchTarget.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
  }
}

/**
 * A full-area tap-to-confirm zone (docs/plan.md §7.2/§4.4: tapping should
 * advance Title/StageClear/GameOver just like "press any key"). Dispatches a
 * synthetic keydown+keyup pair using a dedicated code that isn't bound to
 * any movement/draw action, so tapping the canvas can never accidentally
 * start drawing a line — it only ever contributes to KeyboardInput's
 * edge-triggered `confirm` pulse (see keyboard.ts: ANY newly-seen code sets
 * it, tracked or not).
 */
const VIRTUAL_CONFIRM_CODE = 'VirtualConfirm';

export function attachTapToConfirm(element: HTMLElement, dispatchTarget: EventTarget = window): () => void {
  const onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    dispatchTarget.dispatchEvent(new KeyboardEvent('keydown', { code: VIRTUAL_CONFIRM_CODE }));
    dispatchTarget.dispatchEvent(new KeyboardEvent('keyup', { code: VIRTUAL_CONFIRM_CODE }));
  };
  element.addEventListener('pointerdown', onPointerDown);
  return () => element.removeEventListener('pointerdown', onPointerDown);
}
