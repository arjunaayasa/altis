import type {
  CompiledQuery,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from 'kysely';
import { isDomainError, type DomainError } from '@altis/shared';
import {
  isConnectionLost,
  markInDoubt,
  normalizeConnectError,
  normalizeDbError,
  normalizeStatementError,
  wasNotSent,
} from './db-errors.js';

// Wraps a Kysely dialect so that every statement Kysely runs:
//   - reports driver errors through normalizeDbError (one layer, spec §6.2; normalizeStatementError for statements,
//     normalizeConnectError for acquiring a connection, which maps network and TLS failures to DB_UNAVAILABLE), and
//   - when it is a read outside a transaction that failed because the connection died, and it was the FIRST
//     statement of its connection acquisition, is run once more on a fresh connection (P17, ruling R14). A later
//     statement of a pinned connection (`db.connection()`, Kysely's Migrator) is not: whatever the session held
//     (a GET_LOCK or pg advisory lock, SET values, temporary tables) died with it, and carrying on in a fresh
//     session would silently drop that. Statements calling lock functions are never re-run either.
//   - A connection whose session ended ({@link endsSession}: connection_lost, an established socket that timed out
//     mid-statement, a packet the server refused and closed the session for, a raw error mysql2 flags fatal, a
//     PostgreSQL FATAL/PANIC) is never used again: every later statement, stream, COMMIT or savepoint on it rejects
//     with the very error that reported the end, without reaching the driver (pg would answer "Client ... is not
//     queryable"). So a try/finally that sends one more statement (Kysely's runWithLock releasing its lock)
//     surfaces the original failure instead of masking it. A ROLLBACK on it is skipped: the server rolled back when
//     the session ended. It is never handed back to the pool either: the driver discards it
//     ({@link DiscardingDriver}), so the next acquirer cannot be given the dead connection (a server that ends the
//     session after an error sends the error before its socket close is processed).
//   - A TX_CONFLICT (deadlock, serialization failure) inside a transaction ends that transaction for good: MySQL/MariaDB
//     have already rolled it back (later statements would autocommit on their own), PostgreSQL has aborted it. Every
//     later statement, stream, savepoint and the COMMIT of that transaction reject with the very same error, unsent,
//     even when the caller caught it; only the ROLLBACK is sent. So withTx rolls back and runs its callback again
//     instead of committing half a unit of work (fix round 1, item 8).
//   - Writes are never re-run: whether the first attempt reached the server is unknown. A lost statement that may
//     modify data ({@link mayModifyData}) and a lost COMMIT carry `meta.inDoubt: true` (ruling R28); statements
//     that change no data (reads, row-locking reads, lock-function calls, EXPLAIN, read PRAGMAs, BEGIN/SET/...)
//     and statements never sent do not. `retryable` only says the condition is transient: after an in-doubt
//     failure the outcome is unknown, so only idempotent work may be retried, and the caller decides.

/** First keyword of a statement that may be re-run: it only reads. */
const READ_START = /^(?:select|with|show)\b/i;
/** A read PRAGMA: a bare name, no `= value` and no `(argument)` (which sets the value for most pragmas). */
const READ_PRAGMA = /^pragma\s+[a-z_][\w.]*\s*;?\s*$/i;
/**
 * Words that make a SELECT/WITH/SHOW unsafe to re-run, or that cannot be proven harmless: data-modifying CTEs,
 * `SELECT ... INTO`, row locks (`FOR UPDATE`, `LOCK IN SHARE MODE`), sequence side effects. Matching is textual
 * and so errs on the side of not retrying (an identifier spelled like one of these also prevents the retry).
 */
const WRITE_WORD =
  /\b(?:insert|update|delete|merge|replace|upsert|into|create|alter|drop|truncate|grant|revoke|call|lock|nextval|setval)\b/i;
/**
 * Lock functions: MySQL/MariaDB named locks and PostgreSQL advisory locks belong to the session, so a statement
 * calling one must never move to another connection (Kysely's migration lock is one of these).
 */
const LOCK_FUNCTION =
  /\b(?:get_lock|release_lock|release_all_locks|is_free_lock|is_used_lock|pg_advisory_\w*|pg_try_advisory_\w*)\b/i;
/** Words that make a SELECT/WITH/SHOW change data: data-modifying CTEs, `SELECT ... INTO`, sequence side effects. */
const DATA_WORD =
  /\b(?:insert|update|delete|merge|replace|upsert|into|create|alter|drop|truncate|grant|revoke|call|nextval|setval)\b/i;
/** Row-lock clauses of a SELECT: they lock rows but change nothing. */
const ROW_LOCK_CLAUSE = /\bfor\s+(?:no\s+key\s+)?update\b|\bfor\s+(?:key\s+)?share\b|\block\s+in\s+share\s+mode\b/gi;
/**
 * Statements that never change data: transaction control and session settings. Not MariaDB's compound
 * `BEGIN NOT ATOMIC ... END`, and not `SET ... autocommit` (switching autocommit on commits; {@link SET_AUTOCOMMIT}).
 */
const NO_DATA_START =
  /^(?:begin\b(?!\s+not\s+atomic\b)|start\s+transaction\b|rollback\b|savepoint\b|release\s+savepoint\b|set\b|use\b)/i;
const SET_AUTOCOMMIT = /^set\b[^;]*\bautocommit\b/i;
/** EXPLAIN / DESCRIBE, and the bare-word options that may follow EXPLAIN (a parenthesized list is parsed). */
const EXPLAIN_START = /^(?:explain|describe|desc)\b/i;
const EXPLAIN_WORD = /^(?:(analy[sz]e)|verbose|extended|partitions|format\s*=\s*\w+)\b/i;
/** ANALYZE inside an EXPLAIN option list, unless switched off. */
const ANALYZE_OPTION = /\banaly[sz]e\b(?!\s+(?:false|off|0)\b)/i;

/** Leading white space, `-- ...` and `/* ... *\/` comments, and opening parentheses (`(SELECT ...) UNION ...`). */
function stripLead(sqlText: string): string {
  let text = sqlText;
  for (;;) {
    const next = text.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\()/, '');
    if (next === text) return text;
    text = next;
  }
}

