import type { DB } from '@altis/db';
import { CUSTOM_FIELD_ENTITIES, newId, type CustomFieldEntity, type CustomFieldType } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import {
  CustomFieldBody,
  CustomFieldPatchBody,
  type CustomFieldOption,
  type CustomFieldView,
  type MasterListQuery,
} from '@altis/shared/api/catalog/masters';
import type { Selectable, Transaction, Updateable } from 'kysely';
import { z } from 'zod';
import type { TxCtx } from '../../context.js';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import type { JobRegistry } from '../../jobs/types.js';
import { REINDEX_RECORD_IDS_MAX, enqueueReindex } from '../../search/jobs.js';
import { codeKey } from '../data/keys.js';
import { masterUsage, masterUsages } from './in-use.js';
import { renameTemplateCustomField } from './material-types.js';
import {
  MASTER_LIST_MAX,
  blankToNull,
  changedFields,
  givenFields,
  lockMasterRow,
  masterNotFound,
  masterStale,
  matchesQuery,
  parseBody,
  takingCode,
  validationFailed,
  type Db,
} from './support.js';

// Custom fields of records and items (Phase 2 spec §2.2 "Perubahan tabel Fase 1", §3.7): `custom_field_defs` rows of
// entity `records` or `items`. The values (`custom_values`) are written by the records and items services through
// catalog/data's customValuesSchema; this module manages the definitions.
//
// - `entity` and `type` are set once: a patch that sends them is refused by its strict body. The code is unique per
//   entity on its key; a code that cannot key a value (a dot, which splits the error path `custom.<code>`, or
//   `__proto__`) is `invalid_format`.
// - A `select`/`multiselect` field needs at least one option (`{path: 'options', code: 'required'}`, on a patch that
//   empties them too); any other type takes none (`not_allowed`). The options are stored in the §3.7 shape
//   `[{value, label_id, label_en}]` (`label_en` null when absent): the shape whose JSON the contract caps at 60 000
//   bytes (Review Focus 3).
// - A custom field may always be archived (§3.7): its values stay stored, an archived code is ignored where values are
//   shown and refused in new bodies. `usage` counts its stored values.
// - Renaming a records field's code (its key) rewrites the material type templates that name it, so the editor keeps
//   showing the field.
// - The search index holds the values of the fields that are public and searchable (S20), select options with their
//   labels. A change of that (the flags, archiving, the options of such a field) queues a `catalog.reindex` when the
//   field holds values and the caller gives a queue (`o.reindex`; the API always does): of the records those values
//   feed (at most 1000, REINDEX_RECORD_IDS_MAX), else of everything.

const TABLE = 'custom_field_defs';

type Row = Selectable<DB['custom_field_defs']>;

/** The entities this API manages fields of (Phase 2). */
const ENTITIES: readonly CustomFieldEntity[] = CUSTOM_FIELD_ENTITIES;

/** The types whose value is one or more of the field's options. */
const CHOICE_TYPES: ReadonlySet<string> = new Set<CustomFieldType>(['select', 'multiselect']);

/** Where a write may queue the reindex its change needs: a registry with `catalog.reindex`, and the keyring. */
export interface CustomFieldWriteOptions {
  reindex?: { registry: JobRegistry; keyring: readonly KeyringEntry[] };
}

/** The stored options JSON (§3.7). */
const storedOptions = z.array(z.looseObject({ value: z.string(), label_id: z.string().nullish(), label_en: z.string().nullish() }));

function parseOptions(json: string | null): CustomFieldView['options'] {
  if (json === null) return [];
  try {
    const parsed = storedOptions.safeParse(JSON.parse(json));
    if (!parsed.success) return [];
    return parsed.data.map((o) => ({ value: o.value, labelId: o.label_id ?? o.value, labelEn: o.label_en ?? null }));
  } catch {
    return [];
  }
}

/** The JSON text of `options` in the §3.7 shape, or null for none. */
function optionsJson(options: readonly CustomFieldOption[] | null): string | null {
  if (options === null || options.length === 0) return null;
  return JSON.stringify(options.map((o) => ({ value: o.value, label_id: o.labelId, label_en: blankToNull(o.labelEn) })));
}

