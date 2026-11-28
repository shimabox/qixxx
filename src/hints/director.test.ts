import { describe, expect, it } from 'vitest';
import { HintDirector, type HintStep, type HintView, type HintId } from './director';
import { HintSeenStore, type StorageLike } from '../storage/hints';
import type { GameEvent } from '../core/events';
import type { LineSpeed } from '../core/claim';
import { getStageConfig } from '../core/stage';
import {
  HINT_TIMED_TICKS,
  HINT_SPLIT_TICKS,
  HINT_SLOW_MAX_TICKS,
  HINT_QUEUE_MAX_WAIT_TICKS,
  HINT_RING_TICKS,
} from '../config';

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const unreadable: StorageLike = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

type Ember = { name: string };

const ALL_IDS: HintId[] = ['draw', 'claimSide', 'slow', 'split', 'ember', 'blaze', 'igniter'];

class Harness {
  readonly storage = new MemoryStorage();
  store: HintSeenStore;
  director: HintDirector<Ember>;
  touch = false;
  view: HintView<Ember> | null = null;

  constructor(seen: HintId[] = [], storage: StorageLike | null = null) {
    const backing = storage ?? this.storage;
    if (seen.length > 0) backing.setItem('qixxx.hintsSeen', JSON.stringify(seen));
    this.store = new HintSeenStore(() => backing);
    this.director = new HintDirector<Ember>(this.store);
  }

  step(partial: Partial<HintStep<Ember>> = {}): HintView<Ember> | null {
    this.view = this.director.step({
      playing: true,
      stageStart: null,
      wispCount: 1,
      claims: [],
      events: [],
      spawnedEmber: null,
      touch: this.touch,
      ...partial,
    });
    return this.view;
  }

  /** Steps `ticks` plain playing ticks, returning the last view. */
  run(ticks: number, partial: Partial<HintStep<Ember>> = {}): HintView<Ember> | null {
    for (let i = 0; i < ticks; i++) this.step(partial);
    return this.view;
  }

  startRun(wispCount = 1): HintView<Ember> | null {
    return this.step({ stageStart: 'run', wispCount });
  }

  claim(lineSpeed: LineSpeed = 'fast'): HintView<Ember> | null {
    return this.step({ claims: [{ lineSpeed }] });
  }

  event(event: GameEvent, spawnedEmber: Ember | null = null): HintView<Ember> | null {
    return this.step({ events: [event], spawnedEmber });
  }
}

describe('HintDirector: draw', () => {
  it('shows draw for the whole of play until the first claim, then marks it seen', () => {
    const h = new Harness();
    expect(h.startRun()?.id).toBe('draw');
    expect(h.view?.textKey).toBe('hint.draw.key');
    expect(h.view?.mark).toEqual({ kind: 'arrow' });
    expect(h.view?.remaining).toBeNull();
    expect(h.run(2000)?.id).toBe('draw');
    expect(h.store.has('draw')).toBe(false);
    h.claim();
    expect(h.store.has('draw')).toBe(true);
    expect(h.view?.id).not.toBe('draw');
  });

  it('is not shown once seen', () => {
    const h = new Harness(['draw']);
    expect(h.startRun()).toBeNull();
    expect(h.run(100)).toBeNull();
  });

  it('comes back next run when the run ended before any claim', () => {
    const h = new Harness();
    h.startRun();
    h.run(10);
    expect(h.step({ playing: false })).toBeNull();
    expect(h.startRun()?.id).toBe('draw');
    // A new page load (a new director on the same storage) shows it again too.
    const again = new HintDirector<Ember>(new HintSeenStore(() => h.storage));
    expect(again.step({ playing: true, stageStart: 'run', wispCount: 1, claims: [], events: [], spawnedEmber: null, touch: false })?.id).toBe('draw');
  });

  it('reads the touch sentence and lights FAST on a touch device', () => {
    const h = new Harness();
    h.touch = true;
    const view = h.startRun();
    expect(view?.textKey).toBe('hint.draw.touch');
    expect(view?.glow).toBe('fast');
    h.touch = false;
    expect(h.step()?.glow).toBeNull();
    expect(h.view?.textKey).toBe('hint.draw.key');
  });
});

