// Score ranking UI: the TITLE
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
import { MAX_NAME_LENGTH } from '../core/rankingLimits';
import { RunMode } from '../runMode';
import { HUD_FONT, HUD_TEXT_COLOR, HUD_ACCENT_COLOR, MAX_VERIFIED_CLAIMS, RANKING_BOARD_SIZE } from '../config';
import { getOrCreateSubmitterToken } from './submitterToken';
import { t } from '../i18n';
import { applySentenceFont } from './sentenceFont';

export interface RankingEntry {
  id: string;
  createdAt: string;
  score: number;
  stage: number;
  name: string;
  xHandle: string | null;
  replayAvailable: boolean;
}

export function limitRankingName(value: string): string {
  return Array.from(value).slice(0, MAX_NAME_LENGTH).join('');
}

/**
 * One row of the board the UI actually draws. GET /api/ranking's
 * `displayEntries` merges verified rows and fresh pending rows into a single
 * ranked list under the same ordering rule.
 *
 * A superset of RankingEntry, which is what makes one rendering path enough:
 * `replayAvailable` is present and meaningful on a pending row too because
 * the server serves fresh pending replays, so the
 * REPLAY button is gated on exactly the same field regardless of `status`.
 *
 * `status` is carried for the server's benefit (audit, deletion, debugging)
 * and deliberately NOT rendered: the public board
 * treats pending and verified rows as one real-time ranking. Verification
 * is disclosed once, as a rule of the board, by the static notice under the
 * list (boardNotice(): "entries found invalid may be removed") rather than by
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
 * The board-wide notice under the ranking list. Neutral about the audit on
 * purpose: the server may store scores for a later audit or, with
 * RANKING_AUDIT_MODE=disabled, rank them as submitted, and GET /api/ranking
 * does not say which — so the notice has to be true either way. In the page
 * language (the text table's `ranking.notice`).
 */
export function boardNotice(): string {
  return t('ranking.notice');
}

/**
 * The submission form's line for an accepted POST, chosen from the `status`
 * the server reports for the row it stored: 'verified' (the server ranks
 * scores as submitted, without the audit) is simply on the board now; anything
 * else — 'pending', or an older server that sends no status — is waiting for
 * the audit.
 */
export function acceptedSubmissionText(status: unknown): string {
  return status === 'verified' ? t('submit.accepted') : t('submit.acceptedPending');
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
  /**
   * Successful area claims over the whole run. The server's audit refuses a
   * replay past MAX_VERIFIED_CLAIMS outright (functions/_lib/ranking/
   * verifyReplay.ts), and does so days later and silently from the player's
   * point of view — so the count is checked here, before any offer is made.
   */
  claims: number;
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
  | 'out-of-range'
  /** In range, but with more area claims than the audit will verify — shown as an explanation, never as a form. */
  | 'over-claim-cap';

/**
 * The score a run has to beat to enter the board, from GET /api/ranking's
 * verified `entries` (best first): 0 while the board has a free row (any
 * score gets in), otherwise the lowest row's score — a tie sorts behind the
 * incumbent (see decideSubmissionOffer()).
 */
export function rankInThresholdFrom(entries: RankingEntry[]): number {
  if (entries.length < RANKING_BOARD_SIZE) return 0;
  return entries[entries.length - 1].score;
}

/** A run may be submitted only if it is a normal (non-`?seed=`) run, untainted by debug overrides, and actually seeded. Derived purely from the snapshot — never from live session state. */
/**
 * The board's entry score (rankInThresholdFrom()) as of the newest
 * GET /api/ranking that succeeded. Several of those can be in flight at once
 * (the page-load one and each GAME OVER's), and their replies can land out of
 * order: each request takes a generation number from begin(), and a reply
 * only writes when no newer generation has written already. A failed reply
 * (`null`) writes nothing, so it never clears a known value.
 */
export class RankInThresholdTracker {
  private nextGeneration = 0;
  private writtenGeneration = -1;
  private value: number | null = null;

  /** Call as a GET /api/ranking goes out; pass the result to settle(). */
  begin(): number {
    return this.nextGeneration++;
  }

  /** Records the reply of request `generation`: its verified entries, or null when it failed. */
  settle(generation: number, entries: RankingEntry[] | null): void {
    if (entries === null || generation < this.writtenGeneration) return;
    this.writtenGeneration = generation;
    this.value = rankInThresholdFrom(entries);
  }

  get(): number | null {
    return this.value;
  }
}

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
  const inRange = entries.length < RANKING_BOARD_SIZE || snapshot.score > rankInThresholdFrom(entries);
  if (!inRange) return 'out-of-range';
  // Checked after the range test on purpose: a run that would not be offered
  // anyway needs no explanation, and a run that WOULD be deserves to hear
  // why it cannot be — a pending row that the audit later deletes for this
  // reason would otherwise read as "SUBMITTED" and then simply vanish.
  if (snapshot.claims > MAX_VERIFIED_CLAIMS) return 'over-claim-cap';
  return 'show';
}

