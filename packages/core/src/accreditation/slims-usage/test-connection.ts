import { randomBytes } from 'node:crypto';
import type { ForeignMysql } from '@altis/db';
import { isCalendarDate, isDomainError } from '@altis/shared';
import type { SlimsDbConfigBody, SlimsUsageTestResponse } from '@altis/shared/api/accreditation';
import { textCell } from '../../migration/slims/source/clean-text.js';
import type { SlimsRow, SlimsSource } from '../../migration/slims/source/types.js';
import { openUsageDbSource } from '../../migration/slims/source/usage.js';
import { guessGroup } from './guess.js';
import { slimsUsageConnect } from './source.js';

// The connection test of the SLiMS usage import (`POST accreditation/slims-usage/test-connection`): it opens the
// database as the import would (only the usage tables and columns, member ids hashed under a key thrown away at once)
// and answers what an import would find there: each usage table with its rows, the member types with the group the
// import would guess for each, and the first and last month of loans and visits (MIN/MAX of their dates, past the
// empty and zero dates). SLiMS 9 table/column names (interoperability facts, no SLiMS code). A database that cannot be
// reached or read is an answer too: `{ok: false, code: 'MIGRATION_SOURCE_UNREACHABLE', reason}`, the reason a short
// code, never the server's own message.

/** The connect timeout (10 s). */
const CONNECT_TIMEOUT_MS = 10_000;
/** The member types read at most. */
const MEMBER_TYPES_MAX = 1_000;
/** The page of member types read at once. */
const PAGE = 500;
/** A reason shown to the admin: a short code. */
const REASON = /^[A-Za-z0-9_.:-]{1,100}$/;
/** The dated column of each table whose months the test answers. */
const DATED: readonly (readonly [string, string])[] = [
  ['loan', 'loan_date'],
  ['loan_history', 'loan_date'],
  ['visitor_count', 'checkin_date'],
];
/** Dates before this are empty, zero or the Unix epoch's day: never a month of use. */
const FIRST_COUNTED_DAY = '1970-01-02';

/** Why a connection failed, as a code: the DomainError's `meta.reason`, else the error's code, else `unreachable`. */
function reasonOf(error: unknown): string {
  const meta = isDomainError(error) ? (error.meta as { reason?: unknown } | undefined) : undefined;
  if (typeof meta?.reason === 'string' && REASON.test(meta.reason)) return meta.reason;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && REASON.test(code) && !isDomainError(error)) return code;
  return 'unreachable';
}

/** A cell as text (bytes read as UTF-8, else Latin-1), or null. */
function text(cell: SlimsRow[string] | Buffer | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return String(cell);
  const decoded = textCell(cell);
  return typeof decoded === 'string' ? decoded : Buffer.from(decoded).toString('latin1');
}

/** The month of a date text, when it starts with a calendar date. */
function monthOfText(value: string | null): string | null {
  if (value === null) return null;
  const date = value.slice(0, 10);
  return isCalendarDate(date) && date >= FIRST_COUNTED_DAY ? date.slice(0, 7) : null;
}

/** The member types of the source, in key order, each with its guessed group. */
async function memberTypes(source: SlimsSource): Promise<{ id: string; name: string; guess: ReturnType<typeof guessGroup> }[]> {
  const out: { id: string; name: string; guess: ReturnType<typeof guessGroup> }[] = [];
  let after: string | null = null;
  while (out.length < MEMBER_TYPES_MAX) {
    const page = await source.rows('mst_member_type', after, PAGE);
    for (const row of page.rows) {
      const id = text(row['member_type_id']);
      if (id === null || id.trim() === '' || out.length >= MEMBER_TYPES_MAX) continue;
      const name = text(row['member_type_name']) ?? '';
      out.push({ id: id.trim(), name, guess: guessGroup(name) });
    }
    if (page.next === null) break;
    after = page.next;
  }
  return out;
}

/** The first and last month of the dated tables the source has (null when none holds a counted date). */
async function monthSpan(conn: ForeignMysql, present: ReadonlyMap<string, readonly string[]>): Promise<{ first: string; last: string } | null> {
  let first: string | null = null;
  let last: string | null = null;
  for (const [table, column] of DATED) {
    if (!(present.get(table) ?? []).includes(column)) continue;
    const [row] = await conn.query('SELECT MIN(??) AS lo, MAX(??) AS hi FROM ?? WHERE ?? >= ?', [column, column, table, column, FIRST_COUNTED_DAY]);
    const lo = monthOfText(text(row?.['lo'] ?? null));
    const hi = monthOfText(text(row?.['hi'] ?? null));
    if (lo !== null && (first === null || lo < first)) first = lo;
    if (hi !== null && (last === null || hi > last)) last = hi;
  }
  return first === null || last === null ? null : { first, last };
}

/**
 * What an import would read from the SLiMS database `cfg` (see the top of this file). Never throws for the source's
 * failures: a database that cannot be reached or read answers `{ok: false}`.
 */
export async function testSlimsUsageConnection(cfg: SlimsDbConfigBody): Promise<SlimsUsageTestResponse> {
  const connect = slimsUsageConnect();
  // The session the source opened: the months are read on it too (the source itself only pages rows).
  const opened: { conn: ForeignMysql | null } = { conn: null };
  let source: SlimsSource | null = null;
  try {
    source = await openUsageDbSource(cfg, {
      hashKey: randomBytes(32),
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      connect: async (c, o) => (opened.conn = await connect(c, o)),
    });
    const tables = await source.tables();
    const present = new Map(tables.map((t) => [t.name, t.columns] as const));
    const types = present.has('mst_member_type') ? await memberTypes(source) : [];
    const months = opened.conn === null ? null : await monthSpan(opened.conn, present);
    return { ok: true, tables: tables.map((t) => ({ name: t.name, rows: t.rows })), memberTypes: types, months };
  } catch (error) {
    return { ok: false, code: 'MIGRATION_SOURCE_UNREACHABLE', reason: reasonOf(error) };
  } finally {
    await source?.close().catch(() => undefined);
  }
}
