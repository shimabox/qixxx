import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG_PATH,
  RemoteD1Adapter,
  RemoteD1ConfigurationError,
  RemoteD1QueryError,
  RemoteD1RequestError,
  RemoteD1ResponseError,
  resolveDefaultConfigPath,
  type RemoteD1Fetch,
  type RemoteD1RequestInit,
  type RemoteD1Response,
} from './d1Adapter';
import { safeErrorDetail } from './logSafety';

describe('LocalPlatformProxyD1Adapter default config path', () => {
  it('decodes spaces and non-ASCII characters in the source file URL', () => {
    const configPath = resolveDefaultConfigPath(
      'file:///tmp/my%20repo/%E6%97%A5%E6%9C%AC%E8%AA%9E/scripts/audit/d1Adapter.ts'
    );

    expect(configPath).toContain('my repo');
    expect(configPath).toContain('日本語');
    expect(configPath).not.toContain('%20');
    expect(path.basename(configPath)).toBe('wrangler.toml');
  });

  it.skipIf(process.platform !== 'win32')('removes the leading slash from a Windows drive path', () => {
    expect(
      resolveDefaultConfigPath('file:///C:/my%20repo/scripts/audit/d1Adapter.ts')
    ).toBe('C:\\my repo\\wrangler.toml');
  });

  it('is a decoded filesystem path to the repository wrangler.toml', () => {
    expect(DEFAULT_CONFIG_PATH).not.toContain('%20');
    expect(path.basename(DEFAULT_CONFIG_PATH)).toBe('wrangler.toml');
    expect(fs.existsSync(DEFAULT_CONFIG_PATH)).toBe(true);
  });
});

const ACCOUNT_ID = 'fake-account-id';
const DATABASE_ID = 'fake-database-id';
const API_TOKEN = 'fake-api-token';

function jsonResponse(body: unknown, status = 200): RemoteD1Response {
  return { ok: status >= 200 && status < 300, json: async () => body };
}

function successEnvelope(results: unknown[] = [], changes = 0): unknown {
  return { success: true, result: [{ success: true, results, meta: { changes } }] };
}

function createRemote(fetchStub: RemoteD1Fetch): RemoteD1Adapter {
  return new RemoteD1Adapter({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetch: fetchStub });
}

