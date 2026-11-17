// The pause (src/pause.ts, src/ui/pauseOverlay.ts): P / Escape, the touch
// PAUSE button and a hidden page pause live play; RESUME, P and Escape
// resume it. Runs on a faked, paused clock, so every wait is game time and
// the paused stretches are clock time that must not turn into ticks.
import { test, expect, type Page } from '@playwright/test';
import { advanceUntil, loseAllLivesToIgniter } from './support/fakeClock';

const APP_URL = 'http://localhost:4173/';
const CLOCK_START = new Date('2026-01-01T00:00:00Z');
const SEED = 7;

interface Probe {
  paused: boolean;
  status: string;
  ticks: number;
  remaining: number;
  score: number;
  stage: number;
  lives: number;
  occupancy: number;
  marker: { x: number; y: number };
  drawing: boolean;
  wisps: { x: number; y: number }[];
  embers: { x: number; y: number }[];
}

type Hook = {
  isPaused: () => boolean;
  sfx: { isDrawingToneActive: () => boolean };
  session: {
    getStatus: () => string;
    getTotalTicks: () => number;
    getRemainingTicks: () => number;
    getScore: () => number;
    getStage: () => number;
    getLives: () => number;
    getGame: () => {
      getOccupancy: () => number;
      getMarker: () => { getPosition: () => { x: number; y: number }; isDrawing: () => boolean };
      getWisps: () => { getPosition: () => { x: number; y: number } }[];
      getEmbers: () => { getPosition: () => { x: number; y: number } }[];
    };
  };
};

const probe = (page: Page) =>
  page.evaluate((): Probe => {
    const hook = (window as unknown as { __game__: Hook }).__game__;
    const session = hook.session;
    const game = session.getGame();
    const marker = game.getMarker();
    return {
      paused: hook.isPaused(),
      status: session.getStatus(),
      ticks: session.getTotalTicks(),
      remaining: session.getRemainingTicks(),
      score: session.getScore(),
      stage: session.getStage(),
      lives: session.getLives(),
      occupancy: game.getOccupancy(),
      marker: marker.getPosition(),
      drawing: marker.isDrawing(),
      wisps: game.getWisps().map((w) => w.getPosition()),
      embers: game.getEmbers().map((e) => e.getPosition()),
    };
  });

/** Everything about the run, but not whether it is paused. */
const runState = (p: Probe) => {
  const { paused: _paused, ...rest } = p;
  return rest;
};

/** Opens the page on a fake clock paused before it loads, so the load plays no ticks. */
async function open(page: Page, query = `?seed=${SEED}`): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
  await page.clock.pauseAt(new Date(CLOCK_START.getTime() + 60_000));
  await page.goto(`${APP_URL}${query}`);
  await page.clock.runFor(100);
}

/** Title -> playing with a key, then lets some ticks play. */
async function startRun(page: Page): Promise<void> {
  await page.keyboard.press('Enter');
  await page.clock.runFor(500);
  expect((await probe(page)).status).toBe('playing');
}

/** Fires visibilitychange with the page's visibility switched to `state`. */
async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

const resumeIsFocused = (page: Page) => page.evaluate(() => document.activeElement?.id === 'pause-resume');

