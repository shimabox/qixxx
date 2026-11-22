// Impact feedback director: turns the core's claim/miss notices
// (core/feedback.ts) into short, timed effects — the hit stop length, the
// closed line's glow, the fill reveal, the "+score" popup with its praise
// word and chain count, the sparks from the closed line, flashes, shakes,
// the vanished line's shards, the SPLIT! banner, the multiplier that
// travels to the HUD, BIG CLAIM / CLOSE CALL next to a claim's score, the
// stage's title as it starts and the miss's one-line reason — plus the two
// input holds that go with them (confirm
// is not passed on right after a split, and the GAME OVER modal waits a
// moment after a game-ending miss).
//
// A pure state machine: no DOM, no Canvas, no clock, no Math.random and no
// core rng. Every effect ages one step per tick() — main.ts calls tick()
// once per fixed tick, including the ticks a hit stop freezes — so what is
// on screen depends only on the sequence of calls, never on the frame rate.
// The renderer reads the result through getFrame().
import type { ClaimFeedback, MissFeedback } from '../core/feedback';
import type { Point } from '../core/field';
import { FxParams, FxShakeSpec, ClaimPraise, classifyClaimShare, praiseForClaimShare } from './params';
import { BannerGlitch, bannerGlitch, popupBounceScale, popupChannelOffset } from './textGlitch';
import { t } from '../i18n';
import { FX_MISS_REASON_FADE_TICKS } from '../config';

export interface FxLineGlow {
  cells: readonly Point[];
  /** 1 when it starts, falling toward 0. */
  intensity: number;
  /** True for the split flash: the line is drawn extended past both ends to the field edges. */
  extendToEdges: boolean;
}

export type FxFlash =
  | { kind: 'none' }
  | { kind: 'light' | 'dark'; intensity: number; center: Point | null };

export interface FxFillReveal {
  /** Changes with every claim, so the renderer can tell a new reveal from the running one. */
  id: number;
  /** 0-1: how far out from the closed line the new cells are shown. */
  progress: number;
  line: readonly Point[];
}

export interface FxPopup {
  /** The fill reveal this popup belongs to; the renderer centers the popup on that reveal's new cells. */
  revealId: number;
  /** Fallback position (a cell) when the reveal has no new cells to center on. */
  anchor: Point;
  text: string;
  /** Extra line under the score ('x2' for a slow line), or null. */
  note: string | null;
  /** 0 when it appears, toward 1 as it rises and fades. */
  progress: number;
  /** Ticks since it appeared (0 on the tick it appears). */
  age: number;
  /** Size multiplier: the bounce it appears with (src/fx/textGlitch.ts). */
  scale: number;
  /** Colour split of the score text, relative to its font size (0 once settled, and with reduced motion). */
  channelOffset: number;
  /** NICE! / GREAT! / AWESOME! above the score for a large enough claim, or null. */
  praise: ClaimPraise | null;
  /** 'CHAIN xN' under the score from the second claim in a row, or null. */
  chain: string | null;
}

export interface FxSpark {
  /** Center, in cells (fractional while it flies). */
  x: number;
  y: number;
  /** Side of its square, in cells: 1 when it starts, falling to 0. */
  size: number;
  alpha: number;
  /** 0 when it starts (white), toward 1 (cyan). */
  progress: number;
}

export interface FxShard {
  /** The cell the shard broke from. */
  x: number;
  y: number;
  /** How far it has moved from that cell, in cells. */
  offsetX: number;
  offsetY: number;
  alpha: number;
}

export interface FxSplitBanner {
  progress: number;
  /** Ticks since it appeared (0 on the tick it appears). */
  age: number;
  /** How the text is torn this tick (src/fx/textGlitch.ts). */
  glitch: BannerGlitch;
}

export interface FxMultiplierFly {
  text: string;
  progress: number;
  /** Ticks since it set off (0 on the first tick). */
  age: number;
  /** Colour split of its glow, relative to its font size (0 once settled, and with reduced motion). */
  channelOffset: number;
}

