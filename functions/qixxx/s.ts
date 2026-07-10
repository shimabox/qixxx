// GET /qixxx/s?id=... (docs/plan-cloudflare-x-share.md Phase 2): serves an
// OG-tagged HTML page for a share ID minted by POST /qixxx/share. X's
// crawler reads the <meta> tags without executing JS; a human visitor's
// browser runs the redirect script and lands on the game itself. An unknown
// (or missing) id is a 404 — there being no fallback content means a
// tampered/guessed id can never render a card.
import type { Env, ShareRecord } from './_lib/types';
import { shareRecordKey } from './_lib/kv';

function formatWithCommas(value: number): string {
  return value.toLocaleString('en-US');
}

function renderHtml(record: ShareRecord, origin: string, id: string): string {
  const gameUrl = `${origin}/qixxx/`;
  const shareUrl = `${origin}/qixxx/s?id=${encodeURIComponent(id)}`;
  const ogImageUrl = `${origin}/qixxx/og?id=${encodeURIComponent(id)}`;
  const title = `QIXXX — SCORE ${formatWithCommas(record.score)}`;
  const description = `STAGE ${record.stage} / HI ${formatWithCommas(record.hi)}`;

  // score/stage/hi are guaranteed non-negative integers by share.ts's
  // validateSharePayload before ever reaching KV, so no free-text/HTML
  // escaping is needed for the values interpolated below.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${ogImageUrl}">
<meta property="og:url" content="${shareUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${ogImageUrl}">
<script>
  // JS redirect, not meta refresh (docs/plan-cloudflare-x-share.md Phase 2):
  // link-preview crawlers (which only read the <meta> tags above) never run
  // this; a human's browser does, and lands on the game immediately.
  window.location.replace(${JSON.stringify(gameUrl)});
</script>
</head>
<body>
  <p>Redirecting to <a href="${gameUrl}">QIXXX</a>&hellip;</p>
</body>
</html>
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
  const html = renderHtml(record, url.origin, id);
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
};
