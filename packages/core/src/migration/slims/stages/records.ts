import type { DB } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import type { Insertable, Kysely, Transaction } from 'kysely';
import { CUSTOM_TEXT_MAX, coerceCustomValues, customValuesSchema, loadCustomDefs, writeCustomValues, type CustomFieldDef } from '../../../catalog/data/custom-fields.js';
import { defaultMaterialTypeId } from '../../../catalog/data/defaults.js';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import { splitIdentifierText } from '../../../catalog/lib/identifiers.js';
import { titleKey } from '../../../catalog/lib/title-key.js';
import { indexRecords, stampChanged } from '../../../search/index-records.js';
import { readSettings } from '../../../settings/service.js';
import { authorRole } from '../maps/authors.js';
import { placeMap } from '../maps/place.js';
import { rdaMaps, type RdaKind } from '../maps/rda.js';
import { cleanDate, cleanText, extractYear } from '../source/clean-text.js';
import { phpUnserialize } from '../source/php-unserialize.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsReportRow, SlimsStage, SlimsStageContext } from '../stage.js';
import { slimsCustomField } from './masters.js';
import {
  countUnmapped,
  cutChars,
  fitChars,
  fitText,
  freshRows,
  intOf,
  keyOf,
  mappedOf,
  markOf,
  multiLine,
  oneLine,
  refsOf,
  runSteps,
  textOf,
  type BatchIo,
  type Ledger,
  type Step,
} from './stage-a-kit.js';

// Records (Phase 2 spec §11.3 step 3, §11.4, §11.5; plan Task 37, preflight M13, S13, S19): `biblio` and the tables
// that hang off it, one after the other, each in batches of 500 with one transaction per batch (stage-a-kit.ts):
//
// 1. `biblio` → `records` (written directly, as the catalog's bulk path, with the columns createRecord writes):
//    - `title` split on its first `:` into title and subtitle when both sides are not empty; `sor`, `edition`,
//      `spec_detail_info` → material detail, `collation`, `series_title`, `classification`, `call_number`, `notes`;
//    - `isbn_issn` → identifiers through splitIdentifierText (§3.2); `publish_year` → its text, and its first year
//      (§11.5 step 5) as `publication_year`;
//    - the GMD, publisher and language through the legacy map of the masters stage (a GMD that is 0 or missing → the
//      default material type + report); the RDA codes and the place's name through the masters' tables read into
//      maps (M13; an id with no row → null + `rda_unmatched`, `place_missing`);
//    - `opac_hide` → `opac_visible = 0`, `promoted`; `input_date`/`last_update` (the library's local time) →
//      `created_at`/`updated_at`, an invalid one → the migration time + `date_invalid`; `source = 'slims:<biblio_id>'`;
//    - `uid`, `file_att`, `source` and `frequency_id` are not mapped (the archive keeps `frequency_id`): their values
//      are counted and reported once.
// 2. `biblio_author` → `record_agents`: level 1–10 as relator roles (maps/authors.ts), the first level-1 author of a
//    record its main entry; 3. `biblio_topic` → `record_subjects` (level 1 primary). A link to a record or authority
//    the run did not migrate is skipped `orphan` and reported; a link that two merged authorities make twice is merged.
// 4. `biblio_custom` → custom values: the `cf_*` columns of the definitions the masters stage migrated, a checklist's
//    serialized list split, a date cleaned (§11.5 step 6), then coerceCustomValues and the definitions' schema (S19);
//    a value refused is reported and left out, the record keeps the rest.
// 5. Likely duplicates among the records migrated under the run's source (an ISBN key, or a title key and year) are
//    reported (`possible_duplicate`), never merged (§3.3).
//
// Each batch indexes the records it wrote or linked (`indexRecords`, §4.1) and, as its last write, moves their OAI
// datestamp to the clock read then (`stampChanged`, C14: `changed_at` = the moment the batch commits, never the slice's
// start, so a harvest that ran while it was open still selects them next time). Every row read is counted once: migrated,
// merged or skipped (with its reason). A dry run counts and reports the same, writes nothing, and has no duplicates to
// report; its links can be orphans only when a key is 0 (it maps nothing to look orphans up in). A replay (a row this
// very run mapped before its process died, stage-a-kit.ts) is counted and reported as its first attempt was (a link
// merged into another by its `merged` mark) and writes nothing.

