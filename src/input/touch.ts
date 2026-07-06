// Virtual touch controls (docs/plan.md §5.2/§12.1): a d-pad pinned to the
// screen's left edge plus FAST/SLOW buttons pinned to the right edge, built
// as plain DOM elements. DOM-dependent by design, exactly like
// input/keyboard.ts.
//
// GB-style left/right split (docs/plan.md §12.1 "タッチパッドのGB風左右
// 分離"): the d-pad and the FAST/SLOW cluster are two independent groups
// inside a single flex row with `justify-content: space-between`, so they
// hug the screen's left/right edges with open space between them (rather
// than sitting side-by-side near the center, which is what invited
// mis-taps). Within the action cluster, FAST/SLOW are placed on the
// diagonal (FAST upper-right, SLOW lower-left) like a Game Boy's A/B, via
// absolute positioning inside a small relative box — see buildActionCluster.
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
// bookkeeping in this module. The left/right split (this file) and the
// diagonal FAST/SLOW placement keep the two groups from ever overlapping,
// so that still holds true here.
import { MOVE_KEYS, DRAW_FAST_KEYS, DRAW_SLOW_KEYS } from './keys';
import { TOUCH_BUTTON_SIZE, TOUCH_DPAD_GAP } from '../config';

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

// Side length (CSS px) of the square box the FAST/SLOW buttons are
// diagonally positioned inside (see buildActionCluster): two buttons plus a
// gap between them along the diagonal, with no overlap so a finger on one
// can never accidentally capture the other's pointer events.
const ACTION_CLUSTER_SIZE = TOUCH_BUTTON_SIZE * 2 + TOUCH_DPAD_GAP * 2;

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
    // Two independent groups (docs/plan.md §12.1): the d-pad hugs the left
    // edge, the FAST/SLOW cluster hugs the right edge, with the container's
    // `justify-content: space-between` opening up the space between them.
    this.container.appendChild(this.buildDpad());
    this.container.appendChild(this.buildActionCluster());
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
    // A plain flex row with `space-between` is what pushes the d-pad group
    // and the FAST/SLOW cluster to the screen's left/right edges
    // (docs/plan.md §12.1) — each group lays itself out independently (see
    // buildDpad/buildActionCluster), so this container only needs to place
    // the two groups apart from each other.
    el.style.display = 'flex';
    el.style.justifyContent = 'space-between';
    el.style.alignItems = 'center';
    el.style.padding = '10px 8px';
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
    el.style.display = isTouchCapableDevice() ? 'flex' : 'none';
    return el;
  }

  // The d-pad: a 3x3 grid with the corners left empty, giving a compact
  // "+"-shaped cluster pinned to the container's left edge.
  private buildDpad(): HTMLDivElement {
    const el = document.createElement('div');
    el.style.display = 'grid';
    el.style.gridTemplateAreas = "'. up .' 'left . right' '. down .'";
    el.style.gridTemplateColumns = `repeat(3, ${TOUCH_BUTTON_SIZE}px)`;
    el.style.gridTemplateRows = `repeat(3, ${TOUCH_BUTTON_SIZE}px)`;
    el.style.columnGap = `${TOUCH_DPAD_GAP}px`;
    el.style.rowGap = `${TOUCH_DPAD_GAP}px`;
    el.style.flex = '0 0 auto';
    for (const spec of DPAD_BUTTONS) {
      const button = this.buildButton(spec);
      button.style.gridArea = spec.gridArea;
      el.appendChild(button);
    }
    return el;
  }

  // The FAST/SLOW cluster: a small relative box, pinned to the container's
  // right edge, with FAST absolutely positioned top-right and SLOW
  // bottom-left — a Game Boy-style diagonal A/B layout (docs/plan.md §12.1)
  // rather than the two buttons sitting side by side next to the d-pad.
  private buildActionCluster(): HTMLDivElement {
    const el = document.createElement('div');
    el.style.position = 'relative';
    el.style.width = `${ACTION_CLUSTER_SIZE}px`;
    el.style.height = `${ACTION_CLUSTER_SIZE}px`;
    el.style.flex = '0 0 auto';
    for (const spec of ACTION_BUTTONS) {
      const button = this.buildButton(spec);
      button.style.position = 'absolute';
      if (spec.gridArea === 'fast') {
        button.style.top = '0';
        button.style.right = '0';
      } else {
        button.style.bottom = '0';
        button.style.left = '0';
      }
      el.appendChild(button);
    }
    return el;
  }

  private buildButton(spec: ButtonSpec): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.code = spec.code;
    button.textContent = spec.label;
    button.style.width = `${TOUCH_BUTTON_SIZE}px`;
    button.style.height = `${TOUCH_BUTTON_SIZE}px`;
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
