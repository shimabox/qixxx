// The Title menu (src/ui/titleMenu.ts): HOW TO PLAY, RANKING and MODE in one
// row of underlined text under the title text — where it goes on each
// screen, what it keeps clear of, that it follows the title text, what a
// press on it does, the keys, and the row while the ranking list is open.
//
// Everything runs on a faked page clock (tests/e2e/support/fakeClock.ts), so
// budgets are game time. Layouts are checked by boxes against boxes — no
// pixel constant of a font.
import { test, expect, type Browser, type Page } from '@playwright/test';
import { GameSession } from '../../src/core/session';
import { encodeRle, type InputSample } from '../../src/core/rle';
import {
  RULESET_VERSION,
  REPLAY_FORMAT_VERSION,
  TITLE_MENU_BELOW_GAP_PX,
  TITLE_MENU_FONT_PX,
  TITLE_MENU_GAP_PX,
  TITLE_MENU_INSET_PX,
  TITLE_MENU_MIN_TARGET_PX,
} from '../../src/config';
import { advanceUntil, finishGameOverResult } from './support/fakeClock';
import {
  MENU_BUTTONS,
  actualPlacement,
  box,
  demoReserve,
  expectedPlacement,
  fitsBelowField,
  fitsUnderText,
  hitAt,
  inside,
  menuLook,
  mustAvoid,
  overlaps,
  titleLayout,
  type Box,
  type TitleLayout,
} from './support/titleMenu';

type Hook = {
  session: {
    getStatus: () => 'title' | 'playing' | 'stageclear' | 'gameover';
    getTotalTicks: () => number;
    setDebugTimeLimitTicks: (ticks: number) => void;
  };
  fx: { tick: () => void };
  getConfirmCount: () => number;
  getTitleDemo: () => { state: string; shown: boolean };
};

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const FRAME_MS = 16;
const TICK_MS = 1000 / 60;
const GUARD_TICKS = 24; // RETRY_CONFIRM_GUARD_TICKS

