import type { DbHandle } from '@altis/db';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_HOUSEKEEPING_STEPS,
  catalogHousekeepingJob,
  catalogHousekeepingPayload,
  type CatalogHousekeepingPayload,
  type CatalogHousekeepingStep,
  type HousekeepingStepContext,
} from '../src/catalog/housekeeping.js';
import type { CatalogJobDeps } from '../src/catalog/jobs-deps.js';
import type { CoreLogger } from '../src/context.js';
import type { StorageDriver } from '../src/files/serve.js';
import type { JobContext } from '../src/jobs/types.js';
import { SCHEDULES } from '../src/scheduler/registry.js';

// `catalog.housekeeping` (Task 3; spec §12.6, decision P2-28): one daily job that runs the catalog's three owned
// steps in a fixed order (the search index, Task 15; orphan uploads, Task 18; expired exports, Task 19) across slices,
// with a `{step, cursor}` checkpoint. The steps are stubs in Wave 0; here they are also replaced by test steps.

const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 9, 30, 20, 40);
const WINDOW = { windowStart: NOW - 86_400_000, windowEnd: NOW };
const HANDLE = { dialect: 'sqlite' } as unknown as DbHandle;

const deps: CatalogJobDeps = {
  dataDir: '/data',
  baseUrl: 'https://perpus.example.sch.id',
  keyring: [],
  storage: {} as StorageDriver,
  log: silent,
};

/** A slice's context: no database (the test steps touch none), a budget that can be spent, recorded heartbeats. */
function context(o: { budgetMs?: () => number; cancelled?: boolean } = {}) {
  const heartbeats: { progress?: number; message?: string }[] = [];
  const ctx: JobContext = {
    jobId: '01JC0000000000000000000JOB',
    mode: 'worker',
    heartbeat: async (h) => {
      heartbeats.push(h ?? {});
    },
    cancelled: () => o.cancelled === true,
    markPointOfNoReturn: async () => {},
    secretParam: async () => null,
    audit: async () => {},
    session: async (open) => ({ value: await open(), fresh: true }),
    db: {} as JobContext['db'],
    handle: HANDLE,
    log: silent,
    now: () => NOW,
    budgetLeftMs: o.budgetMs ?? (() => 20_000),
  };
  return { ctx, heartbeats };
}

/** A step that records what it was given and answers from `answers` in turn (then `done`). */
function recording(name: string, answers: { done: boolean; cursor: string | null }[] = []) {
  const seen: { cursor: string | null; now: number; deps: CatalogJobDeps; h: DbHandle; budget: number }[] = [];
  const step: CatalogHousekeepingStep = {
    name,
    async run(c: HousekeepingStepContext) {
      seen.push({ cursor: c.cursor, now: c.now, deps: c.deps, h: c.h, budget: c.budgetLeftMs() });
      expect(typeof c.enqueue).toBe('function');
      return answers.shift() ?? { done: true, cursor: null };
    },
  };
  return { step, seen };
}

