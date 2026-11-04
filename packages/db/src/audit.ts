import { createHash } from 'node:crypto';
import { canonicalize, parseStrictJson } from '@altis/crypto';
import { DomainError, isUlid, newId } from '@altis/shared';
import { sql, type Transaction } from 'kysely';
import { checkText, describe } from './checks.js';
import { exclusive } from './concurrency.js';
import type { DbHandle } from './connect.js';
import type { DB } from './schema.js';
import { assertOutsideTx } from './tx.js';

// The hash-chained audit log (spec §6.3, §7.8).
//
// Every entry gets the next `seq` from the one row of audit_head, under that row's lock, inside the caller's
// transaction, so concurrent appends from any number of processes get 1, 2, 3, ... with no gap and no duplicate,
// and an entry exists exactly when the action it records was committed. Each entry's hash covers the previous
// entry's hash (`prev_hash`) and the entry itself in canonical form (RFC 8785):
//
//   hash = sha256hex(prevHash + canonicalize({id, seq, at, actorType, actorId, action, entity, entityId, branchId,
//                                             ip, meta}))
//
// with the genesis prevHash of 64 zeros. Changing, inserting or deleting any entry, or moving audit_head, breaks
// the chain at that point, which verifyAuditChain finds. Audit rows are never UPDATEd.
//
// Values are checked before anything is written so that every dialect stores exactly what was hashed: actor_id and
// branch_id are CHAR(26) (a canonical ULID or NULL; PostgreSQL would blank-pad anything shorter), lengths fit the
// columns (MySQL STRICT refuses longer values), and meta is stored as its canonical JSON text, which parses back to
// the same canonical value.

/** prev_hash of the first entry (and audit_head.last_hash of an empty log): 64 zeros. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

/** The one row of audit_head (seeded by migration 0004). */
const HEAD_ID = 1;
/** newId(at) needs a 48-bit timestamp. */
const MAX_AT = 2 ** 48 - 1;
/**
 * How far ahead of this process's clock `at` may be (ruling R51): newId(at) moves the process-wide ULID clock, so a
 * future `at` would date every later id of the process in that future.
 */
const MAX_AT_AHEAD_MS = 5 * 60_000;
/** audit_log.meta is TEXT: at most 65535 bytes on MySQL/MariaDB. */
const MAX_META_BYTES = 65_535;
/** Rows read per statement by verifyAuditChain: at most about 6.5 MB of meta (100 x 65535 bytes) at a time. */
const DEFAULT_BATCH_SIZE = 100;

/** One audit entry. Every field is required; the optional ones are `null`, never undefined (they are hashed). */
export interface AuditEntry {
  /** Epoch ms of the action; also the time part of the entry's ULID. */
  at: number;
  /** Who acted: `staff`, `system`, `device`, ... (at most 32 characters). */
  actorType: string;
  /** The actor's ULID, or null (system, CLI). */
  actorId: string | null;
  /** What happened, e.g. `settings.update` (at most 64 characters). */
  action: string;
  /** The kind of entity acted on (at most 64 characters), or null. */
  entity: string | null;
  /** The entity's identifier, ULID or not (at most 191 characters, no trailing blank), or null. */
  entityId: string | null;
  /** The branch's ULID, or null. */
  branchId: string | null;
  /** The client IP (at most 45 characters), or null. */
  ip: string | null;
  /** JSON data: a plain object, at most 65535 bytes as canonical JSON, nested at most 64 levels. */
  meta: Record<string, unknown>;
}

/** What {@link auditAppend} wrote. */
export interface AuditAppendResult {
  id: string;
  seq: number;
  hash: string;
}

/** The outcome of {@link verifyAuditChain}. */
export type AuditChainResult = { ok: true; head: number } | { ok: false; brokenAt: number };

/**
 * The outcome of a {@link verifyAuditChain} walk that stopped at its `deadline` (1d, T18-AUDIT-ANCHOR-BUDGET): every row
 * up to `head` verified, the last of them hashed `headHash`; the walk goes on from `{seq: head, hash: headHash}`.
 */
