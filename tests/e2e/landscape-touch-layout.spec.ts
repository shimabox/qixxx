import { expect, test, devices, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:4173/';
const evidenceDir = process.env.E2E_EVIDENCE_DIR;

async function expectLayout(page: Page, layout: 'bottom' | 'side'): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-touch-layout', layout);
}

async function expectVisibleButtonsWithPositiveGeometry(
  page: Page,
  selector: string,
  count: number,
): Promise<void> {
  const buttons = page.locator(selector);
  await expect(buttons).toHaveCount(count);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  }
}

async function expectSideGeometry(page: Page): Promise<void> {
  await expectVisibleButtonsWithPositiveGeometry(page, '#touch-dpad button', 4);
  await expectVisibleButtonsWithPositiveGeometry(
    page,
    '#touch-actions > div:first-child button',
    2,
  );
  await expect(page.locator('#hud-line1')).toBeVisible();
  await expect(page.locator('#hud-line2')).toBeVisible();
  await expect(page.locator('#hud-line3')).toBeVisible();
  await expect(page.locator('#credit-link')).toBeVisible();
  await expect(page.locator('#mute-button')).toBeVisible();

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const dpad = rect('#touch-dpad');
    const canvas = rect('#game-canvas');
    const actions = rect('#touch-actions');
    const lines = [...document.querySelectorAll<HTMLElement>('#hud-line1, #hud-line2, #hud-line3')];
    return {
      dpadRight: dpad.right,
      canvasLeft: canvas.left,
      canvasRight: canvas.right,
      canvasTop: canvas.top,
      canvasBottom: canvas.bottom,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      actionsLeft: actions.left,
      actionClusterBottom: document.querySelector('#touch-actions > div')!.getBoundingClientRect()
        .bottom,
      actionsExtraTop: document.querySelector('#touch-actions-extra')!.getBoundingClientRect().top,
      canvasCenterX: canvas.left + canvas.width / 2,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      linesUnclipped: lines.every((line) => line.scrollWidth <= line.clientWidth),
      hudChildren: [...document.querySelector('#hud-row')!.children].map((child) => child.id),
      actionsContainExtras:
        document
          .querySelector('#touch-actions')!
          .contains(document.querySelector('#credit-link')) &&
        document.querySelector('#touch-actions')!.contains(document.querySelector('#mute-button')),
    };
  });

  expect(geometry.dpadRight).toBeLessThan(geometry.canvasLeft);
  expect(geometry.canvasRight).toBeLessThan(geometry.actionsLeft);
  expect(geometry.actionsExtraTop).toBeGreaterThanOrEqual(geometry.actionClusterBottom);
  expect(Math.abs(geometry.canvasCenterX - geometry.viewportWidth / 2)).toBeLessThanOrEqual(2);
  expect(geometry.canvasWidth).toBeGreaterThan(0);
  expect(geometry.canvasHeight).toBeGreaterThan(0);
  expect(geometry.canvasLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.canvasTop).toBeGreaterThanOrEqual(0);
  expect(geometry.canvasRight).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.canvasBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.linesUnclipped).toBe(true);
  expect(geometry.hudChildren).toEqual(['hud']);
  expect(geometry.actionsContainExtras).toBe(true);
}

test.describe('Pixel 5 landscape touch layout', () => {
  const { defaultBrowserType: _defaultBrowserType, ...pixel5Landscape } =
    devices['Pixel 5 landscape'];
  test.use({ ...pixel5Landscape });

  test('places the field between non-overlapping side controls', async ({ page }) => {
    await page.goto(APP_URL);
    await expectLayout(page, 'side');
    await expectSideGeometry(page);
    if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/pixel-5-landscape.png` });
  });

  test('tracks landscape, portrait, and landscape changes on one page', async ({ page }) => {
    await page.goto(APP_URL);
    await expectLayout(page, 'side');
    await expectSideGeometry(page);

    await page.setViewportSize({ width: 393, height: 727 });
    await expectLayout(page, 'bottom');
    await expect(page.locator('#hud-row')).toHaveCount(1);
    expect(
      await page
        .locator('#hud-row > *')
        .evaluateAll((children) => children.map((child) => child.id))
    ).toEqual(['hud', 'credit-link', 'mute-button']);

    await page.setViewportSize({ width: 802, height: 293 });
    await expectLayout(page, 'side');
    await expectSideGeometry(page);
  });
});

test.describe('Pixel 5 portrait touch layout', () => {
  const { defaultBrowserType: _defaultBrowserType, ...pixel5 } = devices['Pixel 5'];
  test.use({ ...pixel5 });

  test('keeps controls below the field and HUD extras in their original order', async ({
    page,
  }) => {
    await page.goto(APP_URL);
    await expectLayout(page, 'bottom');
    await expect(page.locator('#touch-controls button')).toHaveCount(6);

    const positions = await page.evaluate(() => ({
      canvasBottom: document.querySelector('#game-canvas')!.getBoundingClientRect().bottom,
      controlsTop: document.querySelector('#touch-controls')!.getBoundingClientRect().top,
      hudChildren: [...document.querySelector('#hud-row')!.children].map((child) => child.id),
    }));
    expect(positions.controlsTop).toBeGreaterThanOrEqual(positions.canvasBottom);
    expect(positions.hudChildren).toEqual(['hud', 'credit-link', 'mute-button']);
    if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/pixel-5-portrait.png` });
  });
});

test('keeps touch controls hidden on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(APP_URL);
  await expectLayout(page, 'bottom');
  await expect(page.locator('#touch-controls')).toBeHidden();
});
