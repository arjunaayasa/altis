import type { FileHandle } from 'node:fs/promises';
import {
  can,
  contentDisposition,
  createJobRegistry,
  fileResponseHeaders,
  getReportRun,
  listReportRuns,
  openReportRunDownload,
  reportById,
  startReportRun,
  type JobRegistry,
  type ReportDefinition,
  type ReportRunViewer,
} from '@altis/core';
import { openRead } from '@altis/platform';
import { DomainError, type Locale } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import {
  ReportRunCreateBody,
  ReportRunListQuery,
  type ReportRunListResponse,
  type ReportRunStarted,
  type ReportRunView,
} from '@altis/shared/api/reports';
import { z } from 'zod';
import { byteRange, rangeStream } from '../../http/range.js';
import { hasRecentReauth } from '../../http/reauth-check.js';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { jobHandlers } from '../../jobs/runtime.js';
import { definitionOf, holdsOf, outputLocaleOf } from './catalog.js';

// The report runs (spec §4.15, §5.2, §13 "Ekspor"):
//
//   POST reports/runs                 any signed-in staff member holding the definition's export permission (checked
//                                     in `prepare`, outside the transaction); `mode: system`, `store`, audit
//                                     `reports.run.start {runId, reportId, format}` (never a parameter value): a run of
//                                     a table report that holds no personal data, and its export job → {id, jobId}.
//                                     A personal report is refused here (`personal_report`: it has its own route), a
//                                     document too (`document_report`: the accreditation routes make documents).
//   POST reports/runs/personal        the same for a table report that holds personal data, behind a fresh
//                                     re-authentication (declared); any other report is `not_personal`.
//   GET  reports/runs                 any signed-in staff member: their own runs, newest first; with the jobs
//                                     permission (`system.jobs.read`) and `?scope=all`, every run, others' without
//                                     their parameters
//   GET  reports/runs/:id             one run, the same visibility (another's run without the jobs permission: 404)
//   GET  reports/runs/:id/download    the run's creator only, holding the definition's export permission now; a
//                                     personal run also wants a re-authentication within the usual window. A
//                                     side-effect GET (its audit; HEAD → 404, no cross-site request), `mode: system`,
//                                     no transaction of its own around the handler. One `Range: bytes=a-b` → 206, past
//                                     the end → 416; from `expires_at` on 410 REPORT_RUN_EXPIRED. Each response that
//                                     serves bytes appends one `reports.run.download {runId, reportId, format}`,
//                                     committed before the first byte; a refusal appends none.

const RUNS = '/api/v1/reports/runs';
/** The job that writes a run's file. */
const REPORTS_EXPORT_JOB = 'reports.export';
const RunParams = z.strictObject({ id: ulidField });

/** What `prepare` hands the start handler. */
interface StartPrepared {
  def: ReportDefinition;
  locale: Locale;
}

let fallbackRegistry: JobRegistry | null = null;

/** The handlers a run is enqueued with: the job runtime's, else (no runtime in this process yet) the handler array's. */
function registryOf(rc: RouteContext<unknown, unknown, unknown>): JobRegistry {
  const reg = rc.services.jobs?.registry;
  if (reg?.get(REPORTS_EXPORT_JOB) !== undefined) return reg;
  fallbackRegistry ??= createJobRegistry(jobHandlers());
  return fallbackRegistry;
}

/** A refusal of the body's report on this route. */
function wrongRoute(code: 'personal_report' | 'not_personal' | 'document_report'): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Laporan ini tidak diekspor lewat rute ini / This report is not exported through this route',
    meta: { errors: [{ path: 'reportId', code }] },
  });
}

/** The checks of both start routes, outside the transaction: the definition, its export permission, the route. */
function prepareStart(personal: boolean) {
  return async (rc: RouteContext<ReportRunCreateBody, unknown, unknown>): Promise<StartPrepared> => {
    const def = definitionOf(rc.body.reportId);
    const permission = def.exportPermission ?? def.permission;
    if (!holdsOf(rc)(permission)) throw await rc.authzDenied(permission);
    if (def.kind === 'document') throw wrongRoute('document_report');
    if (def.personal !== personal) throw wrongRoute(personal ? 'not_personal' : 'personal_report');
    return { def, locale: await outputLocaleOf(rc, def) };
  };
}

/** The start of a run (both routes), in the handler transaction. */
async function startHandler(rc: RouteContext<ReportRunCreateBody, unknown, unknown>): Promise<{ status: number; body: ReportRunStarted }> {
  const { def, locale } = rc.prepared as StartPrepared;
  const userId = rc.auth?.subjectId;
  if (userId === undefined) throw new DomainError('AUTH_REQUIRED');
  const b = rc.body;
  const body = await startReportRun(rc.tx().trx, def, {
    format: b.format,
    params: b.params,
    locale,
    createdBy: userId,
    now: rc.now,
    registry: registryOf(rc),
    keyring: rc.config.keyring,
    ...(b.pdf === undefined ? {} : { pdf: b.pdf }),
  });
  await rc.audit({ entity: 'report_runs', entityId: body.id, meta: { runId: body.id, reportId: def.id, format: b.format } });
  rc.afterCommit(() => rc.services.jobs?.kick());
  return { status: 200, body };
}