test.describe('pause with the keyboard', () => {
  for (const key of ['KeyP', 'Escape']) {
    test(`${key} pauses, holds the run still behind an opaque screen, and resumes without catching up`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await open(page);
      await startRun(page);

      await page.keyboard.press(key);
      await page.clock.runFor(50);
      const atPause = await probe(page);
      expect(atPause.paused).toBe(true);
      await expect(page.locator('#pause-overlay')).toBeVisible();
      await expect(page.locator('#pause-title')).toHaveText('PAUSED');
      await expect(page.locator('#pause-resume')).toHaveText('RESUME');
      await expect(page.locator('#pause-hint')).toHaveText('PRESS P OR ESC TO RESUME');
      // The focus stays on the page, so keys pressed while paused still count.
      expect(await resumeIsFocused(page)).toBe(false);

      // The screen covers the whole field, opaque, over the field's DOM too.
      const cover = await page.evaluate(() => {
        const overlay = document.getElementById('pause-overlay')!;
        const o = overlay.getBoundingClientRect();
        const c = document.getElementById('game-canvas')!.getBoundingClientRect();
        const style = getComputedStyle(overlay);
        const inset = 3;
        const points = [
          [o.left + o.width / 2, o.top + o.height / 2],
          [o.left + inset, o.top + inset],
          [o.right - inset, o.top + inset],
          [o.left + inset, o.bottom - inset],
          [o.right - inset, o.bottom - inset],
        ];
        // The in-play hint line (shown at a run's start) sits on the field: covered too.
        const hint = document.getElementById('hint-bar');
        if (hint && getComputedStyle(hint).display !== 'none') {
          const h = hint.getBoundingClientRect();
          if (h.width > 0) points.push([h.left + h.width / 2, h.top + h.height / 2]);
        }
        return {
          contains: o.left <= c.left && o.top <= c.top && o.right >= c.right && o.bottom >= c.bottom,
          onTop: points.every(([x, y]) => overlay.contains(document.elementFromPoint(x, y))),
          opacity: style.opacity,
          background: style.backgroundColor,
          points: points.length,
        };
      });
      expect(cover).toMatchObject({ contains: true, onTop: true, opacity: '1', background: 'rgb(10, 14, 39)' });

      // Five seconds paused: nothing moves, the time stands still.
      await page.clock.runFor(5000);
      const afterWait = await probe(page);
      expect(runState(afterWait)).toEqual(runState(atPause));
      expect(afterWait.paused).toBe(true);

      await page.keyboard.press(key);
      await page.clock.runFor(16);
      const firstFrame = await probe(page);
      expect(firstFrame.paused).toBe(false);
      await expect(page.locator('#pause-overlay')).toBeHidden();
      // The paused five seconds are not caught up on.
      expect(firstFrame.ticks - atPause.ticks).toBeLessThanOrEqual(1);
      await page.clock.runFor(1000);
      const later = await probe(page);
      expect(later.ticks - firstFrame.ticks).toBeGreaterThanOrEqual(50);
      expect(later.ticks - firstFrame.ticks).toBeLessThanOrEqual(62);
    });
  }

  test('holding the pause key (its auto-repeat) keeps the run paused', async ({ page }) => {
    await open(page);
    await startRun(page);
    await page.keyboard.down('KeyP');
    await page.clock.runFor(50);
    const atPause = await probe(page);
    expect(atPause.paused).toBe(true);
    // The held key's auto-repeat: Playwright's own repeated down, and
    // repeat-flagged and unflagged keydowns of the still-held key.
    await page.keyboard.down('KeyP');
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p', repeat: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p' }));
    });
    await page.clock.runFor(1000);
    const held = await probe(page);
    expect(held.paused).toBe(true);
    expect(runState(held)).toEqual(runState(atPause));
    await page.keyboard.up('KeyP');
    await page.keyboard.press('KeyP');
    await page.clock.runFor(500);
    const resumed = await probe(page);
    expect(resumed.paused).toBe(false);
    expect(resumed.ticks).toBeGreaterThan(atPause.ticks);
  });

  test('a key pressed while paused and held through RESUME counts; one pressed and let go does not', async ({ page }) => {
    await open(page);
    await startRun(page);
    const start = await probe(page);
    // The marker starts on the top border: right moves it along the border.
    expect(start.marker.y).toBe(0);

    await page.keyboard.press('KeyP');
    await page.clock.runFor(50);
    await page.keyboard.down('ArrowRight');
    await page.clock.runFor(500);
    expect(await resumeIsFocused(page)).toBe(false);
    expect((await probe(page)).marker).toEqual(start.marker);
    await page.keyboard.press('KeyP');
    await page.clock.runFor(150);
    const moved = await probe(page);
    await page.keyboard.up('ArrowRight');
    expect(moved.paused).toBe(false);
    expect(moved.marker.x).toBeGreaterThan(start.marker.x);

    await page.keyboard.press('KeyP');
    await page.clock.runFor(50);
    const atPause = await probe(page);
    await page.keyboard.down('ArrowLeft');
    await page.clock.runFor(200);
    await page.keyboard.up('ArrowLeft');
    await page.keyboard.press('KeyP');
    await page.clock.runFor(300);
    const after = await probe(page);
    expect(after.paused).toBe(false);
    expect(after.ticks).toBeGreaterThan(atPause.ticks);
    expect(after.marker).toEqual(atPause.marker);
  });
});

