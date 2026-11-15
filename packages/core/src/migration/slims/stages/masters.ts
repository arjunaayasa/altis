import type { DB } from '@altis/db';
import { newId, normalizeKey, type CustomFieldEntity, type CustomFieldType } from '@altis/shared';
import { emailField } from '@altis/shared/api/common';
import { EMPTY_TEMPLATE } from '@altis/shared/api/catalog/masters';
import { BarcodePattern, SruServer } from '@altis/shared/api/settings';
import type { Insertable } from 'kysely';
import { resolveAgents, resolvePublisher, resolveSubjects } from '../../../catalog/data/authorities.js';
import { codeKey, publisherNameKey, subjectTermKey } from '../../../catalog/data/keys.js';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import { txCtx, type Actor, type TxCtx } from '../../../context.js';
import { readSettings, writeSettings } from '../../../settings/service.js';
import { agentTypeOf, subjectTypeOf } from '../maps/authority-types.js';
import { findSlimsAuthor } from '../maps/authors.js';
import { gmdProfile } from '../maps/gmd.js';
import { marcLanguage } from '../maps/language.js';
import { rdaCodeOf, type RdaKind } from '../maps/rda.js';
import { reciprocalRel, thesaurusRelOf } from '../maps/thesaurus.js';
import { phpUnserialize } from '../source/php-unserialize.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import {
  codeFits,
  countUnmapped,
  codeFromName,
  cutChars,
  fitChars,
  fitText,
  freshRows,
  intOf,
  keyOf,
  markOf,
  multiLine,
  oneLine,
  refsOf,
  runSteps,
  textOf,
  type BatchIo,
  type FreshRow,
  type Ledger,
  type ReplayMark,
  type ScanStep,
} from './stage-a-kit.js';

// Data induk and authorities (Phase 2 spec §11.3 step 2, §11.4; plan Task 37, preflight M13, S13): every masters row
// of §11.4, table by table, in batches of 500, each batch in one transaction with its legacy map rows (`migration_map`,
// entity = the SLiMS table, legacy key = the row's primary key, source = the run's `sourceName`). A row already mapped
// under that source is skipped `already_migrated` and never updated (§11.2, D2-26). Per table:
//
// - `mst_gmd` → a material type per GMD: code `gmd_code` (or one made from the name), profile from the GMD name table
//   (maps/gmd.ts; an unknown name takes `BUKU`'s, reported). A code that exists already is merged into.
// - `mst_content_type`, `mst_media_type`, `mst_carrier_type`, `mst_place`, `mst_relation_term`: no rows of their own;
//   counted `merged` into the fields the records stage fills from them (M13). An RDA row that matches no RDA code or
//   term is reported `rda_unmatched`; a relation code other than U/UF/BT/NT/RT/SA `relation_term_unknown`.
// - `mst_language` → by the 2-letter → MARC table (maps/language.ts): the MARC language (merged into an existing one,
//   else created); an unknown code becomes a new language of that code (`language_unknown`).
// - `mst_publisher`, `mst_author`, `mst_topic` → publishers, agents, subjects through the catalog's find-or-create
//   (Task 1): a row whose key is taken is merged into that row (`authority_merged`), so duplicates keep both legacy ids.
//   Authors are matched by name and type even when only one side has dates (maps/authors.ts); types p/o/c and the six
//   topic types (another code → person/topic + report).
// - `mst_voc_ctrl` → `subject_relations` with their reciprocals (maps/thesaurus.ts); a `scope` row → the subject's
//   scope note (kept when the subject has one: `scope_note_kept`).
// - `mst_location` → rooms of the run's branch (code = `location_id`); `mst_coll_type` → collection types (code from
//   the name); `mst_supplier` → suppliers (`SUP<id>`); `mst_custom_field` (`biblio`, `item`, `member`) → custom field
//   definitions (options from the serialized `data`; a member's never public nor searchable, its values are the members
//   stage's); `mst_servers` (MARC SRU only) → `catalog.sru.servers`, disabled;
//   `setting.batch_item_code_pattern` → `catalog.barcode.patterns`. The settings rows map to the run (a settings entry
//   has no row id of its own).
//
// A dry run reads the same rows and counts them alike (duplicates within a batch and against the catalogue merged),
// and writes nothing. A replay (a row this very run mapped before its process died, stage-a-kit.ts) is counted and
// reported as its first attempt was, from its target and its marks (`merged`, `scope_kept`), and writes nothing.

const SYSTEM: Actor = Object.freeze({ type: 'system', id: null, ip: null });

/** The longest values of the columns written here (their widths). */
const NAME_MAX = 191;
const SHORT_MAX = 64;

/** The writer of a batch: the transaction context of a real run, null in a dry run. */
function writer(c: SlimsStageContext, io: BatchIo): TxCtx | null {
  return io.trx === null ? null : txCtx(io.trx, c.now, SYSTEM);
}

/** A one-line text cell, cleaned and counted, cut to `max` (reported when cut); '' for NULL or blank. */
function line(l: Ledger, table: string, key: string, column: string, row: SlimsRow, max: number): string {
  return fitChars(l, table, key, column, oneLine(textOf(l, table, column, row[column]) ?? ''), max) ?? '';
}

/** The legacy map rows of a batch, written at its end (a real run). */
class Maps {
  private readonly rows: LegacyMapping[] = [];

  constructor(private readonly c: SlimsStageContext, private readonly table: string) {}

