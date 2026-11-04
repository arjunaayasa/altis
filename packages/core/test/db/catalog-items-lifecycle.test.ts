import type { ItemStatus } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { archiveItem, createItem, getItem, updateItem } from '../../src/catalog/items/index.js';
import { NOW, audits, failure, itemChangedEvents, itemEvents, itemRow, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// Phase 2 Task 17: the item lifecycle (spec §2.5; K4): only the transitions of ITEM_TRANSITIONS, 409
// ITEM_STATUS_TRANSITION otherwise; archiving is `withdrawn` + `archived_at`, and `withdrawn → processing` clears it.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`items: lifecycle [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let recordId: string;
  let serial = 0;

  /** A new item of status `status` (stored directly); its id. */
  const itemIn = async (status: ItemStatus, o: { archived?: boolean } = {}): Promise<string> => {
    serial += 1;
    return seedItem(db, recordId, { barcode: `SIKLUS-${String(serial).padStart(4, '0')}`, status, ...o });
  };
  const setStatus = (id: string, status: ItemStatus, version = 0, now = NOW) => db.run((tx) => updateItem(tx, db.branchId, id, { version, status }), now);

  beforeAll(async () => {
    db = await openItemsDb('items-lifecycle');
    recordId = await seedRecord(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('available → lost → 409 ITEM_STATUS_TRANSITION, nothing changed', async () => {
    const id = await itemIn('available');
    expect(await failure(setStatus(id, 'lost'))).toMatchObject({ code: 'ITEM_STATUS_TRANSITION', meta: { from: 'available', to: 'lost' } });
    expect(await itemRow(db, id)).toMatchObject({ status: 'available', version: 0 });
    expect(await itemEvents(db, id)).toEqual([]);
  });

  it("missing → lost is allowed: a 'status' event with both statuses, the update audited and published", async () => {
    const id = await itemIn('missing');
    expect(await setStatus(id, 'lost')).toEqual({ id, version: 1 });
    expect(await itemRow(db, id)).toMatchObject({ status: 'lost', archived_at: null, version: 1 });
    expect(await itemEvents(db, id)).toEqual([expect.objectContaining({ type: 'status', from_status: 'missing', to_status: 'lost', fields: ['status'] })]);
    expect((await audits(db, 'catalog.item.update')).filter((a) => a.entityId === id)).toEqual([
      { entity: 'items', entityId: id, branchId: db.branchId, meta: { fields: ['status'] } },
    ]);
    expect((await itemChangedEvents(db)).filter((e) => e.id === id)).toEqual([{ id, recordId }]);
  });

  it('the same status again is not a transition: no refusal and no status event', async () => {
    const id = await itemIn('missing');
    await setStatus(id, 'missing');
    expect(await itemRow(db, id)).toMatchObject({ status: 'missing' });
    expect(await itemEvents(db, id)).toEqual([]);
  });

  it('every transition of the §2.5 table is allowed, every other pair refused', async () => {
    const table: Record<ItemStatus, readonly ItemStatus[]> = {
      on_order: ['processing', 'available', 'withdrawn'],
      processing: ['available', 'not_for_loan', 'withdrawn'],
      available: ['not_for_loan', 'repair', 'missing', 'withdrawn'],
      not_for_loan: ['available', 'repair', 'missing', 'withdrawn'],
      repair: ['available', 'not_for_loan', 'withdrawn'],
      missing: ['available', 'not_for_loan', 'lost'],
      lost: ['available', 'withdrawn'],
      withdrawn: ['processing'],
    };
    const statuses = Object.keys(table) as ItemStatus[];
    const wrong: string[] = [];
    for (const from of statuses) {
      for (const to of statuses) {
        if (from === to) continue;
        const id = await itemIn(from, { archived: from === 'withdrawn' });
        const outcome = await failure(setStatus(id, to));
        const allowed = table[from].includes(to);
        const ok = allowed ? outcome === 'resolved' : (outcome as { code?: string }).code === 'ITEM_STATUS_TRANSITION';
        if (!ok) wrong.push(`${from} → ${to}: ${JSON.stringify(outcome)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("archiveItem: withdrawn + archived_at, an 'archived' event, catalog.item.archive audited, version + 1", async () => {
    const id = await itemIn('available');
    expect(await db.run((tx) => archiveItem(tx, db.branchId, id, 0))).toEqual({ id, version: 1 });
    expect(await itemRow(db, id)).toMatchObject({ status: 'withdrawn', archived_at: NOW, version: 1 });
    expect(await itemEvents(db, id)).toEqual([expect.objectContaining({ type: 'archived', from_status: 'available', to_status: 'withdrawn' })]);
    expect((await audits(db, 'catalog.item.archive')).filter((a) => a.entityId === id)).toEqual([
      { entity: 'items', entityId: id, branchId: db.branchId, meta: {} },
    ]);
    expect((await getItem(db.h.db, id)).archived).toBe(true);
    // Again (a resent request): answered as it is, audited once more with alreadyArchived, nothing changed.
    expect(await db.run((tx) => archiveItem(tx, db.branchId, id, 1))).toEqual({ id, version: 1 });
    expect((await audits(db, 'catalog.item.archive')).filter((a) => a.entityId === id).map((a) => a.meta)).toEqual([{}, { alreadyArchived: true }]);
    expect(await itemEvents(db, id)).toHaveLength(1);
  });

  it('archiveItem of a missing item → 409 (missing → withdrawn is no transition); a stale version → CONFLICT_STALE; another branch → NOT_FOUND', async () => {
    const id = await itemIn('missing');
    expect(await failure(db.run((tx) => archiveItem(tx, db.branchId, id, 0)))).toMatchObject({ code: 'ITEM_STATUS_TRANSITION' });
    const other = await itemIn('available');
    expect(await failure(db.run((tx) => archiveItem(tx, db.branchId, other, 3)))).toMatchObject({ code: 'CONFLICT_STALE' });
    expect(await failure(db.run((tx) => archiveItem(tx, db.otherBranchId, other, 0)))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a status change to withdrawn archives the item as well', async () => {
    const id = await itemIn('repair');
    await setStatus(id, 'withdrawn');
    expect(await itemRow(db, id)).toMatchObject({ status: 'withdrawn', archived_at: NOW });
    expect((await itemEvents(db, id)).map((e) => e.type)).toEqual(['archived']);
  });

  it('withdrawn → processing clears archived_at', async () => {
    const id = await itemIn('available');
    await db.run((tx) => archiveItem(tx, db.branchId, id, 0));
    expect((await itemRow(db, id)).archived_at).toBe(NOW);
    await setStatus(id, 'processing', 1, NOW + 60_000);
    expect(await itemRow(db, id)).toMatchObject({ status: 'processing', archived_at: null, version: 2 });
    expect((await itemEvents(db, id)).map((e) => [e.type, e.from_status, e.to_status])).toEqual([
      ['archived', 'available', 'withdrawn'],
      ['status', 'withdrawn', 'processing'],
    ]);
    expect((await getItem(db.h.db, id)).archived).toBe(false);
  });

  it('a new item is available by default (P2-31); one created withdrawn is archived at once', async () => {
    const umum = await db.collectionTypeId('UMUM');
    const a = await db.run((tx) => createItem(tx, db.branchId, { recordId, barcode: 'BARU-SIKLUS-1', collectionTypeId: umum } as never));
    expect(await itemRow(db, a.id)).toMatchObject({ status: 'available', archived_at: null });
    const w = await db.run((tx) => createItem(tx, db.branchId, { recordId, barcode: 'BARU-SIKLUS-2', collectionTypeId: umum, status: 'withdrawn' } as never));
    expect(await itemRow(db, w.id)).toMatchObject({ status: 'withdrawn', archived_at: NOW });
  });
});