/** The rows of a claim's popup (FxPopup's text, note, praise and chain), which do not change while it shows. */
export type FxPopupRows = Pick<FxPopup, 'text' | 'note' | 'praise' | 'chain'>;

/** BIG CLAIM / CLOSE CALL +N for one claim, next to its score. */
export interface FxClaimTags {
  /** The claim's fill reveal: the renderer puts the tags with that claim's popup (or where it would be). */
  revealId: number;
  /** Fallback position (a cell), as FxPopup.anchor. */
  anchor: Point;
  /** One line each, top to bottom: a big claim first, then a close call. */
  tags: Array<{ kind: 'big' | 'close'; text: string }>;
  /** A split's claim: no score of its own, so the tags go under SPLIT! instead. */
  split: boolean;
  /**
   * The rows of the claim's popup, or null when it shows none. Kept for the
   * tags' whole life — also after the popup is gone — so the tags are placed
   * the same way throughout and never move.
   */
  popup: FxPopupRows | null;
  /** The largest size the popup bounces to (FxPopup.scale at its peak), so the tags stay clear of it all through. */
  popupMaxScale: number;
  /** 0 when they appear, toward 1. */
  progress: number;
  age: number;
  /** Size multiplier: 1, with a short pop on their first ticks (1 throughout with reduced motion). */
  scale: number;
  /** The largest `scale` reaches (its pop's start, or 1 with reduced motion): the tags are placed for it. */
  maxScale: number;
  /** 1 while shown, fading over the last ticks (1 throughout with reduced motion). */
  alpha: number;
}

/** STAGE n and the stage's name over the field, as a stage starts. */
export interface FxStageTitle {
  heading: string;
  title: string;
  age: number;
  /** Size multiplier: a short pop as it appears (1 throughout with reduced motion). */
  scale: number;
  /** 1 while shown, fading over its last ticks (1 throughout with reduced motion). */
  alpha: number;
}

/** The one-line cause of the last miss, next to its contact. */
export interface FxMissReason {
  text: string;
  /** The contact cell (MissFeedback.position). */
  anchor: Point;
  /** 1 while shown, falling toward 0 over its last FX_MISS_REASON_FADE_TICKS. */
  alpha: number;
}

export interface FxFrame {
  /** Canvas logical-pixel offset to shake the field by. */
  shake: { x: number; y: number };
  flash: FxFlash;
  lineGlows: FxLineGlow[];
  fillReveal: FxFillReveal | null;
  popups: FxPopup[];
  shards: FxShard[];
  sparks: FxSpark[];
  /** SPLIT! banner, while shown. */
  splitBanner: FxSplitBanner | null;
  /** The next stage's multiplier travelling from the field center to the HUD, while it travels. */
  multiplierFly: FxMultiplierFly | null;
  /** After it arrives: 1 falling toward 0 while the HUD multiplier is highlighted; 0 otherwise. */
  multiplierHighlight: number;
  /** The last miss's reason, while shown (reduced motion too). */
  missReason: FxMissReason | null;
  /** BIG CLAIM / CLOSE CALL of recent claims, while shown. */
  claimTags: FxClaimTags[];
  /** The stage's title, while shown (reduced motion too, without the pop and the fade). */
  stageTitle: FxStageTitle | null;
}

interface Timed {
  age: number;
  duration: number;
}

interface GlowEffect extends Timed {
  cells: Point[];
  extendToEdges: boolean;
}

interface RevealEffect extends Timed {
  id: number;
  line: Point[];
}

interface PopupEffect extends Timed {
  revealId: number;
  anchor: Point;
  text: string;
  note: string | null;
  praise: ClaimPraise | null;
  chain: number;
}

interface ShardPiece {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  delay: number;
}

interface ShardEffect extends Timed {
  pieces: ShardPiece[];
}

interface SparkPiece {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
}

interface SparkEffect extends Timed {
  distanceCells: number;
  pieces: SparkPiece[];
}

interface FlashEffect extends Timed {
  center: Point | null;
}

