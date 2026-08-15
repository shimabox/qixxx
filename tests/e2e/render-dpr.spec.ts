// Regression coverage for the fractional-devicePixelRatio cell-fill seam fix
// (src/render/renderer.ts's buildCellBoundaries()/cellBoundaries, 2026-08-15).
//
// The bug only showed up *inside the canvas's own physical pixels* at
// fractional DPR values (e.g. 1.875, 2.2 — real values from Windows display
// scaling and some Android devices), never at integer DPR (1.0, 2.0) — and
// it was invisible to every other e2e test here, since none of them inspect
// canvas pixel data (they only assert on the DOM/HUD). A plain screenshot
// diff would also be too brittle/slow for this suite's "smoke, not
// gameplay regression" scope (docs/plan.md §7.2), so this instead pokes a
// solid CLAIMED_FAST block directly onto the live Field (bypassing
// gameplay) and inspects the rendered pixels of its interior via
// getImageData() — the same technique used to diagnose and verify the fix
// itself. A single fill color inside that interior (away from its own
// edges) means no seam; more than one means the bug is back.
import { test, expect } from '@playwright/test';

// Minimal shape of the window.__game__ debug hook main.ts publishes
// (docs/plan.md §7.2), extended with the Field accessor this suite pokes
// directly (mirroring smoke.spec.ts's own local declaration — kept
// independent so this file stays a black-box consumer of the built app).
declare global {
  interface Window {
    __game__?: {
      session: {
        getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
        getGame: () => {
          getField: () => {
            getWidth: () => number;
            getHeight: () => number;
            set: (p: { x: number; y: number }, state: number) => void;
          };
        };
      };
    };
  }
}

const APP_URL = 'http://localhost:4173/';

// Mirrors src/core/field.ts's CLAIMED_FAST = 1 (a stable numeric CellState
// encoding, part of the exported CellState union). Hardcoded rather than
// imported so this suite stays a black-box consumer of the built app, like
// every other file under tests/e2e/ — the actual Field instance behind
// window.__game__ is real at runtime regardless of this file's own types.
const CLAIMED_FAST = 1;

// Mirrors src/config.ts's RENDER_SCALE (logical canvas px per grid cell).
const RENDER_SCALE = 4;

// Pokes a solid interior rectangle of CLAIMED_FAST cells directly onto the
// live Field (rows/cols 5..24 x 5..54 — comfortably inside the field's
// BORDER ring on every side), waits a frame for the render loop to pick it
// up, then samples the *interior* of that rectangle's rendered pixels (a
// 1-cell margin in from the rectangle's own edges, to dodge the legitimate
// color change at the claimed/unclaimed boundary — the seam bug this guards
// against only ever appeared *between same-color adjacent cells*, i.e.
// strictly inside a fill, never at its outer edge). Returns the count of
// distinct RGBA colors found in that sample: 1 means a clean, seamless
// fill; >1 means the fractional-DPR seam bug has regressed.
async function claimedFillDistinctColorCount(page: import('@playwright/test').Page): Promise<number> {
  await page.goto(APP_URL);
  await page.keyboard.press('Space'); // Title -> Playing
  await expect.poll(() => page.evaluate(() => window.__game__?.session.getStatus())).toBe('playing');

  const rect = await page.evaluate((claimedFast) => {
    const field = window.__game__!.session.getGame().getField();
    const width = field.getWidth();
    const height = field.getHeight();
    const x0 = 5;
    const x1 = Math.min(55, width - 5);
    const y0 = 5;
    const y1 = Math.min(25, height - 5);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        field.set({ x, y }, claimedFast);
      }
    }
    return { x0, x1, y0, y1 };
  }, CLAIMED_FAST);

  // One rendered frame is enough: main.ts's rAF loop redraws the whole
  // field (drawImage of the background layer + a full drawField() scan)
  // every frame regardless of what changed, so the very next frame after
  // the Field mutation above already reflects it.
  await page.waitForTimeout(100);

  return page.evaluate(
    ({ x0, x1, y0, y1, renderScale }) => {
      const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const dpr = window.devicePixelRatio;

      // 1-cell margin inside the claimed block, in logical (pre-dpr) canvas
      // coordinates, then converted to physical (internal) canvas pixels by
      // multiplying by dpr and rounding — matching how the renderer's own
      // ctx.scale(dpr, dpr) maps logical draws onto physical pixels.
      const logicalX0 = (x0 + 1) * renderScale;
      const logicalX1 = (x1 - 1) * renderScale;
      const logicalY0 = (y0 + 1) * renderScale;
      const logicalY1 = (y1 - 1) * renderScale;

      const px0 = Math.round(logicalX0 * dpr);
      const py0 = Math.round(logicalY0 * dpr);
      const pw = Math.round(logicalX1 * dpr) - px0;
      const ph = Math.round(logicalY1 * dpr) - py0;

      const { data } = ctx.getImageData(px0, py0, pw, ph);
      const colors = new Set<string>();
      for (let i = 0; i < data.length; i += 4) {
        colors.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
      }
      return colors.size;
    },
    { x0: rect.x0, x1: rect.x1, y0: rect.y0, y1: rect.y1, renderScale: RENDER_SCALE }
  );
}

// DPR 1.875/2.2 are the fractional values that showed the seam pre-fix; DPR
// 2.0 is a control (an integer DPR the bug never affected) so a failure
// here would flag a broader regression rather than a fractional-DPR-only
// one.
for (const dpr of [1.875, 2.2, 2.0]) {
  test.describe(`devicePixelRatio ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test('claimed-area fill interior renders as a single solid color (no seam)', async ({ page }) => {
      expect(await claimedFillDistinctColorCount(page)).toBe(1);
    });
  });
}
