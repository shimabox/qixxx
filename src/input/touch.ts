// Virtual touch controls (docs/plan.md §5.2/§12.1/§12.8): a d-pad on the
// left plus FAST/SLOW buttons on the right, built as plain DOM elements.
// Portrait uses a bottom row; sufficiently wide touch landscapes use side
// columns so the field can consume the viewport height. DOM-dependent by
// design, exactly like input/keyboard.ts.
//
// GB-style left/right split (docs/plan.md §12.1 "タッチパッドのGB風左右
// 分離"): the d-pad and the FAST/SLOW cluster are two independent groups
// placed at opposite ends of a flex row in bottom mode and in the body
// grid's left/right columns in side mode. Both layouts leave the field clear
// between the groups, avoiding the mis-taps caused by placing them together
// near the center; side mode fixes the credit and MUTE extras in the viewport's
// top-right corner. Within the action cluster, FAST/SLOW are placed on the
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
// Multi-touch (docs/plan.md §5.2 "移動 + ボタン同時押しが必須要件"): the
// d-pad has one owning pointer while FAST/SLOW remain independent button
// targets. This prevents a second movement finger from changing direction
// without interfering with simultaneous movement + action input.
import { MOVE_KEYS, DRAW_FAST_KEYS, DRAW_SLOW_KEYS } from './keys';
import {
  TOUCH_BUTTON_SIZE,
  TOUCH_DPAD_DEAD_ZONE_RADIUS,
  TOUCH_DPAD_GAP,
  TOUCH_DPAD_HIT_MARGIN,
  TOUCH_SIDE_COLUMN_PADDING,
  TOUCH_SIDE_MIN_FIELD_WIDTH,
} from '../config';

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
const SIDE_PADDING = Math.max(TOUCH_SIDE_COLUMN_PADDING, TOUCH_DPAD_HIT_MARGIN);
const SIDE_COLUMN_WIDTH =
  TOUCH_BUTTON_SIZE * 3 + TOUCH_DPAD_GAP * 2 + SIDE_PADDING * 2;

export type DpadDirection = 'up' | 'down' | 'left' | 'right';

export interface DpadTransition {
  keyup: DpadDirection | null;
  keydown: DpadDirection | null;
}

