import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { DeleteQueryNode, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { catalogHousekeepingJob } from '../../src/catalog/housekeeping.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import type { StorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { requestCancel, retryJob } from '../../src/jobs/service.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobHandler, JobRegistry, SliceResult } from '../../src/jobs/types.js';
import { searchHealth } from '../../src/search/health.js';
import { searchHousekeepingStep } from '../../src/search/housekeeping.js';
import { indexRecords } from '../../src/search/index-records.js';
import { enqueueReindex, reindexJob, searchJobs, type ReindexScope } from '../../src/search/jobs.js';
import { searchCatalog } from '../../src/search/search.js';
import { SEARCH_TOKEN_VERSION } from '../../src/search/tokenize.js';
import { finishSeededIndex, seedCatalog, wipeCatalog, type SeedRecord } from '../support/search-corpus.js';

// The real `catalog.reindex` (Phase 2 spec §4.8, §12.6; C38): the full rebuild sliced (state building, index emptied
// with FTS5 'delete-all', keyset batches of 500, then search_term, then ready), stopped after its second slice and
// resumed elsewhere; a batch run twice; the authority and record scopes; the vocabulary refresh and its yielding to a
// full rebuild; cancellation; `catalog.bulk.changed` per batch; the housekeeping step's choice of job.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);

