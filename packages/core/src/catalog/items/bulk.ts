import type { FieldWarning } from '@altis/shared/api/catalog/common';
import { ItemBulkBody, type ItemBulkResponse } from '@altis/shared/api/catalog/items';
import type { TxCtx } from '../../context.js';
import { writeItemEvents } from './events.js';
import { ARCHIVED_STATUS, archivedAtAfter, canChangeStatus, itemStatusOf } from './lifecycle.js';
import {
  afterItemsWrite,
  changeEvents,
  itemValidationFailed,
  lockItemRecords,
  lockItemRows,
  lockLiveLocation,
  lockLiveMaster,
  parseItemBody,
  reviveErrors,
  type ItemRow,
} from './service.js';

// Bulk changes of items (Phase 2 spec §3.4): up to 500 items of one branch get a location, a status or a collection
// type in one transaction. Each item's status change is checked on its own: a refused item is reported (`not_found`
// for an id that names no item of the branch, `invalid_transition`, `invalid_location` when the location is not a live
// one of the branch; for an item leaving `withdrawn`, reviveErrors in service.ts: `record_archived` when its record
// is archived, `archived_reference` when the collection type, location or supplier it keeps is) and left as it is,
// the others proceed. An item already as asked counts as updated and is not
// written. One audit entry `catalog.item.bulk_update` (`meta {count, updated, refused, fields}`), history rows per
// changed item, its record's `changed_at` and index, and `catalog.item.changed` per changed item last.
//
// The item rows are locked first (a write that changes nothing, before any read), then their records' rows
// (lockItemRecords, C05), as one item's update does, then the collection type and the location the change names, each
// with a write that matches only a live row (lockLiveMaster, lockLiveLocation): the order every item writer takes
// (service.ts), and the archive of that master or location waits for the change and then counts the items it moved
// there.

const ID_BATCH = 500;

/**
 * Applies `body.set` to the items `body.ids` of `branchId` (see the top of this file); `updated` counts the items not
 * refused.
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'set.collectionTypeId', code: 'not_found' | 'archived'}`
 */
export async function bulkUpdateItems(tx: TxCtx, branchId: string, body: ItemBulkBody): Promise<ItemBulkResponse> {
  const { trx } = tx;
  const b = parseItemBody(ItemBulkBody, body);
  const ids = [...new Set(b.ids)];
  await lockItemRows(trx, branchId, ids);
  await lockItemRecords(trx, branchId, ids);

  const rows = new Map<string, ItemRow>();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = await trx
      .selectFrom('items')
      .selectAll()
      .where('id', 'in', ids.slice(i, i + ID_BATCH))
      .where('branch_id', '=', branchId)
      .execute();
    for (const r of batch) rows.set(r.id, r);
  }

  const errors: FieldWarning[] = [];
  if (b.set.collectionTypeId !== undefined) {
    const e = await lockLiveMaster(trx, 'collection_types', b.set.collectionTypeId, 'set.collectionTypeId');
    if (e !== null) errors.push(e);
  }
  if (errors.length > 0) throw itemValidationFailed(errors);
  const locationId = b.set.locationId;
  const badLocation = locationId !== undefined && locationId !== null && (await lockLiveLocation(trx, branchId, locationId, 'set.locationId')) !== null;

  const refused: ItemBulkResponse['refused'] = [];
  const written: { id: string; recordId: string }[] = [];
  let updated = 0;
  for (const id of ids) {
    const row = rows.get(id);
    if (row === undefined) {
      refused.push({ id, code: 'not_found' });
      continue;
    }
    if (badLocation) {
      refused.push({ id, code: 'invalid_location' });
      continue;
    }
    const from = itemStatusOf(row.status);
    const to = b.set.status ?? from;
    if (!canChangeStatus(from, to)) {
      refused.push({ id, code: 'invalid_transition' });
      continue;
    }
    if (from === ARCHIVED_STATUS && to !== ARCHIVED_STATUS) {
      const keep = { collectionType: b.set.collectionTypeId === undefined, location: locationId === undefined, supplier: true };
      const revive = await reviveErrors(trx, branchId, row, keep);
      if (revive.length > 0) {
        refused.push({ id, code: revive.some((e) => e.code === 'record_archived') ? 'record_archived' : 'archived_reference' });
        continue;
      }
    }
    updated += 1;
    const changed: string[] = [];
    const set: { status?: string; archived_at?: number | null; location_id?: string | null; collection_type_id?: string } = {};
    if (to !== from) {
      changed.push('status');
      set.status = to;
      set.archived_at = archivedAtAfter(from, to, row.archived_at === null ? null : Number(row.archived_at), tx.now);
    }
    if (locationId !== undefined && locationId !== row.location_id) {
      changed.push('locationId');
      set.location_id = locationId;
    }
    if (b.set.collectionTypeId !== undefined && b.set.collectionTypeId !== row.collection_type_id) {
      changed.push('collectionTypeId');
      set.collection_type_id = b.set.collectionTypeId;
    }
    if (changed.length === 0) continue;
    await trx
      .updateTable('items')
      .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .execute();
    changed.sort();
    await writeItemEvents(
      tx,
      changeEvents(id, changed, { status: from, locationId: row.location_id }, { status: to, locationId: locationId === undefined ? row.location_id : locationId }),
    );
    written.push({ id, recordId: row.record_id });
  }

  await afterItemsWrite(
    tx,
    written,
    {
      publicRecords: written.map((w) => w.recordId),
      audit: {
        action: 'catalog.item.bulk_update',
        entity: 'items',
        entityId: null,
        branchId,
        meta: { count: ids.length, updated, refused: refused.length, fields: Object.keys(b.set).sort() },
      },
      publish: true,
    },
  );
  return { updated, refused };
}
