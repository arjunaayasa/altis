import type { NoteRef, ResultsView, SnpOutcome } from '@altis/shared/api/accreditation';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, type JSX } from 'react';
import { accredKeys, accredPaths } from '@/components/accreditation/usage/queries';
import { useDateTime } from '@/components/data-table';
import { Notice, NoticeAlert, RefetchProblem } from '@/components/form-field';
import { ErrorState, SkeletonTable, TABLE, Tag, type TagTone } from '@/components/layout';
import { useLocale, useT, type Translate } from '@/i18n';
import { isMessageKey } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';

/**
 * The workspace tab Kepatuhan SNP (spec §6, §10.9 item 8): the standards of the school library standard that ALTIS
 * can compute, one row each with its outcome as a badge, the figure it was judged on, the rule as the standard words it
 * for the period's school level, and its notes. The tab never shows an instrument score. The rows come from the
 * period's results (`GET accreditation/periods/:id/results`), read again when the evaluation says they changed.
 */

const OUTCOME_TONE: Readonly<Record<SnpOutcome, TagTone>> = {
  pass: 'ok',
  fail: 'bad',
  reported: 'neutral',
  not_evaluated: 'warn',
  not_available: 'neutral',
};

/** A message key's text, or the value itself when it is not a known key. */
function keyText(t: Translate, key: string, params?: NoteRef['params']): string {
  return isMessageKey(key) ? t(key, params) : key;
}

export function SnpTab({ periodId }: { periodId: string }): JSX.Element {
  const t = useT();
  const locale = useLocale();
  const dateTime = useDateTime();
  const titleId = useId();
  const queryClient = useQueryClient();
  const number = useMemo(() => new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID'), [locale]);
  const query = useApiQuery<ResultsView>({ queryKey: accredKeys.results(periodId), path: accredPaths.results(periodId) });

  useRealtime(['accreditation'], (e) => {
    const payload = e.payload as { periodId?: unknown } | null;
    if (e.type === 'accreditation.results.changed' && payload?.periodId === periodId) {
      void queryClient.invalidateQueries({ queryKey: accredKeys.results(periodId) });
    }
  });

  const results = query.data;
  let body: JSX.Element;
  if (results === undefined) {
    body = query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : <SkeletonTable label={t('shell.loading')} rows={4} />;
  } else {
    const working = results.status === 'queued' || results.status === 'running';
    body = (
      <div className="grid gap-3">
        <RefetchProblem query={query} />
        {results.status === 'missing' && <p className="text-sm text-muted-foreground">{t('accreditation.snp.missing')}</p>}
        {working && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('accreditation.snp.computing')}
          </p>
        )}
        {results.status === 'failed' && <Notice kind="error">{t('accreditation.snp.failed')}</Notice>}
        {results.stale && results.status === 'ready' && <NoticeAlert>{t('accreditation.snp.stale')}</NoticeAlert>}
        {results.computedAt !== null && results.status !== 'missing' && (
          <p className="text-xs text-muted-foreground">{t('accreditation.snp.computed_at', { date: dateTime(results.computedAt) })}</p>
        )}
        {results.snp.length === 0
          ? results.status === 'ready' && <p className="text-sm text-muted-foreground">{t('accreditation.snp.none')}</p>
          : (
              <div className={TABLE.wrap}>
                <table className={TABLE.table}>
                  <caption className="sr-only">{t('accreditation.snp.title')}</caption>
                  <thead>
                    <tr>
                      {(['col_code', 'col_standard', 'col_outcome', 'col_value', 'col_rule', 'col_notes'] as const).map((col) => (
                        <th key={col} scope="col" className={cn(TABLE.th, 'align-bottom', col === 'col_value' && 'text-right')}>
                          {t(`accreditation.snp.${col}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {results.snp.map((row) => (
                      <tr key={row.code} data-snp={row.code}>
                        <td className={cn(TABLE.td, 'whitespace-nowrap text-muted-foreground')}>{row.code.replace(/^SNP-/, '')}</td>
                        <th scope="row" className={cn(TABLE.td, 'min-w-48 text-left font-semibold')}>
                          {keyText(t, row.labelKey)}
                        </th>
                        <td className={TABLE.td}>
                          <Tag tone={OUTCOME_TONE[row.outcome]}>{t(`accreditation.snp.outcome.${row.outcome}`)}</Tag>
                        </td>
                        <td className={cn(TABLE.td, 'text-right')}>{row.value === null ? '—' : number.format(row.value)}</td>
                        <td className={cn(TABLE.td, 'min-w-48')}>{keyText(t, row.rule)}</td>
                        <td className={cn(TABLE.td, 'min-w-48')}>
                          <div className="grid gap-1">
                            {row.notes.map((note, i) => (
                              <p key={`${note.key}-${i}`} className="text-xs text-muted-foreground">
                                {keyText(t, note.key, note.params)}
                              </p>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </div>
    );
  }

  return (
    <section aria-labelledby={titleId} data-period-id={periodId} className="grid min-w-0 gap-4">
      <div className="grid max-w-[75ch] gap-1">
        <h2 id={titleId} className="text-base font-bold">
          {t('accreditation.snp.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('accred.note.snp_selected')}</p>
      </div>
      {body}
    </section>
  );
}
