// Byte-capped request-body reading, shared by every POST handler
// (functions/share.ts, functions/api/scores.ts). Each caller picks its own
// cap sized to the payload it actually expects.

/** What readBodyWithLimit() decided about the request body. */
export type BodyReadResult = { ok: true; text: string } | { ok: false; reason: 'too-large' | 'read-failed' };

/**
 * Reads the request body while counting bytes, aborting the moment the cap
 * is passed.
 *
 * Deliberately NOT `await request.text()` followed by a length check: that
 * buffers the entire body first, so a client that omits or lies about
 * Content-Length can make this public endpoint materialize up to Cloudflare's
 * 100 MB request ceiling inside a Worker with a 128 MB memory limit — an
 * out-of-memory DoS reachable before a single validation runs. The
 * Content-Length pre-check in the handler is only a cheap early-out for
 * honest clients; this is the check that actually holds.
 *
 * Cancels the stream on overflow rather than draining it, so an abusive
 * upload stops costing us anything as soon as it is recognized.
 */
export async function readBodyWithLimit(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<BodyReadResult> {
  if (body === null) return { ok: true, text: '' };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too-large' };
      }
      // `stream: true` so a multi-byte UTF-8 sequence split across chunk
      // boundaries is carried over rather than turned into replacement
      // characters.
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false, reason: 'read-failed' };
  }
}
