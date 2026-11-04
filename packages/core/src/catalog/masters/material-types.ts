import { fullTextFamily, type DB } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import {
  MaterialTypeBody,
  MaterialTypePatchBody,
  MaterialTypeTemplate,
  type MasterListQuery,
  type MaterialTypeView,
} from '@altis/shared/api/catalog/masters';
import type { Selectable, Transaction, Updateable } from 'kysely';
import type { TxCtx } from '../../context.js';
import { codeKey } from '../data/keys.js';
import { archiveMaster, masterUsage, masterUsages } from './in-use.js';
import {
  MASTER_LIST_MAX,
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

// Material types (Phase 2 spec §2.2, §2.6, §3.8): the kind of a record (BUKU, PETA, …) with its MARC leader codes,
// RDA 336/337/338 defaults, schema.org and DCMI types, and the template the record editor and the records service
// follow (`template`, JSON of {@link MaterialTypeTemplate}: field states, the defaults of a new record, the custom
// fields shown).
//
// - A template's references are checked: each `customFields` code must name a custom field of `records` (by its key,
//   as the records service matches them; `not_found`, the same key twice `duplicate`), and `defaults` a collection
//   type and a language that exist (`not_found`). A reference to an archived one is `archived`, unless the stored
//   template already names it: archiving a custom field or a collection type never blocks editing the types that
//   still name it (§3.7: an archived code is ignored where it is shown).
// - A material type that live records use cannot be archived (CATALOG_IN_USE, Review Focus 2).

const TABLE = 'material_types';

type Row = Selectable<DB['material_types']>;

/** The stored template parsed with the strict §3.8 schema; the empty template when it cannot be read. */
function parseTemplate(json: string | null): MaterialTypeTemplate {
  if (json !== null) {
    try {
      const parsed = MaterialTypeTemplate.safeParse(JSON.parse(json));
      if (parsed.success) return parsed.data;
    } catch {
      // Unreadable JSON: the empty template below.
    }
  }
  return { fields: {}, defaults: {}, customFields: [] };
}

/** The JSON text a template is stored as (the strict schema's own field order). */
function templateJson(template: MaterialTypeTemplate): string {
  return JSON.stringify(MaterialTypeTemplate.parse(template));
}

function toView(row: Row, usage: number): MaterialTypeView {
  return {
    id: row.id,
    code: row.code_display,
    nameId: row.name_id,
    nameEn: row.name_en,
    marcType: row.marc_type,
    marcLevel: row.marc_level,
    contentType: row.content_type,
    mediaType: row.media_type,
    carrierType: row.carrier_type,
    schemaType: row.schema_type,
    dcmiType: row.dcmi_type,
    template: parseTemplate(row.template),
    sortOrder: Number(row.sort_order),
    usage,
    archived: row.archived_at !== null,
    version: Number(row.version),
  };
}

async function readRow(db: Db, id: string): Promise<Row> {
  const row = await db.selectFrom('material_types').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw masterNotFound(TABLE);
  return row;
}

/** True when a material type other than `exceptId` holds `key` (archived ones included). */
async function keyTaken(trx: Transaction<DB>, key: string, exceptId?: string): Promise<boolean> {
  let q = trx.selectFrom('material_types').select('id').where('code_key', '=', key);
  if (exceptId !== undefined) q = q.where('id', '!=', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/** The error of a template default naming `id` of `table`: none for a live row, or one `stored` names already. */
async function defaultError(
  trx: Transaction<DB>,
  table: 'collection_types' | 'languages',
  id: string | undefined,
  stored: string | undefined,
  path: string,
): Promise<FieldWarning | null> {
  if (id === undefined) return null;
  // Both tables have `id` and `archived_at`; Kysely cannot narrow a union of table names.
  const row = await trx.selectFrom(table as 'languages').select('archived_at').where('id', '=', id).executeTakeFirst();
  if (row === undefined) return { path, code: 'not_found' };
  if (row.archived_at !== null && id !== stored) return { path, code: 'archived' };
  return null;
}

/**
 * The field errors of `template`'s references (see the top of this file), defaults first, then the custom fields in
 * their order; `stored` is the type's template before the change (null on create).
 */
async function templateErrors(trx: Transaction<DB>, template: MaterialTypeTemplate, stored: MaterialTypeTemplate | null): Promise<FieldWarning[]> {
  const errors: FieldWarning[] = [];
  const ct = await defaultError(trx, 'collection_types', template.defaults.collectionTypeId, stored?.defaults.collectionTypeId, 'template.defaults.collectionTypeId');
  if (ct !== null) errors.push(ct);
  const lang = await defaultError(trx, 'languages', template.defaults.languageId, stored?.defaults.languageId, 'template.defaults.languageId');
  if (lang !== null) errors.push(lang);

  if (template.customFields.length > 0) {
    const defs = await trx.selectFrom('custom_field_defs').select(['code_key', 'archived_at']).where('entity', '=', 'records').execute();
    const archivedByKey = new Map(defs.map((d) => [d.code_key, d.archived_at !== null]));
    const storedKeys = new Set((stored?.customFields ?? []).map((c) => normalizeKey(c)));
    const seen = new Set<string>();
    template.customFields.forEach((code, i) => {
      const key = codeKey(code);
      const path = `template.customFields.${i}`;
      if (seen.has(key)) errors.push({ path, code: 'duplicate' });
      else if (!archivedByKey.has(key)) errors.push({ path, code: 'not_found' });
      else if (archivedByKey.get(key) === true && !storedKeys.has(key)) errors.push({ path, code: 'archived' });
      seen.add(key);
    });
  }
  return errors;
}

/**
 * The material types by `sort_order` then code (at most 500; the 8 seeded ones in seed order), each with the number of
 * live records of the type; archived ones only with `q.includeArchived`, and only those whose code or names contain
 * `q.q` when it is given.
 */
export async function listMaterialTypes(db: Db, q: MasterListQuery): Promise<MaterialTypeView[]> {
  let query = db.selectFrom('material_types').selectAll();
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  query = query.orderBy('sort_order').orderBy('code_key').orderBy('id');
  if (q.q === undefined || q.q === '') query = query.limit(MASTER_LIST_MAX);
  const rows = (await query.execute()).filter((r) => matchesQuery(q.q, [r.code_display, r.name_id, r.name_en])).slice(0, MASTER_LIST_MAX);
  const usage = await masterUsages(db, TABLE, rows.map((r) => r.id));
  return rows.map((r) => toView(r, usage.get(r.id) ?? 0));
}

/**
 * Creates a material type with its template and audits `catalog.master.create` (`entity` material_types,
 * `meta.fields`).
 *
 * @throws DomainError VALIDATION_FAILED: a body the strict contract refuses, `{path: 'code', code: 'taken'}`, or a
 *   template reference that is not there (`template.customFields.<i>`, `template.defaults.*`)
 */
export async function createMaterialType(tx: TxCtx, input: MaterialTypeBody): Promise<MaterialTypeView> {
  const body = parseBody(MaterialTypeBody, input);
  const { trx } = tx;
  const key = codeKey(body.code);
  const errors: FieldWarning[] = (await keyTaken(trx, key)) ? [{ path: 'code', code: 'taken' }] : [];
  errors.push(...(await templateErrors(trx, body.template, null)));
  if (errors.length > 0) throw validationFailed(errors);
  const id = newId();
  await takingCode(() =>
    trx
      .insertInto('material_types')
      .values({
        id,
        code_display: body.code,
        code_key: key,
        name_id: body.nameId,
        name_en: body.nameEn,
        marc_type: body.marcType,
        marc_level: body.marcLevel,
        content_type: body.contentType,
        media_type: body.mediaType,
        carrier_type: body.carrierType,
        schema_type: body.schemaType,
        dcmi_type: body.dcmiType,
        template: templateJson(body.template),
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
 * Changes the fields `patch` sends (a template replaces the whole template), `version` + 1, and audits
 * `catalog.master.update` with the names of the fields whose value changed.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; VALIDATION_FAILED (the contract, a taken code, a template reference)
 */
export async function updateMaterialType(tx: TxCtx, id: string, input: MaterialTypePatchBody): Promise<MaterialTypeView> {
  const patch = parseBody(MaterialTypePatchBody, input);
  const { trx } = tx;
  await lockMasterRow(trx, TABLE, id);
  const before = await readRow(trx, id);
  if (Number(before.version) !== patch.version) throw masterStale(TABLE);

  const set: Updateable<DB['material_types']> = {};
  const errors: FieldWarning[] = [];
  if (patch.code !== undefined) {
    const key = codeKey(patch.code);
    if (key !== before.code_key && (await keyTaken(trx, key, id))) errors.push({ path: 'code', code: 'taken' });
    set.code_key = key;
    set.code_display = patch.code;
  }
  const storedTemplate = parseTemplate(before.template);
  let nextTemplate: string | undefined;
  if (patch.template !== undefined) {
    errors.push(...(await templateErrors(trx, patch.template, storedTemplate)));
    nextTemplate = templateJson(patch.template);
    set.template = nextTemplate;
  }
  if (errors.length > 0) throw validationFailed(errors);
  if (patch.nameId !== undefined) set.name_id = patch.nameId;
  if (patch.nameEn !== undefined) set.name_en = patch.nameEn;
  if (patch.marcType !== undefined) set.marc_type = patch.marcType;
  if (patch.marcLevel !== undefined) set.marc_level = patch.marcLevel;
  if (patch.contentType !== undefined) set.content_type = patch.contentType;
  if (patch.mediaType !== undefined) set.media_type = patch.mediaType;
  if (patch.carrierType !== undefined) set.carrier_type = patch.carrierType;
  if (patch.schemaType !== undefined) set.schema_type = patch.schemaType;
  if (patch.dcmiType !== undefined) set.dcmi_type = patch.dcmiType;
  if (patch.sortOrder !== undefined) set.sort_order = patch.sortOrder;
  const fields = changedFields([
    ['code', patch.code, before.code_display],
    ['nameId', patch.nameId, before.name_id],
    ['nameEn', patch.nameEn, before.name_en],
    ['marcType', patch.marcType, before.marc_type],
    ['marcLevel', patch.marcLevel, before.marc_level],
    ['contentType', patch.contentType, before.content_type],
    ['mediaType', patch.mediaType, before.media_type],
    ['carrierType', patch.carrierType, before.carrier_type],
    ['schemaType', patch.schemaType, before.schema_type],
    ['dcmiType', patch.dcmiType, before.dcmi_type],
    ['template', nextTemplate, templateJson(storedTemplate)],
    ['sortOrder', patch.sortOrder, Number(before.sort_order)],
  ]);

  const updated = await takingCode(() =>
    trx
      .updateTable('material_types')
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
 * Archives a material type that no live record has; see {@link archiveMaster}.
 *
 * @returns the type's version after the call
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; CATALOG_IN_USE with `meta.count` (the live records)
 */
export function archiveMaterialType(tx: TxCtx, id: string, version: number): Promise<{ version: number }> {
  return archiveMaster(tx, TABLE, id, version);
}

/**
 * Rewrites the templates of the material types that name the custom field code key `fromKey` so that they name
 * `toCode` instead (a records custom field's code was renamed), each `version` + 1. Answers how many changed.
 */
export async function renameTemplateCustomField(tx: TxCtx, fromKey: string, toCode: string): Promise<number> {
  const { trx } = tx;
  // Every row is locked first (a write that changes nothing; the table is small), so a concurrent edit of a type
  // either finishes first or finds its version stale. The templates are then read as they are on the latest commit:
  // the caller (updateCustomField) has read before, so on MySQL/MariaDB (REPEATABLE READ) a plain SELECT would read
  // its older snapshot, which a lock that changes nothing does not refresh, and write a template saved meanwhile back
  // as it was; a locking read (FOR UPDATE) reads the latest commit there. PostgreSQL (READ COMMITTED) reads it with
  // every statement, and SQLite serializes the writers.
  await trx
    .updateTable('material_types')
    .set((eb) => ({ version: eb.ref('version') }))
    .execute();
  const query = trx.selectFrom('material_types').select(['id', 'template']).orderBy('id');
  const rows = await (fullTextFamily(trx) === 'innodb' ? query.forUpdate() : query).execute();
  let changed = 0;
  for (const row of rows) {
    const template = parseTemplate(row.template);
    if (!template.customFields.some((c) => normalizeKey(c) === fromKey)) continue;
    const next = { ...template, customFields: template.customFields.map((c) => (normalizeKey(c) === fromKey ? toCode : c)) };
    await trx
      .updateTable('material_types')
      .set((eb) => ({ template: templateJson(next), updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', row.id)
      .execute();
    changed += 1;
  }
  return changed;
}