/** Resolve a point relative to the d-pad centre into one cardinal direction. */
export function resolveDpadDirection(
  dx: number,
  dy: number,
  deadZoneRadius: number,
): DpadDirection | null {
  if (Math.hypot(dx, dy) <= deadZoneRadius) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

/** Tracks the single pointer allowed to own and steer the d-pad. */
export class DpadPointerState {
  private ownerId: number | null = null;
  private direction: DpadDirection | null = null;

  isOwner(pointerId: number): boolean {
    return pointerId === this.ownerId;
  }

  down(pointerId: number, direction: DpadDirection | null): DpadTransition | null {
    if (this.ownerId !== null) return null;
    this.ownerId = pointerId;
    this.direction = direction;
    return direction === null ? null : { keyup: null, keydown: direction };
  }

  move(pointerId: number, direction: DpadDirection | null): DpadTransition | null {
    if (pointerId !== this.ownerId || direction === this.direction) return null;
    const transition = { keyup: this.direction, keydown: direction };
    this.direction = direction;
    return transition;
  }

  up(pointerId: number): DpadTransition | null {
    if (pointerId !== this.ownerId) return null;
    const direction = this.direction;
    this.ownerId = null;
    this.direction = null;
    return direction === null ? null : { keyup: direction, keydown: null };
  }
}

export type TouchLayout = 'bottom' | 'side';

export interface TouchLayoutInput {
  touchCapable: boolean;
  viewportWidth: number;
  viewportHeight: number;
}

/** Resolve touch layout solely from the current device and viewport geometry. */
export function resolveTouchLayout({
  touchCapable,
  viewportWidth,
  viewportHeight,
}: TouchLayoutInput): TouchLayout {
  return touchCapable &&
    viewportWidth > viewportHeight &&
    viewportWidth - 2 * SIDE_COLUMN_WIDTH >= TOUCH_SIDE_MIN_FIELD_WIDTH
    ? 'side'
    : 'bottom';
}

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
    this.container.appendChild(this.buildDpad());
    this.container.appendChild(this.buildActions());
    parent.appendChild(this.container);
    document.documentElement.style.setProperty('--touch-side-w', `${SIDE_COLUMN_WIDTH}px`);
    document.documentElement.style.setProperty(
      '--touch-side-pad',
      `${SIDE_PADDING}px`,
    );
    document.documentElement.style.setProperty(
      '--touch-dpad-hit-margin',
      `${TOUCH_DPAD_HIT_MARGIN}px`,
    );
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
    el.style.touchAction = 'none';
    el.style.userSelect = 'none';
    // Shown only on touch-capable devices (docs/plan.md §5.2); harmless if
    // shown on desktop too, but we default to hiding it there to avoid
    // cluttering a mouse+keyboard session, per the media-query check below.
    // JS re-check backs up the CSS media query for environments (like some
    // automated test harnesses) where `(pointer: coarse)` isn't reported but
    // touch is still emulated.
    if (!isTouchCapableDevice()) el.style.display = 'none';
    return el;
  }

  // The d-pad: a 3x3 grid with the corners left empty, giving a compact
  // "+"-shaped cluster pinned to the container's left edge.
  private buildDpad(): HTMLDivElement {
    const el = document.createElement('div');
    el.id = 'touch-dpad';
    el.style.display = 'grid';
    el.style.gridTemplateAreas = "'. up .' 'left . right' '. down .'";
    el.style.gridTemplateColumns = `repeat(3, ${TOUCH_BUTTON_SIZE}px)`;
    el.style.gridTemplateRows = `repeat(3, ${TOUCH_BUTTON_SIZE}px)`;
    el.style.columnGap = `${TOUCH_DPAD_GAP}px`;
    el.style.rowGap = `${TOUCH_DPAD_GAP}px`;
    el.style.flex = '0 0 auto';
    const buttons = new Map<DpadDirection, HTMLButtonElement>();
    for (const spec of DPAD_BUTTONS) {
      const button = this.buildButtonElement(spec);
      button.style.gridArea = spec.gridArea;
      el.appendChild(button);
      buttons.set(spec.gridArea as DpadDirection, button);
    }

    const state = new DpadPointerState();
    const directionAt = (event: PointerEvent): DpadDirection | null => {
      const rect = el.getBoundingClientRect();
      return resolveDpadDirection(
        event.clientX - (rect.left + rect.width / 2),
        event.clientY - (rect.top + rect.height / 2),
        TOUCH_DPAD_DEAD_ZONE_RADIUS,
      );
    };
    const isInsideHitArea = (event: PointerEvent): boolean => {
      const rect = el.getBoundingClientRect();
      return (
        event.clientX >= rect.left - TOUCH_DPAD_HIT_MARGIN &&
        event.clientX <= rect.right + TOUCH_DPAD_HIT_MARGIN &&
        event.clientY >= rect.top - TOUCH_DPAD_HIT_MARGIN &&
        event.clientY <= rect.bottom + TOUCH_DPAD_HIT_MARGIN
      );
    };
    const applyTransition = (transition: DpadTransition | null): void => {
      if (!transition) return;
      if (transition.keyup) {
        buttons.get(transition.keyup)!.style.background = 'rgba(10, 14, 39, 0.7)';
        this.dispatch('keyup', MOVE_KEYS[transition.keyup][0]);
      }
      if (transition.keydown) {
        buttons.get(transition.keydown)!.style.background = 'rgba(0, 255, 65, 0.35)';
        this.dispatch('keydown', MOVE_KEYS[transition.keydown][0]);
      }
    };
    const onDown = (event: PointerEvent): void => {
      event.preventDefault();
      const transition = state.down(event.pointerId, directionAt(event));
      // A dead-zone press owns the d-pad even though it has no transition.
      if (state.isOwner(event.pointerId)) el.setPointerCapture(event.pointerId);
      applyTransition(transition);
    };
    const onMove = (event: PointerEvent): void => {
      event.preventDefault();
      if (!isInsideHitArea(event)) return;
      applyTransition(state.move(event.pointerId, directionAt(event)));
    };
    const onUp = (event: PointerEvent): void => {
      event.preventDefault();
      applyTransition(state.up(event.pointerId));
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('contextmenu', (event) => event.preventDefault());
    this.disposers.push(() => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    });
    return el;
  }

  private buildActions(): HTMLDivElement {
    const actions = document.createElement('div');
    actions.id = 'touch-actions';
    actions.appendChild(this.buildActionCluster());

    const extra = document.createElement('div');
    extra.id = 'touch-actions-extra';
    actions.appendChild(extra);
    return actions;
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
      const button = this.buildActionButton(spec);
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

  private buildButtonElement(spec: ButtonSpec): HTMLButtonElement {
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

    return button;
  }

  private buildActionButton(spec: ButtonSpec): HTMLButtonElement {
    const button = this.buildButtonElement(spec);
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
