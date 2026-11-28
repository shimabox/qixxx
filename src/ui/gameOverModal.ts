// GAME OVER modal (docs/plan-cloudflare-x-share.md Phase 1): shown only
// while `session.getStatus() === 'gameover'`, layered on top of #screen
// inside #canvas-wrap (see src/main.ts's getScreenElement()/getCanvasWrapElement()),
// centered over the field exactly like #screen already is. Displays the
// run's SCORE (counting up from 0, see src/gameOverResult.ts) / STAGE /
// HI SCORE, then the run's highlight and NEW RECORD (when the run beat the
// best it started from) or how far it fell short, and offers RETRY (the next
// run, at once), TITLE and POST TO X (share). The share always posts the
// final score.
//
// DOM-only module — src/core/ is never imported here (docs/plan.md's "core
// purity" invariant), matching input/keyboard.ts and input/touch.ts's
// existing DOM-touching exemption.
import {
  HUD_FONT,
  HUD_TEXT_COLOR,
  HUD_ACCENT_COLOR,
  HUD_TIME_WARNING_COLOR,
  COLOR_FX_NEON_CYAN,
  GAMEOVER_SPARK_COUNT,
  GAMEOVER_SPARK_DISTANCE_PX,
} from '../config';
import { t, type MessageKey } from '../i18n';
import { applySentenceFont } from './sentenceFont';
import {
  gameOverHighlightText,
  type GameOverBestLine,
  type GameOverHighlight,
  type GameOverResultView,
} from '../gameOverResult';

export interface GameOverScoreInfo {
  score: number;
  stage: number;
  hiScore: number;
  /**
   * Why this run ended (docs/plans/2026-08-13-time-limit-mode — mirrors
   * GameSession.getGameOverReason()): 'time' shows an extra "TIME UP!" line
   * beneath the GAME OVER heading so a time-budget-expired run reads
   * distinctly from an ordinary life-loss one. Omitted/undefined and 'life'
   * both render identically (no extra line).
   */
  reason?: 'life' | 'time';
  /**
   * The run's highlight line under the score lines (src/gameOverResult.ts),
   * or null for none. Its place is kept from the start; it appears when
   * renderResult() says so.
   */
  highlight?: GameOverHighlight | null;
  /**
   * `NEW RECORD +<n>` or `<n> TO HI SCORE`, under the highlight, in one
   * place; null for neither (a run that never saves a high score — a seeded
   * run, a run with debug overrides — or a first run with no points). Its
   * place is kept from the start; it appears when renderResult() says so.
   */
  bestLine?: GameOverBestLine | null;
  /** POST TO X is offered (the default); false hides it — an EASY run is not shared. */
  share?: boolean;
  /** The run was an EASY one: an EASY tag beside the GAME OVER heading. */
  easy?: boolean;
  /**
   * Suggest EASY (src/playLog/summary.ts's suggestsEasy()) in the highlight's
   * place, which is then not shown. Its place is kept from the start; it
   * appears when renderResult() says so.
   */
  easyPrompt?: boolean;
}

/** How tightly the modal is packed (GameOverModal.setDensity()). */
export type GameOverModalDensity = 'normal' | 'compact' | 'tiny';

/** What holds the keyboard and the field for the ranking offer (GameOverModal.setSubmissionHold()). */
export type SubmissionHold = 'none' | 'waiting' | 'panel';

/** What the modal's buttons ask main.ts for; main.ts passes it on as confirm until the run leaves GAME OVER. */
export interface GameOverModalActions {
  /** RETRY: the next run, straight to stage 1. */
  onRetry: () => void;
  /** TITLE: back to the Title screen. */
  onTitle: () => void;
}

const HINT_RETRY: MessageKey = 'gameOver.hintRetry';
// While the ranking submission panel is open and holds the keyboard and the
// field (src/ui/ranking.ts's isSubmissionBlockingRetry()).
const HINT_SUBMISSION: MessageKey = 'gameOver.hintSubmission';
// Every button's tap target is at least this tall.
const BUTTON_MIN_HEIGHT_PX = 44;

/** 3-digit comma grouping for the tweet text (e.g. 45600 -> "45,600"). */
function formatScoreWithCommas(value: number): string {
  return value.toLocaleString('en-US');
}

/** Phase 2's Cloudflare Function that issues a share ID: `${BASE_URL}share` (= /share). */
function shareEndpoint(): string {
  return `${import.meta.env.BASE_URL}share`;
}

