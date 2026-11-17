import { describe, it, expect } from 'vitest';
import { TitleDemo, type TitleDemoDeps, type TitleDemoEngine, type TitleDemoRecord } from './titleDemo';
import type { SessionStatus } from './core/session';

const START = 60;
const END_HOLD = 120;
const CLEAR_HOLD = 90;

/** A replay engine stand-in: `length` recorded ticks, optionally a STAGE CLEAR after tick `clearAt`. */
class FakeEngine implements TitleDemoEngine {
  index = 0;
  steps = 0;
  status: SessionStatus = 'playing';
  events: string[] = [];
  despawned: unknown[] = [];
  constructor(
    readonly record: TitleDemoRecord,
    private readonly length: number,
    private readonly clearAt: number | null = null
  ) {}
  stepTick(): boolean {
    if (this.isFinished()) return false;
    if (this.status === 'stageclear') this.status = 'playing';
    this.index++;
    this.steps++;
    this.events.push('area-claimed');
    this.despawned.push({ x: 0, y: 0 });
    if (this.clearAt !== null && this.index === this.clearAt) this.status = 'stageclear';
    return true;
  }
  isFinished(): boolean {
    return this.index >= this.length || this.status === 'gameover';
  }
  getSession() {
    return {
      getStatus: () => this.status,
      drainEvents: () => this.events.splice(0),
      drainDespawnedEmberPositions: () => this.despawned.splice(0),
    };
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const payload = (seed: number) => ({ seed, rleBase64: `rle-${seed}` });

type FetchAnswer = { seed: number; rleBase64: string } | null | 'throw' | 'unplayable' | Deferred<unknown>;
type CreateAnswer = 'ok' | 'fail' | Deferred<FakeEngine>;

/**
 * A TitleDemo over scripted answers: `fetches[id]` is what GET .../{id}/replay
 * answers, `creates` is consumed one entry per createEngine() call (default
 * 'ok', building a `length`-tick engine).
 */
function setup(options: { fetches?: Record<string, FetchAnswer>; creates?: CreateAnswer[]; length?: number; clearAt?: number } = {}) {
  const fetched: string[] = [];
  const created: { record: TitleDemoRecord; signal: AbortSignal }[] = [];
  const engines: FakeEngine[] = [];
  const creates = [...(options.creates ?? [])];
  const length = options.length ?? 10;
  const deps: TitleDemoDeps<FakeEngine> = {
    fetchReplay: async (id) => {
      fetched.push(id);
      const answer = options.fetches && id in options.fetches ? options.fetches[id] : payload(1);
      if (answer === 'throw') throw new Error('network');
      if (answer === 'unplayable') return { seed: 1, rleBase64: 'x', unplayable: true };
      if (answer !== null && 'promise' in answer) return answer.promise;
      return answer;
    },
    isPlayable: (p): p is { seed: number; rleBase64: string } =>
      typeof p === 'object' && p !== null && !('unplayable' in p) && typeof (p as { seed?: unknown }).seed === 'number',
    decode: (b64) => new TextEncoder().encode(b64),
    createEngine: (record, signal) => {
      created.push({ record, signal });
      const answer = creates.shift() ?? 'ok';
      if (answer === 'fail') return Promise.reject(new Error('bad replay'));
      if (answer !== 'ok') {
        signal.addEventListener('abort', () => answer.reject(new Error('aborted')));
        return answer.promise;
      }
      const engine = new FakeEngine(record, length, options.clearAt ?? null);
      engines.push(engine);
      return Promise.resolve(engine);
    },
    startDelayTicks: START,
    endHoldTicks: END_HOLD,
    stageClearHoldTicks: CLEAR_HOLD,
  };
  const demo = new TitleDemo(deps);
  const onTitle = { onTitle: true, allowed: true, candidates: ['a', 'b', 'c'] };
  const away = { ...onTitle, onTitle: false };
  const steps = (n: number, tick = onTitle) => {
    for (let i = 0; i < n; i++) demo.step(tick);
  };
  return { demo, deps, fetched, created, engines, onTitle, away, steps };
}

describe('TitleDemo: start and candidates', () => {
  it('does nothing until the Title screen has been up for the start delay', async () => {
    const { demo, fetched, steps } = setup();
    steps(START - 1);
    await flush();
    expect(fetched).toEqual([]);
    expect(demo.getState()).toBe('waiting');
    steps(1);
    await flush();
    expect(fetched).toEqual(['a']);
    expect(demo.getState()).toBe('playing');
  });

  it('plays the first candidate that fetches, is playable and builds; an unplayable or failed one moves on', async () => {
    const { demo, fetched, created, steps } = setup({ fetches: { a: 'unplayable', b: payload(22) } });
    steps(START);
    await flush();
    expect(fetched).toEqual(['a', 'b']);
    expect(created.map((c) => c.record.seed)).toEqual([22]);
    expect(demo.getShownEngine()?.record.seed).toBe(22);
  });

  it('moves on from a failed fetch, a non-2xx answer and a failed build alike, and stops asking once all three failed', async () => {
    const { demo, fetched, created, steps } = setup({ fetches: { a: 'throw', b: null, c: payload(3) }, creates: ['fail'] });
    steps(START);
    await flush();
    expect(fetched).toEqual(['a', 'b', 'c']);
    expect(created).toHaveLength(1);
    expect(demo.getState()).toBe('off');
    expect(demo.getShownEngine()).toBeNull();
    steps(START * 3);
    await flush();
    expect(fetched).toHaveLength(3);
    expect(created).toHaveLength(1);
  });

  it('a failed build of the first candidate tries the second', async () => {
    const { demo, fetched, steps } = setup({ fetches: { a: payload(1), b: payload(2) }, creates: ['fail'] });
    steps(START);
    await flush();
    expect(fetched).toEqual(['a', 'b']);
    expect(demo.getShownEngine()?.record.seed).toBe(2);
  });

  it('with reduced motion or on a seeded page (not allowed), or with no candidates, neither fetches nor builds', async () => {
    for (const tick of [
      { onTitle: true, allowed: false, candidates: ['a'] },
      { onTitle: true, allowed: true, candidates: [] },
    ]) {
      const { demo, fetched, created, steps } = setup();
      steps(START * 5, tick);
      await flush();
      expect(fetched).toEqual([]);
      expect(created).toEqual([]);
      expect(demo.getShownEngine()).toBeNull();
    }
  });

  it('starts once the candidates arrive after the start delay', async () => {
    const { demo, fetched, steps, onTitle } = setup();
    steps(START * 2, { ...onTitle, candidates: [] });
    steps(1);
    await flush();
    expect(fetched).toEqual(['a']);
    expect(demo.getState()).toBe('playing');
  });
});

describe('TitleDemo: leaving the Title screen while preparing', () => {
  it('aborts a build when the Title screen goes, and builds again from the fetched record on return without fetching it again', async () => {
    const pending = deferred<FakeEngine>();
    const { demo, fetched, created, steps, away } = setup({ creates: [pending] });
    steps(START);
    await flush();
    expect(created).toHaveLength(1);
    expect(demo.getState()).toBe('preparing');
    steps(1, away);
    expect(created[0].signal.aborted).toBe(true);
    expect(demo.getState()).toBe('waiting');
    await flush();
    steps(START);
    await flush();
    expect(fetched).toEqual(['a']);
    expect(created).toHaveLength(2);
    expect(created[1].record).toBe(created[0].record);
    expect(demo.getState()).toBe('playing');
  });

  it('a fetch answered after the Title screen went is kept, not repeated', async () => {
    const slow = deferred<unknown>();
    const { demo, fetched, created, steps, away } = setup({ fetches: { a: slow } });
    steps(START);
    steps(1, away);
    slow.resolve(payload(7));
    await flush();
    expect(created).toHaveLength(0); // nothing is built away from the Title screen
    steps(START);
    await flush();
    expect(fetched).toEqual(['a']);
    expect(demo.getShownEngine()?.record.seed).toBe(7);
  });

  it('a fetch still in flight when the Title screen comes back is joined, not repeated', async () => {
    const slow = deferred<unknown>();
    const { demo, fetched, steps, away } = setup({ fetches: { a: slow } });
    steps(START);
    steps(1, away);
    steps(START);
    slow.resolve(payload(8));
    await flush();
    expect(fetched).toEqual(['a']);
    expect(demo.getShownEngine()?.record.seed).toBe(8);
  });
});

describe('TitleDemo: playing', () => {
  it('steps the engine once per Title tick, drops it on leaving, and replays from the start on return', async () => {
    const { demo, engines, steps, away } = setup({ length: 1000 });
    steps(START);
    await flush();
    const first = demo.getShownEngine()!;
    expect(first.steps).toBe(0);
    steps(5);
    expect(first.steps).toBe(5);
    steps(3, away);
    expect(first.steps).toBe(5);
    expect(demo.getShownEngine()).toBeNull();
    steps(START);
    await flush();
    const second = demo.getShownEngine()!;
    expect(second).not.toBe(first);
    expect(second.steps).toBe(0);
    expect(engines).toHaveLength(2);
  });

  it('drains and drops every event the demo session raises (nothing is left for sound)', async () => {
    const { demo, steps } = setup({ length: 1000 });
    steps(START);
    await flush();
    const engine = demo.getShownEngine()!;
    steps(10);
    expect(engine.steps).toBe(10);
    expect(engine.events).toEqual([]);
    expect(engine.despawned).toEqual([]);
  });

  it('holds a STAGE CLEAR for the replay viewer\'s hold before going on', async () => {
    const { demo, steps } = setup({ length: 1000, clearAt: 3 });
    steps(START);
    await flush();
    const engine = demo.getShownEngine()!;
    steps(3);
    expect(engine.status).toBe('stageclear');
    steps(CLEAR_HOLD);
    expect(engine.steps).toBe(3);
    steps(1);
    expect(engine.steps).toBe(4);
  });
});

describe('TitleDemo: the end and the repeat', () => {
  it('at the end starts building the next engine from the same record (no fetch), and plays it from the start after the end hold', async () => {
    const { demo, fetched, created, steps } = setup({ length: 5 });
    steps(START);
    await flush();
    const first = demo.getShownEngine()!;
    steps(5);
    expect(demo.getState()).toBe('ended');
    expect(created).toHaveLength(2);
    expect(created[1].record).toBe(created[0].record);
    expect(fetched).toEqual(['a']);
    await flush();
    steps(END_HOLD - 1);
    expect(demo.getShownEngine()).toBe(first); // the last board stays up
    steps(1);
    const second = demo.getShownEngine()!;
    expect(second).not.toBe(first);
    expect(second.steps).toBe(0);
    expect(demo.getState()).toBe('playing');
  });

  it('keeps the last board past the end hold until the next engine is ready, then plays it', async () => {
    const pending = deferred<FakeEngine>();
    const { demo, created, steps } = setup({ length: 5, creates: ['ok', pending] });
    steps(START);
    await flush();
    const first = demo.getShownEngine()!;
    steps(5 + END_HOLD + 30);
    expect(demo.getState()).toBe('ended');
    expect(demo.getShownEngine()).toBe(first);
    const next = new FakeEngine(created[1].record, 5);
    pending.resolve(next);
    await flush();
    steps(1);
    expect(demo.getShownEngine()).toBe(next);
  });

  it('stops for good when the next engine fails to build: no more builds or fetches', async () => {
    const { demo, fetched, created, steps } = setup({ length: 5, creates: ['ok', 'fail'] });
    steps(START);
    await flush();
    steps(5);
    await flush();
    steps(1);
    expect(demo.getState()).toBe('off');
    expect(demo.getShownEngine()).toBeNull();
    steps(START * 3);
    await flush();
    expect(created).toHaveLength(2);
    expect(fetched).toEqual(['a']);
  });

  it('aborts the next build when the Title screen goes during the end hold', async () => {
    const pending = deferred<FakeEngine>();
    const { demo, created, steps, away } = setup({ length: 5, creates: ['ok', pending] });
    steps(START);
    await flush();
    steps(5);
    steps(1, away);
    expect(created[1].signal.aborted).toBe(true);
    expect(demo.getShownEngine()).toBeNull();
    await flush();
    steps(START);
    await flush();
    expect(created).toHaveLength(3);
    expect(demo.getState()).toBe('playing');
  });
});