const g = <T>(page: Page, fn: (h: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__game__)`) as Promise<T>;
const status = (page: Page) => g(page, (h) => h.session.getStatus());
const confirms = (page: Page) => g(page, (h) => h.getConfirmCount());
const toggle = (page: Page) => page.locator('#difficulty-button');

async function open(page: Page, query = ''): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(`${APP_URL}${query}`);
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.clock.runFor(100);
  await advanceUntil(page, () => page.evaluate(() => Boolean((window as unknown as { __game__?: Hook }).__game__)), 2_000, 100);
  // Counts the live ticks (main.ts calls fx.tick() once per live tick).
  await page.evaluate(() => {
    const h = (window as unknown as { __game__: Hook }).__game__;
    const probe = { ticks: 0 };
    const tick = h.fx.tick.bind(h.fx);
    h.fx.tick = () => {
      probe.ticks++;
      tick();
    };
    (window as unknown as { __probe__: typeof probe }).__probe__ = probe;
  });
}

const ticks = (page: Page) => page.evaluate(() => (window as unknown as { __probe__: { ticks: number } }).__probe__.ticks);

/** Advances the clock a frame at a time until at least one more tick has run. */
async function runOneTick(page: Page): Promise<void> {
  const before = await ticks(page);
  await advanceUntil(page, async () => (await ticks(page)) > before, 10 * FRAME_MS, FRAME_MS);
}

// ---------------------------------------------------------------------------
// A board whose top row has a replay: the Title demo plays it (with the DEMO
// tag up), and RANKING lists it with REPLAY.

function recordDemoReplay(seed: number, maxSamples: number): string {
  const session = new GameSession({ seed });
  const confirm = { dx: 0 as const, dy: 0 as const, drawHeld: false, slow: false, confirm: true };
  session.update(confirm);
  const samples: InputSample[] = [];
  const step = (dx: -1 | 0 | 1, dy: -1 | 0 | 1, drawHeld: boolean): void => {
    samples.push({ dx, dy, drawHeld, slow: false });
    session.update({ dx, dy, drawHeld, slow: false, confirm: false });
    session.drainEvents();
    session.drainDespawnedEmberPositions();
  };
  const height = session.getGame().getField().getHeight();
  let goingDown = true;
  while (session.getStatus() !== 'gameover' && samples.length < maxSamples) {
    if (session.getStatus() === 'stageclear') {
      session.update(confirm);
      continue;
    }
    const targetY = goingDown ? height - 1 : 0;
    let crossing = 0;
    while (
      session.getStatus() === 'playing' &&
      samples.length < maxSamples &&
      session.getGame().getMarker().getPosition().y !== targetY &&
      crossing++ < height + 5
    ) {
      step(0, goingDown ? 1 : -1, true);
    }
    for (let i = 0; i < 4 && session.getStatus() === 'playing' && samples.length < maxSamples; i++) step(1, 0, false);
    goingDown = !goingDown;
  }
  return Buffer.from(encodeRle(samples)).toString('base64');
}

const DEMO_PAYLOAD = JSON.stringify({
  seed: 377,
  rleBase64: recordDemoReplay(377, 600),
  rulesetVersion: RULESET_VERSION,
  replayFormatVersion: REPLAY_FORMAT_VERSION,
});

/** Mocks the board (row 0 with a replay); returns a counter of the board's GETs. */
async function mockBoardWithReplay(page: Page): Promise<{ reads: number }> {
  const counter = { reads: 0 };
  const entries = Array.from({ length: 10 }, (_, i) => ({
    id: `row${i}`,
    createdAt: '2026-01-01T12:00:00Z',
    score: 9000 - i * 100,
    stage: 2,
    name: `RIVAL${i}`,
    xHandle: null,
    replayAvailable: i === 0,
  }));
  await page.route('**/api/ranking', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    counter.reads += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seasonId: 1, rulesetVersion: RULESET_VERSION, entries, displayEntries: entries.map((e) => ({ ...e, status: 'verified' })) }),
    });
  });
  await page.route('**/api/ranking/*/replay', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: DEMO_PAYLOAD }));
  return counter;
}

async function untilDemoShown(page: Page): Promise<void> {
  await advanceUntil(page, async () => (await g(page, (h) => h.getTitleDemo().shown)) === true, 5_000, 100);
  await expect(page.locator('#title-demo-label')).toBeVisible();
}

interface Layout {
  name: string;
  viewport: { width: number; height: number };
  hasTouch: boolean;
}

async function pageFor(browser: Browser, layout: Layout, locale = 'en-US'): Promise<Page> {
  const context = await browser.newContext({ viewport: layout.viewport, hasTouch: layout.hasTouch, isMobile: false, locale });
  return context.newPage();
}

// ---------------------------------------------------------------------------
// Shared checks.

/** The three buttons left to right in one row: tops level, none over another, the row's box holding all three. */
function expectOneRow(l: TitleLayout, label: string): void {
  expect(l.buttons, label).toHaveLength(3);
  const [how, ranking, mode] = l.buttons;
  expect(Math.abs(how.top - ranking.top), `${label}: tops level`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(ranking.top - mode.top), `${label}: tops level`).toBeLessThanOrEqual(0.5);
  expect(how.right, `${label}: HOW TO PLAY left of RANKING`).toBeLessThanOrEqual(ranking.left + 0.5);
  expect(ranking.right, `${label}: RANKING left of MODE`).toBeLessThanOrEqual(mode.left + 0.5);
  for (const b of l.buttons) expect(inside(b, l.menu!), `${label}: in the row`).toBe(true);
}

/** Centred on the field, within a pixel. */
function expectCentred(l: TitleLayout, label: string): void {
  const centre = l.field.left + l.field.width / 2;
  expect(Math.abs(l.menu!.left + l.menu!.width / 2 - centre), `${label}: centred`).toBeLessThanOrEqual(1);
}

/** No border, no ground, underlined, at `fontPx`. */
async function expectQuietLook(page: Page, label: string, fontPx?: number): Promise<void> {
  for (const look of await menuLook(page)) {
    expect(look.borders, `${label}: no border`).toEqual(['0px', '0px', '0px', '0px']);
    expect(look.background, `${label}: no ground`).toBe('rgba(0, 0, 0, 0)');
    expect(look.backgroundImage, `${label}: no ground`).toBe('none');
    expect(look.decoration, `${label}: underlined`).toBe('underline');
    if (fontPx !== undefined) expect(look.fontPx, `${label}: text size`).toBe(fontPx);
  }
}

/** Clear of the DEMO tag, the HUD, SOUND, the credit and every touch control (seen boxes). */
function expectClearOfTheRest(l: TitleLayout, label: string): void {
  const others: [string, Box | null][] = [
    ['the DEMO tag', l.demo],
    ['the HUD', l.hud],
    ['SOUND', l.mute],
    ['the credit', l.credit],
  ];
  for (const [name, other] of others) {
    expect(other, `${label}: ${name} shown`).not.toBeNull();
    expect(overlaps(l.menu!, other!), `${label}: the row and ${name}`).toBe(false);
  }
  for (const control of l.touch) expect(overlaps(l.menu!, control), `${label}: the row and a touch control`).toBe(false);
}

/** Each button's middle (and the given extra points) land on that button. */
async function expectPressable(page: Page, l: TitleLayout, label: string, edges = false): Promise<void> {
  for (const [i, b] of l.buttons.entries()) {
    const id = MENU_BUTTONS[i].slice(1);
    const midY = b.top + b.height / 2;
    const points: [number, number][] = [[b.left + b.width / 2, midY]];
    if (edges) points.push([b.left + 1, midY], [b.right - 1, midY], [b.left + b.width / 2, b.bottom - 1]);
    for (const [x, y] of points) expect(await hitAt(page, x, y), `${label}: ${id} at (${x.toFixed(1)}, ${y.toFixed(1)})`).toBe(id);
  }
}

/** The row and its buttons as boxes, for "nothing moved". */
const rowBoxes = (l: TitleLayout) => [l.menu, ...l.buttons];

/** Flips MODE twice by a click and checks nothing in the row moves. */
async function expectToggleMovesNothing(page: Page, label: string, tap: boolean): Promise<void> {
  const before = rowBoxes(await titleLayout(page));
  for (const text of ['MODE: EASY', 'MODE: NORMAL']) {
    if (tap) await toggle(page).tap();
    else await toggle(page).click();
    await page.clock.runFor(100);
    await expect(toggle(page)).toHaveText(text);
    expect(rowBoxes(await titleLayout(page)), `${label}: ${text}`).toEqual(before);
  }
  expect(await status(page)).toBe('title');
}

/** The row's place is the first the rule allows, worked out here, and it sits where that place says. */
function expectRuleFollowed(l: TitleLayout, label: string, column = false): void {
  const placement = actualPlacement(l);
  expect(placement, `${label}: the first place that holds it`).toBe(expectedPlacement(l, column));
  if (placement === 'under-text') {
    expect(Math.abs(l.menu!.top - l.screen.bottom - TITLE_MENU_GAP_PX), `${label}: gap under the text`).toBeLessThanOrEqual(1);
    expect(overlaps(l.menu!, l.screen), `${label}: clear of the title text`).toBe(false);
    expect(inside(l.menu!, l.field), `${label}: on the field`).toBe(true);
  } else if (placement === 'below-field') {
    expect(fitsUnderText(l, column), `${label}: no room under the text`).toBe(false);
    expect(Math.abs(l.menu!.top - l.field.bottom - TITLE_MENU_BELOW_GAP_PX), `${label}: gap under the field`).toBeLessThanOrEqual(1);
    expect(overlaps(l.menu!, l.screen), `${label}: clear of the title text`).toBe(false);
  } else {
    expect(fitsUnderText(l, column), `${label}: no room under the text`).toBe(false);
    expect(fitsBelowField(l, column), `${label}: no room under the field`).toBe(false);
    expect(inside(l.menu!, l.field), `${label}: on the field`).toBe(true);
    // On the field's bottom inset, or raised just above a hit area reaching up there.
    let bottom = l.field.bottom - TITLE_MENU_INSET_PX;
    for (const a of mustAvoid(l)) {
      const at = box(l.menu!.left, bottom - l.menu!.height, l.menu!.width, l.menu!.height);
      if (overlaps(at, a)) bottom = Math.min(bottom, a.top);
    }
    expect(Math.abs(l.menu!.bottom - bottom), `${label}: along the field's bottom edge`).toBeLessThanOrEqual(1);
  }
  if (placement !== 'field-bottom') {
    for (const b of l.buttons) expect(b.height, `${label}: press target`).toBeGreaterThanOrEqual(TITLE_MENU_MIN_TARGET_PX);
  }
  for (const a of mustAvoid(l)) expect(overlaps(l.menu!, a), `${label}: clear of a hit area`).toBe(false);
  expect(inside(l.menu!, l.root), `${label}: unclipped`).toBe(true);
  expect(inside(l.menu!, l.viewport), `${label}: on screen`).toBe(true);
  expectCentred(l, label);
}

