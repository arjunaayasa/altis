import type { CollectionStatistics, LoanStatistics, MemberStatistics, VisitStatistics } from '@altis/shared/api/library-statistics';
import type { VisitSummary } from '@altis/shared/api/visits';
import { Link } from '@tanstack/react-router';
import { useId, type ReactNode } from 'react';
import { BarChart } from '@/components/bar-chart';
import { useLocale, useT } from '@/i18n';
import { holds } from '@/lib/access';
import { useApiQuery, useMe } from '@/lib/me';

/**
 * Statistik perpustakaan on Beranda: the library's figures at a glance, one card per module the user reads, each from
 * that module's own endpoint (`GET catalog/statistics`, `members/statistics`, `visits/statistics`,
 * `circulation/statistics`; @altis/shared/api/library-statistics), so a staff member sees the figures of the modules
 * they hold the read permission of and no other:
 *
 * - Koleksi (`catalog.records.read`): titles and copies in the stock today, copies received this year;
 * - Anggota (`members.records.read`): members on the register, valid today, joined this year;
 * - Kunjungan (`visits.records.read`): people today (the whole library, `GET visits/summary`), this month and this year,
 *   with a compact chart of the year's months;
 * - Peminjaman (`circulation.records.read`): loans this month and this year (with the chart), open and overdue loans.
 *
 * Each card links to the screen holding the rows; the section links to the reports for a holder of the statistics
 * reports. A user who reads none of the four sees nothing. The figures are counts only (no person in them), read in the
 * background and kept five minutes (today's visits every minute, like the other figures of today). The section is one
 * of Beranda's sections (a heading of level 2), its cards headed one level below.
 */

const STALE_MS = 5 * 60_000;

/** One figure of a card. */
function Figure({ label, value, tone }: { label: string; value: number | undefined; tone?: 'warning' }) {
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`text-xl font-semibold tabular-nums ${tone === 'warning' && value !== undefined && value > 0 ? 'text-destructive' : ''}`}>
        {value === undefined ? '—' : number.format(value)}
      </dd>
    </div>
  );
}

/** A module's card: its figures, an optional chart, and the link to its screen. */
function StatCard({ title, to, linkLabel, children, chart }: { title: string; to: string; linkLabel: string; children: ReactNode; chart?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-lg border bg-card p-4" data-library-card="">
      <h3 id={id} className="text-sm font-bold">
        {title}
      </h3>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">{children}</dl>
      {chart}
      <Link to={to} className="mt-auto self-start text-sm text-primary underline-offset-4 hover:underline">
        {linkLabel}
      </Link>
    </section>
  );
}

/** The chart of a year's months. */
function MonthsChart({ title, byMonth }: { title: string; byMonth: readonly number[] | undefined }) {
  const t = useT();
  const locale = useLocale();
  if (byMonth === undefined) return null;
  const tag = locale === 'en' ? 'en-GB' : 'id-ID';
  const month = new Intl.DateTimeFormat(tag, { month: 'short', timeZone: 'UTC' });
  const number = new Intl.NumberFormat(tag);
  const bars = byMonth.map((value, k) => ({ label: month.format(Date.UTC(2000, k, 1)), value }));
  const max = Math.max(0, ...byMonth);
  return (
    <BarChart
      title={title}
      description={t('dashboard.library.chart_desc', { max: number.format(max) })}
      bars={bars}
      format={(v) => number.format(v)}
    />
  );
}

/** The library's statistics (see the top of this file). */
export function LibraryStatistics() {
  const t = useT();
  const me = useMe();
  const reads = {
    catalog: holds(me, 'catalog.records.read'),
    members: holds(me, 'members.records.read'),
    visits: holds(me, 'visits.records.read'),
    loans: holds(me, 'circulation.records.read'),
  };
  const options = (key: string, path: string, enabled: boolean) => ({ queryKey: ['dashboard', 'library', key], path, enabled, request: { background: true }, staleTime: STALE_MS });
  const collection = useApiQuery<CollectionStatistics>(options('catalog', 'catalog/statistics', reads.catalog));
  const members = useApiQuery<MemberStatistics>(options('members', 'members/statistics', reads.members));
  const visits = useApiQuery<VisitStatistics>(options('visits', 'visits/statistics', reads.visits));
  const loans = useApiQuery<LoanStatistics>(options('loans', 'circulation/statistics', reads.loans));
  const visitsToday = useApiQuery<VisitSummary>({
    queryKey: ['dashboard', 'library', 'visits-today'],
    path: 'visits/summary',
    enabled: reads.visits,
    request: { background: true },
    refetchInterval: 60_000,
  });
  const headingId = useId();
  if (!reads.catalog && !reads.members && !reads.visits && !reads.loans) return null;
  const year = collection.data?.year ?? members.data?.year ?? visits.data?.year ?? loans.data?.year;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3" data-library-statistics="">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-base font-bold">
          {t('dashboard.library.title')}
        </h2>
        {holds(me, 'reports.statistics.read') && (
          <Link to="/admin/reports" className="text-sm text-primary underline-offset-4 hover:underline">
            {t('dashboard.library.reports')}
          </Link>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {reads.catalog && (
          <StatCard title={t('dashboard.library.collection')} to="/admin/catalog/records" linkLabel={t('dashboard.library.collection_open')}>
            <Figure label={t('dashboard.library.titles')} value={collection.data?.titles} />
            <Figure label={t('dashboard.library.items')} value={collection.data?.items} />
            <Figure label={t('dashboard.library.received', { year: year ?? '' })} value={collection.data?.receivedThisYear} />
          </StatCard>
        )}
        {reads.members && (
          <StatCard title={t('dashboard.library.members')} to="/admin/anggota" linkLabel={t('dashboard.library.members_open')}>
            <Figure label={t('dashboard.library.registered')} value={members.data?.registered} />
            <Figure label={t('dashboard.library.valid')} value={members.data?.valid} />
            <Figure label={t('dashboard.library.joined', { year: year ?? '' })} value={members.data?.joinedThisYear} />
          </StatCard>
        )}
        {reads.visits && (
          <StatCard
            title={t('dashboard.library.visits')}
            to="/admin/layanan/kunjungan"
            linkLabel={t('dashboard.library.visits_open')}
            chart={<MonthsChart title={t('dashboard.library.visits_chart', { year: year ?? '' })} byMonth={visits.data?.byMonth} />}>
            <Figure label={t('dashboard.today.visits')} value={visitsToday.data?.total} />
            <Figure label={t('dashboard.library.this_month')} value={visits.data?.thisMonth} />
            <Figure label={t('dashboard.library.this_year', { year: year ?? '' })} value={visits.data?.thisYear} />
          </StatCard>
        )}
        {reads.loans && (
          <StatCard
            title={t('dashboard.library.loans')}
            to="/admin/layanan/terlambat"
            linkLabel={t('dashboard.library.loans_open')}
            chart={<MonthsChart title={t('dashboard.library.loans_chart', { year: year ?? '' })} byMonth={loans.data?.byMonth} />}>
            <Figure label={t('dashboard.library.this_month')} value={loans.data?.thisMonth} />
            <Figure label={t('dashboard.library.this_year', { year: year ?? '' })} value={loans.data?.thisYear} />
            <Figure label={t('dashboard.library.open')} value={loans.data?.open} />
            <Figure label={t('dashboard.library.overdue')} value={loans.data?.overdue} tone="warning" />
          </StatCard>
        )}
      </div>
    </section>
  );
}
