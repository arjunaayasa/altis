import type { IndicatorResultView, IndicatorView, InstrumentView } from '@altis/shared/api/accreditation';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, type JSX } from 'react';
import { AnswerPicker } from '@/components/accreditation/answer-picker';
import { EvidenceChecklist } from '@/components/accreditation/evidence-checklist';
import { ProblemAlert } from '@/components/form-field';
import { LoadingState, TABLE } from '@/components/layout';
import { useT, type TKey, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { accreditationKeys, keyText, noteParams, officialLabel, useFormats, useResults, type Formats } from '../data';
import { ReadOnlyNote, TabState, type TabContext } from '../tab-state';

/**
 * Indikator (spec §6 "Akreditasi", §10.3, §10.6): the instrument's indicators under their components, each by the
 * decree's own number written with its component ("Pelayanan butir 7": a primary school instrument has no plagiarism
 * item, so its concept `SCH-L8` is the decree's service item 7). For each one:
 *
 * - the paraphrase, the time window, and, once computed, the value with its formula and numbers, its source and the
 *   data quality notes (with the figures behind a table-valued metric);
 * - ALTIS's suggestion, the stored answer and the final one, and the answer form (answer-picker.tsx: an own answer or
 *   one replacing the suggestion, which needs a note);
 * - the evidence checklist, with the ALTIS screen to capture and the upload for the items filled by a file;
 * - a link to the detail report with the parameters the metric used.
 *
 * Answers and uploads need `accreditation.workspace.manage` on an open period; a frozen period shows them read only.
 */
export function IndicatorsTab(props: { periodId: string }): JSX.Element {
  return <TabState periodId={props.periodId}>{(ctx) => <Indicators ctx={ctx} />}</TabState>;
}

function Indicators({ ctx }: { ctx: TabContext }) {
  const t = useT();
  const queryClient = useQueryClient();
  const periodId = ctx.period.id;
  const results = useResults(periodId);
  const instrument = ctx.instrument;
  if (instrument === undefined) return <p className="text-sm">{t('accreditation.instrument.unknown', { id: ctx.period.instrumentId })}</p>;
  if (instrument.components.length === 0) return <p className="text-sm">{t('accreditation.workspace.indicators.unscored')}</p>;
  if (results.data === undefined && !results.isError) return <LoadingState />;
  const byCode = new Map((results.data?.indicators ?? []).map((r) => [r.code, r]));
  const onUploaded = (): void => void queryClient.invalidateQueries({ queryKey: accreditationKeys.results(periodId) });
  return (
    <div className="grid max-w-5xl gap-8">
      <ReadOnlyNote ctx={ctx} />
      {results.isError && <ProblemAlert error={results.error} />}
      {results.data !== undefined && results.data.computedAt === null && <p className="text-sm">{t('accreditation.workspace.indicators.not_computed')}</p>}
      {instrument.components.map((component) => (
        <Component key={component.code} component={component}>
          {component.indicators.map((indicator) => (
            <IndicatorCard
              key={indicator.code}
              periodId={periodId}
              component={component.code}
              indicator={indicator}
              result={byCode.get(indicator.code)}
              canEdit={ctx.canEdit}
              onUploaded={onUploaded}
            />
          ))}
        </Component>
      ))}
    </div>
  );
}

function Component({ component, children }: { component: InstrumentView['components'][number]; children: JSX.Element[] }) {
  const t = useT();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="grid gap-3">
      <h3 id={titleId} className="text-heading font-semibold">
        {keyText(t, component.labelKey)}
      </h3>
      <div className="grid border-b">{children}</div>
    </section>
  );
}

/** The labels of the time windows of the indicators. */
const WINDOWS: Readonly<Record<string, TKey>> = {
  snapshot: 'accreditation.workspace.window.snapshot',
  current: 'accreditation.workspace.window.current',
  period: 'accreditation.workspace.window.period',
  three_periods: 'accreditation.workspace.window.three_periods',
  three_calendar_years: 'accreditation.workspace.window.three_calendar_years',
  budget_years: 'accreditation.workspace.window.budget_years',
  twelve_months: 'accreditation.workspace.window.twelve_months',
  three_years: 'accreditation.workspace.window.three_years',
  period_and_previous: 'accreditation.workspace.window.period_and_previous',
};

/** The labels of the sources of a value. */
const BASES: Readonly<Record<string, TKey>> = {
  live: 'accreditation.workspace.basis.live',
  migrated: 'accreditation.workspace.basis.migrated',
  imported: 'accreditation.workspace.basis.imported',
  manual: 'accreditation.workspace.basis.manual',
  register: 'accreditation.workspace.basis.register',
  setting: 'accreditation.workspace.basis.setting',
  members: 'accreditation.workspace.basis.members',
  none: 'accreditation.workspace.basis.none',
};

