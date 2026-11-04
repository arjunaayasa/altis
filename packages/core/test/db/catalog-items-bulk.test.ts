import { newId, type ItemStatus } from '@altis/shared';
import type { ItemBulkBody } from '@altis/shared/api/catalog/items';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { bulkUpdateItems } from '../../src/catalog/items/index.js';
import { NOW, audits, fieldErrors, itemChangedEvents, itemEvents, itemRow, openItemsDb, seedItem, seedLocation, seedRecord, type ItemsDb } from './catalog-items-support.js';

// Phase 2 Task 17: bulk changes of items (spec §3.4): up to 500 ids, a location, a status (each item's transition
// checked) or a collection type; refused items are reported and the rest proceeds, under one audit entry.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`items: bulk changes [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let recordId: string;
  let serial = 0;

  const itemIn = async (status: ItemStatus, o: { branchId?: string; locationId?: string | null } = {}): Promise<string> => {
    serial += 1;
    return seedItem(db, recordId, { barcode: `MASSAL-${String(serial).padStart(4, '0')}`, status, ...o });
  };
  const bulk = (body: ItemBulkBody, branchId?: string) => db.run((tx) => bulkUpdateItems(tx, branchId ?? db.branchId, body));

  beforeAll(async () => {
    db = await openItemsDb('items-bulk');
    recordId = await seedRecord(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('3 valid and 2 invalid transitions → updated 3, the 2 refused with invalid_transition; one audit entry', async () => {
    const ok = [await itemIn('available'), await itemIn('not_for_loan'), await itemIn('missing')];
    const bad = [await itemIn('lost'), await itemIn('on_order')];
    const audited = (await audits(db, 'catalog.item.bulk_update')).length;
    const published = (await itemChangedEvents(db)).length;
    const r = await bulk({ ids: [ok[0]!, bad[0]!, ok[1]!, bad[1]!, ok[2]!], set: { status: 'not_for_loan' } });
    expect(r).toEqual({
      updated: 3,
      refused: [
        { id: bad[0], code: 'invalid_transition' },
        { id: bad[1], code: 'invalid_transition' },
      ],
    });
    // not_for_loan → not_for_loan is no change at all (counted, nothing written).
    expect((await itemRow(db, ok[0]!)).status).toBe('not_for_loan');
    expect((await itemRow(db, ok[1]!)).version).toBe(0);
    expect(await itemEvents(db, ok[1]!)).toEqual([]);
    expect((await itemRow(db, ok[2]!)).status).toBe('not_for_loan');
    expect(await itemEvents(db, ok[2]!)).toEqual([expect.objectContaining({ type: 'status', from_status: 'missing', to_status: 'not_for_loan' })]);
    for (const id of bad) expect(await itemRow(db, id)).toMatchObject({ version: 0 });
    expect((await audits(db, 'catalog.item.bulk_update')).slice(audited)).toEqual([
      { entity: 'items', entityId: null, branchId: db.branchId, meta: { count: 5, updated: 3, refused: 2, fields: ['status'] } },
    ]);
    expect((await itemChangedEvents(db)).slice(published).map((e) => e.id).sort()).toEqual([ok[0]!, ok[2]!].sort());
  });

  it("a move: 'moved' events and the new location; ids of another branch or of nothing are not_found", async () => {
    const shelf = await seedLocation(db, { code: 'RAK-MASSAL', kind: 'shelf' });
    const a = await itemIn('available');
    const b = await itemIn('repair');
    const elsewhere = await itemIn('available', { branchId: db.otherBranchId });
    const nothing = newId();
    const r = await bulk({ ids: [a, b, elsewhere, nothing, a], set: { locationId: shelf } });
    expect(r).toEqual({ updated: 2, refused: [{ id: elsewhere, code: 'not_found' }, { id: nothing, code: 'not_found' }] });
    expect(await itemRow(db, a)).toMatchObject({ location_id: shelf, version: 1 });
    expect(await itemEvents(db, b)).toEqual([expect.objectContaining({ type: 'moved', from_location_id: null, to_location_id: shelf, fields: ['locationId'] })]);
    expect((await itemRow(db, elsewhere)).location_id).toBeNull();
  });

  it('a location of another branch refuses every item with invalid_location, and nothing changes', async () => {
    const theirs = await seedLocation(db, { code: 'RAK-UTARA', kind: 'shelf', branchId: db.otherBranchId });
    const a = await itemIn('available');
    const b = await itemIn('available');
    expect(await bulk({ ids: [a, b], set: { locationId: theirs, status: 'repair' } })).toEqual({
      updated: 0,
      refused: [
        { id: a, code: 'invalid_location' },
        { id: b, code: 'invalid_location' },
      ],
    });
    expect(await itemRow(db, a)).toMatchObject({ location_id: null, status: 'available', version: 0 });
  });

  it('a collection type and a status to withdrawn (archived) at once; an unknown collection type is a field error', async () => {
    const ref = await db.collectionTypeId('REF');
    const a = await itemIn('available');
    const r = await bulk({ ids: [a], set: { collectionTypeId: ref, status: 'withdrawn' } });
    expect(r).toEqual({ updated: 1, refused: [] });
    expect(await itemRow(db, a)).toMatchObject({ collection_type_id: ref, status: 'withdrawn', archived_at: NOW, version: 1 });
    expect((await itemEvents(db, a)).map((e) => [e.type, e.fields])).toEqual([
      ['archived', ['status']],
      ['updated', ['collectionTypeId']],
    ]);
    expect(await fieldErrors(bulk({ ids: [a], set: { collectionTypeId: newId() } }))).toEqual([{ path: 'set.collectionTypeId', code: 'not_found' }]);
  });

  it('the records of changed items get changed_at = now', async () => {
    const rec = await seedRecord(db, { title: 'Jejak Langkah' });
    const id = await seedItem(db, rec, { barcode: 'MASSAL-JEJAK', status: 'available' });
    await db.run((tx) => bulkUpdateItems(tx, db.branchId, { ids: [id], set: { status: 'repair' } }), NOW + 5000);
    expect(Number((await db.h.db.selectFrom('records').select('changed_at').where('id', '=', rec).executeTakeFirstOrThrow()).changed_at)).toBe(NOW + 5000);
  });
});
