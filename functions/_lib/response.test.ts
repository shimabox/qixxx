import { describe, it, expect } from 'vitest';
import { jsonResponse, withSecurityHeaders, SECURITY_HEADERS } from './response';

describe('withSecurityHeaders', () => {
  it('adds every security header on top of the caller-supplied ones', () => {
    const headers = withSecurityHeaders({ 'content-type': 'text/html' });
    expect(headers.get('content-type')).toBe('text/html');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(headers.get(name)).toBe(value);
    }
  });
});

describe('jsonResponse', () => {
  it('is JSON, uncacheable, and carries the security headers', async () => {
    const response = jsonResponse({ ok: true }, 201, { 'Retry-After': '30' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});
