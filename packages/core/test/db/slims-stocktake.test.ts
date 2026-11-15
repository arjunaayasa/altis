import { randomBytes } from 'node:crypto';
import { withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { txCtx, type CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { __setSlimsSourceFactory, __setSlimsStages } from '../../src/migration/slims/factory.js';
import { startSlimsMigration, type SlimsStartInput } from '../../src/migration/slims/job.js';
import { slimsJobs } from '../../src/migration/slims/jobs.js';
import { archiveStage } from '../../src/migration/slims/stages/archive.js';
import { __setSlimsStageBBatch } from '../../src/migration/slims/stages/stage-b-kit.js';
import { stocktakeStage } from '../../src/migration/slims/stages/stocktake.js';
import { readSettings } from '../../src/settings/service.js';
import { fakeSlimsFactory, type FakeSlimsTable } from '../fixtures/slims-fake.js';
import { ACTOR, NOW, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// The SLiMS migration's stocktake stage on the engine picked by ALTIS_TEST_DB, through the real framework (an in-memory
// source of synthetic SLiMS rows, written for this test; the catalogue seeded in ALTIS with its legacy map, as the
// catalogue stages would leave it). SLiMS 9 table/column names (interoperability facts, no SLiMS code). Checked: every
// session comes in (an older one with the totals SLiMS kept, one without a start date skipped), the last one with its
// rows mapped to ALTIS copies (found by the officer's name, missing, on loan; a copy ALTIS lacks, a second row of one
// copy and a row of an older session skipped), keeping the totals SLiMS kept for it as it finished it; a session still
// active comes in cancelled, its counters counted from its rows, and is named in the report; both tables are also
// archived, and the reconciliation balances; a re-run skips what an earlier run brought, row by row, and a run after one
// that ended within the rows brings the rest; a dry run writes nothing and counts alike; a run stopped after every batch, with its
// counts lost after every other commit, ends as one that never stopped; a source without the tables reads the rows an
// earlier run archived, outside the reconciliation.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const DB_SOURCE = { host: 'slims.internal', port: 3306, user: 'baca', database: 'slims', tls: false };
const EARLIER_RUN = '01J00000000000000000000000';

const t = (columns: string[], rows: Record<string, string | number | null>[], primaryKey: string[] = [columns[0]!]): FakeSlimsTable => ({ columns, primaryKey, rows });

const SESSION_COLUMNS = [
  'stock_take_id', 'stock_take_name', 'start_date', 'end_date', 'init_user', 'total_item_stock_taked', 'total_item_lost',
  'total_item_exists', 'total_item_loan', 'stock_take_users', 'is_active', 'report_file',
];
const ROW_COLUMNS = ['stock_take_id', 'item_id', 'item_code', 'title', 'gmd_name', 'classification', 'coll_type_name', 'call_number', 'location', 'status', 'checked_by', 'last_update'];

/** The synthetic SLiMS source; `active`: the last session is still active in SLiMS. */
function slimsTables(o: { active?: boolean; withoutStocktake?: boolean } = {}): Record<string, FakeSlimsTable> {
  const session = (id: number, name: string, start: string, end: string | null, totals: [number, number, number, number], active = 0) => ({
    stock_take_id: id,
    stock_take_name: name,
    start_date: start,
    end_date: end,
    init_user: 'Kepala Perpustakaan',
    total_item_stock_taked: totals[0],
    total_item_lost: totals[1],
    total_item_exists: totals[2],
    total_item_loan: totals[3],
    stock_take_users: null,
    is_active: active,
    report_file: null,
  });
  const row = (session: number, item: number, code: string, status: string, checkedBy = 'Petugas Satu') => ({
    stock_take_id: session,
    item_id: item,
    item_code: code,
    title: `Judul ${code}`,
    gmd_name: 'Text',
    classification: '599',
    coll_type_name: 'Umum',
    call_number: '599 JUD',
    location: 'Ruang Baca',
    status,
    checked_by: checkedBy,
    last_update: '2023-06-06 10:30:00',
  });
  const tables: Record<string, FakeSlimsTable> = {
    item: t(['item_id', 'biblio_id', 'item_code'], [1, 2, 3, 4, 5].map((n) => ({ item_id: 100 + n, biblio_id: n, item_code: `B00${n}` }))),
  };
  if (o.withoutStocktake === true) return tables;
  tables['stock_take'] = t(SESSION_COLUMNS, [
    session(1, 'Inventarisasi 2019', '2019-07-01 08:00:00', '2019-07-03 15:00:00', [50, 2, 45, 3]),
    session(2, 'Inventarisasi 2023', '2023-06-05 08:00:00', o.active === true ? null : '2023-06-07 16:00:00', [5, 1, 3, 1], o.active === true ? 1 : 0),
    session(3, 'Tanpa tanggal', '0000-00-00 00:00:00', null, [0, 0, 0, 0]),
  ]);
  tables['stock_take_item'] = t(
    ROW_COLUMNS,
    [
      row(2, 101, 'B001', 'e'),
      row(2, 102, 'B002', 'm', ''),
      row(2, 103, 'B003', 'l', ''),
      // B005 is not in ALTIS; item 999 is no SLiMS item, its code names B001 again.
      row(2, 105, 'B005', 'e'),
      row(2, 999, 'B001', 'e'),
      // A row of the older session (SLiMS keeps the last session's only).
      row(1, 104, 'B004', 'e'),
    ],
    ['stock_take_id', 'item_id'],
  );
  return tables;
}

describe.skipIf(!ctx.available)(`SLiMS stocktake [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let library: string;
  const items = new Map<number, string>();
  const deps = (): CatalogJobDeps => ({ dataDir: db.dataDir, baseUrl: 'https://perpus.example.sch.id/', keyring, storage: localStorageDriver(db.dataDir), log: silent });
  const registry = createJobRegistry(slimsJobs(deps));

  async function mapRow(entity: string, legacyKey: string, targetId: string, runId = EARLIER_RUN): Promise<void> {
    await db.h.db.insertInto('migration_map').values({ source: 'slims', entity, legacy_key: legacyKey, target_id: targetId, run_id: runId }).execute();
  }

  beforeAll(async () => {
    db = await openItemsDb('slims-stocktake');
    library = String((await readSettings(db.h.db, ['library.name'], []))['library.name']);
    for (const n of [1, 2, 3, 4]) {
      const recordId = await seedRecord(db, { title: `Judul ${n}`, callNumber: '599 JUD' });
      await mapRow('biblio', String(n), recordId);
      const itemId = await seedItem(db, recordId, { barcode: `B00${n}` });
      items.set(100 + n, itemId);
      await mapRow('item', String(100 + n), itemId);
    }
  });

  afterAll(async () => {
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
    __setSlimsStageBBatch(null);
    await db?.close();
  });

  beforeEach(() => {
    __setSlimsStages([stocktakeStage, archiveStage]);
  });

  afterEach(() => {
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
    __setSlimsStageBBatch(null);
  });

  const input = (o: Partial<SlimsStartInput> = {}): SlimsStartInput => ({
    dryRun: false,
    sourceKind: 'db',
    db: DB_SOURCE,
    password: 'x',
    dumpStagingId: null,
    files: null,
    filesStagingId: null,
    filesDir: null,
    branchId: db.branchId,
    priceMode: 'major',
    sourceName: 'slims',
    allowNonEmpty: true,
    confirmLibraryName: library,
    fromRunId: null,
    ...o,
  });
  const start = (o: Partial<SlimsStartInput> = {}) => withTx(db.h, (trx) => startSlimsMigration(txCtx(trx, NOW, ACTOR), registry, input(o), { keyring }));

  /** Runs job `id` to its end; with `lose`, every other continued slice's saved counts are put back (a death after its commit). */
  async function runToEnd(id: string, o: { budgetMs?: number; lose?: boolean } = {}): Promise<string> {
    for (let slices = 1; slices <= 400; slices += 1) {
      const run = await db.h.db.selectFrom('catalog_runs').select(['id', 'summary']).where('job_id', '=', id).executeTakeFirst();
      const job = await db.h.db.selectFrom('jobs').select('payload').where('id', '=', id).executeTakeFirstOrThrow();
      const claimed = await claimById(db.h, registry, id, { worker: 'test', now: NOW });
      if (claimed === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(db.h, registry, claimed, { mode: 'worker', budgetMs: o.budgetMs ?? 20_000, keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
      if (o.lose === true && slices % 2 === 0 && run !== undefined) {
        await db.h.db.updateTable('catalog_runs').set({ summary: run.summary }).where('id', '=', run.id).execute();
        await db.h.db.updateTable('jobs').set({ payload: job.payload }).where('id', '=', id).execute();
      }
    }
    throw new Error('no end after 400 slices');
  }

  const summaryOf = async (runId: string): Promise<MigrationSummary> =>
    JSON.parse((await db.h.db.selectFrom('catalog_runs').select('summary').where('id', '=', runId).executeTakeFirstOrThrow()).summary) as MigrationSummary;

  async function reportText(runId: string): Promise<string> {
    const fileId = (await db.h.db.selectFrom('catalog_runs').select('report_file_id').where('id', '=', runId).executeTakeFirstOrThrow()).report_file_id;
    if (fileId === null) throw new Error('the run has no report');
    const parts: Uint8Array[] = [];
    for await (const part of (await localStorageDriver(db.dataDir).get(fileId))!) parts.push(part);
    return Buffer.concat(parts).toString('utf8');
  }

  /** The migrated sessions and their rows, without random ids. */
  async function snapshot(): Promise<unknown> {
    const sessions = await db.h.db.selectFrom('stocktakes').selectAll().orderBy('started_at').execute();
    const out = [];
    for (const s of sessions) {
      const rows = await db.h.db
        .selectFrom('stocktake_items')
        .select(['item_id', 'expected', 'state', 'expected_location_id', 'expected_status', 'stat_ddc', 'collection_type_id', 'scanned_at', 'scanned_by', 'scanned_by_name', 'result'])
        .where('stocktake_id', '=', s.id)
        .orderBy('item_id')
        .execute();
      const rest: Record<string, unknown> = { ...s };
      for (const k of ['id', 'created_at', 'updated_at']) delete rest[k];
      out.push({ ...rest, rows: rows.map((r) => ({ ...r, expected: Number(r.expected) })) });
    }
    return out;
  }

  async function wipe(): Promise<void> {
    for (const table of ['stocktakes', 'jobs', 'catalog_runs', 'migration_archive'] as const) await db.h.db.deleteFrom(table).execute();
    await db.h.db.deleteFrom('migration_map').where('run_id', '<>', EARLIER_RUN).execute();
  }

  it('the real run: every session, the last one with its rows; both tables archived; the reconciliation balances', async () => {
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables() }));
    const { runId, jobId } = await start();
    expect(await runToEnd(jobId)).toBe('succeeded');
    const s = await summaryOf(runId);
    expect(s.reconciliation?.ok, JSON.stringify(s.reconciliation)).toBe(true);
    expect(s.tables['stock_take']).toEqual({ source: 3, migrated: 2, merged: 0, skipped: { invalid_date: 1 }, archived: 0 });
    expect(s.tables['stock_take_item']).toEqual({ source: 6, migrated: 3, merged: 0, skipped: { item_missing: 1, duplicate_item: 1, older_session: 1 }, archived: 0 });

    const sessions = await db.h.db.selectFrom('stocktakes').selectAll().orderBy('started_at').execute();
    expect(sessions.map((x) => [x.name, x.status, x.source, x.active_key, x.branch_id])).toEqual([
      ['Inventarisasi 2019', 'finished', 'migrated', null, db.branchId],
      ['Inventarisasi 2023', 'finished', 'migrated', null, db.branchId],
    ]);
    // The older session: its header and the totals SLiMS kept; no rows.
    const [older, last] = sessions as [(typeof sessions)[number], (typeof sessions)[number]];
    expect([older.total, older.found, older.on_loan, older.misplaced]).toEqual([50, 45, 3, 0]);
    expect(Number(older.finished_at)).toBeGreaterThan(Number(older.started_at));
    expect(await db.h.db.selectFrom('stocktake_items').select('item_id').where('stocktake_id', '=', older.id).execute()).toEqual([]);
    // The last one: its rows mapped to the ALTIS copies.
    const rows = await db.h.db.selectFrom('stocktake_items').selectAll().where('stocktake_id', '=', last.id).execute();
    const byItem = new Map(rows.map((r) => [r.item_id, r]));
    expect(rows).toHaveLength(3);
    expect(byItem.get(items.get(101)!)).toMatchObject({ state: 'found', result: 'none', scanned_by_name: 'Petugas Satu', scanned_by: null, expected_status: 'available', stat_ddc: '590' });
    expect(byItem.get(items.get(101)!)!.scanned_at).not.toBeNull();
    expect(byItem.get(items.get(102)!)).toMatchObject({ state: 'pending', result: 'marked_missing', scanned_by_name: null, scanned_at: null });
    expect(byItem.get(items.get(103)!)).toMatchObject({ state: 'on_loan', result: 'none' });
    // Finished in SLiMS, it keeps the totals SLiMS kept, which also count B005 and the second B001 row ALTIS has no copy for.
    expect([last.total, last.found, last.on_loan, last.misplaced, last.unexpected, last.unknown_codes]).toEqual([5, 3, 1, 0, 0, 0]);
    // Both tables are kept whole in the archive too.
    const archived = await db.h.db.selectFrom('migration_archive').select('table_name').where('run_id', '=', runId).execute();
    expect(archived.filter((a) => a.table_name === 'stock_take')).toHaveLength(3);
    expect(archived.filter((a) => a.table_name === 'stock_take_item')).toHaveLength(6);
    // The summary names no officer; the report lists the copy ALTIS lacks.
    expect(JSON.stringify(s)).not.toContain('Petugas Satu');
    const report = await reportText(runId);
    expect(report).toContain('"stock_take_item","2|105","item_missing","B005"');
    expect(report).toContain('"stock_take_item","2|999","duplicate_item","B001"');
    expect(report).not.toContain('Petugas Satu');
  });

  it('a re-run skips every session and row an earlier run brought', async () => {
    const before = await snapshot();
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables() }));
    const again = await start();
    expect(await runToEnd(again.jobId)).toBe('succeeded');
    expect(await snapshot()).toEqual(before);
    const s = await summaryOf(again.runId);
    expect(s.reconciliation?.ok).toBe(true);
    expect(s.tables['stock_take']?.skipped).toEqual({ already_migrated: 2, invalid_date: 1 });
    // Row by row: the rows the earlier run brought; the copy ALTIS lacks and the second row of one copy as before.
    expect(s.tables['stock_take_item']?.skipped).toEqual({ already_migrated: 3, item_missing: 1, duplicate_item: 1, older_session: 1 });
  });

  it('a run that ended within the rows (its job dead): the next run brings the rows it had not', async () => {
    await wipe();
    __setSlimsStageBBatch(1);
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables() }));
    const ended = await start();
    const rowsOfLast = async () => {
      const last = await db.h.db.selectFrom('stocktakes').select('id').where('name', '=', 'Inventarisasi 2023').executeTakeFirst();
      return last === undefined ? [] : db.h.db.selectFrom('stocktake_items').select(['item_id', 'state']).where('stocktake_id', '=', last.id).orderBy('item_id').execute();
    };
    for (let slices = 0; (await rowsOfLast()).length === 0; slices += 1) {
      if (slices > 50) throw new Error('the run never brought a row');
      const job = await claimById(db.h, registry, ended.jobId, { worker: 'test', now: NOW });
      if (job === null) throw new Error('the job cannot be claimed');
      expect((await runSlice(db.h, registry, job, { mode: 'worker', budgetMs: 1, keyring, log: silent, clock: () => NOW, env: {} })).outcome).toBe('continued');
    }
    expect(await rowsOfLast()).toHaveLength(1);
    await db.h.db.updateTable('jobs').set({ status: 'dead', unique_key: null, finished_at: NOW }).where('id', '=', ended.jobId).execute();
    __setSlimsStageBBatch(null);
    const next = await start();
    expect((await db.h.db.selectFrom('catalog_runs').select('status').where('id', '=', ended.runId).executeTakeFirstOrThrow()).status).toBe('failed');
    expect(await runToEnd(next.jobId)).toBe('succeeded');
    expect((await rowsOfLast()).map((r) => r.state).sort()).toEqual(['found', 'on_loan', 'pending']);
    const s = await summaryOf(next.runId);
    expect(s.reconciliation?.ok).toBe(true);
    expect(s.tables['stock_take_item']).toEqual({ source: 6, migrated: 2, merged: 0, skipped: { already_migrated: 1, item_missing: 1, duplicate_item: 1, older_session: 1 }, archived: 0 });
  });

  it('a session SLiMS still has active comes in cancelled, with its rows unfinished, and the report names it', async () => {
    await wipe();
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ active: true }) }));
    const { runId, jobId } = await start();
    expect(await runToEnd(jobId)).toBe('succeeded');
    const last = await db.h.db.selectFrom('stocktakes').selectAll().where('name', '=', 'Inventarisasi 2023').executeTakeFirstOrThrow();
    expect([last.status, last.active_key, last.finished_at]).toEqual(['cancelled', null, null]);
    // SLiMS had not finished it: its counters are counted from its rows.
    expect([last.total, last.found, last.on_loan]).toEqual([3, 1, 1]);
    const rows = await db.h.db.selectFrom('stocktake_items').select(['state', 'result']).where('stocktake_id', '=', last.id).orderBy('state').execute();
    expect(rows).toEqual([
      { state: 'found', result: null },
      { state: 'on_loan', result: null },
      { state: 'pending', result: null },
    ]);
    expect(await reportText(runId)).toContain('"stock_take","2","stocktake_active_cancelled","Inventarisasi 2023"');
    expect((await summaryOf(runId)).reconciliation?.ok).toBe(true);
  });

  it('a dry run writes nothing and counts as the real run does', async () => {
    await wipe();
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables() }));
    const dry = await start({ dryRun: true });
    expect(await runToEnd(dry.jobId)).toBe('succeeded');
    expect(await db.h.db.selectFrom('stocktakes').select('id').execute()).toEqual([]);
    const s = await summaryOf(dry.runId);
    expect(s.reconciliation?.ok).toBe(true);
    expect(s.tables['stock_take']).toMatchObject({ source: 3, migrated: 2, skipped: { invalid_date: 1 } });
    // B005 is an item of the source: the dry run counts it as a real run after the catalogue would.
    expect(s.tables['stock_take_item']).toMatchObject({ source: 6, migrated: 4, skipped: { duplicate_item: 1, older_session: 1 } });
  });

  it('stopped after every batch, and with its counts lost after every other commit, a run ends as one that never stopped', async () => {
    await wipe();
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables() }));
    const whole = await start();
    expect(await runToEnd(whole.jobId)).toBe('succeeded');
    const wholeSummary = await summaryOf(whole.runId);
    const wholeRows = await snapshot();

    await wipe();
    __setSlimsStageBBatch(1);
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables() }));
    const stepped = await start();
    expect(await runToEnd(stepped.jobId, { budgetMs: 1, lose: true })).toBe('succeeded');
    const steppedSummary = await summaryOf(stepped.runId);
    expect(steppedSummary.tables).toEqual(wholeSummary.tables);
    expect(steppedSummary.reconciliation).toEqual(wholeSummary.reconciliation);
    expect(await snapshot()).toEqual(wholeRows);
  });

  it('a source without the stocktake tables reads the rows an earlier run archived, outside the reconciliation', async () => {
    await wipe();
    const tables = slimsTables();
    const archive = async (table: 'stock_take' | 'stock_take_item', key: (r: Record<string, unknown>) => string) => {
      for (const r of tables[table]!.rows) {
        await db.h.db
          .insertInto('migration_archive')
          .values({ id: newId(NOW), run_id: EARLIER_RUN, source: 'slims', table_name: table, legacy_key: key(r), row_json: JSON.stringify(r), created_at: NOW } as never)
          .execute();
      }
    };
    await archive('stock_take', (r) => String(r['stock_take_id']));
    await archive('stock_take_item', (r) => `${String(r['stock_take_id'])}|${String(r['item_id'])}`);
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ withoutStocktake: true }) }));
    const { runId, jobId } = await start();
    expect(await runToEnd(jobId)).toBe('succeeded');
    const s = await summaryOf(runId);
    expect(s.reconciliation?.ok).toBe(true);
    expect(s.tables['stock_take']).toBeUndefined();
    expect(s.tables['stock_take_item']).toBeUndefined();
    const sessions = await db.h.db.selectFrom('stocktakes').select(['id', 'name', 'total', 'found', 'on_loan']).orderBy('started_at').execute();
    expect(sessions.map((x) => [x.name, x.total, x.found, x.on_loan])).toEqual([
      ['Inventarisasi 2019', 50, 45, 3],
      ['Inventarisasi 2023', 5, 3, 1],
    ]);
    expect(await reportText(runId)).toContain('"stock_take_item","2|105","item_missing","B005"');
  });
});
