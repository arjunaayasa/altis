import type { DB } from '@altis/db';
import { DomainError, newId, normalizeKey, type RelatorRole } from '@altis/shared';
import { issueCode } from '@altis/shared/api/common';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import type { MaterialTypeTemplate } from '@altis/shared/api/catalog/masters';
import type { MarcExtraField } from '@altis/shared/api/catalog/record-data';
import { RecordCreateBody, RecordPatchBody } from '@altis/shared/api/catalog/records';
import type { AgentRefInput, PublisherRefInput, SubjectRefInput } from '@altis/shared/api/catalog/records';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { z } from 'zod';
import type { TxCtx } from '../../context.js';
import { publish } from '../../events/publish.js';
import { indexRecords } from '../../search/index-records.js';
import { resolveAgents, resolvePublisher, resolveSubjects } from '../data/authorities.js';
import { customValuesSchema, loadCustomDefs, readCustomValues, writeCustomValues, type CustomFieldDef } from '../data/custom-fields.js';
import { titleKey } from '../lib/title-key.js';
import { identifierRows, type IdentifierRow } from './identifiers.js';
import { storeRecordLinks } from './links.js';
import { relationRows, writeRelations, type RelationRow } from './relations.js';
import { parseTemplate, presenceOf, templateErrors, type TemplateKey, type TemplatePresence } from './template.js';

// Saving bibliographic records (Phase 2 spec §3.1–§3.3, §3.7, §3.8; plan Task 16), archiving and restoring them. Every
// write path of a record goes through here: the editor (`POST`/`PATCH catalog/records`), imports, SRU and ISBN copies
// and the SLiMS migration (through recordBodyFromDraft, in `bulk` mode).
//
// - A body is parsed again with the strict contract (RecordCreateBody / RecordPatchBody), so a body built by an
//   importer meets the same widths as one from the API. Then everything is checked before anything is written: the
//   material type and language (`not_found`, `archived`), the template (§3.8, template.ts), the ids of the authority
//   refs (`not_found` at `publisher`, `agents.<i>.ref`, `subjects.<i>.ref`), the relations (relations.ts) and the custom
//   values (§3.7). All of them in one VALIDATION_FAILED, in that order. So a refused record writes nothing, and a
//   bulk caller can catch the refusal and go on with the next record in the same transaction.
// - Authorities named by text are found by key or created (Task 1's resolve*, P2-10: no audit entry of their own;
//   the record's entry counts them in `meta.authoritiesCreated`).
// - Both create and update write `title_key` and `changed_at = now` and index the record (`indexRecords`, §4.1) in
//   the same transaction. `interactive` (the default) then audits (`catalog.record.create` / `.update`, `meta {fields,
//   authoritiesCreated}`: field names and a count, never values) and publishes `catalog.record.changed {id}` as the
//   transaction's last statement; `bulk` does neither (its caller audits the run once and publishes
//   `catalog.bulk.changed`).
// - Concurrency: an update, an archive or a restore first locks the record's row with a write that changes nothing
//   (as lockStaffRow does): concurrent writers of the record serialize, and on MySQL/MariaDB (REPEATABLE READ) the
//   reads that follow see the latest commit when the lock is the transaction's first statement. `version` is then
//   compared (CONFLICT_STALE) and bumped by the one UPDATE that writes the row. An update's lock matches only the
//   version it was sent, of a record not merged (lockRecordAt): the WHERE of an UPDATE reads the latest commit on every
//   engine, while a transaction that read before (an import batch, whose MySQL/MariaDB snapshot predates the lock, and
//   a write that changes nothing does not refresh it) would read the record as it was. So a record changed meanwhile is
//   CONFLICT_STALE before any of its lists is written.
// - The material type and the language a record is given (a create, or a change of either) are locked by a write that
//   matches only a live row before they are relied on (lockLiveMaster; Task 40, T12 concern 1): their archive locks
//   the row first and then counts the live records that use it (archiveMaster), so it waits for a record saved
//   against the live row and counts it, and a record saved after the archive committed is refused (`archived`),
//   whatever its transaction read before. An update locks the record's row first, then these.
// - A record merged into another (§3.3) is archived for good: editing or restoring it is CATALOG_MERGE_INVALID.
// - Empty texts are stored as null.

type Db = Kysely<DB> | Transaction<DB>;
type RecordRow = Selectable<DB['records']>;

