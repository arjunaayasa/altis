import { isUlid, vocabKey } from '@altis/shared';
import type { RunView } from '@altis/shared/api/catalog/runs';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useDateTime } from '@/components/data-table';
import { Badge, ProblemAlert } from '@/components/form-field';
import { BackLink, FactList, LoadingState, PageError, PageHead, Section } from '@/components/layout';
import { JobProgress } from '@/components/job-progress';
import { useT } from '@/i18n';
import { ApiError } from '@/lib/api';
import { useApiQuery, useMe } from '@/lib/me';
import { OptionsList, RealRunAction, continuable, importOptionsOf } from './import-wizard';
import { RUNS_KEY, RUN_LINK, RunStatusBadge, SummaryView, formatLabel, isRunActive, runKey } from './summary-view';

/**
 * One catalog run (Phase 2 spec §13, §5.3, §5.4, §3.3; plan Task 29), `/admin/catalog/runs/$runId`: what it is (kind,
 * status, dry run, format, when), an import's options, the job's progress while the run has work ahead (driven from
 * the page where no worker runs), then the summary with the report and an export's file until it expires
 * (summary-view.tsx). A duplicate scan links to Duplikat, where its groups are compared and merged. A finished dry
 * import of the user, not yet taken and under 7 days old, offers "Jalankan impor" with its own options, as the wizard
 * does (C21), so a dry run left behind is never lost.
 *
 * `GET catalog/runs/:id` needs `catalog.records.read`; a migration run is 404 without `catalog.migration.run` (P2-27),
 * which this page shows as "not found" like any other missing run.
 */

const EXCHANGE_PATH = '/admin/catalog/exchange';

function Facts({ run }: { run: RunView }) {
  const t = useT();
  const dateTime = useDateTime();
  const format = formatLabel(t, run);
  const rows: [string, ReactNode][] = [
    [t('catalog.exchange.runs.col.kind'), t(vocabKey('run_kind', run.kind))],
    [t('catalog.exchange.runs.col.status'), <RunStatusBadge key="status" status={run.status} />],
  ];
  if (format !== null) rows.push([t('catalog.exchange.runs.col.format'), format]);
  rows.push([t('catalog.exchange.runs.col.created'), dateTime(run.createdAt)]);
  if (run.finishedAt !== null) rows.push([t('catalog.exchange.runs.col.finished'), dateTime(run.finishedAt)]);
  return <FactList className="max-w-xl" items={rows.map(([label, value]) => ({ key: label, label, value }))} />;
}

export function RunDetailScreen() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const { runId = '' } = useParams({ strict: false }) as { runId?: string };
  const valid = isUlid(runId);
  const run = useApiQuery<RunView>({ queryKey: runKey(runId), path: `catalog/runs/${encodeURIComponent(runId)}`, enabled: valid });
  const r = run.data;
  const notFound = !valid || (run.error instanceof ApiError && run.error.code === 'NOT_FOUND');
  const options = r !== undefined && r.kind === 'import' ? importOptionsOf(r.options) : null;
  const realRun = r === undefined ? null : continuable(r, me, Date.now());

  return (
    <div className="grid max-w-5xl gap-6">
      <BackLink to={EXCHANGE_PATH} search={{ tab: 'runs' }}>
        {t('catalog.exchange.run.back')}
      </BackLink>
      <PageHead title={t('catalog.exchange.run.title')} intro={r?.dryRun === true ? <Badge>{t('catalog.exchange.runs.dry_run')}</Badge> : undefined} />
      {notFound ? (
        <PageError title={t('catalog.exchange.run.not_found')} />
      ) : run.isError && r === undefined ? (
        <ProblemAlert error={run.error} />
      ) : r === undefined ? (
        <LoadingState />
      ) : (
        <>
          <section aria-label={t('catalog.exchange.run.facts')} className="grid gap-3">
            <Facts run={r} />
            {options !== null && <OptionsList options={options} />}
          </section>
          {isRunActive(r.status) && r.jobId !== null && (
            <section aria-label={t('catalog.exchange.run.progress')} className="grid gap-2">
              <JobProgress
                jobId={r.jobId}
                onDone={() => {
                  void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
                }}
              />
              <p className="text-sm text-muted-foreground">{t('catalog.exchange.leave_hint')}</p>
            </section>
          )}
          <Section title={t('catalog.exchange.summary.title')}>
            <SummaryView run={r} />
          </Section>
          {realRun !== null && <RealRunAction key={r.id} dryRunId={r.id} options={realRun} />}
          {r.kind === 'dedupe_scan' && (
            <Link to="/admin/catalog/duplicates" className={RUN_LINK}>
              {t('catalog.exchange.run.duplicates')}
            </Link>
          )}
        </>
      )}
    </div>
  );
}
