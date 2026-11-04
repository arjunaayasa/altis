import { newId } from '@altis/shared';
import type { ItemCreateBody } from '@altis/shared/api/catalog/items';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { createItem, getItem, itemByBarcode, itemHistory, listItems, suggestShelf, updateItem } from '../../src/catalog/items/index.js';
import * as core from '../../src/index.js';
import {
  ACTOR,
  NOW,
  audits,
  failure,
  fieldErrors,
  itemChangedEvents,
  itemEvents,
  itemRow,
  openItemsDb,
  seedItem,
  seedItemCustomField,
  seedLocation,
  seedRecord,
  seedSupplier,
  type ItemsDb,
} from './catalog-items-support.js';

// Phase 2 Task 17: saving items (spec §2.2 items, §3.2, §3.4; K4): the barcode rules, prices, locations of
// the branch, events, the record's index and changed_at, the reads and the shelf suggestion, on the engine picked by
// ALTIS_TEST_DB.

const ctx = testDbContext();

describe('the items barrel (M14)', () => {
  it('exports the names of the Task 17 interface through @altis/core', () => {
    for (const name of [
      'createItem',
      'updateItem',
      'archiveItem',
      'batchCreateItems',
      'bulkUpdateItems',
      'ensureBarcodeLockRow',
      'nextBarcodes',
      'suggestShelf',
      'getItem',
      'itemByBarcode',
      'listItems',
      'itemHistory',
    ]) {
      expect({ name, inCore: typeof (core as Record<string, unknown>)[name] }).toEqual({ name, inCore: 'function' });
    }
  });
});

