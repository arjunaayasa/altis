import { increment, type DB } from '@altis/db';
import type { Transaction } from 'kysely';
import { sha256hex } from '../crypto/tokens.js';

// The rate limiter of the access layer (spec §7.1, P6, D11), kept in the database so that every process of an
// installation (Passenger ≤ 6 workers, the CLI) counts together. One row per bucket and fixed window in
// `rate_limits`: `bucket` is the SHA-256 hex of `bucket_name` = `<name>:<subject>` (TEXT, ruling R43).
//
// A sliding-window counter over two fixed windows: the hit is counted first (`count = count + 1`, read back in the
// same transaction, @altis/db increment), and only then decided on, so that concurrent callers can never all pass:
// each of them sees its own count, and they are serialized on the row.
//
//   w        = BUCKETS[name].windowMs
//   start    = now - (now % w)
//   curr     = count of (bucket, start) after the +1
//   prev     = count of (bucket, start - w), or 0
//   estimate = floor(prev * (w - (now - start)) / w) + curr
//   allowed  = estimate <= limit
//   retryAfterS = allowed ? 0 : ceil((start + w - now) / 1000)
//
// The hit belongs to the caller's transaction: commit it before a check that may fail, so that a refused attempt
// is not rolled back with the failure (D3: such routes run `tx: 'self'`). A login that succeeds gives back what it
// counted with refund() and clears its username+IP bucket with clearBucket(), in the session's transaction.

/** Every bucket of the access layer (spec §7.1 login limits; `forgot:email` is two buckets, D11). */
export type BucketName =
  | 'login:user-ip'
  | 'login:ip'
  | 'login:user'
  | 'login:dev'
  | '2fa:session'
  | '2fa:user'
  | 'recovery:user'
  | 'reauth:session'
  | 'forgot:email:5m'
  | 'forgot:email:1d'
  | 'forgot:ip'
  | 'reset:ip'
  | 'authz-denied'
  // ---- Phase 2 (catalog): Task 2 ----
  // Named as the Phase 2 spec names them (P2-29): the OPAC search and OAI-PMH per client IP (a route's `ipLimits`),
  // ISBN/SRU lookups per staff user (hit by the handler, `tx: 'self'`).
  | 'opac_search'
  | 'oai'
  | 'catalog_lookup';

const MIN = 60_000;

const bucket = (limit: number, windowMs: number): Readonly<{ limit: number; windowMs: number }> =>
  Object.freeze({ limit, windowMs });

/** The limit of each bucket: at most `limit` hits per `windowMs` (sliding). */
export const BUCKETS: Readonly<Record<BucketName, Readonly<{ limit: number; windowMs: number }>>> = Object.freeze({
  'login:user-ip': bucket(5, 15 * MIN),
  'login:ip': bucket(20, 15 * MIN),
  'login:user': bucket(50, 60 * MIN),
  'login:dev': bucket(10, 15 * MIN),
  '2fa:session': bucket(5, 15 * MIN),
  '2fa:user': bucket(10, 15 * MIN),
  'recovery:user': bucket(5, 60 * MIN),
  'reauth:session': bucket(5, 15 * MIN),
  'forgot:email:5m': bucket(1, 5 * MIN),
  'forgot:email:1d': bucket(5, 24 * 60 * MIN),
  'forgot:ip': bucket(10, 60 * MIN),
  'reset:ip': bucket(20, 60 * MIN),
  'authz-denied': bucket(1, MIN),
  // ---- Phase 2 (catalog): Task 2 ----
  opac_search: bucket(120, MIN),
  oai: bucket(60, MIN),
  catalog_lookup: bucket(30, MIN),
});

/** One counted hit: where it was counted, and the decision. */
export interface Hit {
  name: BucketName;
  subject: string;
  /** `bucketKey(name, subject)`. */
  bucket: string;
  /** Start (epoch ms) of the fixed window the hit was counted in. */
  windowStart: number;
  /** The count of that window after this hit. */
  count: number;
  /** Whether the sliding estimate, this hit included, is within the limit. */
  allowed: boolean;
  /** 0 when allowed; otherwise the seconds left in the current window, rounded up. */
  retryAfterS: number;
}