interface ShakeEffect extends Timed {
  amplitudePx: number;
  axes: FxShakeSpec['axes'];
}

interface MultiplierEffect extends Timed {
  text: string;
  flyTicks: number;
}

interface MissReasonEffect extends Timed {
  text: string;
  anchor: Point;
}

interface ClaimTagsEffect extends Timed {
  revealId: number;
  anchor: Point;
  tags: FxClaimTags['tags'];
  split: boolean;
  popup: FxPopupRows | null;
}

interface StageTitleEffect extends Timed {
  heading: string;
  title: string;
}

// The stage title and the claim tags pop in from this size over POP_TICKS,
// and fade out over their last FADE_TICKS (neither with reduced motion).
const LABEL_POP_SCALE = 1.25;
const LABEL_POP_TICKS = 8;
const LABEL_FADE_TICKS = 12;

function labelMaxScale(reduced: boolean): number {
  return reduced ? 1 : Math.max(1, LABEL_POP_SCALE);
}

function labelScale(age: number, reduced: boolean): number {
  if (reduced || age >= LABEL_POP_TICKS) return 1;
  return LABEL_POP_SCALE - ((LABEL_POP_SCALE - 1) * age) / LABEL_POP_TICKS;
}

function labelAlpha(effect: Timed, reduced: boolean): number {
  if (reduced) return 1;
  return Math.min(1, (effect.duration - effect.age) / LABEL_FADE_TICKS);
}

// Shards break off one after another: the last one starts this share of the
// shard time after the first, then every shard drifts this many cells.
const SHARD_STAGGER_SHARE = 0.4;
const SHARD_DRIFT_CELLS = 1.5;

export class FxDirector {
  private readonly params: FxParams;
  private reducedMotion: boolean;
  private glows: GlowEffect[] = [];
  private reveal: RevealEffect | null = null;
  private revealSeq = 0;
  private popups: PopupEffect[] = [];
  private shards: ShardEffect | null = null;
  private sparks: SparkEffect[] = [];
  private flash: FlashEffect | null = null;
  private shake: ShakeEffect | null = null;
  private banner: Timed | null = null;
  private multiplier: MultiplierEffect | null = null;
  private missReason: MissReasonEffect | null = null;
  private claimTags: ClaimTagsEffect[] = [];
  private stageTitle: StageTitleEffect | null = null;
  private splitLockTicks = 0;
  private gameOverHoldTicks = 0;
  // Claims in a row: the director's own tick count (every tick(), stopped
  // ticks included), the tick of the last claim, and the chain so far.
  private ticks = 0;
  private lastClaimTick: number | null = null;
  private chain = 0;

  constructor(params: FxParams, options: { reducedMotion?: boolean } = {}) {
    this.params = params;
    this.reducedMotion = options.reducedMotion ?? false;
  }

  /**
   * With reduced motion on, the field never shakes, the screen never
   * flashes, and the text neither tears apart nor splits its colours;
   * everything else is unchanged.
   */
  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  isReducedMotion(): boolean {
    return this.reducedMotion;
  }

