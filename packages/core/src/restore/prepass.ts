import {
  EDITION_MIGRATIONS,
  TABLE_KEYS,
  columnsAt,
  editionLaneState,
  type ColumnSpec,
  type DB,
  type Dialect,
  type PkValue,
  type TableName,
} from '@altis/db';
import { dataPath, readBytes, writeBytesAtomic } from '@altis/platform';
import { DomainError, isUlid } from '@altis/shared';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { backupTables } from '../backup/canonical.js';
import type { BackupManifest } from '../backup/manifest.js';
import type { RestoreChecklist } from './secrets.js';
import type { RestoreSource } from './source.js';

// The read-only pre-pass of a restore (spec §9.10 step 4; preflight S5; Review Focus 4; plan Task 22). Before anything
// of the target is touched, every row of the backup is checked against the code's DDL for the target dialect, part by
// part, so that a backup that cannot load fails before the point of no return with a report the administrator can
// download (`ops/<opId>/report.json`, `GET ops/report`):
//
// - each row: exactly the columns of columnsAt(table, the backup's schemaVersion), NULL only where nullable, integers
//   safe integers (flags 0/1), `int` within ±2^31 and `smallint` within ±32 767 (`int_range`/`smallint_range`: a
//   SQLite source does not enforce them), text well-formed UTF-16 (`utf16`), CHAR kinds exactly their length
//   (`char_length`; a CHAR value ending in a blank too, outside SQLite), `files.id` a ULID (`invalid`: it becomes a
//   path segment, `uploads/<yyyy>/<mm>/<id>`, only in finalizing, past the point of no return; other ids are only
//   keys, and hand-made ones load as they are), varchar/key191 at most their length in code points (`too_long`); PostgreSQL: no U+0000 in text (`nul`); MySQL/MariaDB: text/json at most 65 535 UTF-8 bytes
//   (`text_bytes`). Each is a conflict naming the row (table, columns, primary key);
// - MySQL/MariaDB: their binary keys are PAD SPACE (R24), so `'X'` and `'X '` are one key there. Every primary key
//   and UNIQUE key of TABLE_KEYS (a composite one as a tuple, S5b) whose text components end in U+0020 is put,
//   {@link rekey}ed, into a small set during the first pass (`trimmed`, at most 10 000 entries); a second pass over
//   the tables concerned reports `duplicate` for the second row of each rekeyed key. A trailing tab or any other
//   character stays significant (S5a);
// - an external archive without blobs while it holds `files` rows (and the restore was not asked to go without files):
//   `files_missing`.
//
// The pre-pass keeps no state across parts but its checkpoint: where it is, the `trimmed` and `seen` sets, the
// conflicts found (at most {@link CONFLICTS_MAX}; it stops once that many are found).

/** Why a value cannot load (an `invalid` conflict's `detail`). */
export type ConflictDetail = 'nul' | 'text_bytes' | 'int_range' | 'smallint_range' | 'char_length' | 'utf16';

/** One row (or one archive-wide problem) that cannot load into the target. */
export type Conflict = {
  table: string;
  kind: 'duplicate' | 'too_long' | 'invalid' | 'files_missing';
  columns: string[];
  pk: PkValue[] | null;
  /** At most 64 characters, never a secret column. */
  value?: string;
  detail?: ConflictDetail;
};

/** `ops/<opId>/report.json`. */
export interface RestoreReport {
  ok: boolean;
  conflicts: Conflict[];
  checklist: RestoreChecklist;
  files: { missing: string[] };
}

/** The most conflicts a pre-pass collects (it stops there: the report is read by a person). */
export const CONFLICTS_MAX = 200;
/** The most rekeyed keys the first pass may set aside (S5b); more fail the pre-pass. */
export const TRIMMED_MAX = 10_000;
/** The most file ids the report lists as missing. */
export const MISSING_MAX = 1000;