/**
 * True when `sqlText` only reads and may be run a second time: `SELECT`, `WITH ... SELECT`, `SHOW`, or a read
 * `PRAGMA`, without any word of {@link WRITE_WORD} and without a lock function ({@link LOCK_FUNCTION}).
 */
export function isReadOnlyStatement(sqlText: string): boolean {
  const text = stripLead(sqlText);
  if (READ_PRAGMA.test(text)) return true;
  return READ_START.test(text) && !WRITE_WORD.test(text) && !LOCK_FUNCTION.test(text);
}

/**
 * How a text is tokenized: `mysql` (MySQL/MariaDB: backslash escapes in '...' and "...", `#` comments, `--`
 * comments only before white space, no dollar quotes) or `standard` (PostgreSQL/SQLite: quotes escape only by
 * doubling, except PostgreSQL E'...' strings; `--` always a comment; `$tag$` dollar quotes). The classifier does not
 * know the dialect, so it tries both and keeps the more cautious answer.
 */
type ScanMode = 'mysql' | 'standard';

/** One pass over a statement text: the text with quotes and comments blanked, and what the pass noticed. */
interface Scan {
  /** The text with every string, quoted identifier and comment replaced by one blank. */
  plain: string;
  /** Something other than white space and comments follows a `;` at the top level: a second statement. */
  later: boolean;
  /** A quote, dollar quote or block comment is never closed: the pass cannot be trusted. */
  unterminated: boolean;
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * The end (just past) of the quoted span or comment starting at `i`, and whether it was closed; null when none
 * starts there.
 */
function quotedSpan(text: string, i: number, mode: ScanMode): { end: number; closed: boolean } | null {
  const c = text[i];
  const before = i > 0 ? text[i - 1] ?? '' : '';
  if (c === "'" || c === '"' || c === '`') {
    // Backslash escapes: MySQL strings, and PostgreSQL E'...' strings (E not part of a longer word).
    const eString = c === "'" && /[eE]/.test(before) && (i < 2 || !IDENTIFIER_CHAR.test(text[i - 2] ?? ''));
    const backslash = c !== '`' && (mode === 'mysql' || eString);
    for (let j = i + 1; j < text.length; ) {
      if (text[j] === c) {
        if (text[j + 1] === c) j += 2; // a doubled quote is an escaped one
        else return { end: j + 1, closed: true };
      } else j += backslash && text[j] === '\\' ? 2 : 1;
    }
    return { end: text.length, closed: false };
  }
  const lineComment =
    (c === '-' && text[i + 1] === '-' && (mode === 'standard' || i + 2 >= text.length || /\s/.test(text[i + 2] ?? ''))) ||
    (c === '#' && mode === 'mysql');
  if (lineComment) {
    const end = text.indexOf('\n', i);
    return { end: end === -1 ? text.length : end + 1, closed: true };
  }
  if (c === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? { end: text.length, closed: false } : { end: end + 2, closed: true };
  }
  if (c === '$' && mode === 'standard' && !IDENTIFIER_CHAR.test(before)) {
    const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(text.slice(i));
    if (tag !== null) {
      const end = text.indexOf(tag[0], i + tag[0].length);
      return end === -1 ? { end: text.length, closed: false } : { end: end + tag[0].length, closed: true };
    }
  }
  return null;
}

function scan(text: string, mode: ScanMode): Scan {
  let plain = '';
  let depth = 0;
  let afterSemicolon = false;
  let later = false;
  let unterminated = false;
  for (let i = 0; i < text.length; ) {
    const span = quotedSpan(text, i, mode);
    if (span !== null) {
      const isComment = text[i] === '-' || text[i] === '#' || (text[i] === '/' && text[i + 1] === '*');
      if (afterSemicolon && !isComment) later = true;
      if (!span.closed) unterminated = true;
      plain += ' ';
      i = span.end;
      continue;
    }
    const c = text[i] ?? '';
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ';' && depth === 0) afterSemicolon = true;
    else if (afterSemicolon && !/\s/.test(c)) later = true;
    plain += c;
    i += 1;
  }
  return { plain, later, unterminated };
}

