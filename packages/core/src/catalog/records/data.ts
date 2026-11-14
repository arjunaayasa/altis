import type { DB } from '@altis/db';
import { AUDIENCES, LOCAL_WORKS, LOCAL_WORK_KINDS, REFERENCE_KINDS } from '@altis/shared';
import type { AttachmentAccess, AttachmentKind, IdentifierType, ItemStatus, RelationType, RelatorRole } from '@altis/shared';
import { isHttpUrl } from '@altis/shared/api/catalog/common';
import type { RecordData } from '@altis/shared/api/catalog/record-data';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { CatalogAgentType, CatalogSubjectType } from '../data/authorities.js';
import { loadCustomDefs, readCustomValues } from '../data/custom-fields.js';

// The denormalised record (Phase 2 spec §2.2; plan Task 16, B3): what the renderers, the exporters, the OPAC detail
// and OAI-PMH read, loaded for many records at once in batches of 500 ids (every list a few statements per batch, never
// one per record).
//
// - Every record found is answered, whatever its state (`archived`, `mergedInto`, `opacVisible` say it): the OPAC
//   answers a merged one with a 301 and a hidden one with 404, an export filters by state itself.
// - Never included: acquisition data (price, currency, supplier, order and invoice numbers and dates, acquisition
//   source) and the items' notes.
// - `publicOnly` (the OPAC, OAI, the public MARC): only `public` attachments; no item that is `withdrawn`, `lost` or
//   archived; relations only to records that are visible and not archived; no `custom` (staff values), only
//   `customPublic`. A staff load has every attachment that is not archived, every item, every relation and `custom`.
// - Archived attachments are never part of it (an archived attachment is deleted for the librarian).
// - `links` are the URL attachments of the load that pass the http(s) check again (S4), as `{url, title}`.
// - Each item carries its branch's code and its location's code (`locationCode`, B3: 852 `$c`), its collection type's
//   code, and whether it is loanable and self-service (§2.5).
// - The accreditation fields (`audience`, `localWork`, `localWorkKind`, `referenceKind`) are on every load, null when
//   not stated; nothing in them is personal.

const ID_BATCH = 500;

type Db = Kysely<DB> | Transaction<DB>;
type RecordRow = Selectable<DB['records']>;

/** The record row and what the detail needs of it besides the {@link RecordData} (internal to the records area). */
export interface LoadedRecord {
  row: RecordRow;
  data: RecordData;
}

/** `v` when it is not null, else undefined: the draft-shaped optional fields of {@link RecordData}. */
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

/**
 * A stored accreditation field: its code when it is one of `values`, else null (a value this version does not know is
 * never handed on, so an export never writes what an import would refuse).
 */
function codeOrNull<T extends string>(values: readonly T[], v: string | null): T | null {
  return v !== null && (values as readonly string[]).includes(v) ? (v as T) : null;
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list === undefined) out.set(k, [r]);
    else list.push(r);
  }
  return out;
}

/** Runs `read` over `ids` in batches and joins the rows. */
async function inBatches<T>(ids: readonly string[], read: (batch: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) out.push(...(await read(ids.slice(i, i + ID_BATCH))));
  return out;
}

