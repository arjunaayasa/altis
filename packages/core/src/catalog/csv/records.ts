// The ALTIS `csv-records` codec (Phase 2 spec §5.2, K6): one record per row, columns by header name in any order.
//
// - Multi-values (`isbn`, `issn`, `authors`, `subjects`) are joined with `|` (`\|` for a literal pipe; multi.ts).
// - `authors`: `Nama [peran]`, the role a MARC relator code (default `aut`). The brackets may also name the agent's
//   type (`person`, `organization`, `meeting`; default `person`) and its dates (a part holding a digit): the export
//   writes `Badan Bahasa [edt, organization]`, `Toer, Pramoedya Ananta [aut, 1925-2006]`, so an agent's identity (the
//   fields its authority key is built from) survives a round trip (K6). The first agent is the main entry.
// - `subjects`: `tipe:istilah`, the type one of SUBJECT_TYPES (default `topic`; a prefix that is not a type is part of
//   the term). The first subject is the primary one.
// - `isbn`/`issn`: each value is split by splitIdentifierText (`978-… (jil. 1); 979-…`), so a qualifier rides in
//   brackets and a part that is no ISBN/ISSN is kept as an `other` identifier.
// - `year`: a bare year is `publicationYear`; anything else is `publicationDateText` with its first year.
// - `opac_visible`: `0/1/true/false/ya/tidak` in any case. `custom.<code>`: raw strings in `draft.custom`; the import
//   coerces them with coerceCustomValues before validation (S19).
// - `audience`, `local_work`, `local_work_kind`, `reference_kind` (the accreditation fields, after `opac_visible`, so a
//   file without them stays valid): the codes of their lists, read in any case; an unknown code is `invalid`.
// - A cell that does not fit its field (too long, not a code, an unknown role) is reported in `errors` and left out of
//   the draft; an empty cell is left out (an update keeps the stored value). The `'` csvCell puts before a formula
//   start is removed, so an export reads back as written.
// Pure; no I/O.

import {
  AGENT_TYPES,
  AUDIENCES,
  LOCAL_WORKS,
  LOCAL_WORK_KINDS,
  REFERENCE_KINDS,
  RELATOR_ROLES,
  SUBJECT_TYPES,
  isUlid,
  type AgentType,
  type RelatorRole,
  type SubjectType,
} from '@altis/shared';
import { RECORD_LIST_MAX, type RecordData, type RecordDraft } from '@altis/shared/api/catalog/record-data';
import { agentNameKey, subjectTermKey } from '../data/keys.js';
import { splitIdentifierText } from '../lib/identifiers.js';
import {
  CUSTOM_PREFIX,
  CellReader,
  cachedHeaderIndex,
  customCells,
  customValueText,
  hasExtraCells,
  inHeaderOrder,
  joinMulti,
  oneLine,
  readYear,
  splitMulti,
  unguard,
  type CsvFieldError,
  type HeaderIndex,
} from './multi.js';

/** The `csv-records` columns of §5.2, in their export order; `custom.<code>` columns follow. */
export const CSV_RECORD_COLUMNS = Object.freeze([
  'record_id',
  'title',
  'subtitle',
  'responsibility',
  'material_type',
  'edition',
  'isbn',
  'issn',
  'publisher',
  'place',
  'year',
  'physical_desc',
  'series',
  'classification',
  'call_number',
  'language',
  'authors',
  'subjects',
  'summary',
  'notes',
  'opac_visible',
  // ---- Komunitas K1 (catalogue accreditation fields): after opac_visible, so a file written before them stays valid ----
  'audience',
  'local_work',
  'local_work_kind',
  'reference_kind',
] as const);

type RecordColumn = (typeof CSV_RECORD_COLUMNS)[number];

type DraftIdentifier = RecordDraft['identifiers'][number];
type DraftAgent = RecordDraft['agents'][number];
type DraftSubject = RecordDraft['subjects'][number];

/** One row read: the record to update (`record_id`), the draft, `opac_visible` (null: not given) and the errors. */
export interface CsvRecordRead {
  recordId: string | null;
  draft: RecordDraft;
  opacVisible: boolean | null;
  errors: CsvFieldError[];
}

/** The header of a `csv-records` export: the columns, then `custom.<code>` for each code. */
export function csvRecordHeader(customCodes: readonly string[]): string[] {
  return [...CSV_RECORD_COLUMNS, ...customCodes.map((c) => CUSTOM_PREFIX + c)];
}