/** The index of the `)` closing the `(` at `start` in a text without quotes, or the end. */
function closingParen(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && (depth -= 1) === 0) return i;
  }
  return text.length;
}

/**
 * After EXPLAIN (in a text whose quotes are blanked): whether ANALYZE (which runs the statement) is among its
 * options, and the explained statement.
 */
function explained(rest: string): { analyze: boolean; statement: string } {
  let text = rest;
  let analyze = false;
  for (;;) {
    text = text.replace(/^\s+/, '');
    if (text.startsWith('(')) {
      const end = closingParen(text, 0);
      if (ANALYZE_OPTION.test(text.slice(1, end))) analyze = true;
      text = text.slice(end + 1);
      continue;
    }
    const word = EXPLAIN_WORD.exec(text);
    if (word === null) return { analyze, statement: stripLead(text) };
    if (word[1] !== undefined) analyze = true;
    text = text.slice(word[0].length);
  }
}

/** {@link mayModifyData} for one way of reading the text. */
function mayModifyAs(text: string, mode: ScanMode): boolean {
  const { plain, later, unterminated } = scan(text, mode);
  if (unterminated || later) return true; // cannot tell where the statement ends, or a second one follows
  if (READ_PRAGMA.test(plain)) return false;
  if (SET_AUTOCOMMIT.test(plain)) return true;
  if (NO_DATA_START.test(plain)) return false;
  let body = plain;
  if (EXPLAIN_START.test(body)) {
    const { analyze, statement } = explained(body.replace(EXPLAIN_START, ''));
    if (!analyze) return false;
    body = statement;
  }
  if (!READ_START.test(body)) return true;
  return DATA_WORD.test(body.replace(ROW_LOCK_CLAUSE, ' '));
}

/**
 * True when `sqlText` may change data, so that losing the connection while it ran leaves its outcome unknown
 * (`meta.inDoubt`, ruling R28). False for one SELECT/WITH/SHOW without a data-modifying word (row-lock clauses
 * such as `FOR UPDATE` and lock-function calls change no data), EXPLAIN without ANALYZE (EXPLAIN ANALYZE runs its
 * statement and is judged by it; the whole option list is read), read PRAGMAs, and BEGIN / START TRANSACTION /
 * ROLLBACK / SAVEPOINT / RELEASE SAVEPOINT / SET / USE. Anything else counts as a possible change: COMMIT, `SET
 * ... autocommit`, MariaDB's `BEGIN NOT ATOMIC`, a text holding a second statement after a top-level `;`, a text
 * whose quote, dollar quote or block comment is never closed, and unknown statements. Words inside string
 * literals, quoted identifiers and comments do not count. The text is read both the MySQL way and the
 * PostgreSQL/SQLite way (backslash escapes, `#` and `--` comments, dollar quotes differ) and is judged a possible
 * change when either reading says so. Textual: a function with side effects called from a SELECT (`pg_notify`, a
 * user function that writes) is not detected.
 */
export function mayModifyData(sqlText: string): boolean {
  const text = stripLead(sqlText);
  return mayModifyAs(text, 'mysql') || mayModifyAs(text, 'standard');
}