export interface AuditChainPartial {
  ok: true;
  head: number;
  headHash: string;
  brokenAt: null;
  complete: false;
}

/** A row of the chain known to be good: its seq and its hash (the `anchor` and `from` options). */
interface AuditChainPoint {
  seq: number;
  hash: string;
}

export interface VerifyAuditChainOptions {
  /** Rows read per statement (default 100): memory stays bounded however long the log is. */
  batchSize?: number;
  /**
   * The last row a retention purge deleted (L39, the instance setting `audit.anchor`): rows with `seq ≤ anchor.seq`
   * may be gone, and are not read; the chain starts at `anchor.seq + 1` with `prev_hash = anchor.hash`.
   */
  anchor?: { seq: number; hash: string };
  /**
   * The last row an earlier walk verified (the daily job's incremental check): only the rows after it are read,
   * the first of them chained to `from.hash`.
   */
  from?: { seq: number; hash: string };
  /**
   * Awaited after every batch read but the last, before the next is read: a long walk (the daily anchor job's first
   * run, or one after a break) renews its job's lease there (`ctx.heartbeat`). Its rejection ends the walk with it.
   */
  onBatch?: () => Promise<void>;
  /**
   * A `performance.now()` reading (1d, T18-AUDIT-ANCHOR-BUDGET): read after every full batch, and once it has passed
   * the walk stops there with an {@link AuditChainPartial}, to go on `from` its head in a later call (a job's next
   * slice, P9). A break, and the end of the log, are reported as without it.
   */
  deadline?: number;
}

/** The hashed fields of an entry, as the canonical object of the hash. */
interface HashedEntry {
  id: string;
  seq: number;
  at: number;
  actorType: string;
  actorId: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  branchId: string | null;
  ip: string | null;
  meta: unknown;
}

/** sha256hex(prevHash + canonicalize({id, seq, at, actorType, actorId, action, entity, entityId, branchId, ip, meta})). */
function entryHash(prevHash: string, e: HashedEntry): string {
  const canonical = canonicalize({
    id: e.id,
    seq: e.seq,
    at: e.at,
    actorType: e.actorType,
    actorId: e.actorId,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId,
    branchId: e.branchId,
    ip: e.ip,
    meta: e.meta,
  });
  return createHash('sha256').update(prevHash + canonical, 'utf8').digest('hex');
}

/**
 * `text` parsed (strictly: no duplicate members, at most 64 levels), when it is exactly the canonical JSON of what
 * it holds; undefined otherwise. Every stored byte of meta is thus covered: the hash covers the canonical value,
 * and the text must be that canonical form.
 */
