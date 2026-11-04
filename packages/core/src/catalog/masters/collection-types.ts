import type { DB } from '@altis/db';
import { newId } from '@altis/shared';
import { CollectionTypeBody, CollectionTypePatchBody, type CollectionTypeView, type MasterListQuery } from '@altis/shared/api/catalog/masters';
import type { Selectable, Transaction, Updateable } from 'kysely';
import type { TxCtx } from '../../context.js';
import { codeKey } from '../data/keys.js';
import { archiveMaster, masterUsage, masterUsages } from './in-use.js';
import {
  MASTER_LIST_MAX,
  changedFields,
  codeTaken,
  givenFields,
  lockMasterRow,
  masterNotFound,
  masterStale,
  matchesQuery,
  parseBody,
  takingCode,
  type Db,
} from './support.js';

// Collection types (Phase 2 spec §2.2, §2.5, §2.6): what an item's collection is, and whether its items may be lent
// (`loanable`) and lent at a self-service kiosk (`self_service`). Items point at one
// (`items.collection_type_id`); a collection type that live items use cannot be archived.

const TABLE = 'collection_types';

type Row = Selectable<DB['collection_types']>;

function toView(row: Row, usage: number): CollectionTypeView {
  return {
    id: row.id,
    code: row.code_display,
    nameId: row.name_id,
    nameEn: row.name_en,
    loanable: Number(row.loanable) === 1,
    selfService: Number(row.self_service) === 1,
    sortOrder: Number(row.sort_order),
    usage,
    archived: row.archived_at !== null,
    version: Number(row.version),
  };
}

async function readRow(db: Db, id: string): Promise<Row> {
  const row = await db.selectFrom('collection_types').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw masterNotFound(TABLE);
  return row;
}

/** True when a collection type other than `exceptId` holds `key` (archived ones included). */
async function keyTaken(trx: Transaction<DB>, key: string, exceptId?: string): Promise<boolean> {
  let q = trx.selectFrom('collection_types').select('id').where('code_key', '=', key);
  if (exceptId !== undefined) q = q.where('id', '!=', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

const flag = (b: boolean): 0 | 1 => (b ? 1 : 0);

/**
 * The collection types by `sort_order` then code (at most 500), each with the number of live items of the type;
 * archived ones only with `q.includeArchived`, and only those whose code or names contain `q.q` when it is given.
 */
export async function listCollectionTypes(db: Db, q: MasterListQuery): Promise<CollectionTypeView[]> {
  let query = db.selectFrom('collection_types').selectAll();
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  query = query.orderBy('sort_order').orderBy('code_key').orderBy('id');
  if (q.q === undefined || q.q === '') query = query.limit(MASTER_LIST_MAX);
  const rows = (await query.execute()).filter((r) => matchesQuery(q.q, [r.code_display, r.name_id, r.name_en])).slice(0, MASTER_LIST_MAX);
  const usage = await masterUsages(db, TABLE, rows.map((r) => r.id));
  return rows.map((r) => toView(r, usage.get(r.id) ?? 0));
}

/**
 * Creates a collection type and audits `catalog.master.create` (`entity` collection_types, `meta.fields`).
 *
 * @throws DomainError VALIDATION_FAILED: a body the strict contract refuses, or `{path: 'code', code: 'taken'}`
 */
export async function createCollectionType(tx: TxCtx, input: CollectionTypeBody): Promise<CollectionTypeView> {
  const body = parseBody(CollectionTypeBody, input);
  const { trx } = tx;
  const key = codeKey(body.code);
  if (await keyTaken(trx, key)) throw codeTaken();
  const id = newId();
  await takingCode(() =>
    trx
      .insertInto('collection_types')
      .values({
        id,
        code_display: body.code,
        code_key: key,
        name_id: body.nameId,
        name_en: body.nameEn,
        loanable: flag(body.loanable),
        self_service: flag(body.selfService),
        sort_order: body.sortOrder,
        archived_at: null,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute(),
  );
  await tx.audit({ action: 'catalog.master.create', entity: TABLE, entityId: id, meta: { fields: givenFields(body) } });
  return toView(await readRow(trx, id), 0);
}

/**
 * Changes the fields `patch` sends, `version` + 1, and audits `catalog.master.update` with the names of the fields
 * whose value changed.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; VALIDATION_FAILED (the contract, or a code another type holds)
 */
export async function updateCollectionType(tx: TxCtx, id: string, input: CollectionTypePatchBody): Promise<CollectionTypeView> {
  const patch = parseBody(CollectionTypePatchBody, input);
  const { trx } = tx;
  await lockMasterRow(trx, TABLE, id);
  const before = await readRow(trx, id);
  if (Number(before.version) !== patch.version) throw masterStale(TABLE);

  const set: Updateable<DB['collection_types']> = {};
  if (patch.code !== undefined) {
    const key = codeKey(patch.code);
    if (key !== before.code_key && (await keyTaken(trx, key, id))) throw codeTaken();
    set.code_key = key;
    set.code_display = patch.code;
  }
  if (patch.nameId !== undefined) set.name_id = patch.nameId;
  if (patch.nameEn !== undefined) set.name_en = patch.nameEn;
  if (patch.loanable !== undefined) set.loanable = flag(patch.loanable);
  if (patch.selfService !== undefined) set.self_service = flag(patch.selfService);
  if (patch.sortOrder !== undefined) set.sort_order = patch.sortOrder;
  const fields = changedFields([
    ['code', patch.code, before.code_display],
    ['nameId', patch.nameId, before.name_id],
    ['nameEn', patch.nameEn, before.name_en],
    ['loanable', patch.loanable, Number(before.loanable) === 1],
    ['selfService', patch.selfService, Number(before.self_service) === 1],
    ['sortOrder', patch.sortOrder, Number(before.sort_order)],
  ]);

  const updated = await takingCode(() =>
    trx
      .updateTable('collection_types')
      .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .where('version', '=', patch.version)
      .executeTakeFirst(),
  );
  if (Number(updated.numUpdatedRows) !== 1) throw masterStale(TABLE);
  await tx.audit({ action: 'catalog.master.update', entity: TABLE, entityId: id, meta: { fields } });
  return toView(await readRow(trx, id), await masterUsage(trx, TABLE, id));
}

/**
 * Archives a collection type that no live item has; see {@link archiveMaster}.
 *
 * @returns the type's version after the call
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; CATALOG_IN_USE with `meta.count` (the live items)
 */
export function archiveCollectionType(tx: TxCtx, id: string, version: number): Promise<{ version: number }> {
  return archiveMaster(tx, TABLE, id, version);
}