/**
 * True for a normalized error after which the connection is unusable: lost, timed out mid-statement, or closed by
 * the server after refusing an oversized packet.
 */
function endsConnection(normalized: unknown): normalized is DomainError {
  if (!isDomainError(normalized) || normalized.code !== 'DB_UNAVAILABLE') return false;
  const reason = normalized.meta?.['reason'];
  return reason === 'connection_lost' || reason === 'timeout' || reason === 'packet_too_large';
}

/**
 * SQLSTATEs PostgreSQL raises only as FATAL: idle_in_transaction_session_timeout (25P03), transaction_timeout
 * (25P04), database_dropped (57P04). Codes that also come as plain ERRORs are not listed.
 */
const PG_FATAL_ONLY: ReadonlySet<string> = new Set(['25P03', '25P04', '57P04']);

/**
 * A PostgreSQL error after which the server ends the session (pg sets no `fatal`): severity FATAL or PANIC, or one
 * of {@link PG_FATAL_ONLY}. pg reports the severity as the server's localized text (a server with lc_messages in
 * Russian sends `ВАЖНО`), so the codes that are always FATAL are recognised by code as well.
 */
function pgSessionFatal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { severity, code } = error as { severity?: unknown; code?: unknown };
  return severity === 'FATAL' || severity === 'PANIC' || (typeof code === 'string' && PG_FATAL_ONLY.has(code));
}

/**
 * Whether `error` ended the session, given its normalization `normalized` ({@link normalizeStatementError}): a
 * normalized loss, a raw error mysql2 flags `fatal` (it closes the connection after it; a protocol error and the
 * like), or a PostgreSQL FATAL/PANIC (25P03 idle_in_transaction_session_timeout, ...).
 */
function ended(error: unknown, normalized: unknown): boolean {
  if (endsConnection(normalized) || pgSessionFatal(error)) return true;
  return normalized === error && typeof error === 'object' && error !== null && (error as { fatal?: unknown }).fatal === true;
}

/**
 * True when `error`, the driver's error for a statement (or COMMIT, ...) on an established connection, means that
 * connection's session is over, so the connection must never be used or pooled again. The guard decides by it (a
 * GuardedConnection's `lostWith`), and connect.ts's pg pool facade marks its dead clients by it too.
 */
export function endsSession(error: unknown): boolean {
  return ended(error, normalizeStatementError(error));
}

/**
 * A {@link Driver} that can drop a connection instead of returning it to its pool; connect.ts gives the MySQL/MariaDB
 * and PostgreSQL drivers this. GuardedDriver hands it every connection whose session ended, instead of
 * releaseConnection: MySQL/MariaDB send 1053, 1153, 1927 or 4031 (and PostgreSQL a FATAL error) before they close the
 * socket, so a connection released before the close is processed would be pooled again and handed to the next
 * acquirer dead.
 */
export interface DiscardingDriver extends Driver {
  discardConnection(connection: DatabaseConnection): Promise<void>;
}

function canDiscard(driver: Driver): driver is DiscardingDriver {
  return typeof (driver as Partial<DiscardingDriver>).discardConnection === 'function';
}

class GuardedConnection implements DatabaseConnection {
  /** The driver connection; replaced by a fresh one when a retry had to take a new connection. */
  inner: DatabaseConnection | null;
  /** Between beginTransaction and commit/rollback: nothing is retried. */
  inTransaction = false;
  /**
   * Once this connection's session ended: the error that reported it. Everything later rejects with it, without
   * reaching the driver, and the connection is discarded on release (see the top of this file). Also set when the
   * P17 retry could not get a fresh connection.
   */
  lostWith: { error: unknown } | null = null;
  /**
   * While inTransaction: the TX_CONFLICT that ended the transaction. Everything later in it rejects with this error,
   * unsent, until the ROLLBACK (see the top of this file).
   */
  conflictWith: { error: unknown } | null = null;
  /**
   * A statement (or a transaction) has been started on this acquisition. From then on the session may hold state
   * the caller relies on, so a lost connection is never replaced: only the first statement may be retried.
   */
  used = false;

  // Kysely's in-flight query abort (used only with abort signals) needs these; offered when the driver has them.
  cancelQuery?: DatabaseConnection['cancelQuery'];
  collectSessionInfo?: DatabaseConnection['collectSessionInfo'];
  killSession?: DatabaseConnection['killSession'];

  readonly #driver: GuardedDriver;