const VALUE_MAX = 64;
const INT_MAX = 2 ** 31 - 1;
const INT_MIN = -(2 ** 31);
const SMALLINT_MAX = 32_767;
const SMALLINT_MIN = -32_768;
const TEXT_BYTES_MAX = 65_535;
const INTEGER_KINDS: ReadonlySet<ColumnSpec['kind']> = new Set(['serial', 'bool', 'money', 'timestamp', 'smallint', 'int', 'bigint']);
const FIXED_KINDS: ReadonlySet<ColumnSpec['kind']> = new Set(['id', 'ulid', 'date', 'char']);
const LIMITED_KINDS: ReadonlySet<ColumnSpec['kind']> = new Set(['varchar', 'key191']);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Where the pre-pass stands (op.params.check). */
export type PrepassCheckpoint = {
  pass: 1 | 2;
  /** Index into {@link prepassTables} of the table being read. */
  table: number;
  /** The part of that table to read next, from 1. */
  part: number;
  /** `<tableIndex>|<keyIndex>|<rekey>` of every key the first pass found with a trailing blank. */
  trimmed: string[];
  /** The ones of `trimmed` the second pass has met once. */
  seen: string[];
  conflicts: Conflict[];
};

const conflictSchema = z.strictObject({
  table: z.string().max(64),
  kind: z.enum(['duplicate', 'too_long', 'invalid', 'files_missing']),
  columns: z.array(z.string().max(64)).max(16),
  pk: z.array(z.union([z.string(), z.number()])).max(8).nullable(),
  value: z.string().max(VALUE_MAX * 2).optional(),
  detail: z.enum(['nul', 'text_bytes', 'int_range', 'smallint_range', 'char_length', 'utf16']).optional(),
});

export const prepassCheckpointSchema = z.strictObject({
  pass: z.union([z.literal(1), z.literal(2)]),
  table: z.number().int().min(0).max(1000),
  part: z.number().int().min(1).max(100_000),
  trimmed: z.array(z.string()).max(TRIMMED_MAX),
  seen: z.array(z.string()).max(TRIMMED_MAX),
  conflicts: z.array(conflictSchema).max(CONFLICTS_MAX),
}) satisfies z.ZodType<PrepassCheckpoint>;

/**
 * The comparison key of the key tuple `tuple` on a `dialect` target (S5): on MySQL/MariaDB (PAD SPACE, R24) each text
 * component loses its trailing U+0020 characters, and nothing else (a trailing tab stays significant); other dialects
 * keep the values. The tuple is joined into one string (its JSON).
 */
export function rekey(dialect: Dialect, tuple: readonly (string | number | null)[]): string {
  const pad = dialect === 'mysql' || dialect === 'mariadb';
  return JSON.stringify(tuple.map((v) => (pad && typeof v === 'string' ? v.replace(/ +$/u, '') : v)));
}

/** The tables of the backup the pre-pass reads: the code's backup tables the manifest holds, in load order. */
export function prepassTables(m: BackupManifest): TableName[] {
  return backupTables()
    .map((t) => t.table)
    .filter((t) => Object.hasOwn(m.tables, t));
}

/** `value` cut to {@link VALUE_MAX} characters (never inside a surrogate pair). */
function shown(value: string): string {
  const chars = [...value];
  return chars.length <= VALUE_MAX ? value : chars.slice(0, VALUE_MAX).join('');
}

/** The primary key of a parsed row, when its key columns hold strings or numbers; null otherwise. */
function pkOfRow(table: TableName, row: Record<string, unknown>): PkValue[] | null {
  const out: PkValue[] = [];
  for (const name of TABLE_KEYS[table].pk) {
    const value = row[name];
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    out.push(value);
  }
  return out;
}

function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

/** Columns whose value becomes a path segment after the point of no return (uploadPath): a ULID or nothing. */
const PATH_IDS: ReadonlySet<string> = new Set(['files.id']);