/** The DEMO tag in the field's bottom-left (or, with `top`, top-left) corner. */
function expectDemoCorner(l: TitleLayout, label: string, top: boolean): void {
  const d = l.demo!;
  expect(inside(d, l.field), `${label}: the DEMO tag on the field`).toBe(true);
  expect(d.left + d.width / 2, `${label}: the DEMO tag on the left`).toBeLessThan(l.field.left + l.field.width / 2);
  if (top) expect(d.top + d.height / 2, `${label}: the DEMO tag at the top`).toBeLessThan(l.field.top + l.field.height / 2);
  else expect(d.top + d.height / 2, `${label}: the DEMO tag at the bottom`).toBeGreaterThan(l.field.top + l.field.height / 2);
}

// ---------------------------------------------------------------------------

const UNDER_TEXT_LAYOUTS: Layout[] = [
  { name: '1280x800', viewport: { width: 1280, height: 800 }, hasTouch: false },
  { name: '390x844 touch', viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: '844x390 touch', viewport: { width: 844, height: 390 }, hasTouch: true },
];

for (const layout of UNDER_TEXT_LAYOUTS) {
  for (const lang of ['en', 'ja'] as const) {
    test(`under the title text at ${layout.name} (${lang}): one row of quiet text, centred, clear of the rest`, async ({ browser }) => {
      const page = await pageFor(browser, layout, lang === 'ja' ? 'ja-JP' : 'en-US');
      await mockBoardWithReplay(page);
      await open(page, `?lang=${lang}`);
      await untilDemoShown(page);
      const l = await titleLayout(page);
      const label = `${layout.name} ${lang}`;
      expectOneRow(l, label);
      expect(actualPlacement(l), label).toBe('under-text');
      expectRuleFollowed(l, label);
      expectClearOfTheRest(l, label);
      expectDemoCorner(l, label, false);
      for (const b of l.buttons) expect(b.height, label).toBeGreaterThanOrEqual(TITLE_MENU_MIN_TARGET_PX);
      await expectQuietLook(page, label, TITLE_MENU_FONT_PX);
      // Nothing around the field's four corners any more.
      const side = Math.min(l.field.width, l.field.height) / 6;
      const corners = [
        box(l.field.left, l.field.top, side, side),
        box(l.field.right - side, l.field.top, side, side),
        box(l.field.left, l.field.bottom - side, side, side),
        box(l.field.right - side, l.field.bottom - side, side, side),
      ];
      for (const b of l.buttons) for (const c of corners) expect(overlaps(b, c), `${label}: a button in a corner`).toBe(false);
      await expectPressable(page, l, label);
      await expectToggleMovesNothing(page, label, layout.hasTouch);
      await page.context().close();
    });
  }
}

