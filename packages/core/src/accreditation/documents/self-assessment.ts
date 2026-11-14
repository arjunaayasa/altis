import { reportWorkPath, writeBytesAtomic } from '@altis/platform';
import type { PrerequisitesView } from '@altis/shared/api/accreditation';
import { z } from 'zod';
import type { PdfLayout } from '../../print/layout.js';
import { PERIOD_PARAM, reportIdField } from '../../reports/params.js';
import type { DocumentCtx, DocumentReport, DocumentStep } from '../../reports/types.js';
import type { ComposedResults } from '../evaluate/compose.js';
import { dateText, documentLayout, documentResults, loadDocPeriod, msg, numberText, orNone, sourceStatusText, type DocPeriod } from './data.js';
import { headerText, SIM, WORDS } from './texts.js';

// The internal simulation of the assessment (spec §10.9): the only document with the estimated score. Every page is
// headed "SIMULASI INTERNAL — bukan untuk diunggah" with the disclaimer that the score is an estimate, and footed with
// the instrument's source status. It prints, from the period's results: the registration prerequisites; the score
// per component; the estimated final score (a range while items are unanswered) and its predicate, which is never
// printed while a prerequisite fails (the single score is then labelled a practice estimate); the unanswered items;
// the ten largest gaps with their suggested actions; the missing evidence per component; the answers given by hand or
// in place of a suggestion, with their notes; and every note of every item. It is never part of an evidence ZIP.
// Personal: it prints the names of the staff.

/** A score with a decimal comma (`70,45`). */
const decimal = (text: string): string => text.replace('.', ',');

function writePrerequisites(layout: PdfLayout, prerequisites: PrerequisitesView | null): void {
  layout.heading(SIM.prerequisites, 2);
  if (prerequisites === null) {
    layout.paragraph(SIM.notComputed);
    return;
  }
  if (!prerequisites.met) layout.paragraph(msg('accred.prereq.failed'), { bold: true });
  layout.checklist(
    [
      { label: msg('accred.prereq.titles', { count: numberText(prerequisites.titles.count), date: dateText(prerequisites.titles.asOf) }), present: prerequisites.titles.pass },
      { label: msg('accred.prereq.npp'), present: prerequisites.npp.pass },
      { label: msg('accred.prereq.founding_decree'), present: prerequisites.foundingDecree.pass },
    ],
    { presentLabel: SIM.pass, missingLabel: SIM.fail },
  );
}

function writeScore(layout: PdfLayout, p: DocPeriod, r: ComposedResults): void {
  const score = r.score;
  if (score === null) {
    layout.paragraph(SIM.notScored);
    return;
  }
  const labelOf = new Map<string, string>(p.instrument.components.map((c) => [c.code, msg(c.labelKey)]));
  layout.heading(SIM.components, 2);
  layout.table(
    [
      { header: SIM.component, weight: 4 },
      { header: SIM.sum, align: 'right' },
      { header: SIM.max, align: 'right' },
      { header: SIM.n, align: 'right' },
      { header: SIM.weight, align: 'right' },
    ],
    score.perComponent.map((c) => [labelOf.get(c.code) ?? c.code, numberText(c.sum), numberText(c.max), numberText(c.n), numberText(c.weight)]),
  );

  const met = r.prerequisites?.met ?? false;
  layout.heading(score.na === null ? SIM.range : SIM.estimate, 2);
  if (score.na !== null) {
    if (score.grade !== null) {
      layout.paragraph(`${SIM.estimate}: ${decimal(score.na)}`, { bold: true });
      layout.paragraph(`${SIM.predicate}: ${score.grade} (${msg(`accred.predicate.${score.grade}`)})`, { bold: true });
    } else {
      layout.paragraph(`${msg('accred.na.exercise')}: ${decimal(score.na)}`, { bold: true });
    }
  } else {
    layout.paragraph(`${SIM.range}: ${decimal(score.naLow)} – ${decimal(score.naHigh)} (${SIM.answered(score.answered, score.total)})`, { bold: true });
    if (!met) layout.paragraph(msg('accred.na.exercise'), { size: 9 });
  }
  layout.paragraph(msg('accred.disclaimer.estimate'), { size: 9 });

  layout.heading(SIM.unanswered, 2);
  const unanswered = r.indicators.filter((i) => i.final === null);
  if (unanswered.length === 0) layout.paragraph(SIM.noneUnanswered, { size: 9 });
  for (const i of unanswered) layout.paragraph(`${i.officialNo} — ${msg(i.labelKey)}`, { size: 9 });

  layout.heading(SIM.gaps, 2);
  for (const g of score.gaps) {
    layout.paragraph(`${g.officialNo} (${labelOf.get(g.component) ?? g.component}) — ${SIM.gap.toLowerCase()} ${decimal(g.gap)}`, { bold: true, size: 9 });
    layout.paragraph(`${SIM.action}: ${msg(g.actionKey)}`, { size: 9 });
  }
}