describe('HintDirector: claimSide', () => {
  it('follows the first claim, rings the Wisps for HINT_RING_TICKS and goes after HINT_TIMED_TICKS', () => {
    const h = new Harness();
    h.startRun();
    const first = h.claim();
    expect(first?.id).toBe('claimSide');
    expect(first?.textKey).toBe('hint.claimSide');
    expect(first?.age).toBe(0);
    expect(first?.remaining).toBe(HINT_TIMED_TICKS);
    expect(first?.mark).toEqual({ kind: 'ring', target: 'wisps' });
    expect(h.store.has('claimSide')).toBe(true);
    expect(h.run(HINT_RING_TICKS - 1)?.mark).toEqual({ kind: 'ring', target: 'wisps' });
    expect(h.step()?.mark).toBeNull();
    expect(h.view?.id).toBe('claimSide');
    h.run(HINT_TIMED_TICKS - HINT_RING_TICKS - 1);
    expect(h.view?.id).toBe('claimSide');
    expect(h.view?.remaining).toBe(1);
    expect(h.step()).toBeNull();
  });

  it('is not shown on a second run', () => {
    const h = new Harness();
    h.startRun();
    h.claim();
    h.run(HINT_TIMED_TICKS);
    h.step({ playing: false });
    h.startRun();
    expect(h.claim()).toBeNull();
  });
});

describe('HintDirector: slow', () => {
  it('appears once two claims have been made', () => {
    const h = new Harness(['draw', 'claimSide']);
    h.startRun();
    expect(h.claim()).toBeNull();
    const view = h.claim();
    expect(view?.id).toBe('slow');
    expect(view?.textKey).toBe('hint.slow.key');
    expect(view?.remaining).toBeNull();
  });

  it('goes and is seen on a slow-line claim', () => {
    const h = new Harness(['draw', 'claimSide']);
    h.startRun();
    h.claim();
    h.claim();
    h.run(100);
    expect(h.view?.id).toBe('slow');
    h.claim('fast');
    expect(h.view?.id).toBe('slow');
    expect(h.store.has('slow')).toBe(false);
    expect(h.claim('slow')).toBeNull();
    expect(h.store.has('slow')).toBe(true);
  });

  it('goes and is seen after HINT_SLOW_MAX_TICKS', () => {
    const h = new Harness(['draw', 'claimSide']);
    h.startRun();
    h.claim();
    h.claim();
    // Shown for HINT_SLOW_MAX_TICKS ticks in all, the claim's tick included.
    h.run(HINT_SLOW_MAX_TICKS - 1);
    expect(h.view?.id).toBe('slow');
    expect(h.store.has('slow')).toBe(false);
    expect(h.step()).toBeNull();
    expect(h.store.has('slow')).toBe(true);
  });

  it('lights SLOW on a touch device and reads the touch sentence', () => {
    const h = new Harness(['draw', 'claimSide']);
    h.touch = true;
    h.startRun();
    h.claim();
    const view = h.claim();
    expect(view?.textKey).toBe('hint.slow.touch');
    expect(view?.glow).toBe('slow');
    expect(view?.mark).toBeNull();
  });

  it('counts claims per run', () => {
    const h = new Harness(['draw', 'claimSide']);
    h.startRun();
    h.claim();
    h.step({ playing: false });
    h.startRun();
    expect(h.claim()).toBeNull();
    expect(h.claim()?.id).toBe('slow');
  });
});