test.describe('under the field at 667x375', () => {
  for (const lang of ['en', 'ja'] as const) {
    test(`(${lang}): one small row just under the field, whole and pressable, the title text centred on the field`, async ({ browser }) => {
      const page = await pageFor(browser, { name: '667x375', viewport: { width: 667, height: 375 }, hasTouch: true }, lang === 'ja' ? 'ja-JP' : 'en-US');
      await mockBoardWithReplay(page);
      await open(page, `?lang=${lang}`);
      await untilDemoShown(page);
      const l = await titleLayout(page);
      const label = `667x375 ${lang}`;
      expectOneRow(l, label);
      expect(actualPlacement(l), label).toBe('below-field');
      expect(Math.abs(l.menu!.top - l.field.bottom - TITLE_MENU_BELOW_GAP_PX), label).toBeLessThanOrEqual(1);
      expect(overlaps(l.menu!, l.screen), label).toBe(false);
      expectCentred(l, label);
      expectRuleFollowed(l, label);
      for (const b of l.buttons) expect(b.height, label).toBeGreaterThanOrEqual(TITLE_MENU_MIN_TARGET_PX);
      await expectQuietLook(page, label);
      expect(inside(l.menu!, l.root), `${label}: inside #game-root`).toBe(true);
      expect(inside(l.menu!, l.viewport), `${label}: on screen`).toBe(true);
      expectClearOfTheRest(l, label);
      // Neither clipped nor taken by a control's hit area, its bottom edge included.
      await expectPressable(page, l, label, true);
      // The title text on the field, centred on it (not lowered).
      expect(inside(l.screen, l.field), `${label}: the title text on the field`).toBe(true);
      expect(Math.abs(l.screen.top + l.screen.height / 2 - (l.field.top + l.field.height / 2)), `${label}: the title text centred`).toBeLessThanOrEqual(1);
      await expectToggleMovesNothing(page, label, true);
      await page.context().close();
    });
  }
});

test.describe('at the 200px field (731x375)', () => {
  for (const lang of ['en', 'ja'] as const) {
    test(`(${lang}): the first place the rule allows, whole, in one row, pressable`, async ({ browser }) => {
      const page = await pageFor(browser, { name: '731x375', viewport: { width: 731, height: 375 }, hasTouch: true }, lang === 'ja' ? 'ja-JP' : 'en-US');
      await mockBoardWithReplay(page);
      await open(page, `?lang=${lang}`);
      await untilDemoShown(page);
      const l = await titleLayout(page);
      const label = `731x375 ${lang}`;
      expectOneRow(l, label);
      expectRuleFollowed(l, label);
      expectClearOfTheRest(l, label);
      await expectPressable(page, l, label);
      test.info().annotations.push({ type: 'placement', description: `${label}: ${actualPlacement(l)}` });
      await expectToggleMovesNothing(page, label, true);
      await page.context().close();
    });
  }
});

