import type { PrerequisitesView, ResultsView, ScoreView } from '@altis/shared/api/accreditation';
import { useId, type JSX } from 'react';
import { Disclaimer } from '@/components/accreditation/disclaimer';
import { GapList } from '@/components/accreditation/gap-list';
import { ScoreBars } from '@/components/accreditation/score-bars';
import { ErrorState, LoadingState, StatusText, Tag } from '@/components/layout';
import { useT } from '@/i18n';
import { componentLabel, keyText, useFormats, useResults } from '../data';
import { TabState } from '../tab-state';

/**
 * Ringkasan (spec §6 "Akreditasi", §10.3, §10.12): the registration prerequisites on top (at least 1 000 titles at the
 * end of the period, the NPP, the founding decree), then the estimate:
 *
 * - while an indicator is unanswered, the range of the final score (unanswered ones at d for the lower bound, at a for
 *   the upper one) and "terjawab X/42";
 * - every indicator answered and the prerequisites met: the single estimate and its predicate;
 * - every indicator answered while a prerequisite fails: the single estimate labelled as a practice figure, never a
 *   predicate (a library that cannot register gets no grade);
 *
 * a bar per component, the ten largest gaps with the suggested action, the missing evidence per component, and the
 * disclaimer. An unscored instrument (the statistics mode) shows the prerequisites only. Before the first evaluation
 * the tab asks for one.
 */
export function SummaryTab(props: { periodId: string }): JSX.Element {
  return <TabState periodId={props.periodId}>{(ctx) => <Summary periodId={ctx.period.id} scored={ctx.instrument?.scored ?? false} />}</TabState>;
}

function Summary({ periodId, scored }: { periodId: string; scored: boolean }) {
  const t = useT();
  const results = useResults(periodId);
  const r = results.data;
  if (r === undefined) {
    return results.isError ? <ErrorState error={results.error} onRetry={() => void results.refetch()} retrying={results.isFetching} /> : <LoadingState />;
  }
  if (r.computedAt === null && r.prerequisites === null) {
    const running = r.status === 'queued' || r.status === 'running';
    return <p className="text-sm">{t(running ? 'accreditation.workspace.summary.running' : 'accreditation.workspace.summary.missing')}</p>;
  }
  return (
    <div className="grid max-w-5xl gap-6">
      <ResultsState results={r} />
      {r.prerequisites !== null && <Prerequisites prerequisites={r.prerequisites} />}
      {!scored || r.score === null ? (
        <p className="text-sm">{t('accreditation.workspace.summary.unscored')}</p>
      ) : (
        <>
          <Estimate score={r.score} met={r.prerequisites?.met === true} />
          <ScoreBars score={r.score} />
          <GapList gaps={r.score.gaps} />
          <MissingEvidence missing={r.missingEvidence} />
          <Disclaimer />
        </>
      )}
    </div>
  );
}

/** A computation under way or failed, above the last results. */
function ResultsState({ results }: { results: ResultsView }) {
  const t = useT();
  if (results.status === 'queued' || results.status === 'running') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('accreditation.workspace.summary.running')}
      </p>
    );
  }
  if (results.status === 'failed') {
    return (
      <p className="text-sm">
        <StatusText tone="bad">{t('accreditation.workspace.summary.failed')}</StatusText>
      </p>
    );
  }
  return null;
}

function Prerequisites({ prerequisites: p }: { prerequisites: PrerequisitesView }) {
  const t = useT();
  const f = useFormats();
  const titleId = useId();
  const checks: { key: string; text: string; pass: boolean }[] = [
    { key: 'titles', text: t('accred.prereq.titles', { count: f.number(p.titles.count), date: f.day(p.titles.asOf) }), pass: p.titles.pass },
    { key: 'npp', text: t('accred.prereq.npp'), pass: p.npp.pass },
    { key: 'founding_decree', text: t('accred.prereq.founding_decree'), pass: p.foundingDecree.pass },
  ];
  return (
    <section aria-labelledby={titleId} className="grid gap-3">
      <h3 id={titleId} className="text-base font-bold">
        {t('accreditation.workspace.prereq.title')}
      </h3>
      {!p.met && (
        <p className="text-sm">
          <StatusText tone="bad">{t('accred.prereq.failed')}</StatusText>
        </p>
      )}
      <ul className="grid border-t text-sm">
        {checks.map((c) => (
          <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
            <span>{c.text}</span>
            <Tag tone={c.pass ? 'ok' : 'bad'}>{t(c.pass ? 'accreditation.workspace.prereq.pass' : 'accreditation.workspace.prereq.fail')}</Tag>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The estimated final score: a range while an indicator is unanswered; the single estimate and its predicate once all
 * are answered with the prerequisites met; with a failing prerequisite, the single estimate as a practice figure and
 * no predicate.
 */
function Estimate({ score, met }: { score: ScoreView; met: boolean }) {
  const t = useT();
  const f = useFormats();
  const titleId = useId();
  const kind = score.na === null ? 'range' : met ? 'single' : 'exercise';
  return (
    <section aria-labelledby={titleId} className="grid gap-2">
      <h3 id={titleId} className="text-base font-bold">
        {t('accreditation.workspace.score.title')}
      </h3>
      <div data-score={kind} className="grid gap-1">
        {kind === 'range' && (
          <>
            <p className="text-2xl font-bold tabular-nums">
              {t('accreditation.workspace.score.range', { low: f.decimal(score.naLow), high: f.decimal(score.naHigh) })}
            </p>
            <p className="text-sm">{t('accreditation.workspace.score.answered', { answered: score.answered, total: score.total })}</p>
            <p className="text-xs text-muted-foreground">{t('accreditation.workspace.score.range_hint')}</p>
          </>
        )}
        {kind === 'single' && score.na !== null && (
          <>
            <p className="text-2xl font-bold tabular-nums">{t('accreditation.workspace.score.single', { na: f.decimal(score.na) })}</p>
            {score.grade !== null && (
              <p className="text-sm font-semibold">
                {t('accreditation.workspace.score.grade', { grade: score.grade, label: t(`accred.predicate.${score.grade}`) })}
              </p>
            )}
          </>
        )}
        {kind === 'exercise' && score.na !== null && (
          <>
            <p className="text-sm font-semibold">{t('accred.na.exercise')}</p>
            <p className="text-2xl font-bold tabular-nums">{f.decimal(score.na)}</p>
          </>
        )}
      </div>
    </section>
  );
}

function MissingEvidence({ missing }: { missing: ResultsView['missingEvidence'] }) {
  const t = useT();
  const titleId = useId();
  const groups = missing.filter((g) => g.items.length > 0);
  return (
    <section aria-labelledby={titleId} className="grid gap-3">
      <h3 id={titleId} className="text-base font-bold">
        {t('accreditation.workspace.evidence_missing.title')}
      </h3>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('accreditation.workspace.evidence_missing.none')}</p>
      ) : (
        <div className="grid gap-3">
          {groups.map((g) => (
            <div key={g.component} className="grid gap-1 text-sm">
              <h4 className="font-semibold">{componentLabel(t, g.component)}</h4>
              <ul className="grid list-disc gap-0.5 pl-5">
                {g.items.map((item) => (
                  <li key={`${item.indicatorCode}.${item.evidenceCode}`}>
                    {item.officialNo} · {keyText(t, item.labelKey)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
