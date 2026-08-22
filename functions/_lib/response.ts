// Tiny JSON response helper shared by share.ts (the only Function that
// returns JSON — s.ts returns HTML, og.ts returns a PNG).
export function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}