/** The problems of a `csv-records` header, to report once per file: unknown, repeated or malformed columns, no title. */
export function csvRecordHeaderErrors(header: readonly string[]): CsvFieldError[] {
  return recordHeaderIndex(header).errors;
}

const headerCache = new WeakMap<readonly string[], HeaderIndex>();

function recordHeaderIndex(header: readonly string[]): HeaderIndex {
  return cachedHeaderIndex(headerCache, header, CSV_RECORD_COLUMNS, 'title');
}

const TRUE_WORDS: ReadonlySet<string> = new Set(['1', 'true', 'ya']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['0', 'false', 'tidak']);

/** The widths of the draft's one-line fields (RecordDraft, the column widths of §2.2). */
const W = { line: 191, short: 64 } as const;

// ---- lists shared with the SLiMS codec -----------------------------------------------------------------------------

/** The identifiers of a row, kept once each (by type and key) and at most RECORD_LIST_MAX.identifiers. */
export class IdentifierList {
  readonly list: DraftIdentifier[] = [];
  private readonly keys = new Set<string>();

  /** The identifiers in `text` (splitIdentifierText); what does not fit is `column` `too_big`. */
  add(r: CellReader, column: string, text: string): void {
    for (const part of splitIdentifierText(oneLine(text))) {
      if (part.value.length > W.short || (part.qualifier !== null && part.qualifier.length > W.short)) {
        r.error(column, 'too_big');
        continue;
      }
      const key = `${part.type}|${part.key ?? part.value.toUpperCase()}`;
      if (this.keys.has(key)) continue;
      if (this.list.length >= RECORD_LIST_MAX.identifiers) {
        r.error(column, 'too_big');
        return;
      }
      this.keys.add(key);
      this.list.push(part.qualifier === null ? { type: part.type, value: part.value } : { type: part.type, value: part.value, qualifier: part.qualifier });
    }
  }
}

/** The agents of a row, kept once each (by type, key and role), the first one the main entry. */
export class AgentList {
  readonly list: DraftAgent[] = [];
  private readonly keys = new Set<string>();

  add(r: CellReader, column: string, a: { type: AgentType; name: string; dates?: string; role: RelatorRole }): void {
    if (a.name === '') return;
    if (a.name.length > W.line || (a.dates !== undefined && a.dates.length > W.short)) {
      r.error(column, 'too_big');
      return;
    }
    const key = `${a.type}|${agentNameKey(a.name, a.dates)}|${a.role}`;
    if (this.keys.has(key)) return;
    if (this.list.length >= RECORD_LIST_MAX.agents) {
      r.error(column, 'too_big');
      return;
    }
    this.keys.add(key);
    const isMain = this.list.length === 0;
    this.list.push(a.dates === undefined ? { type: a.type, name: a.name, role: a.role, isMain } : { type: a.type, name: a.name, dates: a.dates, role: a.role, isMain });
  }
}

/** The subjects of a row, kept once each (by type and key), the first one the primary subject. */
export class SubjectList {
  readonly list: DraftSubject[] = [];
  private readonly keys = new Set<string>();

  add(r: CellReader, column: string, s: { type: SubjectType; term: string }): void {
    if (s.term === '') {
      r.error(column, 'invalid_value');
      return;
    }
    if (s.term.length > W.line) {
      r.error(column, 'too_big');
      return;
    }
    const key = `${s.type}|${subjectTermKey(s.term)}`;
    if (this.keys.has(key)) return;
    if (this.list.length >= RECORD_LIST_MAX.subjects) {
      r.error(column, 'too_big');
      return;
    }
    this.keys.add(key);
    this.list.push({ type: s.type, term: s.term, isPrimary: this.list.length === 0 });
  }
}

// ---- authors and subjects ------------------------------------------------------------------------------------------

const isRole = (s: string): s is RelatorRole => (RELATOR_ROLES as readonly string[]).includes(s);
const isAgentType = (s: string): s is AgentType => (AGENT_TYPES as readonly string[]).includes(s);
const isSubjectType = (s: string): s is SubjectType => (SUBJECT_TYPES as readonly string[]).includes(s);