function writeMissingEvidence(layout: PdfLayout, p: DocPeriod, r: ComposedResults): void {
  if (!p.school) return;
  layout.heading(SIM.missingEvidence, 2);
  if (r.missingEvidence.length === 0) layout.paragraph(SIM.noneMissing, { size: 9 });
  const labelOf = new Map<string, string>(p.instrument.components.map((c) => [c.code, msg(c.labelKey)]));
  for (const group of r.missingEvidence) {
    layout.heading(labelOf.get(group.component) ?? group.component, 3);
    for (const item of group.items) layout.paragraph(`${item.officialNo} — ${msg(item.labelKey)}`, { size: 9 });
  }
}

function writeAnswers(layout: PdfLayout, p: DocPeriod, r: ComposedResults): void {
  if (!p.school) return;
  layout.heading(SIM.answers, 2);
  const answered = r.indicators.filter((i) => i.answer !== null);
  if (answered.length === 0) {
    layout.paragraph(SIM.noAnswers, { size: 9 });
    return;
  }
  layout.table(
    [
      { header: SIM.item, weight: 1 },
      { header: SIM.mode, weight: 1.6 },
      { header: SIM.answer, weight: 1, align: 'center' },
      { header: SIM.suggestion, weight: 1, align: 'center' },
      { header: SIM.note, weight: 5 },
    ],
    answered.map((i) => [
      i.officialNo,
      i.answer!.mode === 'override' ? SIM.override : SIM.manual,
      i.answer!.answer ?? WORDS.none,
      i.suggestion ?? WORDS.none,
      orNone(i.answer!.note),
    ]),
  );
}

function writeNotes(layout: PdfLayout, r: ComposedResults): void {
  layout.heading(SIM.notes, 2);
  const withNotes = r.indicators.filter((i) => i.notes.length > 0);
  if (withNotes.length === 0) layout.paragraph(SIM.noNotes, { size: 9 });
  for (const i of withNotes) {
    layout.heading(`${i.officialNo} — ${msg(i.labelKey)}`, 3);
    for (const n of i.notes) layout.paragraph(`• ${msg(n.key, n.params)}`, { size: 9 });
  }
}

async function renderSelfAssessment(ctx: DocumentCtx): Promise<DocumentStep> {
  const p = await loadDocPeriod(ctx);
  const r = await documentResults(ctx, p);
  const layout = documentLayout(ctx, p, { title: SIM.title, header: { left: msg('accred.simulation.header'), right: msg('accred.disclaimer.estimate') } });
  layout.heading(SIM.title, 1);
  const status = sourceStatusText(p.instrument);
  layout.keyValues([
    [headerText(p.libraryName, p.profile.npp ?? null), ''],
    [p.instrument.decree, status ?? ''],
    [p.row.name, `${dateText(p.row.starts_on)} – ${dateText(p.row.ends_on)}`],
  ]);
  writePrerequisites(layout, r.prerequisites);
  writeScore(layout, p, r);
  writeMissingEvidence(layout, p, r);
  writeAnswers(layout, p, r);
  writeNotes(layout, r);
  const bytes = layout.toBytes();
  await writeBytesAtomic(reportWorkPath(ctx.dataDir, ctx.runId, 'output.part'), bytes);
  return { done: true, rowCount: layout.pages, nonLatinRows: layout.nonLatinRows, warnings: [] };
}

/** The internal simulation of the assessment, with the estimated score. Personal: it prints the names of the staff. */
export const selfAssessmentReport: DocumentReport = Object.freeze<DocumentReport>({
  id: 'accreditation.self_assessment',
  module: 'accreditation',
  kind: 'document',
  titleKey: 'report.accreditation.self_assessment.title',
  permission: 'accreditation.workspace.read',
  personal: true,
  formats: ['pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  render: renderSelfAssessment,
});
