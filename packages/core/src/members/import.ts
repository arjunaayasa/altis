import type { DB } from '@altis/db';
import {
  DomainError,
  isCalendarDate,
  isDomainError,
  normalizeKey,
  type MemberImportMode,
  type MemberImportRefusal,
  type MemberImportWarning,
  type RunStatus,
} from '@altis/shared';
import {
  MemberBody,
  MemberPatchBody,
  type MemberImportCounts,
  type MemberImportSampleRow,
  type MemberImportView,
} from '@altis/shared/api/members';
import type { Selectable } from 'kysely';
import { createCsvReader, type CsvRow } from '../catalog/csv/reader.js';
import { createRun, finishRun, getRun } from '../catalog/data/runs.js';
import type { TxCtx } from '../context.js';
import { libraryToday, textOrNull, type Db } from './common.js';
import { memberNoDisplay, memberNoProblem, normalizeMemberNo } from './keys.js';
import { createMember, updateMember } from './members.js';

// The CSV member import (format `csv-members`), synchronous: the file is read, every row checked and (unless it is a dry
// run) written in the request's own transaction, at most MEMBER_IMPORT_MAX_ROWS rows. The run is a `catalog_runs` row
// of kind `member_import` whose summary holds counts only, never a personal value.
//
// - The reader is the catalogue's CSV reader: `,` or `;`, UTF-8 or Windows-1252 (Excel's "CSV" on an Indonesian PC),
//   quoted cells with line breaks. The first row is the header; column names are matched without regard to case and
//   in any order; an empty header cell is ignored, an unknown column refuses the file (MEMBER_IMPORT_FORMAT `header`),
//   as does a missing `member_no`, `name` or `member_type`.
// - A row is refused (with one reason) when its member number is missing or not valid, its name or type is missing,
//   its type code names no live member type (never created on the fly), its home branch code names no live branch, its
//   number came before in the file, or (`create_only`) a member holds the number already; `upsert` updates that
//   member with the cells that are not empty. A value the member rules refuse (a date, an e-mail, a length) is
//   `invalid_value`. A gender other than L/P, M/F, male/female, laki-laki/perempuan is left empty with the warning
//   `gender_unknown`.
// - Dates are `YYYY-MM-DD`, or `DD/MM/YYYY` (also with `-` or `.`), the day first as Indonesian spreadsheets write it.
// - Counts: rows, inserted, updated, unchanged (an upsert row whose cells change nothing), refused (per reason) and
//   warnings. The refused rows (line, member number, reason) are handed back for the run's report file.

/** The most data rows a file may have (the import runs inside one request). */
export const MEMBER_IMPORT_MAX_ROWS = 5_000;

/** How many rows a dry run shows as its sample. */
export const MEMBER_IMPORT_SAMPLE_ROWS = 20;

/** The columns of the `csv-members` format. */
export const MEMBER_CSV_COLUMNS = Object.freeze([
  'member_no',
  'name',
  'member_type',
  'class_name',
  'identity_no',
  'gender',
  'birth_date',
  'email',
  'phone',
  'address',
  'postal_code',
  'mailing_address',
  'institution',
  'joined_on',
  'expires_on',
  'home_branch',
  'notes',
  'locale',
] as const);

export type MemberCsvColumn = (typeof MEMBER_CSV_COLUMNS)[number];

const REQUIRED_COLUMNS: readonly MemberCsvColumn[] = ['member_no', 'name', 'member_type'];

/** One data row of the file, by column (absent columns are empty). */
export interface MemberCsvRow {
  line: number;
  cells: Partial<Record<MemberCsvColumn, string>>;
}

/** Why a file cannot be read at all (MEMBER_IMPORT_FORMAT `reason`). */
export type MemberImportFormatReason = 'empty' | 'header' | 'unreadable' | 'too_many_rows';

