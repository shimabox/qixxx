// Response helpers shared by every Function. Static assets get their
// security headers from public/_headers; Pages does NOT apply that file to
// Function responses, so anything a Function returns has to set them here.

/**
 * Headers every Function response carries.
 *
 * - `X-Content-Type-Options: nosniff` — the body is exactly the declared
 *   type (JSON, HTML, PNG); never let a browser second-guess it.
 * - `X-Frame-Options: DENY` / `frame-ancestors 'none'` — nothing served
 *   here is meant to be embedded in another site's frame.
 * - `Referrer-Policy` — don't leak full URLs (share ids) to third parties
 *   the page links out to.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/** Returns a new Headers with SECURITY_HEADERS applied on top of `base`. */
export function withSecurityHeaders(base?: HeadersInit): Headers {
  const headers = new Headers(base);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return headers;
}

/**
 * JSON response with the shared security headers and `Cache-Control:
 * no-store`: every JSON endpoint here is either a mutation result or a
 * live view (ranking, replay) that should be re-fetched, never served from
 * an intermediary cache.
 */
export function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  const responseHeaders = withSecurityHeaders(headers);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}
