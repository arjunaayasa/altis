import { createHmac } from 'node:crypto';
import type { TxCtx } from '@altis/core';
import { canonicalize } from '@altis/crypto';
import { withTx, type DbHandle } from '@altis/db';
import { DomainError, isDomainError } from '@altis/shared';
import { idempotencyKeyField } from '@altis/shared/api/common';
import type { Context } from 'hono';
import type { Config } from '../config.js';
import type { AuthState } from './auth-state.js';
import { csrfKey } from './csrf.js';
import type { AppEnv } from './request-id.js';
import type { RouteDecl, RouteResult } from './route.js';

// Step 12 of the middleware chain (spec §4.7, §7.9), which http/route.ts runs per route after validation.
//
// It applies when the declaration says `idempotency: 'store'`, the request carries `Idempotency-Key` and step 7 found
// a session (the subject); otherwise the header is ignored. The key must match idempotencyKeyField (8-64 of
// `A-Z a-z 0-9 . _ : -`), else 400 IDEMPOTENCY_KEY_INVALID. A row of `idempotency_keys` is unique per (subject, key)
// and holds requestHash(method, request path, validated body), keyed with the install's sessionKey (ruling R1b-3):
// a body may hold a password (users.create), and an unkeyed SHA-256 of it would let anyone who reads the database
// test guesses of that password at hash speed, bypassing scrypt (§7.1).
//
// Begin (beginIdempotency), before `prepare` and the handler:
//   1. INSERT a `processing` row locked until now + IDEMPOTENCY_LOCK_MS, in a transaction of its own (committed
//      before the handler starts, so that a parallel request with the key sees it);
//   2. on UNIQUE_VIOLATION that transaction is over (PostgreSQL aborts it anyway, M36): the existing row is read in a
//      new transaction, and
//      - a different request hash → 422 IDEMPOTENCY_KEY_REUSED;
//      - `done` → its response is replayed (stored status and body, `Idempotent-Replayed: true`), without running
//        the handler;
//      - `processing` with `locked_until > now` → 409 IDEMPOTENCY_IN_PROGRESS;
//      - otherwise (the lock expired: the process handling it died or failed with a 5xx) it is taken over with
//        `UPDATE … SET locked_until = now + IDEMPOTENCY_LOCK_MS WHERE … AND status = 'processing' AND locked_until <
//        now`; no row updated (another request took it over first) → 409;
//      a row deleted in between (a 4xx retry, the sweep) sends the request back to 1, at most three times.
//   The new `locked_until` is the claim's mark: finish and release touch the row only while it still carries it.
//
// Finish (finishIdempotency), in the handler's transaction after the handler (and the audit check): `status = 'done'`
// with the response's status and JSON body. It commits with the handler's changes or not at all (§7.9 "di transaksi
// yang sama"). A store route answers with a RouteResult without `headers` (a replay could not send them) whose JSON
// body is at most IDEMPOTENCY_MAX_RESPONSE_BYTES (a TEXT column on MySQL/MariaDB); anything else is a TypeError. The
// request hash does not cover the query string, so defineRoutes refuses a `store` route with a `query` schema.
// A row that lost the claim's mark (the lock expired and another request took it over) → 409 IDEMPOTENCY_IN_PROGRESS,
// which rolls the handler back.
//
// A 4xx DomainError from `prepare` or the handler deletes the row in a transaction of its own (releaseIdempotency),
// so that the client may retry with the key; a 5xx leaves it `processing` until the lock expires. The daily sweep
// deletes rows older than 24 h (spec §7.9 retention; core maintenance/sweep.ts).

/** How long a `processing` row is held before another request with the same key may take it over. */
export const IDEMPOTENCY_LOCK_MS = 30_000;

/** The largest JSON body a `store` route's response may have, in UTF-8 bytes (it is stored to be replayed). */
export const IDEMPOTENCY_MAX_RESPONSE_BYTES = 60_000;

