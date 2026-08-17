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
import { GameSession } from '../core/session';
import { InputRecorder } from '../core/inputRecorder';
import { ReplayEngine } from '../core/replayEngine';
import { RunMode } from '../runMode';
import { HUD_FONT, HUD_TEXT_COLOR, HUD_ACCENT_COLOR } from '../config';

interface RankingEntry {
  id: string;
  createdAt: string;
  score: number;
  stage: number;
  name: string;
  xHandle: string | null;
  replayAvailable: boolean;
}

interface ReplayPayload {
  seed: number;
  rleBase64: string;
  rulesetVersion: number;
  replayFormatVersion: number;
}

export interface RankingUIOptions {
  anchor: HTMLElement;
  getSession: () => GameSession;
  getRunMode: () => RunMode;
  getInputRecorder: () => InputRecorder;
  getRulesetVersion: () => number;
  getReplayFormatVersion: () => number;
  /** Switches main.ts's game loop into replay-viewing mode. */
  onReplayStart: (engine: ReplayEngine) => void;
  /** Switches main.ts's game loop back to live play. */
  onReplayExit: () => void;
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
  /** Mounts the persistent RANKING button (canvas-wrap's top-right corner — see mountTitleButton()'s own comment for why not the HUD row) — visible any time, opens the top-10 list. */
  mountTitleButton(): void;
  /** Offers ranking submission for the just-finished run, if eligible and provisionally in range. No-op (shows nothing) otherwise. */
  offerSubmission(scoreInfo: { score: number; stage: number }): void;
  /** Hides any open submission/list UI — call whenever GAME OVER's own modal is hidden. */
  hideAll(): void;
}

export function initRankingUI(options: RankingUIOptions): RankingUI {
  const { anchor } = options;

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

      if (entry.xHandle) {
        const handleLink = document.createElement('a');
        handleLink.href = `https://x.com/${encodeURIComponent(entry.xHandle)}`;
        handleLink.target = '_blank';
        handleLink.rel = 'noopener noreferrer';
        handleLink.style.color = HUD_ACCENT_COLOR;
        handleLink.style.fontSize = '0.85em';
        handleLink.textContent = `@${entry.xHandle}`;
        left.appendChild(handleLink);
      }
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
  });

  let submitting = false;
  postButton.addEventListener('click', () => {
    if (submitting) return;
    void submitScore();
  });

  async function submitScore(): Promise<void> {
    const session = options.getSession();
    const seed = session.getSeed();
    if (seed === undefined) return; // shouldn't happen for an eligible (normal-mode, seeded internally) run
    const rle = options.getInputRecorder().encode();

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

  function isEligible(): boolean {
    const session = options.getSession();
    return options.getRunMode() === 'normal' && !session.isRunTainted() && session.getSeed() !== undefined;
  }

  function offerSubmission(scoreInfo: { score: number; stage: number }): void {
    submitOverlay.style.display = 'none';
    if (!isEligible()) return;
    void (async () => {
      let provisionalInRange = false;
      try {
        const res = await fetch('/api/ranking');
        if (res.ok) {
          const data = (await res.json()) as { entries: RankingEntry[] };
          const entries = data.entries ?? [];
          provisionalInRange = entries.length < 10 || scoreInfo.score >= entries[entries.length - 1].score;
        }
      } catch {
        provisionalInRange = false;
      }
      if (!provisionalInRange) return;

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
      void showList();
      (event.currentTarget as HTMLButtonElement).blur();
    });
    anchor.appendChild(button);
  }

  function hideAll(): void {
    submitOverlay.style.display = 'none';
  }

  return { mountTitleButton, offerSubmission, hideAll };
}