  add(key: string, targetId: string): void {
    this.rows.push({ source: this.c.options.sourceName, entity: this.table, legacyKey: key, targetId, runId: this.c.runId });
  }

  /** Marks what the row `key` came to (stage-a-kit.ts: a replay of the batch counts it from its marks). */
  mark(key: string, targetId: string, mark: ReplayMark): void {
    this.rows.push(markOf(this.c, this.table, key, targetId, mark));
  }

  async write(io: BatchIo): Promise<void> {
    if (io.trx !== null && this.rows.length > 0) await mapLegacy(io.trx, this.rows);
  }
}

/**
 * The row `r` merges into, or undefined when it makes one: for a replay, its target when its first attempt marked it
 * `merged`; otherwise what `find` answers (a row planned earlier in the batch, or one stored already).
 */
async function mergeTarget(r: FreshRow, find: () => Promise<string | undefined>): Promise<string | undefined> {
  if (r.replay !== null) return r.replay.marks.has('merged') ? r.replay.targetId : undefined;
  return find();
}

/** The trail columns of a row the migration creates (the system actor: no user). */
function trail(now: number) {
  return { archived_at: null, created_at: now, created_by: null, updated_at: now, updated_by: null } as const;
}

// ---- mst_gmd ----------------------------------------------------------------------------------------------------------

/** A new material type's template (the seed's, as the masters API makes one). */
const TEMPLATE_JSON = JSON.stringify(EMPTY_TEMPLATE);
/** New masters sort after the seeded ones (10–80). */
const SORT_AFTER_SEEDS = 1000;
/** Columns of `mst_gmd` and `mst_custom_field` that no ALTIS field takes (reported with their counts). */
const GMD_UNMAPPED = Object.freeze(['icon_image']);
const CUSTOM_FIELD_UNMAPPED = Object.freeze(['default', 'max', 'class', 'width', 'note']);

async function gmdBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_gmd';
  const maps = new Maps(c, T);
  const planned = new Map<string, string>();
  const fresh = await freshRows(c, io, l, T, rows, ['gmd_id']);
  countUnmapped(l, fresh, GMD_UNMAPPED);
  for (const r of fresh) {
    const { key, row, replay } = r;
    const name = line(l, T, key, 'gmd_name', row, NAME_MAX);
    const given = oneLine(textOf(l, T, 'gmd_code', row['gmd_code']) ?? '');
    const code = codeFits(given) ? given : cutChars(codeFromName(name) || `GMD-${key}`, 32);
    const ck = codeKey(code);
    let id = await mergeTarget(r, async () => planned.get(ck) ?? (await io.db.selectFrom('material_types').select('id').where('code_key', '=', ck).executeTakeFirst())?.id);
    if (id !== undefined) {
      l.merged(T);
      maps.mark(key, id, 'merged');
    } else {
      const label = name === '' ? code : name;
      const { profile: p, matched } = gmdProfile(label);
      if (!matched) l.report(T, key, 'gmd_profile_default', `${label}: profil BUKU / the BUKU profile`);
      id = replay?.targetId ?? newId(c.now);
      // A replay's row is stored already.
      await (replay === null ? io.trx : null)
        ?.insertInto('material_types')
        .values({
          id,
          code_display: code,
          code_key: ck,
          name_id: label,
          name_en: label,
          marc_type: p.marcType,
          marc_level: p.marcLevel,
          content_type: p.contentType,
          media_type: p.mediaType,
          carrier_type: p.carrierType,
          schema_type: p.schemaType,
          dcmi_type: p.dcmiType,
          template: TEMPLATE_JSON,
          sort_order: SORT_AFTER_SEEDS,
          ...trail(c.now),
        })
        .execute();
      l.migrated(T);
    }
    planned.set(ck, id);
    maps.add(key, id);
  }
  await maps.write(io);
}

// ---- RDA, places, relation terms: merged into the records' fields -------------------------------------------------

function rdaStep(kind: RdaKind, table: string, termColumn: string): ScanStep {
  return {
    kind: 'scan',
    table,
    async batch(c, rows, io, l) {
      for (const { key, row } of await freshRows(c, io, l, table, rows, ['id'], { mapped: false })) {
        const term = oneLine(textOf(l, table, termColumn, row[termColumn]) ?? '');
        const code = oneLine(textOf(l, table, 'code', row['code']) ?? '');
        if (rdaCodeOf(kind, row) === null) l.report(table, key, 'rda_unmatched', `code=${code}; ${cutChars(term, 80)}`);
        l.merged(table);
      }
    },
  };
}

async function placeBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  for (const { row } of await freshRows(c, io, l, 'mst_place', rows, ['place_id'], { mapped: false })) {
    textOf(l, 'mst_place', 'place_name', row['place_name']);
    l.merged('mst_place');
  }
}

async function relationTermBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_relation_term';
  for (const { key, row } of await freshRows(c, io, l, T, rows, ['ID'], { mapped: false })) {
    const code = keyOf(row['rt_id']);
    if (!thesaurusRelOf(code).valid) l.report(T, key, 'relation_term_unknown', `${cutChars(code, 20)} -> rt`);
    l.merged(T);
  }
}

// ---- mst_language ---------------------------------------------------------------------------------------------------

