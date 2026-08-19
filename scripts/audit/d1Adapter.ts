// D1 connection boundary for the Node-side async audit script
// (docs/plans/2026-08-19-ranking-free-async spec item 11): everything else
// under scripts/audit/ operates on a plain `D1Database` (the same
// @cloudflare/workers-types interface functions/api/*.ts already uses), so
// swapping how that D1Database is obtained never touches verification/lock/
// cleanup logic — only this file.
//
// Local implementation (LocalPlatformProxyD1Adapter): wraps wrangler's
// `getPlatformProxy()`, which — confirmed feasible before this task's
// scripts/audit implementation began (docs/plans/2026-08-19-ranking-free-
// async request.md spec item 11's required pre-check) — hands a Node
// process the SAME local D1 binding `wrangler pages dev`/`wrangler d1
// migrations apply --local` use, with zero Cloudflare account calls:
//
//   const proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: true });
//   proxy.env.DB.prepare('SELECT 1').all();  // real D1 semantics, local file-backed SQLite
//
// `persist: true` matters: without it, getPlatformProxy() defaults to an
// in-memory D1 that starts empty every run, rather than sharing the same
// on-disk `.wrangler/state/` database `wrangler pages dev` and `wrangler d1
// migrations apply --local` already write to.
//
// Remote implementation: intentionally NOT implemented in this round (this
// feature's request.md "やらないこと": "本番デプロイ・GitHub Actions の本番
// 接続...は行わない"). RemoteD1Adapter exists only as a documented stub so
// the interface itself is exercised end-to-end and the future swap-in point
// is unambiguous — see its own doc comment for the two real options it
// would choose between.
import { getPlatformProxy } from 'wrangler';

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
 * Local dev implementation (spec item 11's "第一候補"), backed by wrangler's
 * `getPlatformProxy()`. This is what scripts/audit/cli.ts uses for every
 * local manual-run invocation, and what this feature's own integration
 * tests (scripts/audit/*.test.ts) use to exercise the audit logic against
 * real D1/SQLite semantics (transactions, UNIQUE constraints, AUTOINCREMENT,
 * concurrent-statement behavior) rather than a hand-rolled mock.
 */
export class LocalPlatformProxyD1Adapter implements AuditD1Adapter {
  private proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | null = null;
  private readonly configPath: string;

  constructor(options: LocalPlatformProxyD1AdapterOptions = {}) {
    this.configPath = options.configPath ?? new URL('../../wrangler.toml', import.meta.url).pathname;
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
 * Production (remote D1) implementation — NOT implemented this round (this
 * feature's explicit scope boundary: no real D1 authentication/connection
 * work, see request.md's "やらないこと" and plan.md's "Actions(本番)から D1
 * への接続方式" open item). The real choice when this IS implemented is
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
      'RemoteD1Adapter is not implemented in this round (docs/plans/2026-08-19-ranking-free-async scope: no real D1 authentication/connection work). See docs/ranking-audit-runbook.md for the production connection design.'
    );
  }

  async getDb(): Promise<D1Database> {
    throw new Error('unreachable: constructor already throws');
  }

  async dispose(): Promise<void> {
    /* unreachable */
  }
}
