import { devices, expect, test, type CDPSession, type Page } from '@playwright/test';

declare global {
  interface Window {
    __keyLog: Array<{ type: string; code: string }>;
  }
}

const APP_URL = 'http://localhost:4173/';
const evidenceDir = process.env.E2E_EVIDENCE_DIR;
const MOVEMENT_CODES = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

interface TouchPoint {
  x: number;
  y: number;
  id: number;
}

async function installKeyLog(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__keyLog = [];
    window.addEventListener('keydown', (event) => {
      window.__keyLog.push({ type: event.type, code: event.code });
    });
    window.addEventListener('keyup', (event) => {
      window.__keyLog.push({ type: event.type, code: event.code });
    });
  });
}

async function keyLog(page: Page): Promise<Array<{ type: string; code: string }>> {
  return page.evaluate(() => window.__keyLog);
}

async function clearKeyLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__keyLog = [];
  });
}

async function dispatchTouch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  touchPoints: TouchPoint[],
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
}

async function tap(cdp: CDPSession, point: TouchPoint): Promise<void> {
  await dispatchTouch(cdp, 'touchStart', [point]);
  await dispatchTouch(cdp, 'touchEnd', []);
}

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

async function expectLayout(page: Page, layout: 'bottom' | 'side'): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-touch-layout', layout);
}