test.describe('RESUME', () => {
  test('a click resumes and leaves no focus behind', async ({ page }) => {
    await open(page);
    await startRun(page);
    await page.keyboard.press('Escape');
    await page.clock.runFor(50);
    await page.locator('#pause-resume').click();
    await page.clock.runFor(200);
    expect((await probe(page)).paused).toBe(false);
    await expect(page.locator('#pause-overlay')).toBeHidden();
    expect(await resumeIsFocused(page)).toBe(false);
  });

  test('reached with Tab, Enter resumes; Space resumes without starting a line', async ({ page }) => {
    await open(page);
    await startRun(page);
    await page.keyboard.press('KeyP');
    await page.clock.runFor(50);
    for (let i = 0; i < 12 && !(await resumeIsFocused(page)); i++) await page.keyboard.press('Tab');
    expect(await resumeIsFocused(page)).toBe(true);
    await page.keyboard.press('Enter');
    await page.clock.runFor(100);
    expect((await probe(page)).paused).toBe(false);
    expect(await resumeIsFocused(page)).toBe(false);

    await page.keyboard.press('KeyP');
    await page.clock.runFor(50);
    const atPause = await probe(page);
    await page.locator('#pause-resume').focus();
    await page.keyboard.press('Space');
    await page.clock.runFor(300);
    const after = await probe(page);
    expect(after.paused).toBe(false);
    expect(after.ticks).toBeGreaterThan(atPause.ticks);
    // Space is the draw key: pressed on RESUME it is not a draw.
    expect(after.drawing).toBe(false);
    expect(after.marker).toEqual(atPause.marker);
    expect(await resumeIsFocused(page)).toBe(false);
  });

  test('Space held down on RESUME through the resume does not draw until it is pressed afresh', async ({ page }) => {
    await open(page);
    await startRun(page);
    // The marker starts on the top border: down leaves it only with a draw key held.
    expect((await probe(page)).marker.y).toBe(0);
    await page.keyboard.press('KeyP');
    await page.clock.runFor(50);
    for (let i = 0; i < 12 && !(await resumeIsFocused(page)); i++) await page.keyboard.press('Tab');
    expect(await resumeIsFocused(page)).toBe(true);

    // Space goes down on the focused RESUME, and is still down when RESUME is
    // pressed (Enter, as a button takes Space only on its release) and gives
    // the focus back: the held Space's auto-repeat then lands on the page.
    await page.keyboard.down('Space');
    await page.keyboard.press('Enter');
    await page.clock.runFor(50);
    expect((await probe(page)).paused).toBe(false);
    expect(await resumeIsFocused(page)).toBe(false);
    await page.keyboard.down('Space');
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', repeat: true }));
    });
    await page.keyboard.down('ArrowDown');
    await page.clock.runFor(300);
    const held = await probe(page);
    expect(held.status).toBe('playing');
    expect(held.drawing).toBe(false);
    expect(held.marker.y).toBe(0);

    await page.keyboard.up('ArrowDown');
    await page.keyboard.up('Space');
    await page.keyboard.down('Space');
    await page.keyboard.down('ArrowDown');
    await page.clock.runFor(150);
    const afresh = await probe(page);
    await page.keyboard.up('ArrowDown');
    await page.keyboard.up('Space');
    expect(afresh.drawing).toBe(true);
    expect(afresh.marker.y).toBeGreaterThan(0);
  });
});

test.describe('a hidden page', () => {
  test('pauses a playing run, stays paused when shown again and resumes with RESUME', async ({ page }) => {
    await open(page);
    await startRun(page);
    await setVisibility(page, 'hidden');
    const atHide = await probe(page);
    expect(atHide.paused).toBe(true);
    await page.clock.runFor(4000);
    await setVisibility(page, 'visible');
    await page.clock.runFor(500);
    const shown = await probe(page);
    expect(shown.paused).toBe(true);
    expect(runState(shown)).toEqual(runState(atHide));
    await page.locator('#pause-resume').click();
    await page.clock.runFor(16);
    const first = await probe(page);
    expect(first.paused).toBe(false);
    expect(first.ticks - atHide.ticks).toBeLessThanOrEqual(1);
  });

  test('does nothing on the Title screen', async ({ page }) => {
    await open(page);
    await setVisibility(page, 'hidden');
    await page.clock.runFor(200);
    await setVisibility(page, 'visible');
    const p = await probe(page);
    expect(p.paused).toBe(false);
    expect(p.status).toBe('title');
    await expect(page.locator('#pause-overlay')).toBeHidden();
  });
});

