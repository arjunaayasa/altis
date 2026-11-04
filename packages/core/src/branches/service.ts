import type { DB } from '@altis/db';
import { DomainError, isDomainError, newId, normalizeKey } from '@altis/shared';
import type { BranchCreateBody, BranchItem, BranchListQuery, BranchPatchBody } from '@altis/shared/api/branches';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { TxCtx } from '../context.js';

// Branch management (spec §6.5, §7.2, decision D6). A branch has a code stored twice (spec §6.1): `code_display` as
// typed and `code_key` normalized (`normalizeKey`: NFKC, trimmed, upper case), which is UNIQUE. Writes take the
// transaction of their action (`tx`), audit in it, and never need the actor to be a staff user: the CLI may call them.
//
// - A taken code is VALIDATION_FAILED `{path: 'code', code: 'taken'}`: checked first, and again when the INSERT or
//   UPDATE itself loses the race for the key (UNIQUE_VIOLATION, which on PostgreSQL ends the transaction: the error
//   is thrown at once, nothing continues on it).
// - `version` is the optimistic-concurrency counter: the UPDATE carries `WHERE version = ?`, so two writers that read
//   the same version cannot both win.
// - The default branch (`is_default`) is never archived. Archiving keeps the branch's role assignments (`user_roles`):
//   the people who work there keep their roles, and Task 19 refuses new assignments at an archived branch.

type BranchRow = Selectable<DB['branches']>;

const TAKEN_DETAIL = 'Kode cabang sudah dipakai / The branch code is already taken';
const NOT_FOUND_DETAIL = 'Cabang tidak ditemukan / Branch not found';

/** VALIDATION_FAILED for a code another branch holds (what `{path, code}` of a Zod issue looks like, D10). */
function codeTaken(): DomainError {
  return new DomainError('VALIDATION_FAILED', { detail: TAKEN_DETAIL, meta: { errors: [{ path: 'code', code: 'taken' }] } });
}

function notFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
}

function stale(): DomainError {
  return new DomainError('CONFLICT_STALE', {
    detail: 'Cabang sudah diubah orang lain; muat ulang / The branch was changed by someone else; reload it',
  });
}

/** The API's view of a row (the drivers hand BIGINT back as a number, a string or a bigint: Number() for all). */
function toItem(row: BranchRow): BranchItem {
  return {
    id: row.id,
    code: row.code_display,
    name: row.name,
    address: row.address,
    timezone: row.timezone,
    isDefault: Number(row.is_default) === 1,
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    version: Number(row.version),
  };
}

async function readRow(trx: Transaction<DB>, id: string): Promise<BranchRow> {
  const row = await trx.selectFrom('branches').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw notFound();
  return row;
}

/** True when a branch other than `exceptId` holds `key`. */
async function keyTaken(trx: Transaction<DB>, key: string, exceptId?: string): Promise<boolean> {
  let q = trx.selectFrom('branches').select('id').where('code_key', '=', key);
  if (exceptId !== undefined) q = q.where('id', '!=', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/** Runs a write that may lose the race for `code_key`: that UNIQUE_VIOLATION is a taken code. */
async function takingCode<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') throw codeTaken();
    throw error;
  }
}

/**
 * The branches, the default one first and then by code; archived ones only with `q.includeArchived`. `db` is the
 * handle's `db` or a transaction.
 */
export async function listBranches(db: Kysely<DB>, q: BranchListQuery): Promise<BranchItem[]> {
  let query = db.selectFrom('branches').selectAll();
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  const rows = await query.orderBy('is_default', 'desc').orderBy('code_key').execute();
  return rows.map(toItem);
}

/**
 * Creates an active, non-default branch and audits `branches.create`.
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'code', code: 'taken'}` when another branch has the same code key
 */
export async function createBranch(tx: TxCtx, body: BranchCreateBody): Promise<BranchItem> {
  const { trx } = tx;
  const key = normalizeKey(body.code);
  if (await keyTaken(trx, key)) throw codeTaken();
  const id = newId();
  await takingCode(() =>
    trx
      .insertInto('branches')
      .values({
        id,
        code_key: key,
        code_display: body.code,
        name: body.name,
        address: body.address ?? null,
        timezone: body.timezone,
        is_default: 0,
        archived_at: null,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute(),
  );
  await tx.audit({ action: 'branches.create', entity: 'branches', entityId: id, meta: { code: body.code, name: body.name } });
  return toItem(await readRow(trx, id));
}

/**
 * Changes the fields of `body` (not `version`, which only guards) and audits `branches.update` with the names of the
 * fields whose value really changed. `version` + 1.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE when `body.version` is not the row's; VALIDATION_FAILED `taken` for a
 *   code another branch holds (the branch's own code, in any case, is fine)
 */
export async function updateBranch(tx: TxCtx, id: string, body: BranchPatchBody): Promise<BranchItem> {
  const { trx } = tx;
  const before = await readRow(trx, id);
  if (Number(before.version) !== body.version) throw stale();

  const changed: string[] = [];
  const set: { code_key?: string; code_display?: string; name?: string; address?: string | null; timezone?: string } = {};
  if (body.code !== undefined) {
    const key = normalizeKey(body.code);
    if (key !== before.code_key && (await keyTaken(trx, key, id))) throw codeTaken();
    if (body.code !== before.code_display) changed.push('code');
    set.code_key = key;
    set.code_display = body.code;
  }
  if (body.name !== undefined) {
    if (body.name !== before.name) changed.push('name');
    set.name = body.name;
  }
  if (body.address !== undefined) {
    if (body.address !== before.address) changed.push('address');
    set.address = body.address;
  }
  if (body.timezone !== undefined) {
    if (body.timezone !== before.timezone) changed.push('timezone');
    set.timezone = body.timezone;
  }

  const updated = await takingCode(() =>
    trx
      .updateTable('branches')
      .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .where('version', '=', body.version)
      .executeTakeFirst(),
  );
  // Another writer committed between the read and the UPDATE.
  if (Number(updated.numUpdatedRows) !== 1) throw stale();
  await tx.audit({ action: 'branches.update', entity: 'branches', entityId: id, meta: { changed } });
  return toItem(await readRow(trx, id));
}

/**
 * Archives a branch (`archived_at = now`, `version` + 1) and audits `branches.archive`. Role assignments at the branch
 * stay. A branch that is already archived is left as it is (`archived_at` keeps its first value) and answered the
 * same, so that a repeated DELETE is safe to retry; its entry then carries `meta.alreadyArchived: true`, because a
 * route that audits writes exactly one entry (§7.8).
 *
 * @throws DomainError NOT_FOUND; BRANCH_DEFAULT_ARCHIVE for the default branch
 */
export async function archiveBranch(tx: TxCtx, id: string): Promise<BranchItem> {
  const { trx } = tx;
  const before = await readRow(trx, id);
  if (Number(before.is_default) === 1) {
    throw new DomainError('BRANCH_DEFAULT_ARCHIVE', {
      detail: 'Cabang utama tidak dapat diarsipkan / The default branch cannot be archived',
    });
  }
  const updated = await trx
    .updateTable('branches')
    .set((eb) => ({ archived_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  const archived = Number(updated.numUpdatedRows) === 1;
  await tx.audit({
    action: 'branches.archive',
    entity: 'branches',
    entityId: id,
    meta: archived ? { code: before.code_display } : { code: before.code_display, alreadyArchived: true },
  });
  return toItem(await readRow(trx, id));
}