/** The problem of one value of column `c` on a `dialect` target, or null. */
function valueProblem(c: ColumnSpec, value: unknown, dialect: Dialect): { kind: Conflict['kind']; detail?: ConflictDetail } | null {
  if (value === null) return c.nullable ? null : { kind: 'invalid' };
  if (INTEGER_KINDS.has(c.kind)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return { kind: 'invalid' };
    if (c.kind === 'bool') return value === 0 || value === 1 ? null : { kind: 'invalid' };
    if (c.kind === 'int' && (value > INT_MAX || value < INT_MIN)) return { kind: 'invalid', detail: 'int_range' };
    if (c.kind === 'smallint' && (value > SMALLINT_MAX || value < SMALLINT_MIN)) return { kind: 'invalid', detail: 'smallint_range' };
    return null;
  }
  if (typeof value !== 'string') return { kind: 'invalid' };
  if (LONE_SURROGATE.test(value)) return { kind: 'invalid', detail: 'utf16' };
  if (dialect === 'postgres' && value.includes('\u0000')) return { kind: 'invalid', detail: 'nul' };
  if (FIXED_KINDS.has(c.kind)) {
    if (codePoints(value) !== c.length || (dialect !== 'sqlite' && value.endsWith(' '))) return { kind: 'invalid', detail: 'char_length' };
    return null;
  }
  if (LIMITED_KINDS.has(c.kind)) return codePoints(value) > (c.length ?? 191) ? { kind: 'too_long' } : null;
  if ((dialect === 'mysql' || dialect === 'mariadb') && Buffer.byteLength(value, 'utf8') > TEXT_BYTES_MAX) {
    return { kind: 'invalid', detail: 'text_bytes' };
  }
  return null;
}

/**
 * The problems of one line of a part of `table` for a `dialect` target: its JSON, its columns (exactly `columns`) and
 * each value (see the top of this file). `secret` names the columns whose value a conflict never shows.
 */