test('the draw tone stops while paused and comes back on resuming a held line', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('qixxx.muted', 'false'));
  await open(page);
  await startRun(page);
  const tone = () => page.evaluate(() => (window as unknown as { __game__: Hook }).__game__.sfx.isDrawingToneActive());
  await page.keyboard.down('KeyX');
  await page.keyboard.down('ArrowDown');
  await page.clock.runFor(250);
  expect((await probe(page)).drawing).toBe(true);
  expect(await tone()).toBe(true);

  await page.keyboard.press('KeyP');
  await page.clock.runFor(500);
  expect((await probe(page)).paused).toBe(true);
  expect(await tone()).toBe(false);
  // A hidden page stays silent too.
  await setVisibility(page, 'hidden');
  expect(await tone()).toBe(false);
  await setVisibility(page, 'visible');
  await page.clock.runFor(100);
  expect(await tone()).toBe(false);

  await page.keyboard.press('KeyP');
  await page.clock.runFor(100);
  const resumed = await probe(page);
  expect(resumed.paused).toBe(false);
  expect(resumed.drawing).toBe(true);
  expect(await tone()).toBe(true);
  await page.keyboard.up('ArrowDown');
  await page.keyboard.up('KeyX');
});

test.describe('where the run cannot be paused', () => {
  for (const key of ['KeyP', 'Escape']) {
    test(`${key} on Title starts the run as any key does`, async ({ page }) => {
      await open(page);
      expect((await probe(page)).status).toBe('title');
      await page.keyboard.press(key);
      await page.clock.runFor(200);
      const p = await probe(page);
      expect(p.paused).toBe(false);
      expect(p.status).toBe('playing');
      await expect(page.locator('#pause-overlay')).toBeHidden();
    });
  }

  test('P on GAME OVER retries as any key does, never pausing', async ({ page }) => {
    await open(page);
    await startRun(page);
    await loseAllLivesToIgniter(page);
    // Past the miss's hold before the modal and the guard right after it.
    await page.clock.runFor(2500);
    await expect(page.locator('#gameover-modal')).toBeVisible();
    await expect(page.locator('#pause-button')).toBeHidden();
    // The sound toggle's Title-screen glow is not on GAME OVER either.
    await expect(page.locator('#mute-button')).not.toHaveAttribute('data-attention', 'true');
    await page.keyboard.press('KeyP');
    await page.clock.runFor(200);
    const p = await probe(page);
    expect(p.paused).toBe(false);
    expect(p.status).toBe('playing');
    expect(p.lives).toBe(3);
  });
});

// The same seed and the same inputs, tick for tick, with and without pauses:
// the page dispatches the scripted keys itself after the scheduled ticks
// (wrapping the live session's update), and records the run at checkpoints.
const SCRIPT: [number, 'down' | 'up', string][] = [
  [10, 'down', 'KeyX'],
  [10, 'down', 'ArrowDown'],
  [40, 'up', 'ArrowDown'],
  [40, 'down', 'ArrowRight'],
  [70, 'up', 'ArrowRight'],
  [70, 'down', 'ArrowUp'],
  [120, 'up', 'ArrowUp'],
  [120, 'up', 'KeyX'],
  [150, 'down', 'ArrowLeft'],
  [200, 'up', 'ArrowLeft'],
  [220, 'down', 'KeyZ'],
  [220, 'down', 'ArrowDown'],
  [255, 'up', 'ArrowDown'],
  [255, 'down', 'ArrowLeft'],
  [290, 'up', 'ArrowLeft'],
  [290, 'down', 'ArrowUp'],
  [340, 'up', 'ArrowUp'],
  [340, 'up', 'KeyZ'],
];
const CHECKPOINTS = [100, 200, 300, 400, 500];