const runsCreate = route({
  id: 'reports.runs.create',
  method: 'POST',
  path: RUNS,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'store',
  audit: 'reports.run.start',
  body: ReportRunCreateBody,
  prepare: prepareStart(false),
  handler: startHandler,
});

const runsCreatePersonal = route({
  id: 'reports.runs.create_personal',
  method: 'POST',
  path: `${RUNS}/personal`,
  public: true,
  session: 'required',
  reauth: true,
  mode: 'system',
  idempotency: 'store',
  audit: 'reports.run.start',
  body: ReportRunCreateBody,
  prepare: prepareStart(true),
  handler: startHandler,
});

/** Who the request's user is as a viewer of runs: their own, and everyone's with the jobs permission. */
function viewerOf(rc: RouteContext<unknown, unknown, unknown>): ReportRunViewer {
  if (rc.auth === null) throw new DomainError('AUTH_REQUIRED');
  return { staffId: rc.auth.subjectId, seeAll: can(rc.auth.grants, 'system.jobs.read') };
}

/** `view` as the user sees it now: downloadable only before it expires and while they hold the export permission. */
function asSeenNow(rc: RouteContext<unknown, unknown, unknown>, view: ReportRunView): ReportRunView {
  if (!view.downloadable) return view;
  const holds = holdsOf(rc);
  const def = reportById(view.reportId);
  const expired = view.expiresAt !== null && view.expiresAt <= rc.now;
  const downloadable = def !== null && !expired && holds(def.exportPermission ?? def.permission);
  return downloadable ? view : { ...view, downloadable: false };
}

const runsList = route({
  id: 'reports.runs.list',
  method: 'GET',
  path: RUNS,
  public: true,
  session: 'required',
  idempotency: 'none',
  audit: null,
  query: ReportRunListQuery,
  handler: async (rc) => {
    const page = await listReportRuns(rc.db.db, viewerOf(rc), rc.query);
    const body: ReportRunListResponse = { runs: page.runs.map((view) => asSeenNow(rc, view)), nextCursor: page.nextCursor };
    return { body };
  },
});

const runsGet = route({
  id: 'reports.runs.get',
  method: 'GET',
  path: `${RUNS}/:id`,
  public: true,
  session: 'required',
  idempotency: 'none',
  audit: null,
  params: RunParams,
  handler: async (rc) => {
    const body: ReportRunView = asSeenNow(rc, await getReportRun(rc.db.db, rc.params.id, viewerOf(rc)));
    return { body };
  },
});

function fileGone(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Berkas laporan tidak ditemukan / The report file was not found' });
}

const runsDownload = route({
  id: 'reports.runs.download',
  method: 'GET',
  path: `${RUNS}/:id/download`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: 'reports.run.download',
  params: RunParams,
  handler: async (rc) => {
    const viewer = viewerOf(rc);
    const holds = holdsOf(rc);
    const file = await openReportRunDownload(rc.db.db, rc.params.id, { ...viewer, reauthFresh: hasRecentReauth(rc), holds }, rc.now, rc.services.dataDir);
    let handle: FileHandle;
    try {
      handle = await openRead(file.path);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw fileGone();
      throw error;
    }
    try {
      const size = (await handle.stat()).size;
      // A file of another size than the one the run looked at is not the run's (replaced meanwhile): never served.
      if (size !== file.size) throw fileGone();
      const etag = `"${file.runId}-${size}"`;
      const headers: Record<string, string> = {
        ...fileResponseHeaders({ originalName: file.fileName, mime: file.mime, size }),
        'Content-Disposition': contentDisposition('attachment', file.fileName),
        'Accept-Ranges': 'bytes',
        ETag: etag,
      };
      // An empty file has no byte a range could name: it is served whole (RFC 9110 §14.2 lets a server ignore Range).
      const range = size === 0 ? null : byteRange(rc.c.req.header('range'), rc.c.req.header('if-range'), etag, size);
      // Thrown, not answered: a response the handler returns carries the route's one audit entry, and a refusal serves
      // nothing.
      if (range === 'unsatisfiable') {
        throw new DomainError('RANGE_NOT_SATISFIABLE', {
          detail: `Rentang di luar berkas ${size} byte / The range lies outside the ${size}-byte file`,
        });
      }
      const [first, last] = range ?? [0, size - 1];
      const bytes = Math.max(0, last - first + 1);
      // Committed before the first byte: a download that sends anything is always in the log.
      await rc.audit({ entity: 'report_runs', entityId: file.runId, meta: { runId: file.runId, reportId: file.reportId, format: file.format } });
      headers['Content-Length'] = String(bytes);
      if (range !== null) headers['Content-Range'] = `bytes ${first}-${last}/${size}`;
      return new Response(rangeStream(handle, first, last), { status: range === null ? 200 : 206, headers });
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  },
});

export const REPORT_RUN_ROUTES: RouteDecl[] = [runsCreate, runsCreatePersonal, runsList, runsGet, runsDownload];
