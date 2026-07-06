// KeyboardEvent.code values shared between input/keyboard.ts and
// input/touch.ts (docs/plan.md §5.1/§5.2). Pulled into their own module so
// the virtual touch pad can dispatch synthetic KeyboardEvents using exactly
// the same codes a real keyboard would send, instead of duplicating (and
// risking drifting from) the mapping.
export const MOVE_KEYS = {
  up: ['ArrowUp', 'KeyK'],
  down: ['ArrowDown', 'KeyJ'],
  left: ['ArrowLeft', 'KeyH'],
  right: ['ArrowRight', 'KeyL'],
} as const;

// §5.1: X or Space draws a fast line; Z or Shift draws a slow line. The
// touch UI's FAST/SLOW buttons (§5.2) dispatch the first code in each list.
export const DRAW_FAST_KEYS = ['Space', 'KeyX'] as const;
export const DRAW_SLOW_KEYS = ['KeyZ', 'ShiftLeft', 'ShiftRight'] as const;

export function isTrackedKey(code: string): boolean {
  return (
    Object.values(MOVE_KEYS).some((keys) => (keys as readonly string[]).includes(code)) ||
    (DRAW_FAST_KEYS as readonly string[]).includes(code) ||
    (DRAW_SLOW_KEYS as readonly string[]).includes(code)
  );
}