async function installScript(page: Page): Promise<void> {
  await page.evaluate(
    ({ script, checkpoints }) => {
      type W = { __game__: Hook & { session: { update: (input: unknown) => void } } } & { __checks__: unknown[] };
      const w = window as unknown as W;
      const session = w.__game__.session;
      const original = session.update.bind(session);
      w.__checks__ = [];
      session.update = (input: unknown) => {
        original(input);
        const ticks = session.getTotalTicks();
        if (session.getStatus() !== 'playing' && session.getStatus() !== 'stageclear' && session.getStatus() !== 'gameover') return;
        for (const [at, type, code] of script) {
          if (at === ticks) window.dispatchEvent(new KeyboardEvent(type === 'down' ? 'keydown' : 'keyup', { code }));
        }
        if (checkpoints.includes(ticks)) {
          const game = session.getGame();
          w.__checks__.push({
            ticks,
            score: session.getScore(),
            stage: session.getStage(),
            lives: session.getLives(),
            occupancy: game.getOccupancy(),
            marker: game.getMarker().getPosition(),
            remaining: session.getRemainingTicks(),
          });
        }
      };
    },
    { script: SCRIPT, checkpoints: CHECKPOINTS }
  );
}

const checks = (page: Page) => page.evaluate(() => (window as unknown as { __checks__: unknown[] }).__checks__);

test('a run paused twice along the way plays out exactly as the unpaused one', async ({ browser }) => {
  const run = async (withPauses: boolean) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
    await open(page);
    await installScript(page);
    await page.keyboard.press('Enter');
    if (withPauses) {
      await page.clock.runFor(1500);
      await page.keyboard.press('KeyP');
      await page.clock.runFor(3000);
      // Arrows pressed and let go while paused never reach the run.
      await page.keyboard.down('ArrowRight');
      await page.clock.runFor(300);
      await page.keyboard.up('ArrowRight');
      await page.keyboard.press('KeyP');
      await page.clock.runFor(2700);
      await page.keyboard.press('Escape');
      await page.clock.runFor(2000);
      // An arrow the script is not holding here (letting go of one it holds
      // would be a real release).
      await page.keyboard.down('ArrowRight');
      await page.keyboard.up('ArrowRight');
      await page.keyboard.press('Escape');
    }
    await advanceUntil(page, async () => (await probe(page)).ticks >= 500, 20_000, 1000);
    const result = { checks: await checks(page) };
    await page.close();
    return result;
  };
  const plain = await run(false);
  const paused = await run(true);
  expect(plain.checks).toHaveLength(CHECKPOINTS.length);
  // The script really plays: it claims area before the end.
  expect((plain.checks as { score: number }[])[CHECKPOINTS.length - 1].score).toBeGreaterThan(0);
  expect(paused.checks).toEqual(plain.checks);
});

// ---- Touch, and every screen size --------------------------------------------

// The field and the six touch controls must not move for the PAUSE button or
// the pause screen: compared with themselves on the Title screen (where PAUSE
// is hidden) rather than with measured pixels, which follow the fonts a
// machine has.
const layout = (page: Page) =>
  page.evaluate(() => {
    const r = (el: Element) => {
      const b = el.getBoundingClientRect();
      return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 100) / 100);
    };
    const buttons: Record<string, number[]> = {};
    for (const b of document.querySelectorAll<HTMLElement>('#touch-dpad button, #touch-actions > div:first-child button')) {
      if (b.getBoundingClientRect().width > 0) buttons[b.dataset.code!] = r(b);
    }
    return {
      canvas: r(document.getElementById('game-canvas')!),
      hudTwoLine: (document.getElementById('hud-line2') as HTMLElement).style.display !== 'none',
      buttons,
      hudChildren: [...document.getElementById('hud-row')!.children].map((c) => c.id),
      layout: document.body.dataset.touchLayout,
    };
  });

const VIEWPORTS = [
  { width: 1280, height: 800, touch: false },
  { width: 390, height: 844, touch: true },
  { width: 844, height: 390, touch: true },
  { width: 667, height: 375, touch: true },
];

