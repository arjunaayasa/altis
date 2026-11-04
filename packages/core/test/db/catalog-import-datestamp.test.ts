import { withTx, type DbHandle } from '@altis/db';
import { DeleteQueryNode, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { startCatalogImport } from '../../src/catalog/exchange/import-job.js';
import { createItem } from '../../src/catalog/items/service.js';
import { createRecord } from '../../src/catalog/records/service.js';
import { txCtx, type CoreLogger } from '../../src/context.js';
import { claimById } from '../../src/jobs/claim.js';
import { runSlice } from '../../src/jobs/slice.js';
import { wipeCatalog } from '../support/search-corpus.js';
import { KEYRING, importOptions, openExchangeDb, stageFile, type ExchangeDb } from './catalog-exchange-support.js';
import { NOW } from './catalog-records-support.js';

// C14 (Phase 2 big review): an import batch stamps the OAI datestamp of the records it wrote (`records.changed_at` and
// the copy in `search_doc`) with the clock read right before its COMMIT, not with the one read when the batch began. A
// harvest that ran while the batch was open answered a later responseDate, its next `from`, which must still select
// these records. The clock here moves on 5 s at the batch's first DELETE of `search_facet` (inside indexRecords).

const ctx = testDbContext();
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

describe.skipIf(!ctx.available)(`catalog import: the datestamp of a batch (C14) [${engineLabel()}]`, () => {
  let db: ExchangeDb;

  beforeAll(async () => {
    db = await openExchangeDb('import-datestamp');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await wipeCatalog(db.h);
    for (const table of ['migration_map', 'catalog_runs'] as const) await db.h.db.deleteFrom(table).execute();
  });

  /** Runs the import of `csv` with `options` to its end on a clock that moves on 5 s at the first index DELETE. */
  async function importOnMovingClock(csv: string, options: Parameters<typeof importOptions>[0] = {}): Promise<{ moved: boolean }> {
    const stagingId = await stageFile(db, csv);
    const body = importOptions({ uploadId: stagingId, format: 'csv-records', ...options });
    const started = await withTx(db.h, (trx) => startCatalogImport(txCtx(trx, NOW, db.staff), db.reg, { body, stagingId }, { keyring: KEYRING }));
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
    const watched: DbHandle = { ...db.h, db: db.h.db.withPlugin(plugin) };
    for (let n = 0; n < 20; n += 1) {
      const job = await claimById(watched, db.reg, started.jobId, { worker: 'test', now: clock });
      if (job === null) throw new Error('the import cannot be claimed');
      const r = await runSlice(watched, db.reg, job, { mode: 'worker', budgetMs: 20_000, keyring: KEYRING, log: silent, clock: () => clock, env: {} });
      if (r.outcome === 'continued') continue;
      expect(r.outcome).toBe('succeeded');
      return { moved };
    }
    throw new Error('the import did not end');
  }

  it('the records a batch creates carry the clock read at its end, in records and in search_doc', async () => {
    const { moved } = await importOnMovingClock('title\r\nHikayat satu\r\nHikayat dua\r\n');
    expect(moved).toBe(true);
    const stamps = await db.h.db.selectFrom('records').select(['title', 'changed_at']).orderBy('title').execute();
    expect(stamps.map((r) => [r.title, Number(r.changed_at)])).toEqual([
      ['Hikayat dua', NOW + 5000],
      ['Hikayat satu', NOW + 5000],
    ]);
    const docs = await db.h.db.selectFrom('search_doc').select('changed_at').execute();
    expect(docs.map((d) => Number(d.changed_at))).toEqual([NOW + 5000, NOW + 5000]);
  });

  it('an item row whose change is public moves its record to the clock at the end; a note-only change leaves it', async () => {
    const before = NOW - 3_600_000;
    const buku = await db.materialTypeId('BUKU');
    const umum = await db.collectionTypeId('UMUM');
    const recordOf = async (title: string, barcode: string): Promise<string> => {
      const { id } = await db.run((tx) => createRecord(tx, { materialTypeId: buku, title }), before);
      await db.run((tx) => createItem(tx, db.branchId, { recordId: id, barcode, collectionTypeId: umum, status: 'available', partsTotal: 1 }), before);
      return id;
    };
    const noted = await recordOf('Catatan saja', 'DS-1');
    const repaired = await recordOf('Status berubah', 'DS-2');
    const { moved } = await importOnMovingClock('barcode,note,status\r\nDS-1,Sampul robek,\r\nDS-2,,repair\r\n', { format: 'csv-items', onMatch: 'update' });
    expect(moved).toBe(true);
    const stampOf = async (id: string) => [
      Number((await db.h.db.selectFrom('records').select('changed_at').where('id', '=', id).executeTakeFirstOrThrow()).changed_at),
      Number((await db.h.db.selectFrom('search_doc').select('changed_at').where('record_id', '=', id).executeTakeFirstOrThrow()).changed_at),
    ];
    expect(await db.h.db.selectFrom('items').select(['barcode_key', 'note', 'status']).orderBy('barcode_key').execute()).toEqual([
      { barcode_key: 'DS-1', note: 'Sampul robek', status: 'available' },
      { barcode_key: 'DS-2', note: null, status: 'repair' },
    ]);
    expect(await stampOf(noted)).toEqual([before, before]);
    expect(await stampOf(repaired)).toEqual([NOW + 5000, NOW + 5000]);
  });
});
