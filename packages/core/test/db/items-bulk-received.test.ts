import type { ItemBulkBody } from '@altis/shared/api/catalog/items';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { bulkUpdateItems } from '../../src/catalog/items/index.js';
import { DAY, NOW, STAFF, audits, fieldErrors, itemChangedEvents, itemEvents, itemRow, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// The receiving date set in bulk, so that copies without one (migrated copies above all) can be completed: by default
// only the copies without a date get it (`fill_empty`), a copy that has one is refused with `received_date_set` and
// left as it is; `overwrite` sets it on every copy. A filled date is an ordinary edit of the copy (`updated_by` is its
// editor), so a migrated copy filled this way no longer follows a later SLiMS re-sync.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`items: the receiving date in bulk [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let recordId: string;
  let serial = 0;

  /** A copy of the test record, with `receivedDate` when given; its id. */
  const copy = async (receivedDate: string | null = null, status = 'available'): Promise<string> => {
    serial += 1;
    const id = await seedItem(db, recordId, { barcode: `TERIMA-${String(serial).padStart(4, '0')}`, status });
    if (receivedDate !== null) await db.h.db.updateTable('items').set({ received_date: receivedDate }).where('id', '=', id).execute();
    return id;
  };
  const bulk = (body: ItemBulkBody) => db.run((tx) => bulkUpdateItems(tx, db.branchId, body));
  const recordChangedAt = async () => Number((await db.h.db.selectFrom('records').select('changed_at').where('id', '=', recordId).executeTakeFirstOrThrow()).changed_at);

  beforeAll(async () => {
    db = await openItemsDb('items-bulk-received');
    recordId = await seedRecord(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('fill_empty (the default): two copies without a date get it, the one with a date is refused received_date_set', async () => {
    const a = await copy();
    const dated = await copy('2019-07-15');
    const b = await copy();
    const audited = (await audits(db, 'catalog.item.bulk_update')).length;
    const r = await bulk({ ids: [a, dated, b], set: { receivedDate: '2024-01-08' } });
    expect(r).toEqual({ updated: 2, refused: [{ id: dated, code: 'received_date_set' }] });
    for (const id of [a, b]) {
      expect(await itemRow(db, id)).toMatchObject({ received_date: '2024-01-08', updated_by: STAFF, version: 1 });
      expect(Number((await itemRow(db, id)).updated_at)).toBe(NOW);
      expect(await itemEvents(db, id)).toEqual([expect.objectContaining({ type: 'updated', actor_id: STAFF, fields: ['receivedDate'] })]);
    }
    expect(await itemRow(db, dated)).toMatchObject({ received_date: '2019-07-15', updated_by: null, version: 0 });
    expect(Number((await itemRow(db, dated)).updated_at)).toBe(NOW - DAY);
    expect(await itemEvents(db, dated)).toEqual([]);
    expect((await audits(db, 'catalog.item.bulk_update')).slice(audited)).toEqual([
      { entity: 'items', entityId: null, branchId: db.branchId, meta: { count: 3, updated: 2, refused: 1, fields: ['receivedDate'] } },
    ]);
  });

  it("an explicit 'fill_empty' is the default", async () => {
    const a = await copy();
    const dated = await copy('2020-02-29');
    expect(await bulk({ ids: [a, dated], set: { receivedDate: '2024-03-01' }, receivedDateMode: 'fill_empty' })).toEqual({
      updated: 1,
      refused: [{ id: dated, code: 'received_date_set' }],
    });
    expect((await itemRow(db, a)).received_date).toBe('2024-03-01');
  });

  it('overwrite sets the date on all three copies, the dated one included', async () => {
    const ids = [await copy(), await copy('2018-11-30'), await copy()];
    expect(await bulk({ ids, set: { receivedDate: '2023-06-12' }, receivedDateMode: 'overwrite' })).toEqual({ updated: 3, refused: [] });
    for (const id of ids) expect(await itemRow(db, id)).toMatchObject({ received_date: '2023-06-12', updated_by: STAFF, version: 1 });
  });

  it('a copy already holding that date counts as updated and is not written (overwrite)', async () => {
    const same = await copy('2023-06-12');
    expect(await bulk({ ids: [same], set: { receivedDate: '2023-06-12' }, receivedDateMode: 'overwrite' })).toEqual({ updated: 1, refused: [] });
    expect(await itemRow(db, same)).toMatchObject({ version: 0, updated_by: null });
  });

  it('a refused copy is left whole: with a status change too, it keeps its status', async () => {
    const a = await copy();
    const dated = await copy('2021-05-05');
    expect(await bulk({ ids: [a, dated], set: { receivedDate: '2024-04-04', status: 'repair' } })).toEqual({ updated: 1, refused: [{ id: dated, code: 'received_date_set' }] });
    expect(await itemRow(db, a)).toMatchObject({ received_date: '2024-04-04', status: 'repair', version: 1 });
    expect(await itemRow(db, dated)).toMatchObject({ received_date: '2021-05-05', status: 'available', version: 0 });
  });

  it("the receiving date is not part of the record's public representation: its changed_at stays; catalog.item.changed is published", async () => {
    const a = await copy();
    const before = await recordChangedAt();
    const published = (await itemChangedEvents(db)).length;
    await db.run((tx) => bulkUpdateItems(tx, db.branchId, { ids: [a], set: { receivedDate: '2022-08-17' } }), NOW + 60_000);
    expect(await recordChangedAt()).toBe(before);
    expect((await itemChangedEvents(db)).slice(published)).toEqual([{ id: a, recordId }]);
    // A status change still moves it.
    await db.run((tx) => bulkUpdateItems(tx, db.branchId, { ids: [a], set: { status: 'repair' } }), NOW + 120_000);
    expect(await recordChangedAt()).toBe(NOW + 120_000);
  });

  it('a date that is not a calendar day is refused at set.receivedDate', async () => {
    const a = await copy();
    expect(await fieldErrors(bulk({ ids: [a], set: { receivedDate: '2024-02-30' } }))).toEqual([{ path: 'set.receivedDate', code: expect.any(String) }]);
    expect(await itemRow(db, a)).toMatchObject({ received_date: null, version: 0 });
  });
});
