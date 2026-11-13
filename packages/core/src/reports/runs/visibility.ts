import type { DB } from '@altis/db';
import { DomainError, isUlid, type Locale, type Permission, type ReportFormat, type ReportRunStatus } from '@altis/shared';
import {
  StoredRunParams,
  type ReportCatalogEntry,
  type ReportPaper,
  type ReportRunListQuery,
  type ReportRunListResponse,
  type ReportRunView,
} from '@altis/shared/api/reports';
import type { Kysely, Selectable } from 'kysely';
import { REPORTS } from '../registry.js';
import type { ReportDefinition } from '../types.js';
import { columnView } from './preview.js';
import { reportFieldErrors } from './service.js';

// Who sees which reports and which runs (spec §5.2, §13 "Ekspor").
//
// - A report is visible to whoever holds its `permission`; it can be exported through the generic run routes by
//   whoever holds its export permission (default: the same one), and only when it is a table report: a document is made
//   through its own route.
// - A run is its creator's: the creator sees it in full (its stored parameters, the paper of its PDF, the warnings of
//   its export). A holder of the jobs permission (`seeAll`) sees every other staff member's runs too, without their
//   parameters or warnings, and never as downloadable: the download is the creator's alone (download.ts).

/** Who looks at runs: their own runs in full; with `seeAll` (the jobs permission) every run, others' without params. */
export type ReportRunViewer = { staffId: string; seeAll: boolean };

/** The rows of a list page when the query names no limit. */
const DEFAULT_LIST_LIMIT = 50;

/** The permission that exports `def`. */
export function exportPermissionOf(def: ReportDefinition): Permission {
  return def.exportPermission ?? def.permission;
}

/** The definitions whose `permission` the user holds. */
export function visibleReports(holds: (p: Permission) => boolean): ReportDefinition[] {
  return REPORTS.filter((def) => holds(def.permission));
}

/** A definition as the catalogue lists it for a user (`canExport` from the export permission). */
export function reportCatalogEntry(def: ReportDefinition, holds: (p: Permission) => boolean): ReportCatalogEntry {
  return {
    id: def.id,
    module: def.module,
    kind: def.kind,
    titleKey: def.titleKey,
    personal: def.personal,
    canExport: def.kind === 'table' && holds(exportPermissionOf(def)),
    formats: [...def.formats],
    orientation: def.orientation,
    params: def.params.map((p) => ({ ...p, ...(p.options === undefined ? {} : { options: [...p.options] }) })),
    columns: def.kind === 'table' && typeof def.columns !== 'function' ? def.columns.map(columnView) : null,
  };
}

/** A stored `report_runs.params`; an unreadable value as no parameters at all. */
export function storedParamsOf(text: string): StoredRunParams {
  try {
    const parsed = StoredRunParams.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: as no parameters.
  }
  return { def: {} };
}

const numOrNull = (v: number | string | bigint | null): number | null => (v === null ? null : Number(v));

/**
 * A run as `viewer` sees it. `downloadable` here: the viewer's own run that succeeded; the route also asks the clock
 * (`expiresAt`) and the viewer's current export permission.
 */
export function reportRunView(row: Selectable<DB['report_runs']>, viewer: ReportRunViewer): ReportRunView {
  const mine = row.created_by !== null && row.created_by === viewer.staffId;
  const stored = mine ? storedParamsOf(row.params) : null;
  const paper: ReportPaper | null = stored === null ? null : (stored.pdf?.paper ?? (row.format === 'pdf' ? 'A4' : null));
  return {
    id: row.id,
    reportId: row.report_id,
    format: row.format as ReportFormat,
    locale: row.locale as Locale,
    personal: Number(row.personal) === 1,
    status: row.status as ReportRunStatus,
    rowCount: numOrNull(row.row_count),
    nonLatinRows: numOrNull(row.non_latin_rows),
    outputSize: numOrNull(row.output_size),
    errorCode: row.error_code,
    jobId: row.job_id,
    expiresAt: numOrNull(row.expires_at),
    createdAt: Number(row.created_at),
    createdBy: row.created_by,
    finishedAt: numOrNull(row.finished_at),
    params: stored === null ? null : stored.def,
    paper,
    warnings: stored === null ? [] : [...(stored.warnings ?? [])],
    mine,
    downloadable: mine && row.status === 'succeeded',
  };
}

/** `created_at` and id of the last run of a page, as the next page's cursor. */
function cursorOf(row: { created_at: number; id: string }): string {
  return `${Number(row.created_at)}.${row.id}`;
}

/** The position a cursor names. @throws DomainError `VALIDATION_FAILED` `{path: 'cursor', code: 'invalid'}` */
function parseCursor(cursor: string): { at: number; id: string } {
  const m = /^(\d{1,15})\.([0-9A-Z]{26})$/.exec(cursor);
  if (m === null || !isUlid(m[2]!)) throw reportFieldErrors([{ path: 'cursor', code: 'invalid' }]);
  return { at: Number(m[1]), id: m[2]! };
}

/**
 * The runs `viewer` may see, newest first: their own (`scope` `mine`, the default), or every run (`all`) for a viewer
 * with `seeAll` (without it, `all` lists the viewer's own runs).
 */
export async function listReportRuns(db: Kysely<DB>, viewer: ReportRunViewer, q: ReportRunListQuery): Promise<ReportRunListResponse> {
  const all = q.scope === 'all' && viewer.seeAll;
  const limit = q.limit === undefined ? DEFAULT_LIST_LIMIT : Number(q.limit);
  let query = db.selectFrom('report_runs').selectAll();
  if (!all) query = query.where('created_by', '=', viewer.staffId);
  if (q.reportId !== undefined) query = query.where('report_id', '=', q.reportId);
  if (q.cursor !== undefined) {
    const after = parseCursor(q.cursor);
    query = query.where((eb) => eb.or([eb('created_at', '<', after.at), eb.and([eb('created_at', '=', after.at), eb('id', '<', after.id)])]));
  }
  const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
  const page = rows.slice(0, limit);
  return {
    runs: page.map((row) => reportRunView(row, viewer)),
    nextCursor: rows.length > limit ? cursorOf(page[page.length - 1]!) : null,
  };
}

/** The run `id` as stored, when `viewer` may see it; otherwise null. */
export async function visibleRunRow(db: Kysely<DB>, id: string, viewer: ReportRunViewer): Promise<Selectable<DB['report_runs']> | null> {
  const row = await db.selectFrom('report_runs').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) return null;
  return row.created_by === viewer.staffId || viewer.seeAll ? row : null;
}

export function runNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Proses laporan tidak ditemukan / The report run was not found' });
}

/** One run `viewer` may see. @throws DomainError `NOT_FOUND` for a run that is not there or not the viewer's to see */
export async function getReportRun(db: Kysely<DB>, id: string, viewer: ReportRunViewer): Promise<ReportRunView> {
  const row = await visibleRunRow(db, id, viewer);
  if (row === null) throw runNotFound();
  return reportRunView(row, viewer);
}
