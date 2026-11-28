// The sound toggle (#mute-button): SOUND: OFF / SOUND: ON, the current state,
// in the HUD row (bottom mode) or the top-right corner (side mode). Its glow on
// the live Title screen while the sound is off, and its width reserved so
// toggling never moves the HUD row. Runs on a faked, paused clock where the
// run's ticks matter.
import { test, expect, type Page } from '@playwright/test';
import { GameSession } from '../../src/core/session';
import { encodeRle, type InputSample } from '../../src/core/rle';
import { RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../src/config';

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');

const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());
const focused = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '');

async function open(page: Page, query = ''): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.goto(`${APP_URL}${query}`);
  await page.clock.runFor(100);
}

/** Tabs to the sound toggle. */
async function focusSoundButton(page: Page): Promise<void> {
  for (let i = 0; i < 12 && (await focused(page)) !== 'mute-button'; i++) await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('mute-button');
}

/** A short recorded run that keeps the marker moving: down and up through the field along the border. */
function recordReplay(seed: number, maxSamples: number): string {
  const session = new GameSession({ seed });
  session.update({ dx: 0, dy: 0, drawHeld: false, slow: false, confirm: true });
  const samples: InputSample[] = [];
  const height = session.getGame().getField().getHeight();
  let goingDown = true;
  while (session.getStatus() === 'playing' && samples.length < maxSamples) {
    const targetY = goingDown ? height - 1 : 0;
    for (let i = 0; i < height + 5 && session.getStatus() === 'playing' && samples.length < maxSamples; i++) {
      if (session.getGame().getMarker().getPosition().y === targetY) break;
      const input = { dx: 0 as const, dy: (goingDown ? 1 : -1) as -1 | 1, drawHeld: true, slow: false };
      samples.push(input);
      session.update({ ...input, confirm: false });
      session.drainEvents();
      session.drainDespawnedEmberPositions();
    }
    for (let i = 0; i < 4 && session.getStatus() === 'playing' && samples.length < maxSamples; i++) {
      const input = { dx: 1 as const, dy: 0 as const, drawHeld: false, slow: false };
      samples.push(input);
      session.update({ ...input, confirm: false });
      session.drainEvents();
      session.drainDespawnedEmberPositions();
    }
    goingDown = !goingDown;
  }
  return Buffer.from(encodeRle(samples)).toString('base64');
}

const REPLAY_SEED = 377;
const REPLAY_PAYLOAD = JSON.stringify({
  seed: REPLAY_SEED,
  rleBase64: recordReplay(REPLAY_SEED, 600),
  rulesetVersion: RULESET_VERSION,
  replayFormatVersion: REPLAY_FORMAT_VERSION,
});

/** A full board whose best row has a replay, and that replay: RANKING's REPLAY opens it. */
async function mockBoardWithReplay(page: Page): Promise<void> {
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
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        seasonId: 1,
        rulesetVersion: RULESET_VERSION,
        entries,
        displayEntries: entries.map((e) => ({ ...e, status: 'verified' })),
      }),
    });
  });
  await page.route('**/api/ranking/*/replay', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: REPLAY_PAYLOAD })
  );
}

const attention = (page: Page) => page.locator('#mute-button').getAttribute('data-attention');

