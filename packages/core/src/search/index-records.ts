import {
  fullTextDeleteRows,
  fullTextFamily,
  fullTextInsertRows,
  normalizeDbError,
  type DB,
  type FullTextFamily,
  type FullTextRow,
} from '@altis/db';
import { isDomainError } from '@altis/shared';
import { sql, type Transaction } from 'kysely';
import { loadCustomDefs, readCustomValues, type CustomFieldDef } from '../catalog/data/custom-fields.js';
import { locationPaths } from '../catalog/data/locations.js';
import { openLoanDueDates } from '../circulation/availability.js';
import { keptItems } from '../circulation/holds.js';
import { buildSearchDoc, customSearchTexts, type SearchDoc, type SearchDocSource } from './doc.js';

// The synchronous index (Phase 2 spec §4.1, D2-07): every write path of the catalogue calls indexRecords with the ids it
// changed, in its own transaction, so a record is searchable the moment its write commits, from any path.
//
// Per chunk of 500 ids: a fixed number of reads (the records, their identifiers, agents, subjects, publishers, live
// items and their locations, public live attachments, searchable public custom values), the documents built (doc.ts),
// then, inside SAVEPOINT altis_ix: the old FTS5 rows removed with the `'delete'` command and the values they were
// indexed with (SQLite), the old `search_facet` and `search_doc` rows deleted, the new ones inserted (in statements of
// at most 200 rows and about 4 MB of text, below MariaDB's default max_allowed_packet of 16 MB), the new FTS5 rows
// added. An id that names no record loses its document.
//
// Concurrency (C05): a document is only as fresh as the reads it was built from, so a caller locks the rows of the
// records it indexes (a write that changes nothing, or its own UPDATE of them) before its transaction's first plain
// read: two writers of one record then serialise on that row, and the second builds from the first's commit (on
// MySQL/MariaDB the REPEATABLE READ snapshot starts at the first plain read; PostgreSQL's READ COMMITTED reads the
// latest commit per statement). The record save, the item writes, attachments, the cover, a merge and the reindex
// batches do. A writer that does not (an authority rename) queues a reindex, whose batches do. An import batch cannot
// (its createRecord, updateRecord and createItem run deep in a 200-unit transaction, after the plain reads of the units
// before them; the version and liveness guards of review items C01/C02 keep its data right, not its documents): its
// job builds the documents of every record the batch wrote once more, in a transaction of their own right after the
// batch's COMMIT whose first statement locks those records (import-job.ts, cross-group review X1-1). The SLiMS stage
// batches do not yet (records, items, covers, attachments read the legacy map and the records before they index): on
// MySQL/MariaDB such a batch can build a record's document from a snapshot older than a librarian's save that
// committed during the run, and write it over that save's document (follow-up P2-SLIMS-TAHAP-INDEKS-SNAPSHOT).
//
// Two transactions indexing the same record at once without that lock: PostgreSQL's READ COMMITTED lets the second
// one's DELETE miss the first one's uncommitted document, and its INSERT then waits for it and fails with
// UNIQUE_VIOLATION once the first commits. The savepoint takes that back, the documents are built again (now from the
// committed state) and written once more, whose DELETE now sees the committed row. MySQL/MariaDB's DELETE is a locking
// read that waits and sees it; SQLite has one writer.

/** Ids per chunk (an IN list of each read). */
const CHUNK = 500;
/** Rows per INSERT of search_doc, and their text bytes at most (before the next statement starts). */
const DOC_ROWS_PER_INSERT = 200;
const DOC_BYTES_PER_INSERT = 4_000_000;
/** Rows per INSERT of search_facet (3 parameters each). */
const FACET_ROWS_PER_INSERT = 500;

/** The custom fields whose values are indexed (S20): searchable AND public, not archived. */
interface IndexedDefs {
  records: CustomFieldDef[];
  items: CustomFieldDef[];
}

