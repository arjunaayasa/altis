import type { DB } from '@altis/db';
import { countRows } from '@altis/db';
import { DomainError, MESSAGES, isPermission, isUlid, newId, type MessageKey, type Permission } from '@altis/shared';
import { NOTIFICATION_PAGE_MAX, type NotificationItem } from '@altis/shared/api/notifications';
import type { Kysely, Transaction } from 'kysely';
import { lockStaffRow } from '../auth/staff.js';
import type { ActorAuthz } from '../authz/escalation.js';
import { publish } from '../events/publish.js';

// Notifications (spec §10.9): a message for one staff user, or for every holder of a permission, kept 90 days
// (`expires_at`, L38, decision C24) and read per user (`notification_reads`). Each one is announced by a
// `notification` event: a hint on `user.<id>` or, for a permission audience, on `system.status` with `{permission}`,
// after which the client calls `GET notifications` (events carry no personal data, §10.6).
//
// - The row holds the title key (`notification.<x>.title`) and the parameters of its placeholders; the body key is
//   derived from it (`.title` → `.body`, M44), so both are checked against the catalog when it is written.
// - The id is a new ULID (newId(): time-ordered, strictly increasing within a process), so id order is the order the
//   notifications were written in, and a page is a keyset on the id (`before`), newest first. The id does not take
//   the caller's `now`: an explicit time would move the process-wide ULID sequence along with it.
// - Read markers: the writers of a user's markers ({@link markRead}, {@link markAllRead}) lock that user's staff_users
//   row first (lockStaffRow), so two of them never race to insert the same marker; nothing else inserts markers
//   (retention deletes notifications, and their markers with them, ON DELETE CASCADE).

export type { NotificationItem } from '@altis/shared/api/notifications';

/** How long a notification is kept: 90 days (§10.9), as `expires_at = created_at + NOTIFICATION_TTL_MS`. */
export const NOTIFICATION_TTL_MS = 90 * 86_400_000;

/** The largest `params`, in bytes of its JSON text (UTF-8). */
export const NOTIFICATION_PARAMS_MAX = 4096;

/** The largest `link`, in characters. */
export const NOTIFICATION_LINK_MAX = 2048;

/** Markers inserted per statement by {@link markAllRead}. */
export const NOTIFICATION_MARK_BATCH = 500;

/** Who a notification is for: one staff user, or every holder (global) of a permission. */
export type NotificationAudience = { userId: string } | { permission: Permission };

export interface NotificationInput {
  audience: NotificationAudience;
  /** What happened, as an event-type-like name (`backup.done`): `/^[a-z][a-z0-9_.]{0,63}$/`. */
  type: string;
  /** A `notification.<x>.title` key; its body is `notification.<x>.body` (M44). Both must be in the catalog. */
  titleKey: MessageKey;
  /** The values of the placeholders of the title and the body; `{}` when left out. */
  params?: Record<string, string | number>;
  /** A path on this site to open (`/admin/backups`), or null. */
  link?: string | null;
  /** How long to keep it, in ms; default {@link NOTIFICATION_TTL_MS}. */
  ttlMs?: number;
}

/** A notification type: lower case, dot-separated words, at most 64 characters (the column's width). */
const NOTIFICATION_TYPE = /^[a-z][a-z0-9_.]{0,63}$/;
/** A title key of the `notification.*` family. */
const TITLE_KEY = /^notification\.[a-z][a-z0-9_]*\.title$/;
/** A placeholder name, as the catalog's `{name}` placeholders spell them. */
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** C0 controls, DEL and C1 controls (NUL included). */
const CONTROL = /\p{Cc}/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

const NOT_FOUND_DETAIL = 'Notifikasi tidak ditemukan / Notification not found';