/** Rows per INSERT of `records`, and their text bytes at most (below MariaDB's default max_allowed_packet of 16 MB). */
const RECORD_ROWS_PER_INSERT = 100;
const RECORD_BYTES_PER_INSERT = 4_000_000;
const ROWS_PER_INSERT = 500;
/** `records.source`, `record_identifiers.value_display`/`qualifier` widths. */
const SOURCE_MAX = 191;
const ID_DISPLAY_MAX = 64;

type Db = Kysely<DB> | Transaction<DB>;
type RecordInsert = Insertable<DB['records']>;

/** A legacy reference that points at something (0 is SLiMS's "none"). */
const isRef = (k: string): boolean => k !== '' && k !== '0';

/** Inserts `rows` into `table` in statements of at most `per` rows (and `maxBytes` of text when given). */
async function insertChunks<T extends object>(trx: Transaction<DB>, table: 'records' | 'record_identifiers' | 'record_agents' | 'record_subjects', rows: readonly T[], per: number, maxBytes?: number): Promise<void> {
  let chunk: T[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (chunk.length === 0) return;
    // The tables take what each caller builds for them; Kysely cannot narrow a union of table names.
    await trx
      .insertInto(table as 'record_agents')
      .values(chunk as never)
      .execute();
    chunk = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = maxBytes === undefined ? 0 : Object.values(row).reduce((n: number, v) => n + (typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : 8), 0);
    if (chunk.length >= per || (maxBytes !== undefined && chunk.length > 0 && bytes + size > maxBytes)) await flush();
    chunk.push(row);
    bytes += size;
  }
  await flush();
}

/** The legacy map rows of a batch of `table` (and the `merged` marks of its rows, stage-a-kit.ts). */
function mapsOf(c: SlimsStageContext, table: string): { add(key: string, targetId: string): void; merged(key: string, targetId: string): void; write(io: BatchIo): Promise<void> } {
  const rows: LegacyMapping[] = [];
  return {
    add: (key, targetId) => rows.push({ source: c.options.sourceName, entity: table, legacyKey: key, targetId, runId: c.runId }),
    merged: (key, targetId) => rows.push(markOf(c, table, key, targetId, 'merged')),
    write: async (io) => {
      if (io.trx !== null && rows.length > 0) await mapLegacy(io.trx, rows);
    },
  };
}

// ---- local dates ------------------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(timeZone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(timeZone)) {
    let f: Intl.DateTimeFormat | null;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      f = null;
    }
    formatters.set(timeZone, f);
  }
  return formatters.get(timeZone) ?? null;
}

/** How far the wall clock of `timeZone` is ahead of UTC at the instant `at` (ms); 0 for a zone Intl does not know. */
function offsetAt(at: number, timeZone: string): number {
  const f = formatter(timeZone);
  if (f === null) return 0;
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p['year']), Number(p['month']) - 1, Number(p['day']), Number(p['hour']), Number(p['minute']), Number(p['second']));
  return wall - (at - (((at % 1000) + 1000) % 1000));
}

/** The instant of the wall-clock time `local` (`YYYY-MM-DD[ HH:MM:SS]`, from cleanDate) in `timeZone`. */
export function localEpoch(local: string, timeZone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(local);
  if (m === null) throw new TypeError('localEpoch: not a cleaned date');
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  return second;
}

/** A SLiMS date-time as an instant: NULL or blank → `now`; invalid, before 1970 or after `now` → `now` and reported. */
function instantOf(l: Ledger, key: string, column: string, v: SlimsRow[string] | undefined, timeZone: string, now: number): number {
  const text = keyOf(v);
  if (text === '') return now;
  const clean = cleanDate(text);
  const at = clean === null ? Number.NaN : localEpoch(clean, timeZone);
  if (Number.isSafeInteger(at) && at >= 0 && at <= now) return at;
  l.fixed(`biblio.${column}`, ['date'], text, '');
  l.report('biblio', key, 'date_invalid', `${column}=${cutChars(text, 40)}`);
  return now;
}

async function timeZoneOf(db: Db): Promise<string> {
  return String((await readSettings(db, ['library.timezone'], []))['library.timezone']);
}

// ---- 1. biblio --------------------------------------------------------------------------------------------------------

/** The `biblio` columns no record field takes (§11.4 "tidak dipetakan"; the archive keeps `frequency_id`). */
const BIBLIO_UNMAPPED = Object.freeze(['uid', 'file_att', 'source', 'frequency_id']);

const RDA_COLUMNS: readonly (readonly [RdaKind, string])[] = [
  ['content', 'content_type_id'],
  ['media', 'media_type_id'],
  ['carrier', 'carrier_type_id'],
];

