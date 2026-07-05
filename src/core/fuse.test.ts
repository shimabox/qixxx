// Igniter unit tests (docs/plan.md §7.1: "fuse: 静止時間閾値で出現し、静止
// 中のみ前進、エリア確定で消滅する"). The "エリア確定/ミスで消滅し、引き戻し
// が復活する" half of that requirement is a Game-level integration concern
// (Marker.setRetractEnabled wiring) and is exercised in game.test.ts.
import { describe, it, expect } from 'vitest';
import { Igniter, shouldSpawnIgniter } from './fuse';
import { IGNITER_SPAWN_STILL_TICKS, IGNITER_ADVANCE_TICKS } from '../config';

describe('shouldSpawnIgniter (docs/plan.md §3.4 (3) — 1s stillness threshold)', () => {
  it('is false below the threshold and true once it is reached', () => {
    expect(shouldSpawnIgniter(0)).toBe(false);
    expect(shouldSpawnIgniter(IGNITER_SPAWN_STILL_TICKS - 1)).toBe(false);
    expect(shouldSpawnIgniter(IGNITER_SPAWN_STILL_TICKS)).toBe(true);
    expect(shouldSpawnIgniter(IGNITER_SPAWN_STILL_TICKS + 100)).toBe(true);
  });
});

describe('Igniter (docs/plan.md §3.4 (3) / §4.3)', () => {
  it('does not advance while the player is moving', () => {
    const igniter = new Igniter();
    const maxIndex = 10;

    for (let tick = 0; tick < IGNITER_ADVANCE_TICKS * 3; tick++) {
      igniter.update(false, maxIndex);
    }

    expect(igniter.getIndex()).toBe(0);
  });

  it('advances one index per IGNITER_ADVANCE_TICKS ticks while the player is still', () => {
    const igniter = new Igniter();
    const maxIndex = 10;

    expect(igniter.getIndex()).toBe(0);
    igniter.update(true, maxIndex); // first tick always advances (the cooldown starts at 0)
    expect(igniter.getIndex()).toBe(1);

    for (let tick = 0; tick < IGNITER_ADVANCE_TICKS - 1; tick++) {
      igniter.update(true, maxIndex);
      expect(igniter.getIndex()).toBe(1); // still on cooldown
    }
    igniter.update(true, maxIndex); // cooldown elapsed: advances again
    expect(igniter.getIndex()).toBe(2);
  });

  it('pauses mid-advance when the player starts moving again, and resumes from where it left off', () => {
    const igniter = new Igniter();
    const maxIndex = 10;

    // Advance to index 1.
    for (let tick = 0; tick < IGNITER_ADVANCE_TICKS; tick++) {
      igniter.update(true, maxIndex);
    }
    expect(igniter.getIndex()).toBe(1);

    // Player moves for a while: no progress at all, even partial.
    for (let tick = 0; tick < 50; tick++) {
      igniter.update(false, maxIndex);
    }
    expect(igniter.getIndex()).toBe(1);

    // Player stops again: advances to index 2 after another full interval.
    for (let tick = 0; tick < IGNITER_ADVANCE_TICKS; tick++) {
      igniter.update(true, maxIndex);
    }
    expect(igniter.getIndex()).toBe(2);
  });

  it('never advances past maxIndex, and reports caught-up once it reaches it', () => {
    const igniter = new Igniter();
    const maxIndex = 2;

    let caughtUp = false;
    for (let tick = 0; tick < IGNITER_ADVANCE_TICKS * 10 && !caughtUp; tick++) {
      caughtUp = igniter.update(true, maxIndex);
    }

    expect(caughtUp).toBe(true);
    expect(igniter.getIndex()).toBe(maxIndex);

    // Continuing to update afterward must not push it past maxIndex.
    igniter.update(true, maxIndex);
    expect(igniter.getIndex()).toBe(maxIndex);
  });

  it('reports caught-up immediately when spawned with maxIndex already at 0 (a one-cell line)', () => {
    const igniter = new Igniter();
    expect(igniter.update(true, 0)).toBe(true);
  });
});
