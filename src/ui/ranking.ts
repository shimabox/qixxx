// Score ranking UI (docs/plans/2026-08-16-score-ranking task 4): the TITLE
// screen's RANKING button + top-10 overlay, the GAME OVER name-input/submit
// flow, and the replay-viewer control bar. DOM-only module — src/core/ types
// are imported only for their shapes, never anything DOM-touching from
// src/core/ itself (matching src/ui/gameOverModal.ts's existing "core
// purity" exemption pattern).
//
// XSS safety (hard requirement): every user-supplied string (name, X handle)
// is written via `textContent` only, never `innerHTML` or any other
// HTML-interpreting API.
import { GameSession, SessionStatus } from '../core/session';
import { ReplayEngine, ReplayAbortedError } from '../core/replayEngine';
import { RunMode } from '../runMode';
import { HUD_FONT, HUD_TEXT_COLOR, HUD_ACCENT_COLOR } from '../config';
import { getOrCreateSubmitterToken } from './submitterToken';

export interface RankingEntry {
  id: string;
  createdAt: string;
  score: number;
  stage: number;
  name: string;
  xHandle: string | null;
  replayAvailable: boolean;
}

/**
 * One row of the board the UI actually DRAWS (docs/plans/2026-08-19-ranking-
 * free-async spec item 5, as revised 2026-08-20) — GET /api/ranking's
 * `displayEntries`: verified rows and fresh pending rows merged into a single
 * ranked list under the same ordering rule.
 *
 * A superset of RankingEntry, which is what makes one rendering path enough:
 * `replayAvailable` is present and meaningful on a pending row too (the
 * server serves a fresh pending row's replay now — spec item 7), so the
 * REPLAY button is gated on exactly the same field regardless of `status`.
 *
 * `status` is carried for the server's benefit (audit, deletion, debugging)
 * and deliberately NOT rendered (decision of 2026-08-22): the public board
 * treats pending and verified rows as one real-time ranking. Verification
 * is disclosed once, as a rule of the board, by the static notice under the
 * heading ("entries that fail verification are removed") rather than by
 * marking individual rows as suspect. The X handle is linked either way —
 * the audit verifies the SCORE, never handle ownership, so a row's audit
 * state was never a reason to withhold the link (the self-reported-handles
 * notice is the responsibility boundary there).
 *
 * NOTE the deliberate asymmetry with the SUBMISSION side: whether the name
 * form opens is decided from `entries` (verified only) and never from this
 * list, so pending rows cannot lock anyone out — see decideSubmissionOffer().
 */
export interface DisplayRankingEntry extends RankingEntry {
  status: 'pending' | 'verified';
}

/**
 * Everything the submission flow is allowed to know about the run that just
 * ended — captured *synchronously* by main.ts at the gameover edge, before
 * any network round trip.
 *
 * The reason this exists rather than reading the live GameSession/
 * InputRecorder at submit time: offerSubmission() has to ask the server for
 * the current top 10 before it can decide whether to show the name field,
 * and the player can walk right past that await (GAME OVER -> any key ->
 * Title -> start a new run) while it is in flight. Reading `session.getSeed()`
 * / `inputRecorder.encode()` afterwards would then describe *the run in
 * progress*, not the run that earned the score — i.e. submit a half-finished
 * replay under a finished run's banner. A snapshot makes that
 * structurally impossible: the module cannot see live state at all.
 *
 * `runId` is main.ts's per-run counter, re-checked when the response lands so
 * a reply that outlived its run is dropped instead of reopening the form.
 */
export interface RunSubmissionSnapshot {
  runId: number;
  /** undefined for a run with no seed at all (never POST-eligible). */
  seed: number | undefined;
  /** The finished run's complete RLE-encoded input stream. */
  rle: Uint8Array;
  score: number;
  stage: number;
  runMode: RunMode;
  tainted: boolean;
}

/**
 * Whether a fetched replay payload is one *this build* can faithfully replay.
 *
 * The server already refuses to serve a mismatched row (410 from
 * GET /api/ranking/:id/replay), but that filter is written from the server's
 * point of view. The dangerous case is the reverse: a tab left open across a
 * deploy holds an *old* core, and a payload the new server considers current
 * is one this bundle would resimulate under the wrong ruleset — producing a
 * plausible-looking but wrong run rather than any error. So the versions are
 * checked again here, against the constants this bundle was built with.
 *
 * Also shape-checks `seed` (the uint32 the server stores, mirroring
 * functions/_lib/ranking/seedValidation.ts) and `rleBase64`, so a malformed
 * payload is reported as unplayable instead of reaching the decoder.
 */
export function isReplayPayloadPlayable(payload: unknown, rulesetVersion: number, replayFormatVersion: number): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Partial<ReplayPayload>;
  if (typeof p.seed !== 'number' || !Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xffffffff) return false;
  if (typeof p.rleBase64 !== 'string' || p.rleBase64.length === 0) return false;
  if (p.rulesetVersion !== rulesetVersion) return false;
  if (p.replayFormatVersion !== replayFormatVersion) return false;
  return true;
}

/** Why decideSubmissionOffer() did (or did not) open the name field — 'show' is the only affirmative outcome. */
export type SubmissionOfferDecision =
  | 'show'
  | 'ineligible-run'
  | 'superseded'
  | 'stale-run'
  | 'run-no-longer-over'
  | 'fetch-failed'
  | 'out-of-range';

/** A run may be submitted only if it is a normal (non-`?seed=`) run, untainted by debug overrides, and actually seeded. Derived purely from the snapshot — never from live session state. */
export function isSnapshotEligible(snapshot: RunSubmissionSnapshot): boolean {
  return snapshot.runMode === 'normal' && !snapshot.tainted && snapshot.seed !== undefined;
}

/**
 * The whole "should the name field open?" decision, as a pure function of the
 * snapshot plus the world as it looks *when the /api/ranking response lands*.
 * Split out from the DOM so the race conditions it guards are directly
 * unit-testable (src/ui/ranking.test.ts).
 *
 * `entries === null` means the fetch failed; the offer is skipped rather than
 * guessed at.
 */
export function decideSubmissionOffer(args: {
  snapshot: RunSubmissionSnapshot;
  /** The snapshot the UI still considers current (identity-compared against `snapshot`). */
  activeSnapshot: RunSubmissionSnapshot | null;
  /** main.ts's live run counter at response time. */
  currentRunId: number;
  /** The live session's status at response time. */
  currentStatus: SessionStatus;
  entries: RankingEntry[] | null;
}): SubmissionOfferDecision {
  const { snapshot, activeSnapshot, currentRunId, currentStatus, entries } = args;
  if (!isSnapshotEligible(snapshot)) return 'ineligible-run';
  // A newer gameover already replaced this offer while the fetch was in
  // flight (identity, not equality — two runs can coincidentally score the same).
  if (activeSnapshot !== snapshot) return 'superseded';
  // The player left this run behind (GAME OVER -> Title, possibly already
  // playing again) before the response arrived.
  if (snapshot.runId !== currentRunId) return 'stale-run';
  if (currentStatus !== 'gameover') return 'run-no-longer-over';
  if (entries === null) return 'fetch-failed';
  // Strictly greater once the board is full: ties are broken by rank_seq ASC
  // (first-come-first-served — functions/api/ranking.ts's 順位規則), so an
  // equal score always sorts behind the incumbent, i.e. lands at 11th and is
  // deleted by POST's own trim step. Offering the name field in that case
  // would promise a slot that cannot exist. Below 10 entries there is a free
  // slot regardless of the score, so no comparison applies.
  const inRange = entries.length < 10 || snapshot.score > entries[entries.length - 1].score;
  return inRange ? 'show' : 'out-of-range';
}