/** `Nama [peran]` (see the top of this file) → the agent; an unknown part of the brackets is `invalid_value`. */
function readAgent(r: CellReader, value: string): { type: AgentType; name: string; dates?: string; role: RelatorRole } {
  const v = oneLine(value);
  const m = /^(.*?)\s*\[([^[\]]*)\]$/.exec(v);
  if (m === null || m[1] === '') return { type: 'person', name: v, role: 'aut' };
  let role: RelatorRole = 'aut';
  let type: AgentType = 'person';
  const rest: string[] = [];
  for (const part of m[2]!.split(/[,;]/)) {
    const token = part.trim();
    const word = token.toLowerCase();
    if (token === '') continue;
    if (isRole(word)) role = word;
    else if (isAgentType(word)) type = word;
    else rest.push(token);
  }
  const agent: { type: AgentType; name: string; dates?: string; role: RelatorRole } = { type, name: m[1]!, role };
  if (rest.length > 0) {
    if (rest.some((t) => /\d/.test(t))) agent.dates = rest.join(', ');
    else r.error('authors', 'invalid_value');
  }
  return agent;
}

/** The cell text of an agent: `Nama [peran]`, plus its type when not a person and its dates. */
function agentText(a: { type: AgentType; name: string; dates?: string; role: RelatorRole }): string {
  const parts: string[] = [a.role];
  if (a.type !== 'person') parts.push(a.type);
  if (a.dates) parts.push(a.dates);
  return `${a.name} [${parts.join(', ')}]`;
}

/**
 * An accreditation field's cell: one of `values` (any case), or undefined for an empty cell; an unknown code is the
 * error `invalid` at `column` and left out.
 */
function accredCode<T extends string>(r: CellReader, column: string, raw: string, values: readonly T[]): T | undefined {
  const v = oneLine(raw).toLowerCase();
  if (v === '') return undefined;
  if (!(values as readonly string[]).includes(v)) return r.error(column, 'invalid');
  return v as T;
}

const TYPE_PREFIX = /^([A-Za-z]+)\s*:\s*(.*)$/;

/** `tipe:istilah` → the subject (`topic` when the prefix is not a type). */
function readSubject(value: string): { type: SubjectType; term: string } {
  const v = oneLine(value);
  const m = TYPE_PREFIX.exec(v);
  const prefix = m?.[1]?.toLowerCase();
  return prefix !== undefined && isSubjectType(prefix) ? { type: prefix, term: m![2]! } : { type: 'topic', term: v };
}

/** The cell text of a subject: its term, with `tipe:` unless a topic that cannot be misread. */
function subjectText(s: { type: SubjectType; term: string }): string {
  const prefix = TYPE_PREFIX.exec(s.term)?.[1]?.toLowerCase();
  return s.type === 'topic' && (prefix === undefined || !isSubjectType(prefix)) ? s.term : `${s.type}:${s.term}`;
}

// ---- reading a row -------------------------------------------------------------------------------------------------

/**
 * One `csv-records` row: `cells` under `header` (the file's first row; columns by name, trimmed, any case). See the
 * top of this file; `errors` follow the columns' order in the header.
 */
