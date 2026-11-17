import type {
  NotificationItem,
  NotificationListResponse,
  NotificationReadAllResponse,
  NotificationReadResponse,
} from '@altis/shared/api/notifications';
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Tag } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useDateTime } from '@/components/data-table';
import { useT, type TKey } from '@/i18n';
import { api, isServerPage, safeNext } from '@/lib/api';
import { useApiQuery, useMe } from '@/lib/me';
import { page } from '@/lib/page';
import { cn } from '@/lib/utils';

/**
 * The notification centre (spec §10.9, §13.3; Task 28). Every query lives under `['notifications']`, the key the shell
 * makes stale when the realtime client hears a `notification` event (lib/realtime.ts): the count of the bell
 * (`GET notifications?limit=1`, whose `unread` counts all of the caller's unread notifications) and the panel's list
 * (`GET notifications`, newest first, `before` for the next page). Both are read in the background
 * (`X-Altis-Background: 1`): reading them again on an event is not the user's doing and must not keep an idle session
 * alive. Marking one or all read answers the new unread count, which both caches take at once.
 */

export const NOTIFICATIONS_KEY = ['notifications'] as const;
export const NOTIFICATION_COUNT_KEY = [...NOTIFICATIONS_KEY, 'count'] as const;
export const NOTIFICATION_LIST_KEY = [...NOTIFICATIONS_KEY, 'list'] as const;

/** The caller's unread count (the bell's query; the panel shares it). */
export function useUnreadNotifications(): number {
  const count = useApiQuery<NotificationListResponse>({
    queryKey: NOTIFICATION_COUNT_KEY,
    path: 'notifications?limit=1',
    request: { background: true },
  });
  return count.data?.unread ?? 0;
}

/** Writes a read marker (one notification, or all when `id` is null) and the new unread count into both caches. */
function markRead(queryClient: QueryClient, id: string | null, unread: number): void {
  const mark = (item: NotificationItem): NotificationItem => (id === null || item.id === id ? { ...item, read: true } : item);
  queryClient.setQueryData<NotificationListResponse>(NOTIFICATION_COUNT_KEY, (old) =>
    old === undefined ? old : { ...old, unread, items: old.items.map(mark) },
  );
  queryClient.setQueryData<InfiniteData<NotificationListResponse, string | null>>(NOTIFICATION_LIST_KEY, (old) =>
    old === undefined ? old : { ...old, pages: old.pages.map((page) => ({ ...page, unread, items: page.items.map(mark) })) },
  );
}

const listPath = (before: string | null): string =>
  before === null ? 'notifications' : `notifications?${new URLSearchParams({ before }).toString()}`;

/**
 * The list of the caller's notifications with "Tandai semua dibaca". Opening a notification marks it read and, when
 * it has a link on this site under `/admin` (safeNext), goes there; `onNavigate` is called first (the bell closes).
 */
export function NotificationPanel({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const unread = useUnreadNotifications();

  const list = useInfiniteQuery({
    queryKey: NOTIFICATION_LIST_KEY,
    queryFn: ({ pageParam }) => api<NotificationListResponse>('GET', listPath(pageParam), undefined, { background: true }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextBefore,
    enabled: me !== undefined,
  });

  const markAll = useMutation({
    mutationFn: () => api<NotificationReadAllResponse>('POST', 'notifications/read-all'),
    onSuccess: (answer) => markRead(queryClient, null, answer.unread),
  });
  const markOne = useMutation({
    mutationFn: (id: string) => api<NotificationReadResponse>('POST', `notifications/${encodeURIComponent(id)}/read`),
    onSuccess: (answer) => markRead(queryClient, answer.item.id, answer.unread),
  });

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const failed = markAll.isError || markOne.isError;

  const open = (item: NotificationItem): void => {
    if (!item.read) markOne.mutate(item.id);
    if (item.link !== null && safeNext(item.link) === item.link) {
      onNavigate?.();
      // 1c Task 19: the operations page (an op that needs attention) is the server's own page: loaded, not routed.
      if (isServerPage(item.link)) page.assign(item.link);
      else void navigate({ href: item.link });
    }
  };

  return (
    <div className="flex max-h-[min(32rem,80dvh)] flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <h2 className="text-sm font-bold">{t('notifications.title')}</h2>
        <Button variant="ghost" size="sm" disabled={unread === 0 || markAll.isPending} onClick={() => markAll.mutate()}>
          {t('notifications.mark_all_read')}
        </Button>
      </div>
      {failed && (
        <p role="alert" className="border-b px-4 py-2 text-sm font-semibold text-bad">
          {t('notifications.action_failed')}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <p role="status" className="px-4 py-6 text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        ) : list.isError ? (
          <div className="grid justify-items-start gap-2 px-4 py-6 text-sm">
            <p className="font-semibold text-bad">{t('notifications.load_failed')}</p>
            <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
              {t('notifications.retry')}
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('notifications.empty')}</p>
        ) : (
          <ul aria-label={t('notifications.title')} className="divide-y">
            {items.map((item) => (
              <li key={item.id}>
                <NotificationRow item={item} when={dateTime(item.createdAt)} onOpen={() => open(item)} />
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="border-t p-2 text-center">
            <Button variant="ghost" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('notifications.load_more')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One notification: its title and body from the shared catalog (`notification.<x>.title`, the body key derived from
 * it, M44), its time, and an unread marker. A button while there is something to do (mark it read, open its link).
 */
function NotificationRow({ item, when, onOpen }: { item: NotificationItem; when: string; onOpen: () => void }) {
  const t = useT();
  const title = t(item.titleKey, item.params);
  const bodyKey = item.titleKey.replace(/\.title$/, '.body');
  // The shared t() answers an unknown key with the key itself: no body then.
  const text = bodyKey === item.titleKey ? bodyKey : t(bodyKey as TKey, item.params);
  const body = text === bodyKey ? '' : text;
  const content = (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      {!item.read && <Tag className="mb-0.5">{t('notifications.unread')}</Tag>}
      <span className={cn('text-sm', !item.read && 'font-semibold')}>{title}</span>
      {body !== '' && <span className="text-sm text-muted-foreground">{body}</span>}
      <span className="text-xs text-muted-foreground">{when}</span>
    </span>
  );
  const actionable = !item.read || (item.link !== null && safeNext(item.link) === item.link);
  if (!actionable) return <div className="px-4 py-3 text-left">{content}</div>;
  return (
    <button type="button" onClick={onOpen} className="block w-full px-4 py-3 text-left outline-none hover:bg-accent focus-visible:bg-accent">
      {content}
    </button>
  );
}