/** How a record is saved: `interactive` audits and publishes; `bulk` (imports, migration) leaves both to the caller. */
export interface RecordSaveOptions {
  mode?: 'interactive' | 'bulk';
  /**
   * `records.source` for a caller that is not a client (`import:<runId>`, `slims:<id>`; ≤ 191 characters); wins over
   * the body's `source`. A record saved without either is `manual`.
   */
  source?: string;
}

/** What a save answers: the record's id and new version, the warnings of what was stored anyway, the authorities created. */
export interface RecordSaveResult {
  id: string;
  version: number;
  warnings: FieldWarning[];
  authoritiesCreated: number;
}

const ID_BATCH = 500;
const SOURCE_MAX = 191;

// ---- errors ----------------------------------------------------------------------------------------------------------

export function validationFailed(errors: FieldWarning[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data cantuman tidak valid / The record data is not valid',
    meta: { errors },
  });
}

export function recordNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Cantuman tidak ditemukan / Record not found' });
}

export function recordStale(): DomainError {
  return new DomainError('CONFLICT_STALE', {
    detail: 'Cantuman sudah diubah orang lain; muat ulang / The record was changed by someone else; reload it',
  });
}

export function mergedRecord(): DomainError {
  return new DomainError('CATALOG_MERGE_INVALID', {
    detail: 'Cantuman ini sudah digabungkan ke cantuman lain / This record was merged into another one',
  });
}

/** The issues of a failed parse as field errors (`path` dot-joined, D10). */
function issuesToErrors(issues: readonly z.core.$ZodIssue[], prefix = ''): FieldWarning[] {
  return issues.map((issue) => ({ path: [prefix, ...issue.path.map(String)].filter((p) => p !== '').join('.'), code: issueCode(issue) }));
}

/** `body` parsed with `schema`, or VALIDATION_FAILED with its issues. */
function parseOrFail<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw validationFailed(issuesToErrors(parsed.error.issues));
  return parsed.data;
}

// ---- rows ------------------------------------------------------------------------------------------------------------

/** The record `id`, or NOT_FOUND. */
export async function readRecordRow(db: Db, id: string): Promise<RecordRow> {
  const row = await db.selectFrom('records').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw recordNotFound();
  return row;
}

/**
 * Locks the rows of `ids` with a write that changes nothing (see the top of this file). Run it as the first statement
 * of the action, so that what is read afterwards is the latest commit. One statement for all of them: the rows are
 * locked in index order, the same in every transaction (no deadlock between two merges of the same pair).
 */
export async function lockRecordRows(trx: Transaction<DB>, ids: readonly string[]): Promise<void> {
  await trx
    .updateTable('records')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', 'in', [...new Set(ids)])
    .execute();
}

/**
 * Locks the record `id` as {@link lockRecordRows} does, with a write that matches only while the record holds
 * `version` and is not merged; whether it matched (mysql2 counts matched rows: CLIENT_FOUND_ROWS). The UPDATE's WHERE
 * reads the latest commit and waits for a writer of the row, so the answer holds wherever the action runs in its
 * transaction (see the top of this file).
 */
async function lockRecordAt(trx: Transaction<DB>, id: string, version: number): Promise<boolean> {
  const locked = await trx
    .updateTable('records')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('version', '=', version)
    .where('merged_into', 'is', null)
    .executeTakeFirst();
  return Number(locked.numUpdatedRows) === 1;
}

/** Indexes `ids` and, in interactive mode, audits `e` and publishes `catalog.record.changed` for each id, last. */
export async function afterRecordWrite(
  tx: TxCtx,
  ids: readonly string[],
  e: Parameters<TxCtx['audit']>[0] | null,
): Promise<void> {
  await indexRecords(tx.trx, ids, tx.now);
  if (e === null) return;
  await tx.audit(e);
  for (const id of ids) await publish(tx.trx, { channel: 'catalog', type: 'catalog.record.changed', payload: { id } });
}

/** '' (or blank) as null; any other text as it is. */
function textOrNull(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  return v.trim() === '' ? null : v;
}

/** The body keys of the scalar columns, and their columns. */
const SCALAR_COLUMNS = Object.freeze({
  subtitle: 'subtitle',
  responsibility: 'responsibility',
  edition: 'edition',
  materialDetail: 'material_detail',
  publicationPlace: 'publication_place',
  publicationYear: 'publication_year',
  publicationDateText: 'publication_date_text',
  physicalDesc: 'physical_desc',
  series: 'series',
  classification: 'classification',
  callNumber: 'call_number',
  contentType: 'content_type',
  mediaType: 'media_type',
  carrierType: 'carrier_type',
  summary: 'summary',
  notes: 'notes',
} as const);

