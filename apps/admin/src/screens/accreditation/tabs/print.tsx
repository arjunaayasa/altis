import type { DossierBody, EvidenceListResponse } from '@altis/shared/api/accreditation';
import type { ReportRunCreateBody, ReportRunListResponse, ReportRunStarted, ReportRunView } from '@altis/shared/api/reports';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type JSX, type ReactNode } from 'react';
import { ComponentSizes } from '@/components/accreditation/print/component-sizes';
import { RunCard, StartedRunCard } from '@/components/accreditation/print/run-card';
import { accredKeys, accredPaths, useInstruments, usePeriod } from '@/components/accreditation/usage/queries';
import { Notice, RefetchProblem } from '@/components/form-field';
import { Callout, LoadingState, TABLE, Tag } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT, type TKey } from '@/i18n';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import { cn } from '@/lib/utils';
import { useRetryKey } from '@/screens/catalog/exchange/summary-view';
import { confirmReauth } from '@/screens/reports/run-history';

/**
 * The workspace tab Cetak (spec §6, §10.9). Every file is a report run, always in Indonesian:
 *
 * - **Simulasi penilaian mandiri** (`POST …/self-assessment`): internal, with scores; its card carries the header the
 *   file prints ("SIMULASI INTERNAL — bukan untuk diunggah"). Only for a scored instrument.
 * - **Berkas bukti** (`POST …/dossier`): the PDF, one ZIP, or one ZIP per component (a scored instrument), and the
 *   request letter template alone (`part: 'request_letter'`), with the running size of each component's evidence
 *   against the upload limit per component.
 * - **Surat pernyataan 1.000 judul** (`POST …/statement-1000`): it names no one, so it needs no password.
 * - **Lampiran CSV/XLSX**: each statistical annex through `POST reports/runs`; the staff annex holds names, so it goes
 *   through `POST reports/runs/personal`.
 *
 * The simulation, the evidence file and the staff annex hold staff names: they are started only right after a password
 * confirmation (the reauth dialog), and so are their downloads. Below, the runs the user made for this period (newest
 * first, plus the ones started on this page): each with its job's progress, its warnings as sentences and its download.
 */

const enc = encodeURIComponent;

/** The ten annexes, in the order of the evidence file's statistics. */
const ANNEXES = Object.freeze([
  'accreditation.annex.ddc',
  'accreditation.annex.collection_matrix',
  'accreditation.annex.additions',
  'accreditation.annex.l14',
  'accreditation.annex.usage_monthly',
  'accreditation.annex.staff',
  'accreditation.annex.budgets',
  'accreditation.annex.activities',
  'accreditation.annex.partnerships',
  'accreditation.annex.documents',
] as const);

type AnnexId = (typeof ANNEXES)[number];

/** The annexes holding personal data (the personal run route, after a password confirmation). */
const PERSONAL_ANNEXES: ReadonlySet<AnnexId> = new Set(['accreditation.annex.staff']);

/** Every definition this tab makes: the runs of the period it lists. */
const TAB_REPORTS: ReadonlySet<string> = new Set([
  ...ANNEXES,
  'accreditation.dossier',
  'accreditation.self_assessment',
  'accreditation.statement_1000',
]);

/** The user's own runs, newest first: the tab lists those of its period. */
const RUNS_KEY = ['reports', 'runs', 'list', 'accreditation'] as const;
const RUNS_PATH = 'reports/runs?limit=50';

interface Start {
  /** Which button started it (its failure is shown in its card). */
  action: string;
  personal: boolean;
  path: string;
  body: unknown;
}

