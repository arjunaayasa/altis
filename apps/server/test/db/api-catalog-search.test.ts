import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SEARCH_TOKEN_VERSION, SLICE_BUDGET_MS, claimById, createJobRegistry, runSlice, searchHealth } from '@altis/core';
import { PHASE1_MIGRATIONS, fullTextClear, fullTextFamily, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { ReindexResponse } from '@altis/shared/api/catalog/search';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { catalogBoot } from '../../src/catalog-boot.js';
import { createJobRuntime, jobHandlers } from '../../src/jobs/runtime.js';
import { createAppOps } from '../../src/services.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { TEST_KEYRING, seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The search API of Phase 2 Task 15 (spec §4.8, §12.2, §2.3; M15) on the engine picked by ALTIS_TEST_DB:
// - `POST catalog/search/reindex` (Diagnostik's "Bangun ulang indeks"): 202 {jobId} of the one full rebuild
//   (`catalog.reindex {scope: 'all'}`, unique key `catalog.reindex:all`), joined while one is queued or running, audited
//   once per call (`catalog.search.reindex`), an Idempotency-Key replay answered from the store; 403 without
//   `system.diagnostics.manage`. The queued job is the real one: run to its end, the index is ready.
// - The boot hook (catalog-boot.ts): with `search_state` missing (the first boot, after a restore) it queues the full
//   rebuild by the system, one job however many processes boot at once; with the index there, nothing.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 29, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const REINDEX = '/api/v1/catalog/search/reindex';
const silent = { info() {}, warn() {}, error() {} };

interface Client {
  userId: string;
  post(p: string, key?: string): Promise<AgentReply>;
}

describe.skipIf(!ctx.available)(`catalog search API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let diagnostics: Client;
  let reader: Client;
  const registry = createJobRegistry(jobHandlers());

  async function signedIn(username: string, permissions: string[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { userId: user.id, post: (p, key) => agent.post(p, undefined, key === undefined ? csrf : { ...csrf, 'idempotency-key': key }) };
  }

  /** Live records `n` (not indexed), and one archived one. */
  async function seedRecords(n: number): Promise<void> {
    const buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const row = (i: number, archived: boolean) => ({
      id: newId(NOW),
      material_type_id: buku,
      title: `Hikayat Negeri ${i}`,
      subtitle: null,
      responsibility: null,
      title_key: `hikayat negeri ${i}`,
      edition: null,
      material_detail: null,
      publisher_id: null,
      publication_place: null,
      publication_year: null,
      publication_date_text: null,
      physical_desc: null,
      series: null,
      classification: null,
      call_number: null,
      language_id: null,
      content_type: null,
      media_type: null,
      carrier_type: null,
      summary: null,
      notes: null,
      cover_file_id: null,
      source: 'manual',
      merged_into: null,
      changed_at: NOW,
      archived_at: archived ? NOW : null,
      version: 0,
      created_at: NOW,
      created_by: null,
      updated_at: NOW,
      updated_by: null,
    });
    await h.db
      .insertInto('records')
      .values([...Array.from({ length: n }, (_, i) => row(i, false)), row(n, true)])
      .execute();
  }

  const reindexJobs = () =>
    h.db.selectFrom('jobs').select(['id', 'status', 'payload', 'unique_key', 'created_by']).where('type', '=', 'catalog.reindex').execute();
  const lastSeq = async (): Promise<number> =>
    Number((await h.db.selectFrom('audit_log').select((eb) => eb.fn.max('seq').as('seq')).executeTakeFirst())?.seq ?? 0);
  const entriesAfter = (seq: number) =>
    h.db
      .selectFrom('audit_log')
      .select(['action', 'actor_id', 'entity', 'entity_id', 'meta'])
      .where('seq', '>', seq)
      .orderBy('seq')
      .execute()
      .then((rows) => rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as unknown })));

  /** Runs job `id` slice by slice (the runner's claim path) to its end; its last outcome. */
  async function runToEnd(id: string): Promise<string> {
    for (let n = 0; n < 50; n += 1) {
      const job = await claimById(h, registry, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs: SLICE_BUDGET_MS, keyring: CONFIG.keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error('no end after 50 slices');
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-search-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await seedRecords(3);
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
    diagnostics = await signedIn('diagnostik', ['system.diagnostics.manage', 'system.diagnostics.read']);
    reader = await signedIn('lihat_diagnostik', ['system.diagnostics.read']);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // The index emptied as every wipe of search_doc must be (FTS5 'delete-all' first); no job, no lock left.
    await withTx(h, async (trx) => {
      await fullTextClear(trx, fullTextFamily(trx));
      for (const table of ['search_facet', 'search_doc', 'search_term', 'search_state', 'jobs', 'locks'] as const) await trx.deleteFrom(table).execute();
    });
  });

  it('POST → 202 {jobId} of catalog.reindex {scope: all} by the caller, audited once; run to its end, the index is ready', async () => {
    const seq = await lastSeq();
    const res = await diagnostics.post(REINDEX);
    expect(res.status, res.text).toBe(202);
    expect(res.json).toEqual({ jobId: expect.any(String) });
    const { jobId } = res.json as ReindexResponse;
    expect(await reindexJobs()).toEqual([
      { id: jobId, status: 'queued', payload: '{"scope":"all"}', unique_key: 'catalog.reindex:all', created_by: diagnostics.userId },
    ]);
    expect(await entriesAfter(seq)).toEqual([
      { action: 'catalog.search.reindex', actor_id: diagnostics.userId, entity: 'jobs', entity_id: jobId, meta: { scope: 'all', joined: false } },
    ]);

    expect(await runToEnd(jobId)).toBe('succeeded');
    expect(await searchHealth(h.db)).toEqual({ status: 'ready', docs: 3, records: 3, builtAt: NOW, jobId: null });
    expect(Number((await h.db.selectFrom('search_doc').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(4);
  });

  it('a rebuild already queued is joined: the same jobId, one job row, audited again (joined); a replay of its Idempotency-Key answers from the store', async () => {
    const seq = await lastSeq();
    const first = await diagnostics.post(REINDEX, 'reindex-key-1');
    expect(first.status, first.text).toBe(202);
    const { jobId } = first.json as ReindexResponse;

    const replay = await diagnostics.post(REINDEX, 'reindex-key-1');
    expect(replay.status).toBe(202);
    expect(replay.json).toEqual({ jobId });
    expect(await entriesAfter(seq)).toHaveLength(1);

    const again = await diagnostics.post(REINDEX, 'reindex-key-2');
    expect(again.status, again.text).toBe(202);
    expect(again.json).toEqual({ jobId });
    expect((await reindexJobs()).map((j) => j.id)).toEqual([jobId]);
    expect((await entriesAfter(seq)).map((e) => [e.action, e.entity_id, e.meta])).toEqual([
      ['catalog.search.reindex', jobId, { scope: 'all', joined: false }],
      ['catalog.search.reindex', jobId, { scope: 'all', joined: true }],
    ]);
  });

  it('without system.diagnostics.manage → 403; nothing queued, only the denial audited', async () => {
    const seq = await lastSeq();
    const res = await reader.post(REINDEX);
    expect(res.status).toBe(403);
    expect(await reindexJobs()).toEqual([]);
    expect((await entriesAfter(seq)).map((e) => e.action)).toEqual(['authz.denied']);
  });

  it('catalogBoot: search_state missing → the full rebuild queued by the system, one job however many processes boot at once', async () => {
    const boot = () => catalogBoot(h, { registry, keyring: TEST_KEYRING, now: NOW });
    await Promise.all([boot(), boot(), boot()]);
    await boot();
    const jobs = await reindexJobs();
    expect(jobs).toEqual([{ id: expect.any(String), status: 'queued', payload: '{"scope":"all"}', unique_key: 'catalog.reindex:all', created_by: null }]);

    // The rebuild it queued builds the index.
    expect(await runToEnd(jobs[0]!.id)).toBe('succeeded');
    expect(await searchHealth(h.db)).toMatchObject({ status: 'ready', docs: 3, records: 3 });
  });

  it('catalogBoot: with search_state present (ready, or a build the housekeeping restarts) → nothing queued', async () => {
    for (const status of ['ready', 'building'] as const) {
      await h.db.deleteFrom('search_state').execute();
      await h.db
        .insertInto('search_state')
        .values({ id: 1, status, docs: 0, job_id: null, built_at: status === 'ready' ? NOW : null, token_version: status === 'ready' ? SEARCH_TOKEN_VERSION : null })
        .execute();
      await catalogBoot(h, { registry, keyring: TEST_KEYRING, now: NOW });
      expect(await reindexJobs(), status).toEqual([]);
    }
  });

  it('catalogBoot: a ready index of another token format (NULL: from before 0029) → the full rebuild queued once; its end stores this one', async () => {
    for (const version of [null, SEARCH_TOKEN_VERSION - 1]) {
      await h.db.deleteFrom('jobs').execute();
      await h.db.deleteFrom('search_state').execute();
      await h.db.insertInto('search_state').values({ id: 1, status: 'ready', docs: 3, job_id: null, built_at: NOW, token_version: version }).execute();
      const boot = () => catalogBoot(h, { registry, keyring: TEST_KEYRING, now: NOW });
      await Promise.all([boot(), boot()]);
      const jobs = await reindexJobs();
      expect(jobs, String(version)).toEqual([{ id: expect.any(String), status: 'queued', payload: '{"scope":"all"}', unique_key: 'catalog.reindex:all', created_by: null }]);
      expect(await runToEnd(jobs[0]!.id)).toBe('succeeded');
      expect(await h.db.selectFrom('search_state').select(['status', 'token_version']).executeTakeFirstOrThrow()).toEqual({ status: 'ready', token_version: SEARCH_TOKEN_VERSION });
      await boot();
      expect((await reindexJobs()).map((j) => j.status)).toEqual(['succeeded']);
    }
  });

  it('C26: on Passenger with no cron, the boot-queued rebuild is driven from Diagnostik (POST jobs/:id/drive) slice by slice to ready', async () => {
    const state: AppState = { phase: 'ready', db: h, config: CONFIG };
    const log = recordingLogger();
    const ops = createAppOps(state, { dataDir, version: '0.1.0', log, clock: () => NOW });
    // External mode: no timer, so nothing but a cron call, a piggyback or a drive runs a job (piggyback never a heavy one).
    const runtime = createJobRuntime({
      state,
      runtime: 'passenger',
      env: {},
      dataDir,
      log,
      clock: () => NOW,
      ops,
      handlers: jobHandlers(),
      requestRestart: async () => {},
      installId: CONFIG.install.id,
      appVersion: '0.1.0',
    });
    state.jobs = runtime;
    try {
      const driven = createApp({ state, version: '0.1.0', buildId: 'b', log, clock: () => NOW, dataDir });
      const token = await sessionCookieFor(h, diagnostics.userId, { now: NOW });
      const agent = createAgent(driven);
      agent.setCookie(SID, token);
      const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };

      await catalogBoot(h, { registry, keyring: TEST_KEYRING, now: NOW });
      // "Bangun ulang indeks" joins the boot's rebuild; its JobProgress drives it while no worker runs.
      const res = await agent.post(REINDEX, undefined, csrf);
      expect(res.status, res.text).toBe(202);
      const { jobId } = res.json as ReindexResponse;
      expect((await reindexJobs()).map((j) => [j.id, j.created_by])).toEqual([[jobId, null]]);
      let status = 'queued';
      for (let n = 0; n < 20 && (status === 'queued' || status === 'running'); n += 1) {
        const drive = await agent.post(`/api/v1/jobs/${jobId}/drive`, undefined, csrf);
        expect(drive.status, drive.text).toBe(200);
        status = (drive.json as { status: string }).status;
      }
      expect(status).toBe('succeeded');
      expect(await searchHealth(h.db)).toMatchObject({ status: 'ready', docs: 3, records: 3 });
    } finally {
      await runtime.stop();
      await ops.close();
    }
  });
});
