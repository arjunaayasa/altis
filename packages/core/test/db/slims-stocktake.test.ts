import { createHash, randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
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
import { getStocktake } from '../../src/stocktake/sessions.js';
import { stocktakeReportFileId, stocktakeSlimsReport } from '../../src/stocktake/slims-report.js';
import { fakeSlimsFactory, type FakeSlimsTable } from '../fixtures/slims-fake.js';
import { ACTOR, NOW, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// The SLiMS migration's stocktake stage on the engine picked by ALTIS_TEST_DB, through the real framework (an in-memory
// source of synthetic SLiMS rows, written for this test; the catalogue seeded in ALTIS with its legacy map, as the
// catalogue stages would leave it). SLiMS 9 table/column names (interoperability facts, no SLiMS code). Checked: every
// session comes in (an older one with the totals SLiMS kept, one without a start date skipped), the last one with its
// rows mapped to ALTIS copies (found by the officer's name, missing, on loan; a copy ALTIS lacks, a second row of one
// copy and a row of an older session skipped), keeping the totals SLiMS kept for it as it finished it; a session still
// active comes in cancelled, its counters counted from its rows, and is named in the report, and comes in again finished,
// with its rows as SLiMS left them, once SLiMS finished it; both tables are also
// archived, and the reconciliation balances; a re-run skips what an earlier run brought, row by row, and a run after one
// that ended within the rows brings the rest; a dry run writes nothing and counts alike; a run stopped after every batch, with its
// counts lost after every other commit, ends as one that never stopped; a source without the tables reads the rows an
// earlier run archived, outside the reconciliation.
//
// The report files SLiMS names for its sessions, through an in-memory files source: stored as the session's staff-only
// file (counted as `stock_take.report_file`), reported only when the source lacks the file or refuses it (too large,
// empty, a name that leaves the reports folder), counted alike by a dry run, kept once by a re-run, and stored again
// under the same key by a run after one that died between storing and committing: every blob has its row.

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

/**
 * The synthetic SLiMS source; `active`: the last session is still active in SLiMS; `report`: its report file;
 * `reports`: the report file of each session by id.
 */
function slimsTables(o: { active?: boolean; withoutStocktake?: boolean; report?: string; reports?: Record<number, string> } = {}): Record<string, FakeSlimsTable> {
  const session = (
    id: number,
    name: string,
    start: string,
    end: string | null,
    totals: [number, number, number, number],
    active = 0,
    report: string | null = null,
  ) => ({
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
    report_file: report,
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
  const r = o.reports ?? {};
  tables['stock_take'] = t(SESSION_COLUMNS, [
    session(1, 'Inventarisasi 2019', '2019-07-01 08:00:00', '2019-07-03 15:00:00', [50, 2, 45, 3], 0, r[1] ?? null),
    session(2, 'Inventarisasi 2023', '2023-06-05 08:00:00', o.active === true ? null : '2023-06-07 16:00:00', [5, 1, 3, 1], o.active === true ? 1 : 0, o.report ?? r[2] ?? null),
    session(3, 'Tanpa tanggal', '0000-00-00 00:00:00', null, [0, 0, 0, 0], 0, r[3] ?? null),
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
      // The report's id is derived from the session's: whether it is the session's own is what compares.
      rest['report_file_id'] = s.report_file_id === null ? null : s.report_file_id === stocktakeReportFileId(s.id);
      out.push({ ...rest, rows: rows.map((r) => ({ ...r, expected: Number(r.expected) })) });
    }
    return out;
  }

  async function wipe(): Promise<void> {
    for (const table of ['stocktakes', 'jobs', 'catalog_runs', 'migration_archive'] as const) await db.h.db.deleteFrom(table).execute();
    await db.h.db.deleteFrom('migration_map').where('run_id', '<>', EARLIER_RUN).execute();
    await db.h.db.deleteFrom('files').execute();
    await fsp.rm(path.join(db.dataDir, 'uploads'), { recursive: true, force: true });
  }

  /** The names of every stored blob (`uploads/<yyyy>/<mm>/<id>`). */
  async function blobs(): Promise<string[]> {
    const root = path.join(db.dataDir, 'uploads');
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory()) await walk(path.join(dir, e.name));
        else if (!e.name.startsWith('.')) out.push(e.name);
      }
    };
    await walk(root);
    return out.sort();
  }

  /** Every blob has its `files` row and every row its blob: nothing left behind. */
  async function noOrphan(): Promise<void> {
    const rows = (await db.h.db.selectFrom('files').select('id').execute()).map((r) => r.id).sort();
    expect(await blobs()).toEqual(rows);
  }

  const REPORT = 'files/reports/stock_take_2023_report.html';
  const html = (title: string): Uint8Array => new TextEncoder().encode(`<html><body><h1>${title}</h1><p>Laporan uji, ditulis untuk tes ini.</p></body></html>`);
  const sessionOf = (name: string) => db.h.db.selectFrom('stocktakes').selectAll().where('name', '=', name).executeTakeFirstOrThrow();

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

  it('a session active at an earlier run and finished in SLiMS since comes in again, finished, with its rows as SLiMS left them', async () => {
    await wipe();
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ active: true }) }));
    const first = await start();
    expect(await runToEnd(first.jobId)).toBe('succeeded');
    const before = await db.h.db.selectFrom('stocktakes').select(['id', 'status']).where('name', '=', 'Inventarisasi 2023').executeTakeFirstOrThrow();
    expect(before.status).toBe('cancelled');
    // SLiMS finished it since: B002 turned up after all.
    const later = slimsTables();
    later['stock_take_item']!.rows.find((r) => r['item_id'] === 102)!['status'] = 'e';

    __setSlimsSourceFactory(fakeSlimsFactory({ tables: later }));
    const dry = await start({ dryRun: true });
    expect(await runToEnd(dry.jobId)).toBe('succeeded');
    const drySummary = await summaryOf(dry.runId);

    __setSlimsSourceFactory(fakeSlimsFactory({ tables: later }));
    const again = await start();
    expect(await runToEnd(again.jobId)).toBe('succeeded');
    const last = await db.h.db.selectFrom('stocktakes').selectAll().where('name', '=', 'Inventarisasi 2023').executeTakeFirstOrThrow();
    expect(last.id).toBe(before.id);
    expect(last.status).toBe('finished');
    expect(Number(last.finished_at)).toBeGreaterThan(Number(last.started_at));
    expect([last.total, last.found, last.on_loan]).toEqual([5, 3, 1]);
    const rows = await db.h.db.selectFrom('stocktake_items').select(['item_id', 'state', 'result']).where('stocktake_id', '=', last.id).execute();
    expect(new Map(rows.map((r) => [r.item_id, [r.state, r.result]]))).toEqual(
      new Map([
        [items.get(101)!, ['found', 'none']],
        [items.get(102)!, ['found', 'none']],
        [items.get(103)!, ['on_loan', 'none']],
      ]),
    );
    const s = await summaryOf(again.runId);
    expect(s.reconciliation?.ok).toBe(true);
    expect(s.tables['stock_take']).toEqual({ source: 3, migrated: 1, merged: 0, skipped: { already_migrated: 1, invalid_date: 1 }, archived: 0 });
    expect(s.tables['stock_take_item']).toEqual({ source: 6, migrated: 3, merged: 0, skipped: { item_missing: 1, duplicate_item: 1, older_session: 1 }, archived: 0 });
    expect(await reportText(again.runId)).toContain('"stock_take","2","stocktake_finished_since","Inventarisasi 2023"');
    // The dry run before it counted alike (B005, an item of the source, as a real run after the catalogue would).
    expect(drySummary.tables['stock_take']).toEqual(s.tables['stock_take']);
    expect(drySummary.tables['stock_take_item']).toMatchObject({ source: 6, migrated: 4, skipped: { duplicate_item: 1, older_session: 1 } });

    // A third run finds it finished: nothing changes.
    const snap = await snapshot();
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: later }));
    const third = await start();
    expect(await runToEnd(third.jobId)).toBe('succeeded');
    expect(await snapshot()).toEqual(snap);
    expect((await summaryOf(third.runId)).tables['stock_take']?.skipped).toEqual({ already_migrated: 2, invalid_date: 1 });
  });

  it('a session whose SLiMS report file the run has no files for: the report names the file, in the dry run and the real run', async () => {
    await wipe();
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ report: 'stock_take_2023_report.html' }) }));
    const dry = await start({ dryRun: true });
    expect(await runToEnd(dry.jobId)).toBe('succeeded');
    const line = `"stock_take","2","stocktake_report_not_migrated","${REPORT}"`;
    expect(await reportText(dry.runId)).toContain(line);
    const real = await start();
    expect(await runToEnd(real.jobId)).toBe('succeeded');
    expect(await reportText(real.runId)).toContain(line);
    expect((await sessionOf('Inventarisasi 2023')).report_file_id).toBeNull();
    // A session without a report file names none.
    expect((await reportText(real.runId)).match(/stocktake_report_not_migrated/g)).toHaveLength(1);
    for (const runId of [dry.runId, real.runId]) {
      const s = await summaryOf(runId);
      expect(s.tables['stock_take.report_file']).toEqual({ source: 1, migrated: 0, merged: 0, skipped: { missing_file: 1 }, archived: 0 });
      expect(s.reconciliation?.ok).toBe(true);
    }
  });

  it('the SLiMS report file of a session: stored as its staff-only file; the dry run counts it; a re-run keeps the one', async () => {
    await wipe();
    const bytes = html('Inventarisasi 2023');
    const files = { [REPORT]: bytes };
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ report: 'stock_take_2023_report.html' }), files }));
    const dry = await start({ dryRun: true, files: 'dir', filesDir: '/slims' });
    expect(await runToEnd(dry.jobId)).toBe('succeeded');
    const counted = { source: 1, migrated: 1, merged: 0, skipped: {}, archived: 0 };
    expect((await summaryOf(dry.runId)).tables['stock_take.report_file']).toEqual(counted);
    expect(await db.h.db.selectFrom('files').select('id').where('context', '=', 'stocktake.slims_report').execute()).toEqual([]);

    const real = await start({ files: 'dir', filesDir: '/slims' });
    expect(await runToEnd(real.jobId)).toBe('succeeded');
    const s = await summaryOf(real.runId);
    expect(s.tables['stock_take.report_file']).toEqual(counted);
    expect(s.reconciliation?.ok).toBe(true);
    expect(await reportText(real.runId)).not.toContain('stocktake_report_not_migrated');
    const session = await sessionOf('Inventarisasi 2023');
    expect(session.report_file_id).toBe(stocktakeReportFileId(session.id));
    const file = await db.h.db.selectFrom('files').selectAll().where('id', '=', session.report_file_id!).executeTakeFirstOrThrow();
    expect(file).toMatchObject({
      original_name: 'stock_take_2023_report.html',
      mime: 'application/octet-stream',
      context: 'stocktake.slims_report',
      owner_type: 'stocktakes',
      owner_id: session.id,
      access: 'staff',
      status: 'ok',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(Number(file.size)).toBe(bytes.byteLength);
    // The session's view says it has one, and its route serves those bytes; the older session has none.
    expect((await getStocktake(db.h.db, db.branchId, session.id)).migratedReport).toEqual({ name: 'stock_take_2023_report.html', size: bytes.byteLength });
    expect((await getStocktake(db.h.db, db.branchId, (await sessionOf('Inventarisasi 2019')).id)).migratedReport).toBeNull();
    const served = await stocktakeSlimsReport(db.h.db, localStorageDriver(db.dataDir), db.branchId, session.id);
    const parts: Uint8Array[] = [];
    for await (const part of served.content) parts.push(part);
    expect(Buffer.concat(parts).equals(Buffer.from(bytes))).toBe(true);
    await expect(stocktakeSlimsReport(db.h.db, localStorageDriver(db.dataDir), db.otherBranchId, session.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await noOrphan();

    // A second run over the same source keeps the one file.
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ report: 'stock_take_2023_report.html' }), files }));
    const again = await start({ files: 'dir', filesDir: '/slims' });
    expect(await runToEnd(again.jobId)).toBe('succeeded');
    expect((await summaryOf(again.runId)).tables['stock_take.report_file']).toEqual({ source: 1, migrated: 0, merged: 0, skipped: { already_migrated: 1 }, archived: 0 });
    expect(await db.h.db.selectFrom('files').select('id').where('context', '=', 'stocktake.slims_report').execute()).toEqual([{ id: session.report_file_id }]);
    await noOrphan();
  });

  it('a report file the source lacks or refuses keeps its report row and leaves the session without one', async () => {
    const cases: { name: string; files: Record<string, Uint8Array>; reason: string; detail: string }[] = [
      { name: 'hilang_report.html', files: {}, reason: 'missing_file', detail: 'files/reports/hilang_report.html' },
      {
        name: 'besar_report.html',
        files: { 'files/reports/besar_report.html': new Uint8Array(20 * 1024 * 1024 + 1) },
        reason: 'file_too_large',
        detail: 'files/reports/besar_report.html > 20 MB',
      },
      { name: 'kosong_report.html', files: { 'files/reports/kosong_report.html': new Uint8Array(0) }, reason: 'empty_file', detail: 'files/reports/kosong_report.html: kosong / empty' },
      // The name comes from another system's database: one that leaves the reports folder is never looked up.
      { name: '../../config/database.php', files: { 'config/database.php': html('rahasia') }, reason: 'unsafe_name', detail: '../../config/database.php: nama berkas tidak aman / unsafe file name' },
      { name: 'sub/x_report.html', files: { 'files/reports/sub/x_report.html': html('sub') }, reason: 'unsafe_name', detail: 'sub/x_report.html: nama berkas tidak aman / unsafe file name' },
    ];
    for (const k of cases) {
      await wipe();
      for (const dryRun of [true, false]) {
        __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ reports: { 1: k.name, 3: 'tanpa_tanggal_report.html' } }), files: k.files }));
        const run = await start({ dryRun, files: 'dir', filesDir: '/slims' });
        expect(await runToEnd(run.jobId), k.name).toBe('succeeded');
        const s = await summaryOf(run.runId);
        // The session without a valid start date is no session of the run: its file is skipped without a report row.
        expect(s.tables['stock_take.report_file'], k.name).toEqual({ source: 2, migrated: 0, merged: 0, skipped: { [k.reason]: 1, session_missing: 1 }, archived: 0 });
        expect(s.reconciliation?.ok, k.name).toBe(true);
        const report = await reportText(run.runId);
        expect(report, k.name).toContain(`"stock_take","1","stocktake_report_not_migrated","${k.detail}"`);
        expect(report.match(/stocktake_report_not_migrated/g), k.name).toHaveLength(1);
      }
      expect((await sessionOf('Inventarisasi 2019')).report_file_id, k.name).toBeNull();
      expect(await db.h.db.selectFrom('files').select('id').where('context', '=', 'stocktake.slims_report').execute(), k.name).toEqual([]);
      await noOrphan();
    }
  });

  it('a run that died between storing a report and committing it: the next run stores it again under the same key, nothing is left behind', async () => {
    await wipe();
    const files = { [REPORT]: html('Inventarisasi 2023') };
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ report: 'stock_take_2023_report.html' }), files }));
    const first = await start({ files: 'dir', filesDir: '/slims' });
    expect(await runToEnd(first.jobId)).toBe('succeeded');
    const session = await sessionOf('Inventarisasi 2023');
    const fileId = session.report_file_id!;
    // What a death before the commit leaves: the stored blob, without its row, the session's link or the map row.
    await db.h.db.updateTable('stocktakes').set({ report_file_id: null }).where('id', '=', session.id).execute();
    await db.h.db.deleteFrom('files').where('id', '=', fileId).execute();
    await db.h.db.deleteFrom('migration_map').where('entity', '=', 'stock_take_report').execute();
    expect(await blobs()).toContain(fileId);

    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ report: 'stock_take_2023_report.html' }), files }));
    const next = await start({ files: 'dir', filesDir: '/slims' });
    expect(await runToEnd(next.jobId)).toBe('succeeded');
    expect((await sessionOf('Inventarisasi 2023')).report_file_id).toBe(fileId);
    expect((await summaryOf(next.runId)).tables['stock_take.report_file']).toEqual({ source: 1, migrated: 1, merged: 0, skipped: {}, archived: 0 });
    await noOrphan();
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
    // Both dated sessions name a report file the source has; the undated one names one too.
    const reports = { 1: 'stock_take_2019_report.html', 2: 'stock_take_2023_report.html', 3: 'tanpa_tanggal_report.html' };
    const files = { 'files/reports/stock_take_2019_report.html': html('2019'), [REPORT]: html('2023') };
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ reports }), files }));
    const whole = await start({ files: 'dir', filesDir: '/slims' });
    expect(await runToEnd(whole.jobId)).toBe('succeeded');
    const wholeSummary = await summaryOf(whole.runId);
    expect(wholeSummary.tables['stock_take.report_file']).toEqual({ source: 3, migrated: 2, merged: 0, skipped: { session_missing: 1 }, archived: 0 });
    const wholeRows = await snapshot();

    await wipe();
    __setSlimsStageBBatch(1);
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ reports }), files }));
    const stepped = await start({ files: 'dir', filesDir: '/slims' });
    expect(await runToEnd(stepped.jobId, { budgetMs: 1, lose: true })).toBe('succeeded');
    const steppedSummary = await summaryOf(stepped.runId);
    expect(steppedSummary.tables).toEqual(wholeSummary.tables);
    expect(steppedSummary.reconciliation).toEqual(wholeSummary.reconciliation);
    expect(await snapshot()).toEqual(wholeRows);
    // Exactly one report per session, and no blob without its row.
    expect(await db.h.db.selectFrom('files').select('owner_id').where('context', '=', 'stocktake.slims_report').execute()).toHaveLength(2);
    await noOrphan();
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
