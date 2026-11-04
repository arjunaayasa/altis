import { XmlWriter, loadRecordData, recordToMarc, recordUrlPath, toOaiDc, writeMarcXmlRecord } from '@altis/core';
import type { DbHandle } from '@altis/db';
import type { RecordData } from '@altis/shared/api/catalog/record-data';
import { absoluteUrl } from '../urls.js';
import { MATERIAL_SET, materialSetSpec, oaiDatestamp, type OaiPrefix } from './protocol.js';

// What OAI-PMH reads of the catalogue (Phase 2 spec §10; Task 35): record headers by keyset over `records.id`, the
// counts and the earliest change, the material sets, and each record's metadata in `oai_dc` or `marc21`.
//
// - Every record is an item of the repository, live or not: records are never deleted, only archived, hidden or
//   merged, and such a record is a header with `status="deleted"` for good (`deletedRecord persistent`).
// - The datestamp is `changed_at`, the last change of the record's public representation.
// - Pages are a keyset over `id` (`id > after ORDER BY id`): an edit during a harvest moves `changed_at`, never a
//   record's place in the list, so no record is sent twice or skipped (§10).
// - Metadata is the public load of `loadRecordData` (Task 16: public attachments only, no withdrawn item, no staff
//   value, never acquisition data); `marc21` is `recordToMarc` for the public audience without items (S5: no 541,
//   561, 583, 59X, 852, 876-878, 9XX).

/** The Kysely instance of a DbHandle (apps/server reaches Kysely only through @altis/db). */
type Db = DbHandle['db'];

/** A record as a header shows it. */
export interface OaiItem {
  id: string;
  changedAt: number;
  materialTypeId: string;
  /** Archived, hidden from the OPAC, or merged into another record. */
  deleted: boolean;
}

/** The selection of a list request: `changed_at` in [from, until), one material type or all. */
export interface OaiSelection {
  from: number | null;
  until: number | null;
  materialTypeId: string | null;
}

/** A material set: the type's id, its setSpec and its name; archived types still answer their set. */
export interface OaiMaterialSet {
  id: string;
  spec: string;
  name: string;
  archived: boolean;
}

interface HeaderRow {
  id: string;
  changed_at: number | string | bigint;
  material_type_id: string;
  archived_at: number | string | bigint | null;
  opac_visible: number | string;
  merged_into: string | null;
}

function itemOf(r: HeaderRow): OaiItem {
  return {
    id: r.id,
    changedAt: Number(r.changed_at),
    materialTypeId: r.material_type_id,
    deleted: r.archived_at !== null || Number(r.opac_visible) !== 1 || r.merged_into !== null,
  };
}

function selected(db: Db, s: OaiSelection) {
  let q = db.selectFrom('records');
  if (s.from !== null) q = q.where('changed_at', '>=', s.from);
  if (s.until !== null) q = q.where('changed_at', '<', s.until);
  if (s.materialTypeId !== null) q = q.where('material_type_id', '=', s.materialTypeId);
  return q;
}

const HEADER_COLUMNS = ['id', 'changed_at', 'material_type_id', 'archived_at', 'opac_visible', 'merged_into'] as const;

/** The record `id` as an item, or null when there is none. */
export async function oaiItem(db: Db, id: string): Promise<OaiItem | null> {
  const row = await db.selectFrom('records').select(HEADER_COLUMNS).where('id', '=', id).executeTakeFirst();
  return row === undefined ? null : itemOf(row);
}

/** At most `limit` items of `s` after the id `after` (from the start when null), by id. */
export async function oaiPage(db: Db, s: OaiSelection, after: string | null, limit: number): Promise<OaiItem[]> {
  let q = selected(db, s).select(HEADER_COLUMNS);
  if (after !== null) q = q.where('id', '>', after);
  return (await q.orderBy('id').limit(limit).execute()).map(itemOf);
}