test.describe('the sound toggle', () => {
  for (const lang of ['en', 'ja'] as const) {
    test(`starts at SOUND: OFF, toggles to SOUND: ON and back, and is remembered (${lang})`, async ({ page }) => {
      await open(page, `?lang=${lang}`);
      const sound = page.locator('#mute-button');
      await expect(sound).toHaveText('SOUND: OFF');
      expect(await sound.getAttribute('aria-pressed')).toBeNull();

      await sound.click();
      await page.clock.runFor(50);
      await expect(sound).toHaveText('SOUND: ON');
      expect(await page.evaluate(() => [window.__game__!.sfx.isMuted(), localStorage.getItem('qixxx.muted')])).toEqual([false, 'false']);

      await page.reload();
      await page.clock.runFor(100);
      await expect(page.locator('#mute-button')).toHaveText('SOUND: ON');

      await page.locator('#mute-button').click();
      await page.clock.runFor(50);
      await expect(page.locator('#mute-button')).toHaveText('SOUND: OFF');
      await page.reload();
      await page.clock.runFor(100);
      await expect(page.locator('#mute-button')).toHaveText('SOUND: OFF');
      expect(await status(page)).toBe('title');
    });
  }

  test('a click, Enter or Space on it never starts a run; the next Enter does', async ({ page }) => {
    await open(page, '?seed=3');
    const sound = page.locator('#mute-button');

    await sound.click();
    await page.clock.runFor(200);
    expect(await status(page)).toBe('title');
    expect(await focused(page)).not.toBe('mute-button');

    for (const key of ['Enter', 'Space']) {
      await focusSoundButton(page);
      const before = await sound.innerText();
      await page.keyboard.press(key);
      await page.clock.runFor(200);
      expect(await status(page), key).toBe('title');
      await expect(sound).not.toHaveText(before);
      expect(await focused(page)).not.toBe('mute-button');
    }

    await page.keyboard.press('Enter');
    await page.clock.runFor(200);
    expect(await status(page)).toBe('playing');
  });

  for (const key of ['Enter', 'Space']) {
    test(`${key} held down on it, its auto-repeat included, does not start a run until pressed afresh`, async ({ page }) => {
      await open(page, '?seed=3');
      const sound = page.locator('#mute-button');
      await focusSoundButton(page);
      const before = await sound.innerText();

      // Enter presses the button on its key-down, which gives the focus back,
      // so the held key's auto-repeat lands on the page (Space presses it on
      // its release instead).
      await page.keyboard.down(key);
      await page.clock.runFor(100);
      for (let i = 0; i < 3; i++) await page.keyboard.down(key);
      await page.evaluate((code) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'Space' ? ' ' : code, repeat: true }));
      }, key);
      await page.clock.runFor(300);
      expect(await status(page)).toBe('title');
      await page.keyboard.up(key);
      await page.clock.runFor(100);
      expect(await status(page)).toBe('title');
      await expect(sound).not.toHaveText(before);
      expect(await focused(page)).not.toBe('mute-button');

      await page.keyboard.press(key);
      await page.clock.runFor(200);
      expect(await status(page)).toBe('playing');
    });
  }

  test('a tap on it does not start a run', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, locale: 'en-US' });
    const page = await context.newPage();
    await open(page, '?seed=3');
    await page.locator('#mute-button').tap();
    await page.clock.runFor(200);
    expect(await status(page)).toBe('title');
    await expect(page.locator('#mute-button')).toHaveText('SOUND: ON');
    await context.close();
  });
});

test.describe('the sound toggle glow', () => {
  test('is on while the sound is off on the live Title screen, off once the sound is on or a run starts', async ({ page }) => {
    await open(page, '?seed=3');
    const sound = page.locator('#mute-button');
    expect(await attention(page)).toBe('true');
    expect(await sound.evaluate((el) => getComputedStyle(el).animationName)).toBe('sound-attention');

    await sound.click();
    await page.clock.runFor(50);
    expect(await attention(page)).toBeNull();
    expect(await sound.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');

    await sound.click();
    await page.clock.runFor(50);
    expect(await attention(page)).toBe('true');

    await page.keyboard.press('Enter');
    await page.clock.runFor(200);
    expect(await status(page)).toBe('playing');
    await expect(sound).toHaveText('SOUND: OFF');
    expect(await attention(page)).toBeNull();
  });

  test('holds still under prefers-reduced-motion: reduce', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    expect(await attention(page)).toBe('true');
    const style = await page.locator('#mute-button').evaluate((el) => {
      const s = getComputedStyle(el);
      return { animation: s.animationName, glow: s.boxShadow };
    });
    expect(style.animation).toBe('none');
    expect(style.glow).not.toBe('none');
  });

  test('is not on a ranking replay, where P does not pause either', async ({ page }) => {
    await mockBoardWithReplay(page);
    await open(page);
    expect(await attention(page)).toBe('true');
    await page.locator('#ranking-button').click();
    await page.clock.runFor(100);
    await page.getByRole('button', { name: 'REPLAY' }).first().click();
    await page.clock.runFor(300);
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeVisible();
    await expect(page.locator('#mute-button')).toHaveText('SOUND: OFF');
    expect(await attention(page)).toBeNull();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('KeyP');
    await page.clock.runFor(50);
    await page.keyboard.press('Escape');
    await page.clock.runFor(50);
    expect(await page.evaluate(() => window.__game__!.isPaused())).toBe(false);
    await expect(page.locator('#pause-overlay')).toBeHidden();
    expect(await attention(page)).toBeNull();
  });
});

// The layout, compared with itself rather than with measured pixels (those
// follow the fonts a machine has): SOUND: OFF and SOUND: ON, with and without
// the glow, and English and Japanese, give the same boxes for the HUD row,
// the corner and the touch controls; the toggle's width is the same for
// either label; it never covers the HUD's text; in side mode it and PAUSE sit
// right of the HUD row, apart. What the viewport alone decides is checked as
// such: the field's 4:3 and the toggle's corner.
type Box = { left: number; top: number; width: number; height: number; right: number; bottom: number };

const LAYOUT_VIEWPORTS = [
  { width: 1280, height: 800, touch: false, side: false },
  { width: 390, height: 844, touch: true, side: false },
  { width: 844, height: 390, touch: true, side: true },
  { width: 667, height: 375, touch: true, side: true },
];