async function indexedDefs(trx: Transaction<DB>): Promise<IndexedDefs> {
  const pick = (defs: CustomFieldDef[]) => defs.filter((d) => d.isSearchable && d.isPublic);
  return { records: pick(await loadCustomDefs(trx, 'records')), items: pick(await loadCustomDefs(trx, 'items')) };
}

/** Groups `rows` by their `key`. */
function groupBy<T, K extends keyof T>(rows: readonly T[], key: K): Map<T[K], T[]> {
  const out = new Map<T[K], T[]>();
  for (const r of rows) {
    const list = out.get(r[key]);
    if (list === undefined) out.set(r[key], [r]);
    else list.push(r);
  }
  return out;
}

/** The texts of `values` for the fields `defs` (by code). */
function customTexts(defs: readonly CustomFieldDef[], values: Record<string, unknown> | undefined): string[] {
  if (values === undefined) return [];
  return defs.flatMap((d) => (Object.hasOwn(values, d.code) ? customSearchTexts(d, values[d.code]) : []));
}

/** The documents of the records `ids` (an id without a record has none). */
async function loadDocs(trx: Transaction<DB>, ids: readonly string[], defs: IndexedDefs): Promise<SearchDoc[]> {
  const records = await trx
    .selectFrom('records')
    .select([
      'id',
      'material_type_id',
      'title',
      'subtitle',
      'series',
      'title_key',
      'publisher_id',
      'publication_place',
      'publication_year',
      'classification',
      'call_number',
      'language_id',
      'summary',
      'notes',
      'opac_visible',
      'archived_at',
      'merged_into',
      'created_at',
      'changed_at',
    ])
    .where('id', 'in', ids)
    .execute();
  if (records.length === 0) return [];
  const found = records.map((r) => r.id);

  const identifiers = groupBy(
    await trx
      .selectFrom('record_identifiers')
      .select(['record_id', 'type', 'value_display', 'value_key'])
      .where('record_id', 'in', found)
      .orderBy('record_id')
      .orderBy('sort_order')
      .orderBy('id')
      .execute(),
    'record_id',
  );
  const agents = groupBy(
    await trx
      .selectFrom('record_agents as ra')
      .innerJoin('agents as a', 'a.id', 'ra.agent_id')
      .select(['ra.record_id', 'a.type', 'a.name_display'])
      .where('ra.record_id', 'in', found)
      .orderBy('ra.record_id')
      .orderBy('ra.sort_order')
      .orderBy('ra.agent_id')
      .orderBy('ra.role')
      .execute(),
    'record_id',
  );
  const subjects = groupBy(
    await trx
      .selectFrom('record_subjects as rs')
      .innerJoin('subjects as s', 's.id', 'rs.subject_id')
      .select(['rs.record_id', 's.id', 's.term_display', 's.classification'])
      .where('rs.record_id', 'in', found)
      .orderBy('rs.record_id')
      .orderBy('rs.sort_order')
      .orderBy('rs.subject_id')
      .execute(),
    'record_id',
  );
  const publisherIds = [...new Set(records.map((r) => r.publisher_id).filter((id): id is string => id !== null))];
  const publishers = new Map(
    publisherIds.length === 0
      ? []
      : (await trx.selectFrom('publishers').select(['id', 'name_display', 'place']).where('id', 'in', publisherIds).execute()).map(
          (p) => [p.id, { name: p.name_display, place: p.place }] as const,
        ),
  );
  const itemRows = await trx
    .selectFrom('items')
    .select(['id', 'record_id', 'branch_id', 'location_id', 'collection_type_id', 'status', 'barcode_display', 'call_number'])
    .where('record_id', 'in', found)
    .where('archived_at', 'is', null)
    .orderBy('record_id')
    .orderBy('id')
    .execute();
  // An item on loan keeps its status; the open loan says it is out (facet `av`).
  const onLoan = itemRows.length === 0 ? new Map<string, string>() : await openLoanDueDates(trx, itemRows.map((i) => i.id));
  // A copy kept on a hold shelf is not available to others either.
  const kept = itemRows.length === 0 ? new Map<string, unknown>() : await keptItems(trx, itemRows.map((i) => i.id));
  const items = groupBy(
    itemRows.map((i) => ({ ...i, on_loan: onLoan.has(i.id), on_hold: kept.has(i.id) })),
    'record_id',
  );
  const locationIds = [...new Set(itemRows.map((i) => i.location_id).filter((id): id is string => id !== null))];
  const locations = locationIds.length === 0 ? new Map() : await locationPaths(trx, locationIds);
  const attachments = groupBy(
    await trx
      .selectFrom('attachments as at')
      .leftJoin('files as f', 'f.id', 'at.file_id')
      .select(['at.record_id', 'at.kind', 'f.mime'])
      .where('at.record_id', 'in', found)
      .where('at.archived_at', 'is', null)
      .where('at.access', '=', 'public')
      .execute(),
    'record_id',
  );
  const recordValues = defs.records.length === 0 ? new Map<string, Record<string, unknown>>() : await readCustomValues(trx, 'records', found);
  const itemValues =
    defs.items.length === 0 || itemRows.length === 0 ? new Map<string, Record<string, unknown>>() : await readCustomValues(trx, 'items', itemRows.map((i) => i.id));

  return records.map((record) => {
    const own = items.get(record.id) ?? [];
    const src: SearchDocSource = {
      record,
      identifiers: identifiers.get(record.id) ?? [],
      agents: (agents.get(record.id) ?? []).map((a) => ({ type: a.type, name: a.name_display })),
      subjects: (subjects.get(record.id) ?? []).map((s) => ({ id: s.id, term: s.term_display, classification: s.classification })),
      publisher: record.publisher_id === null ? null : (publishers.get(record.publisher_id) ?? null),
      items: own,
      locations,
      attachments: attachments.get(record.id) ?? [],
      customTexts: [
        ...customTexts(defs.records, recordValues.get(record.id)),
        ...own.flatMap((i) => customTexts(defs.items, itemValues.get(i.id))),
      ],
    };
    return buildSearchDoc(src);
  });
}