async function languageBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_language';
  const maps = new Maps(c, T);
  const planned = new Map<string, string>();
  for (const r of await freshRows(c, io, l, T, rows, ['language_id'])) {
    const { key, row, replay } = r;
    const name = line(l, T, key, 'language_name', row, NAME_MAX);
    const marc = marcLanguage(key);
    const code = marc?.code ?? key;
    if (!codeFits(code)) {
      l.skipped(T, 'invalid_code');
      l.report(T, key, 'invalid_code', 'Kode bahasa tidak dapat dipakai / The language code cannot be used');
      continue;
    }
    if (marc === null) l.report(T, key, 'language_unknown', `${cutChars(name, 80)}: bahasa baru / a new language`);
    const ck = codeKey(code);
    let id = await mergeTarget(r, async () => planned.get(ck) ?? (await io.db.selectFrom('languages').select('id').where('code_key', '=', ck).executeTakeFirst())?.id);
    if (id !== undefined) {
      l.merged(T);
      maps.mark(key, id, 'merged');
    } else {
      id = replay?.targetId ?? newId(c.now);
      await (replay === null ? io.trx : null)
        ?.insertInto('languages')
        .values({ id, code_display: code, code_key: ck, name_id: marc?.nameId ?? (name || code), name_en: marc?.nameEn ?? (name || code), ...trail(c.now) })
        .execute();
      l.migrated(T);
    }
    planned.set(ck, id);
    maps.add(key, id);
  }
  await maps.write(io);
}

// ---- authorities ----------------------------------------------------------------------------------------------------

async function publisherBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_publisher';
  const maps = new Maps(c, T);
  const tx = writer(c, io);
  const planned = new Map<string, string>();
  for (const { key, row, replay } of await freshRows(c, io, l, T, rows, ['publisher_id'])) {
    const name = line(l, T, key, 'publisher_name', row, NAME_MAX);
    if (name === '') {
      l.skipped(T, 'empty_name');
      l.report(T, key, 'empty_name', 'Nama penerbit kosong / The publisher has no name');
      continue;
    }
    let id: string;
    let created: boolean;
    if (replay !== null) {
      id = replay.targetId;
      created = !replay.marks.has('merged');
    } else if (tx !== null) {
      ({ id, created } = (await resolvePublisher(tx, { name })) as { id: string; created: boolean });
    } else {
      const nk = publisherNameKey(name);
      const found = planned.get(nk) ?? (await io.db.selectFrom('publishers').select('id').where('name_key', '=', nk).executeTakeFirst())?.id;
      created = found === undefined;
      id = found ?? newId(c.now);
      planned.set(nk, id);
    }
    if (created) l.migrated(T);
    else {
      l.merged(T);
      l.report(T, key, 'authority_merged', cutChars(name, 120));
      maps.mark(key, id, 'merged');
    }
    maps.add(key, id);
  }
  await maps.write(io);
}

async function authorBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_author';
  const maps = new Maps(c, T);
  const tx = writer(c, io);
  /** A dry run's authors so far, by type and name: their dates. */
  const planned = new Map<string, { id: string; dates: string | null }[]>();
  for (const { key, row, replay } of await freshRows(c, io, l, T, rows, ['author_id'])) {
    const name = line(l, T, key, 'author_name', row, NAME_MAX);
    if (name === '') {
      l.skipped(T, 'empty_name');
      l.report(T, key, 'empty_name', 'Nama pengarang kosong / The author has no name');
      continue;
    }
    const kind = agentTypeOf(textOf(l, T, 'authority_type', row['authority_type']));
    if (!kind.valid) l.report(T, key, 'author_type_invalid', `${cutChars(keyOf(row['authority_type']), 10)} -> person`);
    const dates = line(l, T, key, 'author_year', row, SHORT_MAX) || null;
    const source = line(l, T, key, 'auth_list', row, SHORT_MAX) || null;
    let id: string;
    let created = false;
    if (replay !== null) {
      id = replay.targetId;
      created = !replay.marks.has('merged');
    } else if (tx !== null) {
      const found = await findSlimsAuthor(io.db, kind.type, name, dates);
      if (found !== null) id = (await resolveAgents(tx, [{ id: found }])).ids[0]!;
      else {
        const r = await resolveAgents(tx, [{ type: kind.type, name, dates, authoritySource: source }]);
        id = r.ids[0]!;
        created = r.created === 1;
      }
    } else {
      const nk = `${kind.type}\u0000${normalizeKey(name)}`;
      const same = planned.get(nk) ?? [];
      let found = await findSlimsAuthor(io.db, kind.type, name, dates);
      found ??= (same.find((a) => a.dates === dates) ?? same.find((a) => a.dates === null) ?? (dates === null ? same[0] : undefined))?.id ?? null;
      created = found === null;
      id = found ?? newId(c.now);
      if (created) planned.set(nk, [...same, { id, dates }]);
    }
    if (created) l.migrated(T);
    else {
      l.merged(T);
      l.report(T, key, 'authority_merged', cutChars(name, 120));
      maps.mark(key, id, 'merged');
    }
    maps.add(key, id);
  }
  await maps.write(io);
}