/** Subjects are staff only in 1b. */
const STAFF = 'staff';

/** Begin's rounds of INSERT then read, when the row read is gone again each time. */
const BEGIN_ROUNDS = 3;

/**
 * The request hash of §7.9 as ruling R1b-3 keys it: lower-case hex of `HMAC-SHA256(key, 'idem:' + method + '\n' + path
 * + '\n' + canonicalize(body ?? null))`, 64 characters like the SHA-256 it replaces (`request_hash` CHAR(64)). `key` is
 * the install's sessionKey decoded to its 32 bytes (csrfKey); `path` is the request path.
 */
export function requestHash(key: Uint8Array, method: string, path: string, body: unknown): string {
  return createHmac('sha256', key).update(`idem:${method}\n${path}\n${canonicalize(body ?? null)}`, 'utf8').digest('hex');
}

/** The row a request holds while its handler runs. */
export interface IdempotencyClaim {
  subjectId: string;
  key: string;
  hash: string;
  /** The claim's mark: the row's `locked_until` as this request set it. */
  lockedUntil: number;
}

/** What begin decided: run the handler under the claim, or replay the stored response. */
export type IdempotencyBegin = { kind: 'run'; claim: IdempotencyClaim } | { kind: 'replay'; status: number; body: string | null };

/**
 * Step 12's begin (see the top of this file): null when idempotency does not apply to the request.
 *
 * @throws DomainError `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`; `DB_UNAVAILABLE`
 *   without a database or a config
 */
export async function beginIdempotency(
  c: Context<AppEnv>,
  decl: RouteDecl,
  auth: AuthState | null,
  o: { db: DbHandle | undefined; config: Config | undefined; now: number; body: unknown },
): Promise<IdempotencyBegin | null> {
  const key = c.req.header('idempotency-key');
  if (decl.idempotency !== 'store' || key === undefined || auth === null) return null;
  if (!idempotencyKeyField.safeParse(key).success) throw new DomainError('IDEMPOTENCY_KEY_INVALID');
  const db = o.db;
  if (db === undefined || o.config === undefined) throw new DomainError('DB_UNAVAILABLE');

  const claim: IdempotencyClaim = {
    subjectId: auth.subjectId,
    key,
    hash: requestHash(csrfKey(o.config), c.req.method, c.req.path, o.body),
    lockedUntil: o.now + IDEMPOTENCY_LOCK_MS,
  };
  for (let round = 0; round < BEGIN_ROUNDS; round += 1) {
    if (await book(db, claim, o.now)) return { kind: 'run', claim };
    const decided = await decide(db, claim, o.now);
    if (decided !== null) return decided;
  }
  throw new DomainError('IDEMPOTENCY_IN_PROGRESS');
}

/** Inserts the claim's `processing` row in a transaction of its own; false when the key already has one. */
async function book(db: DbHandle, claim: IdempotencyClaim, now: number): Promise<boolean> {
  try {
    await withTx(db, (trx) =>
      trx
        .insertInto('idempotency_keys')
        .values({
          subject_type: STAFF,
          subject_id: claim.subjectId,
          key: claim.key,
          request_hash: claim.hash,
          status: 'processing',
          locked_until: claim.lockedUntil,
          response_status: null,
          response_body: null,
          created_at: now,
        })
        .execute(),
    );
    return true;
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') return false;
    throw error;
  }
}