/** `audience` checked: the user's id or the permission, exactly one of them. */
function audienceOf(a: unknown): { userId: string; permission: null } | { userId: null; permission: Permission } {
  if (typeof a !== 'object' || a === null) throw new TypeError('notify: the audience must be {userId} or {permission}');
  const keys = Object.keys(a);
  const { userId, permission } = a as { userId?: unknown; permission?: unknown };
  if (keys.length === 1 && keys[0] === 'userId') {
    if (typeof userId !== 'string' || !isUlid(userId)) throw new TypeError('notify: audience.userId must be a ULID');
    return { userId, permission: null };
  }
  if (keys.length === 1 && keys[0] === 'permission') {
    if (typeof permission !== 'string' || !isPermission(permission)) {
      throw new TypeError('notify: audience.permission must be a permission of the catalog');
    }
    return { userId: null, permission };
  }
  throw new TypeError('notify: the audience must be exactly one of {userId} and {permission}');
}

/** `params` as its JSON text: a plain object of placeholder names to strings and finite numbers. */
function paramsText(p: unknown): string {
  if (p === undefined) return '{}';
  const proto: unknown = typeof p === 'object' && p !== null ? Object.getPrototypeOf(p) : undefined;
  if (typeof p !== 'object' || p === null || Array.isArray(p) || (proto !== Object.prototype && proto !== null)) {
    throw new TypeError('notify: params must be a plain object');
  }
  for (const [name, value] of Object.entries(p)) {
    if (!PARAM_NAME.test(name) || name === '__proto__') throw new TypeError('notify: a params name must be a placeholder name');
    const ok = typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
    if (!ok) throw new TypeError('notify: a params value must be a string or a finite number');
  }
  // JSON.stringify escapes NUL and lone surrogates, so the text stores on every dialect.
  const text = JSON.stringify(p);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > NOTIFICATION_PARAMS_MAX) {
    throw new TypeError(`notify: params is ${bytes} bytes of JSON, more than ${NOTIFICATION_PARAMS_MAX}`);
  }
  return text;
}

/**
 * `link` checked: null, or a path on this site (`/…`), never a URL with a scheme or a host (`javascript:`,
 * `https://…`, `//host`, `/\host`): the SPA navigates to it.
 */
function linkOf(link: unknown): string | null {
  if (link === undefined || link === null) return null;
  if (
    typeof link !== 'string' ||
    link.length > NOTIFICATION_LINK_MAX ||
    !link.startsWith('/') ||
    link.startsWith('//') ||
    link.includes('\\') ||
    CONTROL.test(link) ||
    LONE_SURROGATE.test(link)
  ) {
    throw new TypeError(`notify: link must be null or a path on this site (/…, at most ${NOTIFICATION_LINK_MAX} characters)`);
  }
  return link;
}

/** The row of `n` at `now`, every part checked (nothing is written when one is wrong). */
function prepare(n: NotificationInput, now: number) {
  if (typeof n !== 'object' || n === null) throw new TypeError('notify: the notification must be an object');
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('notify: now must be a safe non-negative integer');
  const audience = audienceOf(n.audience);
  if (typeof n.type !== 'string' || !NOTIFICATION_TYPE.test(n.type)) {
    throw new TypeError(`notify: the type must match ${String(NOTIFICATION_TYPE)}`);
  }
  const titleKey: unknown = n.titleKey;
  if (typeof titleKey !== 'string' || !TITLE_KEY.test(titleKey)) {
    throw new TypeError('notify: titleKey must be a notification.<x>.title key');
  }
  const bodyKey = `${titleKey.slice(0, -'.title'.length)}.body`;
  if (!hasOwn(MESSAGES.id, titleKey) || !hasOwn(MESSAGES.id, bodyKey)) {
    throw new TypeError('notify: titleKey and its body key must both be in the message catalog');
  }
  const ttl = n.ttlMs ?? NOTIFICATION_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || !Number.isSafeInteger(now + ttl)) {
    throw new TypeError('notify: ttlMs must be a positive safe integer');
  }
  return {
    id: newId(),
    audience_permission: audience.permission,
    user_id: audience.userId,
    type: n.type,
    title_key: titleKey,
    params: paramsText(n.params),
    link: linkOf(n.link),
    created_at: now,
    expires_at: now + ttl,
  };
}