test('on a very narrow centre column (568x320): the buttons stacked, whole, pressable, clear of the DEMO tag', async ({ browser }) => {
  const page = await pageFor(browser, { name: '568x320', viewport: { width: 568, height: 320 }, hasTouch: true });
  await mockBoardWithReplay(page);
  await open(page);
  await untilDemoShown(page);
  const l = await titleLayout(page);
  const label = '568x320';
  const [how, ranking, mode] = l.buttons;
  // Top to bottom, none over another, each centred.
  expect(how.bottom, label).toBeLessThanOrEqual(ranking.top + 0.5);
  expect(ranking.bottom, label).toBeLessThanOrEqual(mode.top + 0.5);
  const centre = l.field.left + l.field.width / 2;
  for (const b of l.buttons) {
    expect(Math.abs(b.left + b.width / 2 - centre), `${label}: centred`).toBeLessThanOrEqual(1);
    expect(inside(b, l.root), `${label}: inside #game-root`).toBe(true);
    expect(inside(b, l.viewport), `${label}: on screen`).toBe(true);
  }
  expectRuleFollowed(l, label, true);
  const placement = actualPlacement(l);
  if (placement === 'below-field') for (const b of l.buttons) expect(overlaps(b, l.screen), label).toBe(false);
  expect(overlaps(l.menu!, l.demo!), `${label}: the DEMO tag`).toBe(false);
  for (const b of l.buttons) expect(overlaps(b, l.demo!), `${label}: the DEMO tag`).toBe(false);
  expectDemoCorner(l, label, placement === 'field-bottom');
  await expectPressable(page, l, label);
  test.info().annotations.push({ type: 'placement', description: `${label}: ${placement}` });
  await expectToggleMovesNothing(page, label, true);
  await page.context().close();
});

test.describe('a field held to its size by a short window (500x450)', () => {
  test.use({ viewport: { width: 500, height: 450 }, hasTouch: true });

  test('the row along the field’s bottom edge, above the d-pad’s hit area, the DEMO tag top-left, each button pressed by a tap', async ({ page }) => {
    await mockBoardWithReplay(page);
    await open(page);
    await untilDemoShown(page);
    const l = await titleLayout(page);
    const label = '500x450';
    expectOneRow(l, label);
    expect(actualPlacement(l), label).toBe('field-bottom');
    expectRuleFollowed(l, label);
    expect(inside(l.menu!, l.viewport), label).toBe(true);
    expect(l.dpadHit, label).not.toBeNull();
    expect(overlaps(l.menu!, l.dpadHit!), `${label}: the d-pad's hit area`).toBe(false);
    await expectPressable(page, l, label, true);
    expectDemoCorner(l, label, true);
    expect(overlaps(l.menu!, l.demo!), `${label}: the DEMO tag`).toBe(false);
    // The DEMO tag's own corner is where it was before it moved.
    expect(overlaps(demoReserve(l), l.menu!), `${label}: the row over the DEMO tag's corner`).toBe(true);

    // Each pressed by a tap where it is: at its middle, and just inside its
    // bottom edge (the d-pad's wider hit area reaches up close to it).
    const places = [
      { where: 'middle', at: (b: Box) => [b.left + b.width / 2, b.top + b.height / 2] as const },
      { where: 'just inside the bottom edge', at: (b: Box) => [b.left + b.width / 2, b.bottom - 1] as const },
    ];
    const [how, ranking, mode] = l.buttons;
    for (const { where, at } of places) {
      const tapped = `${label}: tapped ${where}`;
      for (const text of ['MODE: EASY', 'MODE: NORMAL']) {
        await page.touchscreen.tap(...at(mode));
        await page.clock.runFor(100);
        await expect(toggle(page), tapped).toHaveText(text);
        expect(rowBoxes(await titleLayout(page)), `${tapped}: ${text}`).toEqual(rowBoxes(l));
        expect(await status(page), tapped).toBe('title');
      }
      await page.touchscreen.tap(...at(how));
      await page.clock.runFor(100);
      await expect(page.locator('#how-to-play-panel'), tapped).toBeVisible();
      expect(await status(page), tapped).toBe('title');
      await page.locator('#how-to-play-close').tap();
      await page.clock.runFor(500);
      await expect(page.locator('#how-to-play-panel')).toBeHidden();
      await page.touchscreen.tap(...at(ranking));
      await page.clock.runFor(100);
      await expect(page.locator('#ranking-list-body'), tapped).toBeVisible();
      expect(await status(page), tapped).toBe('title');
      expect(await confirms(page), tapped).toBe(0);
      await page.getByRole('button', { name: 'CLOSE', exact: true }).tap();
      await page.clock.runFor(100);
      await expect(page.locator('#ranking-list-body')).toBeHidden();
    }
  });
});

// ---------------------------------------------------------------------------
// The row follows the title text.

