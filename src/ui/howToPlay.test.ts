import { describe, expect, it } from 'vitest';
import { HowToConfirmGuard, howToPlayLines, howToPlayPanelLayout } from './howToPlay';
import { HOW_TO_CLOSE_GUARD_TICKS } from '../config';

describe('howToPlayPanelLayout', () => {
  it('lays two rows of two on a tall or roomy screen, one row of four on a wide, low one', () => {
    expect(howToPlayPanelLayout(390, 844).columns).toBe(2);
    expect(howToPlayPanelLayout(1280, 800).columns).toBe(2);
    expect(howToPlayPanelLayout(844, 390).columns).toBe(4);
    expect(howToPlayPanelLayout(667, 375).columns).toBe(4);
  });

  it('keeps the panel on the screen and the pictures within what the height leaves', () => {
    for (const [w, h] of [
      [390, 844],
      [1280, 800],
      [844, 390],
      [667, 375],
      [568, 320],
    ]) {
      const layout = howToPlayPanelLayout(w, h);
      expect(layout.panelWidthPx).toBeLessThanOrEqual(w - 16);
      expect(layout.pictureMaxWidthPx).toBeLessThanOrEqual(200);
      expect(layout.pictureMaxWidthPx).toBeGreaterThan(0);
    }
    // A low screen gets smaller pictures than a roomy one.
    expect(howToPlayPanelLayout(568, 280).pictureMaxWidthPx).toBeLessThan(howToPlayPanelLayout(1280, 800).pictureMaxWidthPx);
  });
});

describe('HowToConfirmGuard', () => {
  it('drops nothing until the panel opens', () => {
    const guard = new HowToConfirmGuard();
    for (let i = 0; i < 30; i++) expect(guard.dropsConfirm()).toBe(false);
  });

  it('drops every confirm while open and for HOW_TO_CLOSE_GUARD_TICKS ticks after it closes', () => {
    const guard = new HowToConfirmGuard();
    guard.setOpen(true);
    for (let i = 0; i < 100; i++) expect(guard.dropsConfirm()).toBe(true);
    guard.setOpen(false);
    for (let i = 0; i < HOW_TO_CLOSE_GUARD_TICKS; i++) expect(guard.dropsConfirm(), `tick ${i}`).toBe(true);
    expect(guard.dropsConfirm()).toBe(false);
  });

  it('starts the wait afresh on each close, and not on a close of a closed panel', () => {
    const guard = new HowToConfirmGuard(3);
    guard.setOpen(true);
    guard.setOpen(false);
    guard.dropsConfirm();
    guard.setOpen(true);
    guard.setOpen(false);
    expect([guard.dropsConfirm(), guard.dropsConfirm(), guard.dropsConfirm(), guard.dropsConfirm()]).toEqual([true, true, true, false]);
    guard.setOpen(false);
    expect(guard.dropsConfirm()).toBe(false);
  });

  it('passes every key-down through until the panel opens', () => {
    const guard = new HowToConfirmGuard();
    expect(guard.keyDown('Enter', false)).toBe(false);
    expect(guard.keyDown('Enter', true)).toBe(false);
  });

  it('keeps the closing key from counting until it is released, past the wait', () => {
    const guard = new HowToConfirmGuard(12);
    guard.setOpen(true);
    // The key-down that closes the panel.
    expect(guard.keyDown('Enter', false)).toBe(true);
    guard.setOpen(false);
    // Its auto-repeat, during the wait and long after it.
    for (let i = 0; i < 120; i++) {
      guard.dropsConfirm();
      expect(guard.keyDown('Enter', true), `tick ${i}`).toBe(true);
    }
    expect(guard.dropsConfirm()).toBe(false);
    // Released and pressed again: a press as usual.
    guard.keyUp('Enter');
    expect(guard.keyDown('Enter', false)).toBe(false);
    expect(guard.keyDown('Enter', true)).toBe(false);
  });

  it('keeps a key pressed while open and still held after CLOSE, and only that key', () => {
    const guard = new HowToConfirmGuard(12);
    guard.setOpen(true);
    expect(guard.keyDown('Space', false)).toBe(true);
    // Closed by CLOSE or the backdrop: the plain wait.
    guard.setOpen(false);
    for (let i = 0; i < 12; i++) expect(guard.dropsConfirm()).toBe(true);
    expect(guard.dropsConfirm()).toBe(false);
    expect(guard.keyDown('Space', true)).toBe(true);
    // Another key is a press of its own.
    expect(guard.keyDown('Enter', false)).toBe(false);
  });

  it('lets the keys go when the window loses focus, or on a fresh press after a missed release', () => {
    const guard = new HowToConfirmGuard(12);
    guard.setOpen(true);
    guard.keyDown('Enter', false);
    guard.keyDown('Space', false);
    guard.setOpen(false);
    guard.releaseAll();
    expect(guard.keyDown('Enter', true)).toBe(false);
    expect(guard.keyDown('Space', true)).toBe(false);

    guard.setOpen(true);
    guard.keyDown('Enter', false);
    guard.setOpen(false);
    // No key-up came, but a non-repeat key-down means it was pressed again.
    expect(guard.keyDown('Enter', false)).toBe(false);
    expect(guard.keyDown('Enter', true)).toBe(false);
  });
});

describe('howToPlayLines', () => {
  it('reads the touch wording of the first line on a touch device', () => {
    expect(howToPlayLines(false)).toEqual(['howTo.draw.key', 'howTo.close', 'howTo.side', 'howTo.split']);
    expect(howToPlayLines(true)).toEqual(['howTo.draw.touch', 'howTo.close', 'howTo.side', 'howTo.split']);
  });
});
