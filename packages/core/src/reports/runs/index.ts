// Stub: replaced by a later change in this milestone.
// The report runs: the catalogue a user sees, the paged preview, the start of an export, the run views and the
// download. The signatures are final; every body throws until the runs are written.
/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters of the final signatures are not read yet */
import type { DB } from '@altis/db';
import type { DataPath } from '@altis/platform';
import type { Locale, Permission, ReportFormat } from '@altis/shared';
import type {
  ReportCatalogEntry,
  ReportPreviewBody,
  ReportPreviewResponse,
  ReportRunListQuery,
  ReportRunListResponse,
  ReportRunStarted,
  ReportRunView,
} from '@altis/shared/api/reports';
import type { Kysely, Transaction } from 'kysely';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import type { JobRegistry } from '../../jobs/types.js';
import type { AccredSettings } from '../../settings/accreditation.js';
import type { ReportDefinition } from '../types.js';

/** Who looks at runs: their own runs in full; with `seeAll` (the jobs permission) every run, others' without params. */
export type ReportRunViewer = { staffId: string; seeAll: boolean };

function notImplemented(): never {
  throw new Error('not implemented yet');
}

/** The definitions whose `permission` the user holds. */
export function visibleReports(holds: (p: Permission) => boolean): ReportDefinition[] {
  return notImplemented();
}

/** A definition as the catalogue lists it for a user (`canExport` from the export permission). */
export function reportCatalogEntry(def: ReportDefinition, holds: (p: Permission) => boolean): ReportCatalogEntry {
  return notImplemented();
}

/** One preview page of a table definition (no audit). */
export async function previewReport(
  db: Kysely<DB>,
  def: ReportDefinition,
  body: ReportPreviewBody,
  o: { locale: Locale; tz: string; now: number; settings: AccredSettings },
): Promise<ReportPreviewResponse> {
  return notImplemented();
}

/** Creates a run of `def` and its export job, in the caller's transaction. */
export async function startReportRun(
  trx: Transaction<DB>,
  def: ReportDefinition,
  o: {
    format: ReportFormat;
    params: Record<string, unknown>;
    locale: Locale;
    createdBy: string;
    now: number;
    registry: JobRegistry;
    keyring: readonly KeyringEntry[];
    pdf?: { paper: 'A4' | 'F4' };
  },
): Promise<ReportRunStarted> {
  return notImplemented();
}

/** The runs `viewer` may see, newest first. */
export async function listReportRuns(db: Kysely<DB>, viewer: ReportRunViewer, q: ReportRunListQuery): Promise<ReportRunListResponse> {
  return notImplemented();
}

/** One run `viewer` may see. */
export async function getReportRun(db: Kysely<DB>, id: string, viewer: ReportRunViewer): Promise<ReportRunView> {
  return notImplemented();
}

/** The file of a run its creator downloads now (the export permission held, a personal run freshly re-authenticated). */
export async function openReportRunDownload(
  db: Kysely<DB>,
  id: string,
  viewer: ReportRunViewer & { reauthFresh: boolean; holds(p: Permission): boolean },
  now: number,
): Promise<{ path: DataPath; size: number; fileName: string; mime: string; runId: string }> {
  return notImplemented();
}
