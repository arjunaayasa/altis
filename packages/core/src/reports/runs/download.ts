import type { DB } from '@altis/db';
import { reportExportPath, statOrNull, type DataPath, type ReportFileExt } from '@altis/platform';
import { DomainError, isLocale, localDate, t, type MessageKey, type Permission, type ReportFormat } from '@altis/shared';
import type { Kysely } from 'kysely';
import { safeFileName } from '../../files/serve.js';
import { reportById } from '../registry.js';
import { libraryTimeZone } from './service.js';
import { exportPermissionOf, runNotFound, visibleRunRow, type ReportRunViewer } from './visibility.js';

// The download of a run's file (spec §5.2, §13 "Ekspor"): only the run's creator downloads it, and only while they
// still hold the definition's export permission; a run that holds personal data also wants a re-authentication within
// the usual window. Seeing other staff members' runs (the jobs permission) never opens their files. A run that did
// not succeed, or whose file is gone, has nothing to serve; one whose file expired answers 410.
//
// The file is `exports/reports/<runId>.<ext>`; its download name is the report's title in the run's language and the
// day the run was asked for in the library's time zone (`Statistik Koleksi-2026-11-14.xlsx`).

/** The Content-Type of each file extension. */
const REPORT_MIME: Readonly<Record<ReportFileExt, string>> = Object.freeze({
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  zip: 'application/zip',
});

const isReportExt = (format: string): format is ReportFileExt => Object.hasOwn(REPORT_MIME, format);

/** What the route serves: the file, its size and name and type, and the facts of its audit entry. */
export interface ReportRunDownload {
  path: DataPath;
  size: number;
  fileName: string;
  mime: string;
  runId: string;
  reportId: string;
  format: ReportFormat;
}

function nothingToServe(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Berkas laporan tidak ditemukan / The report file was not found' });
}

/**
 * The file of a run its creator downloads now (the export permission held, a personal run freshly re-authenticated).
 *
 * @param dataDir the DATA_DIR the file lives under
 * @throws DomainError `NOT_FOUND` for a run the viewer cannot see, of a definition this build lacks, that did not
 *   succeed or whose file is missing (or of another size than the one it finished with); `AUTHZ_DENIED` for another
 *   staff member's run, or the creator without the export permission now; `AUTH_REAUTH_REQUIRED` for a personal run
 *   without a fresh re-authentication; `REPORT_RUN_EXPIRED` from `expires_at` on
 */
export async function openReportRunDownload(
  db: Kysely<DB>,
  id: string,
  viewer: ReportRunViewer & { reauthFresh: boolean; holds(p: Permission): boolean },
  now: number,
  dataDir: string,
): Promise<ReportRunDownload> {
  const row = await visibleRunRow(db, id, viewer);
  if (row === null) throw runNotFound();
  if (row.created_by !== viewer.staffId) {
    throw new DomainError('AUTHZ_DENIED', { detail: 'Hanya pembuatnya yang dapat mengunduh berkas ini / Only its creator can download this file' });
  }
  const def = reportById(row.report_id);
  if (def === null) throw runNotFound();
  if (!viewer.holds(exportPermissionOf(def))) throw new DomainError('AUTHZ_DENIED');
  if (Number(row.personal) === 1 && !viewer.reauthFresh) throw new DomainError('AUTH_REAUTH_REQUIRED');
  if (row.status !== 'succeeded' || !isReportExt(row.format)) throw nothingToServe();
  if (row.expires_at !== null && Number(row.expires_at) <= now) {
    throw new DomainError('REPORT_RUN_EXPIRED', { detail: 'Berkas laporan ini sudah kedaluwarsa / This report file has expired' });
  }
  const path = reportExportPath(dataDir, row.id, row.format);
  const stat = await statOrNull(path);
  if (stat === null || stat.kind !== 'file') throw nothingToServe();
  if (row.output_size !== null && Number(row.output_size) !== stat.size) throw nothingToServe();
  const locale = isLocale(row.locale) ? row.locale : 'id';
  const day = localDate(await libraryTimeZone(db), Number(row.created_at));
  return {
    path,
    size: stat.size,
    fileName: safeFileName(`${t(locale, def.titleKey as MessageKey)}-${day}.${row.format}`),
    mime: REPORT_MIME[row.format],
    runId: row.id,
    reportId: row.report_id,
    format: row.format,
  };
}
