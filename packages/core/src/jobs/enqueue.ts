import { encodeBase64Url } from '@altis/crypto';
import { normalizeDbError, type DB } from '@altis/db';
import { DomainError, isDomainError, isUlid, newId } from '@altis/shared';
import { issueCode } from '@altis/shared/api/common';
import { sql, type Transaction } from 'kysely';
import { sealValue, secretAad, type KeyringEntry } from '../crypto/secret-box.js';
import { DEFAULT_MAX_ATTEMPTS, JOB_PAYLOAD_MAX, JOB_SECRET_MAX, type EnqueueInput, type JobRegistry } from './types.js';

// enqueue (spec §10.1): a queued job, its payload checked by the handler's schema, its secret sealed with the keyring.
//
// A unique key belongs to a live job only: every terminal status sets `unique_key = NULL`, so `uq_jobs_unique_key`
// allows one live job per key, and enqueue with the key of a live job returns that job (`existing: true`):
// 1. the job holding the key is read; found → returned;
// 2. otherwise the INSERT runs inside SAVEPOINT altis_job. A UNIQUE_VIOLATION means another transaction inserted the
//    key after our read and committed: the savepoint is rolled back (which keeps the caller's transaction usable on
//    PostgreSQL) and the holder is read again. PostgreSQL (READ COMMITTED) sees it. MySQL/MariaDB (REPEATABLE READ)
//    may not: a plain read keeps showing the snapshot taken by the transaction's first read, from before that commit.
//    Then enqueue throws TX_CONFLICT, and the caller's withTx runs the whole transaction again (R37), whose first
//    read sees the holder (or, when it has finished meanwhile, a free key). SQLite never gets here: a transaction is
//    the only writer from its BEGIN IMMEDIATE on, so the read of step 1 already sees every committed key.

/** `unique_key` is a key191() column: binary, at most 191 characters, no trailing blank (R24). */
const UNIQUE_KEY_MAX = 191;
/** C0 controls, DEL and C1 controls (NUL included). */
const CONTROL = /\p{Cc}/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isTransaction(trx: unknown): boolean {
  return typeof trx === 'object' && trx !== null && (trx as { isTransaction?: unknown }).isTransaction === true;
}

function checkUniqueKey(key: unknown): string | null {
  if (key === undefined) return null;
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    [...key].length > UNIQUE_KEY_MAX ||
    key.endsWith(' ') ||
    CONTROL.test(key) ||
    LONE_SURROGATE.test(key)
  ) {
    throw new TypeError(`enqueue: uniqueKey must be 1-${UNIQUE_KEY_MAX} characters without controls or a trailing blank`);
  }
  return key;
}

function checkEpoch(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`enqueue: ${name} must be a safe non-negative integer (epoch ms)`);
  }
  return value;
}

