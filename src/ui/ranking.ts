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
import { ReplayEngine } from '../core/replayEngine';
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

interface ReplayPayload {
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

  function hideList(): void {
    listOverlay.style.display = 'none';
  }

  async function showList(): Promise<void> {
    if (!browsingAllowed()) return;
    listBody.textContent = '';
    const loading = document.createElement('div');
    loading.textContent = 'LOADING...';
    listBody.appendChild(loading);
    listOverlay.style.display = 'flex';

    let entries: RankingEntry[] = [];
    try {
      const res = await fetch('/api/ranking');
      if (!res.ok) throw new Error(`ranking fetch failed: ${res.status}`);
      const data = (await res.json()) as { entries: RankingEntry[] };
      entries = data.entries ?? [];
    } catch {
      listBody.textContent = '';
      const err = document.createElement('div');
      err.textContent = 'FAILED TO LOAD RANKING';
      listBody.appendChild(err);
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
    if (!browsingAllowed()) return; // see browsingAllowed()'s comment: replay viewing is a Title-screen-only affordance
    let payload: ReplayPayload;
    try {
      const res = await fetch(`/api/ranking/${encodeURIComponent(id)}/replay`);
      if (res.status === 410) {
        showTransientMessage('THIS RECORD CANNOT BE REPLAYED ON THE CURRENT VERSION.');
        return;
      }
      if (!res.ok) throw new Error(`replay fetch failed: ${res.status}`);
      payload = (await res.json()) as ReplayPayload;
    } catch {
      showTransientMessage('FAILED TO LOAD REPLAY.');
      return;
    }

    const engine = new ReplayEngine(payload.seed, base64ToBytes(payload.rleBase64));
    hideList();
    mountReplayControls();
    options.onReplayStart(engine);
  }

  // ---- Transient message (network/replay-unavailable errors) ----
  const messageOverlay = styledOverlay();
  const messageText = document.createElement('div');
  messageOverlay.appendChild(messageText);
  const messageCloseButton = styledButton('OK');
  messageCloseButton.addEventListener('click', () => {
    messageOverlay.style.display = 'none';
  });
  messageOverlay.appendChild(messageCloseButton);
  anchor.appendChild(messageOverlay);

  function showTransientMessage(text: string): void {
    messageText.textContent = text;
    messageOverlay.style.display = 'flex';
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

  let submitting = false;
  postButton.addEventListener('click', () => {
    if (submitting) return;
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

    submitting = true;
    postButton.disabled = true;
    submitStatus.textContent = 'SUBMITTING...';

    try {
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          seed,
          rleBase64: bytesToBase64(rle),
          name: usingHandle ? undefined : name,
          xHandle: usingHandle ? xHandle : undefined,
          rulesetVersion: options.getRulesetVersion(),
          replayFormatVersion: options.getReplayFormatVersion(),
        }),
      });
      const data = (await res.json()) as { accepted: boolean; rank: number | null; error?: string };
      if (!res.ok && res.status !== 422 && res.status !== 409) {
        throw new Error(data.error ?? `unexpected status ${res.status}`);
      }
      if (data.accepted) {
        submitStatus.textContent = `RANKED #${data.rank}!`;
      } else {
        submitStatus.textContent = data.error ? `NOT RANKED (${data.error}).` : 'JUST MISSED THE TOP 10.';
      }
      postButton.style.display = 'none';
      skipButton.textContent = 'OK';
    } catch {
      submitStatus.textContent = 'SUBMIT FAILED — YOU CAN TRY AGAIN.';
      postButton.disabled = false;
    } finally {
      submitting = false;
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
    activeReplayEngine = null;
    options.onReplayExit();
    // "終了して一覧へ戻る" (task 4): EXIT returns to the ranking list the
    // replay was launched from, not just to the live screen — startReplayFor()
    // closed the list on the way in, so this reopens (and refetches) it.
    void showList();
  });

  skipToFinalButton.addEventListener('click', () => {
    if (activeReplayEngine) activeReplayEngine.skipToFinalStage();
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
    // Also close a list that's already open: the Title screen's "press any
    // key to start" confirm still fires while the overlay is up, so a player
    // can start a run out from under an open list — which would otherwise
    // leave a live 3-minute run ticking away behind it.
    if (!allowed) hideList();
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
