import type { DB } from '@altis/db';
import { newId } from '@altis/shared';
import { SupplierBody, SupplierPatchBody, type MasterListQuery, type SupplierView } from '@altis/shared/api/catalog/masters';
import type { Selectable, Transaction, Updateable } from 'kysely';
import type { TxCtx } from '../../context.js';
import { codeKey } from '../data/keys.js';
import { archiveMaster, masterUsage, masterUsages } from './in-use.js';
import {
  MASTER_LIST_MAX,
  blankToNull,
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

// Suppliers (Phase 2 spec §2.2): where items are bought from (`items.supplier_id`). The contact columns are personal
// data (main spec §6.9): they are answered only to staff with `catalog.records.read`, never on a public page, and an
// audit entry names them without their values. A blank optional text is stored as null. A supplier that live items
// name cannot be archived. Listed by code (the table has no `sort_order`).

const TABLE = 'suppliers';

type Row = Selectable<DB['suppliers']>;

function toView(row: Row, usage: number): SupplierView {
  return {
    id: row.id,
    code: row.code_display,
    name: row.name,
    contactName: row.contact_name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    note: row.note,
    usage,
    archived: row.archived_at !== null,
    version: Number(row.version),
  };
}

async function readRow(db: Db, id: string): Promise<Row> {
  const row = await db.selectFrom('suppliers').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw masterNotFound(TABLE);
  return row;
}

/** True when a supplier other than `exceptId` holds `key` (archived ones included). */
async function keyTaken(trx: Transaction<DB>, key: string, exceptId?: string): Promise<boolean> {
  let q = trx.selectFrom('suppliers').select('id').where('code_key', '=', key);
  if (exceptId !== undefined) q = q.where('id', '!=', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/** A patch's optional text as it is stored: undefined (not sent), or null for a blank one. */
const patchText = (s: string | null | undefined): string | null | undefined => (s === undefined ? undefined : blankToNull(s));

/**
 * The suppliers by code (at most 500), each with the number of live items bought from it; archived ones only with
 * `q.includeArchived`, and only those whose code or name contains `q.q` when it is given (never the contact fields).
 */
export async function listSuppliers(db: Db, q: MasterListQuery): Promise<SupplierView[]> {
  let query = db.selectFrom('suppliers').selectAll();
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  query = query.orderBy('code_key').orderBy('id');
  if (q.q === undefined || q.q === '') query = query.limit(MASTER_LIST_MAX);
  const rows = (await query.execute()).filter((r) => matchesQuery(q.q, [r.code_display, r.name])).slice(0, MASTER_LIST_MAX);
  const usage = await masterUsages(db, TABLE, rows.map((r) => r.id));
  return rows.map((r) => toView(r, usage.get(r.id) ?? 0));
}

/**
 * Creates a supplier and audits `catalog.master.create` (`entity` suppliers, `meta.fields`: the names of the fields
 * given a value, never the values).
 *
 * @throws DomainError VALIDATION_FAILED: a body the strict contract refuses, or `{path: 'code', code: 'taken'}`
 */
export async function createSupplier(tx: TxCtx, input: SupplierBody): Promise<SupplierView> {
  const body = parseBody(SupplierBody, input);
  const { trx } = tx;
  const key = codeKey(body.code);
  if (await keyTaken(trx, key)) throw codeTaken();
  const id = newId();
  await takingCode(() =>
    trx
      .insertInto('suppliers')
      .values({
        id,
        code_display: body.code,
        code_key: key,
        name: body.name,
        contact_name: blankToNull(body.contactName),
        phone: blankToNull(body.phone),
        email: blankToNull(body.email),
        address: blankToNull(body.address),
        note: blankToNull(body.note),
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
 * Changes the fields `patch` sends (null or a blank text clears an optional one), `version` + 1, and audits
 * `catalog.master.update` with the names of the fields whose value changed.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; VALIDATION_FAILED (the contract, or a code another supplier holds)
 */
export async function updateSupplier(tx: TxCtx, id: string, input: SupplierPatchBody): Promise<SupplierView> {
  const patch = parseBody(SupplierPatchBody, input);
  const { trx } = tx;
  await lockMasterRow(trx, TABLE, id);
  const before = await readRow(trx, id);
  if (Number(before.version) !== patch.version) throw masterStale(TABLE);

  const next = {
    contactName: patchText(patch.contactName),
    phone: patchText(patch.phone),
    email: patchText(patch.email),
    address: patchText(patch.address),
    note: patchText(patch.note),
  };
  const set: Updateable<DB['suppliers']> = {};
  if (patch.code !== undefined) {
    const key = codeKey(patch.code);
    if (key !== before.code_key && (await keyTaken(trx, key, id))) throw codeTaken();
    set.code_key = key;
    set.code_display = patch.code;
  }
  if (patch.name !== undefined) set.name = patch.name;
  if (next.contactName !== undefined) set.contact_name = next.contactName;
  if (next.phone !== undefined) set.phone = next.phone;
  if (next.email !== undefined) set.email = next.email;
  if (next.address !== undefined) set.address = next.address;
  if (next.note !== undefined) set.note = next.note;
  const fields = changedFields([
    ['code', patch.code, before.code_display],
    ['name', patch.name, before.name],
    ['contactName', next.contactName, before.contact_name],
    ['phone', next.phone, before.phone],
    ['email', next.email, before.email],
    ['address', next.address, before.address],
    ['note', next.note, before.note],
  ]);

  const updated = await takingCode(() =>
    trx
      .updateTable('suppliers')
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
 * Archives a supplier that no live item names; see {@link archiveMaster}.
 *
 * @returns the supplier's version after the call
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; CATALOG_IN_USE with `meta.count` (the live items)
 */
export function archiveSupplier(tx: TxCtx, id: string, version: number): Promise<{ version: number }> {
  return archiveMaster(tx, TABLE, id, version);
}