  /**
   * Starts the effects of one accepted claim and returns how long to hit
   * stop and the chain. A split replaces the stop, the shake and (in
   * main.ts) the sound with the split's own and shows no popup, but the
   * closed line still glows and sparks and the new cells are still revealed.
   *
   * The chain counts claims in a row: a claim within chainWindowTicks of the
   * previous one adds one, any other claim starts again at 1. It is shown
   * under the popup from 2 and raises the claim sound; it never affects the
   * score, the multiplier or the run.
   */
  onClaim(feedback: ClaimFeedback, context: { nextMultiplier: number }): { hitStopTicks: number; chain: number } {
    const p = this.params;
    const line = feedback.closedLine.map((c) => ({ x: c.x, y: c.y }));
    this.glows.push({ age: 0, duration: p.lineFlashTicks, cells: line, extendToEdges: false });
    const sparks = buildSparks(line, p);
    if (sparks) this.sparks.push(sparks);

    const inWindow = this.lastClaimTick !== null && this.ticks - this.lastClaimTick <= p.chainWindowTicks;
    this.chain = inWindow ? this.chain + 1 : 1;
    this.lastClaimTick = this.ticks;
    const chain = this.chain;

    // A reveal still running is simply replaced: the renderer draws every
    // claimed cell in full except the ones the current reveal is holding back.
    this.revealSeq++;
    this.reveal = { age: 0, duration: p.fillRevealTicks, id: this.revealSeq, line };

    const anchor = line.length > 0 ? { ...line[Math.floor(line.length / 2)] } : { x: 0, y: 0 };
    const share = feedback.occupancyAfter - feedback.occupancyBefore;
    // A split shows no score; any other claim scoring points shows one.
    const popup: FxPopupRows | null =
      !feedback.split && feedback.areaScore > 0
        ? {
            text: t('fx.score', feedback.areaScore),
            note: feedback.lineSpeed === 'slow' ? t('fx.slowNote') : null,
            praise: praiseForClaimShare(share, p),
            chain: chain >= 2 ? t('fx.chain', chain) : null,
          }
        : null;

    // BIG CLAIM / CLOSE CALL go with the claim's score — on a split, which
    // shows no score, under SPLIT!.
    const tags: FxClaimTags['tags'] = [];
    if (feedback.bigClaim) tags.push({ kind: 'big', text: t('fx.bigClaim') });
    if (feedback.nearMissBonus > 0) tags.push({ kind: 'close', text: t('fx.closeCall', feedback.nearMissBonus) });
    if (tags.length > 0 && p.claimTagTicks > 0) {
      this.claimTags.push({
        age: 0,
        duration: p.claimTagTicks,
        revealId: this.revealSeq,
        anchor: { ...anchor },
        tags,
        split: feedback.split,
        popup: popup && p.popupTicks > 0 ? popup : null,
      });
    }

    if (feedback.split) {
      this.glows.push({ age: 0, duration: p.splitFlashTicks, cells: line, extendToEdges: true });
      this.startShake(p.shakeLarge);
      this.banner = { age: 0, duration: p.splitBannerTicks };
      this.multiplier = {
        age: 0,
        duration: p.multiplierFlyTicks + p.multiplierHighlightTicks,
        flyTicks: p.multiplierFlyTicks,
        text: t('hud.multiplier', context.nextMultiplier),
      };
      this.splitLockTicks = Math.max(this.splitLockTicks, p.splitConfirmLockTicks);
      return { hitStopTicks: p.hitStopSplitTicks, chain };
    }

    if (popup) {
      this.popups.push({
        age: 0,
        duration: p.popupTicks,
        revealId: this.revealSeq,
        anchor,
        text: popup.text,
        note: popup.note,
        praise: popup.praise,
        chain,
      });
    }

    const size = classifyClaimShare(share, p);
    if (size === 'large') this.startShake(p.shakeSmall);
    const hitStopTicks =
      size === 'large' ? p.hitStopClaimLargeTicks : size === 'mid' ? p.hitStopClaimMidTicks : p.hitStopClaimSmallTicks;
    return { hitStopTicks, chain };
  }

  /**
   * Starts the effects of one miss and returns how long to hit stop. When
   * the miss ended the run, the GAME OVER modal is held back (and confirm is
   * not passed on) for FX_GAMEOVER_HOLD_TICKS, so the miss itself is seen.
   * A miss ends the chain.
   *
   * `reason` (the text of src/fx/missReason.ts's key) is shown next to the
   * contact for missReasonTicks — through the hit stop and after it, and with
   * reduced motion too — replacing the previous miss's; none without it.
   */
  onMiss(feedback: MissFeedback, context: { gameOver: boolean; reason?: string | null }): { hitStopTicks: number } {
    const p = this.params;
    this.endChain();
    this.missReason =
      context.reason && p.missReasonTicks > 0
        ? { age: 0, duration: p.missReasonTicks, text: context.reason, anchor: { x: feedback.position.x, y: feedback.position.y } }
        : null;
    this.flash = { age: 0, duration: p.missFlashTicks, center: { x: feedback.position.x, y: feedback.position.y } };
    this.startShake(p.shakeMedium);
    this.shards = feedback.line.length > 0 ? buildShards(feedback.line, feedback.position, p.shardTicks) : null;
    if (context.gameOver) {
      this.gameOverHoldTicks = Math.max(this.gameOverHoldTicks, p.gameOverHoldTicks);
    }
    return { hitStopTicks: p.hitStopMissTicks };
  }