async function biblioBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'biblio';
  const fresh = await freshRows(c, io, l, T, rows, ['biblio_id']);
  if (fresh.length === 0) return;
  countUnmapped(l, fresh, BIBLIO_UNMAPPED);
  const refs = (column: string) => fresh.map(({ row }) => keyOf(row[column])).filter(isRef);
  const gmds = await refsOf(c, io, 'mst_gmd', refs('gmd_id'));
  const publishers = await refsOf(c, io, 'mst_publisher', refs('publisher_id'));
  // SLiMS compares language codes without case: the exact key first, then its lower and upper case.
  const languages = await refsOf(c, io, 'mst_language', refs('language_id').flatMap((k) => [k, k.toLowerCase(), k.toUpperCase()]));
  const rda = await rdaMaps(c.source);
  const places = await placeMap(c.source);
  const timeZone = await timeZoneOf(io.db);
  let fallbackType: string | null = null;
  const records: RecordInsert[] = [];
  const identifiers: Insertable<DB['record_identifiers']>[] = [];
  const maps = mapsOf(c, T);

  for (const { key, row, replay } of fresh) {
    const text = (column: string): string => oneLine(textOf(l, T, column, row[column]) ?? '');
    // Title and subtitle.
    const whole = text('title');
    let title = whole;
    let subtitle: string | null = null;
    const colon = whole.indexOf(':');
    if (colon >= 0) {
      const head = whole.slice(0, colon).trim();
      const tail = whole.slice(colon + 1).trim();
      if (head !== '' && tail !== '') [title, subtitle] = [head, tail];
    }
    if (title === '') {
      title = `[Tanpa judul - SLiMS #${key}]`;
      l.report(T, key, 'title_empty', 'Judul kosong / The title is empty');
    }
    title = fitText(l, T, key, 'title', title) ?? title;
    subtitle = fitText(l, T, key, 'title', subtitle);
    // Masters through the legacy map.
    const gmd = keyOf(row['gmd_id']);
    let materialTypeId = isRef(gmd) ? gmds.get(gmd) : undefined;
    if (materialTypeId === undefined) {
      if (fallbackType === null) {
        const configured = (await readSettings(io.db, ['catalog.defaultMaterialTypeId'], []))['catalog.defaultMaterialTypeId'] as string | null;
        fallbackType = await defaultMaterialTypeId(io.db, configured);
      }
      materialTypeId = fallbackType;
      l.report(T, key, 'material_type_default', `gmd_id=${gmd || '-'}`);
    }
    const publisher = keyOf(row['publisher_id']);
    let publisherId: string | null = null;
    if (isRef(publisher)) {
      publisherId = publishers.get(publisher) ?? null;
      if (publisherId === null) l.report(T, key, 'publisher_missing', `publisher_id=${cutChars(publisher, 40)}`);
    }
    const language = keyOf(row['language_id']);
    let languageId: string | null = null;
    if (language !== '') {
      languageId = languages.get(language) ?? languages.get(language.toLowerCase()) ?? languages.get(language.toUpperCase()) ?? null;
      if (languageId === null) l.report(T, key, 'language_missing', `language_id=${cutChars(language, 40)}`);
    }
    // RDA codes and the place (M13).
    const codes: Partial<Record<RdaKind, string | null>> = {};
    for (const [kind, column] of RDA_COLUMNS) {
      const id = keyOf(row[column]);
      codes[kind] = null;
      if (!isRef(id)) continue;
      if (rda[kind].has(id)) codes[kind] = rda[kind].get(id) ?? null;
      else l.report(T, key, 'rda_unmatched', `${column}=${cutChars(id, 40)}`);
    }
    const placeKey = keyOf(row['publish_place_id']);
    let place: string | null = null;
    if (isRef(placeKey)) {
      if (places.has(placeKey)) place = places.get(placeKey) ?? null;
      else l.report(T, key, 'place_missing', `publish_place_id=${cutChars(placeKey, 40)}`);
    }
    // The year (§11.5 step 5): the text kept, its first year extracted.
    const yearText = text('publish_year');
    const year = yearText === '' ? null : extractYear(yearText);
    if (yearText !== '' && yearText !== year) l.fixed(`${T}.publish_year`, ['year'], yearText, year ?? '');
    const id = newId(c.now);
    // The values are worked out (their repairs counted, their problems reported) for a replay too, which is stored.
    const record: RecordInsert = {
      id,
      material_type_id: materialTypeId,
      title,
      subtitle,
      responsibility: fitText(l, T, key, 'sor', text('sor')),
      title_key: titleKey(title, subtitle),
      edition: fitChars(l, T, key, 'edition', text('edition'), 191),
      material_detail: fitChars(l, T, key, 'spec_detail_info', text('spec_detail_info'), 191),
      publisher_id: publisherId,
      publication_place: place,
      publication_year: year,
      publication_date_text: fitChars(l, T, key, 'publish_year', yearText, 64),
      physical_desc: fitChars(l, T, key, 'collation', text('collation'), 191),
      series: fitChars(l, T, key, 'series_title', text('series_title'), 191),
      classification: fitChars(l, T, key, 'classification', text('classification'), 64),
      call_number: fitChars(l, T, key, 'call_number', text('call_number'), 64),
      language_id: languageId,
      content_type: codes.content ?? null,
      media_type: codes.media ?? null,
      carrier_type: codes.carrier ?? null,
      summary: null,
      notes: fitText(l, T, key, 'notes', multiLine(textOf(l, T, 'notes', row['notes']) ?? '').trim()),
      cover_file_id: null,
      opac_visible: intOf(row['opac_hide']) === 1 ? 0 : 1,
      promoted: intOf(row['promoted']) === 1 ? 1 : 0,
      source: cutChars(`slims:${key}`, SOURCE_MAX),
      merged_into: null,
      changed_at: c.now,
      archived_at: null,
      created_at: instantOf(l, key, 'input_date', row['input_date'], timeZone, c.now),
      created_by: null,
      updated_at: instantOf(l, key, 'last_update', row['last_update'], timeZone, c.now),
      updated_by: null,
    };
    // Identifiers (§3.2): each ISBN, ISSN or other text of the cell once.
    const ids: Insertable<DB['record_identifiers']>[] = [];
    const seen = new Set<string>();
    const idText = text('isbn_issn');
    for (const part of idText === '' ? [] : splitIdentifierText(idText)) {
      const valueKey = part.key ?? cutChars(normalizeKey(part.value), 191);
      const unique = `${part.type}\u0000${valueKey}`;
      if (valueKey === '' || seen.has(unique)) continue;
      seen.add(unique);
      if (part.type !== 'other' && !part.valid) l.report(T, key, 'identifier_invalid', `${part.type}=${cutChars(part.value, 40)}`);
      ids.push({
        id: newId(c.now),
        record_id: id,
        type: part.type,
        value_display: cutChars(part.value, ID_DISPLAY_MAX),
        value_key: valueKey,
        qualifier: part.qualifier === null ? null : cutChars(part.qualifier, ID_DISPLAY_MAX) || null,
        is_valid: part.type === 'other' || part.valid ? 1 : 0,
        sort_order: seen.size - 1,
      });
    }
    if (replay !== null) continue;
    records.push(record);
    identifiers.push(...ids);
    maps.add(key, id);
  }
  l.migrated(T, fresh.length);
  if (io.trx === null) return;
  await insertChunks(io.trx, 'records', records, RECORD_ROWS_PER_INSERT, RECORD_BYTES_PER_INSERT);
  await insertChunks(io.trx, 'record_identifiers', identifiers, ROWS_PER_INSERT);
  await maps.write(io);
  const written = records.map((r) => r.id);
  await indexRecords(io.trx, written, c.now);
  await stampChanged(io.trx, written, c.clock());
}