export function checkRow(
  table: TableName,
  line: string,
  columns: readonly ColumnSpec[],
  dialect: Dialect,
  secret: ReadonlySet<string> = new Set(),
): { row: Record<string, unknown> | null; conflicts: Conflict[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { row: null, conflicts: [{ table, kind: 'invalid', columns: [], pk: null }] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { row: null, conflicts: [{ table, kind: 'invalid', columns: [], pk: null }] };
  }
  const row = parsed as Record<string, unknown>;
  const pk = pkOfRow(table, row);
  const conflicts: Conflict[] = [];
  const names = new Set(columns.map((c) => c.name));
  const strays = Object.keys(row).filter((k) => !names.has(k));
  const missing = columns.filter((c) => !Object.hasOwn(row, c.name)).map((c) => c.name);
  if (strays.length > 0 || missing.length > 0) {
    conflicts.push({ table, kind: 'invalid', columns: [...missing, ...strays].slice(0, 16).map((n) => n.slice(0, 64)), pk });
  }
  for (const c of columns) {
    if (!Object.hasOwn(row, c.name)) continue;
    const value = row[c.name];
    let problem = valueProblem(c, value, dialect);
    if (problem === null && typeof value === 'string' && PATH_IDS.has(`${table}.${c.name}`) && !isUlid(value)) problem = { kind: 'invalid' };
    if (problem === null) continue;
    const conflict: Conflict = { table, kind: problem.kind, columns: [c.name], pk };
    if (problem.detail !== undefined) conflict.detail = problem.detail;
    if (problem.kind === 'too_long' && typeof value === 'string' && !secret.has(c.name)) conflict.value = shown(value);
    conflicts.push(conflict);
  }
  return { row: conflicts.length === 0 ? row : null, conflicts };
}

/** The key tuples of `row` (primary key first, then each UNIQUE key), null for a key with a NULL component. */
function keyTuples(table: TableName, row: Record<string, unknown>): ({ columns: readonly string[]; tuple: (string | number)[] } | null)[] {
  const keys = TABLE_KEYS[table];
  return [keys.pk, ...keys.unique].map((cols) => {
    const tuple: (string | number)[] = [];
    for (const name of cols) {
      const value = row[name];
      if (typeof value !== 'string' && typeof value !== 'number') return null; // MySQL allows many NULLs in a UNIQUE key
      tuple.push(value);
    }
    return { columns: cols, tuple };
  });
}

/** The secret columns of a table (never shown in a conflict). */
function secretColumns(table: string): ReadonlySet<string> {
  if (table === 'staff_users') return new Set(['totp_secret_enc', 'password_hash']);
  if (table === 'settings') return new Set(['value']);
  return new Set();
}

export interface PrepassOptions {
  /** The target's dialect. */
  dialect: Dialect;
  /** Epoch ms by which a step should end (it always reads at least one part). */
  deadline: number;
  clock: () => number;
  /** The archive is not this installation's (no valid HMAC). */
  external: boolean;
  withoutFiles: boolean;
}

/** The first checkpoint of a pre-pass. */
export function newPrepass(): PrepassCheckpoint {
  return { pass: 1, table: 0, part: 1, trimmed: [], seen: [], conflicts: [] };
}

/**
 * One step of the pre-pass of `source` from `cp` (see the top of this file): parts until `o.deadline` (at least one),
 * then the next checkpoint. `done` once both passes are over, or {@link CONFLICTS_MAX} conflicts were found; the
 * conflicts are the checkpoint's.
 *
 * @throws DomainError BACKUP_INVALID while reading a part (see RestoreSource.partLines)
 */
export async function prepassStep(source: RestoreSource, cp: PrepassCheckpoint, o: PrepassOptions): Promise<{ done: boolean; checkpoint: PrepassCheckpoint }> {
  const c = structuredClone(cp);
  const m = source.manifest;
  const tables = prepassTables(m);
  const mysql = o.dialect === 'mysql' || o.dialect === 'mariadb';
  const trimmed = new Set(c.trimmed);
  const seen = new Set(c.seen);
  const add = (conflict: Conflict): void => {
    if (c.conflicts.length < CONFLICTS_MAX) c.conflicts.push(conflict);
  };

  if (c.pass === 1 && c.table === 0 && c.part === 1) {
    const files = m.tables['files'];
    if (o.external && !o.withoutFiles && files !== undefined && files.rows > 0 && (!m.includesFiles || m.blobs.length === 0)) {
      add({ table: 'files', kind: 'files_missing', columns: [], pk: null });
    }
  }

  /** The tables (indexes) whose keys the second pass must read. */
  const secondPassTables = (): Set<number> => new Set([...trimmed].map((k) => Number(k.slice(0, k.indexOf('|')))));

  let first = true;
  while (c.conflicts.length < CONFLICTS_MAX && (first || o.clock() < o.deadline)) {
    first = false;
    if (c.pass === 2 && !secondPassTables().has(c.table)) {
      // Skip the tables without a trailing-blank key.
      const next = [...secondPassTables()].filter((i) => i > c.table).sort((a, b) => a - b)[0];
      if (next === undefined) {
        c.table = tables.length;
      } else {
        c.table = next;
        c.part = 1;
      }
    }
    const table = tables[c.table];
    if (table === undefined) {
      if (c.pass === 1 && mysql && trimmed.size > 0) {
        Object.assign(c, { pass: 2, table: 0, part: 1 });
        continue;
      }
      break;
    }
    const parts = m.tables[table]!.parts;
    const part = parts.find((p) => p.n === c.part);
    if (part === undefined) {
      Object.assign(c, { table: c.table + 1, part: 1 });
      continue;
    }
    const columns = columnsAt(table, m.schemaVersion);
    const secret = secretColumns(table);
    for await (const line of source.partLines(table, part.n)) {
      if (line === '') continue;
      if (c.pass === 1) {
        const r = checkRow(table, line, columns, o.dialect, secret);
        for (const conflict of r.conflicts) add(conflict);
        if (r.row === null || !mysql) continue;
        keyTuples(table, r.row).forEach((k, ki) => {
          if (k === null || !k.tuple.some((v) => typeof v === 'string' && v.endsWith(' '))) return;
          trimmed.add(`${c.table}|${ki}|${rekey(o.dialect, k.tuple)}`);
        });
        if (trimmed.size > TRIMMED_MAX) {
          // Too many keys end in a blank to check them all: the table is reported as a whole.
          add({ table, kind: 'invalid', columns: [...TABLE_KEYS[table].pk], pk: null });
          return { done: true, checkpoint: { ...c, trimmed: [], seen: [] } };
        }
        continue;
      }
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // reported by the first pass
      }
      keyTuples(table, row).forEach((k, ki) => {
        if (k === null) return;
        const id = `${c.table}|${ki}|${rekey(o.dialect, k.tuple)}`;
        if (!trimmed.has(id)) return;
        if (!seen.has(id)) {
          seen.add(id);
          return;
        }
        const value = shown(k.tuple.map(String).join(', ').replace(/ +$/u, ''));
        add({ table, kind: 'duplicate', columns: [...k.columns], pk: pkOfRow(table, row), value });
      });
    }
    c.part += 1;
  }
  const done = c.conflicts.length >= CONFLICTS_MAX || (c.table >= tables.length && (c.pass === 2 || !mysql || trimmed.size === 0));
  return { done, checkpoint: { ...c, trimmed: [...trimmed], seen: [...seen] } };
}

