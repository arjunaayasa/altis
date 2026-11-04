import { countUnread, listNotifications, markAllRead, markRead, type ActorAuthz } from '@altis/core';
import { ulidField } from '@altis/shared/api/common';
import {
  NOTIFICATION_PAGE_DEFAULT,
  NotificationListQuery,
  type NotificationListResponse,
  type NotificationReadAllResponse,
  type NotificationReadResponse,
} from '@altis/shared/api/notifications';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';

// The notifications routes of Task 7 (spec §10.9, §13.5 "Event & notifikasi"; route catalog `notifications.*`):
// every signed-in staff user (`public` with `session: 'required'`, so a user without any role passes) reads the
// notifications addressed to them and to the permissions they hold, marks one read or all of them. `mode: system`
// (§8.6): they keep working in read-only. No audit entry (a read marker is the reader's own state), no idempotency
// key (marking read twice is harmless). The writes run in the handler transaction, whose first statement is core's
// lock of the caller's staff row. An id the caller may not see is 404 (existence is not leaked).

const NOTIFICATIONS = '/api/v1/notifications';
const IdParams = z.strictObject({ id: ulidField });
const NO_STORE = { 'Cache-Control': 'no-store' };

/** The caller and the grants of this request (step 7). */
function actorOf(rc: RouteContext<unknown, unknown, unknown>): ActorAuthz {
  const auth = rc.auth;
  // Unreachable: every route here requires a session, which step 9 refuses without one.
  if (auth === null) throw new TypeError('notifications routes run with a session');
  return { id: auth.subjectId, grants: auth.grants };
}

/** The handler transaction (non-GET `tx: 'handler'` routes). */
function trxOf(rc: RouteContext<unknown, unknown, unknown>) {
  return rc.tx().trx;
}

/** GET notifications. */
const notificationsList = route({
  id: 'notifications.list',
  method: 'GET',
  path: NOTIFICATIONS,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  query: NotificationListQuery,
  handler: async (rc) => {
    const body: NotificationListResponse = await listNotifications(rc.db.db, actorOf(rc), {
      now: rc.now,
      limit: rc.query.limit ?? NOTIFICATION_PAGE_DEFAULT,
      ...(rc.query.before === undefined ? {} : { before: rc.query.before }),
    });
    return { body, headers: NO_STORE };
  },
});

/** POST notifications/:id/read. */
const notificationsRead = route({
  id: 'notifications.read',
  method: 'POST',
  path: `${NOTIFICATIONS}/:id/read`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => {
    const actor = actorOf(rc);
    const trx = trxOf(rc);
    const item = await markRead(trx, actor, rc.params.id, rc.now);
    const body: NotificationReadResponse = { item, unread: await countUnread(trx, actor, rc.now) };
    return { body, headers: NO_STORE };
  },
});

/** POST notifications/read-all. */
const notificationsReadAll = route({
  id: 'notifications.read_all',
  method: 'POST',
  path: `${NOTIFICATIONS}/read-all`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const actor = actorOf(rc);
    const trx = trxOf(rc);
    const marked = await markAllRead(trx, actor, rc.now);
    const body: NotificationReadAllResponse = { marked, unread: await countUnread(trx, actor, rc.now) };
    return { body, headers: NO_STORE };
  },
});

export const NOTIFICATIONS_ROUTES: RouteDecl[] = [notificationsList, notificationsRead, notificationsReadAll];