function formatError(reason: MemberImportFormatReason): DomainError {
  const text: Record<MemberImportFormatReason, string> = {
    empty: 'Berkas kosong atau tanpa baris kepala / The file is empty or has no header row',
    header:
      'Baris kepala harus memuat member_no, name, member_type dan hanya kolom yang dikenal / ' +
      'The header row must hold member_no, name and member_type, and only known columns',
    unreadable: 'Berkas CSV tidak dapat dibaca (tanda kutip tidak ditutup?) / The CSV file cannot be read (an unclosed quote?)',
    too_many_rows: `Berkas memuat lebih dari ${MEMBER_IMPORT_MAX_ROWS} baris; bagi menjadi beberapa berkas / The file has more than ${MEMBER_IMPORT_MAX_ROWS} rows; split it`,
  };
  return new DomainError('MEMBER_IMPORT_FORMAT', { detail: text[reason], meta: { reason } });
}

/**
 * The data rows of a `csv-members` file (see the top of this file), at most {@link MEMBER_IMPORT_MAX_ROWS} unless
 * `o.limit` cuts earlier (a sample). Pure.
 *
 * @throws DomainError MEMBER_IMPORT_FORMAT `{reason}`: `empty`, `header`, `unreadable`, `too_many_rows`
 */
export function readMemberCsv(bytes: Uint8Array, o: { limit?: number } = {}): MemberCsvRow[] {
  const reader = createCsvReader();
  const raw: CsvRow[] = [...reader.push(bytes), ...reader.end()];
  const header = raw[0];
  if (header === undefined || header.error !== undefined) throw formatError(header === undefined ? 'empty' : 'unreadable');
  const columns: (MemberCsvColumn | null)[] = [];
  for (const cell of header.cells) {
    const name = cell.trim().toLowerCase();
    if (name === '') {
      columns.push(null);
      continue;
    }
    if (!(MEMBER_CSV_COLUMNS as readonly string[]).includes(name) || columns.includes(name as MemberCsvColumn)) throw formatError('header');
    columns.push(name as MemberCsvColumn);
  }
  if (REQUIRED_COLUMNS.some((c) => !columns.includes(c))) throw formatError('header');
  const rows: MemberCsvRow[] = [];
  for (const r of raw.slice(1)) {
    if (r.error !== undefined) throw formatError('unreadable');
    if (r.cells.every((c) => c.trim() === '')) continue;
    if (o.limit !== undefined && rows.length >= o.limit) break;
    if (rows.length >= MEMBER_IMPORT_MAX_ROWS) throw formatError('too_many_rows');
    const cells: Partial<Record<MemberCsvColumn, string>> = {};
    columns.forEach((c, i) => {
      if (c !== null) cells[c] = (r.cells[i] ?? '').trim();
    });
    rows.push({ line: r.line, cells });
  }
  return rows;
}

/** A gender cell: `female`, `male`, null for an empty cell, `unknown` for anything else. */
export function parseGenderCell(cell: string): 'female' | 'male' | null | 'unknown' {
  const v = cell.trim().toLowerCase();
  if (v === '') return null;
  if (['p', 'f', 'female', 'perempuan', 'wanita'].includes(v)) return 'female';
  if (['l', 'm', 'male', 'laki-laki', 'laki laki', 'pria'].includes(v)) return 'male';
  return 'unknown';
}

/** A date cell as `YYYY-MM-DD` (from `YYYY-MM-DD` or day-first `DD/MM/YYYY`), null when empty, `invalid` otherwise. */
export function parseDateCell(cell: string): string | null | 'invalid' {
  const v = cell.trim();
  if (v === '') return null;
  if (isCalendarDate(v)) return v;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (m === null) return 'invalid';
  const date = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return isCalendarDate(date) ? date : 'invalid';
}

/** What the import does with one row. */
export interface PlannedRow {
  line: number;
  memberNo: string;
  name: string;
  memberType: string;
  className: string | null;
  action: 'insert' | 'update' | 'unchanged' | 'refused';
  refusal: MemberImportRefusal | null;
  warnings: MemberImportWarning[];
  /** The create body (`insert`), or the existing member and its patch (`update`). */
  create?: MemberBody;
  update?: { id: string; version: number; patch: Omit<MemberPatchBody, 'version'> };
}