  /**
   * Shows the stage's title (`heading`: STAGE n, `title`: its name) for
   * stageTitleTicks, replacing any still shown. Display only: play goes on
   * under it. Live play calls this as each stage starts; a replay never does.
   */
  onStageStart(heading: string, title: string): void {
    const p = this.params;
    this.stageTitle = p.stageTitleTicks > 0 ? { age: 0, duration: p.stageTitleTicks, heading, title } : null;
  }

  /** Ages every effect by one fixed tick. */
  tick(): void {
    this.ticks++;
    this.claimTags = this.claimTags.filter(age);
    if (this.stageTitle && !age(this.stageTitle)) this.stageTitle = null;
    this.glows = this.glows.filter(age);
    if (this.reveal && !age(this.reveal)) this.reveal = null;
    this.popups = this.popups.filter(age);
    if (this.shards && !age(this.shards)) this.shards = null;
    this.sparks = this.sparks.filter(age);
    if (this.flash && !age(this.flash)) this.flash = null;
    if (this.shake && !age(this.shake)) this.shake = null;
    if (this.banner && !age(this.banner)) this.banner = null;
    if (this.multiplier && !age(this.multiplier)) this.multiplier = null;
    if (this.missReason && !age(this.missReason)) this.missReason = null;
    if (this.splitLockTicks > 0) this.splitLockTicks--;
    if (this.gameOverHoldTicks > 0) this.gameOverHoldTicks--;
  }

  /** Drops every effect and hold and ends the chain (back to Title, entering a replay). */
  reset(): void {
    this.resetBoard();
    this.stageTitle = null;
    this.banner = null;
    this.multiplier = null;
    this.splitLockTicks = 0;
    this.gameOverHoldTicks = 0;
  }

  /**
   * Drops the effects tied to the board that is being replaced (the next
   * stage starting): glows, reveal, popups, sparks, shards, flash, shake and
   * the miss reason; the chain ends too. The SPLIT! banner and the travelling
   * multiplier keep running over the new board for the rest of their time.
   */
  resetBoard(): void {
    this.missReason = null;
    this.claimTags = [];
    this.glows = [];
    this.reveal = null;
    this.popups = [];
    this.shards = null;
    this.sparks = [];
    this.flash = null;
    this.shake = null;
    this.endChain();
  }

  /** True while confirm must not reach the core: right after a split, and while a game-ending miss is held. */
  isConfirmLocked(): boolean {
    return this.splitLockTicks > 0 || this.gameOverHoldTicks > 0;
  }

  /** True while the GAME OVER modal must wait after a game-ending miss. */
  isGameOverHeld(): boolean {
    return this.gameOverHoldTicks > 0;
  }

  isSplitBannerActive(): boolean {
    return this.banner !== null;
  }

  /** True while the next stage's multiplier is still travelling to the HUD (FxFrame.multiplierFly). */
  isMultiplierFlying(): boolean {
    return this.multiplier !== null && this.multiplier.age < this.multiplier.flyTicks;
  }

  /** Claims in a row so far; 0 after a miss, a new stage or a reset. */
  getChain(): number {
    return this.chain;
  }

