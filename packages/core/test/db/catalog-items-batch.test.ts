import { withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { ItemBatchBody } from '@altis/shared/api/catalog/items';
import type { BarcodePattern } from '@altis/shared/api/settings';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { batchCreateItems, ensureBarcodeLockRow, nextBarcodes } from '../../src/catalog/items/index.js';
import { LOCK_FOREVER, __setBarcodeAfterMaxRead } from '../../src/catalog/items/patterns.js';
import { purgeVolatile } from '../../src/housekeeping/volatile.js';
import { writeSettings } from '../../src/settings/service.js';
import { NOW, audits, failure, fieldErrors, itemChangedEvents, itemEvents, itemRow, openItemsDb, seedItem, seedLocation, seedRecord, type ItemsDb } from './catalog-items-support.js';

// Phase 2 Task 17: batches of items (spec §3.4; B4, M8, decisions P2-25 and P2-34): numbering by a barcode pattern is
// max + 1 over the keys that match the pattern exactly, under the pattern's lock row, with the keys found taken at
// insert reported in `skipped`; the lock row is made outside the batch transaction with until = LOCK_FOREVER.

const ctx = testDbContext();

/** `B` + 7 digits: the seeded pattern `default` (`catalog.barcode.patterns`). */
const DEFAULT_PATTERN: BarcodePattern = { id: 'default', name: 'Bawaan', prefix: 'B', digits: 7, suffix: '' };
const lockName = (patternId: string) => `catalog.barcode:${patternId}`;

/** `B` + `n` zero-padded to 7 digits. */
const b7 = (n: number) => `B${String(n).padStart(7, '0')}`;

describe.skipIf(!ctx.available)(`items: batches and barcode patterns [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let umum: string;
  let recordId: string;

  const batch = (over: Partial<ItemBatchBody> = {}) =>
    db.run((tx) => batchCreateItems(tx, db.branchId, { recordId, count: 100, patternId: 'default', template: { collectionTypeId: umum }, ...over } as ItemBatchBody));
  const lockRow = () => db.h.db.selectFrom('locks').selectAll().where('name', '=', lockName('default')).executeTakeFirst();
  const setPatterns = (patterns: BarcodePattern[]) =>
    withTx(db.h, (trx) => writeSettings(trx, { 'catalog.barcode.patterns': patterns }, { keyring: [], now: NOW, actorId: null }));

  beforeAll(async () => {
    db = await openItemsDb('items-batch');
    umum = await db.collectionTypeId('UMUM');
    recordId = await seedRecord(db, { callNumber: '813 RAN' });
  });

  beforeEach(async () => {
    await db.h.db.deleteFrom('custom_values').execute();
    await db.h.db.deleteFrom('item_events').execute();
    await db.h.db.deleteFrom('items').execute();
    await ensureBarcodeLockRow(db.h, 'default');
  });

  afterEach(() => {
    __setBarcodeAfterMaxRead(null);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('after B0000005: B0000006…B0000105, contiguous, skipped empty; one audit with meta.count, one created event per item', async () => {
    await seedItem(db, recordId, { barcode: b7(5) });
    const audited = (await audits(db, 'catalog.item.batch_create')).length;
    const published = (await itemChangedEvents(db)).length;
    const r = await batch();
    expect(r.skipped).toEqual([]);
    expect(r.created.map((c) => c.barcode)).toEqual(Array.from({ length: 100 }, (_, i) => b7(6 + i)));
    expect(new Set(r.created.map((c) => c.id)).size).toBe(100);
    const entries = (await audits(db, 'catalog.item.batch_create')).slice(audited);
    expect(entries).toEqual([{ entity: 'records', entityId: recordId, branchId: db.branchId, meta: { count: 100, skipped: 0, patternId: 'default' } }]);
    for (const c of [r.created[0]!, r.created[99]!]) {
      expect(await itemEvents(db, c.id)).toEqual([expect.objectContaining({ type: 'created', to_status: 'available' })]);
      expect(await itemRow(db, c.id)).toMatchObject({ barcode_key: c.barcode, barcode_display: c.barcode, record_id: recordId, branch_id: db.branchId });
    }
    const events = await db.h.db.selectFrom('item_events').select('item_id').where('type', '=', 'created').execute();
    expect(events).toHaveLength(100);
    expect((await itemChangedEvents(db)).slice(published)).toHaveLength(100);
  });

  it('with B0000005 and a manual B0000010: B0000011…B0000110 (max + 1, B4), skipped empty', async () => {
    await seedItem(db, recordId, { barcode: b7(5) });
    await seedItem(db, recordId, { barcode: b7(10) });
    const r = await batch();
    expect(r.created.map((c) => c.barcode)).toEqual(Array.from({ length: 100 }, (_, i) => b7(11 + i)));
    expect(r.skipped).toEqual([]);
  });

  it('keys that do not match the pattern exactly (B00000999X, B123, XB0000500) do not move the maximum', async () => {
    await seedItem(db, recordId, { barcode: b7(5) });
    for (const barcode of ['B00000999X', 'B123', 'XB0000500']) await seedItem(db, recordId, { barcode });
    const r = await batch({ count: 3 });
    expect(r.created.map((c) => c.barcode)).toEqual([b7(6), b7(7), b7(8)]);
  });

  it('a key taken between the maximum read and its insert (R57 hook) is reported in skipped; the batch still creates 100', async () => {
    await seedItem(db, recordId, { barcode: b7(5) });
    let calls = 0;
    __setBarcodeAfterMaxRead(async (trx, o) => {
      calls += 1;
      expect(o).toEqual({ pattern: DEFAULT_PATTERN, max: 5 });
      // A manual create of B0000007 (which takes no pattern lock) lands right after the read.
      await trx
        .insertInto('items')
        .values({
          id: newId(),
          record_id: recordId,
          branch_id: db.branchId,
          barcode_display: b7(7),
          barcode_key: b7(7),
          inventory_no: null,
          call_number: null,
          location_id: null,
          collection_type_id: umum,
          status: 'available',
          status_note: null,
          acq_source: null,
          order_no: null,
          order_date: null,
          received_date: null,
          invoice_date: null,
          supplier_id: null,
          invoice_no: null,
          price: null,
          currency: null,
          note: null,
          archived_at: null,
          created_at: NOW,
          created_by: null,
          updated_at: NOW,
          updated_by: null,
        })
        .execute();
    });
    const r = await batch();
    expect(calls).toBe(1);
    expect(r.skipped).toEqual([{ barcode: b7(7), reason: 'taken' }]);
    expect(r.created).toHaveLength(100);
    expect(r.created.map((c) => c.barcode)).toEqual([b7(6), ...Array.from({ length: 99 }, (_, i) => b7(8 + i))]);
    const entry = (await audits(db, 'catalog.item.batch_create')).at(-1);
    expect(entry?.meta).toEqual({ count: 100, skipped: 1, patternId: 'default' });
  });

  it('the template applies to every item of the batch', async () => {
    const shelf = await seedLocation(db, { code: `RAK-${newId().slice(-6)}`, kind: 'shelf' });
    const r = await batch({ count: 2, template: { collectionTypeId: umum, status: 'processing', locationId: shelf, price: '45000', partsTotal: 3 } as never });
    for (const c of r.created) {
      expect(await itemRow(db, c.id)).toMatchObject({ status: 'processing', location_id: shelf, price: 4_500_000, currency: 'IDR', parts_total: 3 });
    }
  });

  it('given barcodes instead of a pattern: normalised and stored; taken, duplicate or invalid ones are field errors at barcodes.<i>', async () => {
    await seedItem(db, recordId, { barcode: 'MANUAL-1' });
    const r = await batch({ patternId: undefined, count: 2, barcodes: [' manual-2 ', 'manual-3\r\n'] });
    expect(r).toEqual({ created: [expect.objectContaining({ barcode: 'MANUAL-2' }), expect.objectContaining({ barcode: 'MANUAL-3' })], skipped: [] });
    expect(await fieldErrors(batch({ patternId: undefined, count: 4, barcodes: ['manual-1', 'manual-4', 'MANUAL-4', '9786020332956'] }))).toEqual([
      { path: 'barcodes.0', code: 'taken' },
      { path: 'barcodes.2', code: 'duplicate' },
      { path: 'barcodes.3', code: 'isbn_not_barcode' },
    ]);
  });

  it('refuses an unknown pattern, an archived record, and a branch of none (nothing written)', async () => {
    expect(await fieldErrors(batch({ patternId: 'tidak-ada' }))).toEqual([{ path: 'patternId', code: 'not_found' }]);
    const archived = await seedRecord(db, { archived: true });
    expect(await fieldErrors(batch({ recordId: archived }))).toEqual([{ path: 'recordId', code: 'archived' }]);
    expect(await failure(db.run((tx) => batchCreateItems(tx, newId(), { recordId, count: 1, patternId: 'default', template: { collectionTypeId: umum } } as ItemBatchBody)))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await db.h.db.selectFrom('items').select('id').execute()).toEqual([]);
  });

  it('a pattern whose numbers run out → patternId exhausted; a candidate that is a valid ISBN-13 is passed over', async () => {
    await setPatterns([DEFAULT_PATTERN, { id: 'kecil', name: 'Kecil', prefix: 'K', digits: 3, suffix: '-X' }, { id: 'isbn', name: 'ISBN', prefix: '9786020332', digits: 3, suffix: '' }]);
    await ensureBarcodeLockRow(db.h, 'kecil');
    await ensureBarcodeLockRow(db.h, 'isbn');
    await seedItem(db, recordId, { barcode: 'K998-X' });
    expect((await batch({ patternId: 'kecil', count: 1 })).created.map((c) => c.barcode)).toEqual(['K999-X']);
    expect(await fieldErrors(batch({ patternId: 'kecil', count: 1 }))).toEqual([{ path: 'patternId', code: 'exhausted' }]);
    await seedItem(db, recordId, { barcode: '9786020332955' });
    // 9786020332956 is a valid ISBN-13 (§3.2): never a barcode, so the next number is used.
    expect((await batch({ patternId: 'isbn', count: 1 })).created.map((c) => c.barcode)).toEqual(['9786020332957']);
    await setPatterns([DEFAULT_PATTERN]);
  });

  describe('the lock row (M8, P2-25)', () => {
    it('exists after the first batch with until = LOCK_FOREVER, and the volatile housekeeping does not delete it', async () => {
      await db.h.db.deleteFrom('locks').where('name', '=', lockName('default')).execute();
      await ensureBarcodeLockRow(db.h, 'default');
      await batch({ count: 1 });
      expect(await lockRow()).toMatchObject({ name: lockName('default'), until: LOCK_FOREVER });
      const purged = await purgeVolatile(db.h, { now: NOW + 365 * 86_400_000, dataDir: db.dataDir });
      expect(purged.deleted['locks']).toBe(0);
      expect(await lockRow()).toMatchObject({ until: LOCK_FOREVER });
    });

    it('a row a clock confirmation clamped (C3) is set back to LOCK_FOREVER; ensuring twice is harmless', async () => {
      await db.h.db.updateTable('locks').set({ until: NOW }).where('name', '=', lockName('default')).execute();
      await ensureBarcodeLockRow(db.h, 'default');
      await ensureBarcodeLockRow(db.h, 'default');
      expect(await db.h.db.selectFrom('locks').select('until').where('name', '=', lockName('default')).execute()).toEqual([{ until: LOCK_FOREVER }]);
    });

    it('two first batches of a new pattern at once both succeed (the second ensure finds the row)', async () => {
      await setPatterns([DEFAULT_PATTERN, { id: 'baru', name: 'Baru', prefix: 'NB', digits: 5, suffix: '' }]);
      const both = await Promise.all([ensureBarcodeLockRow(db.h, 'baru'), ensureBarcodeLockRow(db.h, 'baru')]);
      expect(both).toEqual([undefined, undefined]);
      const [x, y] = await Promise.all([batch({ patternId: 'baru', count: 3 }), batch({ patternId: 'baru', count: 3 })]);
      expect([...x.created, ...y.created].map((c) => c.barcode).sort()).toEqual(['NB00001', 'NB00002', 'NB00003', 'NB00004', 'NB00005', 'NB00006']);
      await setPatterns([DEFAULT_PATTERN]);
    });

    it('nextBarcodes without the lock row → TypeError (ensureBarcodeLockRow was not called)', async () => {
      await db.h.db.deleteFrom('locks').where('name', '=', lockName('default')).execute();
      const outcome = await failure(withTx(db.h, (trx) => nextBarcodes(trx, DEFAULT_PATTERN, 1)));
      expect(outcome).toBeInstanceOf(TypeError);
      expect(await failure(batch({ count: 1 }))).toBeInstanceOf(TypeError);
    });

    it('nextBarcodes takes the lock row first, then answers count free numbers', async () => {
      await seedItem(db, recordId, { barcode: b7(41) });
      const r = await withTx(db.h, (trx) => nextBarcodes(trx, DEFAULT_PATTERN, 3));
      expect(r).toEqual({ barcodes: [b7(42), b7(43), b7(44)], skipped: [] });
    });
  });
});