/** How many items `s` holds (completeListSize, counted on a list's first page). */
export async function oaiCount(db: Db, s: OaiSelection): Promise<number> {
  const row = await selected(db, s)
    .select((eb) => eb.fn.countAll().as('n'))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** The earliest `changed_at` of any record, or null when the catalogue is empty. */
export async function earliestChange(db: Db): Promise<number | null> {
  const row = await db
    .selectFrom('records')
    .select((eb) => eb.fn.min('changed_at').as('m'))
    .executeTakeFirst();
  return row?.m === null || row?.m === undefined ? null : Number(row.m);
}

/** Every material type as a set, in the catalogue's order (archived ones too, flagged). */
export async function materialSets(db: Db): Promise<OaiMaterialSet[]> {
  const rows = await db
    .selectFrom('material_types')
    .select(['id', 'code_key', 'name_en', 'archived_at'])
    .orderBy('sort_order')
    .orderBy('code_key')
    .execute();
  return rows.map((r) => ({ id: r.id, spec: materialSetSpec(r.code_key), name: r.name_en, archived: r.archived_at !== null }));
}

/** What a header and a record's metadata are written with. */
export interface OaiRenderOptions {
  baseUrl: string;
  /** The host of `oai:<host>:<id>`. */
  host: string;
  /** setSpec by material type id. */
  sets: ReadonlyMap<string, string>;
  /** `catalog.marcOrgCode` (null: no 003, P2-32). */
  orgCode: string | null;
}

/** `oai:<host>:<record id>` (§10). */
export function oaiIdentifier(host: string, recordId: string): string {
  return `oai:${host}:${recordId}`;
}

/** The `<header>` of `item`: identifier, datestamp, its sets; `status="deleted"` for a deleted record. */
export function writeHeader(w: XmlWriter, item: OaiItem, o: OaiRenderOptions): void {
  w.open('header', item.deleted ? { status: 'deleted' } : undefined);
  w.leaf('identifier', oaiIdentifier(o.host, item.id));
  w.leaf('datestamp', oaiDatestamp(item.changedAt));
  w.leaf('setSpec', MATERIAL_SET);
  const spec = o.sets.get(item.materialTypeId);
  if (spec !== undefined) w.leaf('setSpec', spec);
  w.close();
}

/** The metadata element of `d` in `prefix` (trusted XML from our own writers, without an XML declaration). */
function metadataXml(d: RecordData, prefix: OaiPrefix, o: OaiRenderOptions): string {
  if (prefix === 'oai_dc') {
    const canonicalUrl = absoluteUrl(o.baseUrl, recordUrlPath(d.id, d.title));
    return toOaiDc(d, { baseUrl: o.baseUrl, canonicalUrl, locale: 'id', coverUrl: null });
  }
  return writeMarcXmlRecord(recordToMarc(d, { audience: 'public', orgCode: o.orgCode, baseUrl: o.baseUrl, includeItems: false }));
}

/** The most XML one ListRecords page carries (UTF-8 bytes); a single larger record still goes out alone. */
export const OAI_PAGE_BYTES = 8 * 1024 * 1024;

/** Records loaded at a time, so that a page of very large records (imported MARC) never sits in memory at once. */
const LOAD_BATCH = 25;

/** One `<record>`: the header, and for a live record its metadata (`d`: the record as loaded, if it was). */
function recordXml(item: OaiItem, d: RecordData | undefined, prefix: OaiPrefix, o: OaiRenderOptions): string {
  // A record is written as loaded (its state and datestamp), so a header and its metadata always agree.
  const shown: OaiItem =
    d === undefined
      ? { ...item, deleted: true }
      : { id: item.id, changedAt: d.changedAt, materialTypeId: d.materialType.id, deleted: d.archived || !d.opacVisible || d.mergedInto !== null };
  const w = new XmlWriter().open('record');
  writeHeader(w, shown, o);
  if (!shown.deleted && d !== undefined) w.open('metadata').raw(metadataXml(d, prefix, o)).close();
  return w.close().toString();
}

/**
 * The `<record>`s of the first items of `items` in `prefix`, in order, while they fit in `budget` bytes (the first one
 * always does): their XML and how many were written. Live records are loaded {@link LOAD_BATCH} at a time (public load,
 * no items); a deleted one is its header alone.
 */
export async function recordsXml(
  db: Db,
  items: readonly OaiItem[],
  prefix: OaiPrefix,
  o: OaiRenderOptions,
  budget: number = OAI_PAGE_BYTES,
): Promise<{ xml: string; count: number }> {
  const parts: string[] = [];
  let bytes = 0;
  for (let i = 0; i < items.length; i += LOAD_BATCH) {
    const batch = items.slice(i, i + LOAD_BATCH);
    const live = batch.filter((item) => !item.deleted).map((item) => item.id);
    const data = live.length === 0 ? new Map<string, RecordData>() : await loadRecordData(db, live, { publicOnly: true, includeItems: false });
    for (const item of batch) {
      const xml = recordXml(item, data.get(item.id), prefix, o);
      const size = Buffer.byteLength(xml, 'utf8');
      if (parts.length > 0 && bytes + size > budget) return { xml: parts.join(''), count: parts.length };
      parts.push(xml);
      bytes += size;
    }
  }
  return { xml: parts.join(''), count: parts.length };
}