function canonicalMeta(text: string): unknown {
  try {
    const value = parseStrictJson(text);
    return canonicalize(value) === text ? value : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Checking an entry

/** The entry's field `field`: present (null allowed only when `nullable`), never undefined. */
function field(e: Record<string, unknown>, name: keyof AuditEntry): unknown {
  const value = e[name];
  if (value === undefined) {
    throw new TypeError(`audit entry ${name} must be given (null when there is none), not undefined`);
  }
  return value;
}

function ulidOrNull(e: Record<string, unknown>, name: 'actorId' | 'branchId'): string | null {
  const value = field(e, name);
  if (value === null) return null;
  if (typeof value !== 'string' || !isUlid(value)) {
    throw new TypeError(
      `audit entry ${name} must be a canonical ULID (26 upper-case characters) or null, got ${describe(value)} ` +
        '(the column is CHAR(26))',
    );
  }
  return value;
}

function textOrNull(e: Record<string, unknown>, name: 'entity' | 'entityId' | 'ip', max: number): string | null {
  const value = field(e, name);
  if (value === null) return null;
  return checkText(`audit entry ${name}`, value, { max, noTrailingBlank: name === 'entityId' });
}

/** The canonical JSON text of `meta`, and the value it parses back to; a TypeError when it cannot be stored as such. */
function checkMeta(meta: unknown): { text: string; value: unknown } {
  const proto: unknown = typeof meta === 'object' && meta !== null ? Object.getPrototypeOf(meta) : undefined;
  if (Array.isArray(meta) || (proto !== Object.prototype && proto !== null)) {
    throw new TypeError(`audit entry meta must be a plain object, got ${describe(meta)}`);
  }
  let text: string;
  try {
    text = canonicalize(meta);
  } catch (error) {
    // JCS_INVALID:<reason> at <JSON Pointer> (NaN, Infinity, BigInt, functions, Dates, lone surrogates, cycles), or
    // a RangeError for a structure nested too deep to walk. The message names member names, never values.
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(`audit entry meta must be JSON data: ${reason}`, { cause: error });
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_META_BYTES) {
    throw new TypeError(`audit entry meta is ${bytes} bytes as JSON; at most ${MAX_META_BYTES} fit (MySQL TEXT)`);
  }
  const value = canonicalMeta(text);
  if (value === undefined) {
    throw new TypeError('audit entry meta must read back as the same JSON (nested at most 64 levels)');
  }
  return { text, value };
}

interface CheckedEntry extends Omit<HashedEntry, 'id' | 'seq'> {
  metaText: string;
}

/** The entry when every field can be stored and hashed the same on every dialect; a TypeError otherwise. */
function checkEntry(entry: unknown): CheckedEntry {
  if (typeof entry !== 'object' || entry === null) throw new TypeError(`audit entry must be an object, got ${describe(entry)}`);
  const e = entry as Record<string, unknown>;
  const at = field(e, 'at');
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at > MAX_AT) {
    throw new TypeError(`audit entry at must be an integer epoch ms from 0 to 2^48-1, got ${describe(at)}`);
  }
  if (at > Date.now() + MAX_AT_AHEAD_MS) {
    throw new TypeError('audit entry at must not be more than 5 minutes ahead of the clock');
  }
  const actorType = checkText('audit entry actorType', field(e, 'actorType'), { max: 32 });
  const actorId = ulidOrNull(e, 'actorId');
  const action = checkText('audit entry action', field(e, 'action'), { max: 64 });
  const entity = textOrNull(e, 'entity', 64);
  const entityId = textOrNull(e, 'entityId', 191);
  const branchId = ulidOrNull(e, 'branchId');
  const ip = textOrNull(e, 'ip', 45);
  const meta = checkMeta(field(e, 'meta'));
  return { at, actorType, actorId, action, entity, entityId, branchId, ip, meta: meta.value, metaText: meta.text };
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Appends `e` to the audit log inside the caller's transaction `trx` (spec §6.3), in exactly these steps:
 *
 * 1. `UPDATE audit_head SET last_seq = last_seq + 1 WHERE id = 1`: takes the head row's lock (SQLite: the write
 *    lock of BEGIN IMMEDIATE), so concurrent appends queue here until this transaction ends;
 * 2. `SELECT last_seq, last_hash` of audit_head;
 * 3. INSERT the entry with `seq = last_seq`, `prev_hash = last_hash`, `id = newId(at)`, `meta` as canonical JSON
 *    and `hash` = sha256hex(prev_hash + canonicalize({id, seq, at, actorType, actorId, action, entity, entityId,
 *    branchId, ip, meta}));
 * 4. `UPDATE audit_head SET last_hash = :hash WHERE id = 1`.
 *
 * The steps run inside `SAVEPOINT altis_audit`; on any error the transaction is rolled back to it before the error
 * is rethrown (ruling R51), so a caller that catches the error and commits leaves audit_head and the log as they
 * were. When the transaction rolls back, so does the entry, and its seq is never used: seq stays gap-free. Call it
 * last in the action's transaction, or at least after the action's other row locks, to keep the head locked
 * briefly.
 *
 * **Await it before the next statement on `trx`** (see withTx: one statement at a time). Appends and the other
 * primitives started together on one transaction are queued and run one after another, but a plain statement run
 * at the same time is not ordered with them: it can run inside SAVEPOINT altis_audit and be undone without trace
 * when an append rolls back to it, although its own promise resolved. Start appends together only with
 * Promise.allSettled (after a Promise.all rejection the callback fails while queued appends still run).
 *
 * @throws TypeError, before anything is written, when `trx` is not a transaction or `e` does not fit (rulings
 *   R40/R40b): `actorId`/`branchId` not a canonical ULID or null; `entityId` over 191 characters or ending in a
 *   blank; `action`/`entity` over 64, `actorType` over 32, `ip` over 45 characters; an empty string for any text
 *   field (`action`, `actorType`, and also `entity`, `entityId` and `ip`, which take null for "none", ruling R50);
 *   NUL or lone surrogates in a text; `at` not an integer from 0 to 2^48-1 or more than 5 minutes ahead of the
 *   clock (R51); an optional field undefined instead of null; `meta` not a plain object of JSON data (NaN, Infinity, BigInt, functions, Dates,
 *   cycles), nested deeper than 64 levels or over 65535 bytes as JSON.
 * @throws DomainError `STATE_CORRUPT` (`meta.reason: 'audit_head_missing'`) when audit_head has no row 1.
 */
export async function auditAppend(trx: Transaction<DB>, e: AuditEntry): Promise<AuditAppendResult> {
  if (typeof trx !== 'object' || trx === null || (trx as { isTransaction?: unknown }).isTransaction !== true) {
    throw new TypeError("auditAppend() runs inside the action's transaction: pass the trx of withTx(), not a database handle");
  }
  const entry = checkEntry(e);
  return exclusive(trx, async () => {
    await sql`savepoint altis_audit`.execute(trx);
    let result: AuditAppendResult;
    try {
      result = await appendSteps(trx, entry);
    } catch (error) {
      // Undo the steps that ran, so that a caller who catches this and commits leaves no half append (R51). It fails
      // as well when the transaction is already gone (a deadlock rolled it back, the connection was lost): the
      // original error is what matters.
      await sql`rollback to savepoint altis_audit`.execute(trx).catch(() => {});
      await sql`release savepoint altis_audit`.execute(trx).catch(() => {});
      throw error;
    }
    await sql`release savepoint altis_audit`.execute(trx);
    return result;
  });
}

/** The four steps of §6.3 (see {@link auditAppend}). */
async function appendSteps(trx: Transaction<DB>, entry: CheckedEntry): Promise<AuditAppendResult> {
  // 1. The next seq, under the lock of the head row.
  const bumped = await trx
    .updateTable('audit_head')
    .set((eb) => ({ last_seq: eb('last_seq', '+', 1) }))
    .where('id', '=', HEAD_ID)
    .executeTakeFirst();
  if (Number(bumped.numUpdatedRows) !== 1) {
    throw new DomainError('STATE_CORRUPT', {
      detail:
        'Baris kepala log audit (audit_head id 1) tidak ada; jalankan migrasi / ' +
        'The audit log head row (audit_head id 1) is missing; run the migrations',
      meta: { reason: 'audit_head_missing' },
    });
  }
  // 2.
  const head = await trx
    .selectFrom('audit_head')
    .select(['last_seq', 'last_hash'])
    .where('id', '=', HEAD_ID)
    .executeTakeFirstOrThrow();
  // 3.
  const id = newId(entry.at);
  const seq = head.last_seq;
  const hash = entryHash(head.last_hash, { ...entry, id, seq });
  await trx
    .insertInto('audit_log')
    .values({
      id,
      seq,
      at: entry.at,
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId,
      branch_id: entry.branchId,
      ip: entry.ip,
      meta: entry.metaText,
      prev_hash: head.last_hash,
      hash,
    })
    .execute();
  // 4.
  await trx.updateTable('audit_head').set({ last_hash: hash }).where('id', '=', HEAD_ID).execute();
  return { id, seq, hash };
}

/**
 * Verifies the whole audit chain (spec §7.8): reads audit_head, then walks audit_log by ascending seq up to the
 * head's last_seq in batches (memory stays bounded), checking for every row that its seq follows the previous one
 * (from 1), that its prev_hash is the previous row's hash (the genesis 64 zeros for seq 1), that its meta is stored
 * as exactly its canonical JSON, and that its hash recomputes. The last row must then be audit_head's last_seq and
 * last_hash, and no row may lie beyond the head.
 *
 * Runs its own statements on `h`, outside any transaction: call it outside any withTx callback (ruling R49; inside
 * one it would need a second connection, on SQLite waiting forever). It stays correct while entries are appended: a committed head implies its rows are
 * committed (they commit together), so the walk stops at the head read first, and rows beyond the head are judged
 * against the head read after them.
 *
 * A tampered value the driver cannot decode (an unsafe BIGINT throws in PostgreSQL's int8 parser and in
 * node:sqlite) or that has the wrong type (MySQL hands an unsafe BIGINT back as a string; SQLite stores a BLOB in a
 * text column) breaks the chain at its row: the batch is then read row by row to find it. Only a RangeError counts
 * as such a value; every other error is a database failure and is rethrown (a closed or exhausted pool, a lost
 * connection, a destroyed handle), never reported as a break.
 *
 * A starting point skips the rows up to it (spec §7.8, L39): with `anchor` (the last row a retention purge deleted)
 * or `from` (the last row an earlier walk verified) the walk reads only the rows after that seq, the first of them
 * chained to its hash; with both, the later one is the start (a `from` the purge has passed since is gone). Rows at
 * or before the start are not read, whether they are still there or not. A start beyond audit_head's last_seq means
 * the head was moved back.
 *
 * With `deadline` (1d) the walk may stop early: see {@link VerifyAuditChainOptions.deadline}.
 *
 * @returns `{ok: true, head}` (head = last_seq; 0 for an empty log), or `{ok: false, brokenAt}`: the first seq at
 *   which the chain does not verify — the changed or undecodable row, the missing seq, the head's last_seq when the
 *   head disagrees with the last row, the first seq beyond a head moved back, or 1 when audit_head is missing or
 *   unreadable or (without a starting point) a row precedes seq 1. With a `deadline` that passed before the end: an
 *   {@link AuditChainPartial}.
 * @throws TypeError when called inside a withTx callback; for a `batchSize` that is not a positive safe integer; for
 *   an `anchor` or `from` that is not `{seq, hash}` with a safe integer seq ≥ 0 and 64 lowercase hex digits; for a
 *   `deadline` that is not a finite number
 */
export function verifyAuditChain(h: DbHandle, o: VerifyAuditChainOptions & { deadline: number }): Promise<AuditChainResult | AuditChainPartial>;
export function verifyAuditChain(h: DbHandle, o?: VerifyAuditChainOptions & { deadline?: undefined }): Promise<AuditChainResult>;
export function verifyAuditChain(h: DbHandle, o?: VerifyAuditChainOptions): Promise<AuditChainResult | AuditChainPartial>;
export async function verifyAuditChain(h: DbHandle, o: VerifyAuditChainOptions = {}): Promise<AuditChainResult | AuditChainPartial> {
  assertOutsideTx('verifyAuditChain');
  const batchSize = o.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError(`batchSize must be a positive integer, got ${describe(batchSize)}`);
  }
  if (o.onBatch !== undefined && typeof o.onBatch !== 'function') {
    throw new TypeError(`onBatch must be a function, got ${describe(o.onBatch)}`);
  }
  const deadline = o.deadline;
  if (deadline !== undefined && (typeof deadline !== 'number' || !Number.isFinite(deadline))) {
    throw new TypeError(`deadline must be a finite number (a performance.now() reading), got ${describe(deadline)}`);
  }
  const start = startOf(chainPoint('anchor', o.anchor), chainPoint('from', o.from));
  const broken = (brokenAt: number): AuditChainResult => ({ ok: false, brokenAt });

  const head = await readHead(h);
  if (head === undefined) return broken(1);
  if (start !== null && head.last_seq < start.seq) return broken(head.last_seq + 1); // a head moved back

  let expected = start === null ? 1 : start.seq + 1;
  let prevHash = start === null ? AUDIT_GENESIS_HASH : start.hash;
  /** After a full batch: the walk so far when the deadline has passed (it stops there), else null (it goes on). */
  const stopped = (): AuditChainPartial | null =>
    deadline !== undefined && performance.now() >= deadline
      ? { ok: true, head: expected - 1, headHash: prevHash, brokenAt: null, complete: false }
      : null;
  /** The first broken seq if `row` (meant to be `expected`) does not verify; null when it does (and moves on). */
  const check = (row: Record<string, unknown>): number | null => {
    // A value of the wrong type (in the row meant for `expected`, or in its seq), a gap (the missing seq), or a row
    // before seq 1 (the start is not verifiable): broken at the seq expected.
    if (!wellFormed(row) || row.seq !== expected) return expected;
    if (row.prev_hash !== prevHash) return row.seq;
    const meta = canonicalMeta(row.meta);
    if (meta === undefined) return row.seq;
    const hash = entryHash(prevHash, {
      id: row.id,
      seq: row.seq,
      at: row.at,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      branchId: row.branch_id,
      ip: row.ip,
      meta,
    });
    if (hash !== row.hash) return row.seq;
    prevHash = row.hash;
    expected += 1;
    return null;
  };

  let after: number | null = start === null ? null : start.seq;
  for (;;) {
    let q = h.db.selectFrom('audit_log').selectAll().where('seq', '<=', head.last_seq).orderBy('seq').limit(batchSize);
    if (after !== null) q = q.where('seq', '>', after);
    let batch: Record<string, unknown>[];
    try {
      batch = await q.execute();
    } catch (error) {
      if (!undecodable(error)) throw error;
      // A row the driver cannot decode (an unsafe BIGINT: PostgreSQL's int8 parser and node:sqlite throw): read the
      // seqs of this batch one row at a time to find it.
      for (let i = 0; i < batchSize && expected <= head.last_seq; i += 1) {
        let row: Record<string, unknown> | undefined;
        try {
          row = await h.db.selectFrom('audit_log').selectAll().where('seq', '=', expected).executeTakeFirst();
        } catch (inner) {
          if (!undecodable(inner)) throw inner;
          return broken(expected);
        }
        if (row === undefined) return broken(expected);
        const at = check(row);
        if (at !== null) return broken(at);
      }
      const partial = stopped();
      if (partial !== null) return partial;
      after = expected - 1;
      await o.onBatch?.();
      continue;
    }
    for (const row of batch) {
      const at = check(row);
      if (at !== null) return broken(at);
    }
    if (batch.length < batchSize) break;
    const partial = stopped();
    if (partial !== null) return partial;
    after = expected - 1;
    await o.onBatch?.();
  }

  const last = expected - 1;
  if (last < head.last_seq) return broken(last + 1); // rows missing at the end
  if (prevHash !== head.last_hash) return broken(Math.max(head.last_seq, 1));
  // Rows beyond the head: every row up to the highest seq read here was committed before the head is read again,
  // together with a head at least that far, so a higher seq than that head means the head was moved back.
  let top: unknown;
  try {
    const highest = await h.db
      .selectFrom('audit_log')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .executeTakeFirst();
    top = highest?.seq ?? null;
  } catch (error) {
    if (!undecodable(error)) throw error;
    top = Number.POSITIVE_INFINITY; // a seq no number can hold: beyond any head
  }
  const now = await readHead(h);
  if (now === undefined) return broken(1);
  if (top !== null && !(typeof top === 'number' && top <= now.last_seq)) return broken(now.last_seq + 1);
  return { ok: true, head: head.last_seq };
}

