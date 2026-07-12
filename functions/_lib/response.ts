// Tiny JSON response helper shared by share.ts (the only Function that
// returns JSON — s.ts returns HTML, og.ts returns a PNG).
export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