// ---- 2, 3. authors and topics of records --------------------------------------------------------------------------------

/** What a record holds already of a link table: a main entry (or primary subject), how many links, which ones. */
interface LinkState {
  first: boolean;
  count: number;
  keys: Set<string>;
}

async function linkStates(db: Db, table: 'record_agents' | 'record_subjects', recordIds: readonly string[]): Promise<Map<string, LinkState>> {
  const out = new Map<string, LinkState>();
  const ids = [...new Set(recordIds)];
  for (const id of ids) out.set(id, { first: false, count: 0, keys: new Set() });
  for (let i = 0; i < ids.length; i += ROWS_PER_INSERT) {
    const chunk = ids.slice(i, i + ROWS_PER_INSERT);
    if (table === 'record_agents') {
      for (const r of await db.selectFrom('record_agents').select(['record_id', 'agent_id', 'role', 'is_main']).where('record_id', 'in', chunk).execute()) {
        const st = out.get(r.record_id)!;
        st.count += 1;
        st.keys.add(`${r.agent_id}|${r.role}`);
        st.first ||= Number(r.is_main) === 1;
      }
    } else {
      for (const r of await db.selectFrom('record_subjects').select(['record_id', 'subject_id', 'is_primary']).where('record_id', 'in', chunk).execute()) {
        const st = out.get(r.record_id)!;
        st.count += 1;
        st.keys.add(r.subject_id);
      }
    }
  }
  return out;
}