/** The `/s?id=...` page Phase 2 serves the OG card for. */
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
  private readonly heading: HTMLDivElement;
  private readonly easyTag: HTMLSpanElement;
  private readonly reasonLine: HTMLDivElement;
  private readonly newRecordLine: HTMLDivElement;
  private readonly scoreLine: HTMLDivElement;
  private readonly scoreValue: HTMLSpanElement;
  private readonly highlightLine: HTMLDivElement;
  private readonly promptLine: HTMLDivElement;
  private readonly promptText: HTMLSpanElement;
  private readonly bestSlot: HTMLDivElement;
  private readonly toBestLine: HTMLDivElement;
  private readonly sparkLayer: HTMLDivElement;
  private readonly sparks: HTMLSpanElement[] = [];
  private lastResultKey = '';
  private readonly stageLine: HTMLDivElement;
  private readonly hiLine: HTMLDivElement;
  // SCORE / STAGE / HI: laid out as three lines (display: contents), or as
  // two (SCORE and STAGE together) in the tiny density.
  private readonly scoreRow: HTMLDivElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly lowerRow: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly shareButton: HTMLButtonElement;
  private current: GameOverScoreInfo = { score: 0, stage: 1, hiScore: 0 };
  private sharing = false;
  // Counts show() calls: a share answer that comes back after another run's
  // GAME OVER has been shown leaves that run's button alone.
  private shownCount = 0;
  private density: GameOverModalDensity | null = null;

  constructor(anchor: HTMLElement, actions: GameOverModalActions) {
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
    this.container.style.boxSizing = 'border-box';
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

    this.heading = document.createElement('div');
    this.heading.textContent = t('gameOver.heading');
    this.heading.style.fontSize = '1.3em';
    this.heading.style.fontWeight = 'bold';
    this.heading.style.whiteSpace = 'nowrap';
    // The EASY tag: small and boxed after the heading, on its line — its
    // line height 0 keeps the heading's line as tall as without it.
    this.easyTag = document.createElement('span');
    this.easyTag.id = 'gameover-easy';
    this.easyTag.style.display = 'none';
    this.easyTag.style.marginLeft = '0.8em';
    this.easyTag.style.padding = '0 0.3em';
    this.easyTag.style.fontSize = '0.6em';
    this.easyTag.style.lineHeight = '0';
    this.easyTag.style.verticalAlign = 'middle';
    this.easyTag.style.color = HUD_ACCENT_COLOR;
    this.easyTag.style.outline = `1px solid ${HUD_ACCENT_COLOR}`;
    this.easyTag.style.outlineOffset = '1px';
    this.heading.appendChild(this.easyTag);
    this.container.appendChild(this.heading);

    // TIME UP! (docs/plans/2026-08-13-time-limit-mode): hidden by default,
    // shown only for a `reason: 'time'` gameover (see show() below).
    this.reasonLine = document.createElement('div');
    this.reasonLine.id = 'gameover-reason';
    this.reasonLine.style.fontSize = '1em';
    this.reasonLine.style.fontWeight = 'bold';
    this.reasonLine.style.color = HUD_TIME_WARNING_COLOR;
    this.reasonLine.style.display = 'none';
    this.container.appendChild(this.reasonLine);

    this.scoreRow = document.createElement('div');
    this.scoreLine = document.createElement('div');
    this.scoreLine.id = 'gameover-score';
    // SCORE: the counting text, at least as wide as the final one from the
    // start (the line is monospace, so that is its length in ch), so the
    // modal never changes width while it counts. The pop is a transform: it
    // never moves anything else either.
    this.scoreValue = document.createElement('span');
    this.scoreValue.id = 'gameover-score-value';
    this.scoreValue.style.display = 'inline-block';
    this.scoreValue.style.whiteSpace = 'pre';
    this.scoreValue.style.fontVariantNumeric = 'tabular-nums';
    this.scoreValue.style.transformOrigin = 'center';
    this.scoreLine.appendChild(this.scoreValue);
    this.stageLine = document.createElement('div');
    this.hiLine = document.createElement('div');
    // Spaced apart when they share one line (the tiny density).
    this.scoreLine.style.marginRight = '0.6em';
    this.stageLine.style.marginRight = '0.6em';
    this.scoreRow.appendChild(this.scoreLine);
    this.scoreRow.appendChild(this.stageLine);
    this.scoreRow.appendChild(this.hiLine);
    this.container.appendChild(this.scoreRow);

    // The run's highlight (SPLIT ×n, BEST CLAIM n%, REACHED STAGE n), then
    // NEW RECORD +<n> or <n> TO HI SCORE in one place under it. A line the run
    // will show keeps its place (visibility: hidden) from the moment the modal
    // appears, so the buttons never move when it does.
    this.highlightLine = document.createElement('div');
    this.highlightLine.id = 'gameover-highlight';
    this.highlightLine.style.fontWeight = 'bold';
    this.highlightLine.style.color = HUD_ACCENT_COLOR;
    this.highlightLine.style.display = 'none';
    this.container.appendChild(this.highlightLine);

    // The EASY suggestion, after a run of early GAME OVERs: shown instead of
    // the highlight, in its place and at its size and timing, on one line.
    // A sentence, so the Japanese page gives its text the Japanese font —
    // in a span of line height 0, so that font never makes the line taller
    // than the highlight's.
    this.promptLine = document.createElement('div');
    this.promptLine.id = 'gameover-easy-prompt';
    this.promptLine.style.fontWeight = 'bold';
    this.promptLine.style.color = HUD_ACCENT_COLOR;
    this.promptLine.style.whiteSpace = 'nowrap';
    this.promptLine.style.display = 'none';
    this.promptText = document.createElement('span');
    this.promptText.id = 'gameover-easy-prompt-text';
    this.promptText.style.lineHeight = '0';
    applySentenceFont(this.promptText);
    this.promptLine.appendChild(this.promptText);
    this.container.appendChild(this.promptLine);

    this.bestSlot = document.createElement('div');
    this.bestSlot.style.position = 'relative';
    this.bestSlot.style.display = 'none';
    this.newRecordLine = document.createElement('div');
    this.newRecordLine.id = 'gameover-new-record';
    this.newRecordLine.style.fontSize = '1.25em';
    this.newRecordLine.style.fontWeight = 'bold';
    this.newRecordLine.style.color = COLOR_FX_NEON_CYAN;
    this.newRecordLine.style.textShadow = `0 0 8px ${COLOR_FX_NEON_CYAN}, 0 0 16px ${COLOR_FX_NEON_CYAN}`;
    this.newRecordLine.style.transformOrigin = 'center';
    this.newRecordLine.style.display = 'none';
    this.bestSlot.appendChild(this.newRecordLine);
    this.toBestLine = document.createElement('div');
    this.toBestLine.id = 'gameover-to-best';
    this.toBestLine.style.display = 'none';
    this.bestSlot.appendChild(this.toBestLine);
    // The sparks: small dots flying out from the line's middle at fixed
    // angles, never taking a tap.
    this.sparkLayer = document.createElement('div');
    this.sparkLayer.style.position = 'absolute';
    this.sparkLayer.style.left = '50%';
    this.sparkLayer.style.top = '50%';
    this.sparkLayer.style.width = '0';
    this.sparkLayer.style.height = '0';
    this.sparkLayer.style.pointerEvents = 'none';
    this.sparkLayer.style.display = 'none';
    for (let i = 0; i < GAMEOVER_SPARK_COUNT; i++) {
      const spark = document.createElement('span');
      spark.style.position = 'absolute';
      spark.style.left = '-2px';
      spark.style.top = '-2px';
      spark.style.width = '4px';
      spark.style.height = '4px';
      spark.style.borderRadius = '2px';
      spark.style.background = COLOR_FX_NEON_CYAN;
      spark.style.boxShadow = `0 0 4px ${COLOR_FX_NEON_CYAN}`;
      this.sparks.push(spark);
      this.sparkLayer.appendChild(spark);
    }
    this.bestSlot.appendChild(this.sparkLayer);
    this.container.appendChild(this.bestSlot);

    // Two rows: RETRY alone across the whole modal (the main action, filled),
    // then TITLE and POST TO X. The buttons ask main.ts for the transition
    // through callbacks rather than a synthetic key, so they keep working
    // while the keyboard and the field are held (see src/fx/liveTick.ts's
    // GameOverConfirmGate).
    const retryButton = this.buildButton(t('gameOver.retry'), 'gameover-retry-button');
    this.retryButton = retryButton;
    retryButton.style.width = '100%';
    retryButton.style.fontSize = '1em';
    retryButton.style.fontWeight = 'bold';
    retryButton.style.color = '#0a0e27';
    retryButton.style.background = HUD_ACCENT_COLOR;
    retryButton.style.textShadow = 'none';
    retryButton.style.boxShadow = `0 0 10px ${HUD_ACCENT_COLOR}`;
    retryButton.addEventListener('click', (event) => {
      actions.onRetry();
      (event.currentTarget as HTMLButtonElement).blur();
    });
    this.container.appendChild(retryButton);

    this.lowerRow = document.createElement('div');
    this.lowerRow.style.display = 'flex';
    this.lowerRow.style.width = '100%';

    const backButton = this.buildButton(t('gameOver.title'), 'gameover-back-button');
    backButton.style.flex = '1 1 0';
    backButton.addEventListener('click', (event) => {
      actions.onTitle();
      (event.currentTarget as HTMLButtonElement).blur();
    });

    this.shareButton = this.buildButton(t('gameOver.share'), 'gameover-share-button');
    this.shareButton.style.flex = '1 1 0';
    this.shareButton.addEventListener('click', () => void this.handleShareClick());

    this.lowerRow.appendChild(backButton);
    this.lowerRow.appendChild(this.shareButton);
    this.container.appendChild(this.lowerRow);

    // Folded in here (rather than left in #screen behind this opaque modal)
    // so the two screens never fight over the same centered position with
    // duplicate/hidden text — see src/main.ts's screenText() 'gameover'
    // branch, which returns '' whenever this modal is the one covering
    // that message.
    this.hint = document.createElement('div');
    this.hint.id = 'gameover-hint';
    this.hint.textContent = t(HINT_RETRY);
    this.hint.style.fontSize = '0.7em';
    this.hint.style.opacity = '0.7';
    // A sentence: the device's Japanese font in Japanese.
    applySentenceFont(this.hint);
    this.container.appendChild(this.hint);

    this.setDensity('normal');
    anchor.appendChild(this.container);
  }

  /** Shows the modal populated with this run's final score info. Idempotent — safe to call again while already shown. */
  show(info: GameOverScoreInfo): void {
    this.current = info;
    this.shownCount++;
    // The final score sizes the line; the shown one starts at the final value
    // until renderResult() says otherwise.
    const finalText = t('gameOver.score', info.score);
    this.scoreValue.style.minWidth = `${finalText.length}ch`;
    this.scoreValue.textContent = finalText;
    this.scoreValue.style.transform = '';
    this.stageLine.textContent = t('gameOver.stage', info.stage);
    this.hiLine.textContent = t('gameOver.hiScore', info.hiScore);
    if (info.reason === 'time') {
      this.reasonLine.textContent = t('gameOver.timeUp');
      this.reasonLine.style.display = 'block';
    } else {
      this.reasonLine.textContent = '';
      this.reasonLine.style.display = 'none';
    }
    // The lines this run will show keep their place, hidden, from now on.
    const prompt = info.easyPrompt === true;
    const highlight = prompt ? null : (info.highlight ?? null);
    this.highlightLine.textContent = highlight ? gameOverHighlightText(highlight) : '';
    this.highlightLine.style.display = highlight ? 'block' : 'none';
    this.highlightLine.style.visibility = 'hidden';
    this.promptText.textContent = prompt ? t('gameOver.easyPrompt') : '';
    this.promptLine.style.display = prompt ? 'block' : 'none';
    this.promptLine.style.visibility = 'hidden';
    const best = info.bestLine ?? null;
    this.bestSlot.style.display = best ? 'block' : 'none';
    this.newRecordLine.textContent = best?.kind === 'new-record' ? t('gameOver.newRecord', best.delta) : '';
    this.newRecordLine.style.display = best?.kind === 'new-record' ? 'block' : 'none';
    this.newRecordLine.style.visibility = 'hidden';
    this.newRecordLine.style.transform = '';
    this.toBestLine.textContent = best?.kind === 'to-best' ? t('gameOver.toBest', best.gap) : '';
    this.toBestLine.style.display = best?.kind === 'to-best' ? 'block' : 'none';
    this.toBestLine.style.visibility = 'hidden';
    // Near the best: lit like NEW RECORD; otherwise as plain as HI SCORE:.
    const near = best?.kind === 'to-best' && best.near;
    this.toBestLine.dataset.near = near ? 'true' : 'false';
    this.toBestLine.style.color = near ? COLOR_FX_NEON_CYAN : '';
    this.toBestLine.style.fontWeight = near ? 'bold' : '';
    this.toBestLine.style.textShadow = near ? `0 0 8px ${COLOR_FX_NEON_CYAN}, 0 0 16px ${COLOR_FX_NEON_CYAN}` : '';
    this.sparkLayer.style.display = 'none';
    this.lastResultKey = '';
    this.setSubmissionHold('none');
    this.resetShareButton();
    this.shareButton.style.display = info.share === false ? 'none' : '';
    // Its text only while shown, so the modal's text reads as before otherwise.
    this.easyTag.textContent = info.easy ? t('difficulty.easy') : '';
    this.easyTag.style.display = info.easy ? 'inline' : 'none';
    this.container.style.display = 'flex';
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  /**
   * Draws the GAME OVER result as it is now (src/gameOverResult.ts): the
   * counting score and its pop, the highlight and the best line once they
   * are due, NEW RECORD's pop and its sparks. A no-op unless something
   * changed.
   */
  renderResult(view: GameOverResultView): void {
    const key = [
      view.score,
      view.popScale.toFixed(3),
      view.highlightShown,
      view.promptShown,
      view.bestLineShown,
      view.recordPopScale.toFixed(3),
      view.sparkProgress === null ? '-' : view.sparkProgress.toFixed(3),
    ].join('|');
    if (key === this.lastResultKey) return;
    this.lastResultKey = key;
    this.scoreValue.textContent = t('gameOver.score', view.score);
    this.scoreValue.style.transform = view.popScale === 1 ? '' : `scale(${view.popScale})`;
    this.highlightLine.style.visibility = view.highlightShown ? 'visible' : 'hidden';
    this.promptLine.style.visibility = view.promptShown ? 'visible' : 'hidden';
    const bestVisibility = view.bestLineShown ? 'visible' : 'hidden';
    this.newRecordLine.style.visibility = bestVisibility;
    this.toBestLine.style.visibility = bestVisibility;
    this.newRecordLine.style.transform = view.recordPopScale === 1 ? '' : `scale(${view.recordPopScale})`;
    const progress = view.sparkProgress;
    this.sparkLayer.style.display = progress === null ? 'none' : 'block';
    if (progress !== null) {
      // Wider than tall, so the sparks stay around the line.
      const out = 1 - Math.pow(1 - progress, 2);
      this.sparks.forEach((spark, i) => {
        const angle = (i / this.sparks.length) * Math.PI * 2;
        const x = Math.cos(angle) * GAMEOVER_SPARK_DISTANCE_PX * 2 * out;
        const y = Math.sin(angle) * GAMEOVER_SPARK_DISTANCE_PX * 0.5 * out;
        spark.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        spark.style.opacity = (1 - progress).toFixed(3);
      });
    }
  }

  /**
   * The hint for what the keyboard and the field do now:
   * - 'none': they retry.
   * - 'waiting': nothing, until the submission panel the ranking reply
   *   decided on opens. The hint keeps the retry text, so the modal keeps
   *   its width and its buttons their place and size, but is not seen, so
   *   it never asks for a key that does nothing yet.
   * - 'panel': the submission panel is open; they wait for it to be closed.
   */
  setSubmissionHold(hold: SubmissionHold): void {
    const text = t(hold === 'panel' ? HINT_SUBMISSION : HINT_RETRY);
    if (this.hint.textContent !== text) this.hint.textContent = text;
    const visibility = hold === 'waiting' ? 'hidden' : 'visible';
    if (this.hint.style.visibility !== visibility) this.hint.style.visibility = visibility;
  }

  /**
   * How tightly the modal is packed, from the field's on-screen size
   * (src/main.ts decides), so the whole modal — TIME UP! and NEW RECORD
   * included — stays on the field:
   * - 'normal': the roomy layout.
   * - 'compact': tighter padding and line spacing.
   * - 'tiny' (a phone held sideways, where the field is only ~150px tall):
   *   smaller text, SCORE and STAGE on one line, and RETRY moves into the
   *   button row beside TITLE and POST TO X — two rows of 44px buttons cannot
   *   fit at all.
   * The buttons keep their 44px tap height in every density.
   */
  setDensity(density: GameOverModalDensity): void {
    if (density === this.density) return;
    this.density = density;
    const roomy = density === 'normal';
    const tiny = density === 'tiny';
    this.container.dataset.density = density;
    this.container.style.gap = roomy ? '6px' : '1px';
    this.container.style.padding = roomy ? '20px 28px' : tiny ? '4px 6px' : '6px 10px';
    // Explicit values, never '': clearing a longhand set by the `font`
    // shorthand would inherit #canvas-wrap's line-height 0.
    this.container.style.lineHeight = roomy ? 'normal' : '1.1';
    this.container.style.fontSize = roomy ? '16px' : tiny ? '10px' : '13px';
    this.container.style.width = roomy ? '' : 'max-content';
    this.heading.style.marginBottom = roomy ? '4px' : '0';
    this.reasonLine.style.marginBottom = roomy ? '4px' : '0';
    this.lowerRow.style.gap = roomy ? '10px' : tiny ? '4px' : '6px';
    for (const button of this.buttons) {
      button.style.marginTop = roomy ? '6px' : tiny ? '2px' : '3px';
      button.style.padding = tiny ? '4px 6px' : '8px 14px';
    }
    this.hint.style.marginTop = roomy ? '6px' : '2px';
    // SCORE and STAGE share a line in the tiny density; HI SCORE keeps its own.
    for (const line of [this.scoreLine, this.stageLine]) line.style.display = tiny ? 'inline' : 'block';
    this.scoreRow.style.display = tiny ? 'block' : 'contents';
    if (tiny) {
      this.retryButton.style.width = '';
      this.retryButton.style.flex = '1 1 0';
      this.lowerRow.insertBefore(this.retryButton, this.lowerRow.firstChild);
    } else {
      this.retryButton.style.flex = '';
      this.retryButton.style.width = '100%';
      this.container.insertBefore(this.retryButton, this.lowerRow);
    }
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
    button.style.minHeight = `${BUTTON_MIN_HEIGHT_PX}px`;
    button.style.boxSizing = 'border-box';
    button.style.whiteSpace = 'nowrap';
    button.style.cursor = 'pointer';
    button.style.pointerEvents = 'auto';
    button.style.userSelect = 'none';
    this.buttons.push(button);
    return button;
  }

  private resetShareButton(): void {
    this.sharing = false;
    this.shareButton.disabled = false;
    this.shareButton.textContent = t('gameOver.share');
  }

  private async handleShareClick(): Promise<void> {
    // Repeat-click guard (docs/plan-cloudflare-x-share.md Phase 1: "連打防
    // 止"): ignored entirely while a request is already in flight.
    if (this.sharing) return;
    // The run shown at the press is the one shared — the request and the
    // post text alike — even if the modal shows another run by the time the
    // answer comes back (TITLE, a new run and its GAME OVER in between).
    const run = { score: this.current.score, stage: this.current.stage, hiScore: this.current.hiScore };
    const shownAtPress = this.shownCount;
    this.sharing = true;
    this.shareButton.disabled = true;
    this.shareButton.textContent = t('gameOver.sharing');

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
          score: run.score,
          stage: run.stage,
          // /share takes a high score no lower than the score. The modal's
          // high score leaves out a debug-tuned run's points, so such a run
          // past it shares its own score as the high score.
          hi: Math.max(run.hiScore, run.score),
        }),
      });
      if (!response.ok) {
        throw new Error(`share request failed: ${response.status}`);
      }
      const data = (await response.json()) as { id?: string };
      if (!data.id) {
        throw new Error('share response missing id');
      }

      const intentUrl = tweetIntentUrl(run, data.id);
      if (popup) {
        popup.location.href = intentUrl;
      } else {
        // Popup was blocked outright (e.g. it returned null) — best-effort
        // fallback, may itself be blocked since we're past the synchronous
        // gesture window at this point, but there's nothing more we can do.
        window.open(intentUrl, '_blank', 'noopener');
      }
      // The button now belongs to another run's GAME OVER (show() reset it).
      if (this.shownCount !== shownAtPress) return;
      this.resetShareButton();
    } catch {
      // Network error or non-200 response (docs/plan-cloudflare-x-share.md
      // Phase 1): surface a retryable error on the button; never touches
      // game state/progression.
      popup?.close();
      if (this.shownCount !== shownAtPress) return;
      this.sharing = false;
      this.shareButton.disabled = false;
      this.shareButton.textContent = t('gameOver.shareFailed');
    }
  }
}

/** Mounts a (initially hidden) GameOverModal into `anchor` (src/main.ts passes #canvas-wrap). */
export function initGameOverModal(anchor: HTMLElement, actions: GameOverModalActions): GameOverModal {
  return new GameOverModal(anchor, actions);
}