describe('HintDirector: split', () => {
  it('appears when a stage with two or more Wisps starts and goes after HINT_SPLIT_TICKS', () => {
    const h = new Harness(['draw']);
    const view = h.step({ stageStart: 'stage', wispCount: 2 });
    expect(view?.id).toBe('split');
    expect(view?.textKey).toBe('hint.split');
    expect(view?.mark).toEqual({ kind: 'ring', target: 'wisps' });
    expect(view?.remaining).toBe(HINT_SPLIT_TICKS);
    h.run(HINT_SPLIT_TICKS - 1);
    expect(h.view?.id).toBe('split');
    expect(h.step()).toBeNull();
  });

  it('is not shown for a one-Wisp stage', () => {
    const h = new Harness(['draw']);
    expect(h.step({ stageStart: 'stage', wispCount: 1 })).toBeNull();
    expect(h.step({ stageStart: 'run', wispCount: 1 })).toBeNull();
  });

  it("is not shown at the start of a run's first stage, even one with two Wisps", () => {
    const h = new Harness(['draw']);
    expect(h.step({ stageStart: 'run', wispCount: 2 })).toBeNull();
    expect(h.run(HINT_SPLIT_TICKS + HINT_QUEUE_MAX_WAIT_TICKS)).toBeNull();
    expect(h.store.has('split')).toBe(false);
    // A later stage's start with two Wisps brings it.
    expect(h.step({ stageStart: 'stage', wispCount: 2 })?.id).toBe('split');
  });

  it('lets a first run start with how to draw, and shows split at the first later stage with two Wisps', () => {
    const h = new Harness();
    expect(h.startRun(1)?.id).toBe('draw');
    h.run(30);
    expect(h.view?.id).toBe('draw');
    h.claim();
    expect(h.view?.id).toBe('claimSide');
    h.run(HINT_TIMED_TICKS);
    h.step({ playing: false }); // STAGE CLEAR
    // Stage 2 (one Wisp): no split hint.
    expect(h.step({ stageStart: 'stage', wispCount: 1 })?.id).not.toBe('split');
    expect(h.store.has('split')).toBe(false);
    h.step({ playing: false }); // STAGE CLEAR
    // Stage 3 (two Wisps) brings it.
    expect(h.step({ stageStart: 'stage', wispCount: 2 })?.id).toBe('split');
  });

  it("first comes at stage 3's start with the stage table's Wisp counts", () => {
    const h = new Harness(['draw', 'claimSide', 'slow', 'ember', 'blaze', 'igniter']);
    expect(getStageConfig(1).wispCount).toBe(1);
    expect(getStageConfig(2).wispCount).toBe(1);
    expect(getStageConfig(3).wispCount).toBe(2);
    expect(h.startRun(getStageConfig(1).wispCount)).toBeNull();
    h.step({ playing: false }); // STAGE CLEAR
    expect(h.step({ stageStart: 'stage', wispCount: getStageConfig(2).wispCount })).toBeNull();
    expect(h.store.has('split')).toBe(false);
    h.step({ playing: false }); // STAGE CLEAR
    expect(h.step({ stageStart: 'stage', wispCount: getStageConfig(3).wispCount })?.id).toBe('split');
  });
});

describe('HintDirector: enemies', () => {
  for (const c of [
    { event: 'ember-spawned' as const, id: 'ember' as const },
    { event: 'ember-blaze-spawned' as const, id: 'blaze' as const },
  ]) {
    it(`shows ${c.id} on ${c.event}, ringing that Ember, for HINT_TIMED_TICKS`, () => {
      const h = new Harness(['draw']);
      const target = { name: 'new' };
      const view = h.event(c.event, target);
      expect(view?.id).toBe(c.id);
      expect(view?.textKey).toBe(`hint.${c.id}`);
      expect(view?.mark).toEqual({ kind: 'ring', target: 'ember', ember: target });
      if (view?.mark?.kind === 'ring' && view.mark.target === 'ember') expect(view.mark.ember).toBe(target);
      h.run(HINT_TIMED_TICKS - 1);
      expect(h.view?.id).toBe(c.id);
      expect(h.step()).toBeNull();
      expect(h.store.has(c.id)).toBe(true);
    });
  }

  it('shows igniter on igniter-spawned, ringing the Igniter, for HINT_TIMED_TICKS', () => {
    const h = new Harness(['draw']);
    const view = h.event('igniter-spawned');
    expect(view?.id).toBe('igniter');
    expect(view?.textKey).toBe('hint.igniter');
    expect(view?.mark).toEqual({ kind: 'ring', target: 'igniter' });
    h.run(HINT_TIMED_TICKS - 1);
    expect(h.view?.id).toBe('igniter');
    expect(h.step()).toBeNull();
  });

  it('shows nothing for events that are not an appearance', () => {
    const h = new Harness(['draw']);
    for (const event of ['area-claimed', 'miss', 'igniter-approaching', 'ember-despawned', 'ember-entered-line'] as GameEvent[]) {
      expect(h.event(event), event).toBeNull();
    }
  });
});

