import { openForeignMysql, type ForeignMysql, type ForeignMysqlConfig } from '@altis/db';
import { DomainError } from '@altis/shared';
import { textCell } from './clean-text.js';
import { slimsTableRole } from './detect.js';
import type { SlimsDbConfig, SlimsRow, SlimsSource, SlimsTableInfo } from './types.js';

// The direct-connection source (spec §11.1): a SLiMS MySQL/MariaDB database read through @altis/db's foreign client
// (B5: one connection, LOCAL INFILE off, no multiple statements, text as Buffers). Only SELECT statements, every
// table and column name a `??` value (the `cf_*` columns of the custom tables come from the source), every value a `?`.
//
// - tables(): the base tables of the connection's database (information_schema), their columns in order, their primary
//   keys, and exact row counts (COUNT(*)) for the tables the migration reads, reports as "Fase 3", or reports as
//   derived (the report lists them with their rows, as the dump path does); tables it does not know have
//   `rows: null`. Read once per source.
// - rows(): keyset pages of at most 500 rows ordered by the primary key, the next page after the last key as a row
//   comparison `(a, b) > (?, ?)`; the cursor is `k:` and the JSON of that key. A table without a primary key is paged
//   by LIMIT/OFFSET (cursor `o:<offset>`) and flagged `no_pk`. A text key value travels back as text, so the server
//   compares it in the column's collation, as it orders it.
// - The tables whose row order the migration's result depends on (IN_TABLE_ORDER: the author and subject links of a
//   record, whose first level-1 author is its main entry and whose links are numbered as they come) are read in the
//   table's own order, as mysqldump reads them (no ORDER BY), paged by LIMIT/OFFSET: a MyISAM table, as SLiMS creates
//   them, gives its rows in the order they were entered (the order the librarian added the authors), an InnoDB table
//   in primary-key order. The database path and the dump path then see the same order.
// - Text cells come back as text when their bytes are valid UTF-8 and as bytes otherwise (textCell), as from a dump.
//
// The usage import (spec §11.2) opens it with its own list (`tables`: only those tables are listed, counted and read,
// and only those of their columns are named in a SELECT), a row transform (the member id replaced by its keyed hash
// before a row is returned) and `secretColumns` (the hashed columns): a table whose primary key is not wholly among the
// selected columns, or holds a secret column, is paged by `ORDER BY <primary key> LIMIT ? OFFSET ?` with the cursor
// `o:<offset>`, so neither a raw member id nor an unread column ever travels in a cursor or a statement's values. Rows
// the server adds or removes during the read may then be skipped or read twice, as for a table without a key.
//
// An unreachable server, a refused login, an unknown database or a TLS failure is DomainError
// MIGRATION_SOURCE_UNREACHABLE with a short `meta.reason` (never the server's own message, which names hosts).

/** The connect timeout (§11.1: 10 s). */
export const DB_CONNECT_TIMEOUT_MS = 10_000;
/** The most rows one call reads (§11.1). */
export const DB_BATCH_MAX = 500;

/** The tables read in their own order rather than by primary key (see the module comment). */
const IN_TABLE_ORDER: ReadonlySet<string> = new Set(['biblio_author', 'biblio_topic']);

export interface OpenDbSourceOptions {
  connectTimeoutMs?: number;
  /** The foreign client (default @altis/db's openForeignMysql); a test seam. */
  connect?: (cfg: ForeignMysqlConfig, o: { connectTimeoutMs: number }) => Promise<ForeignMysql>;
  /**
   * Read only these tables (any other is neither listed nor read), and of each only these columns, those the table has,
   * in this order; every listed table is counted. Without it every table and column (the catalogue migration).
   */
  tables?: Readonly<Record<string, readonly string[]>>;
  /** Applied to each row (after the projection) before `rows()` returns it: the usage import hashes here. */
  transform?: (table: string, row: SlimsRow) => SlimsRow;
  /** Per table, the columns whose values never go into a cursor (see the module comment). */
  secretColumns?: Readonly<Record<string, readonly string[]>>;
}

/** Why the source cannot be read (`meta.reason`). */
export type DbUnreachableReason = 'refused' | 'timeout' | 'dns' | 'network' | 'access_denied' | 'unknown_database' | 'tls' | 'connection_lost' | 'other';