  /** The current state for drawing. A fresh object every call; never mutated afterward. */
  getFrame(): FxFrame {
    const p = this.params;
    const reduced = this.reducedMotion;
    return {
      shake: this.shakeOffset(),
      flash: this.flashState(),
      lineGlows: this.glows.map((g) => ({
        cells: g.cells,
        intensity: 1 - g.age / g.duration,
        extendToEdges: g.extendToEdges,
      })),
      fillReveal: this.reveal
        ? { id: this.reveal.id, progress: Math.min(1, (this.reveal.age + 1) / this.reveal.duration), line: this.reveal.line }
        : null,
      popups: this.popups.map((pop) => ({
        revealId: pop.revealId,
        anchor: pop.anchor,
        text: pop.text,
        note: pop.note,
        progress: pop.age / pop.duration,
        age: pop.age,
        scale: popupBounceScale(pop.age, p.popupBounceScale, p.popupBounceTicks),
        channelOffset: popupChannelOffset(pop.age, reduced, p.textGlitchPopupTicks),
        praise: pop.praise,
        chain: pop.chain >= 2 ? t('fx.chain', pop.chain) : null,
      })),
      shards: this.shards ? shardFrame(this.shards) : [],
      sparks: this.sparks.flatMap(sparkFrame),
      splitBanner: this.banner
        ? {
            progress: this.banner.age / this.banner.duration,
            age: this.banner.age,
            glitch: bannerGlitch(this.banner.age, reduced, p.textGlitchBannerTicks),
          }
        : null,
      multiplierFly:
        this.multiplier && this.multiplier.age < this.multiplier.flyTicks
          ? {
              text: this.multiplier.text,
              progress: Math.min(1, (this.multiplier.age + 1) / this.multiplier.flyTicks),
              age: this.multiplier.age,
              channelOffset: popupChannelOffset(this.multiplier.age, reduced, p.textGlitchPopupTicks),
            }
          : null,
      multiplierHighlight:
        this.multiplier && this.multiplier.age >= this.multiplier.flyTicks
          ? 1 - (this.multiplier.age - this.multiplier.flyTicks) / (this.multiplier.duration - this.multiplier.flyTicks)
          : 0,
      missReason: this.missReason
        ? {
            text: this.missReason.text,
            anchor: this.missReason.anchor,
            alpha: Math.min(1, (this.missReason.duration - this.missReason.age) / FX_MISS_REASON_FADE_TICKS),
          }
        : null,
      claimTags: this.claimTags.map((c) => ({
        revealId: c.revealId,
        anchor: c.anchor,
        tags: c.tags,
        split: c.split,
        popup: c.popup,
        popupMaxScale: Math.max(1, p.popupBounceScale),
        progress: c.age / c.duration,
        age: c.age,
        scale: labelScale(c.age, reduced),
        maxScale: labelMaxScale(reduced),
        alpha: labelAlpha(c, reduced),
      })),
      stageTitle: this.stageTitle
        ? {
            heading: this.stageTitle.heading,
            title: this.stageTitle.title,
            age: this.stageTitle.age,
            scale: labelScale(this.stageTitle.age, reduced),
            alpha: labelAlpha(this.stageTitle, reduced),
          }
        : null,
    };
  }

  private endChain(): void {
    this.chain = 0;
    this.lastClaimTick = null;
  }

  private startShake(spec: FxShakeSpec): void {
    if (spec.ticks <= 0 || spec.amplitudePx <= 0) return;
    this.shake = { age: 0, duration: spec.ticks, amplitudePx: spec.amplitudePx, axes: spec.axes };
  }

  // Largest on its first tick, flipping sign every tick while shrinking
  // linearly to 0 by the end.
  private shakeOffset(): { x: number; y: number } {
    if (this.reducedMotion || !this.shake) return { x: 0, y: 0 };
    const s = this.shake;
    const magnitude = s.amplitudePx * (1 - s.age / s.duration);
    const sign = s.age % 2 === 0 ? 1 : -1;
    if (s.axes === 'y') return { x: 0, y: magnitude * sign };
    return { x: magnitude * sign, y: -magnitude * sign };
  }

  // First half light, second half dark, each fading.
  private flashState(): FxFlash {
    if (this.reducedMotion || !this.flash) return { kind: 'none' };
    const f = this.flash;
    const lightTicks = Math.ceil(f.duration / 2);
    if (f.age < lightTicks) {
      return { kind: 'light', intensity: 1 - f.age / (lightTicks * 2), center: f.center };
    }
    const darkTicks = f.duration - lightTicks;
    return { kind: 'dark', intensity: 0.6 * (1 - (f.age - lightTicks) / darkTicks), center: f.center };
  }
}

