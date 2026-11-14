import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type DB, type DbHandle } from '@altis/db';
import { DomainError, isDomainError, newId, normalizeKey } from '@altis/shared';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';
import { DeleteQueryNode, type KyselyPlugin } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { txCtx, type Actor, type CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { requestCancel } from '../../src/jobs/service.js';
import { runSlice } from '../../src/jobs/slice.js';
import { JOB_HEARTBEAT_MS } from '../../src/jobs/types.js';
import { createCounters } from '../../src/migration/slims/counters.js';
import { __setSlimsSourceFactory, __setSlimsStages } from '../../src/migration/slims/factory.js';
import { assertTargetEmpty } from '../../src/migration/slims/guard.js';
import { SLIMS_MIGRATION_UNIQUE_KEY, SLIMS_STAGES, migrateSlimsJob, startSlimsMigration, type SlimsStartInput } from '../../src/migration/slims/job.js';
import { slimsJobs } from '../../src/migration/slims/jobs.js';
import type { SlimsPipelineContext } from '../../src/migration/slims/pipeline.js';
import { reconcile } from '../../src/migration/slims/reconcile.js';
import { splitDump, type SplitDumpOptions } from '../../src/migration/slims/source/dump-split.js';
import { recordsStage } from '../../src/migration/slims/stages/records.js';
import { SEARCH_TOKEN_VERSION } from '../../src/search/tokenize.js';
import { slimsFixtureBytes } from '../support/slims-fixture/index.js';
import { fakeCountingStage, fakeSlimsFactory, fakeSlimsTables, type FakeSlimsFactory } from '../fixtures/slims-fake.js';

// The SLiMS migration framework (Phase 2 Task 23; spec §11.1–§11.3, §11.6; B1, S3, S10, S13, M6, M13) on the engine
// picked by ALTIS_TEST_DB, with an in-memory source and fake middle stages through the factory seam: the stages run in
// order, a run stopped after every slice ends as one that never stopped, the reconciliation, the target guard, a dry
// run that writes nothing into the catalogue, the source name in the legacy map, the bounded summary, the charset
// sample and the target counts, the split of a dump, and the ends of a run (failed, cancelled, finished and audited).

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 29, 9, 0, 0);
const DB_SOURCE = { host: 'slims.internal', port: 3306, user: 'baca', database: 'slims', tls: false };

/** Every Phase 2 catalog table but `catalog_runs`, and the custom value tables. */
const CATALOG_TABLES = [
  'languages',
  'material_types',
  'publishers',
  'agents',
  'subjects',
  'subject_relations',
  'records',
  'record_identifiers',
  'record_marc_extra',
  'record_agents',
  'record_subjects',
  'record_relations',
  'attachments',
  'locations',
  'collection_types',
  'suppliers',
  'items',
  'item_events',
  'pages',
  'page_translations',
  'search_doc',
  'search_facet',
  'search_term',
  'search_state',
  'migration_map',
  'migration_archive',
  'custom_field_defs',
  'custom_values',
] as const satisfies readonly (keyof DB)[];