/** A hash of the chain: 64 lowercase hex digits (sha256hex). */
const CHAIN_HASH = /^[0-9a-f]{64}$/;

/** `value` checked as the {@link AuditChainPoint} option `name`; null when absent. */
function chainPoint(name: 'anchor' | 'from', value: unknown): AuditChainPoint | null {
  if (value === undefined) return null;
  const seq = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['seq'] : undefined;
  const hash = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['hash'] : undefined;
  if (!safeInteger(seq) || seq < 0 || typeof hash !== 'string' || !CHAIN_HASH.test(hash)) {
    throw new TypeError(
      `${name} must be {seq, hash} with seq a safe integer >= 0 and hash 64 lowercase hex digits, got ${describe(value)}`,
    );
  }
  return { seq, hash };
}

/** Where the walk starts: the later of the anchor and the verified point (from wins a tie); null for seq 1. */
function startOf(anchor: AuditChainPoint | null, from: AuditChainPoint | null): AuditChainPoint | null {
  if (anchor === null) return from;
  if (from === null) return anchor;
  return from.seq >= anchor.seq ? from : anchor;
}

/**
 * audit_head as numbers and text; undefined when the row is missing or does not decode as such (a tampered head
 * cannot anchor the chain: verifyAuditChain then reports brokenAt 1).
 */
