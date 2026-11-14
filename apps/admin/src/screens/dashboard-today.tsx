import type { CirculationDaySummary } from '@altis/shared/api/circulation-summary';
import type { VisitSummary } from '@altis/shared/api/visits';
import { Link } from '@tanstack/react-router';
import { useLocale, useT } from '@/i18n';
import { holds } from '@/lib/access';
import { useApiQuery, useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { useDeskBranch } from '@/screens/circulation/common';

/**
 * The numbers of today on Beranda, above the system dashboard: a strip of figures separated by thin rules, each one a
 * link to the screen that holds its rows.
 *
 * - At the desk's branch (the branch the desk keeps in this browser), for a holder of `circulation.desk.use` there:
 *   lent today, returned today, overdue loans, holds ready for pickup (`GET branches/:branchId/circulation/summary`).
 * - For a holder of `visits.records.read`: the people who visited today (`GET visits/summary`, at the same branch when
 *   there is one, else the whole library).
 *
 * A user who holds neither sees no strip. Read every minute in the background while the page is open, like the
 * dashboard.
 */

const REFRESH_MS = 60_000;

interface Figure {
  key: string;
  label: string;
  value: number | null;
  to: string;
  tone?: 'warning';
}

function FigureStrip({ figures, caption }: { figures: Figure[]; caption: string | null }) {
  const t = useT();
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  // A labelled region with a plain caption, not a heading: the dashboard's cards below are the page's sections.
  return (
    <section aria-label={t('dashboard.today.title')} className="flex flex-col gap-2" data-dashboard-today="">
      <p className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-base font-semibold">{t('dashboard.today.title')}</span>
        {caption !== null && <span className="text-sm text-muted-foreground">{caption}</span>}
      </p>
      <dl className="grid grid-cols-2 divide-x divide-y rounded-lg border bg-card sm:flex sm:divide-y-0">
        {figures.map((f) => (
          <div key={f.key} className="flex flex-1 flex-col">
            <Link to={f.to} className="flex flex-1 flex-col gap-1 p-4 hover:bg-muted/50 focus-visible:bg-muted/50" data-figure={f.key}>
              <dt className="text-sm text-muted-foreground">{f.label}</dt>
              <dd className={cn('text-2xl font-semibold tabular-nums', f.tone === 'warning' && f.value !== null && f.value > 0 && 'text-destructive')}>
                {f.value === null ? '—' : number.format(f.value)}
              </dd>
            </Link>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Today's numbers (see the top of this file). */
export function TodayStrip() {
  const t = useT();
  const me = useMe();
  const desk = useDeskBranch();
  const branchId = desk.branchId;
  const readsVisits = holds(me, 'visits.records.read');
  const circulation = useApiQuery<CirculationDaySummary>({
    queryKey: ['dashboard', 'today', 'circulation', branchId],
    path: `branches/${branchId ?? ''}/circulation/summary`,
    enabled: branchId !== null,
    request: { background: true },
    refetchInterval: REFRESH_MS,
  });
  const visits = useApiQuery<VisitSummary>({
    queryKey: ['dashboard', 'today', 'visits', branchId],
    path: branchId === null ? 'visits/summary' : `visits/summary?branchId=${encodeURIComponent(branchId)}`,
    // Once the desk branch is known (or the branch list failed), so the visits are read once, for the right branch.
    enabled: readsVisits && (desk.branches !== undefined || Boolean(desk.error)),
    request: { background: true },
    refetchInterval: REFRESH_MS,
  });

  const figures: Figure[] = [];
  if (branchId !== null) {
    const c = circulation.data;
    figures.push(
      { key: 'loaned', label: t('dashboard.today.loaned'), value: c?.loaned ?? null, to: '/admin/layanan' },
      { key: 'returned', label: t('dashboard.today.returned'), value: c?.returned ?? null, to: '/admin/layanan/kembali' },
      { key: 'overdue', label: t('dashboard.today.overdue'), value: c?.overdue ?? null, to: '/admin/layanan/terlambat', tone: 'warning' },
      { key: 'holds_ready', label: t('dashboard.today.holds_ready'), value: c?.holdsReady ?? null, to: '/admin/layanan/rak-tunggu' },
    );
  }
  if (readsVisits) figures.push({ key: 'visits', label: t('dashboard.today.visits'), value: visits.data?.total ?? null, to: '/admin/layanan/kunjungan' });
  if (figures.length === 0) return null;
  const branch = desk.branches?.find((b) => b.id === branchId);
  return <FigureStrip figures={figures} caption={branch === undefined ? null : t('dashboard.today.branch', { name: branch.name })} />;
}