export interface ReplayPayload {
  seed: number;
  rleBase64: string;
  rulesetVersion: number;
  replayFormatVersion: number;
  /** The row's audit state. Served for the operator's benefit; the viewer does not render it (decision of 2026-08-22 — see DisplayRankingEntry). */
  status?: 'pending' | 'verified';
}

export interface RankingUIOptions {
  anchor: HTMLElement;
  /** The *live* session — read only for its status (browsing/replay gating), never for run data (see RunSubmissionSnapshot). */
  getSession: () => GameSession;
  /** main.ts's per-run counter, re-checked when an in-flight ranking response lands. */
  getRunId: () => number;
  getRulesetVersion: () => number;
  getReplayFormatVersion: () => number;
  /** Switches main.ts's game loop into replay-viewing mode. */
  onReplayStart: (engine: ReplayEngine) => void;
  /** Switches main.ts's game loop back to live play. */
  onReplayExit: () => void;
  /**
   * Starts/stops main.ts's per-frame `stepTick()` driver without leaving
   * replay mode. Needed because a chunked skip advances the very same engine
   * between its yields: if normal playback kept running, both would step it
   * and the replay would advance at roughly double speed, overshooting the
   * boundary the skip is seeking.
   */
  onReplayAutoAdvanceChange: (autoAdvance: boolean) => void;
}

/**
 * Formats GET /api/ranking's ISO-8601 `createdAt` as a plain `YYYY-MM-DD`
 * in the *viewer's* local timezone (docs/plans/2026-08-16-score-ranking task
 * 4's "日付・スコア・ステージ・名前"). Built from the Date's local parts by
 * hand rather than `toLocaleDateString()`, whose output shape varies by
 * locale and would make the row width — and the E2E assertions — unstable.
 * A malformed/absent timestamp degrades to an empty string rather than
 * rendering "Invalid Date" or "NaN-NaN-NaN".
 */
export function formatRankingDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Stops keydown/keyup from bubbling past this element to `window` — where
 * KeyboardInput (src/input/keyboard.ts) listens for gameplay input and the
 * GAME OVER/Title/StageClear screens' edge-triggered "any key" confirm.
 * Without this, typing into a text field would both leak keystrokes into
 * the game's move/draw state and (worse) fire that "any key" confirm on
 * every character, instantly dismissing whatever screen the field is on.
 */
function stopKeyPropagation(el: HTMLElement): void {
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.addEventListener('keyup', (e) => e.stopPropagation());
}

/**
 * Panel sizing shared by the ranking list, the submission form and the
 * transient message.
 *
 * Both numbers are viewport-responsive (user feedback on a desktop window,
 * 2026-08-20: the panel floated small in the middle of a wide screen and the
 * rows were hard to read). Before, the whole panel was `0.8em` of an
 * inherited font size that never grew past the HUD's own 16px cap, and its
 * width was whatever the content happened to need.
 *
 *  - WIDTH is a PERCENTAGE of canvas-wrap, not `vw`: the panel is absolutely
 *    positioned inside the canvas box, which on a desktop is a good deal
 *    narrower than the viewport (~915px of 1280px), so `90vw` would have
 *    overhung the field it sits on.
 *  - FONT SIZE uses `vw` deliberately, in the same idiom the HUD already uses
 *    (`clamp(10px, 3.2vw, 16px)` in main.ts): it answers "how big is this
 *    screen", which is the question being asked, and it is a font size — it
 *    cannot overflow the panel the way a width could.
 */
const OVERLAY_WIDTH = 'min(560px, 92%)';
const OVERLAY_FONT_SIZE = 'clamp(12px, 2.2vw, 18px)';

function styledOverlay(): HTMLDivElement {
  const el = document.createElement('div');
  el.style.position = 'absolute';
  el.style.top = '50%';
  el.style.left = '50%';
  el.style.transform = 'translate(-50%, -50%)';
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.style.alignItems = 'center';
  el.style.gap = '8px';
  el.style.padding = '16px 20px';
  el.style.boxSizing = 'border-box';
  el.style.width = OVERLAY_WIDTH;
  el.style.maxHeight = '90%';
  el.style.overflowY = 'auto';
  el.style.background = 'rgba(10, 14, 39, 0.95)';
  el.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
  el.style.borderRadius = '8px';
  el.style.boxShadow = `0 0 16px ${HUD_ACCENT_COLOR}`;
  el.style.color = HUD_TEXT_COLOR;
  el.style.font = HUD_FONT;
  el.style.fontSize = OVERLAY_FONT_SIZE;
  el.style.textAlign = 'center';
  el.style.pointerEvents = 'auto';
  el.style.userSelect = 'none';
  el.style.zIndex = '20';
  el.style.display = 'none';
  return el;
}

/**
 * What goes in a row's name slot, for both the confirmed board and the
 * pending section.
 *
 * A handle-only submission stores name='' (the form submits one or the
 * other), which used to render as "(no name)" next to the player's own
 * handle — reported from a real device (2026-08-20) as exactly the confusion
 * it looks like: "I did enter a name". The handle IS the name in that case.
 * "(no name)" now means only what it says: neither was given (a SKIP-less
 * anonymous submission).
 */
function resolveDisplayName(entry: { name: string; xHandle: string | null }): string {
  if (entry.name !== '') return entry.name;
  if (entry.xHandle) return `@${entry.xHandle}`;
  return '(no name)';
}

