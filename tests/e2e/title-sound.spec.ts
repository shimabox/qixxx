// The Title screen's sound toggle (src/ui/titleSoundButton.ts): SOUND: OFF /
// SOUND: ON on the field, the same toggle as MUTE / UNMUTE. Runs on a faked,
// paused clock where the run's ticks matter.
import { test, expect, type Page } from '@playwright/test';
import { GameSession } from '../../src/core/session';
import { encodeRle, type InputSample } from '../../src/core/rle';
import { RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../src/config';
import { advanceUntil } from './support/fakeClock';

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');

const status = (page: Page) => page.evaluate(() => window.__game__!.session.getStatus());

async function open(page: Page, query = ''): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.goto(`${APP_URL}${query}`);
  await page.clock.runFor(100);
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

/** A full board whose best row has a replay, and that replay: the Title demo plays it, and RANKING's REPLAY opens it. */
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

test.describe('the Title sound toggle', () => {
  test('starts at SOUND: OFF, toggles with MUTE / UNMUTE both ways, and is remembered', async ({ page }) => {
    await open(page);
    const sound = page.locator('#title-sound-button');
    const mute = page.locator('#mute-button');
    await expect(sound).toHaveText('SOUND: OFF');
    await expect(mute).toHaveText('UNMUTE');

    await sound.click();
    await page.clock.runFor(50);
    await expect(sound).toHaveText('SOUND: ON');
    await expect(mute).toHaveText('MUTE');
    expect(await page.evaluate(() => window.__game__!.sfx.isMuted())).toBe(false);

    await mute.click();
    await page.clock.runFor(50);
    await expect(sound).toHaveText('SOUND: OFF');
    await expect(mute).toHaveText('UNMUTE');

    await sound.click();
    await page.clock.runFor(50);
    await expect(sound).toHaveText('SOUND: ON');
    await page.reload();
    await page.clock.runFor(100);
    await expect(page.locator('#title-sound-button')).toHaveText('SOUND: ON');
    await expect(page.locator('#mute-button')).toHaveText('MUTE');
    expect(await status(page)).toBe('title');
  });

  test('pressing it never starts a run; the next Enter does', async ({ page }) => {
    await open(page, '?seed=3');
    const sound = page.locator('#title-sound-button');
    const focused = () => page.evaluate(() => document.activeElement?.id ?? '');

    await sound.click();
    await page.clock.runFor(200);
    expect(await status(page)).toBe('title');
    expect(await focused()).not.toBe('title-sound-button');

    for (const key of ['Enter', 'Space']) {
      for (let i = 0; i < 12 && (await focused()) !== 'title-sound-button'; i++) await page.keyboard.press('Tab');
      expect(await focused()).toBe('title-sound-button');
      const before = await sound.innerText();
      await page.keyboard.press(key);
      await page.clock.runFor(200);
      expect(await status(page), key).toBe('title');
      await expect(sound).not.toHaveText(before);
      expect(await focused()).not.toBe('title-sound-button');
    }

    await page.keyboard.press('Enter');
    await page.clock.runFor(200);
    expect(await status(page)).toBe('playing');
    await expect(sound).toBeHidden();
  });

  for (const key of ['Enter', 'Space']) {
    test(`${key} held down on it, its auto-repeat included, does not start a run until pressed afresh`, async ({ page }) => {
      await open(page, '?seed=3');
      const sound = page.locator('#title-sound-button');
      const focused = () => page.evaluate(() => document.activeElement?.id ?? '');
      for (let i = 0; i < 12 && (await focused()) !== 'title-sound-button'; i++) await page.keyboard.press('Tab');
      expect(await focused()).toBe('title-sound-button');
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
      expect(await focused()).not.toBe('title-sound-button');

      await page.keyboard.press(key);
      await page.clock.runFor(200);
      expect(await status(page)).toBe('playing');
    });
  }

  test('a tap on it does not start a run', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, locale: 'en-US' });
    const page = await context.newPage();
    await open(page, '?seed=3');
    await page.locator('#title-sound-button').tap();
    await page.clock.runFor(200);
    expect(await status(page)).toBe('title');
    await expect(page.locator('#title-sound-button')).toHaveText('SOUND: ON');
    await context.close();
  });

  test('is not on a ranking replay, where P does not pause either', async ({ page }) => {
    await mockBoardWithReplay(page);
    await open(page);
    await expect(page.locator('#title-sound-button')).toBeVisible();
    await page.locator('#ranking-button').click();
    await page.clock.runFor(100);
    await page.getByRole('button', { name: 'REPLAY' }).first().click();
    await page.clock.runFor(300);
    await expect(page.getByRole('button', { name: 'EXIT' })).toBeVisible();
    await expect(page.locator('#title-sound-button')).toBeHidden();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('KeyP');
    await page.clock.runFor(50);
    await page.keyboard.press('Escape');
    await page.clock.runFor(50);
    expect(await page.evaluate(() => window.__game__!.isPaused())).toBe(false);
    await expect(page.locator('#pause-overlay')).toBeHidden();
  });
});

const VIEWPORTS = [
  { width: 1280, height: 800, touch: false },
  { width: 390, height: 844, touch: true },
  { width: 844, height: 390, touch: true },
];

for (const vp of VIEWPORTS) {
  for (const lang of ['en', 'ja'] as const) {
    test.describe(`${vp.width}x${vp.height} ${lang}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });

      test('sits on the field clear of the title text, HOW TO PLAY, RANKING and the DEMO tag', async ({ page }) => {
        await mockBoardWithReplay(page);
        await open(page, `?lang=${lang}`);
        // The demo plays (the DEMO tag shows) and the button stays on top of it.
        await advanceUntil(page, () => page.evaluate(() => window.__game__!.getTitleDemo().shown), 6000);
        await page.clock.runFor(50);
        await expect(page.locator('#title-demo-label')).toBeVisible();
        const geometry = await page.evaluate(() => {
          const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
          const sound = rect('title-sound-button');
          const field = rect('game-canvas');
          const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          const others = ['screen', 'how-to-play-button', 'ranking-button', 'title-demo-label'].map((id) => ({ id, rect: rect(id) }));
          const center = document.elementFromPoint(sound.left + sound.width / 2, sound.top + sound.height / 2);
          return {
            inside: sound.left >= field.left && sound.right <= field.right && sound.top >= field.top && sound.bottom <= field.bottom,
            centered: Math.abs(sound.left + sound.width / 2 - (field.left + field.width / 2)),
            clear: others.filter((o) => o.rect.width > 0 && overlaps(sound, o.rect)).map((o) => o.id),
            measured: others.every((o) => o.rect.width > 0),
            below: sound.top >= rect('screen').bottom,
            onTop: center?.id === 'title-sound-button',
          };
        });
        expect(geometry).toMatchObject({ inside: true, clear: [], measured: true, below: true, onTop: true });
        expect(geometry.centered).toBeLessThanOrEqual(2);
      });
    });
  }
}

test.describe('a field shorter than 200px (667x375 touch)', () => {
  test.use({ viewport: { width: 667, height: 375 }, hasTouch: true });

  test('has no room for it: hidden, while MUTE in the corner still toggles the sound', async ({ page }) => {
    await open(page);
    await expect(page.locator('#mute-button')).toBeVisible();
    await expect(page.locator('#title-sound-button')).toBeHidden();
  });
});