async function topicBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_topic';
  const maps = new Maps(c, T);
  const tx = writer(c, io);
  const planned = new Map<string, string>();
  for (const { key, row, replay } of await freshRows(c, io, l, T, rows, ['topic_id'])) {
    const term = line(l, T, key, 'topic', row, NAME_MAX);
    if (term === '') {
      l.skipped(T, 'empty_name');
      l.report(T, key, 'empty_name', 'Subjek kosong / The topic has no term');
      continue;
    }
    const kind = subjectTypeOf(textOf(l, T, 'topic_type', row['topic_type']));
    if (!kind.valid) l.report(T, key, 'topic_type_invalid', `${cutChars(keyOf(row['topic_type']), 10)} -> topic`);
    const classification = line(l, T, key, 'classification', row, SHORT_MAX) || null;
    const source = line(l, T, key, 'auth_list', row, SHORT_MAX) || null;
    let id: string;
    let created: boolean;
    if (replay !== null) {
      id = replay.targetId;
      created = !replay.marks.has('merged');
    } else if (tx !== null) {
      const r = await resolveSubjects(tx, [{ type: kind.type, term, classification, authoritySource: source }]);
      id = r.ids[0]!;
      created = r.created === 1;
    } else {
      const tk = subjectTermKey(term);
      const found =
        planned.get(`${kind.type}\u0000${tk}`) ??
        (await io.db.selectFrom('subjects').select('id').where('type', '=', kind.type).where('term_key', '=', tk).executeTakeFirst())?.id;
      created = found === undefined;
      id = found ?? newId(c.now);
      planned.set(`${kind.type}\u0000${tk}`, id);
    }
    if (created) l.migrated(T);
    else {
      l.merged(T);
      l.report(T, key, 'authority_merged', cutChars(term, 120));
      maps.mark(key, id, 'merged');
    }
    maps.add(key, id);
  }
  await maps.write(io);
}

// ---- mst_voc_ctrl ---------------------------------------------------------------------------------------------------

async function vocBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_voc_ctrl';
  const maps = new Maps(c, T);
  const fresh = await freshRows(c, io, l, T, rows, ['vocabolary_id']);
  const subjects = await refsOf(
    c,
    io,
    'mst_topic',
    fresh.flatMap(({ row }) => [keyOf(row['topic_id']), keyOf(row['related_topic_id'])]).filter((k) => k !== '' && k !== '0'),
  );
  /** Relations written (or found) in this batch: `<subject>|<related>|<rel>`. */
  const seen = new Set<string>();
  const addRelation = async (subjectId: string, relatedId: string, rel: string): Promise<boolean> => {
    const k = `${subjectId}|${relatedId}|${rel}`;
    if (seen.has(k)) return false;
    seen.add(k);
    const exists = await io.db
      .selectFrom('subject_relations')
      .select('rel')
      .where('subject_id', '=', subjectId)
      .where('related_id', '=', relatedId)
      .where('rel', '=', rel)
      .executeTakeFirst();
    if (exists !== undefined) return false;
    await io.trx?.insertInto('subject_relations').values({ subject_id: subjectId, related_id: relatedId, rel }).execute();
    return true;
  };
  for (const { key, row, replay } of fresh) {
    const subjectId = subjects.get(keyOf(row['topic_id']));
    if (subjectId === undefined) {
      l.skipped(T, 'orphan');
      l.report(T, key, 'thesaurus_orphan', `topic_id=${cutChars(keyOf(row['topic_id']), 40)}`);
      continue;
    }
    const outcomes = new Set<'written' | 'kept' | 'orphan' | 'self'>();
    const scope = fitText(l, T, key, 'scope', multiLine(textOf(l, T, 'scope', row['scope']) ?? '').trim());
    if (scope !== null) {
      const kept =
        replay !== null
          ? replay.marks.has('scope_kept')
          : await io.db
              .selectFrom('subjects')
              .select('scope_note')
              .where('id', '=', subjectId)
              .executeTakeFirst()
              .then((has) => has?.scope_note !== null && has?.scope_note !== undefined && has.scope_note !== '');
      if (kept) {
        outcomes.add('kept');
        l.report(T, key, 'scope_note_kept', 'Subjek sudah punya catatan cakupan / The subject has a scope note already');
        maps.mark(key, subjectId, 'scope_kept');
      } else if (replay !== null) {
        outcomes.add('written');
      } else {
        await io.trx
          ?.updateTable('subjects')
          .set((eb) => ({ scope_note: scope, version: eb('version', '+', 1), updated_at: c.now, updated_by: null }))
          .where('id', '=', subjectId)
          .execute();
        outcomes.add('written');
      }
    }
    const code = keyOf(row['rt_id']);
    const relatedKey = keyOf(row['related_topic_id']);
    if (code !== '' || (relatedKey !== '' && relatedKey !== '0')) {
      const { rel, valid } = thesaurusRelOf(code);
      if (!valid) l.report(T, key, 'relation_term_unknown', `${cutChars(code, 20)} -> rt`);
      const relatedId = subjects.get(relatedKey);
      if (relatedId === undefined) {
        outcomes.add('orphan');
        l.report(T, key, 'thesaurus_orphan', `related_topic_id=${cutChars(relatedKey, 40)}`);
      } else if (relatedId === subjectId) {
        outcomes.add('self');
      } else if (replay !== null) {
        // Its first attempt's outcome: a relation written, or both there already (a row marked `merged`).
        outcomes.add(replay.marks.has('merged') ? 'kept' : 'written');
      } else {
        const forward = await addRelation(subjectId, relatedId, rel);
        const back = await addRelation(relatedId, subjectId, reciprocalRel(rel));
        outcomes.add(forward || back ? 'written' : 'kept');
      }
    }
    if (outcomes.has('written')) l.migrated(T);
    else if (outcomes.has('kept')) {
      l.merged(T);
      maps.mark(key, subjectId, 'merged');
    } else {
      l.skipped(T, outcomes.has('orphan') ? 'orphan' : outcomes.has('self') ? 'self' : 'empty');
      continue;
    }
    maps.add(key, subjectId);
  }
  await maps.write(io);
}