/** Reads the key's existing row in a new transaction and decides (see the top of this file); null when it is gone. */
async function decide(db: DbHandle, claim: IdempotencyClaim, now: number): Promise<IdempotencyBegin | null> {
  return withTx(db, async (trx) => {
    const row = await trx
      .selectFrom('idempotency_keys')
      .select(['request_hash', 'status', 'locked_until', 'response_status', 'response_body'])
      .where('subject_type', '=', STAFF)
      .where('subject_id', '=', claim.subjectId)
      .where('key', '=', claim.key)
      .executeTakeFirst();
    if (row === undefined) return null;
    if (row.request_hash !== claim.hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED');
    if (row.status === 'done') {
      return { kind: 'replay', status: Number(row.response_status), body: row.response_body };
    }
    if (Number(row.locked_until) > now) throw new DomainError('IDEMPOTENCY_IN_PROGRESS');
    const taken = await trx
      .updateTable('idempotency_keys')
      .set({ locked_until: claim.lockedUntil })
      .where('subject_type', '=', STAFF)
      .where('subject_id', '=', claim.subjectId)
      .where('key', '=', claim.key)
      .where('request_hash', '=', claim.hash)
      .where('status', '=', 'processing')
      .where('locked_until', '<', now)
      .executeTakeFirst();
    if (Number(taken.numUpdatedRows) === 0) throw new DomainError('IDEMPOTENCY_IN_PROGRESS');
    return { kind: 'run', claim };
  });
}

/**
 * Step 12's finish, in the handler's transaction `trx` (see the top of this file).
 *
 * @throws TypeError for a Response result, a result with `headers`, or a JSON body over IDEMPOTENCY_MAX_RESPONSE_BYTES
 * @throws DomainError `IDEMPOTENCY_IN_PROGRESS` when the row no longer carries the claim's mark
 */
export async function finishIdempotency(
  trx: TxCtx['trx'],
  decl: RouteDecl,
  claim: IdempotencyClaim,
  result: RouteResult,
): Promise<void> {
  if (result instanceof Response || result === null || typeof result !== 'object') {
    throw new TypeError(`route ${decl.id}: an idempotency 'store' route returns {status?, body?}, not a Response (its response is stored)`);
  }
  if (result.headers !== undefined) {
    throw new TypeError(`route ${decl.id}: an idempotency 'store' route returns no headers (a replay could not send them)`);
  }
  const text = result.body === undefined ? null : JSON.stringify(result.body);
  if (text !== null && Buffer.byteLength(text, 'utf8') > IDEMPOTENCY_MAX_RESPONSE_BYTES) {
    throw new TypeError(
      `route ${decl.id}: an idempotency 'store' route's response body is at most ${IDEMPOTENCY_MAX_RESPONSE_BYTES} bytes ` +
        `of JSON, got ${Buffer.byteLength(text, 'utf8')}`,
    );
  }
  const status = result.status ?? (text === null ? 204 : 200);
  // Only the row that still carries the claim's mark.
  const updated = await trx
    .updateTable('idempotency_keys')
    .set({ status: 'done', response_status: status, response_body: text })
    .where('subject_type', '=', STAFF)
    .where('subject_id', '=', claim.subjectId)
    .where('key', '=', claim.key)
    .where('status', '=', 'processing')
    .where('locked_until', '=', claim.lockedUntil)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) throw new DomainError('IDEMPOTENCY_IN_PROGRESS');
}

/** Deletes the claim's row (a 4xx from `prepare` or the handler) in a transaction of its own. */
export async function releaseIdempotency(db: DbHandle, claim: IdempotencyClaim): Promise<void> {
  await withTx(db, (trx) =>
    trx
      .deleteFrom('idempotency_keys')
      .where('subject_type', '=', STAFF)
      .where('subject_id', '=', claim.subjectId)
      .where('key', '=', claim.key)
      .where('status', '=', 'processing')
      .where('locked_until', '=', claim.lockedUntil)
      .execute(),
  );
}

/** The replay of a stored response: its status, its JSON body (none when it had none), `Idempotent-Replayed: true`. */
export function replayResponse(replay: { status: number; body: string | null }): Response {
  const headers: Record<string, string> = { 'Idempotent-Replayed': 'true' };
  if (replay.body !== null) headers['Content-Type'] = 'application/json';
  return new Response(replay.body, { status: replay.status, headers });
}