describe.skipIf(!ctx.available)(`catalog.reindex [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  const deps = (): CatalogJobDeps => ({ dataDir: root, baseUrl: 'https://perpus.example.sch.id', keyring, storage: {} as StorageDriver, log: silent });
  const registry = (): JobRegistry => createJobRegistry(searchJobs(deps));

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-search-reindex-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    if (h !== undefined) await wipeCatalog(h);
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await wipeCatalog(h);
  });

  const reindex = (scope: ReindexScope, reg: JobRegistry = registry()) =>
    withTx(h, (trx) => enqueueReindex(trx, reg, scope, { now: NOW, keyring, createdBy: null }));

  /** Claims job `id` (as worker `worker`) and runs one slice of `budgetMs`. */
  async function slice(reg: JobRegistry, id: string, budgetMs: number, worker = 'test'): Promise<SliceResult> {
    const job = await claimById(h, reg, id, { worker, now: NOW });
    if (job === null) throw new Error(`job ${id} cannot be claimed`);
    return runSlice(h, reg, job, { mode: 'worker', budgetMs, keyring, log: silent, clock: () => NOW, env: {} });
  }

  /** Runs job `id` to its end with full slices; its last outcome. */
  async function runToEnd(reg: JobRegistry, id: string, worker = 'test'): Promise<string> {
    for (let n = 0; n < 50; n += 1) {
      const r = await slice(reg, id, 20_000, worker);
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error('no end after 50 slices');
  }

  /** Runs every queued `catalog.reindex` to its end, in claim order (run_at, id), until none is queued. */
  async function drain(reg: JobRegistry): Promise<void> {
    for (let n = 0; n < 20; n += 1) {
      const next = await h.db.selectFrom('jobs').select('id').where('type', '=', 'catalog.reindex').where('status', '=', 'queued').orderBy('run_at').orderBy('id').executeTakeFirst();
      if (next === undefined) return;
      await runToEnd(reg, next.id);
    }
    throw new Error('the reindex jobs did not drain');
  }

  const payloadOf = async (id: string) => JSON.parse((await h.db.selectFrom('jobs').select('payload').where('id', '=', id).executeTakeFirstOrThrow()).payload) as Record<string, unknown>;
  const docCount = async () => Number((await h.db.selectFrom('search_doc').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
  const total = async (text: string) => (await searchCatalog(h.db, { text, scope: 'admin', pageSize: 1 }, { now: NOW })).total;
  const opac = async (text: string) => (await searchCatalog(h.db, { text, scope: 'opac', pageSize: 200 }, { now: NOW })).recordIds;
  const bulkEvents = async (jobId: string) =>
    (await h.db.selectFrom('events').select(['channel', 'type', 'payload']).where('type', '=', 'catalog.bulk.changed').execute()).filter(
      (e) => (JSON.parse(e.payload) as { runId?: string }).runId === jobId,
    );

  /** 1 200 records: 1 197 public ones titled `Gulungan <n>`, one hidden, two archived; not indexed. */
  const RECORDS: SeedRecord[] = Array.from({ length: 1200 }, (_, i) => ({
    key: `g${i}`,
    title: `Gulungan naskah ${i}`,
    subjects: [i % 2 === 0 ? 'Naskah Kuno' : 'Sastra Lisan'],
    ...(i === 0 ? { hidden: true } : {}),
    ...(i === 1 || i === 2 ? { archived: true } : {}),
  }));

  it('all: stopped after its second slice and resumed by another worker → every record indexed, search_term filled, ready', async () => {
    const seeded = await seedCatalog(h, RECORDS, { now: NOW - 3_600_000, index: false });
    const reg = registry();
    const { jobId } = await reindex({ scope: 'all' }, reg);

    // Slice 1 (a budget of 1 ms: one step a slice): building, the index emptied.
    expect((await slice(reg, jobId, 1)).outcome).toBe('continued');
    expect(await payloadOf(jobId)).toEqual({ scope: 'all', phase: 'docs', cursor: null, tokenVersion: SEARCH_TOKEN_VERSION });
    expect(await searchHealth(h.db)).toMatchObject({ status: 'building', docs: 0, records: 1198, jobId });
    expect((await h.db.selectFrom('search_state').select(['status', 'job_id']).executeTakeFirstOrThrow())).toEqual({ status: 'building', job_id: jobId });

    // Slice 2: the first batch of 500.
    expect((await slice(reg, jobId, 1)).outcome).toBe('continued');
    expect(await docCount()).toBe(500);
    expect((await payloadOf(jobId))['phase']).toBe('docs');
    // The OPAC sees the partial index, and says so.
    expect(await searchCatalog(h.db, { text: '', scope: 'opac' }, { now: NOW })).toMatchObject({ building: true });

    // Meanwhile a write path saves a record of its own (indexed in its transaction) and one record is archived.
    const [late] = (await seedCatalog(h, [{ key: 'late', title: 'Naskah terlambat datang' }], { now: NOW })).values();
    const first = seeded.get('g10')!;
    await withTx(h, async (trx) => {
      await trx.updateTable('records').set({ archived_at: NOW }).where('id', '=', first).execute();
      await indexRecords(trx, [first], NOW);
    });

    // Stopped here; another worker (a fresh registry, as another process) resumes from the checkpoint.
    expect(await runToEnd(registry(), jobId, 'other')).toBe('succeeded');
    const health = await searchHealth(h.db);
    expect(health).toEqual({ status: 'ready', docs: health.records, records: 1198, builtAt: NOW, jobId: null });
    expect(await docCount()).toBe(1201); // every record, the archived ones too
    expect(await h.db.selectFrom('search_state').select(['status', 'docs', 'job_id', 'built_at']).executeTakeFirstOrThrow()).toEqual({
      status: 'ready',
      docs: 1201,
      job_id: null,
      built_at: NOW,
    });
    expect(await opac('terlambat')).toEqual([late]);
    expect((await opac('gulungan')).length).toBe(200); // a page of the 1 196 public ones

    // search_term: the words of the public documents with their document frequency.
    const terms = new Map((await h.db.selectFrom('search_term').select(['term', 'df', 'first_char', 'len']).execute()).map((t) => [t.term, t]));
    expect(terms.get('gulungan')).toEqual({ term: 'gulungan', df: 1196, first_char: 'g', len: 8 });
    expect(terms.get('naskah')?.df).toBe(1197);
    expect(terms.has('kuno')).toBe(true);
    expect([...terms.keys()].every((t) => /^\p{L}{3,84}$/u.test(t))).toBe(true);

    // One catalog.bulk.changed per transaction that changed documents: the clear and three batches.
    const events = await bulkEvents(jobId);
    expect(events.length).toBe(4);
    expect(events.every((e) => e.channel === 'catalog')).toBe(true);
  });

  it('all: a docs batch run twice (a slice killed after its commit, before its checkpoint) changes nothing', async () => {
    await seedCatalog(h, RECORDS.slice(0, 600), { now: NOW - 3_600_000, index: false });
    const reg = registry();
    const { jobId } = await reindex({ scope: 'all' }, reg);
    await slice(reg, jobId, 1); // the clear
    const before = await payloadOf(jobId);
    await slice(reg, jobId, 1); // batch 1
    // The checkpoint of slice 2 is lost: the job goes back to the one before it.
    await h.db.updateTable('jobs').set({ payload: JSON.stringify(before) }).where('id', '=', jobId).execute();
    expect(await runToEnd(reg, jobId)).toBe('succeeded');
    expect(await docCount()).toBe(600);
    expect(await searchHealth(h.db)).toMatchObject({ status: 'ready', docs: 598, records: 598 });
  });

  it('X2-2: all, resumed under another token format (an update changed the tokenizer midway) → starts again from the clear, ready with this format', async () => {
    await seedCatalog(h, RECORDS.slice(0, 600), { now: NOW - 3_600_000, index: false });
    const reg = registry();
    // The checkpoint of a build started under an older tokenizer, and of one written by a release that recorded none.
    for (const older of [{ tokenVersion: SEARCH_TOKEN_VERSION - 1 }, {}]) {
      const { jobId } = await reindex({ scope: 'all' }, reg);
      await slice(reg, jobId, 1); // the clear
      expect(await payloadOf(jobId)).toEqual({ scope: 'all', phase: 'docs', cursor: null, tokenVersion: SEARCH_TOKEN_VERSION });
      await slice(reg, jobId, 1); // batch 1, 500 documents
      expect(await docCount()).toBe(500);
      const checkpoint = await payloadOf(jobId);
      delete checkpoint['tokenVersion'];
      await h.db.updateTable('jobs').set({ payload: JSON.stringify({ ...checkpoint, ...older }) }).where('id', '=', jobId).execute();
      await slice(reg, jobId, 1); // the clear again: the 500 documents of the other format are gone
      expect([await docCount(), await payloadOf(jobId)]).toEqual([0, { scope: 'all', phase: 'docs', cursor: null, tokenVersion: SEARCH_TOKEN_VERSION }]);
      expect(await runToEnd(reg, jobId)).toBe('succeeded');
      expect(await docCount()).toBe(600);
      expect(await h.db.selectFrom('search_state').select(['status', 'docs', 'token_version']).executeTakeFirstOrThrow()).toEqual({
        status: 'ready',
        docs: 600,
        token_version: SEARCH_TOKEN_VERSION,
      });
    }
  });

  it('all: cancelled midway → cancelled, the state stays building; the housekeeping step queues a new rebuild', async () => {
    await seedCatalog(h, RECORDS.slice(0, 600), { now: NOW - 3_600_000, index: false });
    const reg = registry();
    const { jobId } = await reindex({ scope: 'all' }, reg);
    await slice(reg, jobId, 1);
    expect(await withTx(h, (trx) => requestCancel(trx, jobId, NOW))).toBe('cancelled');
    expect(await searchHealth(h.db)).toMatchObject({ status: 'building', jobId: null });
    const housekeeping = catalogHousekeepingJob(deps, [searchHousekeepingStep]) as JobHandler<unknown>;
    const hk = createJobRegistry([housekeeping, ...searchJobs(deps)]);
    const { id } = await withTx(h, (trx) => enqueue(trx, hk, { type: 'catalog.housekeeping', payload: { windowStart: NOW - 1, windowEnd: NOW } }, { now: NOW, keyring }));
    expect(await runToEnd(hk, id)).toBe('succeeded');
    const queued = await h.db.selectFrom('jobs').select(['payload', 'unique_key', 'status']).where('type', '=', 'catalog.reindex').where('status', '=', 'queued').execute();
    expect(queued).toEqual([{ payload: '{"scope":"all"}', unique_key: 'catalog.reindex:all', status: 'queued' }]);
  });

  it('agent, subject and publisher scopes: the linked records get changed_at = now and their documents rewritten', async () => {
    const ids = await seedCatalog(
      h,
      [
        { key: 'a1', title: 'Satu', agents: ['Penulis, Lama'], subjects: ['Topik Lama'], publisher: { name: 'Penerbit Lama' } },
        { key: 'a2', title: 'Dua', agents: ['Penulis, Lama', 'Penyunting, Lain'] },
        { key: 'x', title: 'Tiga', agents: ['Orang, Lain'] },
      ],
      { now: NOW - 3_600_000 },
    );
    await finishSeededIndex(h, NOW - 3_600_000);
    const reg = registry();
    const changedAt = async (key: string) => (await h.db.selectFrom('records').select('changed_at').where('id', '=', ids.get(key)!).executeTakeFirstOrThrow()).changed_at;

    const agent = (await h.db.selectFrom('agents').select('id').where('name_display', '=', 'Penulis, Lama').executeTakeFirstOrThrow()).id;
    await h.db.updateTable('agents').set({ name_display: 'Penulis, Baruan' }).where('id', '=', agent).execute();
    expect(await opac('baruan')).toEqual([]);
    expect(await runToEnd(reg, (await reindex({ agentId: agent }, reg)).jobId)).toBe('succeeded');
    expect((await opac('baruan')).sort()).toEqual([ids.get('a1')!, ids.get('a2')!].sort());
    expect(await changedAt('a1')).toBe(NOW);
    expect(await changedAt('a2')).toBe(NOW);
    expect(await changedAt('x')).toBe(NOW - 3_600_000 + 180_000);

    const subject = (await h.db.selectFrom('subjects').select('id').where('term_display', '=', 'Topik Lama').executeTakeFirstOrThrow()).id;
    await h.db.updateTable('subjects').set({ term_display: 'Topik Kebaruan' }).where('id', '=', subject).execute();
    expect(await runToEnd(reg, (await reindex({ subjectId: subject }, reg)).jobId)).toBe('succeeded');
    expect(await opac('kebaruan')).toEqual([ids.get('a1')!]);

    const publisher = (await h.db.selectFrom('publishers').select('id').executeTakeFirstOrThrow()).id;
    await h.db.updateTable('publishers').set({ name_display: 'Penerbit Terkini' }).where('id', '=', publisher).execute();
    expect(await runToEnd(reg, (await reindex({ publisherId: publisher }, reg)).jobId)).toBe('succeeded');
    expect(await opac('terkini')).toEqual([ids.get('a1')!]);
    expect(await changedAt('x')).toBe(NOW - 3_600_000 + 180_000);
  });

  it('C04/C06: a rename while the agent reindex is past its first batch queues a new pass; every record ends with the last name', async () => {
    await seedCatalog(h, Array.from({ length: 700 }, (_, i) => ({ key: `r${i}`, title: `Risalah ${i}`, agents: ['Penulis, Lama'] })), { now: NOW - 3_600_000 });
    await finishSeededIndex(h, NOW - 3_600_000);
    const reg = registry();
    const agent = (await h.db.selectFrom('agents').select('id').where('name_display', '=', 'Penulis, Lama').executeTakeFirstOrThrow()).id;
    await h.db.updateTable('agents').set({ name_display: 'Penulis, Ejaanpertama' }).where('id', '=', agent).execute();
    const first = await reindex({ agentId: agent }, reg);
    expect((await slice(reg, first.jobId, 1)).outcome).toBe('continued'); // one batch of 500, cursor set
    expect((await payloadOf(first.jobId))['cursor']).toEqual(expect.any(String));

    await h.db.updateTable('agents').set({ name_display: 'Penulis, Ejaankedua' }).where('id', '=', agent).execute();
    const second = await reindex({ agentId: agent }, reg);
    // A request while that pass has not started is joined (one pass covers both).
    const third = await reindex({ agentId: agent }, reg);
    expect(third).toEqual({ jobId: second.jobId, existing: true });
    await drain(reg);
    expect(await total('ejaankedua')).toBe(700);
    expect(await total('ejaanpertama')).toBe(0);
    expect(second).toEqual({ jobId: expect.not.stringMatching(first.jobId), existing: false });
    const jobs = await h.db.selectFrom('jobs').select(['id', 'status', 'unique_key']).where('type', '=', 'catalog.reindex').orderBy('id').execute();
    expect(jobs).toEqual([
      { id: first.jobId, status: 'succeeded', unique_key: null },
      { id: second.jobId, status: 'succeeded', unique_key: null },
    ]);
  }, 120_000);

  it('C04/C24: a merge into the target while its reindex is past its first batch re-indexes the moved records below the cursor', async () => {
    const moved = await seedCatalog(h, Array.from({ length: 100 }, (_, i) => ({ key: `m${i}`, title: `Cabang ${i}`, agents: ['Sumber, Kedua'] })), { now: NOW - 3_600_000 });
    await seedCatalog(h, Array.from({ length: 700 }, (_, i) => ({ key: `t${i}`, title: `Batang ${i}`, agents: ['Sasaran, Utama'] })), { now: NOW - 3_600_000 });
    await finishSeededIndex(h, NOW - 3_600_000);
    const reg = registry();
    const agentId = async (name: string) => (await h.db.selectFrom('agents').select('id').where('name_display', '=', name).executeTakeFirstOrThrow()).id;
    const target = await agentId('Sasaran, Utama');
    const source = await agentId('Sumber, Kedua');
    const first = await reindex({ agentId: target }, reg);
    expect((await slice(reg, first.jobId, 1)).outcome).toBe('continued');
    const cursor = (await payloadOf(first.jobId))['cursor'] as string;
    const below = [...moved.values()].filter((id) => id < cursor);
    expect(below.length).toBeGreaterThan(0);

    // The merge: the source's links move to the target, and the route queues the target's reindex.
    await h.db.updateTable('record_agents').set({ agent_id: target }).where('agent_id', '=', source).execute();
    await reindex({ agentId: target }, reg);
    await drain(reg);
    const rows = await h.db.selectFrom('search_doc').select(['record_id', 't_agents', 'changed_at']).where('record_id', 'in', [...moved.values()]).execute();
    expect(rows).toHaveLength(100);
    expect(rows.filter((r) => !r.t_agents.includes('sasaran')).map((r) => r.record_id)).toEqual([]);
    const stamps = await h.db.selectFrom('records').select('changed_at').where('id', 'in', below).execute();
    expect(stamps.every((r) => Number(r.changed_at) === NOW)).toBe(true);
  }, 120_000);

  it('C06/C24: a change-driven full rebuild while one is past its first batch supersedes it; a plain rebuild request joins', async () => {
    await seedCatalog(h, RECORDS.map((r) => ({ ...r, agents: ['Penyusun, Awal'] })), { now: NOW - 3_600_000, index: false });
    const reg = registry();
    const full = await reindex({ scope: 'all' }, reg);
    await slice(reg, full.jobId, 1); // the clear
    await slice(reg, full.jobId, 1); // batch 1 of 500
    expect(await docCount()).toBe(500);
    // A plain rebuild request (the route, the CLI, the boot) joins the one already running (M15).
    expect(await reindex({ scope: 'all' }, reg)).toEqual({ jobId: full.jobId, existing: true });

    // A change the index must show everywhere (a location move or a custom field over the list limits).
    await h.db.updateTable('agents').set({ name_display: 'Penyusun, Akhir' }).execute();
    const change = await withTx(h, (trx) => enqueueReindex(trx, reg, { scope: 'all' }, { now: NOW, keyring, createdBy: null, changed: true }));
    expect(change.existing).toBe(false);
    expect(change.jobId).not.toBe(full.jobId);
    // A later plain request joins the new one, which has not started.
    expect(await reindex({ scope: 'all' }, reg)).toEqual({ jobId: change.jobId, existing: true });

    // The new one starts (state building, index emptied); the superseded one, run again, ends at once and writes nothing.
    await slice(reg, change.jobId, 1);
    expect(await searchHealth(h.db)).toMatchObject({ status: 'building', docs: 0, jobId: change.jobId });
    expect((await slice(reg, full.jobId, 20_000)).outcome).toBe('succeeded');
    expect(await docCount()).toBe(0);
    expect(await searchHealth(h.db)).toMatchObject({ status: 'building', jobId: change.jobId });

    await drain(reg);
    expect(await searchHealth(h.db)).toMatchObject({ status: 'ready', docs: 1198, records: 1198 });
    expect(await docCount()).toBe(1200);
    expect(await total('akhir')).toBe(await total('gulungan'));
    expect(await total('akhir')).toBeGreaterThan(1000);
    expect(await total('awal')).toBe(0);
  }, 120_000);

  it('C06/C24: a superseded rebuild whose successor already ended stays superseded: its next slice ends at once, writing nothing', async () => {
    await seedCatalog(h, RECORDS.map((r) => ({ ...r, agents: ['Penyusun, Awal'] })), { now: NOW - 3_600_000, index: false });
    const reg = registry();
    const full = await reindex({ scope: 'all' }, reg);
    await slice(reg, full.jobId, 1); // the clear
    await slice(reg, full.jobId, 1); // batch 1 of 500
    await h.db.updateTable('agents').set({ name_display: 'Penyusun, Akhir' }).execute();
    const change = await withTx(h, (trx) => enqueueReindex(trx, reg, { scope: 'all' }, { now: NOW, keyring, createdBy: null, changed: true }));
    // The new rebuild runs to its end before the old one's next slice (a small catalogue fits in one slice), so no job
    // holds the key any more when the old one comes back.
    expect(await runToEnd(reg, change.jobId)).toBe('succeeded');
    expect(await searchHealth(h.db)).toMatchObject({ status: 'ready', docs: 1198, jobId: null });
    const events = (await bulkEvents(full.jobId)).length;
    const terms = Number((await h.db.selectFrom('search_term').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    expect(terms).toBeGreaterThan(0);
    // The daily refresh may write search_term now; the old job must never clear or rebuild it again.
    const one = (await h.db.selectFrom('search_term').select('term').orderBy('term').limit(1).executeTakeFirstOrThrow()).term;
    await h.db.deleteFrom('search_term').where('term', '=', one).execute();
    expect((await slice(reg, full.jobId, 20_000)).outcome).toBe('succeeded');
    const old = await h.db.selectFrom('jobs').select(['status', 'progress_message', 'unique_key']).where('id', '=', full.jobId).executeTakeFirstOrThrow();
    expect(old).toEqual({ status: 'succeeded', progress_message: 'Digantikan tugas yang lebih baru / Superseded by a newer job', unique_key: null });
    expect((await bulkEvents(full.jobId)).length).toBe(events);
    expect(Number((await h.db.selectFrom('search_term').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(terms - 1);
    expect(await searchHealth(h.db)).toMatchObject({ status: 'ready', docs: 1198, jobId: null });
  }, 120_000);

  it('C06/C24: a dead full rebuild retried (it has no unique key any more) is not taken for a superseded one: it rebuilds', async () => {
    await seedCatalog(h, RECORDS.slice(0, 30).map((r) => ({ ...r, hidden: false, archived: false })), { now: NOW - 3_600_000, index: false });
    const reg = registry();
    const full = await reindex({ scope: 'all' }, reg);
    await slice(reg, full.jobId, 1); // the clear
    // It dies (as claim and slice end a job past its attempts): no key, its checkpoint kept.
    await h.db.updateTable('jobs').set({ status: 'dead', unique_key: null, lock_token: null, locked_by: null, locked_until: null, finished_at: NOW }).where('id', '=', full.jobId).execute();
    await withTx(h, (trx) => retryJob(trx, reg, full.jobId, NOW));
    expect(await runToEnd(reg, full.jobId)).toBe('succeeded');
    expect((await h.db.selectFrom('jobs').select('progress_message').where('id', '=', full.jobId).executeTakeFirstOrThrow()).progress_message).toBeNull();
    expect(await searchHealth(h.db)).toMatchObject({ status: 'ready', docs: 30 });
    expect(await docCount()).toBe(30);
  }, 120_000);

  it('C14: an authority reindex stamps changed_at with the clock at the end of its batch, after the documents are built', async () => {
    const ids = await seedCatalog(h, [{ key: 'a', title: 'Hikayat satu', agents: ['Juru, Tulis'] }, { key: 'b', title: 'Hikayat dua', agents: ['Juru, Tulis'] }], {
      now: NOW - 3_600_000,
    });
    await finishSeededIndex(h, NOW - 3_600_000);
    const agent = (await h.db.selectFrom('agents').select('id').where('name_display', '=', 'Juru, Tulis').executeTakeFirstOrThrow()).id;
    const reg = registry();
    const { jobId } = await reindex({ agentId: agent }, reg);
    // At the batch's first DELETE (inside indexRecords) the clock moves on 5 s: a harvest reading the old datestamps
    // while the batch is open answers that time as its responseDate, its next `from`.
    let clock = NOW;
    let paused = false;
    const plugin: KyselyPlugin = {
      transformQuery({ node }) {
        if (!paused && DeleteQueryNode.is(node)) {
          paused = true;
          clock = NOW + 5000;
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    };
    const watched = { ...h, db: h.db.withPlugin(plugin) };
    const job = await claimById(watched, reg, jobId, { worker: 'test', now: NOW });
    if (job === null) throw new Error('the reindex cannot be claimed');
    const r = await runSlice(watched, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => clock, env: {} });
    expect(r.outcome).toBe('succeeded');
    expect(paused).toBe(true);
    const stamps = await h.db.selectFrom('records').select('changed_at').where('id', 'in', [...ids.values()]).execute();
    expect(stamps.map((x) => Number(x.changed_at))).toEqual([NOW + 5000, NOW + 5000]);
    const docs = await h.db.selectFrom('search_doc').select('changed_at').where('record_id', 'in', [...ids.values()]).execute();
    expect(docs.map((x) => Number(x.changed_at))).toEqual([NOW + 5000, NOW + 5000]);
  });

  it('recordIds: those documents rewritten in batches of 500 (changed_at left to the caller), sliced', async () => {
    const ids = await seedCatalog(h, RECORDS.slice(0, 700).map((r) => ({ ...r, hidden: false, archived: false })), { now: NOW - 3_600_000 });
    const all = [...ids.values()];
    const before = await h.db.selectFrom('records').select(['id', 'changed_at']).orderBy('id').execute();
    await h.db.updateTable('records').set({ title: 'Diperbarui semua' }).execute();
    const reg = registry();
    const { jobId } = await reindex({ recordIds: all.slice(0, 1000) }, reg);
    expect((await slice(reg, jobId, 1)).outcome).toBe('continued');
    expect((await payloadOf(jobId))['cursor']).toBe([...all].sort()[499]);
    expect(await runToEnd(reg, jobId)).toBe('succeeded');
    expect((await searchCatalog(h.db, { text: 'diperbarui', scope: 'opac' }, { now: NOW })).total).toBe(700);
    expect(await h.db.selectFrom('records').select(['id', 'changed_at']).orderBy('id').execute()).toEqual(before);
    expect((await bulkEvents(jobId)).length).toBe(2);
  });

  it('terms: refreshes search_term while the index is ready; yields at once to a queued full rebuild', async () => {
    await seedCatalog(h, [{ key: 'a', title: 'Kitab lama' }], { now: NOW - 3_600_000 });
    await finishSeededIndex(h, NOW - 3_600_000);
    await seedCatalog(h, [{ key: 'b', title: 'Kitab barusan' }], { now: NOW });
    const term = (t: string) => h.db.selectFrom('search_term').select(['term', 'df']).where('term', '=', t).executeTakeFirst();
    expect(await term('barusan')).toBeUndefined();
    const reg = registry();
    const refresh = await reindex({ scope: 'terms' }, reg);
    expect((await h.db.selectFrom('jobs').select('unique_key').where('id', '=', refresh.jobId).executeTakeFirstOrThrow()).unique_key).toBe('catalog.reindex:terms');
    expect(await runToEnd(reg, refresh.jobId)).toBe('succeeded');
    expect(await term('barusan')).toEqual({ term: 'barusan', df: 1 });
    expect(await term('kitab')).toEqual({ term: 'kitab', df: 2 });
    expect(await h.db.selectFrom('search_state').select('status').executeTakeFirstOrThrow()).toEqual({ status: 'ready' });

    // A full rebuild is queued: the refresh ends at once and leaves search_term alone.
    await h.db.deleteFrom('search_term').execute();
    const full = await reindex({ scope: 'all' }, reg);
    const again = await reindex({ scope: 'terms' }, reg);
    expect(again.jobId).not.toBe(full.jobId);
    expect(await runToEnd(reg, again.jobId)).toBe('succeeded');
    expect(await h.db.selectFrom('search_term').selectAll().execute()).toEqual([]);
    // The rebuild then makes the terms itself.
    expect(await runToEnd(reg, full.jobId)).toBe('succeeded');
    expect(await term('barusan')).toEqual({ term: 'barusan', df: 1 });
  });

  it('the housekeeping step: missing → the full rebuild; ready → the terms refresh; a live rebuild is joined, never doubled', async () => {
    const housekeeping = catalogHousekeepingJob(deps, [searchHousekeepingStep]) as JobHandler<unknown>;
    const hk = createJobRegistry([housekeeping, ...searchJobs(deps)]);
    const runHousekeeping = async () => {
      const { id } = await withTx(h, (trx) =>
        enqueue(trx, hk, { type: 'catalog.housekeeping', payload: { windowStart: NOW - 1, windowEnd: NOW } }, { now: NOW, keyring }),
      );
      expect(await runToEnd(hk, id)).toBe('succeeded');
    };
    const reindexJobs = () =>
      h.db.selectFrom('jobs').select(['payload', 'unique_key', 'status', 'created_by']).where('type', '=', 'catalog.reindex').orderBy('id').execute();

    await runHousekeeping(); // search_state missing
    expect(await reindexJobs()).toEqual([{ payload: '{"scope":"all"}', unique_key: 'catalog.reindex:all', status: 'queued', created_by: null }]);
    await runHousekeeping(); // still missing, the rebuild queued: joined
    expect(await reindexJobs()).toHaveLength(1);

    await h.db.deleteFrom('jobs').execute();
    await finishSeededIndex(h, NOW);
    await runHousekeeping(); // ready
    expect(await reindexJobs()).toEqual([{ payload: '{"scope":"terms"}', unique_key: 'catalog.reindex:terms', status: 'queued', created_by: null }]);

    // Building with its rebuild alive: nothing more.
    await h.db.deleteFrom('jobs').execute();
    await h.db.updateTable('search_state').set({ status: 'building' }).execute();
    await reindex({ scope: 'all' });
    await runHousekeeping();
    expect(await reindexJobs()).toHaveLength(1);
  });

  it('L03: the housekeeping step leaves a build alone while the job named by search_state (a migration) is live', async () => {
    const housekeeping = catalogHousekeepingJob(deps, [searchHousekeepingStep]) as JobHandler<unknown>;
    const hk = createJobRegistry([housekeeping, ...searchJobs(deps)]);
    const runHousekeeping = async () => {
      const { id } = await withTx(h, (trx) =>
        enqueue(trx, hk, { type: 'catalog.housekeeping', payload: { windowStart: NOW - 1, windowEnd: NOW } }, { now: NOW, keyring }),
      );
      expect(await runToEnd(hk, id)).toBe('succeeded');
    };
    const reindexJobs = () => h.db.selectFrom('jobs').select(['payload', 'status']).where('type', '=', 'catalog.reindex').execute();
    // A SLiMS migration marked the index building with its own job id, and is running.
    const migration = newId();
    await h.db
      .insertInto('jobs')
      .values({ id: migration, type: 'catalog.migration', payload: '{}', status: 'running', run_at: NOW, max_attempts: 1, created_at: NOW, updated_at: NOW })
      .execute();
    await h.db.insertInto('search_state').values({ id: 1, status: 'building', docs: 0, job_id: migration, built_at: null }).execute();
    await runHousekeeping();
    expect(await reindexJobs()).toEqual([]);
    // Once that job ended without marking the index ready, the build is a stopped one: the full rebuild is queued.
    await h.db.updateTable('jobs').set({ status: 'dead', finished_at: NOW }).where('id', '=', migration).execute();
    await runHousekeeping();
    expect(await reindexJobs()).toEqual([{ payload: '{"scope":"all"}', status: 'queued' }]);
  });

  it('the handler: catalog.reindex, system.diagnostics.manage, longRunning, interactive (C26), retryable from the API; the terms scope has its key', () => {
    expect(reindexJob(deps)).toMatchObject({ type: 'catalog.reindex', permission: 'system.diagnostics.manage', retryable: 'api', longRunning: true, interactive: true });
    expect(reindexJob(deps).payload.safeParse({ scope: 'terms', phase: 'terms', cursor: '12' }).success).toBe(true);
    expect(reindexJob(deps).payload.safeParse({ scope: 'terms', agentId: newId() }).success).toBe(false);
  });
});