// ---- locations, collection types, suppliers -------------------------------------------------------------------------

async function locationBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_location';
  const maps = new Maps(c, T);
  const planned = new Map<string, string>();
  for (const r of await freshRows(c, io, l, T, rows, ['location_id'])) {
    const { key, row, replay } = r;
    if (!codeFits(key)) {
      l.skipped(T, 'invalid_code');
      l.report(T, key, 'invalid_code', 'Kode lokasi tidak dapat dipakai / The location code cannot be used');
      continue;
    }
    const name = line(l, T, key, 'location_name', row, NAME_MAX) || key;
    const ck = codeKey(key);
    let id = await mergeTarget(
      r,
      async () =>
        planned.get(ck) ??
        (await io.db.selectFrom('locations').select('id').where('branch_id', '=', c.options.branchId).where('code_key', '=', ck).executeTakeFirst())?.id,
    );
    if (id !== undefined) {
      l.merged(T);
      maps.mark(key, id, 'merged');
    } else {
      id = replay?.targetId ?? newId(c.now);
      await (replay === null ? io.trx : null)
        ?.insertInto('locations')
        .values({
          id,
          branch_id: c.options.branchId,
          parent_id: null,
          kind: 'room',
          code_display: key,
          code_key: ck,
          name,
          shelf_hint: null,
          class_from: null,
          class_to: null,
          map_file_id: null,
          map_x: null,
          map_y: null,
          map_w: null,
          map_h: null,
          is_public: 1,
          sort_order: 0,
          ...trail(c.now),
        })
        .execute();
      l.migrated(T);
    }
    planned.set(ck, id);
    maps.add(key, id);
  }
  await maps.write(io);
}

async function collTypeBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_coll_type';
  const maps = new Maps(c, T);
  const planned = new Map<string, string>();
  for (const r of await freshRows(c, io, l, T, rows, ['coll_type_id'])) {
    const { key, row, replay } = r;
    const name = line(l, T, key, 'coll_type_name', row, NAME_MAX);
    const code = cutChars(codeFromName(name) || `COLL-${key}`, 32);
    const ck = codeKey(code);
    let id = await mergeTarget(r, async () => planned.get(ck) ?? (await io.db.selectFrom('collection_types').select('id').where('code_key', '=', ck).executeTakeFirst())?.id);
    if (id !== undefined) {
      l.merged(T);
      maps.mark(key, id, 'merged');
    } else {
      id = replay?.targetId ?? newId(c.now);
      await (replay === null ? io.trx : null)
        ?.insertInto('collection_types')
        .values({ id, code_display: code, code_key: ck, name_id: name || code, name_en: name || code, loanable: 1, self_service: 1, sort_order: SORT_AFTER_SEEDS, ...trail(c.now) })
        .execute();
      l.migrated(T);
    }
    planned.set(ck, id);
    maps.add(key, id);
  }
  await maps.write(io);
}

async function supplierBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_supplier';
  const maps = new Maps(c, T);
  const planned = new Map<string, string>();
  for (const r of await freshRows(c, io, l, T, rows, ['supplier_id'])) {
    const { key, row, replay } = r;
    const code = `SUP${key}`;
    if (!codeFits(code)) {
      l.skipped(T, 'invalid_code');
      l.report(T, key, 'invalid_code', 'Kode pemasok tidak dapat dipakai / The supplier code cannot be used');
      continue;
    }
    const ck = codeKey(code);
    let id = await mergeTarget(r, async () => planned.get(ck) ?? (await io.db.selectFrom('suppliers').select('id').where('code_key', '=', ck).executeTakeFirst())?.id);
    if (id !== undefined) {
      l.merged(T);
      maps.mark(key, id, 'merged');
    } else {
      const cell = (column: string) => oneLine(textOf(l, T, column, row[column]) ?? '');
      const [email, fax, account, address, postal] = [cell('e_mail'), cell('fax'), cell('account'), cell('address'), cell('postal_code')];
      const emailOk = email !== '' && emailField.safeParse(email).success;
      // What has no column of its own goes into the note: the fax, the account, an e-mail address that is not one.
      const note = [fax === '' ? '' : `Faks: ${fax}`, account === '' ? '' : `Rekening: ${account}`, email === '' || emailOk ? '' : `E-mail: ${email}`]
        .filter((s) => s !== '')
        .join('\n');
      id = replay?.targetId ?? newId(c.now);
      // The values are worked out (and their repairs counted) for a replay too, whose row is stored already.
      const values = {
        id,
        code_display: code,
        code_key: ck,
        name: line(l, T, key, 'supplier_name', row, NAME_MAX) || code,
        contact_name: line(l, T, key, 'contact', row, NAME_MAX) || null,
        phone: line(l, T, key, 'phone', row, SHORT_MAX) || null,
        email: emailOk ? email : null,
        address: fitText(l, T, key, 'address', [address, postal].filter((s) => s !== '').join(' ')),
        note: fitText(l, T, key, 'note', note),
        ...trail(c.now),
      };
      if (replay === null) await io.trx?.insertInto('suppliers').values(values).execute();
      l.migrated(T);
    }
    planned.set(ck, id);
    maps.add(key, id);
  }
  await maps.write(io);
}