export interface ReplayPayload {
  seed: number;
  rleBase64: string;
  rulesetVersion: number;
  replayFormatVersion: number;
  /** The row's audit state. Served for operations; the viewer does not render it. See DisplayRankingEntry. */
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
  /**
   * The submission panel's own RETRY: asks for exactly what the GAME OVER
   * modal's RETRY button asks for. The panel sits on top of the modal, so
   * without these two the modal's buttons could not be reached while it is
   * up. The panel closes through hideAll() once the run leaves GAME OVER.
   */
  onRetry: () => void;
  /** The submission panel's own TITLE: same as the GAME OVER modal's TITLE button (see onRetry). */
  onTitle: () => void;
}

/**
 * Formats GET /api/ranking's ISO-8601 `createdAt` as a plain `YYYY-MM-DD`
 * in the *viewer's* local timezone. Each row includes its date, score, stage,
 * and name. Built from the Date's local parts by
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
 * Without this, keyboard use of a ranking control would also leak into the
 * game's move/draw state and fire the "any key" confirm beneath the UI.
 */
export function stopKeyPropagation(el: HTMLElement): void {
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.addEventListener('keyup', (e) => e.stopPropagation());
}

/**
 * Panel sizing shared by the ranking list, the submission form and the
 * transient message.
 *
 * Both numbers are viewport-responsive because a fixed size left the panel
 * too small in the middle of a wide screen and the
 * rows were hard to read. Before, the whole panel was `0.8em` of an
 * inherited font size that never grew past the HUD's own 16px cap, and its
 * width was whatever the content happened to need.
 *
 * - WIDTH is a PERCENTAGE of canvas-wrap, not `vw`: the panel is absolutely
 * positioned inside the canvas box, which on a desktop is a good deal
 * narrower than the viewport (~915px of 1280px), so `90vw` would have
 * overhung the field it sits on.
 * - FONT SIZE uses `vw` deliberately, in the same idiom the HUD already uses
 * (`clamp(10px, 3.2vw, 16px)` in main.ts): it answers "how big is this
 * screen", which is the question being asked, and it is a font size — it
 * cannot overflow the panel the way a width could.
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
 * handle — an ambiguous row, since it reads as "I did enter a name, and it
 * was dropped". The handle IS the name in that case.
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
  stopKeyPropagation(link);
  link.href = `https://x.com/${encodeURIComponent(xHandle)}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.color = HUD_ACCENT_COLOR;
  link.textContent = `@${xHandle}`;
  return link;
}

function styledButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  stopKeyPropagation(button);
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
  /**
   * Packs the submission panel tighter (smaller text, less padding and
   * spacing) for a field too small to hold its roomy layout — a phone held
   * sideways — so the whole panel, its RETRY / TITLE row included, stays on
   * screen without scrolling. main.ts calls it whenever the field is resized.
   */
  setSubmitPanelCompact(compact: boolean): void;
  /**
   * Fetches GET /api/ranking once to learn the board's entry score (see
   * getRankInThreshold()). main.ts calls it on page load; a failure is
   * silent and leaves the score unknown.
   */
  loadRankInThreshold(): void;
  /**
   * The score a run has to beat to enter the board, as of the last
   * successful GET /api/ranking (the page-load one or a GAME OVER offer's):
   * 0 while the board has a free row, null until one succeeded.
   */
  getRankInThreshold(): number | null;
  /**
   * True while the ranking offer for the just-finished run must keep the
   * keyboard and the field from starting the next run: while asking
   * /api/ranking whether it can be posted, and while the submission panel
   * (the form, its result or the over-the-cap notice) is on screen. False
   * once that panel is closed (SKIP / OK) and once the run turns out not to
   * be offered.
   */
  isSubmissionBlockingRetry(): boolean;
  /** True only for the first half of isSubmissionBlockingRetry(): the /api/ranking check is still in flight. */
  isSubmissionCheckPending(): boolean;
}