async function authorLinks(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'biblio_author';
  const fresh = await freshRows(c, io, l, T, rows, ['biblio_id', 'author_id']);
  if (fresh.length === 0) return;
  const records = await refsOf(c, io, 'biblio', fresh.map(({ row }) => keyOf(row['biblio_id'])).filter(isRef));
  const agents = await refsOf(c, io, 'mst_author', fresh.map(({ row }) => keyOf(row['author_id'])).filter(isRef));
  const states = await linkStates(io.db, 'record_agents', [...records.values()]);
  const links: Insertable<DB['record_agents']>[] = [];
  const touched = new Set<string>();
  const maps = mapsOf(c, T);
  for (const { key, row, replay } of fresh) {
    const b = keyOf(row['biblio_id']);
    const a = keyOf(row['author_id']);
    const recordId = isRef(b) ? records.get(b) : undefined;
    if (recordId === undefined) {
      l.skipped(T, 'orphan');
      l.report(T, key, 'record_missing', `biblio_id=${cutChars(b, 40)}`);
      continue;
    }
    const agentId = isRef(a) ? agents.get(a) : undefined;
    if (agentId === undefined) {
      l.skipped(T, 'orphan');
      l.report(T, key, 'author_missing', `author_id=${cutChars(a, 40)}`);
      continue;
    }
    const level = intOf(row['level']) ?? 1;
    const role = authorRole(level);
    if (!role.valid) l.report(T, key, 'author_level_invalid', `level=${level} -> aut`);
    if (replay !== null) {
      if (replay.marks.has('merged')) l.merged(T);
      else l.migrated(T);
      continue;
    }
    let st = states.get(recordId);
    if (st === undefined) states.set(recordId, (st = { first: false, count: 0, keys: new Set() }));
    const linkKey = `${agentId}|${role.role}`;
    maps.add(key, recordId);
    if (st.keys.has(linkKey)) {
      l.merged(T);
      maps.merged(key, recordId);
      continue;
    }
    st.keys.add(linkKey);
    const isMain = role.mainCandidate && !st.first;
    if (isMain) st.first = true;
    links.push({ record_id: recordId, agent_id: agentId, role: role.role, is_main: isMain ? 1 : 0, sort_order: role.rank * 1000 + st.count });
    st.count += 1;
    touched.add(recordId);
    l.migrated(T);
  }
  if (io.trx === null) return;
  await insertChunks(io.trx, 'record_agents', links, ROWS_PER_INSERT);
  await maps.write(io);
  await indexRecords(io.trx, [...touched], c.now);
  await stampChanged(io.trx, [...touched], c.clock());
}

async function topicLinks(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'biblio_topic';
  const fresh = await freshRows(c, io, l, T, rows, ['biblio_id', 'topic_id']);
  if (fresh.length === 0) return;
  const records = await refsOf(c, io, 'biblio', fresh.map(({ row }) => keyOf(row['biblio_id'])).filter(isRef));
  const subjects = await refsOf(c, io, 'mst_topic', fresh.map(({ row }) => keyOf(row['topic_id'])).filter(isRef));
  const states = await linkStates(io.db, 'record_subjects', [...records.values()]);
  const links: Insertable<DB['record_subjects']>[] = [];
  const touched = new Set<string>();
  const maps = mapsOf(c, T);
  for (const { key, row, replay } of fresh) {
    const b = keyOf(row['biblio_id']);
    const t = keyOf(row['topic_id']);
    const recordId = isRef(b) ? records.get(b) : undefined;
    if (recordId === undefined) {
      l.skipped(T, 'orphan');
      l.report(T, key, 'record_missing', `biblio_id=${cutChars(b, 40)}`);
      continue;
    }
    const subjectId = isRef(t) ? subjects.get(t) : undefined;
    if (subjectId === undefined) {
      l.skipped(T, 'orphan');
      l.report(T, key, 'topic_missing', `topic_id=${cutChars(t, 40)}`);
      continue;
    }
    if (replay !== null) {
      if (replay.marks.has('merged')) l.merged(T);
      else l.migrated(T);
      continue;
    }
    const primary = (intOf(row['level']) ?? 1) === 1;
    let st = states.get(recordId);
    if (st === undefined) states.set(recordId, (st = { first: false, count: 0, keys: new Set() }));
    maps.add(key, recordId);
    if (st.keys.has(subjectId)) {
      l.merged(T);
      maps.merged(key, recordId);
      continue;
    }
    st.keys.add(subjectId);
    links.push({ record_id: recordId, subject_id: subjectId, is_primary: primary ? 1 : 0, sort_order: (primary ? 0 : 1000) + st.count });
    st.count += 1;
    touched.add(recordId);
    l.migrated(T);
  }
  if (io.trx === null) return;
  await insertChunks(io.trx, 'record_subjects', links, ROWS_PER_INSERT);
  await maps.write(io);
  await indexRecords(io.trx, [...touched], c.now);
  await stampChanged(io.trx, [...touched], c.clock());
}