type MemberRow = Selectable<DB['members']>;

/** The API field of each optional text column. */
const TEXT_COLUMNS = Object.freeze({
  class_name: 'className',
  identity_no: 'identityNo',
  email: 'email',
  phone: 'phone',
  address: 'address',
  postal_code: 'postalCode',
  mailing_address: 'mailingAddress',
  institution: 'institution',
  notes: 'notes',
} as const);

/**
 * The plan of every row (see the top of this file): the member types and branches by code, the members the numbers
 * name, then each row checked in file order. Reads only.
 */
export async function planMemberRows(db: Db, rows: readonly MemberCsvRow[], o: { mode: MemberImportMode; today: string }): Promise<PlannedRow[]> {
  const types = new Map(
    (await db.selectFrom('member_types').select(['id', 'code_key']).where('archived_at', 'is', null).execute()).map((t) => [t.code_key, t.id]),
  );
  const branches = new Map(
    (await db.selectFrom('branches').select(['id', 'code_key']).where('archived_at', 'is', null).execute()).map((b) => [b.code_key, b.id]),
  );
  const keys = [...new Set(rows.map((r) => normalizeMemberNo(r.cells.member_no ?? '')).filter((k) => memberNoProblem(k) === null))];
  const existing = new Map<string, MemberRow>();
  for (let i = 0; i < keys.length; i += 500) {
    const found = await db.selectFrom('members').selectAll().where('member_no_key', 'in', keys.slice(i, i + 500)).execute();
    for (const m of found) existing.set(m.member_no_key, m);
  }

  const seen = new Set<string>();
  return rows.map((row): PlannedRow => {
    const c = row.cells;
    const memberNo = memberNoDisplay(c.member_no ?? '');
    const key = normalizeMemberNo(memberNo);
    const base = { line: row.line, memberNo, name: c.name ?? '', memberType: c.member_type ?? '', className: textOrNull(c.class_name) };
    const refuse = (refusal: MemberImportRefusal, warnings: MemberImportWarning[] = []): PlannedRow => ({ ...base, action: 'refused', refusal, warnings });
    if ((c.member_no ?? '') === '') return refuse('missing_member_no');
    if (memberNoProblem(memberNo) !== null) return refuse('invalid_member_no');
    if (seen.has(key)) return refuse('duplicate_in_file');
    seen.add(key);
    const stored = existing.get(key);
    const upsert = o.mode === 'upsert' && stored !== undefined;
    if (stored !== undefined && !upsert) return refuse('exists');
    if (upsert && (stored.archived_at !== null || stored.anonymized_at !== null)) return refuse('exists');
    if ((c.name ?? '') === '' && !upsert) return refuse('missing_name');
    if ((c.member_type ?? '') === '' && !upsert) return refuse('missing_member_type');

    const warnings: MemberImportWarning[] = [];
    const fields: Record<string, unknown> = {};
    if ((c.name ?? '') !== '') fields.name = c.name;
    if ((c.member_type ?? '') !== '') {
      const typeId = types.get(normalizeKey(c.member_type ?? ''));
      if (typeId === undefined) return refuse('unknown_member_type');
      fields.memberTypeId = typeId;
    }
    if ((c.home_branch ?? '') !== '') {
      const branchId = branches.get(normalizeKey(c.home_branch ?? ''));
      if (branchId === undefined) return refuse('unknown_home_branch');
      fields.homeBranchId = branchId;
    }
    const gender = parseGenderCell(c.gender ?? '');
    if (gender === 'unknown') warnings.push('gender_unknown');
    else if (gender !== null) fields.gender = gender;
    for (const [column, field] of Object.entries(TEXT_COLUMNS)) {
      const v = c[column as MemberCsvColumn] ?? '';
      if (v !== '') fields[field] = v;
    }
    for (const [column, field] of [
      ['birth_date', 'birthDate'],
      ['joined_on', 'joinedOn'],
      ['expires_on', 'expiresOn'],
    ] as const) {
      const d = parseDateCell(c[column] ?? '');
      if (d === 'invalid') return refuse('invalid_value', warnings);
      if (d !== null) fields[field] = d;
    }
    if (typeof fields.birthDate === 'string' && fields.birthDate > o.today) return refuse('invalid_value', warnings);
    const locale = (c.locale ?? '').toLowerCase();
    if (locale !== '') {
      if (locale !== 'id' && locale !== 'en') return refuse('invalid_value', warnings);
      fields.locale = locale;
    }

    if (!upsert) {
      const parsed = MemberBody.safeParse({ memberNo, ...fields });
      if (!parsed.success) return refuse('invalid_value', warnings);
      return { ...base, action: 'insert', refusal: null, warnings, create: parsed.data };
    }
    // An update: `joinedOn` is not a field of an edit; only the cells that change something are sent.
    delete fields.joinedOn;
    const parsed = MemberPatchBody.safeParse({ version: Number(stored.version), ...fields });
    if (!parsed.success) return refuse('invalid_value', warnings);
    const { version: _version, ...patch } = parsed.data;
    void _version;
    const differs = Object.entries(patch).some(([k, v]) => v !== undefined && v !== storedValue(stored, k));
    if (!differs) return { ...base, action: 'unchanged', refusal: null, warnings };
    return { ...base, action: 'update', refusal: null, warnings, update: { id: stored.id, version: Number(stored.version), patch } };
  });
}