test.describe('the row follows the title text', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a taller title text: the row is placed again under it on a resize', async ({ page }) => {
    await open(page);
    const before = await titleLayout(page);
    expect(actualPlacement(before)).toBe('under-text');
    expect(Math.abs(before.menu!.top - before.screen.bottom - TITLE_MENU_GAP_PX)).toBeLessThanOrEqual(1);
    // The start line wraps: the title text grows taller.
    await page.evaluate(() => {
      (document.getElementById('screen') as HTMLElement).style.maxWidth = '120px';
      window.dispatchEvent(new Event('resize'));
    });
    await page.clock.runFor(50);
    const after = await titleLayout(page);
    const fieldMiddle = (l: TitleLayout) => l.field.top + l.field.height / 2;
    expect(after.screen.height).toBeGreaterThan(before.screen.height);
    expect(Math.abs(after.screen.bottom - fieldMiddle(after) - (before.screen.bottom - fieldMiddle(before)))).toBeGreaterThan(1);
    expect(actualPlacement(after)).toBe('under-text');
    expect(Math.abs(after.menu!.top - after.screen.bottom - TITLE_MENU_GAP_PX)).toBeLessThanOrEqual(1);
  });

  test('a screen resized from a one-line start line to a wrapped one: the place the rule allows, where it says', async ({ browser }) => {
    const page = await pageFor(browser, { name: '844x390', viewport: { width: 844, height: 390 }, hasTouch: true });
    await mockBoardWithReplay(page);
    await open(page);
    await untilDemoShown(page);
    const before = await titleLayout(page);
    expect(actualPlacement(before)).toBe('under-text');
    // The page's own resize handling runs on the resize event.
    const resized = page.evaluate(() => new Promise<void>((resolve) => window.addEventListener('resize', () => resolve(), { once: true })));
    await page.setViewportSize({ width: 731, height: 375 });
    await resized;
    await page.clock.runFor(100);
    const after = await titleLayout(page);
    expect(after.field.width).toBeLessThan(before.field.width);
    // The start line wraps: the title text is taller.
    expect(after.screen.height).toBeGreaterThan(before.screen.height);
    expectOneRow(after, 'resized');
    expectRuleFollowed(after, 'resized');
    await page.context().close();
  });

  for (const layout of [UNDER_TEXT_LAYOUTS[0], UNDER_TEXT_LAYOUTS[1]]) {
    test(`back from a GAME OVER with TITLE at ${layout.name}: under the start line again`, async ({ browser }) => {
      const page = await pageFor(browser, layout);
      await page.route('**/api/ranking', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
      await open(page);
      await page.keyboard.press('Enter');
      await page.clock.runFor(100);
      expect(await status(page)).toBe('playing');
      await expect(page.locator('#title-menu')).toBeHidden();
      await g(page, (h) => h.session.setDebugTimeLimitTicks(h.session.getTotalTicks() + 2));
      await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
      await finishGameOverResult(page);
      await expect(page.locator('#title-menu')).toBeHidden();
      await page.clock.runFor(Math.ceil((GUARD_TICKS + 2) * TICK_MS));
      await page.locator('#gameover-back-button').click();
      await page.clock.runFor(100);
      expect(await status(page)).toBe('title');
      await expect(page.locator('#screen')).toContainText('QIXXX');
      const l = await titleLayout(page);
      expect(actualPlacement(l)).toBe('under-text');
      expect(Math.abs(l.menu!.top - l.screen.bottom - TITLE_MENU_GAP_PX)).toBeLessThanOrEqual(1);
      expectOneRow(l, layout.name);
      await page.context().close();
    });
  }
});

// ---------------------------------------------------------------------------
// A press on the row, and just off it.

for (const layout of [UNDER_TEXT_LAYOUTS[0], UNDER_TEXT_LAYOUTS[1]]) {
  test(`at ${layout.name}, a press between the buttons starts nothing; one just off the row starts a run`, async ({ browser }) => {
    const page = await pageFor(browser, layout);
    await open(page);
    const l = await titleLayout(page);
    const [how, ranking] = l.buttons;
    const press = async (x: number, y: number) => {
      if (layout.hasTouch) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
    };
    // Between HOW TO PLAY and RANKING: the row's own box, the canvas beneath.
    const gap = [(how.right + ranking.left) / 2, l.menu!.top + l.menu!.height / 2] as const;
    expect(ranking.left - how.right).toBeGreaterThan(1);
    expect(await hitAt(page, ...gap)).toBe('title-menu');
    await press(...gap);
    await runOneTick(page);
    await page.clock.runFor(100);
    expect(await status(page)).toBe('title');
    expect(await confirms(page)).toBe(0);
    // A click lands on the row itself and presses nothing. (A tap this near a
    // button may be taken as a tap on it, as touch screens do.)
    if (!layout.hasTouch) {
      await expect(page.locator('#how-to-play-panel')).toBeHidden();
      await expect(page.locator('#ranking-list-body')).toBeHidden();
    } else {
      if (await page.locator('#how-to-play-panel').isVisible()) await page.locator('#how-to-play-close').tap();
      if (await page.locator('#ranking-list-body').isVisible()) await page.getByRole('button', { name: 'CLOSE', exact: true }).tap();
      await page.clock.runFor(500);
    }
    // Just under the row: the field, which starts a run as before. (A tap
    // still nearer the row is taken as a tap on its nearest button.)
    const off = [gap[0], l.menu!.bottom + (layout.hasTouch ? 20 : 4)] as const;
    expect(await hitAt(page, ...off)).toBe('game-canvas');
    await press(...off);
    await runOneTick(page);
    expect(await status(page)).toBe('playing');
    await page.context().close();
  });
}

