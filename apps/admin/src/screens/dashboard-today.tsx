import type { DeskDashboard, LibraryDashboard } from '@altis/shared/api/dashboard-home';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useLocale, useT } from '@/i18n';
import { holds } from '@/lib/access';
import { useApiQuery, useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { useDeskBranch } from '@/screens/circulation/common';

/**
 * The library figures of Beranda and the strip of today's numbers at its top: four figures separated by thin rules,
 * each a link to the screen that holds its rows (a plain figure for a user who may not open that screen).
 *
 * - At the desk's branch (the branch the desk keeps in this browser), for a holder of `circulation.desk.use` there:
 *   lent today, returned today (each with the same weekday a week before), and overdue loans (with the members who hold
 *   them), from `GET branches/:branchId/dashboard`.
 * - For a holder of `members.records.read`: the members whose membership is valid today, with those who joined this
 *   month, from `GET dashboard/library`.
 *
 * A user who holds neither sees no strip. Both reads are shared with the blocks below (the same query keys), read in
 * the background every minute while the page is open, like the system dashboard.
 */

/** How often an open Beranda reads its figures again. */
export const HOME_REFRESH_MS = 60_000;

/** Today at the desk's branch (no read without one). */
export function useDeskToday() {
  const desk = useDeskBranch();
  const branchId = desk.branchId;
  const query = useApiQuery<DeskDashboard>({
    queryKey: ['dashboard', 'home', 'desk', branchId],
    path: `branches/${encodeURIComponent(branchId ?? '')}/dashboard`,
    enabled: branchId !== null,
    request: { background: true },
    refetchInterval: HOME_REFRESH_MS,
  });
  return { desk, query };
}

/** The library sections the user may read (each null otherwise). */
export function useLibraryToday() {
  return useApiQuery<LibraryDashboard>({
    queryKey: ['dashboard', 'home', 'library'],
    path: 'dashboard/library',
    request: { background: true },
    refetchInterval: HOME_REFRESH_MS,
  });
}

/** Whole numbers in the UI language. */
export function useCount(): (n: number) => string {
  const locale = useLocale();
  return useCallback((n: number) => new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID').format(n), [locale]);
}

/** The weekday of a calendar date `YYYY-MM-DD` in the UI language. */
function useWeekday(): (day: string) => string {
  const locale = useLocale();
  return useCallback(
    (day: string) => {
      const at = Date.parse(`${day}T12:00:00Z`);
      return Number.isNaN(at) ? day : new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { weekday: 'long', timeZone: 'UTC' }).format(at);
    },
    [locale],
  );
}

interface Figure {
  key: string;
  label: string;
  /** undefined while loading; null when the read failed. */
  value: number | null | undefined;
  note: string | null;
  to: string | null;
}

const MD_COLS: Readonly<Record<number, string>> = { 1: 'md:grid-cols-1', 2: 'md:grid-cols-2', 3: 'md:grid-cols-3', 4: 'md:grid-cols-4' };

/** The rules between the figures: two columns on a narrow screen, one row from `md` up. */
function cellRules(k: number, n: number): string {
  const rows = Math.ceil(n / 2);
  return cn(
    k % 2 === 0 && k < n - 1 && 'border-r',
    Math.floor(k / 2) < rows - 1 && 'border-b',
    'md:border-b-0',
    k < n - 1 ? 'md:border-r' : 'md:border-r-0',
  );
}

function FigureCell({ figure }: { figure: Figure }) {
  const count = useCount();
  const body = (
    <>
      <dt className="order-2 text-meta text-muted-foreground">{figure.label}</dt>
      <dd className="order-1 text-2xl leading-tight font-bold tabular-nums">
        {figure.value === undefined ? (
          <span className="inline-block h-6 w-12 animate-pulse rounded bg-layer-2 align-middle motion-reduce:animate-none" aria-hidden="true" />
        ) : figure.value === null ? (
          '—'
        ) : (
          count(figure.value)
        )}
      </dd>
      {figure.note !== null && <dd className="order-3 text-xs text-faint">{figure.note}</dd>}
    </>
  );
  const cell = 'flex h-full flex-col gap-0.5 px-4 py-3.5';
  return figure.to === null ? (
    <div className={cell} data-figure={figure.key}>
      {body}
    </div>
  ) : (
    <Link
      to={figure.to}
      className={cn(cell, 'outline-none hover:bg-layer focus-visible:bg-layer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset')}
      data-figure={figure.key}>
      {body}
    </Link>
  );
}

/** The strip of today's numbers (see the top of this file). */
export function TodayStrip() {
  const t = useT();
  const me = useMe();
  const count = useCount();
  const weekday = useWeekday();
  const { desk, query } = useDeskToday();
  const readsMembers = holds(me, 'members.records.read');
  const library = useLibraryToday();

  const figures: Figure[] = [];
  if (desk.branchId !== null) {
    const d = query.data;
    const value = (n: number | undefined): number | null | undefined => (d === undefined ? (query.isError ? null : undefined) : n);
    figures.push(
      {
        key: 'loaned',
        label: t('dashboard.today.loaned'),
        value: value(d?.loaned),
        note: d === undefined ? null : t('dashboard.home.week_ago', { day: weekday(d.weekAgo), n: count(d.loanedWeekAgo) }),
        to: '/admin/layanan',
      },
      {
        key: 'returned',
        label: t('dashboard.today.returned'),
        value: value(d?.returned),
        note: d === undefined ? null : t('dashboard.home.week_ago', { day: weekday(d.weekAgo), n: count(d.returnedWeekAgo) }),
        to: '/admin/layanan/kembali',
      },
      {
        key: 'overdue',
        label: t('dashboard.today.overdue'),
        value: value(d?.overdue),
        note: d === undefined ? null : t('dashboard.home.overdue_members', { n: count(d.overdueMembers) }),
        to: holds(me, 'circulation.records.read') ? '/admin/layanan/terlambat' : null,
      },
    );
  }
  if (readsMembers) {
    const m = library.data?.members;
    figures.push({
      key: 'active_members',
      label: t('dashboard.home.active_members'),
      value: m === undefined ? (library.isError ? null : undefined) : m === null ? null : m.active,
      note: m === undefined || m === null ? null : t('dashboard.home.joined_month', { n: count(m.joinedThisMonth) }),
      to: '/admin/anggota',
    });
  }
  if (figures.length === 0) return null;
  const n = figures.length;
  // A labelled region, not a heading: the blocks below are the page's sections.
  return (
    <section aria-label={t('dashboard.home.figures')} data-dashboard-today="">
      <dl className={cn('grid overflow-hidden rounded-lg border bg-card', n === 1 ? 'grid-cols-1' : 'grid-cols-2', MD_COLS[n])}>
        {figures.map((f, k) => (
          <div key={f.key} className={cn('min-w-0', cellRules(k, n))}>
            <FigureCell figure={f} />
          </div>
        ))}
      </dl>
    </section>
  );
}
