import fsp from 'node:fs/promises';
import path from 'node:path';
import { withTx } from '@altis/db';
import type { MarcJsonRecord } from '@altis/shared/api/catalog/exchange';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { startCatalogExport } from '../../src/catalog/exchange/export-job.js';
import { createItem } from '../../src/catalog/items/service.js';
import { archiveRecord, createRecord } from '../../src/catalog/records/service.js';
import { txCtx } from '../../src/context.js';
import { readIso2709, readMarcXml } from '../../src/marc/index.js';
import { KEYRING, drive, exportFile, openExchangeDb, reportRows, runOf, type ExchangeDb } from './catalog-exchange-support.js';
import { DAY, NOW } from './catalog-records-support.js';

// The export job (Phase 2 Task 31; spec §5.1, §5.4; P2-21, S5; Review Focus 5) on the engine picked by ALTIS_TEST_DB,
// run through the queue's claim path:
// - Review Focus 5: a record ISO 2709 cannot hold is skipped and reported (`marc_too_long`), and the file reads back
//   with no error; MARCXML has no such limit;
// - S5: the staff export keeps a record's 541;
// - MARC-in-JSON lines; the filters (record ids in their order, archived records, the material type, the search);
// - sliced: a slice appends to the file and checkpoints its length; a resumed slice cuts off what a killed one wrote
//   after its checkpoint, and the result equals an export done in one slice;
// - the file's name, size and `expires_at = now + 7 d` on the run.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`catalog export job [${engineLabel()}]`, () => {
  let db: ExchangeDb;
  let buku: string;

  beforeAll(async () => {
    db = await openExchangeDb('export');
    buku = await db.materialTypeId('BUKU');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    for (const table of ['item_events', 'items', 'custom_values', 'jobs', 'locks', 'catalog_runs'] as const) await db.h.db.deleteFrom(table).execute();
    await db.h.db.deleteFrom('records').execute();
  });

  const book = (title: string, o: Record<string, unknown> = {}) => db.run(async (tx) => (await createRecord(tx, { materialTypeId: buku, title, ...o })).id);

  it('Review Focus 5: a record above 99 999 bytes is skipped in marc21 (marc_too_long) and the file reads back cleanly', async () => {
    const first = await book('Pertama');
    const huge = await book('Raksasa', { summary: 'a'.repeat(59_000), notes: 'b'.repeat(59_000) });
    const last = await book('Terakhir');
    const r = await exportFile(db, { format: 'marc21', filter: {} });
    expect(r.run.status).toBe('succeeded');
    expect(r.summary).toMatchObject({ records: 2, skipped: { marc_too_long: 1 } });
    const reader = readIso2709();
    const results = [...reader.push(r.bytes!), ...reader.end()];
    expect(results.map((x) => (x.ok ? [] : x.error))).toEqual([[], []]);
    const ids = results.map((x) => (x.ok ? x.record.fields.find((f) => f.tag === '001') : null)).map((f) => (f !== null && f !== undefined && 'value' in f ? f.value : null));
    expect(ids).toEqual([first, last]);
    expect(await reportRows(db, r.run)).toEqual([[huge, 'skipped', 'marc_too_long', 'Raksasa']]);

    // MARCXML holds it.
    const xml = await exportFile(db, { format: 'marcxml', filter: {} });
    const xr = readMarcXml();
    const read = [...xr.push(xml.bytes!), ...xr.end()];
    expect(read.map((x) => x.ok)).toEqual([true, true, true]);
    expect(xml.summary).toMatchObject({ records: 3, skipped: { marc_too_long: 0 } });
  });

  it('S5: the staff marc21 export keeps the 541 (acquisition source) of a record and its other MARC extra fields', async () => {
    await book('Atlas Lama', {
      marcExtra: [
        { tag: '541', ind1: '1', ind2: ' ', data: JSON.stringify([['a', 'Toko Buku Sentosa'], ['c', 'Pembelian']]) },
        { tag: '590', ind1: ' ', ind2: ' ', data: JSON.stringify([['a', 'Catatan lokal']]) },
      ],
    });
    const r = await exportFile(db, { format: 'marc21', filter: {} });
    const reader = readIso2709();
    const [rec] = [...reader.push(r.bytes!), ...reader.end()];
    expect(rec?.ok).toBe(true);
    const tags = rec!.ok ? rec!.record.fields.map((f) => f.tag) : [];
    expect(tags).toEqual(expect.arrayContaining(['541', '590']));
  });

  it('marcjson: one MarcJsonRecord per line; recordIds keep their order; archived records only with includeArchived', async () => {
    const a = await book('Alfa');
    const b = await book('Beta');
    const c = await book('Gamma');
    await db.run((tx) => archiveRecord(tx, b, 0));
    const r = await exportFile(db, { format: 'marcjson', filter: { recordIds: [c, b, a] } });
    const lines = r.bytes!.toString('utf8').split('\n').filter((l) => l !== '');
    const records = lines.map((l) => JSON.parse(l) as MarcJsonRecord);
    const idOf = (m: MarcJsonRecord) => (m.fields.find((f) => '001' in f) as { '001': string })['001'];
    expect(records.map(idOf)).toEqual([c, a]);
    expect(records[0]!.leader).toHaveLength(24);
    const all = await exportFile(db, { format: 'marcjson', filter: { recordIds: [c, b, a], includeArchived: true } });
    expect(all.bytes!.toString('utf8').split('\n').filter((l) => l !== '').map((l) => idOf(JSON.parse(l) as MarcJsonRecord))).toEqual([c, b, a]);
  });

  it('filters: the material type, a branch through its items, and the admin search of q', async () => {
    const peta = await db.materialTypeId('PETA');
    const umum = await db.collectionTypeId('UMUM');
    const map = await book('Peta Pulau Jawa', { materialTypeId: peta });
    const novel = await book('Laskar Pelangi');
    await book('Kamus Besar');
    await db.run((tx) => createItem(tx, db.branchId, { recordId: novel, barcode: 'EXP-1', collectionTypeId: umum, status: 'available', partsTotal: 1 }));
    const ids = async (filter: Record<string, unknown>): Promise<string[]> => {
      const r = await exportFile(db, { format: 'marcjson', filter });
      return r.bytes!.toString('utf8').split('\n').filter((l) => l !== '').map((l) => ((JSON.parse(l) as MarcJsonRecord).fields.find((f) => '001' in f) as { '001': string })['001']);
    };
    expect(await ids({ materialTypeId: peta })).toEqual([map]);
    expect(await ids({ branchId: db.branchId })).toEqual([novel]);
    expect(await ids({ q: 'pelangi' })).toEqual([novel]);
    expect((await ids({})).sort()).toHaveLength(3);
  });

  it('csv-records writes the BOM and a header with the record custom-field columns; the run names its file, size and expiry', async () => {
    await book('Satu');
    const r = await exportFile(db, { format: 'csv-records', filter: {} });
    expect(r.run).toMatchObject({ status: 'succeeded', output_name: `${r.runId}.csv`, output_size: r.bytes!.byteLength, expires_at: NOW + 7 * DAY, finished_at: NOW });
    const text = r.bytes!.toString('utf8');
    expect(text.startsWith('\uFEFF"record_id","title"')).toBe(true);
    // The work folder is gone once the run ended.
    await expect(fsp.stat(path.join(db.dataDir, 'tmp', r.runId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sliced: 250 records in batches of 200; a resumed slice cuts off what a killed one wrote, and the file equals a one-slice export', async () => {
    await db.run(async (tx) => {
      for (let i = 0; i < 250; i += 1) await createRecord(tx, { materialTypeId: buku, title: `Buku Iris ${String(i).padStart(3, '0')}` }, { mode: 'bulk' });
    });
    const whole = await exportFile(db, { format: 'marcxml', filter: {} });
    expect(whole.summary).toMatchObject({ records: 250 });

    const started = await withTx(db.h, (trx) => startCatalogExport(txCtx(trx, NOW, db.staff), db.reg, { format: 'marcxml', filter: {} }, { keyring: KEYRING }));
    // One batch per slice (a budget of 1 ms): the first slice continues with the file's length in its checkpoint.
    expect(await drive(db, started.jobId, { budgetMs: 1, maxSlices: 1 })).toEqual(['continued']);
    const job = await db.h.db.selectFrom('jobs').select('payload').where('id', '=', started.jobId).executeTakeFirstOrThrow();
    const checkpoint = (JSON.parse(job.payload) as { checkpoint: { bytes: number; written: number } }).checkpoint;
    expect(checkpoint.written).toBe(200);
    const file = path.join(db.dataDir, 'exports', `${started.runId}.xml`);
    expect((await fsp.stat(file)).size).toBe(checkpoint.bytes);
    // A slice killed after writing more than its checkpoint covers.
    await fsp.appendFile(file, '<record>sisa potongan yang mati</record>');
    expect(await drive(db, started.jobId, { budgetMs: 1 })).toEqual(['continued', 'succeeded']);
    const sliced = await runOf(db, started.runId, started.jobId);
    const bytes = await fsp.readFile(file);
    expect(sliced.run.output_size).toBe(bytes.byteLength);
    // The same records in the same order as the one-slice export (each record's 001 is its id, 005 its update time).
    expect(bytes.equals(whole.bytes!)).toBe(true);
  });
});