// ---- 4. custom values ----------------------------------------------------------------------------------------------------

/** The record definitions and the one each `cf_*` column of `biblio_custom` stands for. */
async function customDefs(c: SlimsStageContext, io: BatchIo, columns: readonly string[]): Promise<{ defs: CustomFieldDef[]; byColumn: Map<string, CustomFieldDef> }> {
  const byColumn = new Map<string, CustomFieldDef>();
  if (!c.dryRun) {
    const mapped = await mappedOf(c, io, 'mst_custom_field', columns);
    const defs = await loadCustomDefs(io.db, 'records');
    const byId = new Map(defs.map((d) => [d.id, d]));
    for (const column of columns) {
      const def = byId.get(mapped.get(column) ?? '');
      if (def !== undefined) byColumn.set(column, def);
    }
    return { defs, byColumn };
  }
  // A dry run made no definitions: they are taken from the source's, as the masters stage would make them.
  const defs: CustomFieldDef[] = [];
  if ((await c.source.tables()).some((t) => t.name === 'mst_custom_field')) {
    let after: string | null = null;
    do {
      const batch = await c.source.rows('mst_custom_field', after, 500);
      for (const row of batch.rows) {
        const def = slimsCustomField(row, (column) => oneLine(quietText(row[column])));
        if (def === null || def.entity !== 'records' || defs.some((d) => d.code === def.code)) continue;
        defs.push({
          id: `~${def.code}`,
          code: def.code,
          type: def.type,
          labelId: def.label,
          labelEn: null,
          options: def.options.map((o) => ({ value: o.value, labelId: o.label_id, labelEn: null })),
          required: false,
          sortOrder: def.sortOrder,
          isPublic: def.isPublic,
          isSearchable: def.isSearchable,
          archived: false,
        });
      }
      after = batch.rows.length === 0 ? null : batch.next;
    } while (after !== null);
  }
  for (const column of columns) {
    const def = defs.find((d) => d.code === column);
    if (def !== undefined) byColumn.set(column, def);
  }
  return { defs, byColumn };
}

/** A cell as clean text without counting its repairs ('' for NULL; the masters stage counts the definitions'). */
function quietText(v: SlimsRow[string] | undefined): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? String(v) : cleanText(v).value;
}

/** The strings of an unserialized checklist value. */
function listOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'object' && value !== null ? Object.values(value) : [value];
  return items.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
}

/** A list as coerceCustomValues reads a multiselect: joined with `|`, a literal `|` as `\|`. */
function pipes(list: readonly string[]): string {
  return list.map((s) => s.replace(/\|/g, '\\|')).join('|');
}