/**
 * Writes the notification `n`, created at `now` (`expires_at = now + ttlMs`, default 90 days), then publishes its
 * `notification` event: on `user.<id>` with payload `{}` for a user, on `system.status` with `{permission}` for a
 * permission audience (no personal data either way). `publish` reads its own clock right before its INSERT (S17).
 *
 * **Call it last in the caller's transaction**: its event must be the transaction's last statement (spec §10.6), and
 * it commits with the caller's change or not at all. Re-runnable as a whole (R37): it writes only through `trx`.
 *
 * @returns the new notification's id
 * @throws TypeError, before anything is written, when `trx` is not a transaction, the audience is not exactly one
 *   ULID `userId` or one catalog `permission`, the type is not `/^[a-z][a-z0-9_.]{0,63}$/`, `titleKey` is not a
 *   `notification.<x>.title` key whose body key is in the catalog too, `params` is not a plain object of placeholder
 *   names to strings and finite numbers of at most {@link NOTIFICATION_PARAMS_MAX} bytes of JSON, `link` is not null
 *   or a path on this site, `ttlMs` is not a positive safe integer, or `now` is not a safe non-negative integer
 */
export async function notify(trx: Transaction<DB>, n: NotificationInput, now: number): Promise<string> {
  if (typeof trx !== 'object' || trx === null || (trx as { isTransaction?: unknown }).isTransaction !== true) {
    throw new TypeError('notify() runs inside the caller’s transaction: pass the trx of withTx(), not a database handle');
  }
  const row = prepare(n, now);
  await trx.insertInto('notifications').values(row).execute();
  // The last statement of the caller's transaction (§10.6).
  if (row.user_id !== null) await publish(trx, { channel: `user.${row.user_id}`, type: 'notification' });
  else await publish(trx, { channel: 'system.status', type: 'notification', payload: { permission: row.audience_permission } });
  return row.id;
}

/** `actor` checked: a string id and grants with a `global` set. */
function checkActor(actor: ActorAuthz): void {
  if (typeof actor !== 'object' || actor === null || typeof actor.id !== 'string' || !(actor.grants?.global instanceof Set)) {
    throw new TypeError('notifications: the actor must be {id, grants}');
  }
}

function checkNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('notifications: now must be a safe non-negative integer');
}

/**
 * The notifications `actor` may see at `now`, each with the actor's own read marker (`r`): addressed to the actor, or
 * to a permission the actor holds globally (`can(grants, p)`), and not expired (`expires_at > now`).
 */
function visible(db: Kysely<DB> | Transaction<DB>, actor: ActorAuthz, now: number) {
  const held = [...actor.grants.global];
  return db
    .selectFrom('notifications as n')
    .leftJoin('notification_reads as r', (join) => join.onRef('r.notification_id', '=', 'n.id').on('r.user_id', '=', actor.id))
    .where((eb) =>
      eb.and([
        held.length === 0
          ? eb('n.user_id', '=', actor.id)
          : eb.or([eb('n.user_id', '=', actor.id), eb('n.audience_permission', 'in', held)]),
        eb('n.expires_at', '>', now),
      ]),
    );
}

const ITEM_COLUMNS = ['n.id', 'n.type', 'n.title_key', 'n.params', 'n.link', 'n.created_at', 'r.read_at'] as const;

type ItemRow = {
  id: string;
  type: string;
  title_key: string;
  params: string;
  link: string | null;
  created_at: number;
  read_at: number | null;
};

/** The stored params as an object; a text that is not a JSON object of strings and numbers reads as `{}`. */
function paramsObject(text: string): Record<string, string | number> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const out: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(value)) {
        // `__proto__` would set the prototype rather than a key; notify() never writes it.
        if (k !== '__proto__' && (typeof v === 'string' || typeof v === 'number')) out[k] = v;
      }
      return out;
    }
  } catch {
    // not JSON: falls through
  }
  return {};
}

function toItem(r: ItemRow): NotificationItem {
  return {
    id: r.id,
    type: r.type,
    // The stored key (one of a later release stays as written; the client shows a key it does not know as is).
    titleKey: r.title_key as MessageKey,
    params: paramsObject(r.params),
    link: r.link,
    createdAt: Number(r.created_at),
    read: r.read_at !== null,
  };
}

/** How many notifications `actor` may see at `now` and has not read (through `db`: a transaction counts inside it). */
export async function countUnread(db: Kysely<DB> | Transaction<DB>, actor: ActorAuthz, now: number): Promise<number> {
  checkActor(actor);
  checkNow(now);
  return countRows(visible(db, actor, now).where('r.notification_id', 'is', null));
}