describe.skipIf(!ctx.available)(`items: save, barcodes, prices, reads [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let umum: string;
  let recordId: string;

  const body = (over: Partial<ItemCreateBody> = {}): ItemCreateBody =>
    ({ recordId, barcode: `T${newId().slice(-9)}`, collectionTypeId: umum, ...over }) as ItemCreateBody;
  const create = (b: ItemCreateBody, o?: Parameters<typeof createItem>[3], branchId?: string, now = NOW) =>
    db.run((tx) => createItem(tx, branchId ?? db.branchId, b, o), now);

  beforeAll(async () => {
    db = await openItemsDb('items-save');
    umum = await db.collectionTypeId('UMUM');
    recordId = await seedRecord(db, { callNumber: '899.221 TOE b' });
  });

  afterAll(async () => {
    await db?.close();
  });

  describe('barcodes (§3.4, §3.2, K4)', () => {
    it("'9786020332956' (a valid ISBN-13 starting 978) → VALIDATION_FAILED {path: 'barcode', code: 'isbn_not_barcode'}", async () => {
      expect(await fieldErrors(create(body({ barcode: '9786020332956' })))).toEqual([{ path: 'barcode', code: 'isbn_not_barcode' }]);
    });

    it("with B001 stored, ' b001\\r\\n' → taken", async () => {
      await create(body({ barcode: 'B001' }));
      expect(await fieldErrors(create(body({ barcode: ' b001\r\n' })))).toEqual([{ path: 'barcode', code: 'taken' }]);
    });

    it("'b 00  12' is stored as 'B 00 12' (decision P2-08: inner spaces collapse to one)", async () => {
      const { id } = await create(body({ barcode: 'b 00  12' }));
      expect(await itemRow(db, id)).toMatchObject({ barcode_display: 'B 00 12', barcode_key: 'B 00 12' });
      // `b 0012` is another barcode, not a collision (P2-08).
      const other = await create(body({ barcode: 'b 0012' }));
      expect((await itemRow(db, other.id)).barcode_key).toBe('B 0012');
    });

    it('a barcode taken in another branch is taken here too (UNIQUE across branches)', async () => {
      await seedItem(db, recordId, { barcode: 'UTARA-77', branchId: db.otherBranchId });
      expect(await fieldErrors(create(body({ barcode: 'utara-77' })))).toEqual([{ path: 'barcode', code: 'taken' }]);
    });

    it('too short, too long and non-ASCII barcodes are refused (length, charset)', async () => {
      expect(await fieldErrors(create(body({ barcode: ' ab\t' })))).toEqual([{ path: 'barcode', code: 'length' }]);
      expect(await fieldErrors(create(body({ barcode: 'X'.repeat(65) })))).toEqual([{ path: 'barcode', code: 'length' }]);
      expect(await fieldErrors(create(body({ barcode: 'BUKU-é01' })))).toEqual([{ path: 'barcode', code: 'charset' }]);
    });
  });

  describe('createItem', () => {
    it('writes the row, one created event, the record changed_at, one audit entry and catalog.item.changed last', async () => {
      const before = (await itemChangedEvents(db)).length;
      const { id, version } = await create(body({ barcode: 'BARU-0001', inventoryNo: 'INV/2026/1', partsTotal: 2, statusNote: '' }));
      expect(version).toBe(0);
      expect(await itemRow(db, id)).toMatchObject({
        record_id: recordId,
        branch_id: db.branchId,
        barcode_display: 'BARU-0001',
        barcode_key: 'BARU-0001',
        inventory_no: 'INV/2026/1',
        status: 'available',
        status_note: null,
        parts_total: 2,
        collection_type_id: umum,
        price: null,
        currency: null,
        archived_at: null,
        created_at: NOW,
        created_by: ACTOR.id,
      });
      expect(await itemEvents(db, id)).toEqual([
        { type: 'created', from_status: null, to_status: 'available', from_location_id: null, to_location_id: null, actor_type: 'staff', actor_id: ACTOR.id, fields: [] },
      ]);
      const record = await db.h.db.selectFrom('records').select(['changed_at', 'version']).where('id', '=', recordId).executeTakeFirstOrThrow();
      expect({ changedAt: Number(record.changed_at), version: Number(record.version) }).toEqual({ changedAt: NOW, version: 0 });
      const entries = (await audits(db, 'catalog.item.create')).filter((a) => a.entityId === id);
      expect(entries).toEqual([{ entity: 'items', entityId: id, branchId: db.branchId, meta: { fields: expect.arrayContaining(['barcode', 'inventoryNo', 'partsTotal']) } }]);
      expect((await itemChangedEvents(db)).slice(before)).toEqual([{ id, recordId }]);
    });

    it("bulk mode with eventType 'imported' writes the event and no audit entry or catalog.item.changed", async () => {
      const audited = (await audits(db, 'catalog.item.create')).length;
      const published = (await itemChangedEvents(db)).length;
      const { id } = await create(body({ barcode: 'IMPOR-0001' }), { mode: 'bulk', eventType: 'imported' });
      expect((await itemEvents(db, id)).map((e) => e.type)).toEqual(['imported']);
      expect(await audits(db, 'catalog.item.create')).toHaveLength(audited);
      expect(await itemChangedEvents(db)).toHaveLength(published);
    });

    it("price '125000.00' → 12500000 minor units in catalog.currency (IDR); a given currency is kept", async () => {
      const idr = await create(body({ price: '125000.00' }));
      expect(await itemRow(db, idr.id)).toMatchObject({ price: 12_500_000, currency: 'IDR' });
      const usd = await create(body({ price: '12.5', currency: 'USD' }));
      expect(await itemRow(db, usd.id)).toMatchObject({ price: 1250, currency: 'USD' });
      const whole = await create(body({ price: '7' }));
      expect(await itemRow(db, whole.id)).toMatchObject({ price: 700, currency: 'IDR' });
      // No price: no currency either, even when one is sent.
      const none = await create(body({ currency: 'USD' }));
      expect(await itemRow(db, none.id)).toMatchObject({ price: null, currency: null });
      // The view gives the decimal string back.
      expect((await getItem(db.h.db, idr.id)).price).toBe('125000.00');
      expect((await getItem(db.h.db, usd.id)).price).toBe('12.50');
    });

    it('a price with more than 2 decimals is refused at price, and nothing is written', async () => {
      const count = async () => Number((await db.h.db.selectFrom('items').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
      const before = await count();
      expect(await fieldErrors(create(body({ price: '1.234' })))).toEqual([{ path: 'price', code: 'invalid_format' }]);
      expect(await count()).toBe(before);
    });

    it("a location of another branch → {path: 'locationId', code: 'invalid'}; an archived one → archived; one of the branch is stored", async () => {
      const elsewhere = await seedLocation(db, { code: 'U-RAK-1', kind: 'shelf', branchId: db.otherBranchId });
      expect(await fieldErrors(create(body({ locationId: elsewhere })))).toEqual([{ path: 'locationId', code: 'invalid' }]);
      expect(await fieldErrors(create(body({ locationId: newId() })))).toEqual([{ path: 'locationId', code: 'invalid' }]);
      const old = await seedLocation(db, { code: 'RAK-LAMA', kind: 'shelf', archived: true });
      expect(await fieldErrors(create(body({ locationId: old })))).toEqual([{ path: 'locationId', code: 'archived' }]);
      const here = await seedLocation(db, { code: 'RAK-1', kind: 'shelf' });
      const { id } = await create(body({ locationId: here }));
      expect((await itemRow(db, id)).location_id).toBe(here);
      expect((await itemEvents(db, id))[0]).toMatchObject({ type: 'created', to_location_id: here });
    });

    it('refuses an archived record, unknown masters and a supplier that does not exist, all in one error', async () => {
      const archived = await seedRecord(db, { archived: true });
      expect(await fieldErrors(create(body({ recordId: archived, collectionTypeId: newId(), supplierId: newId() })))).toEqual([
        { path: 'recordId', code: 'archived' },
        { path: 'collectionTypeId', code: 'not_found' },
        { path: 'supplierId', code: 'not_found' },
      ]);
      expect(await fieldErrors(create(body({ recordId: newId() })))).toEqual([{ path: 'recordId', code: 'not_found' }]);
      const supplier = await seedSupplier(db, 'GRAMEDIA');
      const { id } = await create(body({ supplierId: supplier, acqSource: 'purchase', orderNo: 'PO-1', orderDate: '2026-08-01' }));
      expect(await itemRow(db, id)).toMatchObject({ supplier_id: supplier, acq_source: 'purchase', order_no: 'PO-1', order_date: '2026-08-01' });
    });

    it('a branch that does not exist → NOT_FOUND', async () => {
      expect(await failure(create(body(), undefined, newId()))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('custom values of items: stored and read back; an unknown code is refused', async () => {
      await seedItemCustomField(db, { code: 'sumbangan', type: 'text' });
      const { id } = await create(body({ custom: { sumbangan: 'Dari alumni 1998' } }));
      expect((await getItem(db.h.db, id)).custom).toEqual({ sumbangan: 'Dari alumni 1998' });
      expect(await fieldErrors(create(body({ custom: { tidakada: 'x' } })))).toEqual([{ path: 'custom', code: 'unrecognized_keys' }]);
    });
  });

  describe('updateItem', () => {
    it("changes fields, writes 'moved' and 'updated' events, bumps version, audits the changed field names", async () => {
      const shelf = await seedLocation(db, { code: 'RAK-2', kind: 'shelf' });
      const { id } = await create(body({ barcode: 'UBAH-0001' }));
      const r = await db.run((tx) => updateItem(tx, db.branchId, id, { version: 0, locationId: shelf, note: 'Sampul robek', inventoryNo: 'INV-9' }));
      expect(r).toEqual({ id, version: 1 });
      expect(await itemRow(db, id)).toMatchObject({ location_id: shelf, note: 'Sampul robek', inventory_no: 'INV-9', version: 1 });
      const events = await itemEvents(db, id);
      expect(events.slice(1)).toEqual([
        expect.objectContaining({ type: 'moved', from_location_id: null, to_location_id: shelf, fields: ['locationId'] }),
        expect.objectContaining({ type: 'updated', fields: ['inventoryNo', 'note'] }),
      ]);
      const entry = (await audits(db, 'catalog.item.update')).filter((a) => a.entityId === id);
      expect(entry).toEqual([{ entity: 'items', entityId: id, branchId: db.branchId, meta: { fields: ['inventoryNo', 'locationId', 'note'] } }]);
    });

    it('a new barcode is checked like a new one; a stale version → CONFLICT_STALE', async () => {
      const { id } = await create(body({ barcode: 'UBAH-0002' }));
      expect(await fieldErrors(db.run((tx) => updateItem(tx, db.branchId, id, { version: 0, barcode: 'b001' })))).toEqual([{ path: 'barcode', code: 'taken' }]);
      // Its own barcode, written another way, is not taken.
      await db.run((tx) => updateItem(tx, db.branchId, id, { version: 0, barcode: ' ubah-0002 ' }));
      expect(await failure(db.run((tx) => updateItem(tx, db.branchId, id, { version: 0, note: 'x' })))).toMatchObject({ code: 'CONFLICT_STALE' });
    });

    it('an item of another branch → NOT_FOUND; a location of another branch → invalid', async () => {
      const { id } = await create(body({ barcode: 'UBAH-0003' }));
      expect(await failure(db.run((tx) => updateItem(tx, db.otherBranchId, id, { version: 0, note: 'x' })))).toMatchObject({ code: 'NOT_FOUND' });
      const elsewhere = await seedLocation(db, { code: 'U-RAK-2', kind: 'shelf', branchId: db.otherBranchId });
      expect(await fieldErrors(db.run((tx) => updateItem(tx, db.branchId, id, { version: 0, locationId: elsewhere })))).toEqual([
        { path: 'locationId', code: 'invalid' },
      ]);
    });

    it('a price change keeps the currency; clearing the price clears the currency', async () => {
      const { id } = await create(body({ price: '1000', currency: 'USD' }));
      await db.run((tx) => updateItem(tx, db.branchId, id, { version: 0, price: '2000.5' }));
      expect(await itemRow(db, id)).toMatchObject({ price: 200_050, currency: 'USD' });
      await db.run((tx) => updateItem(tx, db.branchId, id, { version: 1, price: null }));
      expect(await itemRow(db, id)).toMatchObject({ price: null, currency: null });
    });
  });

  describe('reads', () => {
    it('getItem: the view with branch, record, location path, loanable/selfService (§2.5) and the history, newest first', async () => {
      const room = await seedLocation(db, { code: 'R-BACA', kind: 'room', name: 'Ruang Baca' });
      const shelf = await seedLocation(db, { code: 'R-BACA-1', kind: 'shelf', parentId: room, name: 'Rak 1', shelfHint: 'Lt 2 Rak 1' });
      const ref = await db.collectionTypeId('REF');
      const a = await create(body({ barcode: 'BACA-0001', locationId: shelf }));
      const b = await create(body({ barcode: 'BACA-0002', collectionTypeId: ref }));
      const c = await create(body({ barcode: 'BACA-0003', collectionTypeId: await db.collectionTypeId('TANDON') }));
      await db.run((tx) => updateItem(tx, db.branchId, a.id, { version: 0, status: 'repair' }), NOW + 1000);
      const view = await getItem(db.h.db, a.id);
      expect(view).toMatchObject({
        id: a.id,
        record: { id: recordId, title: 'Bumi Manusia' },
        branch: { id: db.branchId, code: 'PUSAT', name: 'Cabang PUSAT' },
        barcode: 'BACA-0001',
        locationId: shelf,
        locationPath: { roomId: room, roomName: 'Ruang Baca', areaName: null, shelfName: 'Rak 1', shelfHint: 'Lt 2 Rak 1' },
        suggestedLocation: null,
        status: 'repair',
        loanable: false,
        selfService: false,
        archived: false,
        version: 1,
      });
      expect(view.history.map((e) => e.type)).toEqual(['status', 'created']);
      expect(view.history[0]).toMatchObject({ fromStatus: 'available', toStatus: 'repair', actorType: 'staff', actorId: ACTOR.id, fields: ['status'] });
      // UMUM is loanable and self-service; REF is loanable only; TANDON neither.
      expect(await getItem(db.h.db, b.id)).toMatchObject({ loanable: true, selfService: false });
      expect(await getItem(db.h.db, c.id)).toMatchObject({ loanable: false, selfService: false });
      expect(await itemHistory(db.h.db, a.id)).toEqual(view.history);
      expect(await failure(getItem(db.h.db, newId()))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('itemByBarcode normalises the raw text first; a barcode that cannot exist is VALIDATION_FAILED; none → NOT_FOUND', async () => {
      const { id } = await create(body({ barcode: 'B/01' }));
      expect((await itemByBarcode(db.h.db, ' b/01\r\n')).id).toBe(id);
      expect(await fieldErrors(itemByBarcode(db.h.db, 'B\u000001'))).toEqual([{ path: 'barcode', code: 'charset' }]);
      expect(await fieldErrors(itemByBarcode(db.h.db, '9786020332956'))).toEqual([{ path: 'barcode', code: 'isbn_not_barcode' }]);
      expect(await failure(itemByBarcode(db.h.db, 'TIDAK-ADA'))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('listItems: keyset by barcode, filters by branch, record, status and barcode prefix', async () => {
      const rec = await seedRecord(db, { title: 'Anak Semua Bangsa' });
      for (const code of ['LST-03', 'LST-01', 'LST-02', 'LST-04']) await create(body({ recordId: rec, barcode: code }));
      await seedItem(db, rec, { barcode: 'LST-05', branchId: db.otherBranchId });
      const first = await listItems(db.h.db, { recordId: rec, limit: 2 });
      expect(first.items.map((i) => i.barcode)).toEqual(['LST-01', 'LST-02']);
      expect(first.nextCursor).not.toBeNull();
      const second = await listItems(db.h.db, { recordId: rec, limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((i) => i.barcode)).toEqual(['LST-03', 'LST-04']);
      const last = await listItems(db.h.db, { recordId: rec, limit: 2, cursor: second.nextCursor! });
      expect(last).toEqual({ items: [expect.objectContaining({ barcode: 'LST-05', branch: { id: db.otherBranchId, code: 'UTARA' } })], nextCursor: null });
      expect((await listItems(db.h.db, { recordId: rec, branchId: db.branchId, limit: 50 })).items).toHaveLength(4);
      expect((await listItems(db.h.db, { barcodePrefix: 'lst-0', limit: 50 })).items.map((i) => i.barcode)).toEqual(['LST-01', 'LST-02', 'LST-03', 'LST-04', 'LST-05']);
      expect((await listItems(db.h.db, { recordId: rec, status: 'repair', limit: 50 })).items).toEqual([]);
      expect(first.items[0]).toMatchObject({ record: { id: rec, title: 'Anak Semua Bangsa' }, branch: { id: db.branchId, code: 'PUSAT' }, status: 'available', archived: false, version: 0 });
      expect(await fieldErrors(listItems(db.h.db, { limit: 5, cursor: 'nonsense' }))).toEqual([{ path: 'cursor', code: 'invalid' }]);
    });

    it('listItems by a room lists the items on its shelves too; the call number falls back to the record', async () => {
      const room = await seedLocation(db, { code: 'R-ANAK', kind: 'room' });
      const shelf = await seedLocation(db, { code: 'R-ANAK-1', kind: 'shelf', parentId: room });
      const { id } = await create(body({ barcode: 'ANAK-0001', locationId: shelf }));
      const page = await listItems(db.h.db, { locationId: room, limit: 50 });
      expect(page.items.map((i) => i.id)).toEqual([id]);
      expect(page.items[0]!.callNumber).toBe('899.221 TOE b');
    });
  });

  describe('suggestShelf (§3.4)', () => {
    it("'808.3 ABC' with shelves 800-899 and 800-809 → the narrower one; archived shelves and other branches are ignored", async () => {
      await seedLocation(db, { code: 'S-800', kind: 'shelf', name: 'Rak 800-899', classFrom: '800', classTo: '899' });
      const narrow = await seedLocation(db, { code: 'S-800-809', kind: 'shelf', name: 'Rak 800-809', classFrom: '800', classTo: '809', shelfHint: 'Rak 800-809' });
      await seedLocation(db, { code: 'S-808-OLD', kind: 'shelf', classFrom: '808', classTo: '808.9', archived: true });
      await seedLocation(db, { code: 'S-808-U', kind: 'shelf', classFrom: '808', classTo: '808.9', branchId: db.otherBranchId });
      expect(await suggestShelf(db.h.db, db.branchId, '808.3 ABC')).toEqual({ id: narrow, name: 'Rak 800-809', shelfHint: 'Rak 800-809' });
      expect(await suggestShelf(db.h.db, db.branchId, '700 XYZ')).toBeNull();
      expect(await suggestShelf(db.h.db, db.branchId, 'FIKSI')).toBeNull();
    });

    it('an item without a location carries the suggestion of its call number (else the record one)', async () => {
      const rec = await seedRecord(db, { callNumber: '808.31 PRA m' });
      const { id } = await create(body({ recordId: rec, barcode: 'SARAN-0001' }));
      expect((await getItem(db.h.db, id)).suggestedLocation).toMatchObject({ name: 'Rak 800-809' });
    });
  });
});