/** The x.com profile link for a handle. Caller decides where it goes and at what size. */
function createHandleLink(xHandle: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = `https://x.com/${encodeURIComponent(xHandle)}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.color = HUD_ACCENT_COLOR;
  link.textContent = `@${xHandle}`;
  return link;
}

function styledButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.font = HUD_FONT;
  button.style.fontSize = '0.85em';
  button.style.color = HUD_ACCENT_COLOR;
  button.style.background = 'rgba(10, 14, 39, 0.7)';
  button.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
  button.style.borderRadius = '4px';
  button.style.padding = '6px 12px';
  button.style.cursor = 'pointer';
  button.style.pointerEvents = 'auto';
  return button;
}

export interface RankingUI {
  /** Mounts the RANKING button (canvas-wrap's top-right corner — see mountTitleButton()'s own comment for why not the HUD row). Shown only on the Title screen; see syncAvailability(). */
  mountTitleButton(): void;
  /**
   * Shows/hides the RANKING button to match the live session's status, and
   * force-closes the list if browsing is no longer allowed. Call once per
   * rendered frame from main.ts (cheap: it early-returns unless the
   * allowed/not-allowed state actually flipped).
   */
  syncAvailability(): void;
  /**
   * Refreshes the replay control bar's "STAGE n / N" status line (including
   * its FINAL STAGE / GAME OVER HERE markers) for the frame currently on
   * screen. Call once per rendered frame from main.ts while viewing a replay;
   * a no-op otherwise, and cheap when nothing changed.
   */
  syncReplayStatus(): void;
  /** Offers ranking submission for the just-finished run, if eligible and provisionally in range. No-op (shows nothing) otherwise. */
  offerSubmission(snapshot: RunSubmissionSnapshot): void;
  /** Hides any open submission UI and drops the pending submission snapshot — call whenever GAME OVER's own modal is hidden. */
  hideAll(): void;
}

export function initRankingUI(options: RankingUIOptions): RankingUI {
  const { anchor } = options;

  // ---- Browsing gate (review round 3) ----
  // The ranking list, and therefore replay viewing, is reachable ONLY from
  // the Title screen. Not a cosmetic restriction: entering replay mode
  // suspends the live GameSession entirely (main.ts's update() returns early
  // while `viewMode === 'replay'`), so a mid-run RANKING -> REPLAY -> EXIT
  // round trip used to freeze a 3-minute run for an arbitrary length of
  // time and then resume the very same untainted, still-POST-eligible run.
  // Gating on 'title' removes the pause primitive outright rather than
  // trying to detect abuse after the fact.
  function browsingAllowed(): boolean {
    return activeReplayEngine === null && options.getSession().getStatus() === 'title';
  }

  // ---- Top-10 list overlay ----
  const listOverlay = styledOverlay();
  const listHeading = document.createElement('div');
  listHeading.textContent = 'RANKING';
  listHeading.style.fontSize = '1.2em';
  listHeading.style.fontWeight = 'bold';
  listOverlay.appendChild(listHeading);
  const disclaimer = document.createElement('div');
  // Two rules of the board, stated once for everyone (decision of
  // 2026-08-22): handles are self-reported, and scores are audited AFTER they
  // appear — a row can vanish later. The second sentence is what replaced the
  // per-row VERIFYING badge, so it must stay visible whenever the list is.
  disclaimer.textContent = 'X handles are self-reported — ownership is not verified. Scores are verified after posting; entries that fail verification are removed.';
  disclaimer.style.fontSize = '0.65em';
  disclaimer.style.opacity = '0.7';
  disclaimer.style.maxWidth = '260px';
  listOverlay.appendChild(disclaimer);
  // ONE board (docs/plans/2026-08-19-ranking-free-async spec item 5, as
  // revised 2026-08-20): verified and pending rows share this container and
  // this ranking. There is deliberately no separate "pending" section, and
  // (since 2026-08-22) no per-row marker either — a pending row is shown at
  // the position it actually holds, looking exactly like its neighbours,
  // until the audit confirms it in place or removes it.
  const listBody = document.createElement('div');
  listBody.id = 'ranking-list-body';
  listBody.style.display = 'flex';
  listBody.style.flexDirection = 'column';
  listBody.style.gap = '4px';
  listBody.style.width = '100%';
  listOverlay.appendChild(listBody);
  const listCloseButton = styledButton('CLOSE');
  listCloseButton.addEventListener('click', () => hideList());
  listOverlay.appendChild(listCloseButton);
  anchor.appendChild(listOverlay);

  // Bumped on every change to the browsing context (the list opening or
  // closing). A network request issued while browsing captures this value and
  // re-checks it on arrival, so a reply that belongs to a browsing session the
  // player has since left is discarded rather than acted on — browsingAllowed()
  // alone can't catch that, since "still on Title with a list open" reads
  // identical before and after a close/reopen.
  let browsingGeneration = 0;

  /**
   * Aborts whatever replay computation the current browsing context started.
   *
   * The generation counter only stops a stale result from being *applied*;
   * the work itself kept running to completion in the background. For a
   * replay pre-pass that is up to 10800 ticks of simulation still grinding
   * away after the player has closed the list or — worse — started a run,
   * where it competes with the live game for exactly the frames the chunking
   * was introduced to protect.
   */
  let browsingAbort: AbortController | null = null;

  function abortReplayWork(): void {
    browsingAbort?.abort();
    browsingAbort = null;
  }

  function beginReplayWork(): AbortSignal {
    abortReplayWork();
    browsingAbort = new AbortController();
    return browsingAbort.signal;
  }

  function hideList(): void {
    listOverlay.style.display = 'none';
    browsingGeneration++;
    abortReplayWork();
  }

  /** Replaces the list body with a single status line (LOADING/error). */
  function showListStatus(text: string): void {
    listBody.textContent = '';
    const line = document.createElement('div');
    line.textContent = text;
    listBody.appendChild(line);
  }

  function clearListStatus(): void {
    listBody.textContent = '';
  }

  async function showList(): Promise<void> {
    if (!browsingAllowed()) return;
    browsingGeneration++;
    const requestGeneration = browsingGeneration;
    showListStatus('LOADING...');
    listOverlay.style.display = 'flex';

    let entries: DisplayRankingEntry[] | null = null;
    try {
      const res = await fetch('/api/ranking');
      if (!res.ok) throw new Error(`ranking fetch failed: ${res.status}`);
      const data = (await res.json()) as { entries?: RankingEntry[]; displayEntries?: DisplayRankingEntry[] };
      // `displayEntries` is what this list draws. The `entries` fallback
      // covers only a server that predates the merged board (it would
      // otherwise render an empty list against a perfectly healthy TOP10);
      // those rows are verified by definition.
      entries = data.displayEntries ?? (data.entries ?? []).map((entry) => ({ ...entry, status: 'verified' as const }));
    } catch {
      entries = null;
    }

    // Same generation guard startReplayFor() uses, and for the same reason:
    // close-then-reopen leaves two GETs racing, and without this the slower
    // (older) one repaints its stale rows over the newer result — or paints
    // an error over a list that has since loaded fine.
    if (!browsingAllowed() || browsingGeneration !== requestGeneration) return;

    if (entries === null) {
      showListStatus('FAILED TO LOAD RANKING');
      return;
    }

    listBody.textContent = '';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'NO ENTRIES YET';
      listBody.appendChild(empty);
      return;
    }

    entries.forEach((entry, index) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.width = '100%';
      row.style.justifyContent = 'space-between';

      const left = document.createElement('div');
      left.style.textAlign = 'left';
      // A long name must wrap inside its own column rather than pushing the
      // REPLAY button off the (now fixed-width) panel.
      left.style.minWidth = '0';
      left.style.overflowWrap = 'anywhere';
      const rankLine = document.createElement('div');
      // textContent-only composition (XSS safety): each piece is either a
      // trusted literal/number, or appended as its own text node below
      // (entry.name) — never concatenated into one interpolated string that
      // could blur the line between "our text" and "their text".
      rankLine.textContent = `#${index + 1}  ${entry.score}  STAGE ${entry.stage}  `;
      // A handle-only row puts the handle in the name slot — as the link
      // itself, so the profile stays one click away and the handle is not
      // printed twice (the meta line below then carries only the date).
      // Linked for pending and verified rows alike — see DisplayRankingEntry.
      const nameIsHandle = entry.name === '' && entry.xHandle !== null;
      if (nameIsHandle) {
        rankLine.appendChild(createHandleLink(entry.xHandle!));
      } else {
        const nameSpan = document.createElement('span');
        nameSpan.textContent = resolveDisplayName(entry);
        rankLine.appendChild(nameSpan);
      }
      left.appendChild(rankLine);

      // Secondary line: the entry's date (task 4's required 日付) and, when
      // present, the X-handle link. Kept off the rank line itself so the
      // primary "#N score STAGE n name" reading order stays uncluttered.
      const metaLine = document.createElement('div');
      metaLine.style.display = 'flex';
      metaLine.style.alignItems = 'center';
      metaLine.style.gap = '8px';
      metaLine.style.fontSize = '0.7em';
      metaLine.style.opacity = '0.75';
      const dateSpan = document.createElement('span');
      dateSpan.textContent = formatRankingDate(entry.createdAt);
      metaLine.appendChild(dateSpan);

      if (entry.xHandle && !nameIsHandle) {
        const handleLink = createHandleLink(entry.xHandle);
        handleLink.style.fontSize = '1.15em'; // back up to the rank line's size, against metaLine's 0.7em
        metaLine.appendChild(handleLink);
      }
      left.appendChild(metaLine);
      row.appendChild(left);

      // Right-hand side: the REPLAY button. A fresh pending row IS replayable
      // (spec item 7), so `replayAvailable` alone decides the button, exactly
      // as it does for a verified row.
      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.alignItems = 'center';
      right.style.gap = '6px';
      right.style.flex = '0 0 auto';

      const replayButton = styledButton('REPLAY');
      replayButton.disabled = !entry.replayAvailable;
      if (!entry.replayAvailable) {
        replayButton.style.opacity = '0.4';
        replayButton.style.cursor = 'not-allowed';
      }
      replayButton.addEventListener('click', () => void startReplayFor(entry.id));
      right.appendChild(replayButton);
      row.appendChild(right);

      listBody.appendChild(row);
    });
  }

  async function startReplayFor(id: string): Promise<void> {
    // Checked here AND again once the response lands. The pre-check alone is
    // not enough: the fetch is an await, and the Title screen's "press any
    // key to start" confirm still fires underneath it, so a player who
    // clicks REPLAY and immediately starts a run would otherwise be dropped
    // into replay mode mid-run on arrival — which suspends the live session
    // entirely (main.ts's update() early-returns in replay mode), restoring
    // exactly the pause exploit the Title-only gate exists to remove.
    if (!browsingAllowed()) return;
    const requestGeneration = browsingGeneration;

    let payload: ReplayPayload | null = null;
    let gone = false;
    try {
      const res = await fetch(`/api/ranking/${encodeURIComponent(id)}/replay`);
      gone = res.status === 410;
      if (res.ok) payload = (await res.json()) as ReplayPayload;
    } catch {
      payload = null;
    }

    // Nothing above this line may touch the UI. A response that outlived its
    // browsing session is dropped silently — including the error/410
    // messages, which would otherwise pop an overlay over a live run.
    if (!browsingAllowed() || browsingGeneration !== requestGeneration) return;

    if (gone) {
      showTransientMessage('THIS RECORD CANNOT BE REPLAYED ON THE CURRENT VERSION.');
      return;
    }
    if (!payload || !isReplayPayloadPlayable(payload, options.getRulesetVersion(), options.getReplayFormatVersion())) {
      // A version the *client* can't honour is the mirror image of the
      // server's own 410: an old tab left open across a deploy would
      // otherwise resimulate a new-ruleset replay with its old core and
      // silently render a wrong run. Checked here rather than trusting the
      // server's filter alone, because the stale party is this bundle.
      showTransientMessage(payload ? 'THIS RECORD CANNOT BE REPLAYED ON THE CURRENT VERSION.' : 'FAILED TO LOAD REPLAY.');
      return;
    }

    // Decoding and the pre-pass both run inside the try: base64 or RLE bytes
    // that don't decode used to throw out of this handler as an unhandled
    // rejection, leaving the player staring at an unchanged list.
    let engine: ReplayEngine;
    showListStatus('LOADING REPLAY...');
    const signal = beginReplayWork();
    try {
      engine = await ReplayEngine.create(payload.seed, base64ToBytes(payload.rleBase64), { signal });
    } catch (err) {
      // An abort means the player closed the list or started a run while the
      // pre-pass was running — expected, and already reflected in the UI by
      // whatever caused it. Anything else is a genuinely bad replay.
      if (err instanceof ReplayAbortedError) return;
      clearListStatus();
      if (browsingAllowed() && browsingGeneration === requestGeneration) {
        showTransientMessage('THIS REPLAY COULD NOT BE PLAYED BACK.');
      }
      return;
    }
    clearListStatus();

    // ReplayEngine.create() is itself an await (a chunked pre-pass), so the
    // same "did the player move on?" question applies again here.
    if (!browsingAllowed() || browsingGeneration !== requestGeneration) return;

    hideList();
    // A pending row's replay plays exactly like a verified one's — the
    // payload's `status` is not rendered (decision of 2026-08-22).
    mountReplayControls();
    options.onReplayStart(engine);
  }

  // ---- Transient message (network/replay-unavailable errors) ----
  const messageOverlay = styledOverlay();
  const messageText = document.createElement('div');
  messageOverlay.appendChild(messageText);
  const messageCloseButton = styledButton('OK');
  messageCloseButton.addEventListener('click', () => hideTransientMessage());
  messageOverlay.appendChild(messageCloseButton);
  anchor.appendChild(messageOverlay);

  function showTransientMessage(text: string): void {
    messageText.textContent = text;
    messageOverlay.style.display = 'flex';
  }

  function hideTransientMessage(): void {
    messageOverlay.style.display = 'none';
  }

  // ---- GAME OVER submission flow ----
  const submitOverlay = styledOverlay();
  const submitHeading = document.createElement('div');
  submitHeading.textContent = 'YOU MADE THE TOP 10!';
  submitHeading.style.fontSize = '1em';
  submitHeading.style.fontWeight = 'bold';
  submitOverlay.appendChild(submitHeading);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'NAME';
  nameInput.maxLength = 24;
  nameInput.style.font = HUD_FONT;
  nameInput.style.fontSize = '0.8em';
  nameInput.style.padding = '4px 8px';
  // Scales with the panel now that the panel itself scales (see
  // OVERLAY_WIDTH/OVERLAY_FONT_SIZE) — a 180px box under 18px text looked
  // like an afterthought on a desktop window.
  nameInput.style.width = 'min(280px, 80%)';
  // Without this, every keystroke bubbles up to KeyboardInput's
  // window-level listener (src/input/keyboard.ts), whose edge-triggered
  // "any key" pulse is exactly what dismisses the GAME OVER screen back to
  // Title — typing a single letter would silently discard this whole
  // submission form before SUBMIT could ever be clicked.
  stopKeyPropagation(nameInput);
  submitOverlay.appendChild(nameInput);

  const handleRow = document.createElement('label');
  handleRow.style.display = 'flex';
  handleRow.style.alignItems = 'center';
  handleRow.style.gap = '6px';
  handleRow.style.fontSize = '0.75em';
  const handleCheckbox = document.createElement('input');
  handleCheckbox.type = 'checkbox';
  const handleLabelText = document.createElement('span');
  handleLabelText.textContent = 'USE X HANDLE INSTEAD';
  handleRow.appendChild(handleCheckbox);
  handleRow.appendChild(handleLabelText);
  submitOverlay.appendChild(handleRow);

  const handleInput = document.createElement('input');
  handleInput.type = 'text';
  handleInput.placeholder = '@handle';
  handleInput.maxLength = 16;
  handleInput.style.font = HUD_FONT;
  handleInput.style.fontSize = '0.8em';
  handleInput.style.padding = '4px 8px';
  handleInput.style.width = 'min(280px, 80%)'; // see nameInput's own comment
  handleInput.style.display = 'none';
  stopKeyPropagation(handleInput); // see nameInput's own comment above
  // Both text fields sit ABOVE the checkbox row: they occupy the same visual
  // slot (only one is ever visible), so the toggle must not flip which side
  // of the checkbox the active field appears on — appending after handleRow
  // made ticking the box seem to move the checkbox above the field
  // (reported 2026-08-22).
  submitOverlay.insertBefore(handleInput, handleRow);

  // The two fields hold their values independently. Ticking the checkbox used
  // to swap a filled NAME box for an empty @handle box in the same spot, which
  // reads as the typed name being wiped — reported from a real device
  // (2026-08-20), and what the player actually wanted was the obvious thing:
  // carry the name over, since it is almost always the same word. See
  // carryNameIntoHandle() below; this hint covers what is left over, i.e. the
  // cases where the two sides genuinely differ.
  const retainedValueHint = document.createElement('div');
  retainedValueHint.id = 'ranking-submit-hint';
  retainedValueHint.style.fontSize = '0.7em';
  retainedValueHint.style.color = HUD_ACCENT_COLOR;
  retainedValueHint.style.maxWidth = '100%';
  retainedValueHint.style.overflowWrap = 'anywhere';
  retainedValueHint.style.display = 'none';
  submitOverlay.appendChild(retainedValueHint);

  /**
   * Shows the hidden side's kept value when it DIFFERS from the one being
   * submitted. Identical values (the usual case right after the carry-over
   * below) need no note — repeating the word already on screen is noise, and
   * the whole point of the hint is "your other value is still there and it is
   * not this one". textContent, never innerHTML: this echoes raw user input
   * back to the screen.
   */
  function syncRetainedValueHint(): void {
    const hidden = handleCheckbox.checked ? { label: 'NAME', value: nameInput.value } : { label: 'X HANDLE', value: handleInput.value };
    const active = handleCheckbox.checked ? handleInput.value : nameInput.value;
    if (hidden.value === '' || hidden.value === active) {
      retainedValueHint.style.display = 'none';
      retainedValueHint.textContent = '';
      return;
    }
    retainedValueHint.textContent = `${hidden.label} KEPT: ${hidden.value}`;
    retainedValueHint.style.display = 'block';
  }

  /**
   * Seeds the @handle field from the name when switching to it — but only
   * while it is still empty, so a handle the player has actually edited is
   * never overwritten by a later toggle.
   *
   * Copied verbatim, with no filtering of any kind: a name that is not a
   * legal X handle (Japanese characters, spaces, or one longer than
   * handleInput's own maxLength, which only constrains typing and not an
   * assignment) is left exactly as typed for the player to see and fix, and
   * is caught by the same submit-time validation as any other bad handle.
   * Silently transliterating or truncating someone's name would be a worse
   * surprise than showing them what they wrote.
   */
  function carryNameIntoHandle(): void {
    if (handleInput.value === '') handleInput.value = nameInput.value;
  }

  handleCheckbox.addEventListener('change', () => {
    if (handleCheckbox.checked) carryNameIntoHandle();
    handleInput.style.display = handleCheckbox.checked ? 'block' : 'none';
    nameInput.style.display = handleCheckbox.checked ? 'none' : 'block';
    syncRetainedValueHint();
  });

  // The hint depends on BOTH values, so editing the visible one can change it
  // (typing a different handle over a carried-over name makes the kept name
  // worth mentioning again).
  nameInput.addEventListener('input', syncRetainedValueHint);
  handleInput.addEventListener('input', syncRetainedValueHint);

  const submitStatus = document.createElement('div');
  submitStatus.style.fontSize = '0.75em';
  submitStatus.style.minHeight = '1.2em';
  submitOverlay.appendChild(submitStatus);

  const submitButtonRow = document.createElement('div');
  submitButtonRow.style.display = 'flex';
  submitButtonRow.style.gap = '10px';
  const skipButton = styledButton('SKIP');
  const postButton = styledButton('SUBMIT');
  submitButtonRow.appendChild(skipButton);
  submitButtonRow.appendChild(postButton);
  submitOverlay.appendChild(submitButtonRow);
  anchor.appendChild(submitOverlay);

  skipButton.addEventListener('click', () => {
    submitOverlay.style.display = 'none';
    activeSubmission = null;
  });

  // The run currently being offered for submission. Every read the POST needs
  // (seed, inputs, score) comes from here — never from the live session — so
  // a submission can only ever describe the run that actually earned the
  // score. Cleared by hideAll()/SKIP, replaced by the next gameover.
  let activeSubmission: RunSubmissionSnapshot | null = null;

  // The snapshot whose POST is currently in flight — deliberately not a bare
  // `submitting` boolean. A boolean is shared across runs: run A's in-flight
  // POST would keep run B's SUBMIT button inert (`if (submitting) return`)
  // long after run A's form was replaced. Keyed by snapshot, "already
  // submitting" can only ever block the run it actually belongs to.
  let submittingFor: RunSubmissionSnapshot | null = null;
  postButton.addEventListener('click', () => {
    if (submittingFor !== null && submittingFor === activeSubmission) return;
    void submitScore();
  });

  async function submitScore(): Promise<void> {
    const snapshot = activeSubmission;
    // No snapshot means the run this form belonged to is already gone (the
    // player returned to Title mid-form) — never fall back to live state.
    if (!snapshot || snapshot.seed === undefined) {
      submitStatus.textContent = 'THIS RUN IS NO LONGER AVAILABLE TO SUBMIT.';
      postButton.style.display = 'none';
      skipButton.textContent = 'OK';
      return;
    }
    const seed = snapshot.seed;
    const rle = snapshot.rle;

    const usingHandle = handleCheckbox.checked;
    const name = usingHandle ? '' : nameInput.value;
    const xHandle = usingHandle ? handleInput.value : '';
    if (!name.trim() && !xHandle.trim()) {
      submitStatus.textContent = 'ENTER A NAME OR X HANDLE.';
      return;
    }

    submittingFor = snapshot;
    postButton.disabled = true;
    submitStatus.textContent = 'SUBMITTING...';

    /**
     * True once this POST's reply no longer belongs to whatever the form is
     * currently showing. submitStatus/postButton/skipButton are a single
     * shared form reused by every run, so writing run A's outcome into them
     * after run B's offer has taken over would both lie about run B and (via
     * the SUBMIT button's own disabled/hidden state) lock the player out of
     * submitting it. Identity, not runId: a new run always gets a fresh
     * snapshot object, making this the strictly stronger check of the two.
     */
    const responseIsStale = (): boolean => activeSubmission !== snapshot;

    try {
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          seed,
          rleBase64: bytesToBase64(rle),
          // docs/plans/2026-08-19-ranking-free-async spec item 1: the
          // client now claims score/stage (the server no longer derives
          // them synchronously — that happens later, asynchronously, in
          // the audit). Taken from the immutable gameover-time snapshot,
          // never from live session state, same as seed/rle above.
          score: snapshot.score,
          stage: snapshot.stage,
          name: usingHandle ? undefined : name,
          xHandle: usingHandle ? xHandle : undefined,
          rulesetVersion: options.getRulesetVersion(),
          replayFormatVersion: options.getReplayFormatVersion(),
          // Browser-ownership token (docs/plans/2026-08-22-pending-self-
          // replace spec item 1) — what lets the server recognize that the
          // pending rows blocking this submission are this same player's, and
          // swap the weakest of them for a better score instead of answering
          // 429. `undefined` (no usable localStorage) drops the key from the
          // JSON entirely, which the server reads as "old/private-browsing
          // client" and handles exactly as it always did.
          submitterToken: getOrCreateSubmitterToken() ?? undefined,
        }),
      });
      const data = (await res.json()) as { accepted: boolean; status?: string; reason?: string; error?: string };
      if (responseIsStale()) return;
      // A 400 is the server rejecting what was TYPED (most often an X handle
      // that isn't one — which the name carry-over makes easy to hit with a
      // Japanese name). It used to fall into the catch below and surface as
      // "SUBMIT FAILED — YOU CAN TRY AGAIN", which is both wrong and cruel:
      // retrying unchanged input fails identically, and the one thing the
      // player needed — WHICH field is unacceptable — was the part thrown
      // away. It is now reported with the server's own reason, and the form
      // stays open and submittable so the value can actually be fixed.
      const inputRejected = res.status === 400;
      // A 429 is "not now", never "not ever" — see the retry branch below.
      const retryLater = res.status === 429;
      if (!res.ok && res.status !== 429 && res.status !== 409 && !inputRejected) {
        throw new Error(data.error ?? `unexpected status ${res.status}`);
      }
      // Free-tier async-audit response contract: a 200 accepted:true never
      // carries a final rank anymore (POST no longer resimulates
      // synchronously — see functions/api/scores.ts's own module comment) —
      // only "provisionally accepted, pending verification". A rejected
      // submission (out-of-range pre-gate, pending-cap 429, duplicate 409,
      // or any other declined outcome) is reported as-is; the previously
      // Paid-version-only "JUST MISSED THE TOP 10" copy doesn't distinguish
      // these anymore, so the server's own reason/error string is surfaced
      // directly instead.
      if (data.accepted) {
        submitStatus.textContent = 'SUBMITTED — PENDING VERIFICATION.';
      } else if (data.reason === 'out-of-range') {
        submitStatus.textContent = 'NOT CURRENTLY IN CONTENTION FOR THE TOP 10 — NOT SAVED.';
      } else if (retryLater) {
        // A 429 means one of two temporary queues is full: the verification
        // backlog (the server answers `accepted:false` for that one) or the
        // per-IP submission rate limit (which answers with an error and no
        // `accepted` field at all). Both clear on their own within minutes,
        // and the wording says so rather than implying the run is gone.
        submitStatus.textContent =
          data.accepted === false
            ? 'VERIFICATION QUEUE IS FULL RIGHT NOW — WAIT A MOMENT, THEN SUBMIT AGAIN.'
            : 'TOO MANY SUBMISSIONS RIGHT NOW — WAIT A MOMENT, THEN SUBMIT AGAIN.';
      } else {
        submitStatus.textContent = data.error ? `NOT ACCEPTED (${data.error}).` : 'NOT ACCEPTED.';
      }
      // Retryable outcomes leave SUBMIT exactly where it is.
      //
      // 400: fixable input — the corrected value needs a button to go out on.
      //
      // 429: the run was NOT judged, only deferred. Hiding SUBMIT here (which
      // this form used to do) threw the score away for good over a queue that
      // empties in minutes — and, now that a submission carries a browser
      // ownership token, a retry can do better than wait: if the pending rows
      // in the way are this same browser's own and weaker, the next SUBMIT
      // replaces the weakest of them instead of being refused
      // (docs/plans/2026-08-22-pending-self-replace spec item 3).
      if (inputRejected || retryLater) {
        postButton.disabled = false;
        return;
      }
      postButton.style.display = 'none';
      skipButton.textContent = 'OK';
    } catch {
      if (responseIsStale()) return;
      submitStatus.textContent = 'SUBMIT FAILED — YOU CAN TRY AGAIN.';
      postButton.disabled = false;
    } finally {
      // Only release the in-flight marker if it is still ours: a newer
      // submission may already have claimed it.
      if (submittingFor === snapshot) submittingFor = null;
    }
  }

  function offerSubmission(snapshot: RunSubmissionSnapshot): void {
    submitOverlay.style.display = 'none';
    activeSubmission = null;
    if (!isSnapshotEligible(snapshot)) return;
    activeSubmission = snapshot;
    void (async () => {
      let entries: RankingEntry[] | null = null;
      try {
        const res = await fetch('/api/ranking');
        if (res.ok) {
          const data = (await res.json()) as { entries: RankingEntry[] };
          entries = data.entries ?? [];
        }
      } catch {
        entries = null;
      }

      // Everything below re-checks the world as it looks *now*, not as it
      // looked when the request went out — see decideSubmissionOffer()'s doc
      // comment for the race this closes.
      const decision = decideSubmissionOffer({
        snapshot,
        activeSnapshot: activeSubmission,
        currentRunId: options.getRunId(),
        currentStatus: options.getSession().getStatus(),
        entries,
      });
      if (decision !== 'show') {
        // Drop the snapshot for anything except a live, still-current run
        // whose score simply didn't make the cut — in the latter case a
        // 'superseded' offer already owns `activeSubmission` and must not be
        // cleared out from under it.
        if (decision !== 'superseded' && activeSubmission === snapshot) activeSubmission = null;
        return;
      }

      // Per-run reset (unchanged): a fresh offer starts from an empty form,
      // both values included.
      nameInput.value = '';
      handleInput.value = '';
      handleCheckbox.checked = false;
      handleInput.style.display = 'none';
      nameInput.style.display = 'block';
      syncRetainedValueHint(); // both empty now -> hides itself
      submitStatus.textContent = '';
      postButton.style.display = 'inline-block';
      postButton.disabled = false;
      skipButton.textContent = 'SKIP';
      submitOverlay.style.display = 'flex';
    })();
  }

  // ---- Replay-viewer control bar ----
  const replayControls = document.createElement('div');
  replayControls.style.position = 'absolute';
  replayControls.style.bottom = '8px';
  // Spans the field and centers its children, rather than `left: 50%` +
  // `translateX(-50%)`: an absolutely positioned box is shrink-wrapped
  // against the space from its `left` edge to the container's right edge,
  // so with `left: 50%` the bar could never be wider than HALF the field and
  // the status line below wrapped at that half-width on every screen size
  // (user feedback, 2026-08-22). The strip itself stays click-transparent so
  // that, at full width, it doesn't swallow taps meant for the field; only
  // the button row is interactive.
  replayControls.style.left = '0';
  replayControls.style.right = '0';
  replayControls.style.display = 'none';
  // Column, not a single row: the status line below grew from a bare
  // "REPLAY" to a stage counter, and stacking it above the buttons keeps the
  // bar readable on a 390px-wide phone canvas.
  replayControls.style.flexDirection = 'column';
  replayControls.style.alignItems = 'center';
  replayControls.style.gap = '6px';
  replayControls.style.zIndex = '20';
  replayControls.style.pointerEvents = 'none';

  // Which stage of how many is on screen right now, and (user feedback,
  // 2026-08-20) whether that stage is the one the run ENDED on — a viewer
  // otherwise has no way to tell "there is more to come" from "this is where
  // they died", which is the single most interesting thing about a replay.
  const replayStageLabel = document.createElement('div');
  replayStageLabel.id = 'replay-stage-label';
  replayStageLabel.style.font = HUD_FONT;
  // A touch larger than the buttons beneath it: this line is the new
  // information on the bar, not a caption for them.
  replayStageLabel.style.fontSize = '0.95em';
  // Deliberately NOT bold: with the generic `monospace` family, a bold
  // weight made macOS Chrome substitute a proportional face for this one
  // line (the buttons beside it, at normal weight, kept the monospace face),
  // which both broke the bar's typography and widened the text. The glow and
  // the slightly larger size carry the emphasis instead.
  replayStageLabel.style.color = HUD_ACCENT_COLOR;
  replayStageLabel.style.textShadow = `0 0 8px ${HUD_ACCENT_COLOR}`;
  // Never broken mid-sentence (user feedback, 2026-08-22: the line wrapped
  // into a ragged 2-3 lines at phone widths). The longest wording is short
  // enough for every supported width; wrapping is not a normal case.
  replayStageLabel.style.whiteSpace = 'nowrap';
  replayStageLabel.style.textAlign = 'center';


  const replayButtonRow = document.createElement('div');
  replayButtonRow.style.display = 'flex';
  replayButtonRow.style.gap = '8px';
  replayButtonRow.style.pointerEvents = 'auto'; // the bar itself is click-transparent (see replayControls)
  const skipToFinalButton = styledButton('SKIP TO FINAL STAGE');
  const exitReplayButton = styledButton('EXIT');
  replayButtonRow.appendChild(skipToFinalButton);
  replayButtonRow.appendChild(exitReplayButton);
  replayControls.appendChild(replayStageLabel);
  replayControls.appendChild(replayButtonRow);
  anchor.appendChild(replayControls);

  let activeReplayEngine: ReplayEngine | null = null;
  let lastReplayStageText: string | null = null;
  let lastSkipVisible: boolean | null = null;

  /**
   * The status line's text for the replay currently on screen. `finalStage`
   * comes from the engine's own pre-pass (ReplayResult.stage — the stage the
   * recorded run ended on), so "3 / 3" is a fact about the RUN, not about how
   * far playback happens to have got.
   */
  function replayStageText(engine: ReplayEngine): string {
    const finalStage = engine.getResult().stage;
    const currentStage = Math.min(engine.getSession().getStage(), finalStage);
    const counter = `STAGE ${currentStage} / ${finalStage}`;
    // "(GAME OVER HERE)" is claimed ONLY on a real gameover. A replay whose
    // recorded input simply runs out mid-play (a truncated or
    // differently-configured recording — main.ts's own end-of-replay overlay
    // has always had to allow for it) also stops here, but nobody died: it
    // gets the neutral end wording instead.
    if (engine.getSession().getStatus() === 'gameover') return `REPLAY END - ${counter} (GAME OVER HERE)`;
    if (engine.isFinished()) return `REPLAY END - ${counter}`;
    return currentStage >= finalStage ? `REPLAY - ${counter} (FINAL STAGE)` : `REPLAY - ${counter}`;
  }

  /**
   * Whether SKIP TO FINAL STAGE still has anywhere to go. False once the
   * final stage is the one playing (a single-stage run: from the very first
   * frame) or playback has ended — the control is HIDDEN rather than disabled
   * in that case, so nobody is left working out why it won't respond.
   */
  function canSkipToFinalStage(engine: ReplayEngine): boolean {
    if (engine.isFinished()) return false;
    return engine.getSession().getStage() < engine.getResult().stage;
  }

  /**
   * Refreshes the status line, and the skip control's visibility, to match
   * the frame currently being rendered. Called once per rendered frame from
   * main.ts while in replay mode (the same arrangement syncAvailability()
   * uses, and for the same reason: both must track the frame on screen, not a
   * timer of their own) — so the skip button also disappears at the exact
   * moment ordinary playback crosses into the final stage, not just after a
   * skip. Cheap: each half early-returns unless its own value changed.
   */
  function syncReplayStatus(): void {
    const engine = activeReplayEngine;
    if (!engine) return;
    const text = replayStageText(engine);
    if (text !== lastReplayStageText) {
      lastReplayStageText = text;
      replayStageLabel.textContent = text;
    }
    const skippable = canSkipToFinalStage(engine);
    if (skippable !== lastSkipVisible) {
      lastSkipVisible = skippable;
      skipToFinalButton.style.display = skippable ? 'inline-block' : 'none';
    }
  }

  function mountReplayControls(): void {
    lastReplayStageText = null;
    replayStageLabel.textContent = 'REPLAY';
    // Starts hidden and is revealed by the first frame's sync if this replay
    // actually has a later stage to skip to — never flashed for a frame at a
    // single-stage run.
    lastSkipVisible = false;
    skipToFinalButton.style.display = 'none';
    replayControls.style.display = 'flex';
  }

  exitReplayButton.addEventListener('click', () => {
    replayControls.style.display = 'none';
    // Cleared BEFORE aborting, so the skip's own .finally() sees that its
    // engine is no longer current and doesn't resume playback on a discarded
    // one — and so a leftover SKIPPING... label can't survive into the next
    // replay.
    activeReplayEngine = null;
    abortReplayWork();
    endSkipUi();
    options.onReplayExit();
    // "終了して一覧へ戻る" (task 4): EXIT returns to the ranking list the
    // replay was launched from, not just to the live screen — startReplayFor()
    // closed the list on the way in, so this reopens (and refetches) it.
    void showList();
  });

  let skipping = false;

  function endSkipUi(): void {
    skipping = false;
    skipToFinalButton.disabled = false;
    skipToFinalButton.textContent = 'SKIP TO FINAL STAGE';
  }

  skipToFinalButton.addEventListener('click', () => {
    const engine = activeReplayEngine;
    if (!engine || skipping) return;
    skipping = true;
    // Chunked (see ReplayEngine.skipToFinalStage()): the label doubles as the
    // progress indicator, which only means anything because the skip now
    // yields to the event loop instead of blocking it.
    skipToFinalButton.disabled = true;
    skipToFinalButton.textContent = 'SKIPPING...';
    // Suspend normal playback for the duration. Both the skip loop and
    // main.ts's per-frame driver call stepTick() on the SAME engine, and the
    // skip yields between chunks — so without this they interleave and
    // double-advance the replay, overshooting the stage boundary the skip is
    // aiming at.
    options.onReplayAutoAdvanceChange(false);
    const signal = beginReplayWork();
    void engine
      .skipToFinalStage({ signal })
      .catch((err) => {
        if (!(err instanceof ReplayAbortedError)) throw err;
      })
      .finally(() => {
        endSkipUi();
        // Only resume if this engine is still the one on screen: EXIT aborts
        // the skip, and resuming playback then would drive a discarded engine.
        if (activeReplayEngine === engine) options.onReplayAutoAdvanceChange(true);
      });
  });

  // Track the currently-viewed engine (main.ts hands it back via
  // onReplayStart's own call site, but this module needs its own reference
  // for skipToFinalButton above).
  const originalOnReplayStart = options.onReplayStart;
  options.onReplayStart = (engine: ReplayEngine) => {
    activeReplayEngine = engine;
    originalOnReplayStart(engine);
  };

  // ---- Title button ----
  let titleButton: HTMLButtonElement | null = null;
  // `null` (not `true`/`false`) until the first syncAvailability() call, so
  // that first call always writes the button's real initial state.
  let lastBrowsingAllowed: boolean | null = null;

  function syncAvailability(): void {
    const allowed = browsingAllowed();
    if (allowed === lastBrowsingAllowed) return;
    lastBrowsingAllowed = allowed;
    if (titleButton) titleButton.style.display = allowed ? 'block' : 'none';
    // Also close anything already on screen: the Title screen's "press any
    // key to start" confirm still fires while an overlay is up, so a player
    // can start a run out from under an open list — which would otherwise
    // leave a live 3-minute run ticking away behind it. The transient
    // message overlay needs the same treatment: a 410/"failed to load"
    // message dismissed only by its own OK button would otherwise sit across
    // the board for the whole run.
    if (!allowed) {
      hideList();
      hideTransientMessage();
    }
  }

  function mountTitleButton(): void {
    const button = document.createElement('button');
    button.id = 'ranking-button';
    button.type = 'button';
    button.textContent = 'RANKING';
    // Deliberately mounted into `anchor` (canvas-wrap), absolutely
    // positioned, rather than as a flex child of the HUD row like MUTE/the
    // credit link: the HUD row's available single-line width is a tightly
    // -budgeted, test-guarded calculation (main.ts's
    // measureNonHudRowWidth()/wouldSingleLineFit(), exercised by
    // tests/e2e/narrow-title-hud.spec.ts and tests/e2e/smoke.spec.ts, both
    // pre-existing and off-limits to edit) — adding another persistent HUD
    // -row sibling shifts that budget and clips text at viewports those
    // tests pin down exactly. Sitting in the canvas's own top-right corner
    // instead never touches that layout at all.
    button.style.position = 'absolute';
    button.style.top = '8px';
    button.style.right = '8px';
    button.style.font = HUD_FONT;
    // BIGGER THAN MUTE, BUT STYLED EXACTLY LIKE IT. Two rounds of device
    // feedback (2026-08-20) landed here: the original 0.75em thin outline
    // read as a disabled caption and went unnoticed on the Title screen, but
    // the glowing, bold, tinted answer to that was too loud. So the size
    // stays (full HUD font size, generous padding — that is what makes it
    // findable) while every decoration matches main.ts's MUTE button
    // verbatim: same accent colour, same near-transparent fill, same 1px
    // border and 4px radius, and no glow or weight of its own.
    // `em`-relative sizing keeps it scaling with canvas-wrap exactly as
    // before, so nothing here is pinned to a pixel viewport.
    button.style.fontSize = '1em';
    button.style.color = HUD_ACCENT_COLOR;
    button.style.background = 'rgba(10, 14, 39, 0.7)';
    button.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
    button.style.borderRadius = '4px';
    button.style.padding = '8px 16px';
    // Never let the button spill out of the canvas box on a narrow phone —
    // it is absolutely positioned inside canvas-wrap, so without this a wide
    // enough label could overhang the field. (At 390px the label measures
    // ~135px against a ~390px-wide canvas, so this is a guard, not a
    // constraint that currently binds.)
    button.style.maxWidth = 'calc(100% - 16px)';
    button.style.cursor = 'pointer';
    button.style.pointerEvents = 'auto';
    button.style.userSelect = 'none';
    button.style.zIndex = '5';
    button.addEventListener('click', (event) => {
      void showList(); // itself gated on browsingAllowed(), against a click racing syncAvailability()
      (event.currentTarget as HTMLButtonElement).blur();
    });
    anchor.appendChild(button);
    titleButton = button;
    // Mounted during init(), before the first frame ever renders: start from
    // the real current state rather than flashing the button on a non-Title
    // screen for one frame.
    lastBrowsingAllowed = null;
    syncAvailability();
  }

  function hideAll(): void {
    submitOverlay.style.display = 'none';
    // Drops the pending snapshot too: main.ts calls this the moment the run
    // stops being 'gameover', so any /api/ranking response still in flight
    // for it must not reopen the form (decideSubmissionOffer()'s
    // 'superseded' / 'stale-run' guards).
    activeSubmission = null;
  }

  return { mountTitleButton, syncAvailability, syncReplayStatus, offerSubmission, hideAll };
}