  constructor(inner: DatabaseConnection, driver: GuardedDriver) {
    this.inner = inner;
    this.#driver = driver;
    if (inner.cancelQuery) this.cancelQuery = (provider) => this.current().cancelQuery?.(provider) ?? Promise.resolve();
    if (inner.collectSessionInfo) this.collectSessionInfo = () => this.current().collectSessionInfo?.() ?? Promise.resolve();
    if (inner.killSession) this.killSession = (provider) => this.current().killSession?.(provider) ?? Promise.resolve();
  }

  /** The current driver connection (throws the loss error if a failed retry left none). */
  current(): DatabaseConnection {
    if (this.inner === null) {
      if (this.lostWith !== null) throw this.lostWith.error;
      throw new Error('database connection already released after a failed retry');
    }
    return this.inner;
  }

  /**
   * Throws the loss error when this connection already died, or the conflict that ended the current transaction:
   * nothing is sent on a dead connection or in a transaction the server has already rolled back.
   */
  assertAlive(): void {
    if (this.lostWith !== null) throw this.lostWith.error;
    if (this.inTransaction && this.conflictWith !== null) throw this.conflictWith.error;
  }

  /**
   * Normalizes `error`. When it means the connection is gone, the result is marked in doubt if `changes` (the
   * failed work was sent and may have changed data; a statement refused unsent, NOT_SENT, never is) and remembered
   * as this connection's loss error.
   */
  fail(error: unknown, changes: boolean): unknown {
    const normalized = normalizeStatementError(error);
    if (this.inTransaction && isDomainError(normalized) && normalized.code === 'TX_CONFLICT') {
      this.conflictWith ??= { error: normalized };
      return normalized;
    }
    if (!endsConnection(normalized)) {
      // Other errors that end the session (a raw error mysql2 flags fatal, a PostgreSQL FATAL/PANIC): remembered
      // as they are returned (R32: the original object; a raw one when no DomainError fits it), not marked.
      if (ended(error, normalized)) this.lostWith = { error: normalized };
      return normalized;
    }
    // Never in doubt: a statement refused unsent (NOT_SENT), or one the server refused unrun (packet_too_large).
    const unrun = wasNotSent(normalized) || normalized.meta?.['reason'] === 'packet_too_large';
    const lost = changes && !unrun ? markInDoubt(normalized) : normalized;
    this.lostWith = { error: lost };
    return lost;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery, options?: Parameters<DatabaseConnection['executeQuery']>[1]): Promise<QueryResult<R>> {
    this.assertAlive();
    const first = !this.used;
    this.used = true;
    try {
      return await this.current().executeQuery<R>(compiledQuery, options);
    } catch (error) {
      const normalized = normalizeStatementError(error);
      if (first && !this.inTransaction && isConnectionLost(normalized) && isReadOnlyStatement(compiledQuery.sql)) {
        return this.#retry<R>(compiledQuery, options);
      }
      throw this.fail(error, mayModifyData(compiledQuery.sql));
    }
  }

  /**
   * The single retry of the acquisition's first statement: hand the dead connection back (discarded, so the pool
   * cannot give it out again), take a fresh one, which becomes this connection's from now on, and run the statement
   * there. Nothing ran on the dead session before, so nothing the caller relies on is lost. Any failure of the retry
   * is final.
   */
  async #retry<R>(compiledQuery: CompiledQuery, options: Parameters<DatabaseConnection['executeQuery']>[1]): Promise<QueryResult<R>> {
    const dead = this.current();
    this.inner = null;
    await this.#driver.handBack(dead, true).catch(() => {});
    try {
      this.inner = await this.#driver.inner.acquireConnection(options);
    } catch (error) {
      // No connection any more: whatever the scope sends next (a finally block) rethrows this error.
      const normalized = normalizeConnectError(error);
      this.lostWith = { error: normalized };
      throw normalized;
    }
    try {
      return await this.inner.executeQuery<R>(compiledQuery, options);
    } catch (error) {
      throw this.fail(error, false); // a read
    }
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    chunkSize: number,
    options?: Parameters<DatabaseConnection['streamQuery']>[2],
  ): AsyncIterableIterator<QueryResult<R>> {
    // Streams are never retried: rows may already have been handed out.
    this.assertAlive();
    this.used = true;
    try {
      yield* this.current().streamQuery<R>(compiledQuery, chunkSize, options);
    } catch (error) {
      throw this.fail(error, mayModifyData(compiledQuery.sql));
    }
  }
}

class GuardedDriver implements Driver {
  readonly inner: Driver;

