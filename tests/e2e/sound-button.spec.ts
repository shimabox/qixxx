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

// Measured before the sound toggle was folded into one (HEAD ba093fa, its
// label then UNMUTE): the field, the HUD row's line count (its height), the
// sound toggle's top and height, and the touch controls while playing — the
// same in English and Japanese. [left, top, width, height] in CSS px. The
// toggle's width, and with it the right edge of #hud (bottom mode) and the
// PAUSE button's left (side mode), may differ: the toggle now reserves the
// width of SOUND: OFF.
type Box = [number, number, number, number];
interface Baseline {
  width: number;
  height: number;
  touch: boolean;
  side: boolean;
  canvas: Box;
  /** #hud's and #hud-row's [left, top, height]. */
  hud: [number, number, number];
  hudRow: [number, number, number];
  /** The sound toggle's [top, height]. */
  sound: [number, number];
  dpad?: Box;
  fast?: Box;
  slow?: Box;
  pause?: Box;
}
const BASELINES: Baseline[] = [
  { width: 1280, height: 800, touch: false, side: false, canvas: [129.5, 34, 1021, 766], hud: [129.5, 5, 18], hudRow: [129.5, 0, 28], sound: [0, 28] },
  {
    width: 390,
    height: 844,
    touch: true,
    side: false,
    canvas: [0, 190, 390, 292],
    hud: [0, 142, 42],
    hudRow: [0, 142, 42],
    sound: [149, 28],
    dpad: [8, 634, 200, 200],
    fast: [318, 666, 64, 64],
    slow: [246, 738, 64, 64],
    pause: [338, 792, 44, 44],
  },
  {
    width: 844,
    height: 390,
    touch: true,
    side: true,
    canvas: [232, 82.5, 380, 285],
    hud: [232, 22.5, 54],
    hudRow: [232, 22.5, 54],
    sound: [6, 19],
    dpad: [16, 95, 200, 200],
    fast: [700, 127, 64, 64],
    slow: [628, 199, 64, 64],
    pause: [642.38, 6, 44, 44],
  },
  {
    width: 667,
    height: 375,
    touch: true,
    side: true,
    canvas: [232, 132.5, 203, 152],
    hud: [232, 90.5, 36],
    hudRow: [232, 90.5, 36],
    sound: [6, 19],
    dpad: [16, 87.5, 200, 200],
    fast: [523, 119.5, 64, 64],
    slow: [451, 191.5, 64, 64],
    pause: [465.38, 6, 44, 44],
  },
];

/** The boxes the layout checks read, rounded to 0.01px. */
function readLayout(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null): [number, number, number, number] => {
      const r = el!.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 100) / 100) as [number, number, number, number];
    };
    const hud = document.getElementById('hud')!;
    const sound = document.getElementById('mute-button')!;
    return {
      canvas: box(document.getElementById('game-canvas')),
      hud: box(hud),
      hudRow: box(hud.parentElement),
      sound: box(sound),
      // The HUD row's children and the corner's extras, wherever they are.
      row: [...hud.parentElement!.children, ...(document.getElementById('touch-actions-extra')?.children ?? [])].map((el) => ({ id: el.id, box: box(el) })),
      dpad: document.getElementById('touch-dpad') ? box(document.getElementById('touch-dpad')) : null,
      fast: document.querySelector('#touch-actions [data-code="Space"]') ? box(document.querySelector('#touch-actions [data-code="Space"]')) : null,
      slow: document.querySelector('#touch-actions [data-code="KeyZ"]') ? box(document.querySelector('#touch-actions [data-code="KeyZ"]')) : null,
      pause: document.getElementById('pause-button') ? box(document.getElementById('pause-button')) : null,
      soundRight: Math.round(sound.getBoundingClientRect().right * 100) / 100,
    };
  });
}

for (const b of BASELINES) {
  for (const lang of ['en', 'ja'] as const) {
    test.describe(`${b.width}x${b.height}${b.touch ? ' touch' : ''} ${lang}`, () => {
      test.use({ viewport: { width: b.width, height: b.height }, hasTouch: b.touch });

      test('the field, the HUD row and the touch controls are where they were; toggling and the glow move nothing', async ({ page }) => {
        await open(page, `?seed=3&lang=${lang}`);
        const sound = page.locator('#mute-button');
        await expect(sound).toHaveText('SOUND: OFF');
        expect(await attention(page)).toBe('true');
        const off = await readLayout(page);

        expect(off.canvas).toEqual(b.canvas);
        expect([off.hud[0], off.hud[1], off.hud[3]]).toEqual(b.hud);
        expect([off.hudRow[0], off.hudRow[1], off.hudRow[3]]).toEqual(b.hudRow);
        expect([off.sound[1], off.sound[3]]).toEqual(b.sound);
        // The toggle keeps its corner: the HUD row's right edge in bottom
        // mode, the viewport's top right in side mode.
        if (b.side) expect(off.soundRight).toBe(b.width - 8);
        else expect(off.soundRight).toBeCloseTo(off.canvas[0] + off.canvas[2], 1);
        // SOUND: OFF fits the reserved width.
        expect(await sound.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

        // SOUND: ON, the glow gone: nothing in the row moves.
        await sound.click();
        await page.clock.runFor(50);
        await expect(sound).toHaveText('SOUND: ON');
        expect(await attention(page)).toBeNull();
        const on = await readLayout(page);
        expect(on).toEqual(off);

        // Playing: the field and the touch controls are where they were.
        await page.keyboard.press('Enter');
        await page.clock.runFor(300);
        expect(await status(page)).toBe('playing');
        const playing = await readLayout(page);
        expect(playing.canvas).toEqual(b.canvas);
        expect([playing.hud[0], playing.hud[1], playing.hud[3]]).toEqual(b.hud);
        expect(playing.sound).toEqual(off.sound);
        if (b.touch) {
          expect(playing.dpad).toEqual(b.dpad);
          expect(playing.fast).toEqual(b.fast);
          expect(playing.slow).toEqual(b.slow);
          // In side mode PAUSE sits left of the credit and the wider toggle,
          // so only its size and top are as they were, and it stays clear of
          // the HUD row.
          if (b.side) {
            expect([playing.pause![1], playing.pause![2], playing.pause![3]]).toEqual([b.pause![1], b.pause![2], b.pause![3]]);
            expect(playing.pause![0]).toBeGreaterThanOrEqual(playing.hudRow[0] + playing.hudRow[2]);
          } else {
            expect(playing.pause).toEqual(b.pause);
          }
        }
      });
    });
  }
}
