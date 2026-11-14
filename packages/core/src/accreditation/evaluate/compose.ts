import type { DB } from '@altis/db';
import type {
  AnswerLetter,
  IndicatorResultView,
  NoteRef,
  PrerequisitesView,
  ResultsView,
  ScoreView,
  SnpResultView,
} from '@altis/shared/api/accreditation';
import type { Kysely } from 'kysely';
import { evidenceChecklist, PREREQUISITES_CODE } from '../evidence/checklist.js';
import { ACCRED_METRICS, type AccredMetricId } from '../metric-ids.js';
import { PREREQUISITE_METRICS, evaluatePrerequisites } from '../scoring/prerequisites.js';
import { catalogueCode, finalAnswers, scoreInstrument } from '../scoring/score.js';
import { evaluateSnp } from '../scoring/snp.js';
import { suggestAnswer } from '../scoring/suggest.js';
import type { AccredComponent, AccredIndicator, AccredInstrument, AccredMetricValue, AccredResultPayload, AccredStoredValue, Letter, SnpCheck } from '../types.js';
import { fittedJson, noValue, storedValue } from './results.js';

// What an evaluation stores and how the results are read back (spec §10.3, §10.4, §10.10).
//
// - The items of an instrument: each indicator (by its catalogue code, `SCH-K1`), each school standard (`SNP-S-01`)
//   and the registration prerequisites (`SCH-PRASYARAT`), with the metrics each one needs: an indicator its metric and,
//   for a band sized by another metric, that one; the building item (answered by hand) the floor area it shows beside
//   its options; a standard its metric, its size metric and the period's class count for the class-based rules; the
//   prerequisites their three metrics. The evaluation computes exactly the union of these.
// - The payload of an item (`AccredResultPayload`) is built from the values once all its metrics are computed: an
//   indicator's value, size value, suggested answer and scoring notes; a standard's value, outcome and notes; the
//   prerequisites with the titles' value.
// - Reading (`composeResults`): the stored suggestions with the current answers give the final answers and the score,
//   computed whenever the results are read, so an answer counts at once without a new evaluation; the evidence
//   checklist of each indicator and the missing items per component come from the period's evidence. It is the only
//   composition of results: the workspace, the freeze and the documents all read it.

/** The building item answers by hand but shows the floor area beside its options. */
const FLOOR_AREA_METRIC: AccredMetricId = 'period.floor_m2';

/** One item of an instrument's results, with the metrics it needs. */
export type ResultItem =
  | { kind: 'indicator'; code: string; component: AccredComponent; indicator: AccredIndicator; metrics: readonly AccredMetricId[] }
  | { kind: 'snp'; code: string; check: SnpCheck; metrics: readonly AccredMetricId[] }
  | { kind: 'prerequisites'; code: string; metrics: readonly AccredMetricId[] };

/** The metric an indicator's value is: its own, or the floor area a manual building item shows; null for none. */
export function shownMetricOf(ind: AccredIndicator): AccredMetricId | null {
  if (ind.metric !== undefined) return ind.metric;
  if (ind.band.kind === 'manual' && ind.noteKeys?.includes('accred.note.sp1_floor') === true) return FLOOR_AREA_METRIC;
  return null;
}

const needsClasses = (check: SnpCheck): boolean => check.rule.kind === 'min_by_classes' || check.rule.kind === 'staff_by_classes';

/** Every item of `instr`'s results, in the order they are shown: indicators, standards, prerequisites. */
export function resultItems(instr: AccredInstrument): ResultItem[] {
  const out: ResultItem[] = [];
  for (const component of instr.components) {
    for (const indicator of component.indicators) {
      const metrics: AccredMetricId[] = [];
      const shown = shownMetricOf(indicator);
      if (shown !== null) metrics.push(shown);
      if (indicator.band.kind === 'sized_range') metrics.push(indicator.band.sizeMetric);
      out.push({ kind: 'indicator', code: catalogueCode(indicator), component, indicator, metrics });
    }
  }
  for (const check of instr.snp) {
    const metrics: AccredMetricId[] = [];
    if (check.metric !== null) metrics.push(check.metric);
    if (check.rule.kind === 'min_by_size') metrics.push(check.rule.sizeMetric);
    if (needsClasses(check)) metrics.push('period.classes');
    out.push({ kind: 'snp', code: check.code, check, metrics });
  }
  out.push({ kind: 'prerequisites', code: PREREQUISITES_CODE, metrics: [...PREREQUISITE_METRICS] });
  return out;
}

