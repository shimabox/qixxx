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
 * A provisionally-in-range, not-yet-audited submission (docs/plans/2026-08
 * -19-ranking-free-async spec item 5) — GET /api/ranking's `pendingEntries`.
 * Deliberately has no rank: the UI renders these in their own unranked
 * "検証待ち" section above the confirmed board, never merged into it, and
 * never offers a REPLAY button for one (the server itself refuses to serve
 * a pending row's replay — GET /api/ranking/:id/replay requires
 * status='verified' — so `id` here is carried only for a stable list key,
 * not treated as replayable).
 */
export interface PendingRankingEntry {
  id: string;
  createdAt: string;
  score: number;
  stage: number;
  name: string;
  xHandle: string | null;
  unverified: true;
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
  el.style.maxHeight = '90%';
  el.style.overflowY = 'auto';
  el.style.background = 'rgba(10, 14, 39, 0.95)';
  el.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
  el.style.borderRadius = '8px';
  el.style.boxShadow = `0 0 16px ${HUD_ACCENT_COLOR}`;
  el.style.color = HUD_TEXT_COLOR;
  el.style.font = HUD_FONT;
  el.style.fontSize = '0.8em';
  el.style.textAlign = 'center';
  el.style.pointerEvents = 'auto';
  el.style.userSelect = 'none';
  el.style.zIndex = '20';
  el.style.display = 'none';
  return el;
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
  disclaimer.textContent = 'X handles are self-reported — ownership is not verified.';
  disclaimer.style.fontSize = '0.65em';
  disclaimer.style.opacity = '0.7';
  disclaimer.style.maxWidth = '260px';
  listOverlay.appendChild(disclaimer);
  // Unranked "検証待ち" section (docs/plans/2026-08-19-ranking-free-async
  // spec item 5) — a SEPARATE container from listBody below, inserted
  // ABOVE the confirmed board, never merged/inserted into it. Hidden
  // (no children) whenever pendingEntries is empty.
  const pendingBody = document.createElement('div');
  pendingBody.style.display = 'flex';
  pendingBody.style.flexDirection = 'column';
  pendingBody.style.gap = '4px';
  pendingBody.style.width = '100%';
  listOverlay.appendChild(pendingBody);
  const listBody = document.createElement('div');
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

  /** Replaces the list body with a single status line (LOADING/error) — also clears the pending section, since a failed/loading fetch has nothing trustworthy to show there either. */
  function showListStatus(text: string): void {
    listBody.textContent = '';
    pendingBody.textContent = '';
    const line = document.createElement('div');
    line.textContent = text;
    listBody.appendChild(line);
  }

  function clearListStatus(): void {
    listBody.textContent = '';
    pendingBody.textContent = '';
  }

