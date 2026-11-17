import type { Alert as SystemAlert, AlertSeverity } from '@altis/shared/api/dashboard';
import { DASHBOARD_EXPIRING_DAYS, DASHBOARD_LONG_OVERDUE_DAYS } from '@altis/shared/api/dashboard-home';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { safeNext } from '@/lib/api';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { PageLink, useSystemDashboard } from '@/screens/dashboard';
import { useCount, useDeskToday, useLibraryToday } from '@/screens/dashboard-today';

/**
 * "Perlu perhatian" on Beranda: what someone should look at, one line each, with its count (or, for a system alert,
 * its severity in words) and a link to the screen that deals with it. Built from what the reads of Beranda already
 * carry, so each line shows only to a user who may read its data and open its screen:
 *
 * - the system dashboard's alerts (`GET dashboard`, filtered there by permission), errors first;
 * - loans more than 14 days overdue at any branch (`circulation.records.read`) → the overdue list;
 * - at the desk's branch (`circulation.desk.use` there): copies on the hold shelf to clear (past their pickup date,
 *   expired or cancelled), and holds ready for pickup → the hold shelf;
 * - active memberships ending within 14 days (`members.records.read`) → the expiring members report, set to 14 days
 *   and to the active members not yet ended, so that it lists the members the line counts;
 * - an update ready to install (`system.update.read`) → Pembaruan;
 * - then the system's warnings and notes.
 *
 * A line with a count of 0 is left out. A user who may read the library's or the desk's lines always sees the block:
 * with no line, one sentence says nothing needs attention (once those reads have answered); when the library's read
 * failed, the block says so with "Coba lagi" (its lines may be missing). Anyone else sees it only with a line.
 */

interface Item {
  key: string;
  label: string;
  value: string;
  tone: 'bad' | 'warn' | 'plain';
  to: string | null;
  search?: Record<string, string | number | boolean>;
}

const SEVERITY_TONE: Readonly<Record<AlertSeverity, Item['tone']>> = { error: 'bad', warning: 'warn', info: 'plain' };

const TONE_CLASS: Readonly<Record<Item['tone'], string>> = {
  bad: 'font-semibold text-bad',
  warn: 'font-semibold text-warn',
  plain: 'text-muted-foreground',
};

/** The lines of the block, in order (see the top of this file). */
export function useAttentionItems(): Item[] {
  const t = useT();
  const me = useMe();
  const count = useCount();
  const system = useSystemDashboard();
  const { desk, query: deskQuery } = useDeskToday();
  const library = useLibraryToday();
  const alerts = system.data?.alerts ?? [];
  const alertItem = (a: SystemAlert): Item => ({
    key: `alert.${a.kind}`,
    label: t(a.messageKey, a.params),
    value: t(`dashboard.severity.${a.severity}`),
    tone: SEVERITY_TONE[a.severity],
    to: a.link !== undefined && safeNext(a.link) === a.link ? a.link : null,
  });
  const counted = (key: string, label: string, n: number | undefined, to: string | null, tone: Item['tone'] = 'plain'): Item[] =>
    n === undefined || n <= 0 ? [] : [{ key, label, value: count(n), tone, to }];

  const d = desk.branchId === null ? undefined : deskQuery.data;
  const update = system.data?.version.update?.available ?? null;
  return [
    ...alerts.filter((a) => a.severity === 'error').map(alertItem),
    ...counted(
      'long_overdue',
      t('dashboard.home.attention.long_overdue', { days: DASHBOARD_LONG_OVERDUE_DAYS }),
      library.data?.loans?.longOverdue,
      holds(me, 'circulation.records.read') ? '/admin/layanan/terlambat' : null,
      'bad',
    ),
    ...counted('holds_to_clear', t('dashboard.home.attention.holds_to_clear'), d?.holdsToClear, '/admin/layanan/rak-tunggu', 'warn'),
    ...counted('holds_ready', t('dashboard.today.holds_ready'), d?.holdsReady, '/admin/layanan/rak-tunggu'),
    ...counted(
      'expiring',
      t('dashboard.home.attention.expiring', { days: DASHBOARD_EXPIRING_DAYS }),
      library.data?.members?.expiringSoon,
      `/admin/reports/${encodeURIComponent('members.expiring')}`,
    ).map((item) => ({ ...item, search: { days: DASHBOARD_EXPIRING_DAYS, activeOnly: true } })),
    ...(update === null ? [] : [{ key: 'update', label: t('dashboard.home.attention.update', { version: update.version }), value: '', tone: 'plain' as const, to: '/admin/updates' }]),
    ...alerts.filter((a) => a.severity !== 'error').map(alertItem),
  ];
}

/** The block's own reads, for a user who may read a line of the library or of the desk (see the top of this file). */
export interface AttentionSources {
  /** The user may read a line of the library or of the desk: the block is shown even without a line. */
  reads: boolean;
  /** Those reads have not all answered yet. */
  pending: boolean;
  /** The library's read failed (and has no earlier answer): read it again. */
  retry: (() => void) | null;
}

/** See {@link AttentionSources}. */
export function useAttentionSources(): AttentionSources {
  const me = useMe();
  const { desk, query: deskQuery } = useDeskToday();
  const library = useLibraryToday();
  const readsLibrary = holds(me, 'circulation.records.read') || holds(me, 'members.records.read');
  const readsDesk = desk.branchId !== null;
  const libraryFailed = readsLibrary && library.data === undefined && library.isError;
  return {
    reads: readsLibrary || readsDesk,
    pending: (readsLibrary && library.data === undefined && !library.isError) || (readsDesk && deskQuery.data === undefined && !deskQuery.isError),
    retry: libraryFailed ? () => void library.refetch() : null,
  };
}

/** "Perlu perhatian" (see the top of this file); nothing for a user who sees no line and reads none of its sources. */
export function Attention({ items, sources }: { items: readonly Item[]; sources: AttentionSources }) {
  const t = useT();
  const headingId = useId();
  if (items.length === 0 && !sources.reads) return null;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3" data-attention="">
      <h2 id={headingId} className="text-base font-bold">
        {t('dashboard.home.attention.title')}
      </h2>
      {items.length === 0 && sources.retry === null && (
        <p className="border-t pt-2.5 text-sm text-muted-foreground">
          {sources.pending ? <span className="block h-4 w-2/3 animate-pulse rounded bg-layer-2 motion-reduce:animate-none" aria-hidden="true" /> : t('dashboard.home.attention.empty')}
        </p>
      )}
      {sources.retry !== null && (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-bad-line bg-bad-bg px-3.5 py-3 text-sm">
          <span className="font-bold text-bad">{t('dashboard.home.load_failed')}</span>
          <Button variant="outline" size="sm" onClick={sources.retry}>
            {t('table.retry')}
          </Button>
        </div>
      )}
      {items.length > 0 && (
        <ul className="border-t">
          {items.map((item) => {
            const body = (
              <>
                <span className={cn('font-semibold', item.to !== null && 'group-hover:text-accent-text group-hover:underline')}>{item.label}</span>
                {/* A space between the two, for the accessible name of the link. */}{' '}
                {item.value !== '' && <span className={cn('shrink-0 tabular-nums', TONE_CLASS[item.tone])}>{item.value}</span>}
              </>
            );
            const row = 'flex items-baseline justify-between gap-3 py-2.5';
            return (
              <li key={item.key} className="border-b" data-attention-item={item.key}>
                {item.to === null ? (
                  <div className={row}>{body}</div>
                ) : (
                  <PageLink to={item.to} search={item.search} className={cn(row, 'group rounded-sm text-foreground no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring')}>
                    {body}
                  </PageLink>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
