import { getPlatformProxy } from 'wrangler';
import { fileURLToPath } from 'node:url';

export type AuditD1BindValue = string | number | null;

export interface AuditD1Result<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: { changes: number };
}

export interface AuditD1PreparedStatement {
  bind(...values: AuditD1BindValue[]): AuditD1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<AuditD1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<AuditD1Result<T>>;
}

export interface AuditD1Database {
  prepare(sql: string): AuditD1PreparedStatement;
}

export function resolveDefaultConfigPath(fromUrl: string): string {
  return fileURLToPath(new URL('../../wrangler.toml', fromUrl));
}

export const DEFAULT_CONFIG_PATH = resolveDefaultConfigPath(import.meta.url);

export interface AuditD1Adapter {
  getDb(): Promise<AuditD1Database>;
  dispose(): Promise<void>;
}

export interface LocalPlatformProxyD1AdapterOptions {
  configPath?: string;
}

export class LocalPlatformProxyD1Adapter implements AuditD1Adapter {
  private proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | null = null;
  private readonly configPath: string;

  constructor(options: LocalPlatformProxyD1AdapterOptions = {}) {
    this.configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  }

  async getDb(): Promise<AuditD1Database> {
    if (!this.proxy) {
      this.proxy = await getPlatformProxy<{ DB: D1Database }>({
        configPath: this.configPath,
        persist: true,
      });
    }
    return this.proxy.env.DB;
  }

  async dispose(): Promise<void> {
    if (this.proxy) {
      await this.proxy.dispose();
      this.proxy = null;
    }
  }
}

const CONFIGURATION_ERROR_MESSAGE = 'Remote D1 configuration is incomplete.';
const REQUEST_ERROR_MESSAGE = 'Remote D1 request failed.';
const RESPONSE_ERROR_MESSAGE = 'Remote D1 response is invalid.';
const QUERY_ERROR_MESSAGE = 'Remote D1 query failed.';

export class RemoteD1ConfigurationError extends Error {
  constructor(missingNames: readonly RemoteConfigurationName[] = []) {
    super(missingNames.length === 0 ? CONFIGURATION_ERROR_MESSAGE : `${CONFIGURATION_ERROR_MESSAGE} Missing: ${missingNames.join(', ')}.`);
    this.name = 'RemoteD1ConfigurationError';
  }
}

export class RemoteD1RequestError extends Error {
  constructor() {
    super(REQUEST_ERROR_MESSAGE);
    this.name = 'RemoteD1RequestError';
  }
}

export class RemoteD1ResponseError extends Error {
  constructor() {
    super(RESPONSE_ERROR_MESSAGE);
    this.name = 'RemoteD1ResponseError';
  }
}

export class RemoteD1QueryError extends Error {
  constructor() {
    super(QUERY_ERROR_MESSAGE);
    this.name = 'RemoteD1QueryError';
  }
}

export interface RemoteD1AdapterOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  fetch?: RemoteD1Fetch;
}

export interface RemoteD1RequestInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface RemoteD1Response {
  ok: boolean;
  json(): Promise<unknown>;
}

export type RemoteD1Fetch = (input: string, init: RemoteD1RequestInit) => Promise<RemoteD1Response>;

export const REMOTE_CONFIGURATION_NAMES = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_D1_DATABASE_ID',
  'RANKING_IP_HASH_KEY',
] as const;

export type RemoteConfigurationName = (typeof REMOTE_CONFIGURATION_NAMES)[number];

export function missingRemoteConfiguration(env: Record<string, string | undefined>): RemoteConfigurationName[] {
  return REMOTE_CONFIGURATION_NAMES.filter((name) => !nonEmpty(env[name] ?? ''));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCell(value: unknown): unknown {
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value as number[]).buffer;
  }
  return value;
}

function normalizeRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new RemoteD1ResponseError();
  return value.map((row) => Object.fromEntries(Object.entries(row).map(([key, cell]) => [key, normalizeCell(cell)])));
}

function parseResult(value: unknown): AuditD1Result<Record<string, unknown>> {
  if (!isRecord(value)) throw new RemoteD1ResponseError();
  if (value.success === false) throw new RemoteD1QueryError();
  if (value.success !== true) throw new RemoteD1ResponseError();
  const results = normalizeRows(value.results);
  if (!isRecord(value.meta) || !Number.isInteger(value.meta.changes) || (value.meta.changes as number) < 0) {
    throw new RemoteD1ResponseError();
  }
  return { results, success: true, meta: { changes: value.meta.changes as number } };
}

class RemoteD1PreparedStatement implements AuditD1PreparedStatement {
  constructor(
    private readonly execute: (sql: string, params: AuditD1BindValue[]) => Promise<AuditD1Result<Record<string, unknown>>>,
    private readonly sql: string,
    private readonly params: AuditD1BindValue[] = []
  ) {}

  bind(...values: AuditD1BindValue[]): AuditD1PreparedStatement {
    return new RemoteD1PreparedStatement(this.execute, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.execute(this.sql, this.params);
    return (result.results[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<AuditD1Result<T>> {
    return this.execute(this.sql, this.params) as Promise<AuditD1Result<T>>;
  }

  async run<T = Record<string, unknown>>(): Promise<AuditD1Result<T>> {
    return this.execute(this.sql, this.params) as Promise<AuditD1Result<T>>;
  }
}

export class RemoteD1Adapter implements AuditD1Adapter {
  private readonly endpoint: string;
  private readonly apiToken: string;
  private readonly fetchImpl: RemoteD1Fetch;
  private readonly db: AuditD1Database;

  constructor(options: RemoteD1AdapterOptions) {
    if (!nonEmpty(options.accountId) || !nonEmpty(options.databaseId) || !nonEmpty(options.apiToken)) {
      throw new RemoteD1ConfigurationError();
    }
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}/query`;
    this.apiToken = options.apiToken;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.db = {
      prepare: (sql: string) => new RemoteD1PreparedStatement(this.execute.bind(this), sql),
    };
  }

  private async execute(sql: string, params: AuditD1BindValue[]): Promise<AuditD1Result<Record<string, unknown>>> {
    let response: RemoteD1Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
      });
    } catch {
      throw new RemoteD1RequestError();
    }
    if (!response.ok) throw new RemoteD1RequestError();

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new RemoteD1ResponseError();
    }
    if (!isRecord(envelope)) throw new RemoteD1ResponseError();
    if (envelope.success === false) throw new RemoteD1QueryError();
    if (envelope.success !== true || !Array.isArray(envelope.result) || envelope.result.length !== 1) {
      throw new RemoteD1ResponseError();
    }
    return parseResult(envelope.result[0]);
  }

  async getDb(): Promise<AuditD1Database> {
    return this.db;
  }

  async dispose(): Promise<void> {}
}
