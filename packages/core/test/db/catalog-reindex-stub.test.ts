import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { catalogHousekeepingJob, type CatalogHousekeepingStep } from '../../src/catalog/housekeeping.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import type { StorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobHandler } from '../../src/jobs/types.js';
import { enqueueReindex, reindexJob, reindexPayload, searchJobs, type ReindexScope } from '../../src/search/jobs.js';

// The reindex seam of Wave 0 (Task 3; spec §4.8, decision P2-03): `enqueueReindex` is real from the start (its unique
// keys join a reindex of the same scope that is still alive), and the stub `catalog.reindex` handler finishes at once,
// so every Wave 1 task can enqueue a reindex before Task 15 brings the real one. Also the housekeeping step context's
// `enqueue`, which a step (Task 15's) uses to queue that job.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);

describe.skipIf(!ctx.available)(`catalog.reindex (Wave 0 stub) and enqueueReindex [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  const deps = (): CatalogJobDeps => ({ dataDir: root, baseUrl: 'https://perpus.example.sch.id', keyring, storage: {} as StorageDriver, log: silent });
  const registry = () => createJobRegistry(searchJobs(deps));

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-reindex-stub-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('jobs').execute();
    await h.db.deleteFrom('locks').execute();
  });

  const reindex = (scope: ReindexScope, createdBy: string | null = null) =>
    withTx(h, (trx) => enqueueReindex(trx, registry(), scope, { now: NOW, keyring, createdBy }));
  const rows = () => h.db.selectFrom('jobs').select(['id', 'type', 'status', 'unique_key', 'payload', 'created_by']).orderBy('id').execute();

  /** Claims job `id` and runs its slices (as any process would) until it ends; its last outcome. */
  async function runToEnd(reg: ReturnType<typeof registry>, id: string): Promise<string> {
    for (let slices = 0; slices < 20; slices += 1) {
      const job = await claimById(h, reg, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error('no end after 20 slices');
  }

  it('the handler: catalog.reindex, system.diagnostics.manage, longRunning, retryable from the API', () => {
    expect(reindexJob(deps)).toMatchObject({
      type: 'catalog.reindex',
      permission: 'system.diagnostics.manage',
      retryable: 'api',
      longRunning: true,
    });
    expect(searchJobs(deps).map((j) => j.type)).toEqual(['catalog.reindex']);
  });

  it('enqueueReindex({scope: all}) twice → one queued job with the unique key catalog.reindex:all', async () => {
    const userId = newId();
    const first = await reindex({ scope: 'all' }, userId);
    const second = await reindex({ scope: 'all' });
    expect(second.jobId).toBe(first.jobId);
    const list = await rows();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: first.jobId, type: 'catalog.reindex', status: 'queued', unique_key: 'catalog.reindex:all', created_by: userId });
    expect(JSON.parse(list[0]!.payload)).toEqual({ scope: 'all' });
  });

  it('the stub handler finishes the job at once; a later reindex of the same scope is a new job', async () => {
    const reg = registry();
    const { jobId } = await reindex({ scope: 'all' });
    expect(await runToEnd(reg, jobId)).toBe('succeeded');
    const done = await h.db.selectFrom('jobs').select(['status', 'unique_key']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(done).toEqual({ status: 'succeeded', unique_key: null });
    const again = await reindex({ scope: 'all' });
    expect(again.jobId).not.toBe(jobId);
  });

  it('the unique key per scope: agent, subject and publisher join their own; record lists never join', async () => {
    const [agent, other, subject, publisher, r1, r2] = [newId(), newId(), newId(), newId(), newId(), newId()];
    const a1 = await reindex({ agentId: agent });
    expect((await reindex({ agentId: agent })).jobId).toBe(a1.jobId);
    expect((await reindex({ agentId: other })).jobId).not.toBe(a1.jobId);
    expect((await reindex({ subjectId: subject })).jobId).toBe((await reindex({ subjectId: subject })).jobId);
    expect((await reindex({ publisherId: publisher })).jobId).toBe((await reindex({ publisherId: publisher })).jobId);
    const l1 = await reindex({ recordIds: [r1, r2] });
    const l2 = await reindex({ recordIds: [r1, r2] });
    expect(l2.jobId).not.toBe(l1.jobId);
    const keys = (await rows()).map((r) => r.unique_key);
    expect(keys.filter((k) => k !== null).sort()).toEqual(
      [
        `catalog.reindex:agent:${agent}`,
        `catalog.reindex:agent:${other}`,
        `catalog.reindex:subject:${subject}`,
        `catalog.reindex:publisher:${publisher}`,
      ].sort(),
    );
    expect(keys.filter((k) => k === null)).toHaveLength(2); // the two record lists
  });

  it('reindexPayload: exactly one scope, with an optional cursor and phase (and the full rebuild its token format); at most 1000 record ids', () => {
    const id = newId();
    for (const ok of [
      { scope: 'all' },
      { scope: 'all', cursor: null, phase: 'docs' },
      { scope: 'all', cursor: id, phase: 'terms' },
      { scope: 'all', cursor: id, phase: 'docs', tokenVersion: 1 },
      { recordIds: [id] },
      { recordIds: Array.from({ length: 1000 }, () => id) },
      { agentId: id },
      { subjectId: id, cursor: id },
      { publisherId: id, phase: 'docs' },
    ]) {
      expect(reindexPayload.safeParse(ok).success, JSON.stringify(ok).slice(0, 80)).toBe(true);
    }
    for (const bad of [
      {},
      { scope: 'some' },
      { scope: 'all', agentId: id },
      { recordIds: [] },
      { recordIds: Array.from({ length: 1001 }, () => id) },
      { recordIds: ['nope'] },
      { agentId: 'nope' },
      { scope: 'all', phase: 'other' },
      { scope: 'all', cursor: 'x'.repeat(513) },
      { scope: 'all', extra: 1 },
      { scope: 'all', phase: 'docs', tokenVersion: 1.5 },
      { scope: 'terms', phase: 'terms', tokenVersion: 1 },
      { agentId: id, tokenVersion: 1 },
    ]) {
      expect(reindexPayload.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it('a payload the schema refuses is VALIDATION_FAILED, and nothing is queued', async () => {
    await expect(reindex({ recordIds: [] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await rows()).toEqual([]);
  });

  it('the housekeeping step context enqueues a catalog job (here a reindex) with its unique key, joining a live one', async () => {
    const queueing: CatalogHousekeepingStep = {
      name: 'queueing',
      async run(c) {
        await c.enqueue('catalog.reindex', { scope: 'all' }, 'catalog.reindex:all');
        await c.enqueue('catalog.reindex', { scope: 'all' }, 'catalog.reindex:all');
        return { done: true, cursor: null };
      },
    };
    const housekeeping: JobHandler<unknown> = catalogHousekeepingJob(deps, [queueing]) as JobHandler<unknown>;
    const reg = createJobRegistry([housekeeping, ...searchJobs(deps)]);
    const { id } = await withTx(h, (trx) =>
      enqueue(trx, reg, { type: 'catalog.housekeeping', payload: { windowStart: NOW - 1, windowEnd: NOW } }, { now: NOW, keyring }),
    );
    expect(await runToEnd(reg, id)).toBe('succeeded');
    const queued = (await rows()).filter((r) => r.type === 'catalog.reindex');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: 'queued', unique_key: 'catalog.reindex:all', created_by: null });
    // ... and the stub runs it to its end.
    expect(await runToEnd(reg, queued[0]!.id)).toBe('succeeded');
  });

  it('the step context refuses a job type outside the catalog jobs (a TypeError, the slice fails)', async () => {
    const wrong: CatalogHousekeepingStep = {
      name: 'wrong',
      run: async (c) => (await c.enqueue('backup.create', {}, null), { done: true, cursor: null }),
    };
    const reg = createJobRegistry([catalogHousekeepingJob(deps, [wrong]) as JobHandler<unknown>, ...searchJobs(deps)]);
    const { id } = await withTx(h, (trx) =>
      enqueue(trx, reg, { type: 'catalog.housekeeping', payload: { windowStart: NOW - 1, windowEnd: NOW }, maxAttempts: 1 }, { now: NOW, keyring }),
    );
    expect(await runToEnd(reg, id)).toBe('dead');
    expect((await rows()).filter((r) => r.type !== 'catalog.housekeeping')).toEqual([]);
  });
});
