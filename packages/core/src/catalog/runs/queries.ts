import type { DB } from '@altis/db';
import type { ExportFileExt } from '@altis/platform';
import { DomainError, EXPORT_FORMATS, RUN_KINDS, RUN_STATUSES, isUlid, type ExportFormat, type RunKind, type RunStatus } from '@altis/shared';
import type { RunListQuery, RunView } from '@altis/shared/api/catalog/runs';
import { JOB_STATUS_VALUES, type JobStatusValue } from '@altis/shared/api/jobs';
import type { Paged } from '@altis/shared/api/catalog/common';
import type { Kysely, Transaction } from 'kysely';
import { getRun, type RunRow } from '../data/runs.js';

// What the admin reads of catalog runs (Phase 2 spec §2.2 `catalog_runs`, §5.4, §12.2; plan Task 19; decision P2-27):
// the list and one run as RunView, a run's report file, and an export's file while it may be downloaded.
//
// - A `migration` run is 404 to anyone without `catalog.migration.run` (P2-27): it is left out of the list, and getting
//   it, its report or its file answers NOT_FOUND. The route says which the viewer holds (`viewer.migration`).
// - A `slims_usage` run (the SLiMS usage import of the accreditation workspace) is hidden the same way from anyone
//   without `accreditation.workspace.manage` (`viewer.slimsUsage`; absent counts as not held).
// - The list is newest first, keyset over `(created_at, id)` (both descending), paged by an opaque cursor
//   `<createdAt>.<id>` that names the last row of the page; with `kind`, `ix_catalog_runs_kind_created_at` serves it.
// - Each run carries its job's status (`jobStatus`, null without a job row): a run still `queued` or `running` whose
//   job ended outside it (cancelled while queued, dead) is not live, so a screen that follows live runs lets go (C17).
// - An export's file is `exports/<runId>.<ext>` (Task 3's exportFilePath), the extension given by the run's `format`
//   ({@link exportFileExtOf}). `output_name` is set (by finishRun) once the file is complete and cleared again by the
//   housekeeping step when it expires, so a run without one has no file to serve (NOT_FOUND). From `expires_at` on the
//   file is gone, whether or not the daily housekeeping removed it yet: CATALOG_RUN_EXPIRED (410).

type Db = Kysely<DB> | Transaction<DB>;

/** Who reads runs: whether they hold `catalog.migration.run`, and `accreditation.workspace.manage`. */
export interface RunViewer {
  migration: boolean;
  // ---- Komunitas K1 (usage import runs) ----
  /** Holds `accreditation.workspace.manage`: sees the SLiMS usage import runs (absent: does not). */
  slimsUsage?: boolean;
}

/** The run kinds `viewer` may not see. */
function hiddenKinds(viewer: RunViewer): string[] {
  const hidden: string[] = [];
  if (!viewer.migration) hidden.push('migration');
  if (viewer.slimsUsage !== true) hidden.push('slims_usage');
  return hidden;
}

/** The file extension of each export format (`marcjson` is MARC-in-JSON as JSON Lines). */
const EXPORT_EXT: Readonly<Record<ExportFormat, ExportFileExt>> = Object.freeze({
  marc21: 'mrc',
  marcxml: 'xml',
  marcjson: 'jsonl',
  'csv-records': 'csv',
  'csv-items': 'csv',
});

/**
 * The extension of the export file of `format` (`exports/<runId>.<ext>`): `mrc`, `xml`, `jsonl` or `csv`; null for a
 * format that is not an export format. The export job (Task 31) writes its file under this name.
 */
export function exportFileExtOf(format: string | null): ExportFileExt | null {
  return format !== null && (EXPORT_FORMATS as readonly string[]).includes(format) ? EXPORT_EXT[format as ExportFormat] : null;
}

function runNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Proses katalog tidak ditemukan / Catalog run not found' });
}

function badCursor(): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Kursor daftar tidak valid / The list cursor is not valid',
    meta: { errors: [{ path: 'cursor', code: 'invalid' }] },
  });
}

/** `text` as a JSON object, or null when it is not one. */
function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: number | string | bigint): number => Number(v);
const numOrNull = (v: number | string | bigint | null): number | null => (v === null ? null : Number(v));

/** A job status as read, or null (no job row, or a status this code does not know). */
function jobStatusOf(v: string | null | undefined): JobStatusValue | null {
  return typeof v === 'string' && (JOB_STATUS_VALUES as readonly string[]).includes(v) ? (v as JobStatusValue) : null;
}

/** The view of a run row, with its job's status. */
function runView(r: RunRow, jobStatus: string | null | undefined): RunView {
  return {
    id: r.id,
    kind: (RUN_KINDS as readonly string[]).includes(r.kind) ? (r.kind as RunKind) : 'import',
    status: (RUN_STATUSES as readonly string[]).includes(r.status) ? (r.status as RunStatus) : 'failed',
    dryRun: Number(r.dry_run) === 1,
    format: r.format,
    options: jsonObject(r.options) ?? {},
    summary: jsonObject(r.summary),
    reportFileId: r.report_file_id,
    outputName: r.output_name,
    outputSize: numOrNull(r.output_size),
    expiresAt: numOrNull(r.expires_at),
    jobId: r.job_id,
    jobStatus: jobStatusOf(jobStatus),
    createdAt: num(r.created_at),
    createdBy: r.created_by,
    finishedAt: numOrNull(r.finished_at),
  };
}

