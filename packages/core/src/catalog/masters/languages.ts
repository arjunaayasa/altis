import type { DB } from '@altis/db';
import { newId } from '@altis/shared';
import { LanguageBody, LanguagePatchBody, type LanguageView, type MasterListQuery } from '@altis/shared/api/catalog/masters';
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

// Languages (Phase 2 spec §2.2, §2.6): a language by its MARC code (≈ ISO 639-2/B, `ind`), with its names in both
// languages. Records point at one (`records.language_id`); a language that live records use cannot be archived.
// Listed by code (the table has no `sort_order`).

const TABLE = 'languages';

type Row = Selectable<DB['languages']>;

function toView(row: Row, usage: number): LanguageView {
  return {
    id: row.id,
    code: row.code_display,
    nameId: row.name_id,
    nameEn: row.name_en,
    usage,
    archived: row.archived_at !== null,
    version: Number(row.version),
  };
}

async function readRow(db: Db, id: string): Promise<Row> {
  const row = await db.selectFrom('languages').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw masterNotFound(TABLE);
  return row;
}

/** True when a language other than `exceptId` holds `key` (archived ones included: the key is unique over all). */
async function keyTaken(trx: Transaction<DB>, key: string, exceptId?: string): Promise<boolean> {
  let q = trx.selectFrom('languages').select('id').where('code_key', '=', key);
  if (exceptId !== undefined) q = q.where('id', '!=', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/**
 * The languages by code (at most 500), each with the number of live records that use it; archived ones only with
 * `q.includeArchived`, and only those whose code or names contain `q.q` when it is given.
 */
export async function listLanguages(db: Db, q: MasterListQuery): Promise<LanguageView[]> {
  let query = db.selectFrom('languages').selectAll();
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  query = query.orderBy('code_key').orderBy('id');
  if (q.q === undefined || q.q === '') query = query.limit(MASTER_LIST_MAX);
  const rows = (await query.execute()).filter((r) => matchesQuery(q.q, [r.code_display, r.name_id, r.name_en])).slice(0, MASTER_LIST_MAX);
  const usage = await masterUsages(db, TABLE, rows.map((r) => r.id));
  return rows.map((r) => toView(r, usage.get(r.id) ?? 0));
}

/**
 * Creates a language and audits `catalog.master.create` (`entity` languages, `meta.fields`: the fields given).
 *
 * @throws DomainError VALIDATION_FAILED: a body the strict contract refuses, or `{path: 'code', code: 'taken'}`
 */
export async function createLanguage(tx: TxCtx, input: LanguageBody): Promise<LanguageView> {
  const body = parseBody(LanguageBody, input);
  const { trx } = tx;
  const key = codeKey(body.code);
  if (await keyTaken(trx, key)) throw codeTaken();
  const id = newId();
  await takingCode(() =>
    trx
      .insertInto('languages')
      .values({
        id,
        code_display: body.code,
        code_key: key,
        name_id: body.nameId,
        name_en: body.nameEn,
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
 * Changes the fields `patch` sends (`version` only guards), `version` + 1, and audits `catalog.master.update` with the
 * names of the fields whose value changed.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; VALIDATION_FAILED (the contract, or a code another language holds)
 */
export async function updateLanguage(tx: TxCtx, id: string, input: LanguagePatchBody): Promise<LanguageView> {
  const patch = parseBody(LanguagePatchBody, input);
  const { trx } = tx;
  await lockMasterRow(trx, TABLE, id);
  const before = await readRow(trx, id);
  if (Number(before.version) !== patch.version) throw masterStale(TABLE);

  const set: Updateable<DB['languages']> = {};
  if (patch.code !== undefined) {
    const key = codeKey(patch.code);
    if (key !== before.code_key && (await keyTaken(trx, key, id))) throw codeTaken();
    set.code_key = key;
    set.code_display = patch.code;
  }
  if (patch.nameId !== undefined) set.name_id = patch.nameId;
  if (patch.nameEn !== undefined) set.name_en = patch.nameEn;
  const fields = changedFields([
    ['code', patch.code, before.code_display],
    ['nameId', patch.nameId, before.name_id],
    ['nameEn', patch.nameEn, before.name_en],
  ]);

  const updated = await takingCode(() =>
    trx
      .updateTable('languages')
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
 * Archives a language that no live record uses; see {@link archiveMaster}.
 *
 * @returns the language's version after the call
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; CATALOG_IN_USE with `meta.count` (the live records)
 */
export function archiveLanguage(tx: TxCtx, id: string, version: number): Promise<{ version: number }> {
  return archiveMaster(tx, TABLE, id, version);
}
