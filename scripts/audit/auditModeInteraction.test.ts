// How the audit (runAudit.ts, unchanged) interacts with rows written while
// RANKING_AUDIT_MODE=disabled, and the operator SQL that docs/
// ranking-audit-runbook.md gives for switching between the modes — all
// against a real local D1, with rows written through the real POST handler.
//
// The audit cannot know which mode Pages runs in (it is a separate Node
// process reading D1 directly), so this file pins what it DOES do with
// audit-free rows rather than adding a guard:
// - run by mistake while the mode is disabled: nothing is pending, so nothing
//   is verified, but the TOP10 cleanup deletes the current season's verified
//   rows below 10th place — unaudited rows, irreversibly;
// - after the runbook's re-audit SQL: the verified rows become pending again
//   with a fresh created_at, so the audit re-verifies the honest ones and
//   deletes the forged ones, and its expiry sweep deletes none of them.
//
// Every SQL statement below is also asserted to appear VERBATIM in the
// runbook, so the text an operator copies is the text tested here.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestD1, seedScoreRow, type TestD1 } from './testSupport/localD1';
import { runAudit } from './runAudit';
import { onRequestPost } from '../../functions/api/scores';
import { CURRENT_SEASON_ID, RULESET_VERSION, REPLAY_FORMAT_VERSION } from '../../functions/_lib/ranking/season';
import { computeSubmitterHash } from '../../functions/_lib/ranking/submitterToken';
import { PENDING_EXPIRY_MS } from '../../functions/_lib/ranking/pendingGate';
import { GameSession } from '../../src/core/session';
import { encodeRle, type InputSample } from '../../src/core/rle';

const RUNBOOK_PATH = fileURLToPath(new URL('../../docs/ranking-audit-runbook.md', import.meta.url));
const SELF_ORIGIN = 'https://qixxx.example';
const IP_HASH_KEY = 'audit-mode-interaction-test-hmac-key';
const TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';

/** なし → あり: send every current-version verified row back to the audit. */
const REAUDIT_SQL = `UPDATE scores
SET status = 'pending', audit_attempts = 0, next_attempt_at = NULL,
    submitter_hash = NULL, created_at = unixepoch() * 1000
WHERE status = 'verified'
  AND season_id = <CURRENT_SEASON_ID>
  AND ruleset_version = <RULESET_VERSION>
  AND replay_format_version = <REPLAY_FORMAT_VERSION>;`;

/** あり → なし: treat the remaining current-version pending rows the way the audit-free mode would have stored them. */
const PENDING_TO_VERIFIED_SQL = `UPDATE scores
SET status = 'verified', audit_attempts = 0, next_attempt_at = NULL
WHERE status = 'pending'
  AND season_id = <CURRENT_SEASON_ID>
  AND ruleset_version = <RULESET_VERSION>
  AND replay_format_version = <REPLAY_FORMAT_VERSION>;`;

/** Optional last step of なし → あり: put back the original posting time of a row the re-audit confirmed. */
const RESTORE_CREATED_AT_SQL = `UPDATE scores SET created_at = <ORIGINAL_CREATED_AT> WHERE id = '<ID>' AND status = 'verified';`;

/** Clears the owner hash audit-free mode leaves on verified rows. */
const CLEAR_SUBMITTER_HASH_SQL = `UPDATE scores SET submitter_hash = NULL
WHERE status = 'verified' AND submitter_hash IS NOT NULL;`;

/** The audit's expired-pending sweep, by hand (created_at <= now - 72h). */
const EXPIRED_PENDING_CLEANUP_SQL = `DELETE FROM scores
WHERE status = 'pending' AND created_at <= (unixepoch() - 259200) * 1000;`;

