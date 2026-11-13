import type { DB } from '@altis/db';
import { isDomainError, newId } from '@altis/shared';
import { BudgetBody, BudgetPatchBody, type BudgetView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Selectable, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import {
  archiveRegisterTableRow,
  auditRegister,
  changedFields,
  checkVersion,
  givenFields,
  lockRegisterRow,
  newTrail,
  parseBody,
  patchText,
  patchValue,
  registerNotFound,
  textOrNull,
  validationFailed,
  writeRegisterRow,
  type Db,
} from './common.js';

// The Budgets register (spec §3.2, §10.6): one row per year for the whole library (`scope_key` ''), money in the
// currency's minor unit with its currency: the library's budget, the parent institution's (in total, and without staff,
// maintenance and building upkeep), the collection purchases and the community's contribution. The year is unique among
// the live rows (UNIQUE `scope_key`, `year`): a second one is the field error `{path: 'year', code: 'taken'}`, checked
// first and again when the write loses the race for the key. Archiving renames the row's scope key to `~<id>`, so the
// same year can be entered again. Listed latest year first.

const TABLE = 'library_budgets';
/** The scope of a library-wide budget (the only scope of this edition). */
const LIBRARY_SCOPE = '';

type Row = Selectable<DB['library_budgets']>;

const minorOrNull = (v: number | string | null): number | null => (v === null ? null : Number(v));

function toView(row: Row): BudgetView {
  return {
    id: row.id,
    year: Number(row.year),
    libraryMinor: Number(row.library_minor),
    parentMinor: minorOrNull(row.parent_minor),
    parentNonpersonnelMinor: minorOrNull(row.parent_nonpersonnel_minor),
    collectionMinor: minorOrNull(row.collection_minor),
    communityMinor: minorOrNull(row.community_minor),
    currency: row.currency,
    note: row.note,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    createdBy: row.created_by,
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by,
  };
}

const yearTaken = () => validationFailed([{ path: 'year', code: 'taken' }]);

/** True when a live library-wide budget other than `exceptId` holds `year`. */
async function yearIsTaken(trx: Transaction<DB>, year: number, exceptId?: string): Promise<boolean> {
  let q = trx.selectFrom(TABLE).select('id').where('scope_key', '=', LIBRARY_SCOPE).where('year', '=', year);
  if (exceptId !== undefined) q = q.where('id', '!=', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/**
 * Runs a write that may lose the race for (scope, year): that UNIQUE_VIOLATION is a taken year. It ends the
 * transaction on PostgreSQL, so it is thrown at once and nothing runs after it.
 */
async function takingYear<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') throw yearTaken();
    throw error;
  }
}

/** The live budgets, latest year first. */
export async function listBudgets(db: Db): Promise<BudgetView[]> {
  const rows = await db.selectFrom(TABLE).selectAll().where('archived_at', 'is', null).execute();
  return rows.map(toView).sort((a, b) => b.year - a.year || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Records a year's budget.
 *
 * @throws DomainError VALIDATION_FAILED (the contract, or `{path: 'year', code: 'taken'}`)
 */
export async function createBudget(tx: TxCtx, input: BudgetBody, now: number): Promise<StoreResponse> {
  const body = parseBody(BudgetBody, input);
  const { trx } = tx;
  if (await yearIsTaken(trx, body.year)) throw yearTaken();
  const id = newId(now);
  await takingYear(() =>
    trx
      .insertInto(TABLE)
      .values({
        id,
        scope_key: LIBRARY_SCOPE,
        branch_id: null,
        year: body.year,
        library_minor: body.libraryMinor,
        parent_minor: body.parentMinor ?? null,
        parent_nonpersonnel_minor: body.parentNonpersonnelMinor ?? null,
        collection_minor: body.collectionMinor ?? null,
        community_minor: body.communityMinor ?? null,
        currency: body.currency,
        note: textOrNull(body.note),
        version: 0,
        ...newTrail(now, tx.actor.id),
      })
      .execute(),
  );
  await auditRegister(tx, 'accreditation.register.create', TABLE, id, givenFields(body));
  return { id, version: 0 };
}

/**
 * Changes the fields `patch` sends (null clears an optional amount).
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; VALIDATION_FAILED (the contract, or a year another budget holds)
 */
export async function updateBudget(tx: TxCtx, id: string, input: BudgetPatchBody, now: number): Promise<StoreResponse> {
  const patch = parseBody(BudgetPatchBody, input);
  const { trx } = tx;
  await lockRegisterRow(trx, TABLE, id);
  const row = await trx.selectFrom(TABLE).selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined || row.archived_at !== null) throw registerNotFound(TABLE);
  checkVersion(TABLE, row, patch.version);
  const before = toView(row);
  const next = {
    year: patch.year,
    libraryMinor: patch.libraryMinor,
    parentMinor: patchValue(patch.parentMinor),
    parentNonpersonnelMinor: patchValue(patch.parentNonpersonnelMinor),
    collectionMinor: patchValue(patch.collectionMinor),
    communityMinor: patchValue(patch.communityMinor),
    currency: patch.currency,
    note: patchText(patch.note),
  };
  if (next.year !== undefined && next.year !== before.year && (await yearIsTaken(trx, next.year, id))) throw yearTaken();
  const set = {
    year: next.year,
    library_minor: next.libraryMinor,
    parent_minor: next.parentMinor,
    parent_nonpersonnel_minor: next.parentNonpersonnelMinor,
    collection_minor: next.collectionMinor,
    community_minor: next.communityMinor,
    currency: next.currency,
    note: next.note,
  };
  const version = await takingYear(() => writeRegisterRow(tx, TABLE, id, patch.version, set, now));
  await auditRegister(tx, 'accreditation.register.update', TABLE, id, changedFields(next, before));
  return { id, version };
}

/** Archives a year's budget: its scope key becomes `~<id>`, so the year can be entered again. */
export function archiveBudget(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  return archiveRegisterTableRow(tx, TABLE, id, now, (row) => ({ scope_key: `~${row.id}` }));
}