const REASONS: ReadonlyMap<string, DbUnreachableReason> = new Map([
  ['ECONNREFUSED', 'refused'],
  ['ETIMEDOUT', 'timeout'],
  ['PROTOCOL_SEQUENCE_TIMEOUT', 'timeout'],
  ['ENOTFOUND', 'dns'],
  ['EAI_AGAIN', 'dns'],
  ['EHOSTUNREACH', 'network'],
  ['ENETUNREACH', 'network'],
  ['EHOSTDOWN', 'network'],
  ['ENETDOWN', 'network'],
  ['EADDRNOTAVAIL', 'network'],
  ['ER_ACCESS_DENIED_ERROR', 'access_denied'],
  ['ER_ACCESS_DENIED_NO_PASSWORD_ERROR', 'access_denied'],
  ['ER_DBACCESS_DENIED_ERROR', 'access_denied'],
  ['ER_TABLEACCESS_DENIED_ERROR', 'access_denied'],
  ['ER_NOT_SUPPORTED_AUTH_MODE', 'access_denied'],
  ['AUTH_SWITCH_PLUGIN_ERROR', 'access_denied'],
  ['ER_BAD_DB_ERROR', 'unknown_database'],
  ['HANDSHAKE_SSL_ERROR', 'tls'],
  ['HANDSHAKE_NO_SSL_SUPPORT', 'tls'],
  ['PROTOCOL_CONNECTION_LOST', 'connection_lost'],
  ['ECONNRESET', 'connection_lost'],
  ['ECONNABORTED', 'connection_lost'],
  ['EPIPE', 'connection_lost'],
  ['ER_SERVER_SHUTDOWN', 'connection_lost'],
  ['POOL_CLOSED', 'connection_lost'],
]);
const TLS_CODE = /^(?:ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH)/;

function reasonOf(error: unknown): DbUnreachableReason | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== 'string') return null;
  if (REASONS.has(code)) return REASONS.get(code)!;
  if (/^EAI_/.test(code)) return 'dns';
  if (TLS_CODE.test(code)) return 'tls';
  return null;
}

function unreachable(reason: DbUnreachableReason, cause: unknown): DomainError {
  return new DomainError('MIGRATION_SOURCE_UNREACHABLE', {
    detail: `Basis data SLiMS tidak dapat dibaca (${reason}) / The SLiMS database cannot be read (${reason})`,
    meta: { reason },
    cause,
  });
}

/** A Buffer cell as text (UTF-8, from the identifiers and counts of information_schema). */
function text(v: unknown): string {
  return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
}

/** The value of a key column in a cursor: text when it is UTF-8, else its bytes as `{$hex}`. */
function cursorValue(v: unknown): unknown {
  if (!Buffer.isBuffer(v)) return v;
  const cell = textCell(v);
  return typeof cell === 'string' ? cell : { $hex: Buffer.from(cell).toString('hex') };
}

/** A cursor's key value as a statement value. */
function keyValue(v: unknown): unknown {
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && typeof (v as { $hex?: unknown }).$hex === 'string' && /^(?:[0-9a-f]{2})*$/.test((v as { $hex: string }).$hex)) {
    return Buffer.from((v as { $hex: string }).$hex, 'hex');
  }
  throw new TypeError('rows: not a cursor of this source');
}

/** A row as the source hands it over: the requested columns in order, a Buffer as its text or bytes. */
function cells(raw: Record<string, unknown>, columns: readonly string[]): SlimsRow {
  const row: SlimsRow = {};
  for (const c of columns) {
    const v = raw[c];
    const value = v === undefined || v === null ? null : Buffer.isBuffer(v) ? textCell(v) : typeof v === 'number' || typeof v === 'string' ? v : String(v);
    if (c === '__proto__') Object.defineProperty(row, c, { value, enumerable: true, writable: true, configurable: true });
    else row[c] = value;
  }
  return row;
}

const placeholders = (n: number, p: string): string => Array.from({ length: n }, () => p).join(', ');

/**
 * Opens a read-only connection to a SLiMS database (see the module comment), giving up after `o.connectTimeoutMs`
 * (default 10 s).
 *
 * @throws DomainError `MIGRATION_SOURCE_UNREACHABLE` (`meta.reason`) when the server cannot be reached or read
 */