/** Longest subject accepted, in UTF-16 code units: subjects are usernames, IPs, emails and ids, all far shorter. */
const MAX_SUBJECT = 1024;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function bucketName(name: unknown): BucketName {
  if (typeof name !== 'string' || !Object.hasOwn(BUCKETS, name)) {
    throw new TypeError(`rate limit: unknown bucket ${JSON.stringify(name)}; it must be one of BUCKETS`);
  }
  return name as BucketName;
}

/** A subject that can be stored in `bucket_name` on every dialect (no NUL for PostgreSQL, no lone surrogate). */
function subjectText(subject: unknown): string {
  if (typeof subject !== 'string' || subject === '' || subject.length > MAX_SUBJECT) {
    throw new TypeError(`rate limit: the subject must be a non-empty string of at most ${MAX_SUBJECT} characters`);
  }
  if (subject.includes('\u0000') || LONE_SURROGATE.test(subject)) {
    throw new TypeError('rate limit: the subject must not hold NUL or a lone surrogate');
  }
  return subject;
}

/** `trx` when it is a transaction; a TypeError otherwise (the counters run inside the caller's transaction). */
function transaction(trx: unknown, fn: string): Transaction<DB> {
  if (typeof trx !== 'object' || trx === null || (trx as { isTransaction?: unknown }).isTransaction !== true) {
    throw new TypeError(`${fn}() runs inside the caller's transaction: pass the trx of withTx(), not a database handle`);
  }
  return trx as Transaction<DB>;
}

/** The `rate_limits.bucket` of `name` + `subject`: `sha256hex(name + ':' + subject)`. */
export function bucketKey(name: BucketName, subject: string): string {
  return sha256hex(`${bucketName(name)}:${subjectText(subject)}`);
}

/**
 * Counts one hit on bucket `name` for `subject` at `now` (epoch ms) in `trx`, then decides with the sliding
 * estimate (see the top of this file). The count is written whatever the decision: a refused attempt counts too.
 * Await it before the next statement on `trx`.
 *
 * @throws TypeError, before anything is written, for an unknown bucket name, a subject that is empty, longer than
 *   1024 characters or holds NUL or a lone surrogate, a `now` that is not a safe non-negative integer, or a `trx`
 *   that is not a transaction
 */
export async function hit(trx: Transaction<DB>, name: BucketName, subject: string, now: number): Promise<Hit> {
  const t = transaction(trx, 'hit');
  const n = bucketName(name);
  const s = subjectText(subject);
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError(`hit: now must be a non-negative integer of epoch milliseconds, got ${String(now)}`);
  }
  const { limit, windowMs: w } = BUCKETS[n];
  const label = `${n}:${s}`;
  const key = sha256hex(label);
  const start = now - (now % w);

  const curr = await increment(t, 'rate_limits', { bucket: key, window_start: start }, 'count', { bucket_name: label });
  const previous = await t
    .selectFrom('rate_limits')
    .select('count')
    .where('bucket', '=', key)
    .where('window_start', '=', start - w)
    .executeTakeFirst();
  const prev = previous === undefined ? 0 : Number(previous.count);

  const estimate = Math.floor((prev * (w - (now - start))) / w) + curr;
  const allowed = estimate <= limit;
  return {
    name: n,
    subject: s,
    bucket: key,
    windowStart: start,
    count: curr,
    allowed,
    retryAfterS: allowed ? 0 : Math.ceil((start + w - now) / 1000),
  };
}

/**
 * Gives back the hit `h` in `trx`: `count = count - 1` in the window it was counted in, never below 0 (a window
 * already swept or cleared is left as it is).
 *
 * @throws TypeError when `trx` is not a transaction
 */
export async function refund(trx: Transaction<DB>, h: Hit): Promise<void> {
  const t = transaction(trx, 'refund');
  await t
    .updateTable('rate_limits')
    .set((eb) => ({ count: eb('count', '-', 1) }))
    .where('bucket', '=', h.bucket)
    .where('window_start', '=', h.windowStart)
    .where('count', '>', 0)
    .execute();
}

/**
 * Deletes every window of bucket `name` + `subject` in `trx` (a login that succeeds clears its username+IP bucket).
 *
 * @throws TypeError for an unknown bucket name, an invalid subject (see {@link hit}) or a `trx` that is not a
 *   transaction
 */
export async function clearBucket(trx: Transaction<DB>, name: BucketName, subject: string): Promise<void> {
  const t = transaction(trx, 'clearBucket');
  const key = bucketKey(name, subject);
  await t.deleteFrom('rate_limits').where('bucket', '=', key).execute();
}