/** The keyset position a cursor names, or a VALIDATION_FAILED at `cursor`. */
function parseCursor(cursor: string): { createdAt: number; id: string } {
  const m = /^(\d{1,15})\.([0-9A-Z]{26})$/.exec(cursor);
  if (m === null || !isUlid(m[2]!)) throw badCursor();
  return { createdAt: Number(m[1]), id: m[2]! };
}

/**
 * A page of runs, newest first (see the top of this file): `q.kind` filters, `q.cursor` continues after the row it
 * names, `q.limit` rows at most. Migration runs only for a viewer with `catalog.migration.run`, usage import runs only for
 * one with `accreditation.workspace.manage`.
 *
 * @throws DomainError `VALIDATION_FAILED` (`cursor`, `invalid`) for a cursor that does not parse
 */
export async function listRuns(db: Db, q: RunListQuery, viewer: RunViewer): Promise<Paged<RunView>> {
  const after = q.cursor === undefined ? null : parseCursor(q.cursor);
  const hidden = hiddenKinds(viewer);
  if (q.kind !== undefined && hidden.includes(q.kind)) return { items: [], nextCursor: null };
  let query = db.selectFrom('catalog_runs as r').leftJoin('jobs as j', 'j.id', 'r.job_id').selectAll('r').select('j.status as job_status');
  if (q.kind !== undefined) query = query.where('r.kind', '=', q.kind);
  else if (hidden.length > 0) query = query.where('r.kind', 'not in', hidden);
  if (after !== null) {
    query = query.where((eb) =>
      eb.or([eb('r.created_at', '<', after.createdAt), eb.and([eb('r.created_at', '=', after.createdAt), eb('r.id', '<', after.id)])]),
    );
  }
  const rows = await query.orderBy('r.created_at', 'desc').orderBy('r.id', 'desc').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => runView(r, r.job_status)),
    nextCursor: rows.length > q.limit && last !== undefined ? `${num(last.created_at)}.${last.id}` : null,
  };
}

/** The run `id` if `viewer` may see it (P2-27), else NOT_FOUND. */
async function visibleRun(db: Db, id: string, viewer: RunViewer): Promise<RunRow> {
  const row = await getRun(db, id);
  if (row === null || hiddenKinds(viewer).includes(row.kind)) throw runNotFound();
  return row;
}

/**
 * The run `id` as RunView.
 *
 * @throws DomainError `NOT_FOUND` for no such run, or a migration run and a viewer without `catalog.migration.run`
 */
export async function getRunView(db: Db, id: string, viewer: RunViewer): Promise<RunView> {
  const row = await visibleRun(db, id, viewer);
  const job = row.job_id === null ? undefined : await db.selectFrom('jobs').select('status').where('id', '=', row.job_id).executeTakeFirst();
  return runView(row, job?.status);
}

/**
 * The report of run `id` (decision P2-23): the `files` row the run names, which must be its own (`context
 * 'catalog.report'`, owner `catalog_runs`/`id`) and complete (`status 'ok'`). The caller streams the stored file.
 *
 * @throws DomainError `NOT_FOUND` for no such run (or a hidden migration run), a run without a report, or a file that
 *   is not the run's own report
 */
export async function runReportFile(db: Db, id: string, viewer: RunViewer): Promise<{ fileId: string; originalName: string; size: number }> {
  const run = await visibleRun(db, id, viewer);
  if (run.report_file_id === null) {
    throw new DomainError('NOT_FOUND', { detail: 'Proses ini belum punya laporan / This run has no report yet' });
  }
  const file = await db
    .selectFrom('files')
    .select(['id', 'original_name', 'size'])
    .where('id', '=', run.report_file_id)
    .where('context', '=', 'catalog.report')
    .where('owner_type', '=', 'catalog_runs')
    .where('owner_id', '=', run.id)
    .where('status', '=', 'ok')
    .executeTakeFirst();
  if (file === undefined) throw new DomainError('NOT_FOUND', { detail: 'Laporan proses tidak ditemukan / The run report was not found' });
  return { fileId: file.id, originalName: file.original_name, size: num(file.size) };
}

/**
 * The export file of run `id` at `now`, for its download (§5.4): the run's format, the file's extension, and the size
 * recorded when it was finished (null when none was).
 *
 * @throws DomainError `NOT_FOUND` for no such run, a run that is not an export or has no file yet (`output_name` not
 *   set, or the run did not succeed); `CATALOG_RUN_EXPIRED` (410) from `expires_at` on
 */
export async function runExportFile(db: Db, id: string, now: number): Promise<{ runId: string; format: ExportFormat; ext: ExportFileExt; size: number | null }> {
  const run = await getRun(db, id);
  const ext = run === null || run.kind !== 'export' ? null : exportFileExtOf(run.format);
  if (run === null || ext === null) throw runNotFound();
  if (run.expires_at !== null && num(run.expires_at) <= now) {
    throw new DomainError('CATALOG_RUN_EXPIRED', {
      detail: 'Berkas ekspor ini sudah kedaluwarsa dan dihapus; buat ekspor baru / This export file has expired and was removed; make a new export',
    });
  }
  if (run.output_name === null || run.status !== 'succeeded') {
    throw new DomainError('NOT_FOUND', { detail: 'Berkas ekspor belum tersedia / The export file is not available yet' });
  }
  return { runId: run.id, format: run.format as ExportFormat, ext, size: numOrNull(run.output_size) };
}