/** The UTF-8 bytes of a row's four token columns. */
function textBytes(d: SearchDoc): number {
  const r = d.row;
  return (
    Buffer.byteLength(r.t_title, 'utf8') + Buffer.byteLength(r.t_agents, 'utf8') + Buffer.byteLength(r.t_subjects, 'utf8') + Buffer.byteLength(r.t_rest, 'utf8')
  );
}

/** Deletes the documents of `ids` and writes `docs` (see the top of this file), in `trx`. */
async function writeDocs(trx: Transaction<DB>, family: FullTextFamily, ids: readonly string[], docs: readonly SearchDoc[]): Promise<void> {
  if (family === 'fts5') {
    const old: FullTextRow[] = await trx
      .selectFrom('search_doc')
      .select(['doc_no', 't_title', 't_agents', 't_subjects', 't_rest'])
      .where('record_id', 'in', ids)
      .execute();
    await fullTextDeleteRows(trx, family, old);
  }
  await trx.deleteFrom('search_facet').where('record_id', 'in', ids).execute();
  await trx.deleteFrom('search_doc').where('record_id', 'in', ids).execute();
  if (docs.length === 0) return;

  for (let i = 0; i < docs.length; ) {
    let bytes = 0;
    let end = i;
    while (end < docs.length && end - i < DOC_ROWS_PER_INSERT && (end === i || bytes + textBytes(docs[end]!) <= DOC_BYTES_PER_INSERT)) {
      bytes += textBytes(docs[end]!);
      end += 1;
    }
    await trx
      .insertInto('search_doc')
      .values(docs.slice(i, end).map((d) => d.row))
      .execute();
    i = end;
  }
  if (family === 'fts5') {
    const numbers = new Map(
      (await trx.selectFrom('search_doc').select(['doc_no', 'record_id']).where('record_id', 'in', ids).execute()).map((r) => [r.record_id, r.doc_no]),
    );
    const rows: FullTextRow[] = docs.map((d) => {
      const docNo = numbers.get(d.row.record_id);
      if (docNo === undefined) throw new TypeError(`indexRecords: the document of ${d.row.record_id} was not written`);
      return { doc_no: Number(docNo), t_title: d.row.t_title, t_agents: d.row.t_agents, t_subjects: d.row.t_subjects, t_rest: d.row.t_rest };
    });
    await fullTextInsertRows(trx, family, rows);
  }
  const facets = docs.flatMap((d) => d.facets.map((f) => ({ record_id: d.row.record_id, facet: f.facet, value_key: f.value_key })));
  for (let i = 0; i < facets.length; i += FACET_ROWS_PER_INSERT) {
    await trx
      .insertInto('search_facet')
      .values(facets.slice(i, i + FACET_ROWS_PER_INSERT))
      .execute();
  }
}