export function csvRecordRow(header: readonly string[], cells: readonly string[]): CsvRecordRead {
  const index = recordHeaderIndex(header);
  const r = new CellReader();
  const get = (c: RecordColumn): string => {
    const i = index.known.get(c);
    return i === undefined ? '' : unguard(cells[i] ?? '');
  };

  let recordId: string | null = null;
  const id = oneLine(get('record_id')).toUpperCase();
  if (id !== '') {
    if (isUlid(id)) recordId = id;
    else r.error('record_id', 'invalid_format');
  }

  const title = r.line('title', get('title'));
  if (title === undefined && !r.errors.some((e) => e.column === 'title')) r.error('title', 'required');

  const draft: RecordDraft = {
    materialTypeCode: r.code('material_type', get('material_type')) ?? null,
    title: title ?? '',
    publisher: null,
    identifiers: [],
    agents: [],
    subjects: [],
    links: [],
    items: [],
    marcExtra: [],
  };
  const put = <K extends keyof RecordDraft>(key: K, value: RecordDraft[K] | undefined): void => {
    if (value !== undefined) draft[key] = value;
  };
  put('subtitle', r.line('subtitle', get('subtitle')));
  put('responsibility', r.line('responsibility', get('responsibility')));
  put('edition', r.short('edition', get('edition'), W.line));

  const ids = new IdentifierList();
  for (const v of splitMulti(get('isbn'))) ids.add(r, 'isbn', v);
  for (const v of splitMulti(get('issn'))) ids.add(r, 'issn', v);
  draft.identifiers = ids.list;

  const publisher = r.short('publisher', get('publisher'), W.line);
  const place = r.short('place', get('place'), W.line);
  if (publisher !== undefined) draft.publisher = place === undefined ? { name: publisher } : { name: publisher, place };
  put('publicationPlace', place);
  const year = readYear(r, 'year', get('year'));
  put('publicationYear', year.publicationYear);
  put('publicationDateText', year.publicationDateText);
  put('physicalDesc', r.short('physical_desc', get('physical_desc'), W.line));
  put('series', r.short('series', get('series'), W.line));
  put('classification', r.short('classification', get('classification'), W.short));
  put('callNumber', r.short('call_number', get('call_number'), W.short));
  put('languageCode', r.code('language', get('language')));

  const agents = new AgentList();
  for (const v of splitMulti(get('authors'))) agents.add(r, 'authors', readAgent(r, v));
  draft.agents = agents.list;
  const subjects = new SubjectList();
  for (const v of splitMulti(get('subjects'))) subjects.add(r, 'subjects', readSubject(v));
  draft.subjects = subjects.list;

  put('summary', r.text('summary', get('summary')));
  put('notes', r.text('notes', get('notes')));

  let opacVisible: boolean | null = null;
  const visible = oneLine(get('opac_visible')).toLowerCase();
  if (TRUE_WORDS.has(visible)) opacVisible = true;
  else if (FALSE_WORDS.has(visible)) opacVisible = false;
  else if (visible !== '') r.error('opac_visible', 'invalid_value');

  put('audience', accredCode(r, 'audience', get('audience'), AUDIENCES));
  put('localWork', accredCode(r, 'local_work', get('local_work'), LOCAL_WORKS));
  put('localWorkKind', accredCode(r, 'local_work_kind', get('local_work_kind'), LOCAL_WORK_KINDS));
  put('referenceKind', accredCode(r, 'reference_kind', get('reference_kind'), REFERENCE_KINDS));

  put('custom', customCells(index, cells));
  if (hasExtraCells(cells, header.length)) r.error('', 'too_many_cells');

  const errors = inHeaderOrder(r.errors, (column) => index.known.get(column) ?? -1);
  return { recordId, draft, opacVisible, errors };
}

// ---- writing a row -------------------------------------------------------------------------------------------------

/** The text of an identifier in its cell: the value, then its qualifier in brackets. */
function identifierText(i: { value: string; qualifier?: string | null }): string {
  return i.qualifier ? `${i.value} (${i.qualifier})` : i.value;
}

/** The year cell: the date as written when its first year is the record's year, else the year. */
function yearText(d: RecordData): string {
  const text = d.publicationDateText;
  if (text !== undefined && text !== '') {
    const first = /(?<!\d)\d{4}(?!\d)/.exec(text)?.[0];
    if (d.publicationYear === undefined || first === d.publicationYear) return text;
  }
  return d.publicationYear ?? '';
}

/**
 * The cells of `d` in the order of `csvRecordHeader(customCodes)`, as text: the caller writes them with csvRow (which
 * quotes them and guards a formula start, `=1+1` → `'=1+1`). The main agent and the primary subject come first.
 */
export function recordCsvCells(d: RecordData, customCodes: readonly string[]): string[] {
  const ids = (type: 'isbn' | 'issn') => joinMulti(d.identifiers.filter((i) => i.type === type).map(identifierText));
  const agents = [...d.agents].sort((a, b) => Number(b.isMain) - Number(a.isMain));
  const subjects = [...d.subjects].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const by: Record<RecordColumn, string> = {
    record_id: d.id,
    title: d.title,
    subtitle: d.subtitle ?? '',
    responsibility: d.responsibility ?? '',
    material_type: d.materialType.code,
    edition: d.edition ?? '',
    isbn: ids('isbn'),
    issn: ids('issn'),
    publisher: d.publisher?.name ?? '',
    place: d.publicationPlace ?? d.publisher?.place ?? '',
    year: yearText(d),
    physical_desc: d.physicalDesc ?? '',
    series: d.series ?? '',
    classification: d.classification ?? '',
    call_number: d.callNumber ?? '',
    language: d.language?.code ?? d.languageCode ?? '',
    authors: joinMulti(agents.map(agentText)),
    subjects: joinMulti(subjects.map(subjectText)),
    summary: d.summary ?? '',
    notes: d.notes ?? '',
    opac_visible: d.opacVisible ? '1' : '0',
    audience: d.audience ?? '',
    local_work: d.localWork ?? '',
    local_work_kind: d.localWorkKind ?? '',
    reference_kind: d.referenceKind ?? '',
  };
  const custom = d.custom ?? {};
  return [...CSV_RECORD_COLUMNS.map((c) => by[c]), ...customCodes.map((code) => customValueText(Object.hasOwn(custom, code) ? custom[code] : undefined))];
}