async function readHead(h: DbHandle): Promise<{ last_seq: number; last_hash: string } | undefined> {
  let row: Record<string, unknown> | undefined;
  try {
    row = await h.db.selectFrom('audit_head').select(['last_seq', 'last_hash']).where('id', '=', HEAD_ID).executeTakeFirst();
  } catch (error) {
    if (!undecodable(error)) throw error;
    return undefined;
  }
  if (row === undefined || !safeInteger(row['last_seq']) || typeof row['last_hash'] !== 'string') return undefined;
  return { last_seq: row['last_seq'], last_hash: row['last_hash'] };
}

/**
 * True for an error reading rows that is about a value, not the database: what a driver throws for a value it
 * cannot decode, a RangeError (PostgreSQL's int8 parser in connect.ts; node:sqlite's ERR_OUT_OF_RANGE, which is a
 * RangeError too, is also accepted by its code). Anything else is a database failure and verifyAuditChain rethrows
 * it: normalized DomainErrors, driver errors, and the plain Errors without a driver code that pools and Kysely
 * raise (mysql2 'Pool is closed.', pg-pool 'Cannot use a pool after calling end', Kysely 'driver has already been
 * destroyed'), which reported as a break would be a false tamper alarm.
 */
function undecodable(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_OUT_OF_RANGE';
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

type AuditRow = {
  id: string;
  seq: number;
  at: number;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  branch_id: string | null;
  ip: string | null;
  meta: string;
  prev_hash: string;
  hash: string;
};

/**
 * True when `row` holds what audit_log columns can hold: safe integers for seq and at, strings (or null where the
 * column allows it) for the rest. A tampered value of another type (MySQL hands an unsafe BIGINT back as a string,
 * SQLite stores a BLOB in a text column) breaks the chain at that row instead of throwing.
 */
function wellFormed(row: Record<string, unknown>): row is AuditRow {
  const text = (v: unknown) => typeof v === 'string';
  const textOrNull = (v: unknown) => v === null || typeof v === 'string';
  return (
    safeInteger(row['seq']) &&
    safeInteger(row['at']) &&
    text(row['id']) &&
    text(row['actor_type']) &&
    textOrNull(row['actor_id']) &&
    text(row['action']) &&
    textOrNull(row['entity']) &&
    textOrNull(row['entity_id']) &&
    textOrNull(row['branch_id']) &&
    textOrNull(row['ip']) &&
    text(row['meta']) &&
    text(row['prev_hash']) &&
    text(row['hash'])
  );
}
