// Impact feedback director: turns the core's claim/miss notices
// (core/feedback.ts) into short, timed effects — the hit stop length, the
// closed line's glow, the fill reveal, the "+score" popup, flashes, shakes,
// the vanished line's shards, the SPLIT! banner and the multiplier that
// travels to the HUD — plus the two input holds that go with them (confirm
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
import { FxParams, FxShakeSpec, classifyClaimShare } from './params';

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

export interface FxFrame {
  /** Canvas logical-pixel offset to shake the field by. */
  shake: { x: number; y: number };
  flash: FxFlash;
  lineGlows: FxLineGlow[];
  fillReveal: FxFillReveal | null;
  popups: FxPopup[];
  shards: FxShard[];
  /** SPLIT! banner, while shown. */
  splitBanner: { progress: number } | null;
  /** The next stage's multiplier travelling from the field center to the HUD, while it travels. */
  multiplierFly: { text: string; progress: number } | null;
  /** After it arrives: 1 falling toward 0 while the HUD multiplier is highlighted; 0 otherwise. */
  multiplierHighlight: number;
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
  private flash: FlashEffect | null = null;
  private shake: ShakeEffect | null = null;
  private banner: Timed | null = null;
  private multiplier: MultiplierEffect | null = null;
  private splitLockTicks = 0;
  private gameOverHoldTicks = 0;

  constructor(params: FxParams, options: { reducedMotion?: boolean } = {}) {
    this.params = params;
    this.reducedMotion = options.reducedMotion ?? false;
  }

  /** With reduced motion on, the field never shakes and the screen never flashes; everything else is unchanged. */
  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  isReducedMotion(): boolean {
    return this.reducedMotion;
  }

  /**
   * Starts the effects of one accepted claim and returns how long to hit
   * stop. A split replaces the stop, the shake and (in main.ts) the sound
   * with the split's own and shows no popup, but the closed line still glows
   * and the new cells are still revealed.
   */
  onClaim(feedback: ClaimFeedback, context: { nextMultiplier: number }): { hitStopTicks: number } {
    const p = this.params;
    const line = feedback.closedLine.map((c) => ({ x: c.x, y: c.y }));
    this.glows.push({ age: 0, duration: p.lineFlashTicks, cells: line, extendToEdges: false });

    // A reveal still running is simply replaced: the renderer draws every
    // claimed cell in full except the ones the current reveal is holding back.
    this.revealSeq++;
    this.reveal = { age: 0, duration: p.fillRevealTicks, id: this.revealSeq, line };

    if (feedback.split) {
      this.glows.push({ age: 0, duration: p.splitFlashTicks, cells: line, extendToEdges: true });
      this.startShake(p.shakeLarge);
      this.banner = { age: 0, duration: p.splitBannerTicks };
      this.multiplier = {
        age: 0,
        duration: p.multiplierFlyTicks + p.multiplierHighlightTicks,
        flyTicks: p.multiplierFlyTicks,
        text: `x${context.nextMultiplier}`,
      };
      this.splitLockTicks = Math.max(this.splitLockTicks, p.splitConfirmLockTicks);
      return { hitStopTicks: p.hitStopSplitTicks };
    }

    if (feedback.areaScore > 0) {
      this.popups.push({
        age: 0,
        duration: p.popupTicks,
        revealId: this.revealSeq,
        anchor: line.length > 0 ? { ...line[Math.floor(line.length / 2)] } : { x: 0, y: 0 },
        text: `+${feedback.areaScore}`,
        note: feedback.lineSpeed === 'slow' ? 'x2' : null,
      });
    }

    const size = classifyClaimShare(feedback.occupancyAfter - feedback.occupancyBefore, p);
    if (size === 'large') this.startShake(p.shakeSmall);
    const hitStopTicks =
      size === 'large' ? p.hitStopClaimLargeTicks : size === 'mid' ? p.hitStopClaimMidTicks : p.hitStopClaimSmallTicks;
    return { hitStopTicks };
  }

  /**
   * Starts the effects of one miss and returns how long to hit stop. When
   * the miss ended the run, the GAME OVER modal is held back (and confirm is
   * not passed on) for FX_GAMEOVER_HOLD_TICKS, so the miss itself is seen.
   */
  onMiss(feedback: MissFeedback, context: { gameOver: boolean }): { hitStopTicks: number } {
    const p = this.params;
    this.flash = { age: 0, duration: p.missFlashTicks, center: { x: feedback.position.x, y: feedback.position.y } };
    this.startShake(p.shakeMedium);
    this.shards = feedback.line.length > 0 ? buildShards(feedback.line, feedback.position, p.shardTicks) : null;
    if (context.gameOver) {
      this.gameOverHoldTicks = Math.max(this.gameOverHoldTicks, p.gameOverHoldTicks);
    }
    return { hitStopTicks: p.hitStopMissTicks };
  }

  /** Ages every effect by one fixed tick. */
  tick(): void {
    this.glows = this.glows.filter(age);
    if (this.reveal && !age(this.reveal)) this.reveal = null;
    this.popups = this.popups.filter(age);
    if (this.shards && !age(this.shards)) this.shards = null;
    if (this.flash && !age(this.flash)) this.flash = null;
    if (this.shake && !age(this.shake)) this.shake = null;
    if (this.banner && !age(this.banner)) this.banner = null;
    if (this.multiplier && !age(this.multiplier)) this.multiplier = null;
    if (this.splitLockTicks > 0) this.splitLockTicks--;
    if (this.gameOverHoldTicks > 0) this.gameOverHoldTicks--;
  }

  /** Drops every effect and hold (back to Title, entering a replay). */
  reset(): void {
    this.resetBoard();
    this.banner = null;
    this.multiplier = null;
    this.splitLockTicks = 0;
    this.gameOverHoldTicks = 0;
  }

  /**
   * Drops the effects tied to the board that is being replaced (the next
   * stage starting): glows, reveal, popups, shards, flash and shake. The
   * SPLIT! banner and the travelling multiplier keep running over the new
   * board for the rest of their time.
   */
  resetBoard(): void {
    this.glows = [];
    this.reveal = null;
    this.popups = [];
    this.shards = null;
    this.flash = null;
    this.shake = null;
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

  /** The current state for drawing. A fresh object every call; never mutated afterward. */
  getFrame(): FxFrame {
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
      })),
      shards: this.shards ? shardFrame(this.shards) : [],
      splitBanner: this.banner ? { progress: this.banner.age / this.banner.duration } : null,
      multiplierFly:
        this.multiplier && this.multiplier.age < this.multiplier.flyTicks
          ? { text: this.multiplier.text, progress: Math.min(1, (this.multiplier.age + 1) / this.multiplier.flyTicks) }
          : null,
      multiplierHighlight:
        this.multiplier && this.multiplier.age >= this.multiplier.flyTicks
          ? 1 - (this.multiplier.age - this.multiplier.flyTicks) / (this.multiplier.duration - this.multiplier.flyTicks)
          : 0,
    };
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
    const prev = line[Math.max(0, i - 1)];
    const next = line[Math.min(line.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    if (tx === 0 && ty === 0) ty = 1;
    const len = Math.hypot(tx, ty);
    tx /= len;
    ty /= len;
    const side = i % 2 === 0 ? 1 : -1;
    const rank = Math.abs(i - contactIndex);
    return {
      x: c.x,
      y: c.y,
      dirX: -ty * side,
      dirY: tx * side,
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