export async function openDbSource(cfg: SlimsDbConfig, o: OpenDbSourceOptions = {}): Promise<SlimsSource> {
  const connect = o.connect ?? openForeignMysql;
  const projection = o.tables;
  const transform = o.transform;
  const secrets = o.secretColumns ?? {};
  let db: ForeignMysql;
  try {
    db = await connect(
      { host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, tls: cfg.tls },
      { connectTimeoutMs: o.connectTimeoutMs ?? DB_CONNECT_TIMEOUT_MS },
    );
  } catch (error) {
    throw unreachable(reasonOf(error) ?? 'other', error);
  }

  const query = async (sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]> => {
    try {
      return await db.query(sql, params);
    } catch (error) {
      const reason = reasonOf(error);
      throw reason === null ? error : unreachable(reason, error);
    }
  };

  let listed: Promise<Map<string, SlimsTableInfo>> | null = null;
  const load = async (): Promise<Map<string, SlimsTableInfo>> => {
    const names = (await query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", [])).map((r) =>
      text(r['name']),
    );
    const columns = new Map<string, { name: string; at: number }[]>();
    for (const r of await query('SELECT TABLE_NAME AS tname, COLUMN_NAME AS cname, ORDINAL_POSITION AS position FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION', [])) {
      const t = text(r['tname']);
      columns.set(t, [...(columns.get(t) ?? []), { name: text(r['cname']), at: Number(r['position']) }]);
    }
    const keys = new Map<string, { name: string; at: number }[]>();
    for (const r of await query(
      "SELECT TABLE_NAME AS tname, COLUMN_NAME AS cname, SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = 'PRIMARY' ORDER BY TABLE_NAME, SEQ_IN_INDEX",
      [],
    )) {
      const t = text(r['tname']);
      keys.set(t, [...(keys.get(t) ?? []), { name: text(r['cname']), at: Number(r['seq']) }]);
    }
    const ordered = (list: { name: string; at: number }[] | undefined): string[] => [...(list ?? [])].sort((a, b) => a.at - b.at).map((c) => c.name);
    const out = new Map<string, SlimsTableInfo>();
    for (const name of [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (projection !== undefined && !Object.hasOwn(projection, name)) continue;
      const role = slimsTableRole(name);
      const counted = projection !== undefined || role !== 'other';
      const rows = counted ? Number((await query('SELECT COUNT(*) AS n FROM ??', [name]))[0]?.['n'] ?? 0) : null;
      const primaryKey = ordered(keys.get(name));
      const present = ordered(columns.get(name));
      const selected = projection === undefined ? present : projection[name]!.filter((c) => present.includes(c));
      out.set(name, { name, columns: selected, primaryKey, rows, ...(primaryKey.length === 0 ? { flags: ['no_pk' as const] } : {}) });
    }
    return out;
  };
  const tables = (): Promise<Map<string, SlimsTableInfo>> => (listed ??= load().catch((error: unknown) => {
    listed = null;
    throw error;
  }));
  const copy = (t: SlimsTableInfo): SlimsTableInfo => ({ ...t, columns: [...t.columns], primaryKey: [...t.primaryKey], ...(t.flags === undefined ? {} : { flags: [...t.flags] }) });

  return {
    kind: 'db',
    async tables() {
      return [...(await tables()).values()].map(copy);
    },
    async rows(table, after, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('rows: limit must be a positive integer');
      const info = (await tables()).get(table);
      if (info === undefined || info.columns.length === 0) return { rows: [], next: null };
      const take = Math.min(limit, DB_BATCH_MAX);
      const columns = info.columns;
      const select = `SELECT ${placeholders(columns.length, '??')} FROM ??`;
      const out = (r: Record<string, unknown>): SlimsRow => (transform === undefined ? cells(r, columns) : transform(table, cells(r, columns)));
      const key = info.primaryKey;
      const secret = Object.hasOwn(secrets, table) ? secrets[table]! : [];
      const inTableOrder = projection === undefined && IN_TABLE_ORDER.has(table);
      const keyset = !inTableOrder && key.length > 0 && key.every((c) => columns.includes(c) && !secret.includes(c));

      if (!keyset) {
        // No key (flagged no_pk), one a cursor must not carry, or a table read in its own order: by offset, in key
        // order when there is a key to order by.
        const m = after === null ? null : /^o:(\d{1,15})$/.exec(after);
        if (after !== null && m === null) throw new TypeError('rows: not a cursor of this source');
        const offset = m === null ? 0 : Number(m[1]);
        const by = key.length === 0 || inTableOrder ? [] : key;
        const order = by.length === 0 ? '' : ` ORDER BY ${placeholders(by.length, '??')}`;
        const raw = await query(`${select}${order} LIMIT ? OFFSET ?`, [...columns, table, ...by, take, offset]);
        return { rows: raw.map(out), next: raw.length === take ? `o:${offset + take}` : null };
      }

      let last: unknown[] | null = null;
      if (after !== null) {
        let parsed: unknown;
        try {
          parsed = after.startsWith('k:') ? JSON.parse(after.slice(2)) : undefined;
        } catch {
          parsed = undefined;
        }
        if (!Array.isArray(parsed) || parsed.length !== key.length) throw new TypeError('rows: not a cursor of this source');
        last = parsed.map(keyValue);
      }
      const where = last === null ? '' : ` WHERE (${placeholders(key.length, '??')}) > (${placeholders(key.length, '?')})`;
      const sql = `${select}${where} ORDER BY ${placeholders(key.length, '??')} LIMIT ?`;
      const raw = await query(sql, [...columns, table, ...(last === null ? [] : [...key, ...last]), ...key, take]);
      const end = raw[raw.length - 1];
      return {
        rows: raw.map(out),
        next: raw.length === take && end !== undefined ? `k:${JSON.stringify(key.map((c) => cursorValue(end[c])))}` : null,
      };
    },
    async close() {
      await db.close();
    },
  };
}