async function customBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger, first: boolean): Promise<void> {
  const T = 'biblio_custom';
  const columns = ((await c.source.tables()).find((t) => t.name === T)?.columns ?? []).filter((column) => /^cf_/i.test(column));
  const { defs, byColumn } = await customDefs(c, io, columns);
  if (first) {
    for (const column of columns) {
      if (!byColumn.has(column)) l.report(T, null, 'custom_column_unmapped', `${column}: tanpa definisi ruas / no field definition`);
    }
  }
  const fresh = await freshRows(c, io, l, T, rows, ['biblio_id']);
  if (fresh.length === 0) return;
  const records = await refsOf(c, io, 'biblio', fresh.map(({ key }) => key).filter(isRef));
  const schema = customValuesSchema(defs, 'patch');
  const touched = new Set<string>();
  const maps = mapsOf(c, T);
  for (const { key, row, replay } of fresh) {
    const recordId = records.get(key);
    if (recordId === undefined) {
      l.skipped(T, 'orphan');
      l.report(T, key, 'record_missing', `biblio_id=${cutChars(key, 40)}`);
      continue;
    }
    const raw: [string, string][] = [];
    for (const [column, def] of byColumn) {
      const cell = textOf(l, T, column, row[column]);
      if (cell === null) continue;
      let s = def.type === 'longtext' ? multiLine(cell).trim() : oneLine(cell);
      if (s === '') continue;
      if (def.type === 'multiselect') {
        const parsed = phpUnserialize(s);
        const list = parsed.ok ? listOf(parsed.value) : parsed.strings;
        if (!parsed.ok) {
          l.fixed(`${T}.${column}`, ['php'], s, JSON.stringify(list));
          l.report(T, key, 'php_broken', `${column}: ${list.length} teks terbaca / strings recovered`);
        }
        s = pipes(list.map((x) => oneLine(x)).filter((x) => x !== ''));
      } else if (def.type === 'date') {
        const date = cleanDate(s);
        if (date === null) {
          l.fixed(`${T}.${column}`, ['date'], s, '');
          l.report(T, key, 'date_invalid', `${column}=${cutChars(s, 40)}`);
          continue;
        }
        s = date.slice(0, 10);
      } else if (def.type === 'text') {
        s = fitChars(l, T, key, column, s, CUSTOM_TEXT_MAX) ?? '';
      } else if (def.type === 'longtext') {
        s = fitText(l, T, key, column, s) ?? '';
      }
      if (s !== '') raw.push([def.code, s]);
    }
    const given = Object.fromEntries(raw);
    const coerced = coerceCustomValues(defs, given);
    for (const e of coerced.errors) {
      const code = e.path.replace(/^custom\./, '');
      l.report(T, key, 'custom_value_invalid', `${code}=${cutChars(given[code] ?? '', 60)}`);
    }
    // The definitions' schema (S19): a value it refuses is reported and left out; the others are kept.
    let values: Record<string, unknown> = coerced.values;
    for (let round = 0; round < 8 && Object.keys(values).length > 0; round += 1) {
      const parsed = schema.safeParse(values);
      if (parsed.success) {
        values = parsed.data;
        break;
      }
      const bad = new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')));
      if (bad.has('')) values = {};
      for (const code of bad) {
        if (code === '') continue;
        l.report(T, key, 'custom_value_invalid', `${code}=${cutChars(given[code] ?? '', 60)}`);
        values = Object.fromEntries(Object.entries(values).filter(([k]) => k !== code));
      }
    }
    if (Object.keys(values).length === 0) {
      l.skipped(T, 'no_values');
      continue;
    }
    l.migrated(T);
    if (replay !== null) continue;
    if (io.trx !== null) await writeCustomValues(io.trx, 'records', recordId, values, defs, { now: c.now, actor: null });
    maps.add(key, recordId);
    touched.add(recordId);
  }
  if (io.trx === null) return;
  await maps.write(io);
  await indexRecords(io.trx, [...touched], c.now);
  await stampChanged(io.trx, [...touched], c.clock());
}

// ---- 5. likely duplicates -----------------------------------------------------------------------------------------------

/** Keys of duplicate groups per call. */
const GROUPS_PER_CALL = 200;
/** Legacy ids listed per report row. */
const MEMBERS_LISTED = 50;

function cursorOf(cursor: string | null): { k: 'isbn' | 'title'; a: string | null } {
  if (cursor === null) return { k: 'isbn', a: null };
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch {
    throw new TypeError('records: the duplicates cursor is not JSON');
  }
  const v = raw as { k?: unknown; a?: unknown };
  if ((v.k !== 'isbn' && v.k !== 'title') || (v.a !== null && typeof v.a !== 'string')) throw new TypeError('records: the duplicates cursor is malformed');
  return { k: v.k, a: v.a };
}

