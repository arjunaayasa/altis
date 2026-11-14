import type { IndicatorResultView, NoteRef } from '@altis/shared/api/accreditation';
import type { PdfChecklistItem, PdfLayout } from '../../print/layout.js';
import { ACCRED_NOTE_IN_DOSSIER, type AccredNoteKey } from '../notes.js';
import { catalogueCode } from '../scoring/score.js';
import type { AccredComponent, AccredEvidenceItem, AccredIndicator, AccredInstrument } from '../types.js';
import type { ComposedResults } from '../evaluate/compose.js';
import { documentReport, msg, numberText } from './data.js';
import { BASIS, HEADINGS, SHEET, UNITS, WORDS } from './texts.js';

// The indicator sheets of the evidence file (spec §10.9 item 6), also the per-component sheets of an evidence ZIP:
// ordered by component, then by the indicator's printed number (numerically, so L10 follows L9). Each prints the
// printed number with its component, our paraphrase, the raw value, the formula with its numbers, the source of the
// value, the data-quality notes, the evidence checklist (each item's kind, whether it is there, its captions and file
// names, the screen of a screenshot, the report of a generated list) and the detail report's title.
//
// A sheet never prints an answer of any kind: no answer letter (computed or chosen by hand), no suggestion, no option
// label, no estimated score, predicate or gap, no mark or note of an answer that replaced a suggestion, and none of the
// notes that speak about the answer (`ACCRED_NOTE_IN_DOSSIER`); the librarian fills the answers in the official system.
// An indicator answered by hand prints its paraphrase and its evidence checklist only.

/** One sheet: the indicator, its component and its results. */
export interface SheetItem {
  component: AccredComponent;
  indicator: AccredIndicator;
  view: IndicatorResultView | null;
}

/** The number of a printed number (`L10` → 10). */
function numberOf(officialNo: string): number {
  const m = /(\d+)$/.exec(officialNo);
  return m === null ? Number.MAX_SAFE_INTEGER : Number(m[1]);
}

/** The sheets of `instrument` (of the components in `only`, when given), in their printed order. */
export function sheetItems(instrument: AccredInstrument, results: ComposedResults, only?: ReadonlySet<string>): SheetItem[] {
  const views = new Map(results.indicators.map((v) => [v.code, v]));
  const out: SheetItem[] = [];
  for (const component of instrument.components) {
    if (only !== undefined && !only.has(component.code)) continue;
    const indicators = [...component.indicators].sort((a, b) => numberOf(a.officialNo) - numberOf(b.officialNo));
    for (const indicator of indicators) out.push({ component, indicator, view: views.get(catalogueCode(indicator)) ?? null });
  }
  return out;
}

/** The heading of a sheet: `L7 · Pelayanan Perpustakaan butir 7`. */
export function sheetHeading(component: AccredComponent, indicator: AccredIndicator): string {
  return `${indicator.officialNo} · ${SHEET.item(msg(component.labelKey), String(numberOf(indicator.officialNo)))}`;
}

/** The notes the evidence file prints: the data-quality notes only (never one about the answer). */
export function dossierNotes(notes: readonly NoteRef[]): NoteRef[] {
  return notes.filter((n) => (ACCRED_NOTE_IN_DOSSIER as Readonly<Record<string, boolean>>)[n.key as AccredNoteKey] === true);
}

/** A value with its unit. */
function valueText(value: number | null, unit: string): string {
  if (value === null) return WORDS.noData;
  const suffix = UNITS[unit];
  return suffix === undefined ? numberText(value) : `${numberText(value)} ${suffix}`;
}

/** The formula with its numbers, when the value is a share or a ratio of two counts. */
function formulaText(v: IndicatorResultView): string | null {
  if (v.value === null || v.numerator === null || v.denominator === null) return null;
  const [n, d, x] = [numberText(v.numerator), numberText(v.denominator), numberText(v.value)];
  return v.unit === 'percent' ? `${n} × 100 ÷ ${d} = ${x} %` : `${n} ÷ ${d} = ${x}`;
}

/** The title of a report by id. */
export function reportTitle(reportId: string): string {
  return msg(documentReport(reportId)?.titleKey ?? `report.${reportId}.title`);
}

/** One checklist line: the item and its kind, there or not, and what backs it. */
function checklistItem(item: AccredEvidenceItem, state: IndicatorResultView['evidence'][number] | undefined): PdfChecklistItem {
  const label = `${msg(item.labelKey)} (${msg(`vocab.evidence_kind.${item.kind}`)})`;
  const details: string[] = [];
  if (item.kind === 'generated' && item.reportId !== undefined) details.push(`${SHEET.report}: ${reportTitle(item.reportId)}`);
  if (item.kind === 'screenshot' && item.screen !== undefined) details.push(`${SHEET.screen}: ${item.screen}`);
  for (const f of state?.files ?? []) {
    const caption = f.caption.trim();
    details.push(caption === '' ? `${SHEET.file}: ${f.name}` : `${caption} (${SHEET.file.toLowerCase()} ${f.name})`);
  }
  const present = item.kind === 'generated' || (state?.present ?? false);
  return details.length === 0 ? { label, present } : { label, present, detail: details.join('; ') };
}

/** Prints one sheet. */
export function writeSheet(layout: PdfLayout, s: SheetItem): void {
  const { component, indicator, view } = s;
  layout.heading(sheetHeading(component, indicator), 2);
  layout.paragraph(msg(indicator.labelKey));
  if (indicator.band.kind !== 'manual') {
    const rows: [string, string][] = [];
    const v = view;
    rows.push([SHEET.value, v === null ? WORDS.noData : valueText(v.value, v.unit)]);
    const formula = v === null ? null : formulaText(v);
    if (formula !== null) rows.push([SHEET.formula, formula]);
    rows.push([SHEET.source, BASIS[v?.basis ?? 'none'] ?? BASIS['none']!]);
    if (v?.detail !== null && v?.detail !== undefined) rows.push([SHEET.detail, reportTitle(v.detail.reportId)]);
    layout.keyValues(rows);
    const notes = dossierNotes(v?.notes ?? []);
    if (notes.length > 0) {
      layout.heading(SHEET.notes, 3);
      for (const n of notes) layout.paragraph(`• ${msg(n.key, n.params)}`, { size: 9 });
    }
  }
  layout.heading(SHEET.evidence, 3);
  const states = new Map((view?.evidence ?? []).map((e) => [e.code, e]));
  layout.checklist(
    indicator.evidence.map((item) => checklistItem(item, states.get(item.code))),
    { presentLabel: WORDS.present, missingLabel: WORDS.missing },
  );
}

/** Prints the sheets of `items` under the section heading; the number of sheets. */
export function writeIkSheets(layout: PdfLayout, items: readonly SheetItem[]): number {
  layout.heading(HEADINGS.sheets, 1);
  let current: string | null = null;
  for (const s of items) {
    if (current !== null && current !== s.component.code) layout.pageBreak();
    current = s.component.code;
    writeSheet(layout, s);
  }
  return items.length;
}