/** One batch of records (≤ {@link ID_BATCH} ids) loaded. */
async function loadBatch(
  db: Db,
  ids: string[],
  o: { publicOnly: boolean; includeItems: boolean },
  publicDefs: readonly { code: string; labelId: string; labelEn: string | null }[],
): Promise<LoadedRecord[]> {
  const rows = await db.selectFrom('records').selectAll().where('id', 'in', ids).execute();
  if (rows.length === 0) return [];
  const found = rows.map((r) => r.id);

  const typeIds = [...new Set(rows.map((r) => r.material_type_id))];
  const types = new Map(
    (
      await db
        .selectFrom('material_types')
        .select(['id', 'code_display', 'name_id', 'name_en', 'marc_type', 'marc_level', 'schema_type', 'dcmi_type'])
        .where('id', 'in', typeIds)
        .execute()
    ).map((t) => [t.id, t]),
  );
  const languageIds = [...new Set(rows.flatMap((r) => (r.language_id === null ? [] : [r.language_id])))];
  const languages = new Map(
    languageIds.length === 0
      ? []
      : (await db.selectFrom('languages').select(['id', 'code_display', 'name_id', 'name_en']).where('id', 'in', languageIds).execute()).map((l) => [l.id, l]),
  );
  const publisherIds = [...new Set(rows.flatMap((r) => (r.publisher_id === null ? [] : [r.publisher_id])))];
  const publishers = new Map(
    publisherIds.length === 0
      ? []
      : (await db.selectFrom('publishers').select(['id', 'name_display', 'place']).where('id', 'in', publisherIds).execute()).map((p) => [p.id, p]),
  );

  const identifiers = groupBy(
    await db
      .selectFrom('record_identifiers')
      .select(['record_id', 'type', 'value_display', 'qualifier'])
      .where('record_id', 'in', found)
      .orderBy('record_id')
      .orderBy('sort_order')
      .orderBy('id')
      .execute(),
    (r) => r.record_id,
  );
  const agents = groupBy(
    await db
      .selectFrom('record_agents as ra')
      .innerJoin('agents as a', 'a.id', 'ra.agent_id')
      .select(['ra.record_id', 'a.id', 'a.type', 'a.name_display', 'a.dates', 'a.authority_source', 'ra.role', 'ra.is_main'])
      .where('ra.record_id', 'in', found)
      .orderBy('ra.record_id')
      .orderBy('ra.sort_order')
      .orderBy('ra.agent_id')
      .execute(),
    (r) => r.record_id,
  );
  const subjects = groupBy(
    await db
      .selectFrom('record_subjects as rs')
      .innerJoin('subjects as s', 's.id', 'rs.subject_id')
      .select(['rs.record_id', 's.id', 's.type', 's.term_display', 's.classification', 's.authority_source', 'rs.is_primary'])
      .where('rs.record_id', 'in', found)
      .orderBy('rs.record_id')
      .orderBy('rs.sort_order')
      .orderBy('rs.subject_id')
      .execute(),
    (r) => r.record_id,
  );
  let attachmentQuery = db
    .selectFrom('attachments as at')
    .leftJoin('files as f', 'f.id', 'at.file_id')
    .select(['at.record_id', 'at.id', 'at.kind', 'at.file_id', 'at.url', 'at.title', 'at.access', 'f.mime'])
    .where('at.record_id', 'in', found)
    .where('at.archived_at', 'is', null);
  if (o.publicOnly) attachmentQuery = attachmentQuery.where('at.access', '=', 'public');
  const attachments = groupBy(await attachmentQuery.orderBy('at.record_id').orderBy('at.sort_order').orderBy('at.id').execute(), (r) => r.record_id);
  const marcExtra = groupBy(
    await db
      .selectFrom('record_marc_extra')
      .select(['record_id', 'tag', 'ind1', 'ind2', 'data'])
      .where('record_id', 'in', found)
      .orderBy('record_id')
      .orderBy('sort_order')
      .orderBy('id')
      .execute(),
    (r) => r.record_id,
  );

  // Relations both ways, with the other record's title (and, for a public load, only visible and live ones).
  const outRows = await db
    .selectFrom('record_relations')
    .select(['record_id', 'related_id', 'type'])
    .where('record_id', 'in', found)
    .orderBy('record_id')
    .orderBy('type')
    .orderBy('related_id')
    .execute();
  const inRows = await db
    .selectFrom('record_relations')
    .select(['record_id', 'related_id', 'type'])
    .where('related_id', 'in', found)
    .orderBy('related_id')
    .orderBy('type')
    .orderBy('record_id')
    .execute();
  const others = [...new Set([...outRows.map((r) => r.related_id), ...inRows.map((r) => r.record_id)])];
  const otherRecords = new Map(
    (
      await inBatches(others, (batch) =>
        db.selectFrom('records').select(['id', 'title', 'opac_visible', 'archived_at']).where('id', 'in', batch).execute(),
      )
    ).map((r) => [r.id, r]),
  );
  const shown = (id: string): boolean => {
    const r = otherRecords.get(id);
    return r !== undefined && (!o.publicOnly || (Number(r.opac_visible) === 1 && r.archived_at === null));
  };
  const relations = new Map<string, RecordData['relations']>();
  const addRelation = (recordId: string, rel: RecordData['relations'][number]): void => {
    const list = relations.get(recordId);
    if (list === undefined) relations.set(recordId, [rel]);
    else list.push(rel);
  };
  for (const r of outRows) {
    if (shown(r.related_id)) addRelation(r.record_id, { type: r.type as RelationType, direction: 'out', recordId: r.related_id, title: otherRecords.get(r.related_id)!.title });
  }
  for (const r of inRows) {
    if (shown(r.record_id)) addRelation(r.related_id, { type: r.type as RelationType, direction: 'in', recordId: r.record_id, title: otherRecords.get(r.record_id)!.title });
  }

  let items = new Map<string, RecordData['items']>();
  if (o.includeItems) {
    let itemQuery = db
      .selectFrom('items as i')
      .innerJoin('branches as b', 'b.id', 'i.branch_id')
      .innerJoin('collection_types as ct', 'ct.id', 'i.collection_type_id')
      .leftJoin('locations as l', 'l.id', 'i.location_id')
      .select([
        'i.record_id',
        'i.id',
        'i.barcode_display',
        'i.branch_id',
        'b.code_display as branch_code',
        'i.location_id',
        'l.code_display as location_code',
        'i.call_number',
        'i.status',
        'ct.code_display as collection_type_code',
        'ct.loanable',
        'ct.self_service',
      ])
      .where('i.record_id', 'in', found);
    if (o.publicOnly) itemQuery = itemQuery.where('i.archived_at', 'is', null).where('i.status', 'not in', ['withdrawn', 'lost']);
    const itemRows = await itemQuery.orderBy('i.record_id').orderBy('b.code_key').orderBy('i.barcode_key').execute();
    items = new Map(
      [...groupBy(itemRows, (r) => r.record_id)].map(([recordId, list]) => [
        recordId,
        list.map((r) => {
          const loanable = r.status === 'available' && Number(r.loanable) === 1;
          return {
            id: r.id,
            barcode: r.barcode_display,
            branchId: r.branch_id,
            branchCode: r.branch_code,
            locationId: r.location_id,
            locationCode: r.location_code ?? null,
            callNumber: r.call_number,
            status: r.status as ItemStatus,
            collectionTypeCode: r.collection_type_code,
            loanable,
            selfService: loanable && Number(r.self_service) === 1,
          };
        }),
      ]),
    );
  }

  const custom = await readCustomValues(db, 'records', found);

  return rows.map((row) => {
    const type = types.get(row.material_type_id);
    const language = row.language_id === null ? undefined : languages.get(row.language_id);
    const publisher = row.publisher_id === null ? undefined : publishers.get(row.publisher_id);
    const attachmentList = (attachments.get(row.id) ?? []).map((a) => ({
      id: a.id,
      kind: a.kind as AttachmentKind,
      fileId: a.file_id,
      url: a.url,
      title: a.title,
      access: a.access as AttachmentAccess,
      mime: a.kind === 'file' ? (a.mime ?? null) : null,
    }));
    const values = custom.get(row.id) ?? {};
    const data: RecordData = {
      id: row.id,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      changedAt: Number(row.changed_at),
      opacVisible: Number(row.opac_visible) === 1,
      promoted: Number(row.promoted) === 1,
      archived: row.archived_at !== null,
      mergedInto: row.merged_into,
      materialTypeCode: type?.code_display ?? null,
      materialType: {
        id: row.material_type_id,
        code: type?.code_display ?? '',
        nameId: type?.name_id ?? '',
        nameEn: type?.name_en ?? '',
        marcType: type?.marc_type ?? 'a',
        marcLevel: type?.marc_level ?? 'm',
        schemaType: type?.schema_type ?? 'Book',
        dcmiType: type?.dcmi_type ?? 'Text',
      },
      title: row.title,
      subtitle: opt(row.subtitle),
      responsibility: opt(row.responsibility),
      edition: opt(row.edition),
      materialDetail: opt(row.material_detail),
      publisher: publisher === undefined ? null : { id: publisher.id, name: publisher.name_display, ...(publisher.place === null ? {} : { place: publisher.place }) },
      publicationPlace: opt(row.publication_place),
      publicationYear: opt(row.publication_year),
      publicationDateText: opt(row.publication_date_text),
      physicalDesc: opt(row.physical_desc),
      series: opt(row.series),
      classification: opt(row.classification),
      callNumber: opt(row.call_number),
      languageCode: language?.code_display,
      language: language === undefined ? null : { code: language.code_display, nameId: language.name_id, nameEn: language.name_en },
      contentType: opt(row.content_type),
      mediaType: opt(row.media_type),
      carrierType: opt(row.carrier_type),
      summary: opt(row.summary),
      notes: opt(row.notes),
      identifiers: (identifiers.get(row.id) ?? []).map((i) => ({ type: i.type as IdentifierType, value: i.value_display, ...(i.qualifier === null ? {} : { qualifier: i.qualifier }) })),
      agents: (agents.get(row.id) ?? []).map((a) => ({
        id: a.id,
        type: a.type as CatalogAgentType,
        name: a.name_display,
        ...(a.dates === null ? {} : { dates: a.dates }),
        role: a.role as RelatorRole,
        isMain: Number(a.is_main) === 1,
        ...(a.authority_source === null ? {} : { authoritySource: a.authority_source }),
      })),
      subjects: (subjects.get(row.id) ?? []).map((s) => ({
        id: s.id,
        type: s.type as CatalogSubjectType,
        term: s.term_display,
        ...(s.classification === null ? {} : { classification: s.classification }),
        ...(s.authority_source === null ? {} : { authoritySource: s.authority_source }),
        isPrimary: Number(s.is_primary) === 1,
      })),
      links: attachmentList.flatMap((a) => (a.kind === 'url' && a.url !== null && isHttpUrl(a.url) ? [{ url: a.url, title: a.title }] : [])),
      items: items.get(row.id) ?? [],
      marcExtra: (marcExtra.get(row.id) ?? []).map((f) => ({ tag: f.tag, ind1: f.ind1, ind2: f.ind2, data: f.data })),
      coverFileId: row.cover_file_id,
      attachments: attachmentList,
      relations: relations.get(row.id) ?? [],
      // In the definitions' order (sort order, then code).
      customPublic: publicDefs.flatMap((d) => (Object.hasOwn(values, d.code) ? [{ code: d.code, labelId: d.labelId, labelEn: d.labelEn, value: values[d.code] }] : [])),
      ...(o.publicOnly ? {} : { custom: values }),
      // ---- Komunitas K1 (catalogue accreditation fields): null when not stated ----
      audience: codeOrNull(AUDIENCES, row.audience),
      localWork: codeOrNull(LOCAL_WORKS, row.local_work),
      localWorkKind: codeOrNull(LOCAL_WORK_KINDS, row.local_work_kind),
      referenceKind: codeOrNull(REFERENCE_KINDS, row.reference_kind),
    };
    return { row, data };
  });
}

/** The records of `ids` loaded with their rows (the detail's read); ids that name no record are absent. */
export async function loadRecords(db: Db, ids: readonly string[], o: { publicOnly: boolean; includeItems: boolean }): Promise<Map<string, LoadedRecord>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, LoadedRecord>();
  if (unique.length === 0) return out;
  const defs = await loadCustomDefs(db, 'records');
  const publicDefs = defs.filter((d) => d.isPublic).map((d) => ({ code: d.code, labelId: d.labelId, labelEn: d.labelEn }));
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    for (const loaded of await loadBatch(db, unique.slice(i, i + ID_BATCH), o, publicDefs)) out.set(loaded.row.id, loaded);
  }
  return out;
}

/**
 * The records of `ids` as {@link RecordData}, keyed by id (see the top of this file); an id that names no record is
 * absent. Loads in batches of 500 ids.
 */
export async function loadRecordData(db: Db, ids: readonly string[], o: { publicOnly: boolean; includeItems: boolean }): Promise<Map<string, RecordData>> {
  const loaded = await loadRecords(db, ids, o);
  return new Map([...loaded].map(([id, l]) => [id, l.data]));
}