/** The metrics an evaluation of `items` computes, once each, in the order the items first need them. */
export function evaluationMetrics(items: readonly ResultItem[]): AccredMetricId[] {
  const out = new Set<AccredMetricId>();
  for (const item of items) for (const m of item.metrics) out.add(m);
  return [...out];
}

/** The `metricParams` the indicators of `instr` give each metric (merged when several indicators read it). */
export function metricParamsOf(instr: AccredInstrument): (metric: AccredMetricId) => Readonly<Record<string, unknown>> {
  const params = new Map<AccredMetricId, Record<string, unknown>>();
  for (const c of instr.components) {
    for (const i of c.indicators) {
      if (i.metric === undefined || i.metricParams === undefined) continue;
      params.set(i.metric, { ...(params.get(i.metric) ?? {}), ...i.metricParams });
    }
  }
  return (metric) => params.get(metric) ?? {};
}

/** A computed value of each metric (a metric no provider answered for has no data). */
export type ValueOf = (id: AccredMetricId) => AccredMetricValue;

/**
 * The stored JSON of `item`, from the values of its metrics and the snapshot date `D` (a value's table cut to fit
 * 16 000 bytes). The prerequisites also answer their view, for the evaluation's `_meta`.
 */
export function itemPayload(item: ResultItem, valueOf: ValueOf, D: string): { json: string; prerequisites: PrerequisitesView | null } {
  switch (item.kind) {
    case 'indicator': {
      const ind = item.indicator;
      const shown = shownMetricOf(ind);
      const v = shown === null ? null : valueOf(shown);
      const size = ind.band.kind === 'sized_range' ? valueOf(ind.band.sizeMetric) : null;
      const { suggestion, notes } = suggestAnswer(ind, v, size);
      const value = v === null ? null : storedValue(v);
      const sized = size === null ? null : storedValue(size);
      const payload: AccredResultPayload = { kind: 'indicator', metric: shown, value, size: sized, suggestion, notes };
      return { json: fittedJson(payload, [value, sized]), prerequisites: null };
    }
    case 'snp': {
      const check = item.check;
      const v = check.metric === null ? null : valueOf(check.metric);
      const size = check.rule.kind === 'min_by_size' ? valueOf(check.rule.sizeMetric) : null;
      const classes = needsClasses(check) ? valueOf('period.classes').value : null;
      const r = evaluateSnp(check, v, size, classes, { D });
      const value = v === null ? null : storedValue(v);
      const payload: AccredResultPayload = { kind: 'snp', metric: check.metric, value, outcome: r.outcome, rule: r.rule, notes: r.notes };
      return { json: fittedJson(payload, [value]), prerequisites: null };
    }
    case 'prerequisites': {
      const [titlesId, nppId, decreeId] = PREREQUISITE_METRICS as [AccredMetricId, AccredMetricId, AccredMetricId];
      const titles = valueOf(titlesId);
      const prerequisites = evaluatePrerequisites({ titles, npp: valueOf(nppId), foundingDecree: valueOf(decreeId), D });
      const stored = storedValue(titles);
      const payload: AccredResultPayload = { kind: 'prerequisites', prerequisites, titles: stored };
      return { json: fittedJson(payload, [stored]), prerequisites };
    }
  }
}

/** The values of `ids` from `values`, those it lacks without data. */
export function valueReader(values: ReadonlyMap<AccredMetricId, AccredMetricValue>): ValueOf {
  return (id) => values.get(id) ?? noValue(id);
}

// ---- reading -------------------------------------------------------------------------------------------------------

/** What the results of a period are, composed from the stored rows, the current answers and the evidence. */
export interface ComposedResults {
  prerequisites: PrerequisitesView | null;
  indicators: IndicatorResultView[];
  snp: SnpResultView[];
  score: ScoreView | null;
  missingEvidence: ResultsView['missingEvidence'];
}

type StoredAnswer = NonNullable<IndicatorResultView['answer']>;

/** The answers of `periodId` by catalogue code. */
async function answersOf(db: Kysely<DB>, periodId: string): Promise<Map<string, StoredAnswer>> {
  const rows = await db.selectFrom('accred_answers').select(['indicator_code', 'answer', 'mode', 'note', 'updated_at', 'updated_by']).where('period_id', '=', periodId).execute();
  const out = new Map<string, StoredAnswer>();
  for (const r of rows) {
    out.set(r.indicator_code, {
      answer: r.answer as AnswerLetter,
      mode: r.mode === 'override' ? 'override' : 'manual',
      note: r.note,
      updatedAt: Number(r.updated_at),
      updatedBy: r.updated_by,
    });
  }
  return out;
}