type ScalarKey = keyof typeof SCALAR_COLUMNS;
type ScalarColumn = (typeof SCALAR_COLUMNS)[ScalarKey];

const SCALAR_KEYS = Object.keys(SCALAR_COLUMNS) as ScalarKey[];

// ---- checks ----------------------------------------------------------------------------------------------------------

/**
 * Locks the master row `id` of `table` with a write that changes nothing and matches only a live row; whether it
 * matched (see the top of this file). The UPDATE's WHERE reads the latest commit on every engine and waits for a
 * writer of the row, where a plain read may show an older snapshot (MySQL/MariaDB, an import batch).
 */
async function lockLiveMaster(trx: Transaction<DB>, table: 'material_types' | 'languages', id: string): Promise<boolean> {
  // Both tables have `id`, `version` and `archived_at`; Kysely cannot narrow a union of table names.
  const locked = await trx
    .updateTable(table as 'languages')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  return Number(locked.numUpdatedRows) === 1;
}

/** The material type `id` (any state) with its template, or undefined. */
async function materialTypeOf(db: Db, id: string): Promise<{ archived: boolean; template: MaterialTypeTemplate } | undefined> {
  const row = await db.selectFrom('material_types').select(['archived_at', 'template']).where('id', '=', id).executeTakeFirst();
  return row === undefined ? undefined : { archived: row.archived_at !== null, template: parseTemplate(row.template) };
}

/** The ids of `ids` that name no row of `table`. */
async function missingIds(db: Db, table: 'agents' | 'subjects' | 'publishers', ids: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(ids)];
  const found = new Set<string>();
  for (let i = 0; i < wanted.length; i += ID_BATCH) {
    const rows = await db
      .selectFrom(table as 'agents')
      .select('id')
      .where('id', 'in', wanted.slice(i, i + ID_BATCH))
      .execute();
    for (const r of rows) found.add(r.id);
  }
  return new Set(wanted.filter((id) => !found.has(id)));
}

const isIdRef = (ref: AgentRefInput | SubjectRefInput | PublisherRefInput): ref is { id: string } => 'id' in ref;

/** The errors of the `{id}` refs that name no authority: `publisher`, `agents.<i>.ref`, `subjects.<i>.ref`. */
async function authorityRefErrors(
  db: Db,
  input: { publisher?: PublisherRefInput | null | undefined; agents?: { ref: AgentRefInput }[] | undefined; subjects?: { ref: SubjectRefInput }[] | undefined },
): Promise<FieldWarning[]> {
  const errors: FieldWarning[] = [];
  if (input.publisher !== undefined && input.publisher !== null && isIdRef(input.publisher)) {
    if ((await missingIds(db, 'publishers', [input.publisher.id])).size > 0) errors.push({ path: 'publisher', code: 'not_found' });
  }
  const lists = [
    ['agents', 'agents', input.agents] as const,
    ['subjects', 'subjects', input.subjects] as const,
  ];
  for (const [path, table, list] of lists) {
    if (list === undefined) continue;
    const ids = list.flatMap((x) => (isIdRef(x.ref) ? [x.ref.id] : []));
    if (ids.length === 0) continue;
    const missing = await missingIds(db, table, ids);
    list.forEach((x, i) => {
      if (isIdRef(x.ref) && missing.has(x.ref.id)) errors.push({ path: `${path}.${i}.ref`, code: 'not_found' });
    });
  }
  return errors;
}

/**
 * The custom values of a body checked against the live definitions (§3.7): a code `required` only where the
 * material type's template shows it (`customFields`), since the editor offers only those. Errors at `custom.<code>`;
 * a required code without a value is `required`.
 */
function checkCustom(
  defs: readonly CustomFieldDef[],
  template: MaterialTypeTemplate,
  custom: Record<string, unknown> | undefined,
  mode: 'create' | 'patch',
): { values: Record<string, unknown>; errors: FieldWarning[] } {
  const shown = new Set(template.customFields.map((c) => normalizeKey(c)));
  const adjusted = defs.map((d) => ({ ...d, required: d.required && shown.has(normalizeKey(d.code)) }));
  const input = custom ?? {};
  const parsed = customValuesSchema(adjusted, mode).safeParse(input);
  if (parsed.success) return { values: parsed.data, errors: [] };
  const errors = parsed.error.issues.map((issue) => {
    const code = issue.path.length === 1 ? String(issue.path[0]) : null;
    const missing = code !== null && issue.code === 'invalid_type' && (!Object.hasOwn(input, code) || input[code] === null);
    return { path: ['custom', ...issue.path.map(String)].join('.'), code: missing ? 'required' : issueCode(issue) };
  });
  return { values: {}, errors };
}