// ---------------------------------------------------------------------------
// The keys.

test.describe('the keys', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Tab goes HOW TO PLAY, RANKING, MODE, each outlined; Enter on each presses it and starts nothing', async ({ page }) => {
    await mockBoardWithReplay(page);
    await open(page);
    const focused = () => page.evaluate(() => document.activeElement?.id ?? '');
    for (let i = 0; i < 12 && (await focused()) !== 'how-to-play-button'; i++) await page.keyboard.press('Tab');
    const order: string[] = [await focused()];
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('Tab');
      order.push(await focused());
    }
    expect(order).toEqual(['how-to-play-button', 'ranking-button', 'difficulty-button']);
    const outline = (selector: string) =>
      page.locator(selector).evaluate((el) => {
        const c = getComputedStyle(el);
        return { style: c.outlineStyle, width: parseFloat(c.outlineWidth), focusVisible: el.matches(':focus-visible') };
      });

    // HOW TO PLAY: the panel.
    await page.locator('#how-to-play-button').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const how = await outline('#how-to-play-button');
    expect(how.focusVisible).toBe(true);
    expect(how.style).not.toBe('none');
    expect(how.width).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    await page.clock.runFor(100);
    await expect(page.locator('#how-to-play-panel')).toBeVisible();
    expect(await status(page)).toBe('title');
    await page.locator('#how-to-play-close').click();
    await page.clock.runFor(500);

    // RANKING: the list.
    for (let i = 0; i < 12 && (await focused()) !== 'ranking-button'; i++) await page.keyboard.press('Tab');
    const ranking = await outline('#ranking-button');
    expect(ranking.focusVisible).toBe(true);
    expect(ranking.style).not.toBe('none');
    expect(ranking.width).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    await page.clock.runFor(100);
    await expect(page.locator('#ranking-list-body')).toBeVisible();
    expect(await status(page)).toBe('title');
    await page.getByRole('button', { name: 'CLOSE', exact: true }).click();
    await page.clock.runFor(100);

    // MODE: flipped.
    for (let i = 0; i < 12 && (await focused()) !== 'difficulty-button'; i++) await page.keyboard.press('Tab');
    const mode = await outline('#difficulty-button');
    expect(mode.focusVisible).toBe(true);
    expect(mode.style).not.toBe('none');
    expect(mode.width).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    await page.clock.runFor(200);
    await expect(toggle(page)).toHaveText('MODE: EASY');
    expect(await status(page)).toBe('title');
    expect(await confirms(page)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// When the row shows.

test('the row shows on the live Title screen, under the demo too, and nowhere else', async ({ page }) => {
  await mockBoardWithReplay(page);
  await open(page);
  const row = page.locator('#title-menu');
  await expect(row).toBeVisible();
  await untilDemoShown(page);
  await expect(row).toBeVisible();
  for (const s of MENU_BUTTONS) await expect(page.locator(s)).toBeVisible();
  // A ranking REPLAY: none.
  await page.locator('#ranking-button').click();
  await page.getByRole('button', { name: 'REPLAY' }).and(page.locator(':enabled')).first().click();
  await advanceUntil(page, async () => page.getByRole('button', { name: 'EXIT' }).isVisible(), 3_000, 100);
  await expect(row).toBeHidden();
  for (const s of MENU_BUTTONS) await expect(page.locator(s)).toBeHidden();
  await page.getByRole('button', { name: 'EXIT' }).click();
  await page.clock.runFor(100);
  await expect(row).toBeVisible();
  // Playing and GAME OVER: none.
  await page.keyboard.press('Enter');
  await page.clock.runFor(100);
  expect(await status(page)).toBe('playing');
  await expect(row).toBeHidden();
  await g(page, (h) => h.session.setDebugTimeLimitTicks(h.session.getTotalTicks() + 2));
  await advanceUntil(page, async () => page.locator('#gameover-modal').isVisible(), 2_000, FRAME_MS);
  await expect(row).toBeHidden();
  for (const s of MENU_BUTTONS) await expect(page.locator(s)).toBeHidden();
});

// ---------------------------------------------------------------------------
// The row while the ranking list is open.

const LIST_LAYOUTS: Layout[] = [
  { name: '1280x800', viewport: { width: 1280, height: 800 }, hasTouch: false },
  { name: '667x375 touch', viewport: { width: 667, height: 375 }, hasTouch: true },
];

for (const layout of LIST_LAYOUTS) {
  test(`with the ranking list open at ${layout.name}: the row presses nothing, the list works, and the keyboard still reaches HOW TO PLAY`, async ({ browser }) => {
    const page = await pageFor(browser, layout);
    const board = await mockBoardWithReplay(page);
    await open(page);
    const l = await titleLayout(page);
    const press = async (x: number, y: number) => {
      if (layout.hasTouch) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
    };
    const listShown = () => page.locator('#ranking-list-body').isVisible();
    const openList = async () => {
      await press(l.buttons[1].left + l.buttons[1].width / 2, l.buttons[1].top + l.buttons[1].height / 2);
      await page.clock.runFor(200);
      expect(await listShown()).toBe(true);
      await expect(page.getByRole('button', { name: 'REPLAY' }).first()).toBeVisible();
    };
    await openList();
    const reads = board.reads;

    // Every button's place, and the gaps between them: nothing pressed, nothing started.
    const [how, ranking, mode] = l.buttons;
    const midY = l.menu!.top + l.menu!.height / 2;
    const points: [number, number][] = [
      ...l.buttons.map((b) => [b.left + b.width / 2, b.top + b.height / 2] as [number, number]),
      [(how.right + ranking.left) / 2, midY],
      [(ranking.right + mode.left) / 2, midY],
    ];
    if (layout.name.startsWith('667')) {
      // Not covered by the list: the row itself takes the press.
      for (const [x, y] of points) expect(['title-menu', ...MENU_BUTTONS.map((s) => s.slice(1))]).toContain(await hitAt(page, x, y));
      for (const [x, y] of points.slice(0, 3)) expect(await hitAt(page, x, y)).toBe('title-menu');
    }
    for (const [x, y] of points) {
      await press(x, y);
      await page.clock.runFor(100);
      expect(await status(page)).toBe('title');
      await expect(page.locator('#how-to-play-panel')).toBeHidden();
      await expect(toggle(page)).toHaveText('MODE: NORMAL');
      expect(await listShown()).toBe(true);
      expect(board.reads, 'the list was not opened again').toBe(reads);
    }
    expect(await confirms(page)).toBe(0);

    // The list's own controls: REPLAY plays, EXIT leaves; CLOSE closes.
    await page.getByRole('button', { name: 'REPLAY' }).and(page.locator(':enabled')).first().click();
    await advanceUntil(page, async () => page.getByRole('button', { name: 'EXIT' }).isVisible(), 3_000, 100);
    await page.getByRole('button', { name: 'EXIT' }).click();
    await page.clock.runFor(100);
    expect(await status(page)).toBe('title');
    await openList();
    await page.getByRole('button', { name: 'CLOSE', exact: true }).click();
    await page.clock.runFor(100);
    expect(await listShown()).toBe(false);

    // With the list closed, HOW TO PLAY is pressed again where it is.
    await press(how.left + how.width / 2, how.top + how.height / 2);
    await page.clock.runFor(100);
    await expect(page.locator('#how-to-play-panel')).toBeVisible();
    expect(await status(page)).toBe('title');
    await page.locator('#how-to-play-close').click();
    await page.clock.runFor(500);
    await expect(page.locator('#how-to-play-panel')).toBeHidden();

    // The keyboard: Tab to HOW TO PLAY with the list open, Enter closes the list and opens the panel.
    await openList();
    const focused = () => page.evaluate(() => document.activeElement?.id ?? '');
    for (let i = 0; i < 20 && (await focused()) !== 'how-to-play-button'; i++) await page.keyboard.press('Tab');
    expect(await focused()).toBe('how-to-play-button');
    await page.keyboard.press('Enter');
    await page.clock.runFor(100);
    expect(await listShown()).toBe(false);
    await expect(page.locator('#how-to-play-panel')).toBeVisible();
    await page.locator('#how-to-play-close').click();
    await page.clock.runFor(500);

    // With the list closed, the buttons are pressed again.
    await press(mode.left + mode.width / 2, mode.top + mode.height / 2);
    await page.clock.runFor(100);
    await expect(toggle(page)).toHaveText('MODE: EASY');
    expect(await status(page)).toBe('title');
    await page.context().close();
  });
}