/** Legacy ids in their natural order (numbers by value). */
function legacyOrder(a: string, b: string): number {
  const na = /^\d+$/.test(a) ? Number(a) : Number.NaN;
  const nb = /^\d+$/.test(b) ? Number(b) : Number.NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function duplicateRow(ids: string[], what: string): SlimsReportRow {
  ids.sort(legacyOrder);
  const listed = ids.slice(0, MEMBERS_LISTED).join(',');
  const more = ids.length > MEMBERS_LISTED ? ` (+${ids.length - MEMBERS_LISTED})` : '';
  return { table: 'biblio', legacyKey: ids[0] ?? null, code: 'possible_duplicate', detail: `${what}; slims=${listed}${more}` };
}

/**
 * One call of the duplicate report (§3.3: reported, never merged): a page of ISBN keys, then of title keys, that two or
 * more records migrated under the run's source share; per title key, the records of one year (or of none) are a group.
 * Read-only, so a call redone after a crash only adds report rows the framework cuts back (its report checkpoint).
 */
async function duplicates(c: SlimsStageContext, cursor: string | null): Promise<{ done: boolean; cursor: string | null }> {
  if (c.dryRun) return { done: true, cursor: null };
  const at = cursorOf(cursor);
  const db = c.h.db;
  const source = c.options.sourceName;
  if (at.k === 'isbn') {
    const keys = (
      await db
        .selectFrom('record_identifiers as ri')
        .innerJoin('migration_map as mm', 'mm.target_id', 'ri.record_id')
        .select('ri.value_key')
        .where('mm.source', '=', source)
        .where('mm.entity', '=', 'biblio')
        .where('ri.type', '=', 'isbn')
        .$if(at.a !== null, (q) => q.where('ri.value_key', '>', at.a!))
        .groupBy('ri.value_key')
        .having((eb) => eb(eb.fn.countAll(), '>', 1))
        .orderBy('ri.value_key')
        .limit(GROUPS_PER_CALL)
        .execute()
    ).map((r) => r.value_key);
    if (keys.length > 0) {
      const members = await db
        .selectFrom('record_identifiers as ri')
        .innerJoin('migration_map as mm', 'mm.target_id', 'ri.record_id')
        .select(['ri.value_key', 'mm.legacy_key'])
        .where('mm.source', '=', source)
        .where('mm.entity', '=', 'biblio')
        .where('ri.type', '=', 'isbn')
        .where('ri.value_key', 'in', keys)
        .execute();
      for (const k of keys) {
        const ids = [...new Set(members.filter((m) => m.value_key === k).map((m) => m.legacy_key))];
        if (ids.length > 1) c.report(duplicateRow(ids, `isbn=${k}`));
      }
    }
    return { done: false, cursor: JSON.stringify(keys.length < GROUPS_PER_CALL ? { k: 'title', a: null } : { k: 'isbn', a: keys[keys.length - 1] }) };
  }
  const keys = (
    await db
      .selectFrom('records as r')
      .innerJoin('migration_map as mm', 'mm.target_id', 'r.id')
      .select('r.title_key')
      .where('mm.source', '=', source)
      .where('mm.entity', '=', 'biblio')
      .where('r.archived_at', 'is', null)
      .where('r.title_key', '<>', '')
      .$if(at.a !== null, (q) => q.where('r.title_key', '>', at.a!))
      .groupBy('r.title_key')
      .having((eb) => eb(eb.fn.countAll(), '>', 1))
      .orderBy('r.title_key')
      .limit(GROUPS_PER_CALL)
      .execute()
  ).map((r) => r.title_key);
  if (keys.length > 0) {
    const members = await db
      .selectFrom('records as r')
      .innerJoin('migration_map as mm', 'mm.target_id', 'r.id')
      .select(['r.title_key', 'r.publication_year', 'mm.legacy_key'])
      .where('mm.source', '=', source)
      .where('mm.entity', '=', 'biblio')
      .where('r.archived_at', 'is', null)
      .where('r.title_key', 'in', keys)
      .execute();
    for (const k of keys) {
      const years = new Map<string, string[]>();
      for (const m of members) {
        if (m.title_key !== k) continue;
        const y = m.publication_year ?? '';
        years.set(y, [...(years.get(y) ?? []), m.legacy_key]);
      }
      for (const [y, ids] of [...years].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (ids.length > 1) c.report(duplicateRow(ids, `title_key=${cutChars(k, 80)}; year=${y || '-'}`));
      }
    }
  }
  return keys.length < GROUPS_PER_CALL ? { done: true, cursor: null } : { done: false, cursor: JSON.stringify({ k: 'title', a: keys[keys.length - 1] }) };
}

// ---- the stage ----------------------------------------------------------------------------------------------------------

const STEPS: readonly Step[] = Object.freeze([
  { kind: 'scan', table: 'biblio', unmapped: BIBLIO_UNMAPPED, batch: biblioBatch },
  { kind: 'scan', table: 'biblio_author', batch: authorLinks },
  { kind: 'scan', table: 'biblio_topic', batch: topicLinks },
  { kind: 'scan', table: 'biblio_custom', batch: customBatch },
  { kind: 'custom', name: 'possible_duplicates', run: duplicates },
] satisfies Step[]);

/**
 * Records (§11.3 step 3, §11.4): `biblio` with its authors, topics and custom values, in batches of 500.
 */
export const recordsStage: SlimsStage = Object.freeze({
  name: 'records' as const,
  reads: Object.freeze(['biblio', 'biblio_author', 'biblio_topic', 'biblio_custom']),
  run: (c: SlimsStageContext, cursor: string | null) => runSteps(c, 'records', STEPS, cursor),
});
