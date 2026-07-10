// Shared types for the Phase 2 Cloudflare Pages Functions
// (docs/plan-cloudflare-x-share.md Phase 2). Kept dependency-free (no
// @cloudflare/workers-types imports here) so these types can be imported
// from both the `functions/` tsconfig (which has workers-types as ambient
// globals) and from vitest's `src/`-only tsconfig-less test run, without
// either environment needing the other's ambient globals.

/** The validated request body for POST /qixxx/share. */
export interface ShareRequestPayload {
  score: number;
  stage: number;
  hi: number;
}

/** What's stored in KV under `share:<id>` (functions/qixxx/_lib/kv.ts). */
export interface ShareRecord extends ShareRequestPayload {
  /** `Date.now()` at the time the record was written. */
  at: number;
}

/** The Pages Functions environment bindings (wrangler.toml `[[kv_namespaces]]`). */
export interface Env {
  SHARES: KVNamespace;
}