/** A part of the tab: a titled region, a thin rule above all but the first. */
function Card({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="grid min-w-0 gap-3 border-t pt-5 first:border-t-0 first:pt-0">
      <h3 id={titleId} className="text-heading font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function PrintTab({ periodId }: { periodId: string }): JSX.Element {
  const t = useT();
  const titleId = useId();
  const queryClient = useQueryClient();
  const retryKey = useRetryKey('accreditation-print');
  const period = usePeriod(periodId);
  const instruments = useInstruments();
  const evidence = useApiQuery<EvidenceListResponse>({ queryKey: accredKeys.evidence(periodId), path: accredPaths.evidence(periodId) });
  const runs = useApiQuery<ReportRunListResponse>({ queryKey: RUNS_KEY, path: RUNS_PATH });
  /** The runs started on this page, newest first. */
  const [started, setStarted] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ action: string; text: string } | null>(null);

  const begin = async (start: Start): Promise<void> => {
    if (busy !== null) return;
    setFailure(null);
    setBusy(start.action);
    try {
      if (start.personal && !(await confirmReauth(queryClient))) {
        setFailure({ action: start.action, text: t('accreditation.print.reauth_cancelled') });
        return;
      }
      const keyed = { path: start.path, body: start.body };
      const run = await api<ReportRunStarted>('POST', start.path, start.body, { idempotencyKey: retryKey.key(keyed) });
      retryKey.clear();
      setStarted((current) => [run.id, ...current.filter((id) => id !== run.id)]);
      void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    } catch (e) {
      setFailure({ action: start.action, text: problemText(t, e) });
    } finally {
      setBusy(null);
    }
  };

  const failed = (prefix: string) =>
    failure !== null && failure.action.startsWith(prefix) ? <Notice kind="error">{failure.text}</Notice> : null;

  const documentStart = (action: string, document: 'dossier' | 'self-assessment' | 'statement-1000', body: unknown, personal: boolean): Start => ({
    action,
    personal,
    path: `accreditation/periods/${enc(periodId)}/${document}`,
    body,
  });

  const dossier = (action: string, body: DossierBody): Start => documentStart(`dossier:${action}`, 'dossier', body, true);

  const action = (label: TKey, start: Start, o: { variant?: 'default' | 'outline' } = {}) => (
    <Button type="button" variant={o.variant ?? 'outline'} disabled={busy !== null} onClick={() => void begin(start)}>
      {t(label)}
    </Button>
  );

  let body: JSX.Element;
  if (period.data === undefined || (instruments.data === undefined && !instruments.isError)) {
    body = period.isError ? <Notice kind="error">{problemText(t, period.error)}</Notice> : <LoadingState />;
  } else {
    const instrument = instruments.data?.instruments.find((i) => i.id === period.data.instrumentId);
    const scored = instrument?.scored ?? true;
    const limitMb = instruments.data?.config.componentLimitMb ?? null;
    const listed: ReportRunView[] = (runs.data?.runs ?? []).filter((r) => TAB_REPORTS.has(r.reportId) && r.params?.['periodId'] === periodId);
    const listedIds = new Set(listed.map((r) => r.id));
    const fresh = started.filter((id) => !listedIds.has(id));

    body = (
      <div className="grid max-w-5xl gap-5">
        {scored && (
          <Card title={t('report.accreditation.self_assessment.title')}>
            <Callout tone="warn" title={t('accred.simulation.header')} />
            <p className="text-sm text-muted-foreground">{t('accreditation.print.simulation.intro')}</p>
            <div className="flex flex-wrap gap-2">
              {action('accreditation.print.simulation.make', documentStart('simulation', 'self-assessment', {}, true))}
            </div>
            {failed('simulation')}
          </Card>
        )}

        <Card title={t('report.accreditation.dossier.title')}>
          <p className="text-sm text-muted-foreground">{t('accreditation.print.dossier.intro')}</p>
          <div className="flex flex-wrap gap-2">
            {action('accreditation.print.dossier.pdf', dossier('pdf', { format: 'pdf' }), { variant: 'default' })}
            {action('accreditation.print.dossier.zip', dossier('zip', { format: 'zip' }))}
            {scored && action('accreditation.print.dossier.zip_components', dossier('zip_components', { format: 'zip_components' }))}
          </div>
          {scored && <p className="text-xs text-muted-foreground">{t('accreditation.print.dossier.zip_hint')}</p>}
          {scored && (
            <div className="grid gap-1">
              <div className="flex flex-wrap gap-2">
                {action('accreditation.print.request_letter', dossier('request_letter', { format: 'pdf', part: 'request_letter' }))}
              </div>
              <p className="text-xs text-muted-foreground">{t('accreditation.print.request_letter_hint')}</p>
            </div>
          )}
          {failed('dossier')}
          <RefetchProblem query={evidence} />
          {evidence.data !== undefined && limitMb !== null && <ComponentSizes bytes={evidence.data.componentBytes} limitMb={limitMb} />}
          {evidence.data === undefined && evidence.isError && <Notice kind="error">{problemText(t, evidence.error)}</Notice>}
        </Card>

        <Card title={t('report.accreditation.statement_1000.title')}>
          <p className="text-sm text-muted-foreground">{t('accreditation.print.statement.intro')}</p>
          <div className="flex flex-wrap gap-2">
            {action('accreditation.print.statement.make', documentStart('statement', 'statement-1000', {}, false))}
          </div>
          {failed('statement')}
        </Card>

        <Card title={t('accreditation.print.annexes.title')}>
          <p className="text-sm text-muted-foreground">{t('accreditation.print.annexes.intro')}</p>
          <div className={TABLE.wrap}>
            <table className={TABLE.table}>
              <caption className="sr-only">{t('accreditation.print.annexes.title')}</caption>
              <tbody>
                {ANNEXES.map((reportId) => {
                  const title = t(`report.${reportId}.title`);
                  const personal = PERSONAL_ANNEXES.has(reportId);
                  return (
                    <tr key={reportId} data-report-id={reportId}>
                      <th scope="row" className={cn(TABLE.td, 'text-left font-normal')}>
                        <span className="flex flex-wrap items-center gap-2">
                          {title}
                          {personal && <Tag tone="warn">{t('accreditation.print.annexes.personal')}</Tag>}
                        </span>
                      </th>
                      <td className={TABLE.td}>
                        <div className="flex flex-wrap justify-end gap-2">
                          {(['csv', 'xlsx'] as const).map((format) => {
                            const formatLabel = t(`vocab.report_format.${format}`);
                            const runBody: ReportRunCreateBody = { reportId, format, params: { periodId } };
                            return (
                              <Button
                                key={format}
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busy !== null}
                                aria-label={t('accreditation.print.annexes.make', { format: formatLabel, title })}
                                onClick={() =>
                                  void begin({ action: `annex:${reportId}:${format}`, personal, path: personal ? 'reports/runs/personal' : 'reports/runs', body: runBody })
                                }>
                                {formatLabel}
                              </Button>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {failed('annex')}
        </Card>

        <Card title={t('accreditation.print.runs.title')}>
          <p className="text-sm text-muted-foreground">{t('accreditation.print.runs.intro')}</p>
          <RefetchProblem query={runs} />
          {runs.data === undefined && runs.isError && <Notice kind="error">{problemText(t, runs.error)}</Notice>}
          {fresh.length === 0 && listed.length === 0 ? (
            runs.data !== undefined && <p className="text-sm text-muted-foreground">{t('accreditation.print.runs.empty')}</p>
          ) : (
            <ul className="grid border-t">
              {fresh.map((id) => (
                <StartedRunCard key={id} runId={id} limitMb={limitMb} evidence={evidence.data?.evidence} />
              ))}
              {listed.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  limitMb={limitMb}
                  evidence={evidence.data?.evidence}
                  onEnded={() => void queryClient.invalidateQueries({ queryKey: RUNS_KEY })}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>
    );
  }

  return (
    <section aria-labelledby={titleId} data-period-id={periodId} className="grid min-w-0 gap-5">
      <div className="grid max-w-[75ch] gap-1">
        <h2 id={titleId} className="text-heading font-semibold">
          {t('accreditation.print.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('accreditation.print.intro')}</p>
      </div>
      {body}
    </section>
  );
}