for (const vp of VIEWPORTS) {
  for (const lang of ['en', 'ja'] as const) {
    test.describe(`${vp.width}x${vp.height} ${lang}${vp.touch ? ' touch' : ''}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });

      test('the pause screen fits the field, and the field, HUD and controls stay where they were', async ({ page }) => {
        await open(page, `?seed=${SEED}&lang=${lang}`);
        const before = await layout(page);
        // The field is 4:3 (rounded to whole pixels); the touch controls are
        // the six, or none without touch.
        expect(Math.abs(before.canvas[2] * 3 - before.canvas[3] * 4)).toBeLessThanOrEqual(4);
        expect(Object.keys(before.buttons).sort()).toEqual(vp.touch ? ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'KeyZ', 'Space'] : []);
        await page.keyboard.press('Enter');
        await page.clock.runFor(300);
        const playing = await layout(page);
        if (vp.touch) {
          await expect(page.locator('#pause-button')).toBeVisible();
          await page.locator('#pause-button').tap();
        } else {
          await expect(page.locator('#pause-button')).toBeHidden();
          await page.keyboard.press('KeyP');
        }
        await page.clock.runFor(50);
        expect((await probe(page)).paused).toBe(true);
        await expect(page.locator('#pause-hint')).toHaveText(
          vp.touch
            ? lang === 'ja' ? 'RESUME を押すと再開' : 'TAP RESUME TO CONTINUE'
            : lang === 'ja' ? 'P か Esc キーで再開' : 'PRESS P OR ESC TO RESUME'
        );
        const paused = await layout(page);
        for (const state of [before, playing, paused]) {
          expect(state.canvas).toEqual(before.canvas);
          expect(state.hudTwoLine).toBe(before.hudTwoLine);
          expect(state.buttons).toEqual(before.buttons);
          expect(state.hudChildren).toEqual(state.layout === 'side' ? ['hud'] : ['hud', 'credit-link', 'mute-button']);
        }

        const fit = await page.evaluate(() => {
          const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
          const o = rect('pause-overlay');
          const inside = (r: DOMRect) => r.left >= o.left && r.right <= o.right && r.top >= o.top && r.bottom <= o.bottom && r.width > 0;
          const font = (id: string) => parseFloat(getComputedStyle(document.getElementById(id)!).fontSize);
          const resume = rect('pause-resume');
          return {
            inside: ['pause-title', 'pause-resume', 'pause-hint'].every((id) => inside(rect(id))),
            resume: [resume.width, resume.height],
            fonts: ['pause-title', 'pause-resume', 'pause-hint'].map(font),
            hintOneBox: document.getElementById('pause-hint')!.scrollWidth <= document.getElementById('pause-hint')!.clientWidth,
          };
        });
        expect(fit.inside).toBe(true);
        expect(fit.hintOneBox).toBe(true);
        expect(Math.min(...fit.resume)).toBeGreaterThanOrEqual(44);
        expect(Math.min(...fit.fonts)).toBeGreaterThanOrEqual(vp.width === 667 ? 10 : 12);

        if (vp.touch) {
          const box = await page.locator('#pause-button').boundingBox();
          expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
          // Tapping RESUME resumes.
          await page.locator('#pause-resume').tap();
          await page.clock.runFor(100);
          expect((await probe(page)).paused).toBe(false);
          expect((await layout(page)).buttons).toEqual(before.buttons);
        }
      });
    });
  }
}

test.describe('the touch PAUSE button', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('shows only while the run can be paused, and pressing it is no game input', async ({ page }) => {
    await open(page);
    await expect(page.locator('#pause-button')).toBeHidden();
    await page.locator('#game-canvas').tap();
    await page.clock.runFor(300);
    const playing = await probe(page);
    expect(playing.status).toBe('playing');
    await expect(page.locator('#pause-button')).toBeVisible();

    await page.locator('#pause-button').tap();
    await page.clock.runFor(16);
    const atPause = await probe(page);
    expect(atPause.paused).toBe(true);
    expect(atPause.drawing).toBe(false);
    expect(atPause.ticks - playing.ticks).toBeLessThanOrEqual(1);
    expect(atPause.marker).toEqual(playing.marker);
    expect(await page.evaluate(() => document.activeElement?.id ?? '')).not.toBe('pause-button');
    // The touch controls and the field do not resume.
    const right = await page.locator('#touch-dpad button[data-code="ArrowRight"]').boundingBox();
    await page.touchscreen.tap(right!.x + right!.width / 2, right!.y + right!.height / 2);
    await page.locator('#pause-overlay').tap({ position: { x: 4, y: 4 } });
    await page.clock.runFor(300);
    expect((await probe(page)).paused).toBe(true);

    // The same button resumes.
    await page.locator('#pause-button').tap();
    await page.clock.runFor(300);
    const resumed = await probe(page);
    expect(resumed.paused).toBe(false);
    expect(resumed.drawing).toBe(false);
    expect(resumed.marker).toEqual(playing.marker);

    await loseAllLivesToIgniter(page);
    await page.clock.runFor(500);
    await expect(page.locator('#pause-button')).toBeHidden();
  });
});