  /**
   * Renders the unranked "検証待ち" section (docs/plans/2026-08-19-ranking-
   * free-async spec item 5): no rank number, no REPLAY button (the server
   * itself refuses to serve a pending row's replay — see
   * PendingRankingEntry's own doc comment), a distinct dimmer/badged style
   * so it reads as provisional rather than as part of the confirmed board.
   * No-op (renders nothing) when `pending` is empty.
   */
  function renderPendingEntries(pending: PendingRankingEntry[]): void {
    pendingBody.textContent = '';
    if (pending.length === 0) return;

    const heading = document.createElement('div');
    heading.textContent = 'PENDING VERIFICATION';
    heading.style.fontSize = '0.75em';
    heading.style.opacity = '0.75';
    heading.style.marginTop = '2px';
    pendingBody.appendChild(heading);

    pending.forEach((entry) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.width = '100%';
      row.style.justifyContent = 'space-between';
      row.style.opacity = '0.65'; // visually distinct from the confirmed board below

      const left = document.createElement('div');
      left.style.textAlign = 'left';
      const line = document.createElement('div');
      // No rank number here — deliberately, per this section's own contract
      // (never implies a confirmed position on the board).
      line.textContent = `${entry.score}  STAGE ${entry.stage}  `;
      const nameSpan = document.createElement('span');
      nameSpan.textContent = entry.name || '(no name)';
      line.appendChild(nameSpan);
      left.appendChild(line);
      row.appendChild(left);

      const badge = document.createElement('span');
      badge.textContent = 'PENDING';
      badge.style.fontSize = '0.7em';
      badge.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
      badge.style.borderRadius = '4px';
      badge.style.padding = '2px 6px';
      row.appendChild(badge);

      pendingBody.appendChild(row);
    });
  }

  async function showList(): Promise<void> {
    if (!browsingAllowed()) return;
    browsingGeneration++;
    const requestGeneration = browsingGeneration;
    showListStatus('LOADING...');
    listOverlay.style.display = 'flex';

    let entries: RankingEntry[] | null = null;
    let pendingEntries: PendingRankingEntry[] = [];
    try {
      const res = await fetch('/api/ranking');
      if (!res.ok) throw new Error(`ranking fetch failed: ${res.status}`);
      const data = (await res.json()) as { entries: RankingEntry[]; pendingEntries?: PendingRankingEntry[] };
      entries = data.entries ?? [];
      pendingEntries = data.pendingEntries ?? [];
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

    renderPendingEntries(pendingEntries);

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
      const rankLine = document.createElement('div');
      // textContent-only composition (XSS safety): each piece is either a
      // trusted literal/number, or appended as its own text node below
      // (entry.name) — never concatenated into one interpolated string that
      // could blur the line between "our text" and "their text".
      rankLine.textContent = `#${index + 1}  ${entry.score}  STAGE ${entry.stage}  `;
      const nameSpan = document.createElement('span');
      nameSpan.textContent = entry.name || '(no name)';
      rankLine.appendChild(nameSpan);
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

      if (entry.xHandle) {
        const handleLink = document.createElement('a');
        handleLink.href = `https://x.com/${encodeURIComponent(entry.xHandle)}`;
        handleLink.target = '_blank';
        handleLink.rel = 'noopener noreferrer';
        handleLink.style.color = HUD_ACCENT_COLOR;
        handleLink.style.fontSize = '1.15em'; // back up to the rank line's size, against metaLine's 0.7em
        handleLink.textContent = `@${entry.xHandle}`;
        metaLine.appendChild(handleLink);
      }
      left.appendChild(metaLine);
      row.appendChild(left);

      const replayButton = styledButton('REPLAY');
      replayButton.disabled = !entry.replayAvailable;
      if (!entry.replayAvailable) {
        replayButton.style.opacity = '0.4';
        replayButton.style.cursor = 'not-allowed';
      }
      replayButton.addEventListener('click', () => void startReplayFor(entry.id));
      row.appendChild(replayButton);

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
  nameInput.style.width = '180px';
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
  handleInput.style.width = '180px';
  handleInput.style.display = 'none';
  stopKeyPropagation(handleInput); // see nameInput's own comment above
  submitOverlay.appendChild(handleInput);
  handleCheckbox.addEventListener('change', () => {
    handleInput.style.display = handleCheckbox.checked ? 'block' : 'none';
    nameInput.style.display = handleCheckbox.checked ? 'none' : 'block';
  });

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
        }),
      });
      const data = (await res.json()) as { accepted: boolean; status?: string; reason?: string; error?: string };
      if (responseIsStale()) return;
      if (!res.ok && res.status !== 429 && res.status !== 409) {
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
      } else {
        submitStatus.textContent = data.error ? `NOT ACCEPTED (${data.error}).` : 'NOT ACCEPTED.';
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

      nameInput.value = '';
      handleInput.value = '';
      handleCheckbox.checked = false;
      handleInput.style.display = 'none';
      nameInput.style.display = 'block';
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
  replayControls.style.left = '50%';
  replayControls.style.transform = 'translateX(-50%)';
  replayControls.style.display = 'none';
  replayControls.style.gap = '8px';
  replayControls.style.zIndex = '20';
  replayControls.style.pointerEvents = 'auto';
  const replayLabel = document.createElement('div');
  replayLabel.textContent = 'REPLAY';
  replayLabel.style.font = HUD_FONT;
  replayLabel.style.fontSize = '0.75em';
  replayLabel.style.color = HUD_ACCENT_COLOR;
  replayLabel.style.alignSelf = 'center';
  const skipToFinalButton = styledButton('SKIP TO FINAL STAGE');
  const exitReplayButton = styledButton('EXIT');
  replayControls.appendChild(replayLabel);
  replayControls.appendChild(skipToFinalButton);
  replayControls.appendChild(exitReplayButton);
  anchor.appendChild(replayControls);

  let activeReplayEngine: ReplayEngine | null = null;

  function mountReplayControls(): void {
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
    button.style.top = '6px';
    button.style.right = '6px';
    button.style.font = HUD_FONT;
    button.style.fontSize = '0.75em';
    button.style.color = HUD_ACCENT_COLOR;
    button.style.background = 'rgba(10, 14, 39, 0.7)';
    button.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
    button.style.borderRadius = '4px';
    button.style.padding = '4px 10px';
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

  return { mountTitleButton, syncAvailability, offerSubmission, hideAll };
}
