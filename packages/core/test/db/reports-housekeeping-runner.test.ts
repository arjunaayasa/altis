import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import type { StorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobHandler, JobRegistry } from '../../src/jobs/types.js';
import {
  REPORTS_HOUSEKEEPING_STEPS,
  reportsHousekeepingJob,
  type ReportsHousekeepingStep,
} from '../../src/reports/housekeeping/index.js';
import { writeSettings } from '../../src/settings/service.js';

// The runner of `reports.housekeeping` with steps of its own (the real steps are written later): the steps run in
// order across slices, a step that stops hands its cursor to the next slice, and while the clock looks wrong every
// step whose work depends on an age is skipped and the job ends with the message `date_jobs_postponed`.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 10, 14, 20, 50, 0);

describe('the reports housekeeping steps and handler', () => {
  it('the steps in order, the abandoned runs and the work folders not age-based; the handler as the schedule names it', () => {
    expect(REPORTS_HOUSEKEEPING_STEPS.map((s) => [s.name, s.ageBased])).toEqual([
      ['abandoned_runs', false],
      ['expired_runs', true],
      ['report_files', true],
      ['work_dirs', false],
      ['orphan_uploads', true],
      // ---- Komunitas (notices) ----
      ['notices', true],
      // ---- Komunitas (OPAC home page) ----
      ['popular_titles', true],
    ]);
    expect(Object.isFrozen(REPORTS_HOUSEKEEPING_STEPS)).toBe(true);
    const handler = reportsHousekeepingJob(() => ({}) as CatalogJobDeps);
    expect(handler).toMatchObject({ type: 'reports.housekeeping', permission: 'system.jobs.manage', retryable: 'api' });
    expect(handler.payload.safeParse({ windowStart: 1, windowEnd: 2 }).success).toBe(true);
    expect(handler.payload.safeParse({ windowStart: 1, windowEnd: 2, step: 3, cursor: 'x'.repeat(1024) }).success).toBe(true);
    expect(handler.payload.safeParse({ windowStart: 1, windowEnd: 2, cursor: 'x'.repeat(1025) }).success).toBe(false);
  });
});

describe.skipIf(!ctx.available)(`reports.housekeeping runner [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  const deps = (): CatalogJobDeps => ({ dataDir: root, baseUrl: 'https://perpus.example.sch.id', keyring, storage: {} as StorageDriver, log: silent });

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-reports-housekeeping-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('jobs').execute();
    await h.db.deleteFrom('locks').execute();
    await h.db.deleteFrom('settings').where('key', '=', 'system.clock_anomaly').execute();
  });

  /** A registry with the housekeeping job over `steps`. */
  const registryOf = (steps: readonly ReportsHousekeepingStep[]): JobRegistry =>
    createJobRegistry([reportsHousekeepingJob(deps, steps) as JobHandler<unknown>]);

  const queue = (reg: JobRegistry) =>
    withTx(h, (trx) => enqueue(trx, reg, { type: 'reports.housekeeping', payload: { windowStart: NOW - 86_400_000, windowEnd: NOW } }, { now: NOW, keyring }));

  /** Claims job `id` and runs its slices until it ends; the outcomes of every slice. */
  async function runToEnd(reg: JobRegistry, id: string): Promise<string[]> {
    const outcomes: string[] = [];
    for (let slices = 0; slices < 20; slices += 1) {
      const job = await claimById(h, reg, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => NOW, env: {} });
      outcomes.push(r.outcome);
      if (r.outcome !== 'continued') return outcomes;
    }
    throw new Error('no end after 20 slices');
  }

  const jobRow = (id: string) => h.db.selectFrom('jobs').select(['status', 'progress_message', 'payload']).where('id', '=', id).executeTakeFirstOrThrow();

  /** A step that records its calls (name and cursor) and answers `answers` in turn (then done). */
  function fake(name: string, ageBased: boolean, calls: string[], answers: { done: boolean; cursor: string | null }[] = []): ReportsHousekeepingStep {
    let n = 0;
    return {
      name,
      ageBased,
      run: async (c) => {
        calls.push(`${name}:${c.cursor ?? '-'}`);
        expect(c.now).toBe(NOW);
        expect(c.deps.dataDir).toBe(root);
        const answer = answers[n] ?? { done: true, cursor: null };
        n += 1;
        return answer;
      },
    };
  }

  it('runs the steps in order in one slice while the budget lasts, and ends without a message', async () => {
    const calls: string[] = [];
    const reg = registryOf([fake('a', true, calls), fake('b', false, calls), fake('c', true, calls)]);
    const { id } = await queue(reg);
    expect(await runToEnd(reg, id)).toEqual(['succeeded']);
    expect(calls).toEqual(['a:-', 'b:-', 'c:-']);
    expect(await jobRow(id)).toMatchObject({ status: 'succeeded', progress_message: null });
  });

  it('a step that stops resumes in the next slice with the cursor it returned, the steps before it not run again', async () => {
    const calls: string[] = [];
    const reg = registryOf([
      fake('a', true, calls),
      fake('b', true, calls, [
        { done: false, cursor: 'x' },
        { done: false, cursor: 'y' },
      ]),
      fake('c', false, calls),
    ]);
    const { id } = await queue(reg);
    expect(await runToEnd(reg, id)).toEqual(['continued', 'continued', 'succeeded']);
    expect(calls).toEqual(['a:-', 'b:-', 'b:x', 'b:y', 'c:-']);
  });

  it('while the clock looks wrong the age-based steps are not called, and the job ends with date_jobs_postponed', async () => {
    await withTx(h, (trx) => writeSettings(trx, { 'system.clock_anomaly': { detectedAt: NOW, maxSeen: NOW + 86_400_000 } }, { keyring: [], now: NOW, actorId: null }));
    const calls: string[] = [];
    const reg = registryOf([fake('a', true, calls), fake('work', false, calls, [{ done: false, cursor: 'w' }]), fake('c', true, calls)]);
    const { id } = await queue(reg);
    expect(await runToEnd(reg, id)).toEqual(['continued', 'succeeded']);
    expect(calls).toEqual(['work:-', 'work:w']);
    expect(await jobRow(id)).toMatchObject({ status: 'succeeded', progress_message: 'date_jobs_postponed' });
  });

  it('a skip in an earlier slice is remembered until the end', async () => {
    await withTx(h, (trx) => writeSettings(trx, { 'system.clock_anomaly': { detectedAt: NOW, maxSeen: NOW + 86_400_000 } }, { keyring: [], now: NOW, actorId: null }));
    const calls: string[] = [];
    const reg = registryOf([fake('a', true, calls), fake('work', false, calls, [{ done: false, cursor: 'w' }])]);
    const { id } = await queue(reg);
    const job = await claimById(h, reg, id, { worker: 'test', now: NOW });
    await runSlice(h, reg, job!, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => NOW, env: {} });
    expect(JSON.parse((await jobRow(id)).payload)).toMatchObject({ step: 1, cursor: 'w', postponed: true });
    expect(await runToEnd(reg, id)).toEqual(['succeeded']);
    expect(await jobRow(id)).toMatchObject({ progress_message: 'date_jobs_postponed' });
  });

  it('the real steps, not written yet, run to the end at once', async () => {
    const reg = createJobRegistry([reportsHousekeepingJob(deps) as JobHandler<unknown>]);
    const { id } = await queue(reg);
    expect(await runToEnd(reg, id)).toEqual(['succeeded']);
  });
});
