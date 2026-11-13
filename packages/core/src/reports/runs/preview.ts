import { countRows, type DB } from '@altis/db';
import type { DomainError, Locale } from '@altis/shared';
import {
  REPORT_PREVIEW_CURSOR_MAX,
  REPORT_SCAN_PREVIEW_MAX_RECORDS,
  type ReportColumnView,
  type ReportPreviewBody,
  type ReportPreviewResponse,
} from '@altis/shared/api/reports';
import type { Kysely } from 'kysely';
import type { AccredSettings } from '../../settings/accreditation.js';
import { columnsOf } from '../personal.js';
import type { ReportDefinition, TableReport } from '../types.js';
import { parseDefParams, reportCtx, reportFieldErrors } from './service.js';

// The paged preview of a table report (spec §4.15): one keyset page of rows answered at once, without an audit entry.
// A document report has no rows to preview.
//
// A report that has to scan the whole stock for its answer (`scanBased`) is previewed only while the library holds at
// most REPORT_SCAN_PREVIEW_MAX_RECORDS live records; above that the request is refused at once with `export_only`
// (the screen offers the export), before any scan starts. Below it, the definition may answer pages without rows while
// its scan runs (`{rows: [], nextCursor}`): the preview calls it again with that cursor until rows come, and refuses
// with `export_only` too when its own budget of 10 seconds runs out first.

/** The rows of a page when the body names no limit. */
const DEFAULT_LIMIT = 50;
/** The budget of one preview request. */
const PREVIEW_BUDGET_MS = 10_000;
/** Below this much budget left after a page without rows, the scan is not continued. */
const SCAN_MARGIN_MS = 2_000;

/** The `export_only` refusal: this preview is too big to answer at once; the export can. */
function exportOnly(): DomainError {
  return reportFieldErrors([{ path: 'params', code: 'export_only' }]);
}

/** A column as the API shows it. */
export function columnView(c: { key: string; labelKey: string; type: ReportColumnView['type'] }): ReportColumnView {
  return { key: c.key, labelKey: c.labelKey, type: c.type };
}

/**
 * The parameters that decide whether `def` scans the stock: an `asOf` equal to today asks for the live stock, which is
 * no scan, so it is left out of the question (a definition does not know today in `scanBased`).
 */
function scanQuestion(params: Record<string, unknown>, today: string): Record<string, unknown> {
  if (params['asOf'] !== today) return params;
  const rest = { ...params };
  delete rest['asOf'];
  return rest;
}

/** Whether the library holds more live records than a scan-based preview may read. */
async function tooManyRecordsToScan(db: Kysely<DB>): Promise<boolean> {
  const live = await countRows(db.selectFrom('records').where('archived_at', 'is', null));
  return live > REPORT_SCAN_PREVIEW_MAX_RECORDS;
}

/**
 * One preview page of `def` for `body`: its columns for the parameters, up to `limit` rows (default 50) from `cursor`,
 * the cursor of the next page (null at the end) and, on the first page, the totals row.
 *
 * @throws DomainError `VALIDATION_FAILED`: `{path: 'reportId', code: 'not_previewable'}` for a document report,
 *   `params.<name>` for parameters its schema refuses, `{path: 'params', code: 'export_only'}` for a scan-based
 *   report over the record limit, a scan that does not answer within the budget, or a page whose cursor is longer
 *   than a preview cursor may be
 */
export async function previewReport(
  db: Kysely<DB>,
  def: ReportDefinition,
  body: ReportPreviewBody,
  o: { locale: Locale; tz: string; now: number; settings: AccredSettings },
): Promise<ReportPreviewResponse> {
  if (def.kind !== 'table') throw reportFieldErrors([{ path: 'reportId', code: 'not_previewable' }]);
  const table: TableReport = def;
  const params = parseDefParams(table, body.params);
  const ctx = reportCtx(db, { ...o, params, budgetMs: PREVIEW_BUDGET_MS });
  if (table.scanBased?.(scanQuestion(params, ctx.today)) === true && (await tooManyRecordsToScan(db))) throw exportOnly();

  const limit = body.limit ?? DEFAULT_LIMIT;
  let page = await table.rows(ctx, body.cursor ?? null, limit);
  while (page.rows.length === 0 && page.nextCursor !== null) {
    if (ctx.budgetLeftMs() < SCAN_MARGIN_MS) throw exportOnly();
    page = await table.rows(ctx, page.nextCursor, limit);
  }
  if (page.nextCursor !== null && page.nextCursor.length > REPORT_PREVIEW_CURSOR_MAX) throw exportOnly();
  const totals = (body.cursor ?? null) === null && table.totals !== undefined ? await table.totals(ctx) : null;
  return {
    columns: columnsOf(table, params).map(columnView),
    rows: page.rows.map((row) => [...row]),
    nextCursor: page.nextCursor,
    totals: totals === null ? null : [...totals],
  };
}
