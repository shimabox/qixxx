// GAME OVER modal (docs/plan-cloudflare-x-share.md Phase 1): shown only
// while `session.getStatus() === 'gameover'`, layered on top of #screen
// inside #canvas-wrap (see src/main.ts's getScreenElement()/getCanvasWrapElement()),
// centered over the field exactly like #screen already is. Displays the
// run's SCORE / STAGE / HI SCORE and offers two buttons: "POST TO X" (share)
// and "BACK TO TITLE".
//
// DOM-only module — src/core/ is never imported here (docs/plan.md's "core
// purity" invariant), matching input/keyboard.ts and input/touch.ts's
// existing DOM-touching exemption.
import { HUD_FONT, HUD_TEXT_COLOR, HUD_ACCENT_COLOR } from '../config';

export interface GameOverScoreInfo {
  score: number;
  stage: number;
  hiScore: number;
}

// Edge-triggered "return to Title" signal, reusing input/touch.ts's
// VirtualConfirm technique verbatim (see its module comment): a synthetic
// keydown+keyup pair dispatched on `window` with a `code` no real key/button
// produces, so KeyboardInput's edge-triggered `confirm` pulse (docs/plan.md
// §4.4) fires exactly like "press any key" — without this module needing to
// import core/session.ts or reach into main.ts's KeyboardInput instance at
// all. A distinct code from VirtualConfirm's own, purely so the two sources
// stay independently traceable; either would work identically.
const MODAL_CONFIRM_CODE = 'ModalConfirm';

function dispatchConfirm(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: MODAL_CONFIRM_CODE }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: MODAL_CONFIRM_CODE }));
}

/** 3-digit comma grouping for the tweet text (e.g. 45600 -> "45,600"). */
function formatScoreWithCommas(value: number): string {
  return value.toLocaleString('en-US');
}

/** Phase 2's Cloudflare Function that issues a share ID: `${BASE_URL}share` (= /qixxx/share). */
function shareEndpoint(): string {
  return `${import.meta.env.BASE_URL}share`;
}

/** The `/qixxx/s?id=...` page Phase 2 serves the OG card for. */
function shareViewUrl(id: string): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}s?id=${encodeURIComponent(id)}`;
}

function tweetIntentUrl(info: GameOverScoreInfo, id: string): string {
  const text = `QIXXX で STAGE ${info.stage} / SCORE ${formatScoreWithCommas(info.score)} を記録！ #QIXXX`;
  const url = shareViewUrl(id);
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}

export class GameOverModal {
  private readonly container: HTMLDivElement;
  private readonly scoreLine: HTMLDivElement;
  private readonly stageLine: HTMLDivElement;
  private readonly hiLine: HTMLDivElement;
  private readonly shareButton: HTMLButtonElement;
  private current: GameOverScoreInfo = { score: 0, stage: 1, hiScore: 0 };
  private sharing = false;

  constructor(anchor: HTMLElement) {
    this.container = document.createElement('div');
    this.container.id = 'gameover-modal';
    // Centered over the field, same positioning basis as #screen (this is a
    // sibling inside #canvas-wrap) — but unlike #screen, this container's
    // own pointer-events are enabled (it needs to be clickable/tappable),
    // while #screen itself stays pointer-events:none (src/main.ts).
    this.container.style.position = 'absolute';
    this.container.style.top = '50%';
    this.container.style.left = '50%';
    this.container.style.transform = 'translate(-50%, -50%)';
    this.container.style.display = 'none';
    this.container.style.flexDirection = 'column';
    this.container.style.alignItems = 'center';
    this.container.style.gap = '6px';
    this.container.style.padding = '20px 28px';
    this.container.style.background = 'rgba(10, 14, 39, 0.92)';
    this.container.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
    this.container.style.borderRadius = '8px';
    this.container.style.boxShadow = `0 0 16px ${HUD_ACCENT_COLOR}`;
    this.container.style.color = HUD_TEXT_COLOR;
    this.container.style.font = HUD_FONT;
    this.container.style.textAlign = 'center';
    this.container.style.textShadow = `0 0 8px ${HUD_ACCENT_COLOR}`;
    this.container.style.pointerEvents = 'auto';
    this.container.style.userSelect = 'none';
    this.container.style.zIndex = '10';

    const heading = document.createElement('div');
    heading.textContent = 'GAME OVER';
    heading.style.fontSize = '1.3em';
    heading.style.fontWeight = 'bold';
    heading.style.marginBottom = '4px';
    this.container.appendChild(heading);

    this.scoreLine = document.createElement('div');
    this.stageLine = document.createElement('div');
    this.hiLine = document.createElement('div');
    this.container.appendChild(this.scoreLine);
    this.container.appendChild(this.stageLine);
    this.container.appendChild(this.hiLine);

    const buttonRow = document.createElement('div');
    buttonRow.style.display = 'flex';
    buttonRow.style.gap = '10px';
    buttonRow.style.marginTop = '10px';

    this.shareButton = this.buildButton('POST TO X', 'gameover-share-button');
    this.shareButton.addEventListener('click', () => void this.handleShareClick());

    const backButton = this.buildButton('BACK TO TITLE', 'gameover-back-button');
    // Uses the exact same "press any key" confirm path as keyboard/touch
    // input (see dispatchConfirm() above) rather than calling into
    // GameSession directly, so this module never needs a reference to the
    // session/KeyboardInput instances.
    backButton.addEventListener('click', () => dispatchConfirm());

    buttonRow.appendChild(backButton);
    buttonRow.appendChild(this.shareButton);
    this.container.appendChild(buttonRow);

    // Folded in here (rather than left in #screen behind this opaque modal)
    // so the two screens never fight over the same centered position with
    // duplicate/hidden text — see src/main.ts's screenText() 'gameover'
    // branch, which now returns '' whenever this modal is the one covering
    // that message.
    const hint = document.createElement('div');
    hint.textContent = 'PRESS ANY KEY OR TAP FIELD FOR TITLE';
    hint.style.fontSize = '0.7em';
    hint.style.opacity = '0.7';
    hint.style.marginTop = '6px';
    this.container.appendChild(hint);

    anchor.appendChild(this.container);
  }

