import { describe, expect, it } from 'vitest';
import { placeTitleMenu, rectsOverlap, type TitleMenuPlacementInput, type TitleMenuRect } from './titleMenu';
import { TITLE_MENU_BELOW_GAP_PX, TITLE_MENU_GAP_PX, TITLE_MENU_INSET_PX } from '../config';

const rect = (left: number, top: number, width: number, height: number): TitleMenuRect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

// A 400x300 field at (100, 50) with the title text in its middle, the DEMO
// tag's corner bottom-left, and the page showing a good deal below it.
function input(overrides: Partial<TitleMenuPlacementInput> = {}): TitleMenuPlacementInput {
  return {
    field: rect(100, 50, 400, 300),
    screen: rect(200, 160, 200, 60),
    demoReserve: rect(108, 330, 34, 12),
    visible: rect(100, 0, 400, 500),
    avoid: [],
    width: 280,
    targetHeight: 28,
    edgeHeight: 16,
    ...overrides,
  };
}

describe('placeTitleMenu', () => {
  it('puts the row under the title text, centred on the field, when it fits there', () => {
    const { placement, rect: r } = placeTitleMenu(input());
    expect(placement).toBe('under-text');
    expect(r.top).toBe(220 + TITLE_MENU_GAP_PX);
    expect(r.bottom - r.top).toBe(28);
    expect((r.left + r.right) / 2).toBe(300);
    expect(r.right - r.left).toBe(280);
  });

  it('goes under the field when the text leaves no room under it inside the field', () => {
    const { placement, rect: r } = placeTitleMenu(input({ screen: rect(200, 120, 200, 200) }));
    expect(placement).toBe('below-field');
    expect(r.top).toBe(350 + TITLE_MENU_BELOW_GAP_PX);
    expect(r.bottom - r.top).toBe(28);
  });

  it('keeps the field\'s bottom inset free under the text', () => {
    // The row would end exactly on the field's bottom edge.
    const screenBottom = 350 - 28 - TITLE_MENU_GAP_PX;
    expect(placeTitleMenu(input({ screen: rect(200, 200, 200, screenBottom - 200), demoReserve: rect(0, 0, 0, 0) })).placement).toBe('below-field');
    const fits = screenBottom - TITLE_MENU_INSET_PX;
    expect(placeTitleMenu(input({ screen: rect(200, 200, 200, fits - 200), demoReserve: rect(0, 0, 0, 0) })).placement).toBe('under-text');
  });

  it('keeps clear of the DEMO tag\'s corner, shown or not', () => {
    const wide = input({ width: 390, screen: rect(200, 200, 200, 100) });
    expect(placeTitleMenu({ ...wide, demoReserve: rect(108, 400, 34, 12) }).placement).toBe('under-text');
    expect(placeTitleMenu(wide).placement).toBe('below-field');
  });

  it('keeps clear of a touch control\'s hit area', () => {
    const avoid = [rect(250, 230, 100, 20)];
    expect(placeTitleMenu(input({ avoid })).placement).toBe('below-field');
  });

  it('does not go under the field where the page would clip it, or over text reaching below the field', () => {
    const tall = rect(200, 120, 200, 200);
    expect(placeTitleMenu(input({ screen: tall, visible: rect(100, 0, 400, 370) })).placement).toBe('field-bottom');
    expect(placeTitleMenu(input({ screen: rect(200, 120, 200, 240) })).placement).toBe('field-bottom');
    // Wider than the column it would sit in.
    expect(placeTitleMenu(input({ screen: tall, visible: rect(170, 0, 260, 500) })).placement).toBe('field-bottom');
    // Over a touch control's hit area.
    expect(placeTitleMenu(input({ screen: tall, avoid: [rect(0, 370, 200, 100)] })).placement).toBe('field-bottom');
  });

  it('along the field\'s bottom edge, sits on the inset, raised above a hit area reaching up into the field', () => {
    const base = input({ screen: rect(200, 120, 200, 200), visible: rect(100, 0, 400, 350) });
    const plain = placeTitleMenu(base);
    expect(plain.placement).toBe('field-bottom');
    expect(plain.rect.bottom).toBe(350 - TITLE_MENU_INSET_PX);
    expect(plain.rect.bottom - plain.rect.top).toBe(16);

    const hit = rect(0, 344, 224, 216);
    const raised = placeTitleMenu({ ...base, avoid: [hit] });
    expect(raised.placement).toBe('field-bottom');
    expect(raised.rect.bottom).toBe(344);
    expect(rectsOverlap(raised.rect, hit)).toBe(false);
  });

  it('ignores an empty box among what it must avoid', () => {
    expect(placeTitleMenu(input({ avoid: [rect(0, 0, 0, 0), rect(250, 240, 0, 10)] })).placement).toBe('under-text');
  });
});
