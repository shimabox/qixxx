// Shared types for the Phase 2 Cloudflare Pages Functions
// (docs/plan-cloudflare-x-share.md Phase 2). Kept dependency-free (no
// @cloudflare/workers-types imports here) so these types can be imported
// from both the `functions/` tsconfig (which has workers-types as ambient
// globals) and from vitest's `src/`-only tsconfig-less test run, without
// either environment needing the other's ambient globals.

/** The validated request body for POST /share. */
export interface ShareRequestPayload {
  score: number;
  stage: number;
  hi: number;
}

/** What's stored in KV under `share:<id>` (functions/_lib/kv.ts). */
export interface ShareRecord extends ShareRequestPayload {
  /** `Date.now()` at the time the record was written. */
  at: number;
}

/**
 * The Pages Functions environment bindings (wrangler.toml
 * `[[kv_namespaces]]` / `[[d1_databases]]`). `DB` (docs/plans/2026-08-16-
 * score-ranking task 3) is bound to a *local-only* D1 database until task
 * 7's stop point is cleared with the user — see wrangler.toml's own comment
 * on the `[[d1_databases]]` block for the exact local/production split.
 */
export interface Env {
  SHARES: KVNamespace;
  DB: D1Database;
}