/** The audit's TOP-N trim, by hand, keeping <KEEP_ROWS> verified rows of the current season and ruleset. */
const MANUAL_TRIM_SQL = `DELETE FROM scores
WHERE status = 'verified'
  AND season_id = <CURRENT_SEASON_ID>
  AND ruleset_version = <RULESET_VERSION>
  AND rank_seq NOT IN (
    SELECT rank_seq FROM scores
    WHERE status = 'verified'
      AND season_id = <CURRENT_SEASON_ID>
      AND ruleset_version = <RULESET_VERSION>
    ORDER BY score DESC, rank_seq ASC
    LIMIT <KEEP_ROWS>
  );`;

function fillIn(template: string, extra: Record<string, string | number> = {}): string {
  const values: Record<string, string | number> = {
    CURRENT_SEASON_ID,
    RULESET_VERSION,
    REPLAY_FORMAT_VERSION,
    ...extra,
  };
  const sql = template.replace(/<([A-Z_]+)>/g, (_match, name: string) => {
    if (!(name in values)) throw new Error(`no value for placeholder <${name}>`);
    return String(values[name]);
  });
  return sql;
}

/** A short, real, gameover-reaching replay recorded through the actual core simulator (same recipe as runAudit.test.ts). */
function recordRealReplay(seed: number): { rle: Uint8Array; score: number; stage: number } {
  const session = new GameSession({ seed });
  session.update({ dx: 0, dy: 0, drawHeld: false, confirm: true });
  const samples: InputSample[] = [];
  let guard = 0;
  while (session.getStatus() !== 'gameover' && guard < 20000) {
    const input: InputSample = { dx: 0, dy: 1, drawHeld: true, slow: false };
    session.update({ ...input, confirm: false });
    samples.push(input);
    guard++;
  }
  if (session.getStatus() !== 'gameover') throw new Error('fixture setup failed: did not reach gameover');
  return { rle: encodeRle(samples), score: session.getScore(), stage: session.getStage() };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** POSTs through the real handler with RANKING_AUDIT_MODE=disabled, each call from its own IP so the per-IP cap never interferes. */
async function postAuditFree(db: D1Database, args: { seed: number; rle: Uint8Array; score: number; stage: number; ipIndex: number; token?: string }) {
  const body: Record<string, unknown> = {
    seed: args.seed,
    rleBase64: toBase64(args.rle),
    score: args.score,
    stage: args.stage,
    name: `P${args.seed}`,
    rulesetVersion: RULESET_VERSION,
    replayFormatVersion: REPLAY_FORMAT_VERSION,
  };
  if (args.token !== undefined) body.submitterToken = args.token;
  const request = new Request(`${SELF_ORIGIN}/api/scores`, {
    method: 'POST',
    headers: { Origin: SELF_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${args.ipIndex}` },
    body: JSON.stringify(body),
  });
  type Ctx = Parameters<typeof onRequestPost>[0];
  const env = { DB: db, RANKING_IP_HASH_KEY: IP_HASH_KEY, RANKING_AUDIT_MODE: 'disabled' };
  const response = await onRequestPost({ request, env, params: {} } as unknown as Ctx);
  const json = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200 || json.accepted !== true || json.status !== 'verified') {
    throw new Error(`fixture setup failed: audit-free POST answered ${response.status} ${JSON.stringify(json)}`);
  }
  return json.id as string;
}

interface Row {
  id: string;
  status: string;
  score: number;
  created_at: number;
  submitter_hash: string | null;
  audit_attempts: number;
  next_attempt_at: number | null;
  season_id: number;
  replay_format_version: number;
}

describe('the audit and RANKING_AUDIT_MODE=disabled rows (real local D1)', () => {
  let testDb: TestD1;

  beforeAll(async () => {
    testDb = await createTestD1();
  }, 30_000);

  afterAll(async () => {
    await testDb.dispose();
  });

  beforeEach(async () => {
    await testDb.db.prepare(`DELETE FROM scores`).run();
    await testDb.db.prepare(`DELETE FROM ranking_rate_limits`).run();
  });

  async function row(id: string): Promise<Row | null> {
    return testDb.db
      .prepare(`SELECT id, status, score, created_at, submitter_hash, audit_attempts, next_attempt_at, season_id, replay_format_version FROM scores WHERE id = ?1`)
      .bind(id)
      .first<Row>();
  }

  async function exec(sql: string): Promise<number> {
    const result = await testDb.db.prepare(sql).run();
    return result.meta.changes;
  }

  function auditOptions() {
    return { db: testDb.db, seasonId: CURRENT_SEASON_ID, rulesetVersion: RULESET_VERSION, replayFormatVersion: REPLAY_FORMAT_VERSION };
  }

  it('the runbook carries every SQL statement this file tests, verbatim', () => {
    const runbook = fs.readFileSync(RUNBOOK_PATH, 'utf8');
    for (const sql of [REAUDIT_SQL, PENDING_TO_VERIFIED_SQL, RESTORE_CREATED_AT_SQL, CLEAR_SUBMITTER_HASH_SQL, EXPIRED_PENDING_CLEANUP_SQL, MANUAL_TRIM_SQL]) {
      expect(runbook.includes(sql), `docs/ranking-audit-runbook.md is missing:\n${sql}`).toBe(true);
    }
  });

  // The failure mode the runbook's switch procedures are ordered around.
  it('run by mistake in audit-free mode: verifies nothing, and deletes the current season\'s verified rows below 10th place', async () => {
    // 12 audit-free rows, posted in ascending score order so each one clears
    // the pre-gate's 10th-place threshold at the time it arrives. The replay
    // bytes are irrelevant here — nothing is resimulated.
    const ids: string[] = [];
    for (let i = 1; i <= 12; i++) {
      ids.push(await postAuditFree(testDb.db, { seed: 7000 + i, rle: encodeRle([{ dx: 1, dy: 0, drawHeld: false, slow: false }]), score: i * 100, stage: 1, ipIndex: i }));
    }
    const oldSeason = await seedScoreRow(testDb.db, { status: 'verified', season_id: CURRENT_SEASON_ID + 1, ruleset_version: RULESET_VERSION, score: 1 });

    const result = await runAudit(auditOptions());

    expect(result.acquired).toBe(true);
    expect(result.processedCount).toBe(0);
    expect(result.verifiedCount).toBe(0);
    expect(result.expiredDeletedCount).toBe(0);
    expect(result.top10CleanedCount).toBe(2);
    // The two lowest (100, 200) are gone for good; the top 10 stay verified.
    expect(await row(ids[0])).toBeNull();
    expect(await row(ids[1])).toBeNull();
    for (const id of ids.slice(2)) expect((await row(id))!.status).toBe('verified');
    // Another season is outside the cleanup's scope.
    expect(await row(oldSeason)).not.toBeNull();
  });

  it('re-audit: honest rows come back verified, forged ones are deleted, and the expiry sweep deletes none — even rows posted over 72h ago', async () => {
    const honestOld = recordRealReplay(9101);
    const honestNew = recordRealReplay(9102);
    const forged = recordRealReplay(9103);
    const ids = {
      honestOld: await postAuditFree(testDb.db, { seed: 9101, ...honestOld, ipIndex: 1, token: TOKEN }),
      honestNew: await postAuditFree(testDb.db, { seed: 9102, ...honestNew, ipIndex: 2, token: TOKEN }),
      forgedOld: await postAuditFree(testDb.db, { seed: 9103, ...forged, score: forged.score + 999_999, ipIndex: 3, token: TOKEN }),
    };
    // Two of them were posted well over 72h ago, the case that would be swept
    // unaudited if they were set back to pending with their original time.
    const longAgo = Date.now() - PENDING_EXPIRY_MS - 24 * 60 * 60 * 1000;
    await testDb.db.prepare(`UPDATE scores SET created_at = ?1 WHERE id IN (?2, ?3)`).bind(longAgo, ids.honestOld, ids.forgedOld).run();
    expect((await row(ids.forgedOld))!.submitter_hash).toBe(await computeSubmitterHash(TOKEN));

    const before = Date.now();
    expect(await exec(fillIn(REAUDIT_SQL))).toBe(3);
    for (const id of Object.values(ids)) {
      const r = (await row(id))!;
      expect(r).toMatchObject({ status: 'pending', audit_attempts: 0, next_attempt_at: null, submitter_hash: null });
      // unixepoch() has 1s resolution.
      expect(r.created_at).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    }

    const result = await runAudit(auditOptions());

    expect(result.expiredDeletedCount).toBe(0);
    expect(result.verifiedCount).toBe(2);
    expect(result.deletedConfirmedInvalidCount).toBe(1);
    expect((await row(ids.honestOld))!.status).toBe('verified');
    expect((await row(ids.honestNew))!.status).toBe('verified');
    expect(await row(ids.forgedOld)).toBeNull();

    // Optional last step: the original posting time goes back from a backup.
    expect(await exec(fillIn(RESTORE_CREATED_AT_SQL, { ORIGINAL_CREATED_AT: longAgo, ID: ids.honestOld }))).toBe(1);
    expect((await row(ids.honestOld))!.created_at).toBe(longAgo);
    // ...and touches nothing for a row the audit deleted.
    expect(await exec(fillIn(RESTORE_CREATED_AT_SQL, { ORIGINAL_CREATED_AT: longAgo, ID: ids.forgedOld }))).toBe(0);
  });

  it('the re-audit SQL leaves other seasons, other replay formats, other rulesets and existing pending rows untouched', async () => {
    const createdAt = Date.now() - 1000;
    const untouched = {
      oldSeason: await seedScoreRow(testDb.db, { status: 'verified', season_id: CURRENT_SEASON_ID - 1, ruleset_version: RULESET_VERSION, replay_format_version: REPLAY_FORMAT_VERSION, created_at: createdAt, submitter_hash: 'h1' }),
      oldFormat: await seedScoreRow(testDb.db, { status: 'verified', season_id: CURRENT_SEASON_ID, ruleset_version: RULESET_VERSION, replay_format_version: REPLAY_FORMAT_VERSION - 1, created_at: createdAt, submitter_hash: 'h2' }),
      oldRuleset: await seedScoreRow(testDb.db, { status: 'verified', season_id: CURRENT_SEASON_ID, ruleset_version: RULESET_VERSION - 1, replay_format_version: REPLAY_FORMAT_VERSION, created_at: createdAt, submitter_hash: 'h3' }),
      pending: await seedScoreRow(testDb.db, { status: 'pending', season_id: CURRENT_SEASON_ID, ruleset_version: RULESET_VERSION, replay_format_version: REPLAY_FORMAT_VERSION, created_at: createdAt, submitter_hash: 'h4', audit_attempts: 1, next_attempt_at: 123 }),
    };
    const target = await seedScoreRow(testDb.db, { status: 'verified', season_id: CURRENT_SEASON_ID, ruleset_version: RULESET_VERSION, replay_format_version: REPLAY_FORMAT_VERSION, created_at: createdAt });
    const snapshot = await Promise.all(Object.values(untouched).map((id) => row(id)));

    expect(await exec(fillIn(REAUDIT_SQL))).toBe(1);

    expect((await row(target))!.status).toBe('pending');
    expect(await Promise.all(Object.values(untouched).map((id) => row(id)))).toEqual(snapshot);
  });

  it('switching to audit-free: the pending-to-verified SQL flips only current-version pending rows and keeps their owner hash', async () => {
    const createdAt = Date.now() - 1000;
    const current = await seedScoreRow(testDb.db, {
      status: 'pending',
      season_id: CURRENT_SEASON_ID,
      ruleset_version: RULESET_VERSION,
      replay_format_version: REPLAY_FORMAT_VERSION,
      created_at: createdAt,
      submitter_hash: 'owner',
      audit_attempts: 2,
      next_attempt_at: 999,
    });
    const untouched = {
      oldSeason: await seedScoreRow(testDb.db, { status: 'pending', season_id: CURRENT_SEASON_ID - 1, ruleset_version: RULESET_VERSION, replay_format_version: REPLAY_FORMAT_VERSION, created_at: createdAt }),
      oldFormat: await seedScoreRow(testDb.db, { status: 'pending', season_id: CURRENT_SEASON_ID, ruleset_version: RULESET_VERSION, replay_format_version: REPLAY_FORMAT_VERSION - 1, created_at: createdAt }),
      oldRuleset: await seedScoreRow(testDb.db, { status: 'pending', season_id: CURRENT_SEASON_ID, ruleset_version: RULESET_VERSION - 1, replay_format_version: REPLAY_FORMAT_VERSION, created_at: createdAt }),
      verified: await seedScoreRow(testDb.db, { status: 'verified', season_id: CURRENT_SEASON_ID, ruleset_version: RULESET_VERSION, replay_format_version: REPLAY_FORMAT_VERSION, created_at: createdAt, submitter_hash: null }),
    };
    const snapshot = await Promise.all(Object.values(untouched).map((id) => row(id)));

    expect(await exec(fillIn(PENDING_TO_VERIFIED_SQL))).toBe(1);

    expect(await row(current)).toMatchObject({ status: 'verified', audit_attempts: 0, next_attempt_at: null, submitter_hash: 'owner', created_at: createdAt });
    expect(await Promise.all(Object.values(untouched).map((id) => row(id)))).toEqual(snapshot);
  });

  it('the owner-hash clearing SQL empties submitter_hash on verified rows only', async () => {
    const verifiedOwned = await seedScoreRow(testDb.db, { status: 'verified', submitter_hash: 'owned' });
    const pendingOwned = await seedScoreRow(testDb.db, { status: 'pending', submitter_hash: 'owned-pending' });

    expect(await exec(CLEAR_SUBMITTER_HASH_SQL)).toBe(1);

    expect((await row(verifiedOwned))!.submitter_hash).toBeNull();
    expect((await row(pendingOwned))!.submitter_hash).toBe('owned-pending');
  });

  it('the manual expired-pending cleanup deletes exactly what the audit\'s sweep would (created_at <= now - 72h)', async () => {
    const nowSeconds = (await testDb.db.prepare(`SELECT unixepoch() AS now`).first<{ now: number }>())!.now;
    const cutoffMs = nowSeconds * 1000 - PENDING_EXPIRY_MS;
    const expired = await seedScoreRow(testDb.db, { status: 'pending', created_at: cutoffMs - 60_000 });
    const fresh = await seedScoreRow(testDb.db, { status: 'pending', created_at: cutoffMs + 60_000 });
    const oldVerified = await seedScoreRow(testDb.db, { status: 'verified', created_at: cutoffMs - 60_000 });

    expect(await exec(EXPIRED_PENDING_CLEANUP_SQL)).toBe(1);

    expect(await row(expired)).toBeNull();
    expect(await row(fresh)).not.toBeNull();
    expect(await row(oldVerified)).not.toBeNull();
  });

  it('the manual trim keeps the top <KEEP_ROWS> verified rows of the current season and ruleset, and nothing else is touched', async () => {
    const current: { id: string; score: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const score = 1000 - i * 10;
      current.push({ id: await seedScoreRow(testDb.db, { status: 'verified', season_id: CURRENT_SEASON_ID, ruleset_version: RULESET_VERSION, score }), score });
    }
    const pendingLow = await seedScoreRow(testDb.db, { status: 'pending', season_id: CURRENT_SEASON_ID, ruleset_version: RULESET_VERSION, score: 1 });
    const otherSeasonLow = await seedScoreRow(testDb.db, { status: 'verified', season_id: CURRENT_SEASON_ID + 1, ruleset_version: RULESET_VERSION, score: 1 });

    expect(await exec(fillIn(MANUAL_TRIM_SQL, { KEEP_ROWS: 10 }))).toBe(2);

    for (const { id } of current.slice(0, 10)) expect(await row(id)).not.toBeNull();
    for (const { id } of current.slice(10)) expect(await row(id)).toBeNull();
    expect(await row(pendingLow)).not.toBeNull();
    expect(await row(otherSeasonLow)).not.toBeNull();
  });
});
