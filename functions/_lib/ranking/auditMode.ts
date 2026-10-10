// RANKING_AUDIT_MODE — whether POST /api/scores stores a new submission for
// the asynchronous audit (scripts/audit/) or straight onto the ranking.
//
// - 'enabled' (the default): stored as `status='pending'`, promoted to
//   'verified' or deleted later by the audit. Exactly the behavior this
//   endpoint had before the variable existed.
// - 'disabled': stored as `status='verified'` immediately, with the client's
//   score/stage claim taken at face value. Nothing re-simulates the replay.
//
// Only the literal `disabled` (after trim + lower-casing) turns the audit off.
// Unset, empty and unrecognized values all fall back to 'enabled': a typo or a
// missing variable then leaves unverified scores pending — still auditable
// for 72h — instead of silently making them confirmed ranks.
//
// The mode only matters at POST's write time. Every later reader (GET
// /api/ranking, the replay endpoint, the audit itself) decides from the
// stored `status` alone and never consults this.

export type AuditMode = 'enabled' | 'disabled';

export function resolveAuditMode(raw: string | undefined): AuditMode {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'disabled') return 'disabled';
  if (normalized !== '' && normalized !== 'enabled') {
    // The value itself is deliberately not logged: Pages may hold this
    // variable as a secret, and a mistyped one could be anything.
    console.warn('RANKING_AUDIT_MODE has an unrecognized value; falling back to the audited mode');
  }
  return 'enabled';
}
