/**
 * The notifications API vocabulary shared by the server and the admin SPA (spec §10.9, §13.5 "Event & notifikasi"):
 * the query string of `GET notifications` and the answers of `GET notifications`, `POST notifications/:id/read` and
 * `POST notifications/read-all`. No Node built-ins here: the browser bundles this module. Import it as
 * `@altis/shared/api/notifications`.
 *
 * A notification is addressed to one staff user or to every holder of a permission; the client renders its title
 * and body from the message catalog (`titleKey`, and the body key derived from it by replacing `.title` with `.body`,
 * M44) filled with `params`. Query strings are text, so the number goes through `z.coerce.number().int()` (M5); the
 * object is strict (§7.4).
 */
import { z } from 'zod';
import type { MessageKey } from '../i18n/index.js';
import { ulidField } from './common.js';

/** The default page size of `GET notifications`. */
export const NOTIFICATION_PAGE_DEFAULT = 20;
/** The largest page size of `GET notifications`. */
export const NOTIFICATION_PAGE_MAX = 50;

/**
 * `GET notifications`: keyset paging on the notification id, newest first: `before` is the `nextBefore` of the
 * previous page (only notifications older than it), `limit` the page size (1-50, default 20).
 */
export const NotificationListQuery = z.strictObject({
  before: ulidField.optional(),
  limit: z.coerce.number().int().min(1).max(NOTIFICATION_PAGE_MAX).optional(),
});

export type NotificationListQuery = z.infer<typeof NotificationListQuery>;

/**
 * One notification as its reader sees it. `type` names what happened (`backup.done`); `titleKey` is a
 * `notification.<x>.title` key (its body is `notification.<x>.body`), `params` fills their `{name}` placeholders;
 * `link` is a path on this site to open (or null); `createdAt` is epoch ms; `read` is the reader's own marker (a
 * notification addressed to a permission is read or unread per holder).
 */
export interface NotificationItem {
  id: string;
  type: string;
  titleKey: MessageKey;
  params: Record<string, string | number>;
  link: string | null;
  createdAt: number;
  read: boolean;
}

/**
 * The answer of `GET notifications`: the caller's notifications that have not expired, newest first; `unread` counts
 * all of them the caller has not read (not only this page's); `nextBefore` is the `before` of the next page, null on
 * the last one.
 */
export interface NotificationListResponse {
  items: NotificationItem[];
  unread: number;
  nextBefore: string | null;
}

/** The answer of `POST notifications/:id/read`: the notification, now read, and the caller's new unread count. */
export interface NotificationReadResponse {
  item: NotificationItem;
  unread: number;
}

/** The answer of `POST notifications/read-all`: how many notifications it marked, and the caller's unread count. */
export interface NotificationReadAllResponse {
  marked: number;
  unread: number;
}
