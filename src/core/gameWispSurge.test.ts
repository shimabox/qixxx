// Game's Wisp surge (GameOptions.wispSurge, core/wispSurge.ts): every claim
// decides the level again from occupancy and the goal, and every Wisp moves
// at its own multiplier times the level's. Driven on a 21 x 12 field (190
// claimable cells) whose Wisps go straight up and down their own columns on
// the right (no jitter), while the marker closes one full-height strip after
// another from the left: the occupancies after each strip are 10/190,
// 30/190, 50/190, 70/190, 90/190, 110/190 and 130/190.
import { describe, it, expect } from 'vitest';
import { Field } from './field';
import { Game, GameOptions } from './game';
import { Wisp } from './enemy';

const W = 21;
const H = 12;

function buildGame(options: GameOptions & { wispColumns?: number[]; wispSpeed?: number } = {}): Game {
  const { wispColumns = [18, 17], wispSpeed = 1, ...gameOptions } = options;
  const wisps = wispColumns.map((x, i) => new Wisp({ x, y: 3 + i * 2 }, () => 0.5, Math.PI / 2, wispSpeed));
  return new Game(new Field(W, H), { x: 2, y: 0 }, undefined, () => 0.5, {
    wisps,
    requiredOccupancy: 0.7,
    emberSpawnIntervalTicks: 1_000_000,
    ...gameOptions,
  });
}

/** Closes the next strip: down from the top edge on even strips, up from the bottom on odd ones, then two cells right. */
function closeStrip(game: Game, strip: number): void {
  const dy = strip % 2 === 0 ? 1 : -1;
  for (let i = 0; i < H - 1; i++) game.update({ dx: 0, dy, drawHeld: true });
  expect(game.getMarker().isDrawing()).toBe(false);
  for (let i = 0; i < 2; i++) game.update({ dx: 1, dy: 0, drawHeld: true });
}

const speeds = (game: Game) => game.getWisps().map((w) => w.getSpeedMultiplier());

