// D1 connection boundary for the Node-side async audit script: everything else
// under scripts/audit/ operates on a plain `D1Database` (the same
// @cloudflare/workers-types interface functions/api/*.ts already uses), so
// swapping how that D1Database is obtained never touches verification/lock/
// cleanup logic — only this file.
//
// Local implementation (LocalPlatformProxyD1Adapter): wraps wrangler's
// `getPlatformProxy()`, which hands a Node process the same local D1 binding
// `wrangler pages dev`/`wrangler d1
// migrations apply --local` use, with zero Cloudflare account calls:
//
// const proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: true });
// proxy.env.DB.prepare('SELECT 1').all(); // real D1 semantics, local file-backed SQLite
//
// `persist: true` matters: without it, getPlatformProxy() defaults to an
// in-memory D1 that starts empty every run, rather than sharing the same
// on-disk `.wrangler/state/` database `wrangler pages dev` and `wrangler d1
// migrations apply --local` already write to.
//
// Remote implementation is intentionally not wired. RemoteD1Adapter exists
// as a documented stub so
// the interface itself is exercised end-to-end and the future swap-in point
// is unambiguous — see its own doc comment for the two real options it
// would choose between.
import { getPlatformProxy } from 'wrangler';
import { fileURLToPath } from 'node:url';

export function resolveDefaultConfigPath(fromUrl: string): string {
  return fileURLToPath(new URL('../../wrangler.toml', fromUrl));
}

export const DEFAULT_CONFIG_PATH = resolveDefaultConfigPath(import.meta.url);

export interface AuditD1Adapter {
  /** Returns the D1Database binding this adapter connects to. May be called more than once (should return the same instance/connection). */
  getDb(): Promise<D1Database>;
  /** Releases any underlying process/connection this adapter opened. Safe to call even if getDb() was never called. */
  dispose(): Promise<void>;
}

export interface LocalPlatformProxyD1AdapterOptions {
  /** Path to wrangler.toml. Defaults to the repo-root wrangler.toml (this file's location, two directories up). */
  configPath?: string;
}

/**
 * Local development implementation backed by wrangler's
 * `getPlatformProxy()`. This is what scripts/audit/cli.ts uses for every
 * local manual-run invocation, and what the integration
 * tests (scripts/audit/*.test.ts) use to exercise the audit logic against
 * real D1/SQLite semantics (transactions, UNIQUE constraints, AUTOINCREMENT,
 * concurrent-statement behavior) rather than a hand-rolled mock.
 */
export class LocalPlatformProxyD1Adapter implements AuditD1Adapter {
  private proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | null = null;
  private readonly configPath: string;

  constructor(options: LocalPlatformProxyD1AdapterOptions = {}) {
    this.configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  }

  async getDb(): Promise<D1Database> {
    if (!this.proxy) {
      this.proxy = await getPlatformProxy<{ DB: D1Database }>({
        configPath: this.configPath,
        // Share the same on-disk local D1 wrangler pages dev / wrangler d1
        // migrations apply --local already write to — see this module's own
        // doc comment for why the default (in-memory, non-persisted) proxy
        // would be useless here (a fresh empty DB every audit run).
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

/**
 * Production (remote D1) implementation is not wired. The real choice is
 * between `wrangler d1 execute --remote` (shelling out, parsing its output)
 * and D1's HTTP REST API (an authenticated fetch call per statement/batch) —
 * documented in docs/ranking-audit-runbook.md rather than decided here.
 * Throwing on construction (not merely on getDb()) means a caller that
 * accidentally wires this in locally fails immediately and loudly, not
 * several steps into an audit run.
 */
export class RemoteD1Adapter implements AuditD1Adapter {
  constructor() {
    throw new Error(
      'RemoteD1Adapter is not implemented. See docs/ranking-audit-runbook.md for the production connection design.'
    );
  }

  async getDb(): Promise<D1Database> {
    throw new Error('unreachable: constructor already throws');
  }

  async dispose(): Promise<void> {
    /* unreachable */
  }
}
