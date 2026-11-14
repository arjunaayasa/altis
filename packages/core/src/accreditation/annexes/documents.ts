import { DOCUMENT_KINDS, t, type Locale, type MessageKey } from '@altis/shared';
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField, reportParam } from '../../reports/params.js';
import type { ReportCtx, ReportRow, TableReport } from '../../reports/types.js';
import { annexPeriod, aspectsOf, compareKeys, isCurrentDocument, pageAfter, parseKeyCursor, periodDates, vocabLabel } from '../providers/registers-metrics.js';
import { resolveWindow } from '../windows.js';

// The documents annex of an accreditation period: the live documents of the register that are current at its
// snapshot date (issued by then or undated, and still valid then) or were issued in the period, of the kinds chosen
// (all without `kinds`), by issue date (undated ones first), then id. The aspects a document covers are listed by their
// labels in the instrument's order. The register holds hundreds of rows at most, so a page is cut from the sorted
// list after the cursor's key.

/** The aspects of a document as one cell, or null when it covers none. */
function aspectsCell(locale: Locale, d: { kind: string; aspect_codes: string | null }): string | null {
  const codes = aspectsOf(d);
  return codes.length === 0 ? null : codes.map((code) => t(locale, `accred.aspect.${d.kind}.${code}` as MessageKey)).join(', ');
}

async function documentAnnexRows(ctx: ReportCtx, cursor: string | null, limit: number): Promise<{ rows: ReportRow[]; nextCursor: string | null }> {
  const after = parseKeyCursor(cursor);
  const { period, D } = await annexPeriod(ctx);
  const w = resolveWindow('period', periodDates(period), D);
  const kinds = Array.isArray(ctx.params['kinds']) ? (ctx.params['kinds'] as string[]) : [];
  let q = ctx.db
    .selectFrom('library_documents')
    .select(['id', 'kind', 'title', 'reference', 'issued_on', 'issued_by', 'aspect_codes', 'valid_until'])
    .where('archived_at', 'is', null);
  if (kinds.length > 0) q = q.where('kind', 'in', kinds);
  const listed = (await q.execute())
    .filter((d) => isCurrentDocument(d, D) || (d.issued_on !== null && d.issued_on >= w.from && d.issued_on <= w.to))
    .map((d) => ({ ...d, key: [d.issued_on ?? '', d.id] as [string, string] }))
    .sort((a, b) => compareKeys(a.key, b.key));
  const { page, next } = pageAfter(listed, (d) => d.key, after, limit);
  return {
    rows: page.map((d) => [
      vocabLabel(ctx.locale, 'document_kind', d.kind),
      d.title,
      d.reference,
      d.issued_on,
      d.issued_by,
      aspectsCell(ctx.locale, d),
      d.valid_until,
    ]),
    nextCursor: next,
  };
}

/** The documents of the register current in the period, filtered by kind. */
export const annexDocumentsReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.documents',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.documents.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    PERIOD_PARAM,
    reportParam('kinds', 'status', { multiple: true, options: DOCUMENT_KINDS, optionLabelPrefix: 'vocab.document_kind.' }),
  ],
  paramsSchema: z.strictObject({
    periodId: reportIdField,
    kinds: z.array(z.enum(DOCUMENT_KINDS)).min(1).max(DOCUMENT_KINDS.length).optional(),
  }),
  columns: [
    ...['kind', 'title', 'reference'].map((key) => reportColumn(key, 'text')),
    reportColumn('issued_on', 'date'),
    ...['issued_by', 'aspects'].map((key) => reportColumn(key, 'text')),
    reportColumn('valid_until', 'date'),
  ],
  rows: documentAnnexRows,
});