function isUniqueViolation(error: unknown): boolean {
  const e = normalizeDbError(error);
  return isDomainError(e) && e.code === 'UNIQUE_VIOLATION';
}

/**
 * Rewrites the index rows of `recordIds` (spec §4.1; see the top of this file): deletes, then writes `search_doc`,
 * `search_facet` and the dialect's full-text row, in the caller's transaction `trx`, so that a record is searchable
 * the moment its write commits. Every write path of the catalog (form, import, migration, SRU copy, merge, items,
 * attachments) calls it with the ids it changed. `now` is the write's time; a document carries the record's own
 * `created_at` and `changed_at`, so it is not stored.
 *
 * Re-runnable as a whole (R37): it writes only through `trx`. Await it before the next statement on `trx`.
 *
 * @throws TypeError when `recordIds` is not an array of strings
 */
export async function indexRecords(trx: Transaction<DB>, recordIds: readonly string[], now: number): Promise<void> {
  void now;
  if (!Array.isArray(recordIds) || recordIds.some((id) => typeof id !== 'string')) {
    throw new TypeError('indexRecords: recordIds must be an array of strings');
  }
  const unique = [...new Set(recordIds)];
  if (unique.length === 0) return;
  const family = fullTextFamily(trx);
  const defs = await indexedDefs(trx);
  for (let i = 0; i < unique.length; i += CHUNK) {
    const ids = unique.slice(i, i + CHUNK);
    const docs = await loadDocs(trx, ids, defs);
    await sql`savepoint altis_ix`.execute(trx);
    try {
      await writeDocs(trx, family, ids, docs);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another transaction committed a document of one of these records after our DELETE looked (see the top): the
      // documents are built again from what it committed.
      await sql`rollback to savepoint altis_ix`.execute(trx);
      await writeDocs(trx, family, ids, await loadDocs(trx, ids, defs));
    }
    await sql`release savepoint altis_ix`.execute(trx);
  }
}

/**
 * Sets the OAI datestamp of the records `recordIds` (`records.changed_at`) and the copy their documents hold
 * (`search_doc.changed_at`) to `at`, in the caller's transaction `trx` (C14). A batch writer (a reindex batch, an import
 * batch, a SLiMS stage batch) runs it as its last statements, with `at` read from the clock right before its COMMIT: a
 * harvest that read the old rows while the batch was open answered an earlier responseDate, so its next `from` still
 * selects them. With `o.from`, only the rows still stamped `from` (the batch's own earlier stamp) move: a record the
 * batch wrote without changing its public form keeps its datestamp. In chunks of 500 ids.
 */
export async function stampChanged(trx: Transaction<DB>, recordIds: readonly string[], at: number, o: { from?: number } = {}): Promise<void> {
  const unique = [...new Set(recordIds)].sort();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const ids = unique.slice(i, i + CHUNK);
    let records = trx.updateTable('records').set({ changed_at: at }).where('id', 'in', ids);
    let docs = trx.updateTable('search_doc').set({ changed_at: at }).where('record_id', 'in', ids);
    if (o.from !== undefined) {
      records = records.where('changed_at', '=', o.from);
      docs = docs.where('changed_at', '=', o.from);
    }
    await records.execute();
    await docs.execute();
  }
}