/**
 * The language `id`, locked while live (lockLiveMaster): its error at `languageId`, `not_found` or `archived` (null
 * when it is live).
 */
async function languageError(trx: Transaction<DB>, id: string): Promise<FieldWarning | null> {
  if (await lockLiveMaster(trx, 'languages', id)) return null;
  const row = await trx.selectFrom('languages').select('archived_at').where('id', '=', id).executeTakeFirst();
  // None matched: gone or archived; an older snapshot may still show it live.
  return { path: 'languageId', code: row === undefined ? 'not_found' : 'archived' };
}

// ---- lists -----------------------------------------------------------------------------------------------------------

interface AgentLink {
  agent_id: string;
  role: RelatorRole;
  is_main: 0 | 1;
  sort_order: number;
}

interface SubjectLink {
  subject_id: string;
  is_primary: 0 | 1;
  sort_order: number;
}

/** The agent links of resolved ids (`ids[i]` for `list[i]`), the same `(agent, role)` once. */
function agentLinks(list: readonly { role: RelatorRole; isMain: boolean }[], ids: readonly string[]): AgentLink[] {
  const links: AgentLink[] = [];
  const seen = new Set<string>();
  list.forEach((a, i) => {
    const agentId = ids[i] as string;
    const key = `${agentId}:${a.role}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ agent_id: agentId, role: a.role, is_main: a.isMain ? 1 : 0, sort_order: links.length });
  });
  return links;
}

/** The subject links of resolved ids, each subject once. */
function subjectLinks(list: readonly { isPrimary: boolean }[], ids: readonly string[]): SubjectLink[] {
  const links: SubjectLink[] = [];
  const seen = new Set<string>();
  list.forEach((s, i) => {
    const subjectId = ids[i] as string;
    if (seen.has(subjectId)) return;
    seen.add(subjectId);
    links.push({ subject_id: subjectId, is_primary: s.isPrimary ? 1 : 0, sort_order: links.length });
  });
  return links;
}

/** Inserts `rows` into `table` in batches (every engine caps a statement's parameters). */
async function insertBatches<T extends Record<string, unknown>>(
  trx: Transaction<DB>,
  table: 'record_identifiers' | 'record_agents' | 'record_subjects' | 'record_marc_extra',
  rows: readonly T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += ID_BATCH) {
    // The four tables take what each caller builds for them; Kysely cannot narrow a union of table names.
    await trx
      .insertInto(table as 'record_identifiers')
      .values(rows.slice(i, i + ID_BATCH) as never)
      .execute();
  }
}

async function writeIdentifiers(trx: Transaction<DB>, recordId: string, rows: readonly IdentifierRow[], now: number): Promise<void> {
  await trx.deleteFrom('record_identifiers').where('record_id', '=', recordId).execute();
  await insertBatches(
    trx,
    'record_identifiers',
    rows.map((r) => ({ id: newId(now), record_id: recordId, ...r })),
  );
}

async function writeAgentLinks(trx: Transaction<DB>, recordId: string, links: readonly AgentLink[]): Promise<void> {
  await trx.deleteFrom('record_agents').where('record_id', '=', recordId).execute();
  await insertBatches(
    trx,
    'record_agents',
    links.map((l) => ({ record_id: recordId, ...l })),
  );
}

async function writeSubjectLinks(trx: Transaction<DB>, recordId: string, links: readonly SubjectLink[]): Promise<void> {
  await trx.deleteFrom('record_subjects').where('record_id', '=', recordId).execute();
  await insertBatches(
    trx,
    'record_subjects',
    links.map((l) => ({ record_id: recordId, ...l })),
  );
}

async function writeMarcExtra(trx: Transaction<DB>, recordId: string, fields: readonly MarcExtraField[], now: number): Promise<void> {
  await trx.deleteFrom('record_marc_extra').where('record_id', '=', recordId).execute();
  await insertBatches(
    trx,
    'record_marc_extra',
    fields.map((f, i) => ({ id: newId(now), record_id: recordId, tag: f.tag, ind1: f.ind1, ind2: f.ind2, data: f.data, sort_order: i })),
  );
}

/** Two lists of plain rows (or texts) hold the same entries in the same order. */
function sameRows(a: readonly unknown[], b: readonly unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- create and update -----------------------------------------------------------------------------------------------

/** `o.source` checked: a caller's own value (TypeError when it does not fit `records.source`). */
function sourceOption(o: RecordSaveOptions): string | undefined {
  const s = o.source;
  if (s === undefined) return undefined;
  if (typeof s !== 'string' || s === '' || Array.from(s).length > SOURCE_MAX || /\p{Cc}/u.test(s)) {
    throw new TypeError(`record source ${JSON.stringify(s)} is not 1-${SOURCE_MAX} characters without control characters`);
  }
  return s;
}

/**
 * Creates a record (see the top of this file) and answers its id, version 0, the warnings of the identifiers stored
 * as not valid and of the links skipped (S4), and how many authorities it created.
 *
 * @throws DomainError VALIDATION_FAILED with every field error (nothing written)
 */
export async function createRecord(tx: TxCtx, body: RecordCreateBody, o: RecordSaveOptions = {}): Promise<RecordSaveResult> {
  const { trx } = tx;
  const b = parseOrFail(RecordCreateBody, body);
  const source = sourceOption(o) ?? b.source ?? 'manual';

  const errors: FieldWarning[] = [];
  const typeLive = await lockLiveMaster(trx, 'material_types', b.materialTypeId);
  const type = await materialTypeOf(trx, b.materialTypeId);
  if (type === undefined) errors.push({ path: 'materialTypeId', code: 'not_found' });
  else if (type.archived || !typeLive) errors.push({ path: 'materialTypeId', code: 'archived' });
  const template = type?.template;
  if (template !== undefined) {
    const presence = presenceOf(b as Partial<Record<TemplateKey, unknown>>);
    errors.push(...templateErrors(template, presence, presence));
  }
  if (b.languageId !== undefined && b.languageId !== null) {
    const e = await languageError(trx, b.languageId);
    if (e !== null) errors.push(e);
  }
  errors.push(...(await authorityRefErrors(trx, b)));
  const relations = await relationRows(trx, null, b.relations ?? []);
  errors.push(...relations.errors);
  const defs = await loadCustomDefs(trx, 'records');
  const custom = template === undefined ? { values: {}, errors: [] } : checkCustom(defs, template, b.custom, 'create');
  errors.push(...custom.errors);
  if (errors.length > 0) throw validationFailed(errors);

  const identifiers = identifierRows(b.identifiers ?? []);
  const publisher = await resolvePublisher(tx, b.publisher ?? null);
  const agents = await resolveAgents(tx, (b.agents ?? []).map((a) => a.ref));
  const subjects = await resolveSubjects(tx, (b.subjects ?? []).map((s) => s.ref));
  const authoritiesCreated = (publisher.created ? 1 : 0) + agents.created + subjects.created;

  const id = newId(tx.now);
  const scalars = Object.fromEntries(SCALAR_KEYS.map((k) => [SCALAR_COLUMNS[k], textOrNull(b[k])])) as Record<ScalarColumn, string | null>;
  await trx
    .insertInto('records')
    .values({
      id,
      material_type_id: b.materialTypeId,
      title: b.title,
      title_key: titleKey(b.title, scalars.subtitle),
      ...scalars,
      publisher_id: publisher.id,
      language_id: b.languageId ?? null,
      cover_file_id: null,
      opac_visible: b.opacVisible === false ? 0 : 1,
      promoted: b.promoted === true ? 1 : 0,
      source,
      merged_into: null,
      changed_at: tx.now,
      archived_at: null,
      created_at: tx.now,
      created_by: tx.actor.id,
      updated_at: tx.now,
      updated_by: tx.actor.id,
    })
    .execute();
  await insertBatches(
    trx,
    'record_identifiers',
    identifiers.rows.map((r) => ({ id: newId(tx.now), record_id: id, ...r })),
  );
  await insertBatches(
    trx,
    'record_agents',
    agentLinks(b.agents ?? [], agents.ids).map((l) => ({ record_id: id, ...l })),
  );
  await insertBatches(
    trx,
    'record_subjects',
    subjectLinks(b.subjects ?? [], subjects.ids).map((l) => ({ record_id: id, ...l })),
  );
  if (relations.rows.length > 0) await writeRelations(trx, id, relations.rows);
  if ((b.marcExtra ?? []).length > 0) await writeMarcExtra(trx, id, b.marcExtra ?? [], tx.now);
  if (Object.keys(custom.values).length > 0) await writeCustomValues(trx, 'records', id, custom.values, defs, { now: tx.now, actor: tx.actor.id });
  const linkWarnings = await storeRecordLinks(tx, id, b.links ?? []);

  const fields = Object.keys(b).filter((k) => b[k as keyof typeof b] !== undefined);
  await afterRecordWrite(
    tx,
    [id],
    (o.mode ?? 'interactive') === 'interactive'
      ? { action: 'catalog.record.create', entity: 'records', entityId: id, meta: { fields, authoritiesCreated } }
      : null,
  );
  return { id, version: 0, warnings: [...identifiers.warnings, ...linkWarnings], authoritiesCreated };
}

/** How many identifiers, agents and subjects the record holds, for a `required` list the patch does not send. */
async function storedListPresence(db: Db, id: string, keys: readonly ('identifiers' | 'agents' | 'subjects')[]): Promise<TemplatePresence> {
  const out: TemplatePresence = {};
  for (const key of keys) {
    const table = key === 'identifiers' ? 'record_identifiers' : key === 'agents' ? 'record_agents' : 'record_subjects';
    const row = await db
      .selectFrom(table as 'record_agents')
      .select('record_id')
      .where('record_id', '=', id)
      .limit(1)
      .executeTakeFirst();
    out[key] = row !== undefined;
  }
  return out;
}

/**
 * Changes the fields `patch` sends (a list sent replaces the record's list) and answers as {@link createRecord}, with
 * the new version. `meta.fields` of the audit entry names the fields whose value really changed.
 *
 * @throws DomainError NOT_FOUND; CATALOG_MERGE_INVALID for a merged record; CONFLICT_STALE when `patch.version` is
 *   not the row's; VALIDATION_FAILED with every field error (nothing written)
 */
export async function updateRecord(tx: TxCtx, id: string, patch: RecordPatchBody, o: RecordSaveOptions = {}): Promise<RecordSaveResult> {
  const { trx } = tx;
  const p = parseOrFail(RecordPatchBody, patch);
  const sourceOverride = sourceOption(o);
  // The version on the latest commit, before anything is written (see the top of this file). When it matched and the
  // snapshot holds the same version, the row read next is the latest commit: every write of a record's fields bumps
  // its version.
  const current = await lockRecordAt(trx, id, p.version);
  const before = await readRecordRow(trx, id);
  if (before.merged_into !== null) throw mergedRecord();
  if (!current || Number(before.version) !== p.version) throw recordStale();

  const errors: FieldWarning[] = [];
  const materialTypeId = p.materialTypeId ?? before.material_type_id;
  // A new material type must be live (and is locked so, see the top of this file); the record may keep an archived one.
  const typeChanged = materialTypeId !== before.material_type_id;
  const typeLive = !typeChanged || (await lockLiveMaster(trx, 'material_types', materialTypeId));
  const type = await materialTypeOf(trx, materialTypeId);
  if (type === undefined) errors.push({ path: 'materialTypeId', code: 'not_found' });
  else if (typeChanged && (type.archived || !typeLive)) errors.push({ path: 'materialTypeId', code: 'archived' });
  const template = type?.template;

  // The record as it will be, for `required`; what the patch sends, for `hidden`.
  const sent = presenceOf(p as Partial<Record<TemplateKey, unknown>>);
  if (template !== undefined) {
    const result: TemplatePresence = {};
    for (const k of SCALAR_KEYS) result[k] = p[k] === undefined ? (before[SCALAR_COLUMNS[k]] ?? '').trim() !== '' : sent[k] === true;
    result.publisher = p.publisher === undefined ? before.publisher_id !== null : sent.publisher === true;
    result.languageId = p.languageId === undefined ? before.language_id !== null : sent.languageId === true;
    const lists = (['identifiers', 'agents', 'subjects'] as const).filter((k) => p[k] === undefined);
    const stored = await storedListPresence(trx, id, lists);
    for (const k of ['identifiers', 'agents', 'subjects'] as const) result[k] = p[k] === undefined ? stored[k] === true : sent[k] === true;
    errors.push(...templateErrors(template, result, sent));
  }
  if (p.languageId !== undefined && p.languageId !== null && p.languageId !== before.language_id) {
    const e = await languageError(trx, p.languageId);
    if (e !== null) errors.push(e);
  }
  errors.push(...(await authorityRefErrors(trx, p)));
  const relations = p.relations === undefined ? null : await relationRows(trx, id, p.relations);
  if (relations !== null) errors.push(...relations.errors);
  const defs = p.custom === undefined || template === undefined ? [] : await loadCustomDefs(trx, 'records');
  const custom = p.custom === undefined || template === undefined ? null : checkCustom(defs, template, p.custom, 'patch');
  if (custom !== null) errors.push(...custom.errors);
  if (errors.length > 0) throw validationFailed(errors);

  const changed: string[] = [];
  const set: Partial<Record<ScalarColumn, string | null>> & {
    material_type_id?: string;
    title?: string;
    publisher_id?: string | null;
    language_id?: string | null;
    opac_visible?: 0 | 1;
    promoted?: 0 | 1;
    source?: string;
  } = {};
  if (p.materialTypeId !== undefined && p.materialTypeId !== before.material_type_id) {
    changed.push('materialTypeId');
    set.material_type_id = p.materialTypeId;
  }
  if (p.title !== undefined && p.title !== before.title) {
    changed.push('title');
    set.title = p.title;
  }
  for (const k of SCALAR_KEYS) {
    if (p[k] === undefined) continue;
    const value = textOrNull(p[k]);
    if (value !== before[SCALAR_COLUMNS[k]]) {
      changed.push(k);
      set[SCALAR_COLUMNS[k]] = value;
    }
  }
  if (p.languageId !== undefined && p.languageId !== before.language_id) {
    changed.push('languageId');
    set.language_id = p.languageId;
  }
  if (p.opacVisible !== undefined && (p.opacVisible ? 1 : 0) !== Number(before.opac_visible)) {
    changed.push('opacVisible');
    set.opac_visible = p.opacVisible ? 1 : 0;
  }
  if (p.promoted !== undefined && (p.promoted ? 1 : 0) !== Number(before.promoted)) {
    changed.push('promoted');
    set.promoted = p.promoted ? 1 : 0;
  }
  const source = sourceOverride ?? p.source;
  if (source !== undefined && source !== before.source) {
    changed.push('source');
    set.source = source;
  }

  let authoritiesCreated = 0;
  if (p.publisher !== undefined) {
    const publisher = await resolvePublisher(tx, p.publisher);
    authoritiesCreated += publisher.created ? 1 : 0;
    if (publisher.id !== before.publisher_id) {
      changed.push('publisher');
      set.publisher_id = publisher.id;
    }
  }

  const warnings: FieldWarning[] = [];
  if (p.identifiers !== undefined) {
    const identifiers = identifierRows(p.identifiers);
    warnings.push(...identifiers.warnings);
    const stored = await trx
      .selectFrom('record_identifiers')
      .select(['type', 'value_display', 'value_key', 'qualifier', 'is_valid', 'sort_order'])
      .where('record_id', '=', id)
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
    if (!sameRows(stored.map((r) => ({ ...r, is_valid: Number(r.is_valid), sort_order: Number(r.sort_order) })), identifiers.rows)) {
      changed.push('identifiers');
      await writeIdentifiers(trx, id, identifiers.rows, tx.now);
    }
  }
  if (p.agents !== undefined) {
    const resolved = await resolveAgents(tx, p.agents.map((a) => a.ref));
    authoritiesCreated += resolved.created;
    const links = agentLinks(p.agents, resolved.ids);
    const stored = await trx.selectFrom('record_agents').select(['agent_id', 'role', 'is_main', 'sort_order']).where('record_id', '=', id).orderBy('sort_order').execute();
    if (!sameRows(stored.map((r) => ({ agent_id: r.agent_id, role: r.role, is_main: Number(r.is_main), sort_order: Number(r.sort_order) })), links)) {
      changed.push('agents');
      await writeAgentLinks(trx, id, links);
    }
  }
  if (p.subjects !== undefined) {
    const resolved = await resolveSubjects(tx, p.subjects.map((s) => s.ref));
    authoritiesCreated += resolved.created;
    const links = subjectLinks(p.subjects, resolved.ids);
    const stored = await trx.selectFrom('record_subjects').select(['subject_id', 'is_primary', 'sort_order']).where('record_id', '=', id).orderBy('sort_order').execute();
    if (!sameRows(stored.map((r) => ({ subject_id: r.subject_id, is_primary: Number(r.is_primary), sort_order: Number(r.sort_order) })), links)) {
      changed.push('subjects');
      await writeSubjectLinks(trx, id, links);
    }
  }
  if (relations !== null) {
    const stored = await trx.selectFrom('record_relations').select(['related_id', 'type']).where('record_id', '=', id).execute();
    const key = (r: RelationRow | { related_id: string; type: string }) => `${r.related_id}:${r.type}`;
    if (!sameRows(stored.map(key).sort(), relations.rows.map(key).sort())) {
      changed.push('relations');
      await writeRelations(trx, id, relations.rows);
    }
  }
  if (p.marcExtra !== undefined) {
    const stored = await trx.selectFrom('record_marc_extra').select(['tag', 'ind1', 'ind2', 'data']).where('record_id', '=', id).orderBy('sort_order').orderBy('id').execute();
    if (!sameRows(stored, p.marcExtra.map((f) => ({ tag: f.tag, ind1: f.ind1, ind2: f.ind2, data: f.data })))) {
      changed.push('marcExtra');
      await writeMarcExtra(trx, id, p.marcExtra, tx.now);
    }
  }
  if (custom !== null && Object.keys(custom.values).length > 0) {
    const stored = (await readCustomValues(trx, 'records', [id])).get(id) ?? {};
    const differs = Object.entries(custom.values).some(([code, v]) => JSON.stringify(v ?? null) !== JSON.stringify(Object.hasOwn(stored, code) ? stored[code] : null));
    if (differs) {
      changed.push('custom');
      await writeCustomValues(trx, 'records', id, custom.values, defs, { now: tx.now, actor: tx.actor.id });
    }
  }

  const title = set.title ?? before.title;
  const subtitle = set.subtitle !== undefined ? set.subtitle : before.subtitle;
  const updated = await trx
    .updateTable('records')
    .set((eb) => ({
      ...set,
      title_key: titleKey(title, subtitle),
      changed_at: tx.now,
      updated_at: tx.now,
      updated_by: tx.actor.id,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', id)
    .where('version', '=', p.version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw recordStale();

  await afterRecordWrite(
    tx,
    [id],
    (o.mode ?? 'interactive') === 'interactive'
      ? { action: 'catalog.record.update', entity: 'records', entityId: id, meta: { fields: changed, authoritiesCreated } }
      : null,
  );
  return { id, version: p.version + 1, warnings, authoritiesCreated };
}

// ---- archive and restore ---------------------------------------------------------------------------------------------

/** The live (not archived) items of `recordId`. */
export async function liveItemCount(db: Db, recordId: string): Promise<number> {
  const row = await db
    .selectFrom('items')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('record_id', '=', recordId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/**
 * Archives a record (`archived_at = now`, `changed_at = now`, version + 1), indexes it, audits `catalog.record.archive`
 * and publishes `catalog.record.changed`. One already archived is answered as it is (its entry says
 * `meta.alreadyArchived`), so a retried request is harmless.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; CATALOG_RECORD_HAS_ITEMS (409, `meta.count`) while it has items that
 *   are not archived (§3.1)
 */
export async function archiveRecord(tx: TxCtx, id: string, version: number): Promise<{ version: number }> {
  const { trx } = tx;
  await lockRecordRows(trx, [id]);
  const before = await readRecordRow(trx, id);
  if (Number(before.version) !== version) throw recordStale();
  if (before.archived_at !== null) {
    await tx.audit({ action: 'catalog.record.archive', entity: 'records', entityId: id, meta: { alreadyArchived: true } });
    return { version };
  }
  const count = await liveItemCount(trx, id);
  if (count > 0) {
    throw new DomainError('CATALOG_RECORD_HAS_ITEMS', {
      detail:
        `Cantuman masih mempunyai ${count} eksemplar aktif; arsipkan atau pindahkan dahulu / ` +
        `The record still has ${count} live item(s); archive or move them first`,
      meta: { count },
    });
  }
  const updated = await trx
    .updateTable('records')
    .set((eb) => ({ archived_at: tx.now, changed_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw recordStale();
  await afterRecordWrite(tx, [id], { action: 'catalog.record.archive', entity: 'records', entityId: id, meta: {} });
  return { version: version + 1 };
}

/**
 * Brings an archived record back (`archived_at` cleared, `changed_at = now`, version + 1), indexes it, audits
 * `catalog.record.restore` and publishes `catalog.record.changed`. One that is live is answered as it is
 * (`meta.alreadyLive`).
 *
 * @throws DomainError NOT_FOUND; CATALOG_MERGE_INVALID for a merged record (it lives on in its target); CONFLICT_STALE
 */
export async function restoreRecord(tx: TxCtx, id: string, version: number): Promise<{ version: number }> {
  const { trx } = tx;
  await lockRecordRows(trx, [id]);
  const before = await readRecordRow(trx, id);
  if (before.merged_into !== null) throw mergedRecord();
  if (Number(before.version) !== version) throw recordStale();
  if (before.archived_at === null) {
    await tx.audit({ action: 'catalog.record.restore', entity: 'records', entityId: id, meta: { alreadyLive: true } });
    return { version };
  }
  const updated = await trx
    .updateTable('records')
    .set((eb) => ({ archived_at: null, changed_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw recordStale();
  await afterRecordWrite(tx, [id], { action: 'catalog.record.restore', entity: 'records', entityId: id, meta: {} });
  return { version: version + 1 };
}