describe('RemoteD1Adapter', () => {
  it('sends a single authenticated request with SQL and ordered bind values separated', async () => {
    const fetchStub = vi.fn<[string, RemoteD1RequestInit], Promise<RemoteD1Response>>().mockResolvedValue(jsonResponse(successEnvelope([{ value: 7 }], 0)));
    const adapter = createRemote(fetchStub);
    const db = await adapter.getDb();

    await expect(db.prepare('SELECT ?1, ?2').bind('text', 42).first<{ value: number }>()).resolves.toEqual({ value: 7 });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    });
    const body = JSON.parse(String(init?.body)) as { sql: string; params: unknown[] };
    expect(body).toEqual({ sql: 'SELECT ?1, ?2', params: ['text', '42'] });
    expect(body.params.every((param) => typeof param === 'string')).toBe(true);
    expect(String(init?.body)).not.toContain(API_TOKEN);
  });

  it('returns the same facade, supports first null, all, run, and changes', async () => {
    const fetchStub = vi
      .fn<[string, RemoteD1RequestInit], Promise<RemoteD1Response>>()
      .mockResolvedValueOnce(jsonResponse(successEnvelope([], 0)))
      .mockResolvedValueOnce(jsonResponse(successEnvelope([{ id: 'returned' }], 1)))
      .mockResolvedValueOnce(jsonResponse(successEnvelope([{ id: 'a' }, { id: 'b' }], 0)))
      .mockResolvedValueOnce(jsonResponse(successEnvelope([{ id: 'updated' }], 1)));
    const adapter = createRemote(fetchStub);
    const db = await adapter.getDb();
    expect(await adapter.getDb()).toBe(db);

    await expect(db.prepare('UPDATE scores SET status = ?1 RETURNING id').bind('verified').first()).resolves.toBeNull();
    await expect(db.prepare('UPDATE scores SET status = ?1 RETURNING id').bind('verified').first<{ id: string }>()).resolves.toEqual({ id: 'returned' });
    await expect(db.prepare('SELECT id FROM scores').all<{ id: string }>()).resolves.toEqual({
      success: true,
      results: [{ id: 'a' }, { id: 'b' }],
      meta: { changes: 0 },
    });
    await expect(db.prepare('UPDATE scores SET status = ?1 RETURNING id').bind('verified').run<{ id: string }>()).resolves.toEqual({
      success: true,
      results: [{ id: 'updated' }],
      meta: { changes: 1 },
    });
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });

  it('normalizes numeric-array BLOB cells to ArrayBuffer', async () => {
    const fetchStub = vi.fn<[string, RemoteD1RequestInit], Promise<RemoteD1Response>>().mockResolvedValue(jsonResponse(successEnvelope([{ id: 'row', inputs: [0, 1, 127, 255] }], 0)));
    const db = await createRemote(fetchStub).getDb();
    const row = await db.prepare('SELECT inputs FROM scores').first<{ inputs: ArrayBuffer }>();

    expect(row?.inputs).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(row!.inputs)]).toEqual([0, 1, 127, 255]);
  });

  it.each([
    ['fetch rejection', () => Promise.reject(new Error('socket secret')), RemoteD1RequestError],
    ['HTTP failure', () => Promise.resolve(jsonResponse({ secret: 'raw body' }, 403)), RemoteD1RequestError],
    ['invalid JSON', () => Promise.resolve({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }), RemoteD1ResponseError],
    ['non-object envelope', () => Promise.resolve(jsonResponse([])), RemoteD1ResponseError],
    ['top-level query failure', () => Promise.resolve(jsonResponse({ success: false, errors: [{ message: 'secret' }] })), RemoteD1QueryError],
    ['result query failure', () => Promise.resolve(jsonResponse({ success: true, result: [{ success: false, errors: [{ message: 'secret' }] }] })), RemoteD1QueryError],
    ['missing result', () => Promise.resolve(jsonResponse({ success: true })), RemoteD1ResponseError],
    ['multiple results', () => Promise.resolve(jsonResponse({ success: true, result: [{}, {}] })), RemoteD1ResponseError],
    ['invalid results', () => Promise.resolve(jsonResponse({ success: true, result: [{ success: true, results: {}, meta: { changes: 0 } }] })), RemoteD1ResponseError],
    ['missing changes', () => Promise.resolve(jsonResponse({ success: true, result: [{ success: true, results: [], meta: {} }] })), RemoteD1ResponseError],
    ['invalid changes', () => Promise.resolve(jsonResponse({ success: true, result: [{ success: true, results: [], meta: { changes: -1 } }] })), RemoteD1ResponseError],
  ])('classifies %s without retrying or writing to console', async (_label, response, ErrorClass) => {
    const fetchStub = vi.fn<[string, RemoteD1RequestInit], Promise<RemoteD1Response>>().mockImplementation(response);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(createRemote(fetchStub).getDb().then((db) => db.prepare('SECRET SQL ?1').bind('secret-param').run())).rejects.toBeInstanceOf(ErrorClass);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });

  it('does not retain external response or request details in errors or opted-in detail', async () => {
    const forbidden = [API_TOKEN, ACCOUNT_ID, DATABASE_ID, 'SECRET SQL', 'secret-param', 'ip_hash_value', '/Users/private/database.sqlite'];
    const fetchStub = vi.fn<[string, RemoteD1RequestInit], Promise<RemoteD1Response>>().mockResolvedValue(
      jsonResponse({
        success: false,
        errors: [{ message: forbidden.join(' ') }],
      })
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let caught: unknown;
    try {
      await createRemote(fetchStub).getDb().then((db) => db.prepare('SECRET SQL').bind('secret-param').run());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RemoteD1QueryError);
    const published = `${(caught as Error).message}\n${safeErrorDetail(caught)}`;
    for (const value of forbidden) expect(published).not.toContain(value);
    expect('cause' in (caught as object)).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    log.mockRestore();
    consoleError.mockRestore();
  });

  it.each([
    [{ accountId: '', databaseId: DATABASE_ID, apiToken: API_TOKEN }],
    [{ accountId: ACCOUNT_ID, databaseId: '   ', apiToken: API_TOKEN }],
    [{ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: '' }],
  ])('rejects incomplete configuration before fetch', (options) => {
    const fetchStub = vi.fn<[string, RemoteD1RequestInit], Promise<RemoteD1Response>>();
    expect(() => new RemoteD1Adapter({ ...options, fetch: fetchStub })).toThrow(RemoteD1ConfigurationError);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