/** `ops/<opId>/report.json`. */
function reportPath(dataDir: string, opId: string) {
  return dataPath(dataDir, 'ops', opId, 'report.json');
}

/** Writes the report of the restore `opId` (atomically). @throws DomainError DISK_QUOTA (P21) */
export async function writeRestoreReport(dataDir: string, opId: string, report: RestoreReport): Promise<void> {
  await writeBytesAtomic(reportPath(dataDir, opId), `${JSON.stringify(report, null, 2)}\n`);
}

const REPORT_MAX_BYTES = 16 * 1024 * 1024;

/** The report of the restore `opId`, or null when it has none (or it cannot be read). */
export async function readRestoreReport(dataDir: string, opId: string): Promise<RestoreReport | null> {
  const bytes = await readBytes(reportPath(dataDir, opId), REPORT_MAX_BYTES);
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString('utf8')) as RestoreReport;
  } catch {
    return null;
  }
}

/** RESTORE_CONFLICTS: the pre-pass found rows that cannot load. */
export function conflictsError(count: number): DomainError {
  return new DomainError('RESTORE_CONFLICTS', {
    detail:
      `Pemeriksaan awal menemukan ${count} baris yang tidak dapat dimuat; unduh laporan konflik / ` +
      `The pre-check found ${count} row(s) that cannot be loaded; download the conflict report`,
  });
}

// ---- Komunitas K1 (edition lane) ----

/**
 * Refuses a restore, or the update revert's restore, onto a database that holds what a migration of the other lane
 * ("migrasi jalur lain") made, while this code ships none (its lane is empty): rows of `schema_migrations_edition`, or
 * tables whose `schema_tables.created_by` names such a migration (`eNNNN_slug`). This code cannot tell what those tables
 * need, so the restore stops before its point of no return and the database stays as it is; code that knows them
 * restores it. Behind this refusal the restore's drop also keeps them (load.ts).
 *
 * @throws DomainError BACKUP_EDITION_TABLES (409) with `meta.count`: the rows of the lane, or its tables when it has no
 *   rows
 */
export async function assertNoEditionTables(db: Kysely<DB>): Promise<void> {
  if (Object.keys(EDITION_MIGRATIONS).length > 0) return;
  const { rows, tables } = await editionLaneState(db);
  if (rows === 0 && tables.length === 0) return;
  const count = rows > 0 ? rows : tables.length;
  throw new DomainError('BACKUP_EDITION_TABLES', {
    detail:
      `Database ini memuat ${count} migrasi atau tabel jalur lain; pulihkan dengan kode yang mengenalnya / ` +
      `This database holds ${count} migration(s) or table(s) of another migration lane; restore it with code that knows them`,
    meta: { count },
  });
}
