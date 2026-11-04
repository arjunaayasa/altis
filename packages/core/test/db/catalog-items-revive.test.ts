import { newId, type Permission } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import type { Grants } from '../../src/authz/grants.js';
import { loadCustomDefs } from '../../src/catalog/data/custom-fields.js';
import { importBatch, type BatchSettings } from '../../src/catalog/exchange/import-batch.js';
import { bulkUpdateItems } from '../../src/catalog/items/bulk.js';
import { updateItem } from '../../src/catalog/items/service.js';
import { createCollectionType } from '../../src/catalog/masters/collection-types.js';
import { NOW, fieldErrors, itemRow, openItemsDb, seedItem, seedLocation, seedRecord, seedSupplier, type ItemsDb } from './catalog-items-support.js';

// Phase 2 big review, group P1-catalog-writes, C03: an item brought back from `withdrawn` (§2.5, `withdrawn →
// processing` clears `archived_at`) becomes live again, so what it points to must be live too. Spec §3.1 refuses to
// archive a record that still has a live item, and the archives of a location, a collection type and a supplier count
// only live items; a withdrawn item counted for none of them. So the record of an item coming back must be live
// (`{path: 'status', code: 'record_archived'}`), and so must the location, collection type and supplier it keeps
// (`archived` at that field; one the same change replaces or clears is checked as the new value, or not at all).
// The same holds for a bulk change (refused `record_archived` / `archived_reference`, the other items go on) and for
// an import's update row, which goes through updateItem.

const ctx = testDbContext();
const ITEMS_EVERYWHERE: Grants = {
  global: new Set<Permission>(['catalog.items.manage']),
  branches: new Map(),
  superAdmin: false,
  roleMfaRequired: false,
};