describe('HintDirector: one at a time', () => {
  it('queues a timed hint behind the one shown and shows it when that goes', () => {
    const h = new Harness(['draw']);
    h.event('igniter-spawned');
    h.run(10);
    expect(h.event('ember-spawned', { name: 'e' })?.id).toBe('igniter');
    h.run(HINT_TIMED_TICKS - 12);
    expect(h.view?.id).toBe('igniter');
    const next = h.step();
    expect(next?.id).toBe('ember');
    expect(next?.age).toBe(0);
    expect(h.store.has('ember')).toBe(true);
  });

  it('drops a hint that waited longer than HINT_QUEUE_MAX_WAIT_TICKS, without marking it seen', () => {
    const h = new Harness(['draw']);
    h.step({ stageStart: 'stage', wispCount: 3 }); // split: 180 ticks
    h.event('igniter-spawned'); // waits 179, then shows for 150
    h.event('ember-spawned', { name: 'e' }); // would wait 178 + 150 > 300
    h.run(HINT_SPLIT_TICKS - 3);
    expect(h.view?.id).toBe('split');
    expect(h.step()?.id).toBe('igniter');
    h.run(HINT_TIMED_TICKS + 5);
    expect(h.view).toBeNull();
    expect(h.store.has('igniter')).toBe(true);
    expect(h.store.has('ember')).toBe(false);
    // Shown at its next chance.
    expect(h.event('ember-spawned', { name: 'later' })?.id).toBe('ember');
  });

  // split (tick 0, 180 ticks), then igniter (queued at tick 1, shown 180-329),
  // then ember queued at tick `queuedAt`: at tick 330 it has waited 330 - queuedAt.
  function waitBehindTwo(queuedAt: number): Harness {
    const h = new Harness(['draw']);
    h.step({ stageStart: 'stage', wispCount: 2 });
    h.event('igniter-spawned');
    h.run(queuedAt - 2);
    h.event('ember-spawned', { name: 'e' });
    h.run(329 - queuedAt);
    expect(h.view?.id).toBe('igniter');
    return h;
  }

  it('shows a hint that waited exactly HINT_QUEUE_MAX_WAIT_TICKS', () => {
    expect(HINT_SPLIT_TICKS + HINT_TIMED_TICKS - HINT_QUEUE_MAX_WAIT_TICKS).toBe(30);
    const h = waitBehindTwo(30);
    expect(h.step()?.id).toBe('ember');
  });

  it('drops a hint that waited one tick more', () => {
    const h = waitBehindTwo(29);
    expect(h.step()).toBeNull();
    expect(h.store.has('ember')).toBe(false);
  });

  it('does not queue a hint twice', () => {
    const h = new Harness(['draw']);
    h.event('igniter-spawned');
    h.event('ember-spawned', { name: 'a' });
    h.event('ember-spawned', { name: 'b' });
    h.event('igniter-spawned');
    h.run(HINT_TIMED_TICKS - 4);
    const ember = h.step();
    expect(ember?.id).toBe('ember');
    expect(ember?.mark).toEqual({ kind: 'ring', target: 'ember', ember: { name: 'a' } });
    h.run(HINT_TIMED_TICKS);
    expect(h.view).toBeNull();
  });

  it('holds the continuing hints back while a timed hint is shown or waiting', () => {
    const h = new Harness();
    h.startRun();
    // The first claim: draw goes, claimSide shows.
    h.claim();
    h.event('ember-spawned', { name: 'e' });
    // A second claim makes slow due, but the timed ones go first.
    h.claim();
    const seen: string[] = [];
    for (let i = 0; i < HINT_TIMED_TICKS * 2 + 10; i++) seen.push(h.step()?.id ?? '-');
    const firstSlow = seen.indexOf('slow');
    expect(seen.slice(0, firstSlow).every((id) => id === 'claimSide' || id === 'ember')).toBe(true);
    expect(seen).toContain('ember');
    expect(seen.lastIndexOf('ember')).toBeLessThan(firstSlow);
    expect(seen.slice(firstSlow).every((id) => id === 'slow')).toBe(true);
  });

  it('lets a timed hint in over a continuing one, and the continuing one comes back after', () => {
    const h = new Harness();
    h.startRun();
    h.run(30);
    const view = h.event('igniter-spawned');
    expect(view?.id).toBe('igniter');
    h.run(HINT_TIMED_TICKS - 1);
    const back = h.step();
    expect(back?.id).toBe('draw');
    expect(back?.age).toBe(0);
    expect(h.store.has('draw')).toBe(false);
  });
});