  constructor(inner: Driver) {
    this.inner = inner;
  }

  async init(options?: Parameters<Driver['init']>[0]): Promise<void> {
    try {
      await this.inner.init(options);
    } catch (error) {
      throw normalizeDbError(error);
    }
  }

  async acquireConnection(options?: Parameters<Driver['acquireConnection']>[0]): Promise<DatabaseConnection> {
    try {
      return new GuardedConnection(await this.inner.acquireConnection(options), this);
    } catch (error) {
      // Opening a pooled connection: a network or TLS failure is DB_UNAVAILABLE (a 503), not a raw error (a 500).
      throw normalizeConnectError(error);
    }
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const c = connection as GuardedConnection;
    c.assertAlive();
    c.inTransaction = true;
    c.used = true;
    try {
      await this.inner.beginTransaction(c.current(), settings);
    } catch (error) {
      c.inTransaction = false;
      throw c.fail(error, false);
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const c = connection as GuardedConnection;
    try {
      c.assertAlive(); // never sent: not in doubt beyond what the loss error already says
      await this.inner.commitTransaction(c.current());
    } catch (error) {
      // A COMMIT that was sent and lost: the server may have committed before the connection died.
      if (error === c.lostWith?.error || error === c.conflictWith?.error) throw error;
      throw c.fail(error, true);
    } finally {
      c.inTransaction = false;
      c.conflictWith = null;
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const c = connection as GuardedConnection;
    try {
      // On a dead connection there is nothing to roll back: the server did it when the session ended. Trying
      // would only replace the error the caller needs to see.
      if (c.lostWith === null) await this.inner.rollbackTransaction(c.current());
    } catch (error) {
      throw c.fail(error, false);
    } finally {
      c.inTransaction = false;
      c.conflictWith = null;
    }
  }

  async savepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    const c = connection as GuardedConnection;
    if (this.inner.savepoint === undefined) throw new Error('the driver does not support savepoints');
    c.assertAlive();
    try {
      await this.inner.savepoint(c.current(), savepointName, compileQuery);
    } catch (error) {
      throw c.fail(error, false);
    }
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    const c = connection as GuardedConnection;
    if (this.inner.rollbackToSavepoint === undefined) throw new Error('the driver does not support savepoints');
    c.assertAlive();
    try {
      await this.inner.rollbackToSavepoint(c.current(), savepointName, compileQuery);
    } catch (error) {
      throw c.fail(error, false);
    }
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    const c = connection as GuardedConnection;
    if (this.inner.releaseSavepoint === undefined) throw new Error('the driver does not support savepoints');
    c.assertAlive();
    try {
      await this.inner.releaseSavepoint(c.current(), savepointName, compileQuery);
    } catch (error) {
      throw c.fail(error, false);
    }
  }

  async releaseConnection(connection: DatabaseConnection, options?: Parameters<Driver['releaseConnection']>[1]): Promise<void> {
    const c = connection as GuardedConnection;
    // Null after a retry that could not get a fresh connection: the dead one was handed back already.
    if (c.inner !== null) await this.handBack(c.inner, c.lostWith !== null, options);
  }

  /**
   * Hands a driver connection back: to the pool, or, when its session ended (`dead`), discarded so that the pool
   * never gives it out again. A driver without discardConnection (SQLite: one connection, no pool) releases it.
   */
  async handBack(connection: DatabaseConnection, dead: boolean, options?: Parameters<Driver['releaseConnection']>[1]): Promise<void> {
    if (dead && canDiscard(this.inner)) await this.inner.discardConnection(connection);
    else await this.inner.releaseConnection(connection, options);
  }

  async destroy(options?: Parameters<Driver['destroy']>[0]): Promise<void> {
    await this.inner.destroy(options);
  }
}

/**
 * `inner` with every driver error normalized, the P17 single retry of a read that is the first statement of its
 * connection, dead connections never used or pooled again, and lost data changes/COMMITs marked `meta.inDoubt` (see
 * the top of this file).
 */
export class GuardedDialect implements Dialect {
  readonly #inner: Dialect;

  constructor(inner: Dialect) {
    this.#inner = inner;
  }

  createDriver(): Driver {
    return new GuardedDriver(this.#inner.createDriver());
  }

  createQueryCompiler(): QueryCompiler {
    return this.#inner.createQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return this.#inner.createAdapter();
  }

  createIntrospector(db: Kysely<never>): DatabaseIntrospector {
    return this.#inner.createIntrospector(db);
  }
}