// ---- mst_custom_field -----------------------------------------------------------------------------------------------

/** SLiMS custom field types → ALTIS (§11.4). */
const CUSTOM_TYPES: Readonly<Record<string, CustomFieldType>> = Object.freeze({
  text: 'text',
  longtext: 'longtext',
  numeric: 'number',
  dropdown: 'select',
  checklist: 'multiselect',
  choice: 'select',
  date: 'date',
});

/** Options per field (the masters API's maximum), and their stored JSON in UTF-8 bytes (a TEXT column, Review Focus 3). */
const OPTIONS_MAX = 100;
const OPTIONS_JSON_MAX_BYTES = 60_000;

/** A SLiMS custom field definition as ALTIS keeps it, and what the conversion has to report. */
export interface SlimsCustomField {
  entity: CustomFieldEntity;
  code: string;
  type: CustomFieldType;
  label: string;
  options: { value: string; label_id: string; label_en: null }[];
  isPublic: boolean;
  isSearchable: boolean;
  sortOrder: number;
  /** Report rows (`code`, `detail`). */
  problems: { code: string; detail: string }[];
  /** The serialized option list was broken: the stored text and the strings recovered from it. */
  broken: { stored: string; strings: string[] } | null;
}

/** The strings of an unserialized list (a list of lists, a list, an object of values), each pair as value and label. */
function optionPairs(value: unknown): [string, string][] {
  const items = Array.isArray(value) ? value : typeof value === 'object' && value !== null ? Object.values(value) : [value];
  const pairs: [string, string][] = [];
  for (const item of items) {
    if (Array.isArray(item)) {
      const [v, label] = item as unknown[];
      if (v !== undefined && v !== null) pairs.push([String(v), String(label ?? v)]);
    } else if (typeof item === 'string' || typeof item === 'number') {
      pairs.push([String(item), String(item)]);
    }
  }
  return pairs;
}

/**
 * The definition a `mst_custom_field` row of `biblio`, `item` or `member` becomes (§11.4), or null for another table.
 * The option list comes from the serialized `data`; a broken payload keeps the strings it quotes, paired as value and
 * label. A member's field is never public nor searchable (what a member's field holds is personal data).
 */
export function slimsCustomField(row: SlimsRow, text: (column: string) => string): SlimsCustomField | null {
  const table = text('primary_table').toLowerCase();
  const entity: CustomFieldEntity | null = table === 'biblio' ? 'records' : table === 'item' ? 'items' : table === 'member' ? 'members' : null;
  if (entity === null) return null;
  const problems: SlimsCustomField['problems'] = [];
  const slimsType = text('type').toLowerCase();
  let type: CustomFieldType = Object.hasOwn(CUSTOM_TYPES, slimsType) ? CUSTOM_TYPES[slimsType]! : 'text';
  if (!Object.hasOwn(CUSTOM_TYPES, slimsType)) problems.push({ code: 'custom_field_type_unknown', detail: `${cutChars(slimsType, 20)} -> text` });
  let broken: SlimsCustomField['broken'] = null;
  let pairs: [string, string][] = [];
  const data = text('data');
  if (type === 'select' || type === 'multiselect') {
    if (data !== '') {
      const parsed = phpUnserialize(data);
      if (parsed.ok) pairs = optionPairs(parsed.value);
      else {
        broken = { stored: data, strings: parsed.strings };
        for (let i = 0; i < parsed.strings.length; i += 2) pairs.push([parsed.strings[i]!, parsed.strings[i + 1] ?? parsed.strings[i]!]);
        problems.push({ code: 'php_broken', detail: `data: ${parsed.strings.length} teks terbaca / strings recovered` });
      }
    }
  }
  const options: SlimsCustomField['options'] = [];
  const values = new Set<string>();
  let bytes = 2;
  for (const [v, label] of pairs) {
    const value = cutChars(oneLine(v), NAME_MAX);
    if (value === '' || values.has(value)) continue;
    const option = { value, label_id: cutChars(oneLine(label), NAME_MAX) || value, label_en: null };
    const size = Buffer.byteLength(JSON.stringify(option), 'utf8') + 1;
    if (options.length >= OPTIONS_MAX || bytes + size > OPTIONS_JSON_MAX_BYTES) {
      problems.push({ code: 'custom_field_options_cut', detail: `${options.length} opsi disimpan / options kept` });
      break;
    }
    values.add(value);
    options.push(option);
    bytes += size;
  }
  if ((type === 'select' || type === 'multiselect') && options.length === 0) {
    problems.push({ code: 'custom_field_no_options', detail: `${type} -> text` });
    type = 'text';
  }
  const code = text('dbfield');
  return {
    entity,
    code,
    type,
    label: cutChars(oneLine(text('label')), NAME_MAX) || code,
    options: type === 'select' || type === 'multiselect' ? options : [],
    isPublic: entity !== 'members' && intOf(text('is_public')) === 1,
    isSearchable: entity !== 'members' && intOf(text('indexed')) === 1,
    sortOrder: Math.max(0, Math.min(2_147_483_647, intOf(text('field_id')) ?? 0)),
    problems,
    broken,
  };
}

