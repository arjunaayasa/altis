import { DASHBOARD_USAGE_DAYS, type SubjectLoans, type TopTitle } from '@altis/shared/api/dashboard-home';
import { Link } from '@tanstack/react-router';
import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { useMe } from '@/lib/me';
import { useCount, useLibraryToday } from '@/screens/dashboard-today';

/**
 * The loans of the last 30 days on Beranda, for a holder of `reports.statistics.read` (`GET dashboard/library`'s
 * `usage`), every branch, voided loans not counted:
 *
 * - "Peminjaman per subjek": one bar per DDC main class with a loan (the class the loan kept when it was lent), named
 *   with its number and its name, most first, in one colour (the theme's `--series-1`); the same figures as a table;
 * - "Judul paling sering dipinjam": the five most borrowed titles, numbered, each with its count; never a borrower. A
 *   title links to its record for a catalogue reader.
 *
 * Each block links to its full report (the loans by class, the most borrowed titles), which the same permission opens.
 * While the first read is under way both blocks show their shape; when it fails, both say so and offer "Coba lagi".
 */

/** The name of a DDC main class with its number (`800 Kesusastraan`), `NON` by its name only. */
function subjectName(t: Translate, s: SubjectLoans): string {
  const name = t(`vocab.ddc_main.${s.main}`);
  return s.main === 'NON' ? name : `${s.main} ${name}`;
}

/** A titled block of the usage row. */
function Block({ title, aside, children, data }: { title: string; aside: ReactNode; children: ReactNode; data: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3" data-usage={data}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={id} className="text-base font-bold">
          {title}
        </h2>
        <span className="flex flex-wrap items-baseline gap-x-3 text-meta text-muted-foreground">{aside}</span>
      </div>
      {children}
    </section>
  );
}

function ReportLink({ id }: { id: string }) {
  const t = useT();
  return (
    <Link to={`/admin/reports/${encodeURIComponent(id)}`} className="font-semibold text-accent-text underline-offset-4 hover:underline">
      {t('dashboard.home.report')}
    </Link>
  );
}

/** In place of a block's figures: its shape while they load, or that they could not be read with "Coba lagi". */
function Placeholder({ retry, announce }: { retry: (() => void) | null; announce: boolean }) {
  const t = useT();
  if (retry === null) return <div className="h-[180px] animate-pulse rounded-lg bg-layer-2 motion-reduce:animate-none" aria-hidden="true" />;
  return (
    <div role={announce ? 'alert' : undefined} className="flex flex-col items-start gap-2 rounded-md border border-bad-line bg-bad-bg px-3.5 py-3 text-sm">
      <span className="font-bold text-bad">{t('dashboard.home.load_failed')}</span>
      <Button variant="outline" size="sm" onClick={retry}>
        {t('table.retry')}
      </Button>
    </div>
  );
}

function Subjects({ subjects, placeholder }: { subjects: readonly SubjectLoans[]; placeholder?: ReactNode }) {
  const t = useT();
  const count = useCount();
  const range = t('dashboard.home.subjects.range', { days: DASHBOARD_USAGE_DAYS });
  const max = Math.max(1, ...subjects.map((s) => s.loans));
  return (
    <Block
      title={t('dashboard.home.subjects.title')}
      data="subjects"
      aside={
        <>
          <span>{range}</span>
          <ReportLink id="circulation.loans_by_class" />
        </>
      }>
      {placeholder !== undefined ? (
        placeholder
      ) : subjects.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('dashboard.home.subjects.empty', { days: DASHBOARD_USAGE_DAYS })}</p>
      ) : (
        <>
          <ul className="flex flex-col" aria-label={t('dashboard.home.subjects.caption', { days: DASHBOARD_USAGE_DAYS })}>
            {subjects.map((s) => (
              <li key={s.main} className="grid grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_2.5rem] items-center gap-2.5 py-[5px] text-meta xl:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)_2.5rem]" data-subject={s.main}>
                <span className="truncate text-muted-foreground" title={subjectName(t, s)}>
                  {subjectName(t, s)}
                </span>
                <span className="h-2.5" aria-hidden="true">
                  <span className="block h-full rounded-r-[3px] bg-series-1" style={{ width: `${(s.loans / max) * 100}%` }} />
                </span>
                <span className="text-right tabular-nums">{count(s.loans)}</span>
              </li>
            ))}
          </ul>
          <details className="text-sm">
            <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">{t('dashboard.home.table.show')}</summary>
            <div className="mt-2 overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse tabular-nums">
                <caption className="sr-only">{t('dashboard.home.subjects.caption', { days: DASHBOARD_USAGE_DAYS })}</caption>
                <thead>
                  <tr className="bg-layer text-xs text-muted-foreground">
                    <th scope="col" className="border-b px-3 py-2 text-left font-semibold">
                      {t('dashboard.home.subjects.class')}
                    </th>
                    <th scope="col" className="border-b px-3 py-2 text-right font-semibold">
                      {t('dashboard.home.subjects.loans')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {subjects.map((s) => (
                    <tr key={s.main} className="border-b last:border-b-0">
                      <th scope="row" className="px-3 py-1.5 text-left font-normal">
                        {subjectName(t, s)}
                      </th>
                      <td className="px-3 py-1.5 text-right">{count(s.loans)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Block>
  );
}

function TopTitles({ titles, placeholder }: { titles: readonly TopTitle[]; placeholder?: ReactNode }) {
  const t = useT();
  const me = useMe();
  const count = useCount();
  const readsCatalog = holds(me, 'catalog.records.read');
  return (
    <Block
      title={t('dashboard.home.top.title')}
      data="top"
      aside={
        <>
          <span>{t('dashboard.home.subjects.range', { days: DASHBOARD_USAGE_DAYS })}</span>
          <ReportLink id="circulation.top_titles" />
        </>
      }>
      {placeholder !== undefined ? (
        placeholder
      ) : titles.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('dashboard.home.top.empty', { days: DASHBOARD_USAGE_DAYS })}</p>
      ) : (
        <ol className="border-t">
          {titles.map((title, k) => (
            <li key={title.recordId} className="flex items-baseline gap-3 border-b py-2.5" data-top-title="">
              <span className="w-5 shrink-0 text-right font-bold text-faint tabular-nums">{count(k + 1)}</span>
              <span className="min-w-0 flex-1 font-semibold break-words">
                {readsCatalog ? (
                  <Link to={`/admin/catalog/records/${encodeURIComponent(title.recordId)}`} className="text-foreground underline-offset-4 hover:text-accent-text hover:underline">
                    {title.title}
                  </Link>
                ) : (
                  title.title
                )}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                <span aria-hidden="true">{count(title.loans)}×</span>
                <span className="sr-only">{t('dashboard.home.top.count', { n: count(title.loans) })}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Block>
  );
}

const ROW = 'grid gap-8 min-[1060px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]';

/** The loans by subject and the most borrowed titles, side by side (see the top of this file); nothing without them. */
export function UsageBlocks() {
  const me = useMe();
  const library = useLibraryToday();
  if (library.data === undefined) {
    if (!holds(me, 'reports.statistics.read')) return null;
    const retry = library.isError ? () => void library.refetch() : null;
    return (
      <div className={ROW}>
        <Subjects subjects={[]} placeholder={<Placeholder retry={retry} announce />} />
        <TopTitles titles={[]} placeholder={<Placeholder retry={retry} announce={false} />} />
      </div>
    );
  }
  const usage = library.data.usage;
  if (usage === null) return null;
  return (
    <div className={ROW}>
      <Subjects subjects={usage.bySubject} />
      <TopTitles titles={usage.topTitles} />
    </div>
  );
}
