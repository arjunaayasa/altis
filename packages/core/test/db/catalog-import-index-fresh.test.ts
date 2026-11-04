import { withTx, type DbHandle } from '@altis/db';
import { InsertQueryNode, SelectQueryNode, type KyselyPlugin, type QueryId } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { startCatalogImport } from '../../src/catalog/exchange/import-job.js';
import { createItem } from '../../src/catalog/items/service.js';
import { createRecord, updateRecord } from '../../src/catalog/records/service.js';
import { txCtx, type CoreLogger } from '../../src/context.js';
import { claimById } from '../../src/jobs/claim.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { SliceResult } from '../../src/jobs/types.js';
import { KEYRING, importOptions, openExchangeDb, stageFile, type ExchangeDb } from './catalog-exchange-support.js';
import { NOW } from './catalog-records-support.js';

// Cross-group review X1-1 (Phase 2): an import batch is one transaction of up to 200 units whose first statement is a
// plain read (the legacy map), so on MySQL/MariaDB (REPEATABLE READ) every later plain read of it comes from the
// snapshot that read took. A librarian's save of record R that commits after it (a new author) is not in what a later
// unit of the batch reads when it writes one of R's items and indexes R: the batch would write R's document without
// the author over the librarian's. The import job therefore builds the documents of every record a batch wrote once
// more, in a transaction of its own right after the batch's COMMIT that locks those records first, and a slice that
// ends between the two does it at its next start. PostgreSQL reads the latest commit per statement, and SQLite has one
// writer (the librarian waits for the whole batch), so the race cases run on the server engines only (on PostgreSQL
// they hold by construction); the cut-off case runs everywhere.

const ctx = testDbContext();
const SQLITE = ctx.engine === 'sqlite';
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

