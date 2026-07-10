// GET /qixxx/og?id=... (docs/plan-cloudflare-x-share.md Phase 2): renders
// the 1200x630 PNG social card for a share ID, using workers-og's Satori
// -based ImageResponse. Unknown ids are 404 (no fallback/placeholder card is
// ever generated for a nonexistent id, so a guessed/tampered id can't
// produce anything). The card's content is entirely numeric/ASCII labels
// (docs/plan-cloudflare-x-share.md's decision: "OG カード画像内の文字は英数
// 字のみ") — no Japanese text is ever rendered into the image, keeping the
// bundled font to a single lightweight Latin/ASCII face (see
// _lib/fonts/pressStart2P.ts).
import { ImageResponse } from 'workers-og';
import type { Env, ShareRecord } from './_lib/types';
import { shareRecordKey } from './_lib/kv';
import { PRESS_START_2P_TTF_BASE64 } from './_lib/fonts/pressStart2P';
import { COLOR_BACKGROUND, COLOR_BORDER, COLOR_CLAIMED_SLOW, HUD_TEXT_COLOR } from '../../src/config';

const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 630;
const FONT_FAMILY = 'Press Start 2P';

let cachedFontData: ArrayBuffer | null = null;

/** Decodes the base64-embedded TTF once per isolate (Workers reuse isolates across requests). */
function decodePressStart2P(): ArrayBuffer {
  if (cachedFontData) return cachedFontData;
  const binary = atob(PRESS_START_2P_TTF_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  cachedFontData = bytes.buffer;
  return cachedFontData;
}

function formatWithCommas(value: number): string {
  return value.toLocaleString('en-US');
}

// Fixed content width the card's inner (bordered) area renders at: IMAGE_WIDTH
// minus the outer padding (40px * 2) and the card's own padding (56px * 2).
// Every row below is pinned to this same width, with a fixed-width label
// column (STAT_LABEL_WIDTH) so all three value columns start at the same x
// regardless of how wide "SCORE"/"STAGE"/"HI" or their values are — using
// `justify-content: space-between` per row instead (right-aligning each
// value to the row's own edge) left rows visually stair-stepped since each
// value's width differs.
const CONTENT_WIDTH = IMAGE_WIDTH - 2 * 40 - 2 * 56;
const STAT_LABEL_WIDTH = 260;

function statRow(label: string, value: string, color: string, big: boolean): string {
  const valueFontSize = big ? '96px' : '56px';
  return `
    <div style="display:flex; align-items:baseline; width:${CONTENT_WIDTH}px;">
      <span style="display:flex; width:${STAT_LABEL_WIDTH}px; color:${HUD_TEXT_COLOR}; font-size:32px;">${label}</span>
      <span style="display:flex; color:${color}; font-size:${valueFontSize};">${value}</span>
    </div>
  `;
}

function renderCardHtml(record: ShareRecord): string {
  const scoreText = formatWithCommas(record.score);
  const stageText = String(record.stage);
  const hiText = formatWithCommas(record.hi);

  return `
    <div style="display:flex; flex-direction:column; width:${IMAGE_WIDTH}px; height:${IMAGE_HEIGHT}px; background:${COLOR_BACKGROUND}; font-family:'${FONT_FAMILY}'; padding:40px; box-sizing:border-box;">
      <div style="display:flex; flex-direction:column; flex:1; width:100%; border:6px solid ${COLOR_BORDER}; border-radius:16px; padding:56px; box-sizing:border-box; justify-content:space-between;">
        <div style="display:flex;">
          <span style="color:${COLOR_BORDER}; font-size:64px;">QIXXX</span>
        </div>
        <div style="display:flex; flex-direction:column; width:${CONTENT_WIDTH}px;">
          ${statRow('SCORE', scoreText, COLOR_BORDER, true)}
          ${statRow('STAGE', stageText, HUD_TEXT_COLOR, false)}
          ${statRow('HI', hiText, COLOR_CLAIMED_SLOW, false)}
        </div>
      </div>
    </div>
  `;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (id === null || id === '') {
    return new Response('Not Found', { status: 404 });
  }

  const raw = await env.SHARES.get(shareRecordKey(id));
  if (raw === null) {
    return new Response('Not Found', { status: 404 });
  }

  const record = JSON.parse(raw) as ShareRecord;
  const html = renderCardHtml(record);

  const image = new ImageResponse(html, {
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    fonts: [
      {
        name: FONT_FAMILY,
        data: decodePressStart2P(),
        weight: 400,
        style: 'normal',
      },
    ],
  });

  // The record (and therefore this image) is immutable once written — a
  // given id's content never changes — so this can be cached for a full
  // year (docs/plan-cloudflare-x-share.md Phase 2).
  const headers = new Headers(image.headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(image.body, { status: 200, headers });
};