/** Ages `t` by one tick; false once it has run its course. */
function age(t: Timed): boolean {
  t.age++;
  return t.age < t.duration;
}

/** Unit vector across the line at `line[i]` (perpendicular to the line there). */
function acrossLine(line: readonly Point[], i: number): { x: number; y: number } {
  const prev = line[Math.max(0, i - 1)];
  const next = line[Math.min(line.length - 1, i + 1)];
  let tx = next.x - prev.x;
  let ty = next.y - prev.y;
  if (tx === 0 && ty === 0) ty = 1;
  const len = Math.hypot(tx, ty);
  return { x: -ty / len, y: tx / len };
}

/**
 * The line's cells as shards: the cell nearest the contact breaks first and
 * the break runs along the line from there (toward the root, and toward the
 * tip if the contact was mid-line). Each shard drifts across the line,
 * alternating sides.
 */
function buildShards(line: readonly Point[], contact: Point, duration: number): ShardEffect {
  let contactIndex = 0;
  let best = Number.POSITIVE_INFINITY;
  line.forEach((c, i) => {
    const d = Math.abs(c.x - contact.x) + Math.abs(c.y - contact.y);
    if (d < best) {
      best = d;
      contactIndex = i;
    }
  });
  const maxRank = Math.max(contactIndex, line.length - 1 - contactIndex);
  const maxDelay = Math.floor(duration * SHARD_STAGGER_SHARE);
  const pieces = line.map((c, i) => {
    const across = acrossLine(line, i);
    const side = i % 2 === 0 ? 1 : -1;
    const rank = Math.abs(i - contactIndex);
    return {
      x: c.x,
      y: c.y,
      dirX: across.x * side,
      dirY: across.y * side,
      delay: maxRank > 0 ? Math.round((rank / maxRank) * maxDelay) : 0,
    };
  });
  return { age: 0, duration, pieces };
}

function shardFrame(effect: ShardEffect): FxShard[] {
  return effect.pieces.map((piece) => {
    const span = Math.max(1, effect.duration - piece.delay);
    const t = Math.min(1, Math.max(0, (effect.age - piece.delay) / span));
    return {
      x: piece.x,
      y: piece.y,
      offsetX: piece.dirX * SHARD_DRIFT_CELLS * t,
      offsetY: piece.dirY * SHARD_DRIFT_CELLS * t,
      alpha: 1 - t,
    };
  });
}

/**
 * Sparks from the closed line: up to sparkMax cells picked at even steps
 * along it, one spark each, flying across the line — one side, then the
 * other, by the spark's place in the line. Only the line decides them.
 */
function buildSparks(line: readonly Point[], p: FxParams): SparkEffect | null {
  const count = Math.min(line.length, Math.max(0, Math.floor(p.sparkMax)));
  if (count === 0 || p.sparkTicks <= 0) return null;
  const pieces: SparkPiece[] = [];
  for (let k = 0; k < count; k++) {
    const i = Math.floor(((k + 0.5) * line.length) / count);
    const across = acrossLine(line, i);
    const side = k % 2 === 0 ? 1 : -1;
    pieces.push({ x: line[i].x, y: line[i].y, dirX: across.x * side, dirY: across.y * side });
  }
  return { age: 0, duration: p.sparkTicks, distanceCells: p.sparkDistanceCells, pieces };
}

function sparkFrame(effect: SparkEffect): FxSpark[] {
  const t = effect.age / effect.duration;
  // Fast at first, slowing as it fades.
  const travel = effect.distanceCells * (1 - (1 - t) * (1 - t));
  return effect.pieces.map((piece) => ({
    x: piece.x + 0.5 + piece.dirX * travel,
    y: piece.y + 0.5 + piece.dirY * travel,
    size: 1 - t,
    alpha: 1 - t,
    progress: t,
  }));
}