describe('HintDirector: only while playing', () => {
  it('clears the shown hint and the queue when play stops', () => {
    const h = new Harness(['draw']);
    h.event('igniter-spawned');
    h.event('ember-spawned', { name: 'e' });
    expect(h.step({ playing: false })).toBeNull();
    // Nothing comes back by itself: the ember hint was dropped, not seen.
    expect(h.run(HINT_TIMED_TICKS * 2)).toBeNull();
    expect(h.store.has('ember')).toBe(false);
  });

  it('does not show or mark seen a hint that comes up on the tick play stops', () => {
    const h = new Harness(['draw', 'claimSide']);
    expect(h.step({ playing: false, stageStart: 'stage', wispCount: 2, events: ['ember-spawned'] })).toBeNull();
    expect(h.store.has('split')).toBe(false);
    expect(h.store.has('ember')).toBe(false);
  });

  it('counts a claim that cleared the stage, and its draw becomes seen', () => {
    const h = new Harness();
    h.startRun();
    expect(h.step({ playing: false, claims: [{ lineSpeed: 'fast' }] })).toBeNull();
    expect(h.store.has('draw')).toBe(true);
    expect(h.store.has('claimSide')).toBe(false);
  });

  it('brings a continuing hint back on the next playing tick', () => {
    const h = new Harness();
    h.startRun();
    h.step({ playing: false });
    expect(h.step()?.id).toBe('draw');
  });

  it('reset() forgets the shown hint and the queue', () => {
    const h = new Harness(['draw']);
    h.event('igniter-spawned');
    h.event('ember-spawned', { name: 'e' });
    h.director.reset();
    expect(h.director.current()).toBeNull();
    expect(h.run(HINT_TIMED_TICKS * 2)).toBeNull();
  });
});

describe('HintDirector: unreadable storage', () => {
  it('starts with nothing seen and never repeats a hint within the same director', () => {
    const h = new Harness([], unreadable);
    h.startRun();
    expect(h.view?.id).toBe('draw');
    h.claim();
    h.run(HINT_TIMED_TICKS);
    h.step({ playing: false });
    h.startRun();
    expect(h.view).toBeNull();
    expect(h.claim()).toBeNull();
    h.event('igniter-spawned');
    h.run(HINT_TIMED_TICKS);
    expect(h.event('igniter-spawned')).toBeNull();
  });
});

describe('HintDirector: all seen', () => {
  it('shows nothing at all', () => {
    const h = new Harness(ALL_IDS);
    const views = [
      h.startRun(3),
      h.claim(),
      h.claim(),
      h.claim('slow'),
      h.event('ember-spawned', { name: 'e' }),
      h.event('ember-blaze-spawned', { name: 'b' }),
      h.event('igniter-spawned'),
      h.step({ stageStart: 'stage', wispCount: 4 }),
      h.run(700),
    ];
    expect(views.every((v) => v === null)).toBe(true);
  });
});