/** The stored value of the API field `field` of a member row (for "does this cell change anything"). */
function storedValue(m: MemberRow, field: string): unknown {
  const columns: Record<string, unknown> = {
    name: m.name,
    memberTypeId: m.member_type_id,
    homeBranchId: m.home_branch_id,
    gender: m.gender,
    birthDate: m.birth_date,
    className: m.class_name,
    identityNo: m.identity_no,
    email: m.email,
    phone: m.phone,
    address: m.address,
    postalCode: m.postal_code,
    mailingAddress: m.mailing_address,
    institution: m.institution,
    notes: m.notes,
    expiresOn: m.expires_on,
    locale: m.locale,
  };
  return columns[field];
}

/** The counts of a plan. */
export function countPlan(plan: readonly PlannedRow[]): MemberImportCounts {
  const counts: MemberImportCounts = { rows: plan.length, inserted: 0, updated: 0, unchanged: 0, refused: 0, refusedBy: {}, warnings: {} };
  for (const p of plan) {
    if (p.action === 'insert') counts.inserted += 1;
    else if (p.action === 'update') counts.updated += 1;
    else if (p.action === 'unchanged') counts.unchanged += 1;
    else {
      counts.refused += 1;
      if (p.refusal !== null) counts.refusedBy[p.refusal] = (counts.refusedBy[p.refusal] ?? 0) + 1;
    }
    for (const w of p.warnings) counts.warnings[w] = (counts.warnings[w] ?? 0) + 1;
  }
  return counts;
}

/** What an import answers its route: the run, its counts and the refused rows (for the report file). */
export interface MemberImportResult {
  runId: string;
  counts: MemberImportCounts;
  refused: { line: number; memberNo: string; reason: MemberImportRefusal }[];
}

/** The header of the report file of refused rows. */
export const MEMBER_IMPORT_REPORT_HEADER = Object.freeze(['line', 'member_no', 'reason']);

/**
 * Runs a member import of `bytes` in `tx` (see the top of this file): the run row, the audit `members.import.start`,
 * every row planned and (unless `dryRun`) written in bulk mode (history `imported`, no audit of its own), the run
 * finished with its counts, and `members.import.finish` with the counts.
 *
 * @throws DomainError MEMBER_IMPORT_FORMAT `{reason}` when the file cannot be read (nothing written)
 */