async function customFieldBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_custom_field';
  const maps = new Maps(c, T);
  const planned = new Map<string, string>();
  const fresh = await freshRows(c, io, l, T, rows, ['dbfield']);
  countUnmapped(l, fresh, CUSTOM_FIELD_UNMAPPED);
  for (const { key, row, replay } of fresh) {
    const def = slimsCustomField(row, (column) => oneLine(textOf(l, T, column, row[column]) ?? ''));
    if (def === null) {
      l.skipped(T, 'phase3');
      l.report(T, key, 'custom_field_not_migrated', `primary_table=${cutChars(keyOf(row['primary_table']), 40)}`);
      continue;
    }
    if (!codeFits(def.code)) {
      l.skipped(T, 'invalid_code');
      l.report(T, key, 'invalid_code', 'Kode ruas tambahan tidak dapat dipakai / The custom field code cannot be used');
      continue;
    }
    for (const p of def.problems) l.report(T, key, p.code, p.detail);
    if (def.broken !== null) l.fixed(`${T}.data`, ['php'], def.broken.stored, JSON.stringify(def.broken.strings));
    const ck = codeKey(def.code);
    const plannedKey = `${def.entity}\u0000${ck}`;
    // A replay merged only when its first attempt marked it so; it looks the definition up as that attempt did.
    const merging = replay === null || replay.marks.has('merged');
    const stored =
      planned.has(plannedKey) || !merging
        ? undefined
        : await io.db.selectFrom('custom_field_defs').select(['id', 'type']).where('entity', '=', def.entity).where('code_key', '=', ck).executeTakeFirst();
    let id = merging ? (planned.get(plannedKey) ?? stored?.id) : undefined;
    if (id !== undefined) {
      if (stored !== undefined && stored.type !== def.type) l.report(T, key, 'custom_field_type_differs', `${stored.type} / ${def.type}`);
      l.merged(T);
      maps.mark(key, id, 'merged');
    } else if (replay !== null) {
      id = replay.targetId;
      l.migrated(T);
    } else {
      id = newId(c.now);
      const values: Insertable<DB['custom_field_defs']> = {
        id,
        entity: def.entity,
        code_key: ck,
        code_display: def.code,
        label: def.label,
        label_en: null,
        type: def.type,
        options: def.options.length === 0 ? null : JSON.stringify(def.options),
        is_required: 0,
        sort_order: def.sortOrder,
        is_public: def.isPublic ? 1 : 0,
        is_searchable: def.isSearchable ? 1 : 0,
        ...trail(c.now),
      };
      await io.trx?.insertInto('custom_field_defs').values(values).execute();
      l.migrated(T);
    }
    planned.set(plannedKey, id);
    maps.add(key, id);
  }
  await maps.write(io);
}

// ---- settings: SRU servers and barcode patterns ---------------------------------------------------------------------

/** An id for a settings entry (`catalogConfigIdField`: `a-z 0-9 -`, 1–32) from the run's source name and `n`, not in `taken`. */
function configId(c: SlimsStageContext, n: string, taken: ReadonlySet<string>): string {
  const base = c.options.sourceName.replace(/_/g, '-').slice(0, 20);
  const tail = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 8) || 'x';
  for (let k = 1; ; k += 1) {
    const id = `${base}-${tail}${k === 1 ? '' : `-${k}`}`.slice(0, 32).replace(/-+$/, '');
    if (!taken.has(id)) return id;
  }
}

/** The SRU type of `mst_servers.server_type` (4: MARC SRU). */
const MARC_SRU = 4;
const SRU_MAX = 10;
const PATTERNS_MAX = 20;

async function serversBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'mst_servers';
  const maps = new Maps(c, T);
  const list = [...((await readSettings(io.db, ['catalog.sru.servers'], []))['catalog.sru.servers'] as SruServer[])];
  let changed = false;
  for (const { key, row, replay } of await freshRows(c, io, l, T, rows, ['server_id'])) {
    const name = line(l, T, key, 'name', row, 64) || `SLiMS ${key}`.slice(0, 64);
    const type = intOf(row['server_type']);
    if (type !== MARC_SRU) {
      l.skipped(T, 'server_type');
      l.report(T, key, 'server_not_migrated', `${cutChars(name, 60)}: server_type=${type ?? '?'}`);
      continue;
    }
    const url = oneLine(textOf(l, T, 'uri', row['uri']) ?? '');
    if (replay !== null) {
      // The list holds the entry since its first attempt: counted (and reported) as that attempt was.
      if (replay.marks.has('merged')) l.merged(T);
      else {
        l.migrated(T);
        l.report(T, key, 'server_disabled', `${cutChars(name, 60)}: dinonaktifkan sampai diperiksa / disabled until checked`);
      }
      maps.add(key, c.runId);
      continue;
    }
    const entry = SruServer.safeParse({
      id: configId(c, key, new Set(list.map((s) => s.id))),
      name,
      url,
      version: '1.2',
      recordSchema: 'marcxml',
      indexes: { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' },
      enabled: false,
    });
    if (!entry.success || url === '') {
      l.skipped(T, 'invalid_url');
      l.report(T, key, 'server_invalid_url', `${cutChars(name, 60)}: ${cutChars(url, 120)}`);
      continue;
    }
    if (list.some((s) => s.url === url)) {
      l.merged(T);
      maps.mark(key, c.runId, 'merged');
    } else if (list.length >= SRU_MAX) {
      l.skipped(T, 'list_full');
      l.report(T, key, 'list_full', `catalog.sru.servers: ${SRU_MAX}`);
      continue;
    } else {
      list.push(entry.data);
      changed = true;
      l.migrated(T);
      l.report(T, key, 'server_disabled', `${cutChars(name, 60)}: dinonaktifkan sampai diperiksa / disabled until checked`);
    }
    maps.add(key, c.runId);
  }
  if (changed && io.trx !== null) await writeSettings(io.trx, { 'catalog.sru.servers': list }, { keyring: [], now: c.now, actorId: null });
  await maps.write(io);
}