describe('Game — the Wisp surge (wispSurge: true)', () => {
  it('raises every Wisp to x1.15 past half of the goal and to x1.3 within 0.10 of it, and only on the claims that cross', () => {
    const game = buildGame({ wispSurge: true });
    const seen: Array<{ occupancy: number; level: number; speeds: number[] }> = [];
    for (let strip = 0; strip < 7; strip++) {
      closeStrip(game, strip);
      seen.push({ occupancy: game.getOccupancy(), level: game.getWispSurgeLevel(), speeds: speeds(game) });
    }
    expect(seen.map((s) => s.occupancy)).toEqual([10, 30, 50, 70, 90, 110, 130].map((n) => n / 190));
    // Goal 0.70: level 1 above 0.35, level 2 from 0.60.
    expect(seen.map((s) => s.level)).toEqual([0, 0, 0, 1, 1, 1, 2]);
    expect(seen.map((s) => s.speeds)).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
      [1.15, 1.15],
      [1.15, 1.15],
      [1.15, 1.15],
      [1.3, 1.3],
    ]);
    expect(game.getStatus()).toBe('playing');
  });

  it('keeps the level and the speed through a miss', () => {
    const game = buildGame({ wispSurge: true, wispColumns: [18] });
    for (let strip = 0; strip < 4; strip++) closeStrip(game, strip);
    expect(game.getWispSurgeLevel()).toBe(1);
    // A one-cell stub, then still until the Igniter catches the marker.
    game.update({ dx: 0, dy: 1, drawHeld: true });
    for (let i = 0; i < 5_000 && game.getLives() === 3; i++) game.update({ dx: 0, dy: 0, drawHeld: false });
    expect(game.getLives()).toBe(2);
    expect(game.getMultiplier()).toBe(1);
    expect(game.getWispSurgeLevel()).toBe(1);
    expect(speeds(game)).toEqual([1.15]);
  });

  it('applies the level to the debug speed override, and back to the stage speed once it is dropped; the panel keeps reading the multiplier before the level', () => {
    const game = buildGame({ wispSurge: true, wispSpeed: 1.5 });
    for (let strip = 0; strip < 4; strip++) closeStrip(game, strip);
    expect(game.getWispSurgeLevel()).toBe(1);
    expect(speeds(game)).toEqual([1.5 * 1.15, 1.5 * 1.15]);
    expect(game.getEffectiveDebugParams().wispSpeedMultiplier).toBe(1.5);

    game.applyDebugOverrides({ wispSpeedMultiplier: 2 });
    expect(speeds(game)).toEqual([2 * 1.15, 2 * 1.15]);
    expect(game.getEffectiveDebugParams().wispSpeedMultiplier).toBe(2);

    game.resetDebugOverrides();
    expect(game.getWispSurgeLevel()).toBe(1);
    expect(speeds(game)).toEqual([1.5 * 1.15, 1.5 * 1.15]);
    expect(game.getEffectiveDebugParams().wispSpeedMultiplier).toBe(1.5);
  });

  it('decides the level again on a changed goal override, at the same occupancy: a higher goal lowers it, a lower one raises it', () => {
    const game = buildGame({ wispSurge: true });
    for (let strip = 0; strip < 4; strip++) closeStrip(game, strip);
    expect(game.getOccupancy()).toBe(70 / 190);
    expect(game.getWispSurgeLevel()).toBe(1);

    // Goal 0.90: half is 0.45, above 70/190 (0.368...).
    game.applyDebugOverrides({ requiredOccupancy: 0.9 });
    expect(game.getWispSurgeLevel()).toBe(0);
    expect(speeds(game)).toEqual([1, 1]);

    // Goal 0.45: 70/190 is past half and within 0.10 of it.
    game.applyDebugOverrides({ requiredOccupancy: 0.45 });
    expect(game.getWispSurgeLevel()).toBe(2);
    expect(speeds(game)).toEqual([1.3, 1.3]);
    expect(game.getOccupancy()).toBe(70 / 190);
    expect(game.getEffectiveDebugParams().wispSpeedMultiplier).toBe(1);
  });

  it('moves Wisps added by the debug count override at their own multiplier times the level', () => {
    const game = buildGame({ wispSurge: true, wispColumns: [18] });
    for (let strip = 0; strip < 4; strip++) closeStrip(game, strip);
    expect(game.getWispSurgeLevel()).toBe(1);
    game.applyDebugOverrides({ wispCount: 3 });
    expect(speeds(game)).toEqual([1.15, 1.15, 1.15]);
    game.applyDebugOverrides({ wispSpeedMultiplier: 2, wispCount: 4 });
    expect(speeds(game)).toEqual([2.3, 2.3, 2.3, 2.3]);
  });

  it('queues a notice, with every Wisp head, only for a claim that raises the level and leaves the stage playing', () => {
    const game = buildGame({ wispSurge: true, captureFeedback: true });
    const notices: Array<Array<{ level: number; positions: number }>> = [];
    for (let strip = 0; strip < 7; strip++) {
      closeStrip(game, strip);
      notices.push(game.drainWispSurgeFeedback().map((n) => ({ level: n.level, positions: n.positions.length })));
    }
    expect(notices).toEqual([[], [], [], [{ level: 1, positions: 2 }], [], [], [{ level: 2, positions: 2 }]]);
    // A debug override changing the level, either way, queues nothing.
    game.applyDebugOverrides({ requiredOccupancy: 0.9 });
    game.applyDebugOverrides({ requiredOccupancy: 0.7 });
    expect(game.getWispSurgeLevel()).toBe(2);
    expect(game.drainWispSurgeFeedback()).toEqual([]);
  });

  it('queues no notice for a claim that clears the stage on occupancy, though the level rises', () => {
    const game = buildGame({ wispSurge: true, captureFeedback: true, requiredOccupancy: 0.15 });
    closeStrip(game, 0);
    expect(game.getWispSurgeLevel()).toBe(0);
    closeStrip(game, 1);
    expect(game.getStatus()).toBe('stageclear');
    expect(game.getLastClearWasSplit()).toBe(false);
    expect(game.getWispSurgeLevel()).toBe(2);
    expect(game.drainWispSurgeFeedback()).toEqual([]);
  });

  it('queues no notice for a claim that clears the stage with a split, though the level rises', () => {
    const game = buildGame({ wispSurge: true, captureFeedback: true, requiredOccupancy: 0.6, wispColumns: [7, 18] });
    for (let strip = 0; strip < 3; strip++) closeStrip(game, strip);
    expect(game.getWispSurgeLevel()).toBe(0);
    // The fourth strip's line runs between the two Wisps' columns.
    closeStrip(game, 3);
    expect(game.getStatus()).toBe('stageclear');
    expect(game.getLastClearWasSplit()).toBe(true);
    expect(game.getWispSurgeLevel()).toBe(2);
    expect(game.drainWispSurgeFeedback()).toEqual([]);
  });

  it('builds no notice without captureFeedback', () => {
    const game = buildGame({ wispSurge: true });
    for (let strip = 0; strip < 4; strip++) closeStrip(game, strip);
    expect(game.getWispSurgeLevel()).toBe(1);
    expect(game.drainWispSurgeFeedback()).toEqual([]);
  });
});

describe('Game — without the Wisp surge (the default)', () => {
  it('never changes a Wisp’s speed as occupancy rises, and stays on level 0', () => {
    const game = buildGame({ captureFeedback: true, wispSpeed: 1.5 });
    expect(game.isWispSurgeEnabled()).toBe(false);
    for (let strip = 0; strip < 7; strip++) {
      closeStrip(game, strip);
      expect(game.getWispSurgeLevel()).toBe(0);
      expect(speeds(game)).toEqual([1.5, 1.5]);
    }
    expect(game.getOccupancy()).toBe(130 / 190);
    expect(game.drainWispSurgeFeedback()).toEqual([]);
    game.applyDebugOverrides({ requiredOccupancy: 0.7 });
    expect(speeds(game)).toEqual([1.5, 1.5]);
  });
});
