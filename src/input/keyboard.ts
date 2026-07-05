// Keyboard input handling. DOM-dependent by design — this is the only layer
// (besides render/ and main.ts) allowed to touch the DOM (docs/plan.md §4.4).
import { SessionInput } from '../core/session';
import { MOVE_KEYS, DRAW_FAST_KEYS, DRAW_SLOW_KEYS, isTrackedKey } from './keys';

export class KeyboardInput {
  private pressed = new Set<string>();
  private pressOrder: string[] = [];
  // Edge-triggered "any key" pulse (docs/plan.md §4.4): set on any key that
  // transitions from up to down, consumed (and cleared) the next time
  // getInput() is called, so holding a key down doesn't fire more than one
  // Title/StageClear/GameOver transition (see SessionInput.confirm).
  private confirmPending = false;
  private target: EventTarget;

  constructor(target: EventTarget = window) {
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (event: Event): void => {
    const code = (event as KeyboardEvent).code;
    if (!this.pressed.has(code)) {
      this.pressed.add(code);
      this.pressOrder.push(code);
      this.confirmPending = true;
    }
    // Prevent the page from scrolling on arrow keys / space while playing.
    if (isTrackedKey(code)) {
      event.preventDefault();
    }
  };

  private onKeyUp = (event: Event): void => {
    const code = (event as KeyboardEvent).code;
    this.pressed.delete(code);
    this.pressOrder = this.pressOrder.filter((c) => c !== code);
  };

  /**
   * Resolves the current key state into a single 4-directional move (the
   * most recently pressed direction key wins if multiple are held) plus
   * whether a fast-line button is held, plus the edge-triggered `confirm`
   * signal (docs/plan.md §4.4) for the Title/StageClear/GameOver screens.
   */
  getInput(): SessionInput {
    let dx: SessionInput['dx'] = 0;
    let dy: SessionInput['dy'] = 0;

    for (let i = this.pressOrder.length - 1; i >= 0; i--) {
      const code = this.pressOrder[i];
      if ((MOVE_KEYS.up as readonly string[]).includes(code)) {
        dy = -1;
        break;
      }
      if ((MOVE_KEYS.down as readonly string[]).includes(code)) {
        dy = 1;
        break;
      }
      if ((MOVE_KEYS.left as readonly string[]).includes(code)) {
        dx = -1;
        break;
      }
      if ((MOVE_KEYS.right as readonly string[]).includes(code)) {
        dx = 1;
        break;
      }
    }

    const fastHeld = DRAW_FAST_KEYS.some((code) => this.pressed.has(code));
    const slowHeld = DRAW_SLOW_KEYS.some((code) => this.pressed.has(code));
    // Both held at once (rare) resolves to fast, matching the "X/Space wins" tie-break.
    const drawHeld = fastHeld || slowHeld;
    const slow = slowHeld && !fastHeld;

    const confirm = this.confirmPending;
    this.confirmPending = false;

    return { dx, dy, drawHeld, slow, confirm };
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
  }
}