/**
 * One page of the notifications `actor` may see at `o.now` (its own, and those of the permissions it holds
 * globally), not expired, newest first: at most `o.limit` (1-50) with an id below `o.before` when given, each with
 * the actor's read marker. `unread` counts every visible notification the actor has not read; `nextBefore` is the id
 * of the last item when more follow (the `before` of the next page), otherwise null.
 *
 * @throws RangeError for a `limit` outside 1-50, a `before` that is not a ULID or a `now` that is not a safe
 *   non-negative integer (the API's schema refuses the first two first); TypeError for a malformed actor
 */
export async function listNotifications(
  db: Kysely<DB> | Transaction<DB>,
  actor: ActorAuthz,
  o: { now: number; limit: number; before?: string },
): Promise<{ items: NotificationItem[]; unread: number; nextBefore: string | null }> {
  checkActor(actor);
  checkNow(o.now);
  if (!Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > NOTIFICATION_PAGE_MAX) {
    throw new RangeError(`limit must be an integer from 1 to ${NOTIFICATION_PAGE_MAX}`);
  }
  if (o.before !== undefined && !isUlid(o.before)) throw new RangeError('before must be a ULID');
  let query = visible(db, actor, o.now).select(ITEM_COLUMNS).orderBy('n.id', 'desc').limit(o.limit + 1);
  if (o.before !== undefined) query = query.where('n.id', '<', o.before);
  const rows = await query.execute();
  const items = rows.slice(0, o.limit).map(toItem);
  const unread = await countUnread(db, actor, o.now);
  return { items, unread, nextBefore: rows.length > o.limit ? items[items.length - 1]!.id : null };
}

function notFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
}

/**
 * Marks the notification `id` read by `actor` at `now` (its first read time is kept when it was read before), in
 * `trx`, and returns it. It locks the actor's staff_users row first (lockStaffRow), so it is the first statement of
 * `trx` (as for a route's handler transaction).
 *
 * @throws DomainError `NOT_FOUND` (404) when `actor` may not see `id` at `now`: another user's, a permission the
 *   actor does not hold, expired, unknown or not a ULID (existence is not leaked)
 */
export async function markRead(trx: Transaction<DB>, actor: ActorAuthz, id: string, now: number): Promise<NotificationItem> {
  checkActor(actor);
  checkNow(now);
  if (typeof id !== 'string' || !isUlid(id)) throw notFound();
  await lockStaffRow(trx, actor.id);
  const row = await visible(trx, actor, now).select(ITEM_COLUMNS).where('n.id', '=', id).executeTakeFirst();
  if (row === undefined) throw notFound();
  if (row.read_at === null) {
    await trx.insertInto('notification_reads').values({ notification_id: id, user_id: actor.id, read_at: now }).execute();
  }
  return { ...toItem(row), read: true };
}

/**
 * Marks every notification `actor` may see at `now` and has not read as read at `now`, in `trx`, in statements of at
 * most {@link NOTIFICATION_MARK_BATCH} markers (keyset on the id). It locks the actor's staff_users row first
 * (lockStaffRow), as {@link markRead}.
 *
 * @returns how many it marked
 */
export async function markAllRead(trx: Transaction<DB>, actor: ActorAuthz, now: number): Promise<number> {
  checkActor(actor);
  checkNow(now);
  await lockStaffRow(trx, actor.id);
  let marked = 0;
  let after: string | null = null;
  for (;;) {
    let query = visible(trx, actor, now)
      .select('n.id')
      .where('r.notification_id', 'is', null)
      .orderBy('n.id')
      .limit(NOTIFICATION_MARK_BATCH);
    if (after !== null) query = query.where('n.id', '>', after);
    const rows = await query.execute();
    if (rows.length === 0) break;
    await trx
      .insertInto('notification_reads')
      .values(rows.map((r) => ({ notification_id: r.id, user_id: actor.id, read_at: now })))
      .execute();
    marked += rows.length;
    after = rows[rows.length - 1]!.id;
    if (rows.length < NOTIFICATION_MARK_BATCH) break;
  }
  return marked;
}