  /** Shows the modal populated with this run's final score info. Idempotent — safe to call again while already shown. */
  show(info: GameOverScoreInfo): void {
    this.current = info;
    this.scoreLine.textContent = `SCORE: ${info.score}`;
    this.stageLine.textContent = `STAGE: ${info.stage}`;
    this.hiLine.textContent = `HI SCORE: ${info.hiScore}`;
    this.resetShareButton();
    this.container.style.display = 'flex';
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  private buildButton(label: string, id: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = label;
    button.style.font = HUD_FONT;
    button.style.fontSize = '0.8em';
    button.style.color = HUD_ACCENT_COLOR;
    button.style.background = 'rgba(10, 14, 39, 0.7)';
    button.style.border = `1px solid ${HUD_ACCENT_COLOR}`;
    button.style.borderRadius = '4px';
    button.style.padding = '8px 14px';
    button.style.cursor = 'pointer';
    button.style.pointerEvents = 'auto';
    button.style.userSelect = 'none';
    return button;
  }

  private resetShareButton(): void {
    this.sharing = false;
    this.shareButton.disabled = false;
    this.shareButton.textContent = 'POST TO X';
  }

  private async handleShareClick(): Promise<void> {
    // Repeat-click guard (docs/plan-cloudflare-x-share.md Phase 1: "連打防
    // 止"): ignored entirely while a request is already in flight.
    if (this.sharing) return;
    this.sharing = true;
    this.shareButton.disabled = true;
    this.shareButton.textContent = 'POSTING...';

    // Popup-blocker workaround (docs/plan-cloudflare-x-share.md Phase 1):
    // open a blank tab synchronously, still inside this click handler's own
    // call stack, *before* the `await fetch` below — most browsers only
    // treat a `window.open` as gesture-triggered (and therefore exempt from
    // popup blocking) when it happens synchronously within the event
    // handler. Opening it *after* an await would no longer count and gets
    // silently blocked. We deliberately don't pass 'noopener' here (we need
    // to keep the returned reference so we can redirect it below), and null
    // out its `opener` ourselves as the equivalent hardening.
    let popup: Window | null = null;
    try {
      popup = window.open('', '_blank');
      if (popup) popup.opener = null;
    } catch {
      popup = null;
    }

    try {
      const response = await window.fetch(shareEndpoint(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          score: this.current.score,
          stage: this.current.stage,
          hi: this.current.hiScore,
        }),
      });
      if (!response.ok) {
        throw new Error(`share request failed: ${response.status}`);
      }
      const data = (await response.json()) as { id?: string };
      if (!data.id) {
        throw new Error('share response missing id');
      }

      const intentUrl = tweetIntentUrl(this.current, data.id);
      if (popup) {
        popup.location.href = intentUrl;
      } else {
        // Popup was blocked outright (e.g. it returned null) — best-effort
        // fallback, may itself be blocked since we're past the synchronous
        // gesture window at this point, but there's nothing more we can do.
        window.open(intentUrl, '_blank', 'noopener');
      }
      this.resetShareButton();
    } catch {
      // Network error or non-200 response (docs/plan-cloudflare-x-share.md
      // Phase 1): surface a retryable error on the button; never touches
      // game state/progression.
      popup?.close();
      this.sharing = false;
      this.shareButton.disabled = false;
      this.shareButton.textContent = 'FAILED - RETRY';
    }
  }
}

/** Mounts a (initially hidden) GameOverModal into `anchor` (src/main.ts passes #canvas-wrap). */
export function initGameOverModal(anchor: HTMLElement): GameOverModal {
  return new GameOverModal(anchor);
}