/** The id of the live job holding `key`, or null. */
async function holderOf(trx: Transaction<DB>, key: string): Promise<string | null> {
  const row = await trx.selectFrom('jobs').select('id').where('unique_key', '=', key).executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Enqueues a job in `trx` at `o.now`: `queued`, `run_at = input.runAt ?? now`, `attempts = 0`, `max_attempts =
 * input.maxAttempts ?? handler.maxAttempts ?? 5`, the payload as its JSON text after the handler's schema parsed it,
 * `secret` sealed into `secret_param` (AAD `jobs.secret_param.<id>`, the keyring's active key). With `uniqueKey`, a
 * live job holding it is returned instead (`existing: true`; nothing is written), also when another transaction
 * inserted it concurrently (see the top of this file).
 *
 * Await it before the next statement on `trx`. Run it inside a withTx callback that may be run again (R37): a key
 * committed by another transaction after this one's snapshot is a TX_CONFLICT, which withTx retries.
 *
 * @throws DomainError `VALIDATION_FAILED` (`meta.errors`: `{path: 'payload.<field>', code}`, never the value) when
 *   the handler's schema refuses the payload; nothing is written
 * @throws DomainError `TX_CONFLICT` when the key's holder committed after this transaction's first read and cannot be
 *   seen from it (MySQL/MariaDB, see above): withTx runs the transaction again
 * @throws TypeError when `trx` is not a transaction, the type has no handler, the payload is over
 *   {@link JOB_PAYLOAD_MAX} bytes of JSON, or `uniqueKey`, `runAt`, `maxAttempts`, `createdBy`, `secret` (at most
 *   {@link JOB_SECRET_MAX} bytes) or `o.now` is malformed
 */
export async function enqueue(
  trx: Transaction<DB>,
  reg: JobRegistry,
  input: EnqueueInput,
  o: { now: number; keyring: readonly KeyringEntry[] },
): Promise<{ id: string; existing: boolean }> {
  if (!isTransaction(trx)) throw new TypeError('enqueue() runs inside the caller’s transaction: pass the trx of withTx()');
  const now = checkEpoch('now', o.now);
  const handler = typeof input.type === 'string' ? reg.get(input.type) : undefined;
  if (handler === undefined) throw new TypeError(`enqueue: no handler for job type ${JSON.stringify(input.type)}`);
  const uniqueKey = checkUniqueKey(input.uniqueKey);
  const runAt = input.runAt === undefined ? now : checkEpoch('runAt', input.runAt);
  const maxAttempts = input.maxAttempts ?? handler.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('enqueue: maxAttempts must be a positive integer');
  const createdBy = input.createdBy ?? null;
  if (createdBy !== null && (typeof createdBy !== 'string' || !isUlid(createdBy))) {
    throw new TypeError('enqueue: createdBy must be a ULID or null');
  }
  if (input.secret !== undefined && (!(input.secret instanceof Uint8Array) || input.secret.byteLength > JOB_SECRET_MAX)) {
    throw new TypeError(`enqueue: secret must be a Uint8Array of at most ${JOB_SECRET_MAX} bytes`);
  }

  const parsed = handler.payload.safeParse(input.payload);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', {
      detail: 'Data tugas tidak valid / The job payload is not valid',
      meta: {
        errors: parsed.error.issues.map((issue) => ({
          path: ['payload', ...issue.path.map(String)].join('.'),
          code: issueCode(issue),
        })),
      },
    });
  }
  const payload = JSON.stringify(parsed.data);
  if (typeof payload !== 'string') throw new TypeError('enqueue: the payload must be JSON data');
  if (Buffer.byteLength(payload, 'utf8') > JOB_PAYLOAD_MAX) {
    throw new TypeError(`enqueue: the payload is more than ${JOB_PAYLOAD_MAX} bytes of JSON`);
  }

  if (uniqueKey !== null) {
    const holder = await holderOf(trx, uniqueKey);
    if (holder !== null) return { id: holder, existing: true };
  }

  const id = newId();
  const row = {
    id,
    type: handler.type,
    payload,
    secret_param:
      input.secret === undefined ? null : sealValue(o.keyring, secretAad('jobs', 'secret_param', id), encodeBase64Url(input.secret)),
    status: 'queued',
    run_at: runAt,
    max_attempts: maxAttempts,
    unique_key: uniqueKey,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  };
  if (uniqueKey === null) {
    await trx.insertInto('jobs').values(row).execute();
    return { id, existing: false };
  }
  await sql`savepoint altis_job`.execute(trx);
  try {
    await trx.insertInto('jobs').values(row).execute();
  } catch (error) {
    const normalized = normalizeDbError(error);
    if (!isDomainError(normalized) || normalized.code !== 'UNIQUE_VIOLATION') throw error;
    await sql`rollback to savepoint altis_job`.execute(trx);
    await sql`release savepoint altis_job`.execute(trx);
    const holder = await holderOf(trx, uniqueKey);
    if (holder !== null) return { id: holder, existing: true };
    throw new DomainError('TX_CONFLICT', {
      detail:
        'Tugas dengan kunci yang sama baru saja dibuat; transaksi diulang / A job with the same key was just created; ' +
        'the transaction is run again',
      meta: { attempts: 1, code: 'JOB_UNIQUE_KEY' },
    });
  }
  await sql`release savepoint altis_job`.execute(trx);
  return { id, existing: false };
}