/** The notes printed beside a value: the value's own, then the scoring notes. */
function shownNotes(value: AccredStoredValue | null, scoring: readonly NoteRef[]): NoteRef[] {
  const out = [...(value?.notes ?? [])];
  for (const n of scoring) if (!out.some((m) => m.key === n.key)) out.push(n);
  return out;
}

/**
 * The results of period `periodId` of `instrument` from its stored rows (`rows`, by code), its current answers and its
 * evidence: every indicator (missing rows read as not computed), every standard, the prerequisites, the score from
 * the final answers, and the missing evidence items per component (components without one left out).
 */
export async function composeResults(
  db: Kysely<DB>,
  periodId: string,
  instrument: AccredInstrument,
  rows: ReadonlyMap<string, AccredResultPayload>,
): Promise<ComposedResults> {
  const answers = await answersOf(db, periodId);
  const checklist = await evidenceChecklist(db, periodId, instrument);
  const items = resultItems(instrument);

  const suggestions = new Map<string, Letter | null>();
  for (const item of items) {
    const row = rows.get(item.code);
    if (item.kind === 'indicator') suggestions.set(item.code, row?.kind === 'indicator' ? row.suggestion : null);
  }
  const finals = finalAnswers(instrument, suggestions, answers);
  const prereqRow = rows.get(PREREQUISITES_CODE);
  const prerequisites = prereqRow?.kind === 'prerequisites' ? prereqRow.prerequisites : null;

  const indicators: IndicatorResultView[] = [];
  const snp: SnpResultView[] = [];
  const missing = new Map<string, ResultsView['missingEvidence'][number]['items']>();
  for (const item of items) {
    const row = rows.get(item.code);
    if (item.kind === 'indicator') {
      const ind = item.indicator;
      const stored = row?.kind === 'indicator' ? row : null;
      const value = stored?.value ?? null;
      const metric = stored?.metric ?? shownMetricOf(ind);
      const evidence = checklist.get(item.code) ?? [];
      indicators.push({
        code: item.code,
        officialNo: ind.officialNo,
        component: item.component.code,
        labelKey: ind.labelKey,
        metric,
        value: value?.value ?? null,
        numerator: value?.numerator ?? null,
        denominator: value?.denominator ?? null,
        unit: value?.unit ?? (metric === null ? 'none' : (ACCRED_METRICS[metric as AccredMetricId]?.unit ?? 'none')),
        basis: value?.basis ?? 'none',
        notes: shownNotes(value, stored?.notes ?? []),
        detail: value?.detail === undefined ? null : { reportId: value.detail.reportId, params: { ...value.detail.params } },
        table: value?.table === undefined ? null : value.table.map((r) => [...r]),
        suggestion: stored?.suggestion ?? null,
        suggest: ind.band.kind !== 'manual' && value?.suggest !== false,
        answer: answers.get(item.code) ?? null,
        final: finals.get(item.code) ?? null,
        evidence: evidence.map((e) => ({ code: e.code, present: e.present, files: e.files.map((f) => ({ ...f })) })),
      });
      for (const e of evidence) {
        if (e.present) continue;
        const def = ind.evidence.find((x) => x.code === e.code);
        const list = missing.get(item.component.code) ?? [];
        list.push({ indicatorCode: item.code, officialNo: ind.officialNo, evidenceCode: e.code, labelKey: def?.labelKey ?? e.code });
        missing.set(item.component.code, list);
      }
    } else if (item.kind === 'snp') {
      const stored = row?.kind === 'snp' ? row : null;
      snp.push({
        code: item.code,
        labelKey: item.check.labelKey,
        outcome: stored?.outcome ?? 'not_evaluated',
        value: stored?.value?.value ?? null,
        rule: stored?.rule ?? item.check.ruleKey,
        notes: stored === null ? [] : stored.notes.map((n) => ({ ...n })),
      });
    }
  }
  const score = scoreInstrument(instrument, finals, { prerequisitesMet: prerequisites?.met ?? false });
  const missingEvidence = instrument.components.filter((c) => missing.has(c.code)).map((c) => ({ component: c.code, items: missing.get(c.code)! }));
  return { prerequisites, indicators, snp, score, missingEvidence };
}