test.describe('Pixel 5 portrait d-pad hit area', () => {
  const { defaultBrowserType: _defaultBrowserType, ...pixel5 } = devices['Pixel 5'];
  test.use({ ...pixel5 });

  test.beforeEach(async ({ page }) => {
    await installKeyLog(page);
    await page.goto(APP_URL);
  });

  test('accepts a tap above the visible up circle', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const box = await page.locator('#touch-dpad button[data-code="ArrowUp"]').boundingBox();
    expect(box).not.toBeNull();
    await tap(cdp, { x: box!.x + box!.width / 2, y: box!.y - 8, id: 1 });
    expect(await keyLog(page)).toEqual([
      { type: 'keydown', code: 'ArrowUp' },
      { type: 'keyup', code: 'ArrowUp' },
    ]);
  });

  test('resolves empty space between up and left by angle', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const dpad = await centre(page, '#touch-dpad');

    await tap(cdp, { x: dpad.x - 30, y: dpad.y - 50, id: 1 });
    expect(await keyLog(page)).toEqual([
      { type: 'keydown', code: 'ArrowUp' },
      { type: 'keyup', code: 'ArrowUp' },
    ]);

    await clearKeyLog(page);
    await tap(cdp, { x: dpad.x - 50, y: dpad.y - 30, id: 2 });
    expect(await keyLog(page)).toEqual([
      { type: 'keydown', code: 'ArrowLeft' },
      { type: 'keyup', code: 'ArrowLeft' },
    ]);
  });

  test('does not dispatch movement from the centre dead zone', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const dpad = await centre(page, '#touch-dpad');
    await tap(cdp, { ...dpad, id: 1 });
    expect((await keyLog(page)).filter(({ code }) => MOVEMENT_CODES.includes(code))).toEqual([]);
  });

  test('switches direction in keyup then keydown order while sliding', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const up = await centre(page, '#touch-dpad button[data-code="ArrowUp"]');
    const right = await centre(page, '#touch-dpad button[data-code="ArrowRight"]');
    await dispatchTouch(cdp, 'touchStart', [{ ...up, id: 1 }]);
    await dispatchTouch(cdp, 'touchMove', [{ ...right, id: 1 }]);
    await dispatchTouch(cdp, 'touchEnd', []);
    expect(await keyLog(page)).toEqual([
      { type: 'keydown', code: 'ArrowUp' },
      { type: 'keyup', code: 'ArrowUp' },
      { type: 'keydown', code: 'ArrowRight' },
      { type: 'keyup', code: 'ArrowRight' },
    ]);
  });

  test('ignores a second d-pad pointer until the owner is released', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const up = await centre(page, '#touch-dpad button[data-code="ArrowUp"]');
    const right = await centre(page, '#touch-dpad button[data-code="ArrowRight"]');
    const first = { ...up, id: 1 };
    const second = { ...right, id: 2 };

    await dispatchTouch(cdp, 'touchStart', [first]);
    await dispatchTouch(cdp, 'touchStart', [first, second]);
    await dispatchTouch(cdp, 'touchEnd', [second]);
    expect(await keyLog(page)).toEqual([{ type: 'keydown', code: 'ArrowUp' }]);
    await dispatchTouch(cdp, 'touchEnd', [first]);
    expect(await keyLog(page)).toEqual([
      { type: 'keydown', code: 'ArrowUp' },
      { type: 'keyup', code: 'ArrowUp' },
    ]);
  });

  test('supports d-pad and FAST with separate simultaneous pointers', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const up = await centre(page, '#touch-dpad button[data-code="ArrowUp"]');
    const fast = await centre(page, '#touch-actions button[data-code="Space"]');
    const first = { ...up, id: 1 };
    const second = { ...fast, id: 2 };
    await dispatchTouch(cdp, 'touchStart', [first]);
    await dispatchTouch(cdp, 'touchStart', [first, second]);
    const downs = (await keyLog(page)).filter(({ type }) => type === 'keydown');
    expect(downs).toContainEqual({ type: 'keydown', code: 'ArrowUp' });
    expect(downs).toContainEqual({ type: 'keydown', code: 'Space' });
    await dispatchTouch(cdp, 'touchEnd', [first]);
    await dispatchTouch(cdp, 'touchEnd', []);
  });

  test('keeps the expanded hit area below the canvas in bottom mode', async ({ page }) => {
    await expectLayout(page, 'bottom');
    const geometry = await page.evaluate(() => {
      const dpad = document.querySelector('#touch-dpad')!.getBoundingClientRect();
      const canvas = document.querySelector('#game-canvas')!.getBoundingClientRect();
      const margin = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--touch-dpad-hit-margin'),
      );
      return { hitTop: dpad.top - margin, canvasBottom: canvas.bottom };
    });
    expect(geometry.hitTop).toBeGreaterThanOrEqual(geometry.canvasBottom);
    if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/dpad-pixel-5-portrait.png` });
  });
});

test.describe('Pixel 5 landscape d-pad hit area', () => {
  const { defaultBrowserType: _defaultBrowserType, ...pixel5Landscape } =
    devices['Pixel 5 landscape'];
  test.use({ ...pixel5Landscape });

  test('stays clear of the canvas in side mode', async ({ page }) => {
    await page.goto(APP_URL);
    await expectLayout(page, 'side');
    const geometry = await page.evaluate(() => {
      const dpad = document.querySelector('#touch-dpad')!.getBoundingClientRect();
      const canvas = document.querySelector('#game-canvas')!.getBoundingClientRect();
      const margin = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--touch-dpad-hit-margin'),
      );
      return { hitRight: dpad.right + margin, canvasLeft: canvas.left };
    });
    expect(geometry.hitRight).toBeLessThanOrEqual(geometry.canvasLeft);
    if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/dpad-pixel-5-landscape.png` });
  });
});

test.describe('side layout minimum width', () => {
  test.use({ viewport: { width: 704, height: 300 }, hasTouch: true, isMobile: true });

  test('uses side at 704px without extending the d-pad over the canvas', async ({ page }) => {
    await installKeyLog(page);
    await page.goto(APP_URL);
    await expectLayout(page, 'side');
    const geometry = await page.evaluate(() => {
      const dpad = document.querySelector('#touch-dpad')!.getBoundingClientRect();
      const canvas = document.querySelector('#game-canvas')!.getBoundingClientRect();
      const margin = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--touch-dpad-hit-margin'),
      );
      return { hitRight: dpad.right + margin, canvasLeft: canvas.left };
    });
    expect(geometry.hitRight).toBeLessThanOrEqual(geometry.canvasLeft);

    const cdp = await page.context().newCDPSession(page);
    await tap(cdp, { x: geometry.canvasLeft + 2, y: 150, id: 1 });
    expect((await keyLog(page)).filter(({ code }) => MOVEMENT_CODES.includes(code))).toEqual([]);
    if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/dpad-704x300.png` });

    await page.setViewportSize({ width: 703, height: 300 });
    await expectLayout(page, 'bottom');
  });
});