export function initRankingUI(options: RankingUIOptions): RankingUI {
  const { anchor } = options;

  // ---- Browsing gate ----
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
  listHeading.textContent = t('ranking.heading');
  listHeading.style.fontSize = '1.2em';
  listHeading.style.fontWeight = 'bold';
  listOverlay.appendChild(listHeading);
  const disclaimer = document.createElement('div');
  // Two rules of the board, stated once for everyone: handles are
  // self-reported, and scores can be checked AFTER they
  // appear — a row can vanish later. The second sentence is what replaced the
  // per-row VERIFYING badge, so it must stay visible whenever the list is.
  // Worded so it is true whether or not the server currently runs the audit
  // (RANKING_AUDIT_MODE): the board never says which, by design.
  // Appended BELOW the list (see the end of this block), as a footnote: up
  // between the heading and the rows it read as the panel's headline.
  disclaimer.textContent = boardNotice();
  applySentenceFont(disclaimer);
  disclaimer.style.fontSize = '0.65em';
  disclaimer.style.opacity = '0.7';
  disclaimer.style.maxWidth = '260px';
  // ONE board: verified and pending rows share this container and ranking.
  // There is deliberately no separate "pending" section or
  // per-row marker.
  // A pending row is shown at its actual position with the same appearance
  // as its neighbours until the audit confirms it in place or removes it.
  const listBody = document.createElement('div');
  listBody.id = 'ranking-list-body';
  listBody.style.display = 'flex';
  listBody.style.flexDirection = 'column';
  listBody.style.gap = '4px';
  listBody.style.width = '100%';
  listOverlay.appendChild(listBody);
  listOverlay.appendChild(disclaimer);
  const listCloseButton = styledButton(t('ranking.close'));
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
    applySentenceFont(line);
    listBody.appendChild(line);
  }

  function clearListStatus(): void {
    listBody.textContent = '';
  }

  async function showList(): Promise<void> {
    if (!browsingAllowed()) return;
    browsingGeneration++;
    const requestGeneration = browsingGeneration;
    showListStatus(t('ranking.loading'));
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
      showListStatus(t('ranking.loadFailed'));
      return;
    }

    listBody.textContent = '';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = t('ranking.empty');
      applySentenceFont(empty);
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
      rankLine.textContent = t('ranking.row', index + 1, entry.score, entry.stage);
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

      // Secondary line: the entry's date and, when
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

      // Right-hand side: the REPLAY button. A fresh pending row IS replayable,
      // so `replayAvailable` alone decides the button, exactly
      // as it does for a verified row.
      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.alignItems = 'center';
      right.style.gap = '6px';
      right.style.flex = '0 0 auto';

      const replayButton = styledButton(t('ranking.replay'));
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
      showTransientMessage(t('replay.unsupported'));
      return;
    }
    if (!payload || !isReplayPayloadPlayable(payload, options.getRulesetVersion(), options.getReplayFormatVersion())) {
      // A version the *client* can't honour is the mirror image of the
      // server's own 410: an old tab left open across a deploy would
      // otherwise resimulate a new-ruleset replay with its old core and
      // silently render a wrong run. Checked here rather than trusting the
      // server's filter alone, because the stale party is this bundle.
      showTransientMessage(payload ? t('replay.unsupported') : t('replay.loadFailed'));
      return;
    }

    // Decoding and the pre-pass both run inside the try: base64 or RLE bytes
    // that don't decode used to throw out of this handler as an unhandled
    // rejection, leaving the player staring at an unchanged list.
    let engine: ReplayEngine;
    showListStatus(t('replay.loading'));
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
        showTransientMessage(t('replay.playbackFailed'));
      }
      return;
    }
    clearListStatus();

    // ReplayEngine.create() is itself an await (a chunked pre-pass), so the
    // same "did the player move on?" question applies again here.
    if (!browsingAllowed() || browsingGeneration !== requestGeneration) return;

    hideList();
    // A pending row's replay plays exactly like a verified one's — the
    // payload's `status` is not rendered.
    mountReplayControls();
    options.onReplayStart(engine);
  }

  // ---- Transient message (network/replay-unavailable errors) ----
  const messageOverlay = styledOverlay();
  const messageText = document.createElement('div');
  applySentenceFont(messageText);
  messageOverlay.appendChild(messageText);
  const messageCloseButton = styledButton(t('ranking.ok'));
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
  submitOverlay.id = 'ranking-submit-panel';
  const submitHeading = document.createElement('div');
  submitHeading.textContent = t('submit.heading');
  submitHeading.style.fontSize = '1em';
  submitHeading.style.fontWeight = 'bold';
  submitOverlay.appendChild(submitHeading);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = t('submit.namePlaceholder');
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
  stopKeyPropagation(handleCheckbox);
  const handleLabelText = document.createElement('span');
  handleLabelText.textContent = t('submit.useHandle');
  applySentenceFont(handleLabelText);
  handleRow.appendChild(handleCheckbox);
  handleRow.appendChild(handleLabelText);
  submitOverlay.appendChild(handleRow);

  const handleInput = document.createElement('input');
  handleInput.type = 'text';
  handleInput.placeholder = t('submit.handlePlaceholder');
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
  // made ticking the box seem to move the checkbox above the field on
  // narrow screens.
  submitOverlay.insertBefore(handleInput, handleRow);

  // The two fields hold their values independently. Ticking the checkbox used
  // to swap a filled NAME box for an empty @handle box in the same spot, which
  // reads as the typed name being wiped. The value is preserved across the
  // switch, carrying the name over since it is almost always the same
  // word. See
  // carryNameIntoHandle() below; this hint covers what is left over, i.e. the
  // cases where the two sides genuinely differ.
  const retainedValueHint = document.createElement('div');
  retainedValueHint.id = 'ranking-submit-hint';
  retainedValueHint.style.fontSize = '0.7em';
  retainedValueHint.style.color = HUD_ACCENT_COLOR;
  retainedValueHint.style.maxWidth = '100%';
  retainedValueHint.style.overflowWrap = 'anywhere';
  retainedValueHint.style.display = 'none';
  applySentenceFont(retainedValueHint);
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
    const hidden = handleCheckbox.checked
      ? { label: t('submit.nameLabel'), value: nameInput.value }
      : { label: t('submit.handleLabel'), value: handleInput.value };
    const active = handleCheckbox.checked ? handleInput.value : nameInput.value;
    if (hidden.value === '' || hidden.value === active) {
      retainedValueHint.style.display = 'none';
      retainedValueHint.textContent = '';
      return;
    }
    retainedValueHint.textContent = t('submit.kept', hidden.label, hidden.value);
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
  nameInput.addEventListener('input', (event) => {
    if (!(event as InputEvent).isComposing) nameInput.value = limitRankingName(nameInput.value);
    syncRetainedValueHint();
  });
  nameInput.addEventListener('compositionend', () => {
    nameInput.value = limitRankingName(nameInput.value);
    syncRetainedValueHint();
  });
  handleInput.addEventListener('input', syncRetainedValueHint);

  const submitStatus = document.createElement('div');
  submitStatus.style.fontSize = '0.75em';
  submitStatus.style.minHeight = '1.2em';
  applySentenceFont(submitStatus);
  submitOverlay.appendChild(submitStatus);

  const submitButtonRow = document.createElement('div');
  submitButtonRow.style.display = 'flex';
  submitButtonRow.style.gap = '10px';
  const skipButton = styledButton(t('submit.skip'));
  const postButton = styledButton(t('submit.submit'));
  submitButtonRow.appendChild(skipButton);
  submitButtonRow.appendChild(postButton);
  submitOverlay.appendChild(submitButtonRow);

  // RETRY / TITLE, smaller than the row above: the panel covers the GAME OVER
  // modal, whose own RETRY / TITLE buttons are the way on while the keys and
  // the field are held, so the panel carries the same two requests.
  const submitNavRow = document.createElement('div');
  submitNavRow.style.display = 'flex';
  submitNavRow.style.gap = '10px';
  const submitRetryButton = styledButton(t('submit.retry'));
  submitRetryButton.id = 'ranking-submit-retry-button';
  const submitTitleButton = styledButton(t('submit.title'));
  submitTitleButton.id = 'ranking-submit-title-button';
  for (const button of [submitRetryButton, submitTitleButton]) {
    button.style.fontSize = '0.7em';
    button.style.padding = '4px 10px';
  }
  submitNavRow.appendChild(submitRetryButton);
  submitNavRow.appendChild(submitTitleButton);
  submitOverlay.appendChild(submitNavRow);
  anchor.appendChild(submitOverlay);

  /** True while this panel's own run has a POST in flight. */
  function isPostInFlight(): boolean {
    return submittingFor !== null && submittingFor === activeSubmission;
  }

  /**
   * RETRY / TITLE are off while the POST is in flight — leaving the run then
   * would drop it with its submission still unanswered — and on otherwise
   * (the form, the over-the-cap notice and a finished POST's result).
   */
  function syncSubmitNavButtons(): void {
    const disabled = isPostInFlight();
    submitRetryButton.disabled = disabled;
    submitTitleButton.disabled = disabled;
    submitRetryButton.style.opacity = disabled ? '0.4' : '1';
    submitTitleButton.style.opacity = disabled ? '0.4' : '1';
    submitRetryButton.style.cursor = disabled ? 'default' : 'pointer';
    submitTitleButton.style.cursor = disabled ? 'default' : 'pointer';
  }

  submitRetryButton.addEventListener('click', () => {
    if (isPostInFlight()) return;
    options.onRetry();
    submitRetryButton.blur();
  });
  submitTitleButton.addEventListener('click', () => {
    if (isPostInFlight()) return;
    options.onTitle();
    submitTitleButton.blur();
  });

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
      submitStatus.textContent = t('submit.unavailable');
      postButton.style.display = 'none';
      skipButton.textContent = t('submit.ok');
      return;
    }
    const seed = snapshot.seed;
    const rle = snapshot.rle;

    const usingHandle = handleCheckbox.checked;
    const name = usingHandle ? '' : nameInput.value;
    const xHandle = usingHandle ? handleInput.value : '';
    if (!name.trim() && !xHandle.trim()) {
      submitStatus.textContent = t('submit.needName');
      return;
    }

    submittingFor = snapshot;
    postButton.disabled = true;
    syncSubmitNavButtons();
    submitStatus.textContent = t('submit.submitting');

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
          // The client claims score/stage; the server no longer derives
          // them synchronously. Verification happens later in the audit.
          // Values come from the immutable gameover-time snapshot and
          // never from live session state, same as seed/rle above.
          score: snapshot.score,
          stage: snapshot.stage,
          name: usingHandle ? undefined : name,
          xHandle: usingHandle ? xHandle : undefined,
          rulesetVersion: options.getRulesetVersion(),
          replayFormatVersion: options.getReplayFormatVersion(),
          // Browser-ownership token — what lets the server recognize that the
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
      // only the stored row's `status`: "provisionally accepted, pending
      // verification", or "verified" when the server runs without the audit
      // (see acceptedSubmissionText()). A rejected
      // submission (out-of-range pre-gate, pending-cap 429, duplicate 409,
      // or any other declined outcome) is reported as-is; the previously
      // Paid-version-only "JUST MISSED THE TOP 10" copy doesn't distinguish
      // these anymore, so the server's own reason/error string is surfaced
      // directly instead.
      if (data.accepted) {
        submitStatus.textContent = acceptedSubmissionText(data.status);
      } else if (data.reason === 'out-of-range') {
        submitStatus.textContent = t('submit.notInContention');
      } else if (retryLater) {
        // A 429 means one of two temporary queues is full: the verification
        // backlog (the server answers `accepted:false` for that one) or the
        // per-IP submission rate limit (which answers with an error and no
        // `accepted` field at all). The backlog may clear quickly, while the
        // fixed rate-limit window can take up to an hour to reset.
        submitStatus.textContent = data.accepted === false ? t('submit.queueFull') : t('submit.rateLimited');
      } else {
        submitStatus.textContent = data.error ? t('submit.notAcceptedWith', data.error) : t('submit.notAccepted');
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
      // replaces the weakest of them instead of being refused.
      // This preserves the player's retry opportunity.
      if (inputRejected || retryLater) {
        postButton.disabled = false;
        return;
      }
      postButton.style.display = 'none';
      skipButton.textContent = t('submit.ok');
    } catch {
      if (responseIsStale()) return;
      submitStatus.textContent = t('submit.failed');
      postButton.disabled = false;
    } finally {
      // Only release the in-flight marker if it is still ours: a newer
      // submission may already have claimed it.
      if (submittingFor === snapshot) submittingFor = null;
      syncSubmitNavButtons();
    }
  }

  // The board's entry score (getRankInThreshold()), from the newest
  // successful GET /api/ranking that carried verified `entries`.
  const rankInThreshold = new RankInThresholdTracker();

  async function fetchVerifiedEntries(): Promise<RankingEntry[] | null> {
    const generation = rankInThreshold.begin();
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
    rankInThreshold.settle(generation, entries);
    return entries;
  }

  function loadRankInThreshold(): void {
    void fetchVerifiedEntries();
  }

  // The snapshot whose /api/ranking check is still in flight (see
  // isSubmissionCheckPending()). Identity-keyed like `submittingFor`, so an
  // older run's late reply cannot clear a newer run's check.
  let checkingFor: RunSubmissionSnapshot | null = null;

  function isSubmissionCheckPending(): boolean {
    return checkingFor !== null;
  }

  function isSubmissionBlockingRetry(): boolean {
    return checkingFor !== null || submitOverlay.style.display !== 'none';
  }

  function offerSubmission(snapshot: RunSubmissionSnapshot): void {
    submitOverlay.style.display = 'none';
    activeSubmission = null;
    checkingFor = null;
    if (!isSnapshotEligible(snapshot)) return;
    activeSubmission = snapshot;
    checkingFor = snapshot;
    void (async () => {
      const entries = await fetchVerifiedEntries();
      if (checkingFor === snapshot) checkingFor = null;

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
      if (decision === 'over-claim-cap') {
        // Explanation only: no name field, no SUBMIT. The snapshot is dropped
        // right away — there is nothing a retry could change about it.
        activeSubmission = null;
        nameInput.style.display = 'none';
        handleRow.style.display = 'none';
        handleInput.style.display = 'none';
        submitStatus.textContent = t('submit.tooManyClaims', snapshot.claims, MAX_VERIFIED_CLAIMS);
        postButton.style.display = 'none';
        skipButton.textContent = t('submit.ok');
        syncSubmitNavButtons();
        submitOverlay.style.display = 'flex';
        return;
      }
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
      handleRow.style.display = 'flex';
      nameInput.style.display = 'block';
      syncRetainedValueHint(); // both empty now -> hides itself
      submitStatus.textContent = '';
      postButton.style.display = 'inline-block';
      postButton.disabled = false;
      skipButton.textContent = t('submit.skip');
      syncSubmitNavButtons();
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
  // the status line below wrapped at that half-width on every screen size.
  // The strip itself stays click-transparent so
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

  // Shows which stage is on screen and whether it is the stage where the
  // run ended — a viewer
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
  // Never broken mid-sentence: the line wrapped
  // into a ragged 2-3 lines at phone widths. The longest wording is short
  // enough for every supported width; wrapping is not a normal case.
  replayStageLabel.style.whiteSpace = 'nowrap';
  replayStageLabel.style.textAlign = 'center';


  const replayButtonRow = document.createElement('div');
  replayButtonRow.style.display = 'flex';
  replayButtonRow.style.gap = '8px';
  replayButtonRow.style.pointerEvents = 'auto'; // the bar itself is click-transparent (see replayControls)
  const skipToFinalButton = styledButton(t('replay.skipToFinal'));
  const exitReplayButton = styledButton(t('replay.exit'));
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
    const counter = t('replay.counter', currentStage, finalStage);
    // "(GAME OVER HERE)" is claimed ONLY on a real gameover. A replay whose
    // recorded input simply runs out mid-play (a truncated or
    // differently-configured recording — main.ts's own end-of-replay overlay
    // has always had to allow for it) also stops here, but nobody died: it
    // gets the neutral end wording instead.
    if (engine.getSession().getStatus() === 'gameover') return t('replay.statusEndGameOver', counter);
    if (engine.isFinished()) return t('replay.statusEnd', counter);
    return currentStage >= finalStage ? t('replay.statusFinal', counter) : t('replay.status', counter);
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
    replayStageLabel.textContent = t('replay.label');
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
    // "終了して一覧へ戻る": EXIT returns to the ranking list the
    // replay was launched from, not just to the live screen — startReplayFor()
    // closed the list on the way in, so this reopens (and refetches) it.
    void showList();
  });

  let skipping = false;

  function endSkipUi(): void {
    skipping = false;
    skipToFinalButton.disabled = false;
    skipToFinalButton.textContent = t('replay.skipToFinal');
  }

  skipToFinalButton.addEventListener('click', () => {
    const engine = activeReplayEngine;
    if (!engine || skipping) return;
    skipping = true;
    // Chunked (see ReplayEngine.skipToFinalStage()): the label doubles as the
    // progress indicator, which only means anything because the skip now
    // yields to the event loop instead of blocking it.
    skipToFinalButton.disabled = true;
    skipToFinalButton.textContent = t('replay.skipping');
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
    stopKeyPropagation(button);
    button.id = 'ranking-button';
    button.type = 'button';
    button.textContent = t('ranking.button');
    // Mounted into `anchor` (canvas-wrap) and absolutely positioned to
    // preserve the HUD row's single-line width budget, which main.ts
    // calculates in measureNonHudRowWidth()/wouldSingleLineFit(). Adding a
    // persistent HUD-row sibling reduces the available width and can clip
    // text in narrow viewports. The canvas's top-right corner does not
    // participate in that layout.
    button.style.position = 'absolute';
    button.style.top = '8px';
    button.style.right = '8px';
    button.style.font = HUD_FONT;
    // BIGGER THAN MUTE, BUT STYLED EXACTLY LIKE IT. The original 0.75em
    // thin outline
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

  let submitPanelCompact = false;
  function setSubmitPanelCompact(compact: boolean): void {
    if (compact === submitPanelCompact) return;
    submitPanelCompact = compact;
    // The roomy values are styledOverlay()'s / styledButton()'s / the
    // fields' own, restored when the field grows again.
    submitOverlay.style.padding = compact ? '4px 8px' : '16px 20px';
    submitOverlay.style.gap = compact ? '2px' : '8px';
    submitOverlay.style.fontSize = compact ? '10px' : OVERLAY_FONT_SIZE;
    // Explicit values, never '': clearing the longhand the `font` shorthand
    // set would inherit #canvas-wrap's line-height 0.
    submitOverlay.style.lineHeight = compact ? '1.1' : 'normal';
    submitOverlay.style.maxHeight = compact ? '100%' : '90%';
    for (const input of [nameInput, handleInput]) input.style.padding = compact ? '2px 6px' : '4px 8px';
    for (const button of [skipButton, postButton]) button.style.padding = compact ? '3px 10px' : '6px 12px';
    for (const button of [submitRetryButton, submitTitleButton]) button.style.padding = compact ? '2px 8px' : '4px 10px';
    submitStatus.style.minHeight = compact ? '0' : '1.2em';
  }

  function hideAll(): void {
    submitOverlay.style.display = 'none';
    // Drops the pending snapshot too: main.ts calls this the moment the run
    // stops being 'gameover', so any /api/ranking response still in flight
    // for it must not reopen the form (decideSubmissionOffer()'s
    // 'superseded' / 'stale-run' guards).
    activeSubmission = null;
    checkingFor = null;
  }

  return {
    mountTitleButton,
    syncAvailability,
    syncReplayStatus,
    offerSubmission,
    hideAll,
    setSubmitPanelCompact,
    loadRankInThreshold,
    getRankInThreshold: () => rankInThreshold.get(),
    isSubmissionBlockingRetry,
    isSubmissionCheckPending,
  };
}
