// Season/ruleset "current value" constants (docs/plans/2026-08-16-score-
// ranking task 3's confirmed spec): the server, not the client, is the
// source of truth for which season is active. A client never submits a
// season_id — POST /api/scores always stamps the row with CURRENT_SEASON_ID
// below, and GET endpoints always filter by it.
//
// RULESET_VERSION / REPLAY_FORMAT_VERSION live in src/config.ts (shared with
// core/ — the same build's simulation must agree with whatever value gets
// stamped into a submitted row).
//
// Operational rule (docs/ranking-runbook.md §4.1 expands on this): whenever
// RULESET_VERSION changes, CURRENT_SEASON_ID below MUST also be incremented
// by hand, in the same deploy. Forgetting to bump the season is harmless by
// construction — every ranking/replay query filters on
// `season_id = CURRENT_SEASON_ID AND ruleset_version = RULESET_VERSION`
// together (task 3's confirmed "絞り込み規則"), so an old season's rows
// simply never surface even if season_id itself wasn't bumped — but bumping
// it anyway keeps season_id meaningful as "a distinct ruleset era" rather
// than an accidentally-reused number.
export { RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../../src/config';

/** The current season. Bumped by hand (never by a deploy script) to reset the ranking while keeping RULESET_VERSION unchanged — see this module's doc comment and docs/ranking-runbook.md §3. */
export const CURRENT_SEASON_ID = 1;