/** A SLiMS item code pattern (`B00000`: prefix, a run of zeros for the number, suffix) as an ALTIS pattern, or null. */
function patternOf(s: string): { prefix: string; digits: number; suffix: string } | null {
  const m = /^(.*?)(0+)([^0-9]*)$/.exec(s.trim());
  if (m === null) return null;
  const parsed = BarcodePattern.safeParse({ id: 'x', name: 'x', prefix: m[1], digits: m[2]!.length, suffix: m[3] });
  return parsed.success ? { prefix: parsed.data.prefix, digits: parsed.data.digits, suffix: parsed.data.suffix } : null;
}

async function settingBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'setting';
  const maps = new Maps(c, T);
  const list = [...((await readSettings(io.db, ['catalog.barcode.patterns'], []))['catalog.barcode.patterns'] as BarcodePattern[])];
  let changed = false;
  for (const { key, row, replay } of await freshRows(c, io, l, T, rows, ['setting_id'])) {
    const name = keyOf(row['setting_name']).toLowerCase();
    if (name.endsWith('_print_settings')) {
      l.skipped(T, 'print_settings');
      l.report(T, key, 'print_settings_not_migrated', cutChars(name, 60));
      continue;
    }
    if (name !== 'batch_item_code_pattern') {
      l.skipped(T, 'not_mapped');
      continue;
    }
    const stored = textOf(l, T, 'setting_value', row['setting_value']) ?? '';
    const parsed = phpUnserialize(stored);
    let strings: string[];
    if (parsed.ok) strings = optionPairs(parsed.value).map(([v]) => v);
    else {
      strings = parsed.strings;
      l.fixed(`${T}.setting_value`, ['php'], stored, JSON.stringify(strings));
      l.report(T, key, 'php_broken', `batch_item_code_pattern: ${strings.length} teks terbaca / strings recovered`);
    }
    let added = 0;
    let existing = 0;
    for (const s of strings) {
      const p = patternOf(s);
      if (p === null) {
        l.report(T, key, 'barcode_pattern_unsupported', cutChars(s, 60));
        continue;
      }
      if (list.some((x) => x.prefix === p.prefix && x.digits === p.digits && x.suffix === p.suffix)) {
        existing += 1;
        continue;
      }
      if (list.length >= PATTERNS_MAX) {
        l.report(T, key, 'list_full', `catalog.barcode.patterns: ${PATTERNS_MAX}`);
        continue;
      }
      // A replay's patterns are in the list since its first attempt; one missing there was not added then either.
      if (replay !== null) continue;
      list.push({ id: configId(c, `p${list.length}`, new Set(list.map((x) => x.id))), name: `SLiMS ${cutChars(oneLine(s), 50)}`, ...p });
      added += 1;
    }
    if (replay !== null) {
      if (replay.marks.has('merged')) l.merged(T);
      else l.migrated(T);
    } else if (added > 0) {
      changed = true;
      l.migrated(T);
    } else if (existing > 0) {
      l.merged(T);
      maps.mark(key, c.runId, 'merged');
    } else {
      l.skipped(T, 'invalid_pattern');
      continue;
    }
    maps.add(key, c.runId);
  }
  if (changed && io.trx !== null) await writeSettings(io.trx, { 'catalog.barcode.patterns': list }, { keyring: [], now: c.now, actorId: null });
  await maps.write(io);
}

// ---- the stage ------------------------------------------------------------------------------------------------------

const scan = (table: string, batch: ScanStep['batch'], unmapped?: readonly string[]): ScanStep => ({
  kind: 'scan',
  table,
  batch,
  ...(unmapped === undefined ? {} : { unmapped }),
});

const STEPS: readonly ScanStep[] = Object.freeze([
  scan('mst_gmd', gmdBatch, GMD_UNMAPPED),
  rdaStep('content', 'mst_content_type', 'content_type'),
  rdaStep('media', 'mst_media_type', 'media_type'),
  rdaStep('carrier', 'mst_carrier_type', 'carrier_type'),
  scan('mst_language', languageBatch),
  scan('mst_publisher', publisherBatch),
  scan('mst_place', placeBatch),
  scan('mst_author', authorBatch),
  scan('mst_topic', topicBatch),
  scan('mst_voc_ctrl', vocBatch),
  scan('mst_relation_term', relationTermBatch),
  scan('mst_location', locationBatch),
  scan('mst_coll_type', collTypeBatch),
  scan('mst_supplier', supplierBatch),
  scan('mst_custom_field', customFieldBatch, CUSTOM_FIELD_UNMAPPED),
  scan('mst_servers', serversBatch),
  scan('setting', settingBatch),
]);

/**
 * Data induk and authorities (§11.3 step 2, §11.4): GMD, RDA codes, languages, publishers, places, authors, topics and
 * the thesaurus, locations, collection types, suppliers, custom field definitions, SRU servers and the barcode pattern.
 */
export const mastersStage: SlimsStage = Object.freeze({
  name: 'masters' as const,
  reads: Object.freeze(STEPS.map((s) => s.table)),
  run: (c: SlimsStageContext, cursor: string | null) => runSteps(c, 'masters', STEPS, cursor),
});