function toView(row: Row, usage: number): CustomFieldView {
  return {
    id: row.id,
    entity: row.entity as CustomFieldEntity,
    code: row.code_display,
    type: row.type as CustomFieldType,
    labelId: row.label,
    labelEn: row.label_en,
    options: parseOptions(row.options),
    required: Number(row.is_required) === 1,
    sortOrder: Number(row.sort_order),
    isPublic: Number(row.is_public) === 1,
    isSearchable: Number(row.is_searchable) === 1,
    usage,
    archived: row.archived_at !== null,
    version: Number(row.version),
  };
}

/** The custom field `id` of a Phase 2 entity (`records`, `items`; a definition of another table is not this API's). */
async function readRow(db: Db, id: string): Promise<Row> {
  const row = await db.selectFrom('custom_field_defs').selectAll().where('id', '=', id).where('entity', 'in', ENTITIES).executeTakeFirst();
  if (row === undefined) throw masterNotFound(TABLE);
  return row;
}

/** True when a field of `entity` other than `exceptId` holds `key` (archived ones included). */
async function keyTaken(trx: Transaction<DB>, entity: string, key: string, exceptId?: string): Promise<boolean> {
  let q = trx.selectFrom('custom_field_defs').select('id').where('entity', '=', entity).where('code_key', '=', key);
  if (exceptId !== undefined) q = q.where('id', '!=', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/** The error of a code that cannot key a value in a body (`custom.<code>`), or null. */
function codeFormatError(code: string): FieldWarning | null {
  return code.includes('.') || code === '__proto__' ? { path: 'code', code: 'invalid_format' } : null;
}

/** The error of `options` for a field of `type`, or null. */
function optionsError(type: string, options: readonly CustomFieldOption[] | undefined): FieldWarning | null {
  const count = options?.length ?? 0;
  if (CHOICE_TYPES.has(type)) return count === 0 ? { path: 'options', code: 'required' } : null;
  return count > 0 ? { path: 'options', code: 'not_allowed' } : null;
}

const flag = (b: boolean): 0 | 1 => (b ? 1 : 0);

/** What the search index reads of a field (S20): whether its values are indexed, and the option labels it indexes. */
function indexed(row: { archived_at: number | null; is_public: number; is_searchable: number; type: string; options: string | null }): string | null {
  if (row.archived_at !== null || Number(row.is_public) !== 1 || Number(row.is_searchable) !== 1) return null;
  return CHOICE_TYPES.has(row.type) ? (row.options ?? '') : '';
}

/**
 * The records whose index the values of field `def` feed (its own records, or the records of its items), at most
 * {@link REINDEX_RECORD_IDS_MAX}; null when there are more.
 */
async function recordsWithValues(trx: Transaction<DB>, def: Row): Promise<string[] | null> {
  const limit = REINDEX_RECORD_IDS_MAX + 1;
  const ids =
    def.entity === 'items'
      ? (
          await trx
            .selectFrom('custom_values as v')
            .innerJoin('items as i', 'i.id', 'v.entity_id')
            .select('i.record_id as id')
            .distinct()
            .where('v.field_id', '=', def.id)
            .limit(limit)
            .execute()
        ).map((r) => r.id)
      : (await trx.selectFrom('custom_values').select('entity_id as id').where('field_id', '=', def.id).limit(limit).execute()).map((r) => r.id);
  return ids.length > REINDEX_RECORD_IDS_MAX ? null : ids;
}

/**
 * Queues the `catalog.reindex` a change of field `def` needs: of the records its values feed when there are at most
 * {@link REINDEX_RECORD_IDS_MAX}, else of everything (joined with one not started yet, superseding one that has: C24);
 * nothing when it holds no value.
 */
async function reindexValues(tx: TxCtx, def: Row, o: CustomFieldWriteOptions): Promise<void> {
  if (o.reindex === undefined) return;
  const ids = await recordsWithValues(tx.trx, def);
  if (ids !== null && ids.length === 0) return;
  const scope = ids === null ? { scope: 'all' as const } : { recordIds: ids };
  await enqueueReindex(tx.trx, o.reindex.registry, scope, { now: tx.now, keyring: o.reindex.keyring, createdBy: tx.actor.id, changed: true });
}

/**
 * The custom fields (at most 500) of `q.entity`, or of both entities, by `sort_order` then code, each with the number
 * of values it holds; archived ones only with `q.includeArchived`, and only those whose code or labels contain `q.q`
 * when it is given.
 */
export async function listCustomFields(db: Db, q: MasterListQuery): Promise<CustomFieldView[]> {
  let query = db.selectFrom('custom_field_defs').selectAll();
  query = q.entity === undefined ? query.where('entity', 'in', ENTITIES) : query.where('entity', '=', q.entity);
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  query = query.orderBy('sort_order').orderBy('code_key').orderBy('entity').orderBy('id');
  if (q.q === undefined || q.q === '') query = query.limit(MASTER_LIST_MAX);
  const rows = (await query.execute()).filter((r) => matchesQuery(q.q, [r.code_display, r.label, r.label_en])).slice(0, MASTER_LIST_MAX);
  const usage = await masterUsages(db, TABLE, rows.map((r) => r.id));
  return rows.map((r) => toView(r, usage.get(r.id) ?? 0));
}

// ---- Komunitas K2 (members) ----
/** A member's custom field is never public nor searchable (personal data): `{path, code: 'not_allowed_for_members'}`. */
function memberFlagErrors(entity: string, isPublic: boolean | undefined, isSearchable: boolean | undefined): FieldWarning[] {
  if (entity !== 'members') return [];
  const out: FieldWarning[] = [];
  if (isPublic === true) out.push({ path: 'isPublic', code: 'not_allowed_for_members' });
  if (isSearchable === true) out.push({ path: 'isSearchable', code: 'not_allowed_for_members' });
  return out;
}

/**
 * Creates a custom field of `body.entity` and audits `catalog.master.create` (`entity` custom_field_defs,
 * `meta.fields`).
 *
 * @throws DomainError VALIDATION_FAILED: a body the strict contract refuses (a choice field without options is
 *   `options` `required` there), options on another type (`not_allowed`), a code that is `invalid_format` or `taken`
 */
export async function createCustomField(tx: TxCtx, input: CustomFieldBody): Promise<CustomFieldView> {
  const body = parseBody(CustomFieldBody, input);
  const { trx } = tx;
  const key = codeKey(body.code);
  const errors = [codeFormatError(body.code), optionsError(body.type, body.options), ...memberFlagErrors(body.entity, body.isPublic, body.isSearchable)].filter(
    (e): e is FieldWarning => e !== null,
  );
  if (errors.every((e) => e.path !== 'code') && (await keyTaken(trx, body.entity, key))) errors.unshift({ path: 'code', code: 'taken' });
  if (errors.length > 0) throw validationFailed(errors);
  const id = newId();
  await takingCode(() =>
    trx
      .insertInto('custom_field_defs')
      .values({
        id,
        entity: body.entity,
        code_key: key,
        code_display: body.code,
        label: body.labelId,
        label_en: blankToNull(body.labelEn),
        type: body.type,
        options: optionsJson(body.options ?? null),
        is_required: flag(body.required),
        sort_order: body.sortOrder,
        is_public: flag(body.isPublic),
        is_searchable: flag(body.isSearchable),
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
 * Changes the fields `patch` sends, `version` + 1, and audits `catalog.master.update` once with the names of the
 * fields whose value changed (and `templatesUpdated` when a code rename rewrote material type templates). Queues the
 * reindex its change needs when `o.reindex` is given (see the top of this file).
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; VALIDATION_FAILED (the strict contract: `entity` and `type` are
 *   unrecognized keys; options emptied on a choice field `required`, given to another type `not_allowed`; a code
 *   `invalid_format` or `taken`)
 */
export async function updateCustomField(tx: TxCtx, id: string, input: CustomFieldPatchBody, o: CustomFieldWriteOptions = {}): Promise<CustomFieldView> {
  const patch = parseBody(CustomFieldPatchBody, input);
  const { trx } = tx;
  await lockMasterRow(trx, TABLE, id);
  const before = await readRow(trx, id);
  if (Number(before.version) !== patch.version) throw masterStale(TABLE);

  const errors: FieldWarning[] = [];
  const set: Updateable<DB['custom_field_defs']> = {};
  const oldKey = before.code_key;
  let newKey = oldKey;
  if (patch.code !== undefined) {
    newKey = codeKey(patch.code);
    const format = codeFormatError(patch.code);
    if (format !== null) errors.push(format);
    else if (newKey !== oldKey && (await keyTaken(trx, before.entity, newKey, id))) errors.push({ path: 'code', code: 'taken' });
    set.code_key = newKey;
    set.code_display = patch.code;
  }
  let nextOptions: string | null | undefined;
  if (patch.options !== undefined) {
    const error = optionsError(before.type, patch.options);
    if (error !== null) errors.push(error);
    nextOptions = optionsJson(patch.options);
    set.options = nextOptions;
  }
  errors.push(...memberFlagErrors(before.entity, patch.isPublic, patch.isSearchable));
  if (errors.length > 0) throw validationFailed(errors);
  const labelEn = patch.labelEn === undefined ? undefined : blankToNull(patch.labelEn);
  if (patch.labelId !== undefined) set.label = patch.labelId;
  if (labelEn !== undefined) set.label_en = labelEn;
  if (patch.required !== undefined) set.is_required = flag(patch.required);
  if (patch.sortOrder !== undefined) set.sort_order = patch.sortOrder;
  if (patch.isPublic !== undefined) set.is_public = flag(patch.isPublic);
  if (patch.isSearchable !== undefined) set.is_searchable = flag(patch.isSearchable);
  const fields = changedFields([
    ['code', patch.code, before.code_display],
    ['labelId', patch.labelId, before.label],
    ['labelEn', labelEn, before.label_en],
    ['options', nextOptions, before.options],
    ['required', patch.required, Number(before.is_required) === 1],
    ['sortOrder', patch.sortOrder, Number(before.sort_order)],
    ['isPublic', patch.isPublic, Number(before.is_public) === 1],
    ['isSearchable', patch.isSearchable, Number(before.is_searchable) === 1],
  ]);

  const updated = await takingCode(() =>
    trx
      .updateTable('custom_field_defs')
      .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .where('version', '=', patch.version)
      .executeTakeFirst(),
  );
  if (Number(updated.numUpdatedRows) !== 1) throw masterStale(TABLE);
  const after = await readRow(trx, id);
  const templatesUpdated = before.entity === 'records' && newKey !== oldKey ? await renameTemplateCustomField(tx, oldKey, after.code_display) : 0;
  if (indexed(before) !== indexed(after)) await reindexValues(tx, after, o);
  await tx.audit({
    action: 'catalog.master.update',
    entity: TABLE,
    entityId: id,
    meta: templatesUpdated === 0 ? { fields } : { fields, templatesUpdated },
  });
  return toView(after, await masterUsage(trx, TABLE, id));
}

/**
 * Archives a custom field (always allowed, §3.7; its values stay), `version` + 1, and audits `catalog.master.archive`
 * once; one already archived is answered as it is (`meta.alreadyArchived`). Queues the reindex when the field was
 * indexed and `o.reindex` is given.
 *
 * @returns the field's version after the call
 * @throws DomainError NOT_FOUND; CONFLICT_STALE
 */
export async function archiveCustomField(tx: TxCtx, id: string, version: number, o: CustomFieldWriteOptions = {}): Promise<{ version: number }> {
  const { trx } = tx;
  await lockMasterRow(trx, TABLE, id);
  const before = await readRow(trx, id);
  if (Number(before.version) !== version) throw masterStale(TABLE);
  if (before.archived_at !== null) {
    await tx.audit({ action: 'catalog.master.archive', entity: TABLE, entityId: id, meta: { alreadyArchived: true } });
    return { version };
  }
  const updated = await trx
    .updateTable('custom_field_defs')
    .set((eb) => ({ archived_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw masterStale(TABLE);
  if (indexed(before) !== null) await reindexValues(tx, before, o);
  await tx.audit({ action: 'catalog.master.archive', entity: TABLE, entityId: id, meta: {} });
  return { version: version + 1 };
}