describe.skipIf(!ctx.available)(`catalog import: documents built from the latest commit (X1-1) [${engineLabel()}]`, () => {
  let db: ExchangeDb;
  let buku: string;
  let umum: string;

  beforeAll(async () => {
    db = await openExchangeDb('import-index-fresh');
    buku = await db.materialTypeId('BUKU');
    umum = await db.collectionTypeId('UMUM');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  /** A record by `Lama, Penulis` with the item `barcode`; its id (version 0). */
  async function seed(title: string, barcode: string): Promise<string> {
    const { id } = await db.run((tx) => createRecord(tx, { materialTypeId: buku, title, agents: [{ ref: { type: 'person', name: 'Lama, Penulis' }, role: 'aut', isMain: true }] }));
    await db.run((tx) => createItem(tx, db.branchId, { recordId: id, barcode, collectionTypeId: umum, status: 'available', partsTotal: 1 }));
    return id;
  }

  /** The stored `t_agents` of `recordId`'s document. */
  const agentsOf = async (recordId: string): Promise<string> =>
    (await db.h.db.selectFrom('search_doc').select('t_agents').where('record_id', '=', recordId).executeTakeFirstOrThrow()).t_agents;

  /** Starts an import of the csv-items file `csv` with `options`; its job id. */
  async function started(csv: string, options: Parameters<typeof importOptions>[0]): Promise<string> {
    const stagingId = await stageFile(db, csv);
    const body = importOptions({ uploadId: stagingId, format: 'csv-items', ...options });
    return (await withTx(db.h, (trx) => startCatalogImport(txCtx(trx, NOW, db.staff), db.reg, { body, stagingId }, { keyring: KEYRING }))).jobId;
  }

  /** One slice of job `jobId` through `h` on the clock `now`. */
  async function slice(h: DbHandle, jobId: string, now: number): Promise<SliceResult['outcome']> {
    const job = await claimById(h, db.reg, jobId, { worker: 'test', now });
    if (job === null) throw new Error(`job ${jobId} cannot be claimed`);
    return (await runSlice(h, db.reg, job, { mode: 'worker', budgetMs: 20_000, keyring: KEYRING, log: silent, clock: () => now, env: {} })).outcome;
  }

  /** Runs job `jobId` to its end on the clock `now`; the last outcome. */
  async function toEnd(jobId: string, now: number): Promise<SliceResult['outcome']> {
    for (let n = 0; n < 20; n += 1) {
      const outcome = await slice(db.h, jobId, now);
      if (outcome !== 'continued') return outcome;
    }
    throw new Error('the import did not end');
  }

  /**
   * The test handle with a gate after the import batch's first statement (its read of the legacy map, which starts the
   * batch's MySQL/MariaDB snapshot): `reached` once the batch is there, `open()` lets it go on.
   */
  function gated(): { h: DbHandle; reached: Promise<void>; open(): void } {
    let seen = false;
    const held = new Set<QueryId>();
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const plugin: KyselyPlugin = {
      transformQuery({ node, queryId }) {
        if (!seen && SelectQueryNode.is(node) && JSON.stringify(node.from).includes('"migration_map"')) {
          seen = true;
          held.add(queryId);
        }
        return node;
      },
      async transformResult({ queryId, result }) {
        if (held.delete(queryId)) {
          reach();
          await gate;
        }
        return result;
      },
    };
    return { h: { ...db.h, db: db.h.db.withPlugin(plugin) }, reached, open };
  }

  /**
   * Runs the import of `csv` (job started now) while a librarian adds the author `Kebaruan, Pengarang` to `recordId`
   * and commits after the batch's first read; R's stored `t_agents` once the import ended.
   */
  async function importBesideSave(recordId: string, csv: string, options: Parameters<typeof importOptions>[0]): Promise<string> {
    const jobId = await started(csv, options);
    const g = gated();
    const first = slice(g.h, jobId, NOW);
    try {
      await Promise.race([
        g.reached,
        first.then(() => {
          throw new Error('the slice ended before its batch read the legacy map');
        }),
      ]);
      await db.run(
        (tx) =>
          updateRecord(tx, recordId, {
            version: 0,
            agents: [
              { ref: { type: 'person', name: 'Lama, Penulis' }, role: 'aut', isMain: true },
              { ref: { type: 'person', name: 'Kebaruan, Pengarang' }, role: 'aut', isMain: false },
            ],
          }),
        NOW + 1000,
      );
    } finally {
      g.open();
    }
    const outcome = await first;
    if (outcome === 'continued') expect(await toEnd(jobId, NOW)).toBe('succeeded');
    else expect(outcome).toBe('succeeded');
    return agentsOf(recordId);
  }

  it.skipIf(SQLITE)('an item row that creates an item of R after a librarian saved R with a new author: R keeps the author in its document', async () => {
    const recordId = await seed('Gelombang impor pertama', 'IF-1');
    const agents = await importBesideSave(recordId, `barcode,record_id\r\nIF-2,${recordId}\r\n`, { branchId: db.branchId });
    expect(await db.h.db.selectFrom('items').select('barcode_key').where('record_id', '=', recordId).orderBy('barcode_key').execute()).toEqual([
      { barcode_key: 'IF-1' },
      { barcode_key: 'IF-2' },
    ]);
    expect(agents).toContain('kebaruan');
  });

  it.skipIf(SQLITE)('an item row that updates a note of R’s item after a librarian saved R with a new author: R keeps the author in its document', async () => {
    const recordId = await seed('Gelombang impor kedua', 'IG-1');
    const agents = await importBesideSave(recordId, 'barcode,note\r\nIG-1,Sampul robek\r\n', { onMatch: 'update' });
    expect((await db.h.db.selectFrom('items').select('note').where('barcode_key', '=', 'IG-1').executeTakeFirstOrThrow()).note).toBe('Sampul robek');
    expect(agents).toContain('kebaruan');
  });

  it('a slice that ends right after a batch’s COMMIT: the next slice builds the documents of what the batch wrote again', async () => {
    const recordId = await seed('Gelombang impor ketiga', 'IH-1');
    const jobId = await started(`barcode,record_id\r\nIH-2,${recordId}\r\n`, { branchId: db.branchId });
    // The statement after the batch's `catalog.bulk.changed` (its last) fails once: the process ends there.
    let published = false;
    let failed = false;
    const plugin: KyselyPlugin = {
      transformQuery({ node }) {
        if (published && !failed) {
          failed = true;
          throw new Error('the process ended after the batch committed');
        }
        if (InsertQueryNode.is(node) && JSON.stringify(node).includes('catalog.bulk.changed')) published = true;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    };
    expect(await slice({ ...db.h, db: db.h.db.withPlugin(plugin) }, jobId, NOW)).toBe('retry');
    expect(failed).toBe(true);
    expect((await db.h.db.selectFrom('items').select('record_id').where('barcode_key', '=', 'IH-2').executeTakeFirstOrThrow()).record_id).toBe(recordId);
    // A change of R's author the batch never saw, as a commit after its snapshot would be (and no index write of its own).
    const agent = (await db.h.db.selectFrom('record_agents').select('agent_id').where('record_id', '=', recordId).executeTakeFirstOrThrow()).agent_id;
    await db.h.db.updateTable('agents').set({ name_display: 'Kebaruan, Pengarang' }).where('id', '=', agent).execute();
    expect(await agentsOf(recordId)).not.toContain('kebaruan');
    expect(await toEnd(jobId, NOW + 3_600_000)).toBe('succeeded');
    expect(await agentsOf(recordId)).toContain('kebaruan');
    // Nothing of it is left to a reindex job (spec §4.1: the import indexes itself).
    expect(await db.h.db.selectFrom('jobs').select('id').where('type', '=', 'catalog.reindex').execute()).toEqual([]);
  });
});