const label = (t: Translate, table: Readonly<Record<string, TKey>>, value: string): string => {
  const key = table[value];
  return key === undefined ? value : t(key);
};

/**
 * The computed value as it is shown: a percentage or a ratio with its numerator and denominator ("230 × 100 ÷ 1.000 =
 * 23 %"), else the value in its unit; "Tidak ada data" without one.
 */
export function valueText(t: Translate, f: Formats, r: Pick<IndicatorResultView, 'value' | 'numerator' | 'denominator' | 'unit'>): string {
  if (r.value === null) return t('accreditation.workspace.value.none');
  const value = f.number(r.value);
  if (r.numerator !== null && r.denominator !== null) {
    if (r.unit === 'percent') return t('accreditation.workspace.formula.percent', { num: f.number(r.numerator), den: f.number(r.denominator), value });
    if (r.unit === 'ratio') return t('accreditation.workspace.formula.ratio', { num: f.number(r.numerator), den: f.number(r.denominator), value });
  }
  switch (r.unit) {
    case 'percent':
      return t('accreditation.workspace.value.percent', { value });
    case 'years':
      return t('accreditation.workspace.value.years', { value });
    case 'mbps':
      return t('accreditation.workspace.value.mbps', { value });
    default:
      return value;
  }
}

/** The detail report a metric names, when the user may open it: collection reports need the statistics permission. */
function useCanOpen(reportId: string): boolean {
  const me = useMe();
  return reportId.startsWith('accreditation.') || holds(me, 'reports.statistics.read');
}

function IndicatorCard({
  periodId,
  component,
  indicator,
  result,
  canEdit,
  onUploaded,
}: {
  periodId: string;
  component: string;
  indicator: IndicatorView;
  result: IndicatorResultView | undefined;
  canEdit: boolean;
  onUploaded(): void;
}) {
  const t = useT();
  const f = useFormats();
  const titleId = useId();
  const canOpen = useCanOpen(result?.detail?.reportId ?? '');
  const computed = !indicator.manual;
  return (
    <section aria-labelledby={titleId} data-indicator={indicator.code} className="grid gap-4 border-t py-5">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h4 id={titleId} className="text-sm font-bold">
            {officialLabel(t, indicator.officialNo, component)}
          </h4>
          <span className="text-xs text-faint">{indicator.code}</span>
        </div>
        <p className="text-sm">{keyText(t, indicator.labelKey)}</p>
        <p className="text-xs text-muted-foreground">{t('accreditation.workspace.window', { window: label(t, WINDOWS, indicator.window) })}</p>
      </header>

      {computed && result !== undefined && (
        <div className="grid gap-1 text-sm">
          <p>
            <span className="text-muted-foreground">{t('accreditation.workspace.value_label')} </span>
            {valueText(t, f, result)}
          </p>
          <p>{t('accreditation.workspace.source', { source: label(t, BASES, result.basis) })}</p>
        </div>
      )}
      {result !== undefined && result.notes.length > 0 && (
        <ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
          {result.notes.map((note, i) => (
            <li key={`${note.key}:${i}`}>{keyText(t, note.key, noteParams(f, note.params))}</li>
          ))}
        </ul>
      )}
      {result?.table != null && result.table.length > 0 && (
        <details className="text-sm">
          <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">{t('accreditation.workspace.table')}</summary>
          <div className={cn(TABLE.wrap, 'mt-2 w-fit max-w-full')}>
            <table className={TABLE.table}>
              <tbody>
                {result.table.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className={cn(TABLE.td, 'py-1.5', typeof cell === 'number' && 'text-right')}>
                        {typeof cell === 'number' ? f.number(cell) : cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {result?.detail != null && canOpen && (
        <p className="text-sm">
          <Link
            to={`/admin/reports/${encodeURIComponent(result.detail.reportId)}`}
            search={result.detail.params}
            className="font-semibold text-accent-text underline-offset-4 hover:underline">
            {t('accreditation.workspace.detail')}
          </Link>
        </p>
      )}

      <AnswerPicker periodId={periodId} indicator={indicator} result={result} disabled={!canEdit} />

      <EvidenceChecklist
        periodId={periodId}
        indicatorCode={indicator.code}
        items={indicator.evidence}
        status={result?.evidence}
        canUpload={canEdit}
        onUploaded={onUploaded}
      />
    </section>
  );
}