describe('catalog.housekeeping', () => {
  it('is a handler of type catalog.housekeeping, with the schedule permission, retryable from the API', () => {
    const job = catalogHousekeepingJob(() => deps);
    expect(job).toMatchObject({ type: 'catalog.housekeeping', permission: 'system.jobs.manage', retryable: 'api' });
    expect(job.longRunning).toBeUndefined();
    expect(job.cpuHeavy).toBeUndefined();
  });

  it('is scheduled daily at 03:40 with the same job type and permission (§12.6)', () => {
    const def = SCHEDULES.find((d) => d.name === 'catalog.housekeeping');
    expect(def).toMatchObject({ expr: '40 3 * * *', jobType: 'catalog.housekeeping', permission: 'system.jobs.manage', enabledByDefault: true });
  });

  it('its payload is the schedule window plus an optional {step, cursor} checkpoint, strict and bounded', () => {
    expect(catalogHousekeepingPayload.parse(WINDOW)).toEqual(WINDOW);
    expect(catalogHousekeepingPayload.parse({ ...WINDOW, step: 2, cursor: 'x' })).toEqual({ ...WINDOW, step: 2, cursor: 'x' });
    expect(catalogHousekeepingPayload.parse({ ...WINDOW, step: 1, cursor: null })).toEqual({ ...WINDOW, step: 1, cursor: null });
    for (const bad of [
      { windowStart: 1 },
      { ...WINDOW, step: -1 },
      { ...WINDOW, step: 1.5 },
      { ...WINDOW, cursor: 'x'.repeat(1025) },
      { ...WINDOW, extra: 1 },
    ]) {
      expect(catalogHousekeepingPayload.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });

  it('owns three steps in a fixed order: search, orphan uploads, expired exports', () => {
    expect(CATALOG_HOUSEKEEPING_STEPS.map((s) => s.name)).toEqual(['search', 'orphan_uploads', 'expired_exports']);
    expect(Object.isFrozen(CATALOG_HOUSEKEEPING_STEPS)).toBe(true);
  });

  // The default steps are the real ones since Wave 1 (Task 15 reads search_state), so this case runs three test steps
  // that end at once; the database-backed steps are covered by their own db tests.
  it('runs three steps that end at once and ends done in one slice, with a heartbeat after each step', async () => {
    const { ctx, heartbeats } = context();
    const out = await catalogHousekeepingJob(() => deps, ['a', 'b', 'c'].map((name) => recording(name).step)).run(ctx, WINDOW);
    expect(out).toEqual({ done: true });
    expect(heartbeats.map((h) => h.progress)).toEqual([33, 66, 100]);
  });

  it('runs the steps in order, each with the slice clock, the deps, the handle and a null cursor', async () => {
    const order: string[] = [];
    const steps = ['a', 'b', 'c'].map((name) => {
      const r = recording(name);
      const run = r.step.run;
      return { ...r, step: { name, run: (c: HousekeepingStepContext) => (order.push(name), run(c)) } };
    });
    const { ctx } = context();
    expect(await catalogHousekeepingJob(() => deps, steps.map((s) => s.step)).run(ctx, WINDOW)).toEqual({ done: true });
    expect(order).toEqual(['a', 'b', 'c']);
    for (const s of steps) expect(s.seen).toEqual([{ cursor: null, now: NOW, deps, h: HANDLE, budget: 20_000 }]);
  });

  it('a step that is not done ends the slice; the next slice continues that step with its cursor', async () => {
    const a = recording('a');
    const b = recording('b', [{ done: false, cursor: 'x' }]);
    const c = recording('c');
    const job = catalogHousekeepingJob(() => deps, [a.step, b.step, c.step]);

    const first = await job.run(context().ctx, WINDOW);
    expect(first).toEqual({ continueWith: { ...WINDOW, step: 1, cursor: 'x' }, progress: 33 });
    expect([a.seen.length, b.seen.length, c.seen.length]).toEqual([1, 1, 0]);

    // The checkpoint goes through the payload schema (the queue stores it as JSON), then the next slice runs.
    const checkpoint = catalogHousekeepingPayload.parse(JSON.parse(JSON.stringify((first as { continueWith: CatalogHousekeepingPayload }).continueWith)));
    expect(await job.run(context().ctx, checkpoint)).toEqual({ done: true });
    expect(a.seen).toHaveLength(1); // a finished step is not run again
    expect(b.seen.map((s) => s.cursor)).toEqual([null, 'x']);
    expect(c.seen.map((s) => s.cursor)).toEqual([null]);
  });

  it('a step may stop several times; each slice hands it the cursor it returned last', async () => {
    const a = recording('a', [
      { done: false, cursor: '1' },
      { done: false, cursor: '2' },
    ]);
    const job = catalogHousekeepingJob(() => deps, [a.step]);
    let payload: CatalogHousekeepingPayload = WINDOW;
    let slices = 0;
    for (;;) {
      slices += 1;
      const out = await job.run(context().ctx, payload);
      if (!('continueWith' in out)) break; // done (a catalog step never waits: no `waitUntil`, 1d)
      payload = out.continueWith;
    }
    expect(slices).toBe(3);
    expect(a.seen.map((s) => s.cursor)).toEqual([null, '1', '2']);
  });

  it('with the budget spent after a step, the slice ends and the next one starts the next step', async () => {
    let left = 20_000;
    const a = recording('a');
    const b = recording('b');
    const spending: CatalogHousekeepingStep = { name: 'a', run: async (c) => ((left = 500), a.step.run(c)) };
    const job = catalogHousekeepingJob(() => deps, [spending, b.step]);
    const out = await job.run(context({ budgetMs: () => left }).ctx, WINDOW);
    expect(out).toEqual({ continueWith: { ...WINDOW, step: 1, cursor: null }, progress: 50 });
    expect(b.seen).toHaveLength(0);
    left = 20_000;
    expect(await job.run(context({ budgetMs: () => left }).ctx, { ...WINDOW, step: 1, cursor: null })).toEqual({ done: true });
    expect([a.seen.length, b.seen.length]).toEqual([1, 1]);
  });

  it('the first step of a slice runs even on a short budget (a slice always makes progress)', async () => {
    const a = recording('a');
    const out = await catalogHousekeepingJob(() => deps, [a.step]).run(context({ budgetMs: () => 10 }).ctx, WINDOW);
    expect(out).toEqual({ done: true });
    expect(a.seen).toHaveLength(1);
  });

  it('a cancel request ends the slice after the running step (the runner then cancels the job)', async () => {
    const a = recording('a');
    const b = recording('b');
    const out = await catalogHousekeepingJob(() => deps, [a.step, b.step]).run(context({ cancelled: true }).ctx, WINDOW);
    expect(out).toEqual({ continueWith: { ...WINDOW, step: 1, cursor: null }, progress: 50 });
    expect(b.seen).toHaveLength(0);
  });

  it('a checkpoint past the last step (fewer steps after an update) ends done', async () => {
    const a = recording('a');
    expect(await catalogHousekeepingJob(() => deps, [a.step]).run(context().ctx, { ...WINDOW, step: 5, cursor: 'x' })).toEqual({ done: true });
    expect(a.seen).toHaveLength(0);
  });

  it('a cursor longer than the checkpoint allows is a bug of the step: TypeError, not a stored oversized payload', async () => {
    const a = recording('a', [{ done: false, cursor: 'x'.repeat(1025) }]);
    await expect(catalogHousekeepingJob(() => deps, [a.step]).run(context().ctx, WINDOW)).rejects.toThrow(TypeError);
  });
});