/** The boxes the layout checks read, rounded to 0.01px, and the HUD's lines of text. */
function readLayout(page: Page) {
  return page.evaluate(() => {
    const round = (v: number) => Math.round(v * 100) / 100;
    const box = (el: Element | null): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: round(r.left), top: round(r.top), width: round(r.width), height: round(r.height), right: round(r.right), bottom: round(r.bottom) };
    };
    const hud = document.getElementById('hud')!;
    const range = document.createRange();
    range.selectNodeContents(hud);
    return {
      boxes: {
        canvas: box(document.getElementById('game-canvas'))!,
        hud: box(hud)!,
        hudRow: box(hud.parentElement)!,
        sound: box(document.getElementById('mute-button'))!,
        // The HUD row's children and the corner's extras, wherever they are.
        row: [...hud.parentElement!.children, ...(document.getElementById('touch-actions-extra')?.children ?? [])].map((el) => ({ id: el.id, box: box(el) })),
        dpad: box(document.getElementById('touch-dpad')),
        fast: box(document.querySelector('#touch-actions [data-code="Space"]')),
        slow: box(document.querySelector('#touch-actions [data-code="KeyZ"]')),
        pause: box(document.getElementById('pause-button')),
      },
      hudText: [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => r.toJSON() as Box),
      touchLayout: document.body.dataset.touchLayout ?? null,
    };
  });
}

const intersects = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const vp of LAYOUT_VIEWPORTS) {
  test(`${vp.width}x${vp.height}${vp.touch ? ' touch' : ''}: toggling, the glow and the language move nothing; the toggle covers no HUD text`, async ({ browser }) => {
    const layouts: Record<string, { off: Awaited<ReturnType<typeof readLayout>>; playing: Awaited<ReturnType<typeof readLayout>> }> = {};
    for (const lang of ['en', 'ja'] as const) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, locale: lang === 'ja' ? 'ja-JP' : 'en-US' });
      const page = await context.newPage();
      await open(page, `?seed=3&lang=${lang}`);
      const sound = page.locator('#mute-button');
      await expect(sound).toHaveText('SOUND: OFF');
      expect(await attention(page)).toBe('true');
      const off = await readLayout(page);
      if (vp.touch) expect(off.touchLayout, lang).toBe(vp.side ? 'side' : 'bottom');
      // SOUND: OFF fits the reserved width.
      expect(await sound.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

      // SOUND: ON, the glow gone: nothing in the row moves, the toggle keeps its width.
      await sound.click();
      await page.clock.runFor(50);
      await expect(sound).toHaveText('SOUND: ON');
      expect(await attention(page)).toBeNull();
      const on = await readLayout(page);
      expect(on.boxes, lang).toEqual(off.boxes);
      expect(on.boxes.sound.width, lang).toBe(off.boxes.sound.width);
      expect(await sound.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

      // Playing: the field and the toggle are where they were.
      await page.keyboard.press('Enter');
      await page.clock.runFor(300);
      expect(await status(page)).toBe('playing');
      const playing = await readLayout(page);
      expect(playing.boxes.canvas, lang).toEqual(off.boxes.canvas);
      expect(playing.boxes.sound, lang).toEqual(off.boxes.sound);

      for (const [name, state] of [['title', off], ['playing', playing]] as const) {
        const { canvas, hudRow, sound: toggle, pause } = state.boxes;
        const where = `${lang} ${name}`;
        // The field is 4:3, whatever the fonts (rounded to whole pixels).
        expect(Math.abs(canvas.width * 3 - canvas.height * 4), where).toBeLessThanOrEqual(4);
        // The HUD's text stays clear of the toggle.
        expect(state.hudText.length, where).toBeGreaterThan(0);
        for (const line of state.hudText) expect(intersects(line, toggle), `${where}: ${JSON.stringify(line)}`).toBe(false);
        // The toggle keeps its corner: the viewport's top right in side
        // mode, the HUD row's right edge (the field's) otherwise.
        if (vp.side) expect(toggle.right, where).toBe(vp.width - 8);
        else expect(Math.abs(toggle.right - (canvas.left + canvas.width)), where).toBeLessThanOrEqual(0.05);
        if (vp.side && name === 'playing') {
          // PAUSE and the toggle, right of the HUD row and apart.
          expect(pause, where).not.toBeNull();
          expect(pause!.left, where).toBeGreaterThanOrEqual(hudRow.right);
          expect(toggle.left, where).toBeGreaterThanOrEqual(hudRow.right);
          expect(intersects(pause!, toggle), where).toBe(false);
        }
      }
      layouts[lang] = { off, playing };
      await context.close();
    }
    // English and Japanese: the same boxes, on the Title screen and playing.
    expect(layouts.ja.off.boxes).toEqual(layouts.en.off.boxes);
    expect(layouts.ja.playing.boxes).toEqual(layouts.en.playing.boxes);
  });
}