describe.skipIf(!ctx.available)(`SLiMS migration framework [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let branchId: string;
  let staff: Actor;
  let factory: FakeSlimsFactory;
  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: 'https://perpus.example.sch.id/', keyring, storage: localStorageDriver(dataDir), log: silent });
  const registry = createJobRegistry(slimsJobs(deps));

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-framework-')));
    dataDir = path.join(root, 'data');
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    branchId = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Perpustakaan Pusat', timezone: 'Asia/Jakarta', is_default: 1, created_at: NOW, updated_at: NOW })
      .execute();
    const staffId = newId(NOW);
    await h.db
      .insertInto('staff_users')
      .values({ id: staffId, username_key: 'MIGRATOR', username_display: 'migrator', name: 'migrator', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
      .execute();
    staff = { type: 'staff', id: staffId, ip: null };
  });

  afterAll(async () => {
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    factory = fakeSlimsFactory();
    __setSlimsSourceFactory(factory);
    __setSlimsStages(null);
    for (const table of ['jobs', 'locks', 'migration_map', 'migration_archive', 'catalog_runs', 'events', 'search_state', 'records'] as const) {
      await h.db.deleteFrom(table).execute();
    }
    await h.db.deleteFrom('files').where('context', '=', 'catalog.report').execute();
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.mkdir(dataDir, { recursive: true });
  });

  afterEach(() => {
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
  });

  const input = (o: Partial<SlimsStartInput> = {}): SlimsStartInput => ({
    dryRun: false,
    sourceKind: 'db',
    db: DB_SOURCE,
    password: 'Rahasia-SLiMS-1',
    dumpStagingId: null,
    files: null,
    filesStagingId: null,
    filesDir: null,
    branchId,
    priceMode: 'major',
    sourceName: 'slims',
    allowNonEmpty: false,
    confirmLibraryName: null,
    fromRunId: null,
    ...o,
  });
  const start = (o: Partial<SlimsStartInput> = {}, actor: Actor = staff) =>
    withTx(h, (trx) => startSlimsMigration(txCtx(trx, NOW, actor), registry, input(o), { keyring }));

  /** Claims and runs job `id`'s slices (each with `budgetMs`) until it ends; its outcome and the slices it took. */
  async function runToEnd(id: string, budgetMs = 20_000): Promise<{ outcome: string; slices: number }> {
    for (let slices = 1; slices <= 200; slices += 1) {
      const job = await claimById(h, registry, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs, keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return { outcome: r.outcome, slices };
    }
    throw new Error('no end after 200 slices');
  }

  const runRow = (id: string) => h.db.selectFrom('catalog_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const summaryOf = async (id: string): Promise<MigrationSummary & Record<string, unknown>> => JSON.parse((await runRow(id)).summary);
  /** The report file of run `id` as rows of cells (BOM and CRLF stripped, the `"` quoting undone). */
  async function reportRows(id: string): Promise<string[][]> {
    const fileId = (await runRow(id)).report_file_id;
    if (fileId === null) throw new Error('the run has no report');
    const chunks: Buffer[] = [];
    for await (const c of (await localStorageDriver(dataDir).get(fileId))!) chunks.push(Buffer.from(c));
    const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\r') continue;
      else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    return rows;
  }
  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const t of CATALOG_TABLES) {
      out[t] = Number((await h.db.selectFrom(t as 'records').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    }
    return out;
  };

  it('the handler: catalog.migrate_slims, catalog.migration.run, longRunning, cpuHeavy, origin-only; the stage list', () => {
    expect(migrateSlimsJob(deps)).toMatchObject({
      type: 'catalog.migrate_slims',
      permission: 'catalog.migration.run',
      retryable: 'origin-only',
      longRunning: true,
      cpuHeavy: true,
    });
    expect(SLIMS_STAGES.map((s) => s.name)).toEqual([
      'split',
      'analyze',
      'masters',
      'records',
      'relations',
      'items',
      'attachments',
      'covers',
      'content',
      'archive',
      'report',
    ]);
  });

  it('a fake source of 3 tables and 2 fake stages: the stages run in order, each to its end, and the run reconciles', async () => {
    const log: string[] = [];
    __setSlimsStages([fakeCountingStage('masters', 'mst_author', { log }), fakeCountingStage('records', 'biblio', { log })]);
    const { runId, jobId } = await start();
    expect(await runToEnd(jobId)).toMatchObject({ outcome: 'succeeded' });
    // mst_author (3 rows) in batches of 2, then biblio (5 rows).
    expect(log).toEqual(['masters:-', 'masters:2', 'records:-', 'records:2', 'records:4']);
    const run = await runRow(runId);
    expect(run.status).toBe('succeeded');
    const summary = await summaryOf(runId);
    expect(summary.version).toBe('9');
    expect(summary.reconciliation).toEqual({
      ok: true,
      tables: [
        { table: 'biblio', source: 5, migrated: 5, merged: 0, skipped: 0, archived: 0, unread: false, diff: 0 },
        { table: 'mst_author', source: 3, migrated: 3, merged: 0, skipped: 0, archived: 0, unread: false, diff: 0 },
      ],
    });
    // The password went to the source from the job's secret, which its end cleared; the options never held it.
    expect(factory.calls.passwords).toEqual(['Rahasia-SLiMS-1']);
    expect(run.options).not.toContain('Rahasia');
    const job = await h.db.selectFrom('jobs').select(['status', 'secret_param', 'unique_key']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job).toEqual({ status: 'succeeded', secret_param: null, unique_key: null });
  });

  it('stopped after every slice and resumed from the stored payload, a run ends with the summary and report of one never stopped', async () => {
    const stages = () => [fakeCountingStage('masters', 'mst_author', { write: true }), fakeCountingStage('items', 'item')];
    __setSlimsStages(stages());
    const whole = await start();
    expect(await runToEnd(whole.jobId)).toEqual({ outcome: 'succeeded', slices: 1 });
    const wholeSummary = await summaryOf(whole.runId);
    const wholeReport = await reportRows(whole.runId);

    for (const table of ['jobs', 'migration_map', 'catalog_runs', 'search_state'] as const) await h.db.deleteFrom(table).execute();
    __setSlimsStages(stages());
    const stepped = await start();
    // A budget of the save margin alone: one stage call per slice, one batch per call.
    const { outcome, slices } = await runToEnd(stepped.jobId, 2_000);
    expect(outcome).toBe('succeeded');
    expect(slices).toBeGreaterThan(6);
    expect(await summaryOf(stepped.runId)).toEqual(wholeSummary);
    expect(await reportRows(stepped.runId)).toEqual(wholeReport);
    expect(wholeSummary.reconciliation?.ok).toBe(true);
  });

  it('reconcile: source = migrated + merged + skipped + archived for every table read; a diff of 1 → ok false; unread tables never fail', () => {
    const ok = reconcile({
      tables: {
        mst_author: { source: 10, migrated: 6, merged: 2, skipped: { empty_key: 1 }, archived: 1 },
        loan: { source: 99, migrated: 0, merged: 0, skipped: {}, archived: 0 },
      },
      unread: ['loan'],
    });
    expect(ok).toEqual({
      ok: true,
      tables: [
        { table: 'loan', source: 99, migrated: 0, merged: 0, skipped: 0, archived: 0, unread: true, diff: 0, unreadKind: 'phase3' },
        { table: 'mst_author', source: 10, migrated: 6, merged: 2, skipped: 1, archived: 1, unread: false, diff: 0 },
      ],
    });
    const off = reconcile({ tables: { biblio: { source: 10, migrated: 7, merged: 0, skipped: { orphan: 1, empty_key: 1 }, archived: 0 } }, unread: [] });
    expect(off.ok).toBe(false);
    expect(off.tables[0]).toMatchObject({ table: 'biblio', skipped: 2, diff: 1 });
  });

  it('the guard: one live record → 409; allowNonEmpty with a wrong library name → 409; with the right name → ok', async () => {
    await expect(assertTargetEmpty(h.db, { allowNonEmpty: false, libraryName: 'Perpustakaan Nusantara' })).resolves.toBeUndefined();
    const buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    await h.db
      .insertInto('records')
      .values({
        id: newId(NOW),
        material_type_id: buku,
        title: 'Hidup',
        subtitle: null,
        responsibility: null,
        title_key: 'hidup',
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
        archived_at: null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    const refused = (o: Parameters<typeof assertTargetEmpty>[1]) =>
      assertTargetEmpty(h.db, o).then(
        () => null,
        (e: unknown) => (isDomainError(e) ? [e.code, e.status] : e),
      );
    expect(await refused({ allowNonEmpty: false, libraryName: 'Perpustakaan Nusantara' })).toEqual(['MIGRATION_TARGET_NOT_EMPTY', 409]);
    expect(await refused({ allowNonEmpty: true, libraryName: 'Perpustakaan Nusantara' })).toEqual(['MIGRATION_TARGET_NOT_EMPTY', 409]);
    expect(await refused({ allowNonEmpty: true, confirmLibraryName: 'Perpustakaan Lain', libraryName: 'Perpustakaan Nusantara' })).toEqual([
      'MIGRATION_TARGET_NOT_EMPTY',
      409,
    ]);
    expect(await refused({ allowNonEmpty: false, confirmLibraryName: 'Perpustakaan Nusantara', libraryName: 'Perpustakaan Nusantara' })).toEqual([
      'MIGRATION_TARGET_NOT_EMPTY',
      409,
    ]);
    expect(await refused({ allowNonEmpty: true, confirmLibraryName: '  Perpustakaan Nusantara ', libraryName: 'Perpustakaan Nusantara' })).toBeNull();
    // Through the start: a real run is refused and nothing is queued; a dry run is not refused.
    await h.db.updateTable('settings').set({ value: JSON.stringify('Perpustakaan Nusantara') }).where('key', '=', 'library.name').execute();
    expect(await start().then(() => null, (e: unknown) => (isDomainError(e) ? e.code : e))).toBe('MIGRATION_TARGET_NOT_EMPTY');
    expect(await h.db.selectFrom('jobs').select('id').execute()).toEqual([]);
    await expect(start({ dryRun: true })).resolves.toMatchObject({ runId: expect.any(String) });
  });

  it('a dry run leaves the row count of every catalog table unchanged (a writing stage writes nothing)', async () => {
    __setSlimsStages([fakeCountingStage('masters', 'mst_author', { write: true }), fakeCountingStage('records', 'biblio', { write: true })]);
    const before = await counts();
    const { runId, jobId } = await start({ dryRun: true });
    expect(await runToEnd(jobId)).toMatchObject({ outcome: 'succeeded' });
    expect(await counts()).toEqual(before);
    const run = await runRow(runId);
    expect([run.status, Number(run.dry_run), run.report_file_id === null]).toEqual(['succeeded', 1, false]);
    // A dry run publishes no bulk change; a real run does at the end of each writing slice.
    expect(await h.db.selectFrom('events').select('seq').where('type', '=', 'catalog.bulk.changed').execute()).toEqual([]);
  });

  it('C14: a stage batch stamps its records with the clock read right before its COMMIT, not with the slice\'s', async () => {
    // The real records stage on two biblio rows; the clock moves on 5 s at the batch's first DELETE of search_facet
    // (inside indexRecords): a harvest that ran while the batch was open answered that later time as its responseDate.
    factory = fakeSlimsFactory({
      tables: {
        biblio: {
          columns: ['biblio_id', 'title'],
          primaryKey: ['biblio_id'],
          rows: [
            { biblio_id: 1, title: 'Hikayat satu' },
            { biblio_id: 2, title: 'Hikayat dua' },
          ],
        },
      },
    });
    __setSlimsSourceFactory(factory);
    __setSlimsStages([recordsStage]);
    const { jobId } = await start();
    let clock = NOW;
    let moved = false;
    const plugin: KyselyPlugin = {
      transformQuery({ node }) {
        if (!moved && DeleteQueryNode.is(node) && JSON.stringify(node.from).includes('"search_facet"')) {
          moved = true;
          clock = NOW + 5000;
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    };
    const watched: DbHandle = { ...h, db: h.db.withPlugin(plugin) };
    let outcome = 'continued';
    for (let n = 0; n < 50 && outcome === 'continued'; n += 1) {
      const job = await claimById(watched, registry, jobId, { worker: 'test', now: clock });
      if (job === null) throw new Error('the migration cannot be claimed');
      outcome = (await runSlice(watched, registry, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => clock, env: {} })).outcome;
    }
    expect(outcome).toBe('succeeded');
    expect(moved).toBe(true);
    const stamps = await h.db.selectFrom('records').select(['title', 'changed_at']).orderBy('title').execute();
    expect(stamps.map((r) => [r.title, Number(r.changed_at)])).toEqual([
      ['Hikayat dua', NOW + 5000],
      ['Hikayat satu', NOW + 5000],
    ]);
    const docs = await h.db.selectFrom('search_doc').select('changed_at').execute();
    expect(docs.map((d) => Number(d.changed_at))).toEqual([NOW + 5000, NOW + 5000]);
  });

  it('L03: a real run whose index a full rebuild took over meanwhile leaves search_state to that rebuild at its end', async () => {
    const rebuild = newId();
    let marked = false;
    __setSlimsStages([
      fakeCountingStage('masters', 'mst_author', {
        write: true,
        onCall: async (c) => {
          if (marked) return;
          marked = true;
          await (c as SlimsPipelineContext).pipeline.markIndexBuilding();
          // A full rebuild starts during the run: it marks the index building with its own id.
          await h.db.updateTable('search_state').set({ job_id: rebuild }).where('id', '=', 1).execute();
        },
      }),
    ]);
    const { jobId } = await start();
    await runToEnd(jobId, 2_000);
    expect(await h.db.selectFrom('search_state').select(['status', 'job_id']).execute()).toEqual([{ status: 'building', job_id: rebuild }]);
  });

  /** Runs slices of job `jobId` (run `runId`) of a 1 ms budget until its run is past `analyze`, then kills the job. */
  async function killPastAnalyze(runId: string, jobId: string): Promise<void> {
    const stageOf = async (): Promise<number> => ((await summaryOf(runId).catch(() => null))?.['resume'] as { stage?: number } | undefined)?.stage ?? 0;
    for (let slices = 0; (await stageOf()) < 2; slices += 1) {
      if (slices > 50) throw new Error('the run never got past analyze');
      const job = await claimById(h, registry, jobId, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${jobId} cannot be claimed`);
      expect((await runSlice(h, registry, job, { mode: 'worker', budgetMs: 1, keyring, log: silent, clock: () => NOW, env: {} })).outcome).toBe('continued');
    }
    await h.db.updateTable('jobs').set({ status: 'dead', unique_key: null, finished_at: NOW }).where('id', '=', jobId).execute();
  }

  it('X2-1: a real run never takes the search index a full rebuild holds (cancelled after its first slice): neither its end nor the end of its abandoned run marks it ready', async () => {
    const rebuild = newId();
    await h.db.insertInto('search_state').values({ id: 1, status: 'building', docs: 0, job_id: rebuild, built_at: null }).execute();
    __setSlimsStages([fakeCountingStage('masters', 'mst_author', { write: true })]);
    const ended = await start();
    expect(await runToEnd(ended.jobId, 2_000)).toMatchObject({ outcome: 'succeeded' });
    expect(await h.db.selectFrom('search_state').select(['status', 'job_id']).execute()).toEqual([{ status: 'building', job_id: rebuild }]);
    expect((await summaryOf(ended.runId)).indexBuilding).toBe(false);
    // A run whose job dies past `analyze`, ended by the next start (closeAbandonedSlimsRun): the index stays the rebuild's.
    const dying = await start();
    await killPastAnalyze(dying.runId, dying.jobId);
    await start({ dryRun: true });
    expect((await runRow(dying.runId)).status).toBe('failed');
    expect(await h.db.selectFrom('search_state').select(['status', 'job_id']).execute()).toEqual([{ status: 'building', job_id: rebuild }]);
  });

  it('X2-1: a real run never creates the missing search_state over records (a restore): the rebuild the boot and the housekeeping queue builds it', async () => {
    const buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    // An archived record: the target is empty (§11.2), but a rebuild would index it.
    await h.db
      .insertInto('records')
      .values({
        id: newId(NOW),
        material_type_id: buku,
        title: 'Arsip lama',
        subtitle: null,
        responsibility: null,
        title_key: 'arsip lama',
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
        archived_at: NOW,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    __setSlimsStages([fakeCountingStage('masters', 'mst_author', { write: true })]);
    const { runId, jobId } = await start();
    expect(await runToEnd(jobId, 2_000)).toMatchObject({ outcome: 'succeeded' });
    expect(await h.db.selectFrom('search_state').select(['status', 'job_id']).execute()).toEqual([]);
    expect((await summaryOf(runId)).indexBuilding).toBe(false);
  });

  /** The `catalog.reindex` jobs. */
  const reindexJobs = () => h.db.selectFrom('jobs').select(['payload', 'unique_key', 'status']).where('type', '=', 'catalog.reindex').execute();

  it('X2-2: a real run over a ready index of this token format marks it ready with that format; over one of another format (or none) it queues a full rebuild', async () => {
    __setSlimsStages([fakeCountingStage('masters', 'mst_author', { write: true })]);
    await h.db.insertInto('search_state').values({ id: 1, status: 'ready', docs: 0, job_id: null, built_at: NOW - 1, token_version: SEARCH_TOKEN_VERSION }).execute();
    const current = await start();
    await runToEnd(current.jobId, 2_000);
    expect(await h.db.selectFrom('search_state').select(['status', 'job_id', 'token_version']).execute()).toEqual([
      { status: 'ready', job_id: null, token_version: SEARCH_TOKEN_VERSION },
    ]);
    expect(await reindexJobs()).toEqual([]);
    // An index built by an older tokenizer, or before the format was stored (0029): its documents are not all of this
    // format, so the run's end leaves it building and queues the full rebuild that makes it ready (joined if queued).
    for (const older of [SEARCH_TOKEN_VERSION - 1, null]) {
      await h.db.deleteFrom('jobs').where('type', '=', 'catalog.reindex').execute();
      await h.db.updateTable('search_state').set({ status: 'ready', job_id: null, token_version: older }).where('id', '=', 1).execute();
      const run = await start();
      await runToEnd(run.jobId, 2_000);
      expect(await h.db.selectFrom('search_state').select(['status', 'job_id']).execute()).toEqual([{ status: 'building', job_id: run.jobId }]);
      expect(await reindexJobs()).toEqual([{ payload: '{"scope":"all"}', unique_key: 'catalog.reindex:all', status: 'queued' }]);
    }
  });

  it('X2-2: a real run in flight across an update that changed the tokenizer (it took the index under the older one) queues a full rebuild at its end', async () => {
    let updated = false;
    __setSlimsStages([
      fakeCountingStage('masters', 'mst_author', {
        write: true,
        onCall: async () => {
          if (updated) return;
          updated = true;
          // What the older release recorded when this run took its ready index: that release's token format.
          await h.db.updateTable('search_state').set({ token_version: SEARCH_TOKEN_VERSION - 1 }).where('id', '=', 1).execute();
        },
      }),
    ]);
    const { jobId } = await start();
    await runToEnd(jobId, 2_000);
    expect(await h.db.selectFrom('search_state').select(['status', 'job_id']).execute()).toEqual([{ status: 'building', job_id: jobId }]);
    expect(await reindexJobs()).toEqual([{ payload: '{"scope":"all"}', unique_key: 'catalog.reindex:all', status: 'queued' }]);
  });

  it('X2-2: an abandoned real run (C17) marks the index it took ready only over documents of this token format, else queues a full rebuild', async () => {
    const first = await start();
    await withTx(h, (trx) => trx.insertInto('search_state').values({ id: 1, status: 'building', docs: 0, job_id: first.jobId, built_at: null, token_version: SEARCH_TOKEN_VERSION - 1 }).execute());
    expect(await withTx(h, (trx) => requestCancel(trx, first.jobId, NOW))).toBe('cancelled');
    await start({ dryRun: true });
    expect((await runRow(first.runId)).status).toBe('cancelled');
    expect(await h.db.selectFrom('search_state').select(['status', 'job_id']).execute()).toEqual([{ status: 'building', job_id: first.jobId }]);
    expect(await reindexJobs()).toEqual([{ payload: '{"scope":"all"}', unique_key: 'catalog.reindex:all', status: 'queued' }]);
  });

  it('X2-1: a real run holds the index it took again when the slice that took it died before its summary saved', async () => {
    let calls = 0;
    __setSlimsStages([
      fakeCountingStage('masters', 'mst_author', {
        write: true,
        onCall: async (c) => {
          calls += 1;
          if (calls === 1) await (c as SlimsPipelineContext).pipeline.markIndexBuilding();
        },
      }),
    ]);
    const { jobId } = await start();
    await runToEnd(jobId, 2_000);
    expect(await h.db.selectFrom('search_state').select(['status', 'job_id']).execute()).toEqual([{ status: 'ready', job_id: null }]);
  });

  it('a real run: catalog.bulk.changed {runId} per writing slice, the search index ready at the end, one catalog.migration.finish', async () => {
    __setSlimsStages([fakeCountingStage('masters', 'mst_author', { write: true })]);
    const { runId, jobId } = await start();
    const seq = Number((await h.db.selectFrom('audit_head').select('last_seq').executeTakeFirstOrThrow()).last_seq);
    await runToEnd(jobId, 2_000);
    const events = await h.db.selectFrom('events').select(['channel', 'payload']).where('type', '=', 'catalog.bulk.changed').execute();
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) expect([e.channel, JSON.parse(e.payload)]).toEqual(['catalog', { runId }]);
    expect(await h.db.selectFrom('search_state').select(['status', 'job_id']).execute()).toEqual([{ status: 'ready', job_id: null }]);
    const entries = await h.db.selectFrom('audit_log').select(['action', 'actor_type', 'actor_id', 'entity', 'entity_id', 'meta']).where('seq', '>', seq).execute();
    expect(entries.map((e) => e.action)).toEqual(['catalog.migration.finish']);
    expect(entries[0]).toMatchObject({ actor_type: 'system', actor_id: null, entity: 'catalog_runs', entity_id: runId });
    expect(JSON.parse(entries[0]!.meta)).toMatchObject({ status: 'succeeded', dryRun: false, ok: true, migrated: 3, source: 3, jobId });
  });

  it("S13: a run with sourceName 'kampus' writes migration_map.source = 'kampus'", async () => {
    __setSlimsStages([fakeCountingStage('masters', 'mst_author', { write: true })]);
    const { jobId, runId } = await start({ sourceName: 'kampus' });
    await runToEnd(jobId);
    const rows = await h.db.selectFrom('migration_map').select(['source', 'entity', 'run_id']).execute();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toEqual({ source: 'kampus', entity: 'mst_author', run_id: runId });
  });

  it('M6: 60 cf_* columns with 5 long samples each → the summary stays under 60 000 bytes, the report CSV holds every sample whole', async () => {
    const long = (i: number, k: number) => `${'Ã©'.repeat(200)} cf_${i} #${k}`;
    __setSlimsStages([
      fakeCountingStage('records', 'biblio', {
        batch: 5,
        onCall: (c) => {
          for (let i = 0; i < 60; i += 1) {
            for (let k = 0; k < 5; k += 1) {
              c.counters.fix(`biblio_custom.cf_${i}`, 'mojibake', 1);
              c.counters.sample(`biblio_custom.cf_${i}`, long(i, k), long(i, k).replace(/Ã©/g, 'é'));
            }
          }
        },
      }),
    ]);
    const { runId, jobId } = await start({ dryRun: true });
    expect(await runToEnd(jobId)).toMatchObject({ outcome: 'succeeded' });
    const text = (await runRow(runId)).summary;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(60_000);
    const summary = JSON.parse(text) as MigrationSummary;
    expect(summary.samples.length).toBeGreaterThan(0);
    expect(new Set(summary.samples.map((s) => s.column)).size).toBeLessThanOrEqual(50);
    for (const s of summary.samples) expect(Array.from(s.before).length).toBeLessThanOrEqual(120);
    expect(summary.fixes['biblio_custom.cf_59']).toEqual({ mojibake: 5 });
    const samples = (await reportRows(runId)).filter((r) => r[2] === 'sample');
    expect(samples).toHaveLength(300);
    for (let i = 0; i < 60; i += 1) {
      for (let k = 0; k < 5; k += 1) expect(samples.some((r) => r[3]!.includes(long(i, k)))).toBe(true);
    }
  });

  it('M6: the counters bound samples to 5 per column, 50 columns, 120 characters, and pass every sample to the report', () => {
    const seen: string[] = [];
    const c = createCounters(null, { onSample: (column, fix, before) => seen.push(`${column}:${fix}:${before.length}`) });
    for (let i = 0; i < 70; i += 1) {
      c.fix(`t.c${i}`, 'backslash', 2);
      for (let k = 0; k < 7; k += 1) c.sample(`t.c${i}`, 'x'.repeat(300), 'y');
    }
    const json = c.toJSON();
    expect(seen).toHaveLength(490);
    expect(seen[0]).toBe('t.c0:backslash:300');
    expect(new Set(json.samples.map((s) => s.column)).size).toBeLessThanOrEqual(50);
    expect(json.samples.filter((s) => s.column === 't.c0')).toHaveLength(5);
    expect(json.samples[0]!.before).toHaveLength(120);
    // Loaded again from the summary, the counters go on from there.
    const again = createCounters(JSON.parse(JSON.stringify(json)));
    again.migrated('t', 1);
    expect(again.toJSON().fixes['t.c69']).toEqual({ backslash: 2 });
    expect(again.toJSON().samples).toEqual(json.samples);
    expect(() => c.migrated('t', -1)).toThrow(TypeError);
    expect(() => c.skipped('t', 'Bad Reason', 1)).toThrow(TypeError);
    expect(() => c.fix('t.c', 'other' as never, 1)).toThrow(TypeError);
  });

  it('M13: analyze stores the charset sample of a cp1252 column; the report has the target-table counts before and after', async () => {
    __setSlimsStages([fakeCountingStage('masters', 'mst_author', { write: true })]);
    const { runId, jobId } = await start();
    await runToEnd(jobId);
    const summary = await summaryOf(runId);
    const title = summary.charset.find((c) => c.column === 'biblio.title');
    expect(title).toMatchObject({ rows: 5, ascii: 4, cp1252: 1, utf8: 0, mojibake: 0, samples: ['Café Manis'] });
    expect(summary.charset.find((c) => c.column === 'item.item_code')).toMatchObject({ rows: 7, ascii: 7 });
    expect(summary.targets.find((t) => t.table === 'migration_map')).toEqual({ table: 'migration_map', before: 0, after: 3 });
    const report = await reportRows(runId);
    expect(report[0]).toEqual(['table', 'legacy_key', 'code', 'detail']);
    const targets = report.filter((r) => r[2] === 'target_count');
    expect(targets.map((r) => r[0])).toEqual(['records', 'items', 'agents', 'subjects', 'publishers', 'attachments', 'pages', 'migration_map', 'migration_archive']);
    expect(targets.find((r) => r[0] === 'migration_map')![3]).toBe('before=0; after=3; added=3');
    expect(report.some((r) => r[2] === 'oai_identifiers_changed')).toBe(true);
    expect(report.some((r) => r[2] === 'phase3_tables')).toBe(true);
    expect(report.find((r) => r[2] === 'charset' && r[3]!.startsWith('biblio.title'))![3]).toContain('cp1252=1');
  });

  it('the check sample: up to 20 migrated biblio rows with their record URL and a title comparison', async () => {
    const buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    // A stage that maps two biblio rows to records whose titles agree (one split on its colon) and one that does not.
    __setSlimsStages([
      {
        name: 'records',
        reads: ['biblio'],
        async run(c) {
          const rows = (await c.source.rows('biblio', null, 10)).rows;
          c.counters.migrated('biblio', rows.length);
          await withTx(c.h, async (trx) => {
            for (const r of rows.slice(0, 3)) {
              const id = newId(NOW);
              const title = r['biblio_id'] === 1 ? 'Laskar Pelangi' : r['biblio_id'] === 3 ? 'Ronggeng Dukuh Paruk' : 'Judul Lain';
              await trx
                .insertInto('records')
                .values({
                  id,
                  material_type_id: buku,
                  title,
                  subtitle: r['biblio_id'] === 1 ? 'sebuah novel' : null,
                  responsibility: null,
                  title_key: normalizeKey(title).toLowerCase(),
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
                  source: `slims:${String(r['biblio_id'])}`,
                  merged_into: null,
                  changed_at: NOW,
                  archived_at: null,
                  created_at: NOW,
                  created_by: null,
                  updated_at: NOW,
                  updated_by: null,
                })
                .execute();
              await trx
                .insertInto('migration_map')
                .values({ source: c.options.sourceName, entity: 'biblio', legacy_key: String(r['biblio_id']), target_id: id, run_id: c.runId })
                .execute();
            }
          });
          return { done: true, cursor: null };
        },
      },
    ]);
    const { runId, jobId } = await start({ allowNonEmpty: true });
    await runToEnd(jobId);
    const summary = await summaryOf(runId);
    expect(summary.checks.map((c) => [c.legacyId, c.matches]).sort()).toEqual([
      ['1', true],
      ['2', false],
      ['3', true],
    ]);
    const rows = (await reportRows(runId)).filter((r) => r[2] === 'check_sample');
    expect(rows).toHaveLength(3);
    const first = rows.find((r) => r[1] === '1')!;
    expect(first[3]).toMatch(/^url=https:\/\/perpus\.example\.sch\.id\/admin\/catalog\/records\/[0-9A-Z]{26}; slims=Laskar Pelangi: sebuah novel; altis=Laskar Pelangi: sebuah novel; match=yes$/);
  });

  it('a dump source: the split runs over two slices from its checkpoint, tables.json is written, the dump removed after it', async () => {
    __setSlimsStages([fakeCountingStage('records', 'biblio')]);
    const staging = newId(NOW);
    await fsp.mkdir(path.join(dataDir, 'tmp', staging), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', staging, 'upload.bin'), '-- MySQL dump\n');
    const { runId, jobId } = await start({ dryRun: true, sourceKind: 'dump', db: null, password: null, dumpStagingId: staging });
    expect(await runToEnd(jobId, 2_000)).toMatchObject({ outcome: 'succeeded' });
    expect(factory.calls).toMatchObject({ split: 2, staged: 1, openDb: 0 });
    const work = path.join(dataDir, 'tmp', runId);
    expect(JSON.parse(await fsp.readFile(path.join(work, 'tables.json'), 'utf8')).map((t: { name: string }) => t.name)).toEqual(['biblio', 'item', 'mst_author']);
    await expect(fsp.stat(path.join(work, 'dump.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(dataDir, 'tmp', staging))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await summaryOf(runId)).reconciliation?.ok).toBe(true);
  });

  it('C19: a gzipped dump split over several slices of one process is read on from where each slice stopped (never inflated twice)', async () => {
    const calls: { offset: number; kept: number | null; heartbeat: boolean }[] = [];
    __setSlimsSourceFactory({
      ...fakeSlimsFactory(),
      async splitDump(o: SplitDumpOptions) {
        calls.push({ offset: o.checkpoint?.offset ?? 0, kept: o.keep?.reader?.position ?? null, heartbeat: typeof o.heartbeat === 'function' });
        return splitDump({ ...o, ensureHeadroom: async () => {} });
      },
    });
    __setSlimsStages([fakeCountingStage('records', 'biblio')]);
    const staging = newId(NOW);
    await fsp.mkdir(path.join(dataDir, 'tmp', staging), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', staging, 'upload.bin'), slimsFixtureBytes().dumpGz);
    const { jobId } = await start({ dryRun: true, sourceKind: 'dump', db: null, password: null, dumpStagingId: staging });
    // Each slice's split gets 1 ms (the slice keeps 2 s for its save), so the fixture's split takes several slices.
    expect(await runToEnd(jobId, 2_001)).toMatchObject({ outcome: 'succeeded' });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]).toEqual({ offset: 0, kept: null, heartbeat: true });
    // Every later slice of this process found the reader its last slice left, standing at its checkpoint.
    for (const c of calls.slice(1)) expect(c).toEqual({ offset: c.offset, kept: c.offset, heartbeat: true });
  });

  it('a dump whose table names the split tracks but SLiMS never uses (mixed case, $, -) reads its table list back', async () => {
    __setSlimsSourceFactory(
      fakeSlimsFactory({ tables: { ...fakeSlimsTables(), Biblio_Lama: { columns: ['id'], primaryKey: ['id'], rows: [{ id: 1 }] }, 'tmp$ex-port': { columns: ['a'], primaryKey: [], rows: [] } } }),
    );
    __setSlimsStages([fakeCountingStage('records', 'biblio')]);
    const staging = newId(NOW);
    await fsp.mkdir(path.join(dataDir, 'tmp', staging), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', staging, 'upload.bin'), '-- MySQL dump\n');
    const { runId, jobId } = await start({ dryRun: true, sourceKind: 'dump', db: null, password: null, dumpStagingId: staging });
    expect(await runToEnd(jobId)).toMatchObject({ outcome: 'succeeded' });
    expect((await summaryOf(runId)).warnings).not.toContain('work_corrupt');
    expect((await runRow(runId)).status).toBe('succeeded');
  });

  it('S3 in the job: a real run whose start lost its rename adopts the dry run\'s folder itself, and skips the split; a lost folder fails it', async () => {
    __setSlimsStages([fakeCountingStage('records', 'biblio')]);
    const dump = async (): Promise<string> => {
      const staging = newId(NOW);
      await fsp.mkdir(path.join(dataDir, 'tmp', staging), { recursive: true });
      await fsp.writeFile(path.join(dataDir, 'tmp', staging, 'upload.bin'), '-- MySQL dump\n');
      return staging;
    };
    const dry = await start({ dryRun: true, sourceKind: 'dump', db: null, password: null, dumpStagingId: await dump() });
    await runToEnd(dry.jobId);
    expect(factory.calls.split).toBe(2);
    // The start's own rename after its COMMIT is the route's (not made here): the first slice makes it.
    const real = await start({ sourceKind: 'dump', db: null, password: null, fromRunId: dry.runId });
    expect(JSON.parse((await h.db.selectFrom('jobs').select('payload').where('id', '=', real.jobId).executeTakeFirstOrThrow()).payload)).toMatchObject({ stage: 1 });
    expect(await runToEnd(real.jobId)).toMatchObject({ outcome: 'succeeded' });
    expect(factory.calls.split).toBe(2);
    await expect(fsp.stat(path.join(dataDir, 'tmp', dry.runId))).rejects.toMatchObject({ code: 'ENOENT' });
    // The real run ended: nothing adopts its work any more, so its folder is gone with the run's end.
    await expect(fsp.stat(path.join(dataDir, 'tmp', real.runId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await runRow(real.runId)).status).toBe('succeeded');
    // A dry run whose folder went away before its real run's first slice: the real run fails as work_missing.
    const second = await start({ dryRun: true, sourceKind: 'dump', db: null, password: null, dumpStagingId: await dump() });
    await runToEnd(second.jobId);
    const orphan = await start({ sourceKind: 'dump', db: null, password: null, fromRunId: second.runId });
    await fsp.rm(path.join(dataDir, 'tmp', second.runId), { recursive: true, force: true });
    await runToEnd(orphan.jobId);
    expect((await runRow(orphan.runId)).status).toBe('failed');
    expect((await summaryOf(orphan.runId)).warnings).toContain('work_missing');
  });

  it('S10: DISK_QUOTA from splitDump ends the run failed with the report row disk_full', async () => {
    __setSlimsSourceFactory(fakeSlimsFactory({ splitFails: new DomainError('DISK_QUOTA') }));
    __setSlimsStages([fakeCountingStage('records', 'biblio')]);
    const staging = newId(NOW);
    await fsp.mkdir(path.join(dataDir, 'tmp', staging), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', staging, 'upload.bin'), '-- MySQL dump\n');
    const { runId, jobId } = await start({ dryRun: true, sourceKind: 'dump', db: null, password: null, dumpStagingId: staging });
    expect(await runToEnd(jobId)).toEqual({ outcome: 'succeeded', slices: 1 });
    const run = await runRow(runId);
    expect(run.status).toBe('failed');
    expect((await reportRows(runId)).filter((r) => r[2] === 'disk_full')).toHaveLength(1);
    expect((await summaryOf(runId)).warnings).toContain('disk_full');
    const finish = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'catalog.migration.finish').where('entity_id', '=', runId).execute();
    expect(finish.map((e) => JSON.parse(e.meta).status)).toEqual(['failed']);
  });

  it('S10 on a full disk: a split stopped by ENOSPC whose report rows cannot be written either ends the run failed in one slice, its staging gone', async () => {
    const full = (): NodeJS.ErrnoException => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    __setSlimsSourceFactory({
      ...fakeSlimsFactory(),
      async splitDump(s) {
        // The staging written before the disk filled up, then the write that found it full (Staging maps it).
        await fsp.writeFile(path.join(s.stagingDir, 'biblio.ndjson'), '{"biblio_id":1}\n'.repeat(1000));
        await fsp.writeFile(path.join(s.stagingDir, 'split_tables.ndjson'), '{"table":"biblio","columns":["biblio_id"],"primaryKey":[]}\n');
        throw new DomainError('DISK_QUOTA', { meta: { reason: 'write', code: 'ENOSPC' }, cause: full() });
      },
    });
    __setSlimsStages([fakeCountingStage('records', 'biblio')]);
    const staging = newId(NOW);
    await fsp.mkdir(path.join(dataDir, 'tmp', staging), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', staging, 'upload.bin'), '-- MySQL dump\n');
    const { runId, jobId } = await start({ dryRun: true, sourceKind: 'dump', db: null, password: null, dumpStagingId: staging });
    const work = path.join(dataDir, 'tmp', runId);
    // Every write of the report work file finds the disk full too.
    const realOpen = fsp.open.bind(fsp);
    const open = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === path.join(work, 'report.csv')) {
        handle.write = (async () => {
          throw full();
        }) as unknown as typeof handle.write;
      }
      return handle;
    });
    try {
      expect(await runToEnd(jobId)).toEqual({ outcome: 'succeeded', slices: 1 });
    } finally {
      open.mockRestore();
    }
    const run = await runRow(runId);
    expect(run.status).toBe('failed');
    expect((await summaryOf(runId)).warnings).toContain('disk_full');
    // The rows that could not reach the work file still reach the report.
    expect((await reportRows(runId)).filter((r) => r[2] === 'disk_full')).toHaveLength(1);
    // Ended in its first slice: the job succeeded, never retried.
    expect((await h.db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status).toBe('succeeded');
    // Nothing of the failed run holds the disk any more: no staging, no dump, no work folder at all.
    await expect(fsp.stat(work)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('the end of a run frees its work folder, except what a succeeded dry run keeps for its real run (S3)', async () => {
    __setSlimsStages([fakeCountingStage('records', 'biblio')]);
    const dump = async (): Promise<string> => {
      const staging = newId(NOW);
      await fsp.mkdir(path.join(dataDir, 'tmp', staging), { recursive: true });
      await fsp.writeFile(path.join(dataDir, 'tmp', staging, 'upload.bin'), '-- MySQL dump\n');
      return staging;
    };
    // A failed dump run (the source is not SLiMS): its folder goes.
    __setSlimsSourceFactory(fakeSlimsFactory({ version: 'unknown' }));
    const failed = await start({ dryRun: true, sourceKind: 'dump', db: null, password: null, dumpStagingId: await dump() });
    await runToEnd(failed.jobId);
    expect((await runRow(failed.runId)).status).toBe('failed');
    await expect(fsp.stat(path.join(dataDir, 'tmp', failed.runId))).rejects.toMatchObject({ code: 'ENOENT' });
    // A succeeded dry run keeps its staging (not its dump) for the real run that adopts it.
    __setSlimsSourceFactory(fakeSlimsFactory());
    const dry = await start({ dryRun: true, sourceKind: 'dump', db: null, password: null, dumpStagingId: await dump() });
    await runToEnd(dry.jobId);
    expect((await fsp.readdir(path.join(dataDir, 'tmp', dry.runId))).sort()).toEqual(['report.csv', 'tables.json']);
  });

  it('an unsupported source (detect: unknown) ends the run failed as source_unsupported', async () => {
    __setSlimsSourceFactory(fakeSlimsFactory({ version: 'unknown' }));
    __setSlimsStages([fakeCountingStage('records', 'biblio')]);
    const { runId, jobId } = await start({ dryRun: true });
    await runToEnd(jobId);
    expect((await runRow(runId)).status).toBe('failed');
    expect((await reportRows(runId)).some((r) => r[2] === 'source_unsupported')).toBe(true);
  });

  it('a cancel request ends the run cancelled at its next stage call', async () => {
    __setSlimsStages([fakeCountingStage('masters', 'mst_author', { batch: 1 })]);
    const { runId, jobId } = await start({ dryRun: true });
    const first = await claimById(h, registry, jobId, { worker: 'test', now: NOW });
    expect((await runSlice(h, registry, first!, { mode: 'worker', budgetMs: 2_000, keyring, log: silent, clock: () => NOW, env: {} })).outcome).toBe('continued');
    await h.db.updateTable('jobs').set({ cancel_requested: 1 }).where('id', '=', jobId).execute();
    const job = await claimById(h, registry, jobId, { worker: 'test', now: NOW });
    expect((await runSlice(h, registry, job!, { mode: 'worker', budgetMs: 2_000, keyring, log: silent, clock: () => NOW, env: {} })).outcome).toBe('cancelled');
    expect((await runRow(runId)).status).toBe('cancelled');
  });

  it('C17: a cancel requested while a stage spends the slice\'s budget ends the run cancelled in that slice, not only its job', async () => {
    let t = NOW;
    let jobId = '';
    __setSlimsStages([
      fakeCountingStage('masters', 'mst_author', {
        batch: 1,
        async onCall(c) {
          // The jobs page's Batalkan on the running job, seen by the stage's next heartbeat (15 s later).
          await withTx(h, (trx) => requestCancel(trx, jobId, t));
          t += JOB_HEARTBEAT_MS + 1;
          await c.heartbeat(50, 'masters');
        },
      }),
    ]);
    const started = await start({ dryRun: true });
    jobId = started.jobId;
    let outcome = 'continued';
    for (let slices = 0; outcome === 'continued' && slices < 10; slices += 1) {
      const job = await claimById(h, registry, jobId, { worker: 'test', now: t });
      outcome = (await runSlice(h, registry, job!, { mode: 'worker', budgetMs: 2_000, keyring, log: silent, clock: () => t, env: {} })).outcome;
    }
    expect(outcome).toBe('cancelled');
    const run = await runRow(started.runId);
    expect(run.status).toBe('cancelled');
    expect((await reportRows(started.runId)).filter((r) => r[2] === 'cancelled')).toHaveLength(1);
    const finish = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'catalog.migration.finish').where('entity_id', '=', started.runId).execute();
    expect(finish.map((e) => JSON.parse(e.meta).status)).toEqual(['cancelled']);
  });

  it('C17: a run whose job was cancelled while queued is ended by the next start as its job ended, with its finish audited and the index ready again', async () => {
    const first = await start();
    // As the run's take recorded it (pipeline.ts): its index held documents of this token format.
    await withTx(h, (trx) =>
      trx.insertInto('search_state').values({ id: 1, status: 'building', docs: 0, job_id: first.jobId, built_at: null, token_version: SEARCH_TOKEN_VERSION }).execute(),
    );
    expect(await withTx(h, (trx) => requestCancel(trx, first.jobId, NOW))).toBe('cancelled');
    const second = await start({ dryRun: true });
    expect(await runRow(first.runId)).toMatchObject({ status: 'cancelled', finished_at: NOW });
    expect((await runRow(second.runId)).status).toBe('queued');
    // The caller removes the ended run's work folder after the COMMIT (releaseEndedRunWork, C16).
    expect(second.endedRunIds).toEqual([first.runId]);
    expect(await h.db.selectFrom('search_state').select(['status', 'job_id', 'token_version']).execute()).toEqual([
      { status: 'ready', job_id: null, token_version: SEARCH_TOKEN_VERSION },
    ]);
    const finish = await h.db.selectFrom('audit_log').select(['actor_type', 'meta']).where('action', '=', 'catalog.migration.finish').where('entity_id', '=', first.runId).execute();
    expect(finish.map((e) => [e.actor_type, JSON.parse(e.meta)])).toEqual([['system', { status: 'cancelled', dryRun: false, jobId: first.jobId, abandoned: true }]]);
  });

  it('one migration at a time: the unique key; a run left running without a live job is ended failed by the next start', async () => {
    const first = await start({ dryRun: true });
    const live = await h.db.selectFrom('jobs').select(['id', 'unique_key']).execute();
    expect(live).toEqual([{ id: first.jobId, unique_key: SLIMS_MIGRATION_UNIQUE_KEY }]);
    expect(await start({ dryRun: true }).then(() => null, (e: unknown) => (isDomainError(e) ? e.code : e))).toBe('TX_CONFLICT');
    // The job died before it ran (a lease-expiry kill on its last attempt): its run stays queued until the next start.
    await h.db.updateTable('jobs').set({ status: 'dead', unique_key: null, finished_at: NOW }).where('id', '=', first.jobId).execute();
    const second = await start({ dryRun: true });
    expect((await runRow(first.runId)).status).toBe('failed');
    expect((await runRow(second.runId)).status).toBe('queued');
  });

  it('a payload naming a run that has ended ends its job at once (a retried slice)', async () => {
    const { runId, jobId } = await start({ dryRun: true });
    await h.db.updateTable('catalog_runs').set({ status: 'failed', finished_at: NOW }).where('id', '=', runId).execute();
    expect(await runToEnd(jobId)).toEqual({ outcome: 'succeeded', slices: 1 });
  });
});