export async function runMemberImport(tx: TxCtx, input: { bytes: Uint8Array; mode: MemberImportMode; dryRun: boolean }): Promise<MemberImportResult> {
  const rows = readMemberCsv(input.bytes);
  const runId = await createRun(tx, { kind: 'member_import', dryRun: input.dryRun, format: 'csv-members', options: { mode: input.mode } });
  await tx.audit({ action: 'members.import.start', entity: 'catalog_runs', entityId: runId, meta: { dryRun: input.dryRun, mode: input.mode, format: 'csv-members' } });
  const today = await libraryToday(tx.trx, tx.now);
  const plan = await planMemberRows(tx.trx, rows, { mode: input.mode, today });
  if (!input.dryRun) {
    const source = `import:${runId}`;
    for (const p of plan) {
      try {
        if (p.action === 'insert' && p.create !== undefined) {
          await createMember(tx, p.create, { mode: 'bulk', source, eventType: 'imported', today });
        } else if (p.action === 'update' && p.update !== undefined) {
          await updateMember(tx, p.update.id, { version: p.update.version, ...p.update.patch }, { mode: 'bulk', eventType: 'imported', today });
        }
      } catch (error) {
        // A value only the database can refuse (a home branch or a type archived meanwhile): the row is refused.
        if (!isDomainError(error) || (error.code !== 'VALIDATION_FAILED' && error.code !== 'NOT_FOUND')) throw error;
        p.action = 'refused';
        p.refusal = 'invalid_value';
      }
    }
  }
  const counts = countPlan(plan);
  await finishRun(tx.trx, runId, { status: 'succeeded', summary: { counts } }, tx.now);
  await tx.audit({ action: 'members.import.finish', entity: 'catalog_runs', entityId: runId, meta: { dryRun: input.dryRun, ...counts } });
  const refused = plan.flatMap((p) => (p.action === 'refused' && p.refusal !== null ? [{ line: p.line, memberNo: p.memberNo, reason: p.refusal }] : []));
  return { runId, counts, refused };
}

/** The view of the member import run `id`; `sample` holds the first rows of a dry run's file when `file` is given. */
export async function getMemberImport(db: Db, id: string, o: { file: Uint8Array | null; now: number }): Promise<MemberImportView> {
  const run = await getRun(db, id);
  if (run === null || run.kind !== 'member_import') throw new DomainError('NOT_FOUND', { detail: 'Impor anggota tidak ditemukan / Member import not found' });
  let options: { mode?: unknown } = {};
  let summary: { counts?: unknown } = {};
  try {
    options = JSON.parse(run.options) as { mode?: unknown };
    summary = JSON.parse(run.summary) as { counts?: unknown };
  } catch {
    // A run row written by this code always holds JSON objects.
  }
  const mode: MemberImportMode = options.mode === 'upsert' ? 'upsert' : 'create_only';
  const dryRun = Number(run.dry_run) === 1;
  let sample: MemberImportSampleRow[] = [];
  if (dryRun && o.file !== null) {
    try {
      const rows = readMemberCsv(o.file, { limit: MEMBER_IMPORT_SAMPLE_ROWS });
      const plan = await planMemberRows(db, rows, { mode, today: await libraryToday(db, o.now) });
      sample = plan.map((p) => ({ line: p.line, memberNo: p.memberNo, name: p.name, memberType: p.memberType, className: p.className, refusal: p.refusal, warnings: p.warnings }));
    } catch {
      sample = [];
    }
  }
  const counts = typeof summary.counts === 'object' && summary.counts !== null ? (summary.counts as MemberImportCounts) : null;
  return {
    id: run.id,
    status: run.status as RunStatus,
    format: 'csv-members',
    mode,
    dryRun,
    counts,
    sample,
    errorCode: null,
    reportAvailable: run.report_file_id !== null,
    createdAt: Number(run.created_at),
    createdBy: run.created_by,
    finishedAt: run.finished_at === null ? null : Number(run.finished_at),
  };
}

/** How long the report of a member import may be downloaded after the run finished. */
export const MEMBER_IMPORT_REPORT_KEEP_MS = 90 * 86_400_000;