describe.skipIf(!ctx.available)(`items: bringing a withdrawn item back checks what it points to [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let serial = 0;

  beforeAll(async () => {
    db = await openItemsDb('items-revive');
  });

  afterAll(async () => {
    await db?.close();
  });

  const barcode = (): string => {
    serial += 1;
    return `HIDUP-${String(serial).padStart(4, '0')}`;
  };
  /** A withdrawn (archived) item of `recordId`; its id. */
  const withdrawn = (recordId: string, o: { locationId?: string; collectionTypeCode?: string } = {}): Promise<string> =>
    seedItem(db, recordId, { barcode: barcode(), status: 'withdrawn', archived: true, ...o });
  const archive = (table: 'records' | 'locations' | 'collection_types' | 'suppliers', id: string) =>
    db.h.db
      .updateTable(table as 'locations')
      .set({ archived_at: NOW })
      .where('id', '=', id)
      .execute();
  const collectionType = async (): Promise<{ id: string; code: string }> => {
    const code = `CT${newId().slice(-8)}`;
    const view = await db.run((tx) => createCollectionType(tx, { code, nameId: 'Hadiah', nameEn: 'Gift', loanable: true, selfService: true, sortOrder: 50 }));
    return { id: view.id, code };
  };
  const revive = (id: string, patch: Record<string, unknown> = {}) => db.run((tx) => updateItem(tx, db.branchId, id, { version: 0, status: 'processing', ...patch }));
  /** What the item is now: its status, version and whether it is archived. */
  const stateOf = async (id: string): Promise<{ status: string; version: number; archived: boolean }> => {
    const row = await itemRow(db, id);
    return { status: row.status, version: Number(row.version), archived: row.archived_at !== null };
  };
  const stillWithdrawn = { status: 'withdrawn', version: 0, archived: true };

  describe('PATCH (updateItem)', () => {
    it('an item whose record was archived: VALIDATION_FAILED status record_archived, the item stays withdrawn', async () => {
      const recordId = await seedRecord(db, { archived: true });
      const id = await withdrawn(recordId);
      expect(await fieldErrors(revive(id))).toEqual([{ path: 'status', code: 'record_archived' }]);
      expect(await stateOf(id)).toEqual(stillWithdrawn);
    });

    it('an item whose shelf was archived: locationId archived; moved off the shelf in the same change, it comes back', async () => {
      const recordId = await seedRecord(db);
      const shelf = await seedLocation(db, { code: `RAK-${barcode()}`, kind: 'room', archived: true });
      const live = await seedLocation(db, { code: `RAK-${barcode()}`, kind: 'room' });
      const kept = await withdrawn(recordId, { locationId: shelf });
      expect(await fieldErrors(revive(kept))).toEqual([{ path: 'locationId', code: 'archived' }]);
      expect(await stateOf(kept)).toEqual(stillWithdrawn);
      const moved = await withdrawn(recordId, { locationId: shelf });
      expect(await revive(moved, { locationId: live })).toEqual({ id: moved, version: 1 });
      const cleared = await withdrawn(recordId, { locationId: shelf });
      expect(await revive(cleared, { locationId: null })).toEqual({ id: cleared, version: 1 });
      expect(await stateOf(cleared)).toEqual({ status: 'processing', version: 1, archived: false });
      expect((await itemRow(db, cleared)).location_id).toBeNull();
    });

    it('an item whose collection type was archived: collectionTypeId archived; given a live one, it comes back', async () => {
      const recordId = await seedRecord(db);
      const old = await collectionType();
      const fresh = await collectionType();
      await archive('collection_types', old.id);
      const kept = await withdrawn(recordId, { collectionTypeCode: old.code });
      expect(await fieldErrors(revive(kept))).toEqual([{ path: 'collectionTypeId', code: 'archived' }]);
      const changed = await withdrawn(recordId, { collectionTypeCode: old.code });
      expect(await revive(changed, { collectionTypeId: fresh.id })).toEqual({ id: changed, version: 1 });
    });

    it('an item whose supplier was archived: supplierId archived; with the supplier cleared, it comes back', async () => {
      const recordId = await seedRecord(db);
      const supplier = await seedSupplier(db, `SUP-${barcode()}`);
      await archive('suppliers', supplier);
      const kept = await withdrawn(recordId);
      const cleared = await withdrawn(recordId);
      await db.h.db.updateTable('items').set({ supplier_id: supplier }).where('id', 'in', [kept, cleared]).execute();
      expect(await fieldErrors(revive(kept))).toEqual([{ path: 'supplierId', code: 'archived' }]);
      expect(await revive(cleared, { supplierId: null })).toEqual({ id: cleared, version: 1 });
    });

    it('every error at once, nothing written', async () => {
      const recordId = await seedRecord(db, { archived: true });
      const shelf = await seedLocation(db, { code: `RAK-${barcode()}`, kind: 'room', archived: true });
      const old = await collectionType();
      await archive('collection_types', old.id);
      const id = await withdrawn(recordId, { locationId: shelf, collectionTypeCode: old.code });
      expect(await fieldErrors(revive(id))).toEqual([
        { path: 'status', code: 'record_archived' },
        { path: 'collectionTypeId', code: 'archived' },
        { path: 'locationId', code: 'archived' },
      ]);
    });

    it('everything live: withdrawn → processing clears archived_at', async () => {
      const recordId = await seedRecord(db);
      const shelf = await seedLocation(db, { code: `RAK-${barcode()}`, kind: 'room' });
      const id = await withdrawn(recordId, { locationId: shelf });
      expect(await revive(id)).toEqual({ id, version: 1 });
      expect(await stateOf(id)).toEqual({ status: 'processing', version: 1, archived: false });
      expect((await itemRow(db, id)).location_id).toBe(shelf);
    });

    it('an item that stays withdrawn may still be edited on an archived record', async () => {
      const recordId = await seedRecord(db, { archived: true });
      const id = await withdrawn(recordId);
      expect(await db.run((tx) => updateItem(tx, db.branchId, id, { version: 0, note: 'Disimpan di gudang' }))).toEqual({ id, version: 1 });
    });
  });

  describe('bulk (bulkUpdateItems)', () => {
    it('refuses the items coming back to an archived record or an archived shelf or type, and changes the others', async () => {
      const archivedRecord = await seedRecord(db, { archived: true });
      const liveRecord = await seedRecord(db);
      const shelf = await seedLocation(db, { code: `RAK-${barcode()}`, kind: 'room', archived: true });
      const old = await collectionType();
      await archive('collection_types', old.id);
      const onArchived = await withdrawn(archivedRecord);
      const onShelf = await withdrawn(liveRecord, { locationId: shelf });
      const ofType = await withdrawn(liveRecord, { collectionTypeCode: old.code });
      const fine = await withdrawn(liveRecord);
      const answer = await db.run((tx) => bulkUpdateItems(tx, db.branchId, { ids: [onArchived, onShelf, ofType, fine], set: { status: 'processing' } }));
      expect(answer).toEqual({
        updated: 1,
        refused: [
          { id: onArchived, code: 'record_archived' },
          { id: onShelf, code: 'archived_reference' },
          { id: ofType, code: 'archived_reference' },
        ],
      });
      for (const id of [onArchived, onShelf, ofType]) expect(await stateOf(id)).toEqual(stillWithdrawn);
      expect(await stateOf(fine)).toEqual({ status: 'processing', version: 1, archived: false });
    });

    it('a bulk move off the archived shelf brings the item back', async () => {
      const recordId = await seedRecord(db);
      const shelf = await seedLocation(db, { code: `RAK-${barcode()}`, kind: 'room', archived: true });
      const live = await seedLocation(db, { code: `RAK-${barcode()}`, kind: 'room' });
      const id = await withdrawn(recordId, { locationId: shelf });
      expect(await db.run((tx) => bulkUpdateItems(tx, db.branchId, { ids: [id], set: { status: 'processing', locationId: live } }))).toEqual({ updated: 1, refused: [] });
    });
  });

  describe('import (an update row goes through updateItem)', () => {
    it('a CSV item row that sets processing on a withdrawn item of an archived record is a row error', async () => {
      const recordId = await seedRecord(db, { archived: true });
      const code = barcode();
      const id = await seedItem(db, recordId, { barcode: code, status: 'withdrawn', archived: true });
      const settings: BatchSettings = {
        runId: newId(NOW),
        format: 'csv-items',
        matchOn: 'record_id',
        onMatch: 'update',
        onDuplicate: 'report',
        createItems: false,
        branchId: db.branchId,
        defaultMaterialTypeId: (await db.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id,
        defaultCollectionTypeId: await db.collectionTypeId('UMUM'),
        threshold: 100,
        grants: ITEMS_EVERYWHERE,
        recordDefs: await loadCustomDefs(db.h.db, 'records'),
        itemDefs: await loadCustomDefs(db.h.db, 'items'),
      };
      const outcome = await db.run((tx) => importBatch(tx, settings, [{ kind: 'item', recordNo: 1, line: 2, item: { barcode: code, status: 'processing', custom: {} }, issues: [] }]));
      expect(outcome.counts).toMatchObject({ updated: 0, errors: 1 });
      expect(outcome.rows.map((r) => [r[2], r[3], r[4]])).toEqual([['error', 'record_archived', 'status']]);
      expect(await stateOf(id)).toEqual(stillWithdrawn);
    });
  });
});
