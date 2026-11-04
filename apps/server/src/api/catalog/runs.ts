import type { FileHandle } from 'node:fs/promises';
import {
  can,
  createJobRegistry,
  fileResponseHeaders,
  getRunView,
  listRuns,
  localStorageDriver,
  runExportFile,
  runReportFile,
  startDedupeScan,
  DEDUPE_SCAN_JOB,
  type JobRegistry,
  type RunViewer,
} from '@altis/core';
import { exportFilePath, openRead, type ExportFileExt } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import { DedupeScanBody, RunListQuery, type RunListResponse, type RunStarted, type RunView } from '@altis/shared/api/catalog/runs';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { jobHandlers } from '../../jobs/runtime.js';
import { byteRange } from '../backups.js';

// The catalog API routes of catalog runs and the duplicate scan (Phase 2 spec §3.3, §5.4, §12.2, §12.3; plan Task 19,
// route catalog; decisions P2-12, P2-23, P2-27):
//
//   GET  catalog/runs                 `catalog.records.read`: newest first (keyset, `?kind=`); migration runs only for
//                                     a holder of `catalog.migration.run` (P2-27)
//   GET  catalog/runs/:id             `catalog.records.read`: one run (a migration run is 404 without that permission)
//   GET  catalog/runs/:id/report      `catalog.records.read`, `mode: system`: the run's CSV report (a staff `files` row,
//                                     context `catalog.report`, never served by `/files/:id`, S18), as an attachment
//   GET  catalog/runs/:id/download    `catalog.export.run`, `mode: system`, a side-effect GET (its audit; HEAD → 404,
//                                     no cross-site request): an export's file `exports/<runId>.<ext>` as an attachment,
//                                     one `Range: bytes=a-b` (or `a-`, `-n`) → 206, past the end → 416
//                                     RANGE_NOT_SATISFIABLE (thrown: no entry, so no `Content-Range: bytes */<size>`
//                                     either), several or malformed ranges, and any range of an empty file, ignored
//                                     (RFC 9110 §14.2),
//                                     `ETag "<runId>-<size>"`; from `expires_at` on → 410 CATALOG_RUN_EXPIRED, without
//                                     a file yet → 404. Each response that serves bytes (200 or 206) appends one
//                                     `catalog.export.download {format, bytes}` (the bytes it serves), committed before
//                                     the first byte goes out; a refusal appends none.
//   POST catalog/dedupe-scans         `catalog.records.manage`, `store`: a `dedupe_scan` run and its job
//                                     `catalog.dedupe_scan` (unique key `catalog.dedupe_scan`: while a scan is live, a
//                                     second request joins it) → 202 RunStarted; the worker is woken after the COMMIT.

const RUNS = '/api/v1/catalog/runs';
const RunParams = z.strictObject({ id: ulidField });
/** A file is read in pieces of this size, each only once the client took the previous one. */
const DOWNLOAD_CHUNK_BYTES = 256 * 1024;

/** The Content-Type of each export file extension. */
const EXPORT_MIME: Readonly<Record<ExportFileExt, string>> = Object.freeze({
  mrc: 'application/marc',
  xml: 'application/marcxml+xml; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
});

/** What the request's user may see of runs (P2-27): a route with a permission runs with a session. */
function viewerOf(rc: RouteContext<unknown, unknown, unknown>): RunViewer {
  if (rc.auth === null) throw new DomainError('AUTH_REQUIRED');
  return { migration: can(rc.auth.grants, 'catalog.migration.run') };
}

function exportGone(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Berkas ekspor tidak ditemukan / The export file was not found' });
}

let fallbackRegistry: JobRegistry | null = null;

/** The handlers the scan is enqueued with: the job runtime's, else (no runtime in this process yet) the handler array's. */
function registryOf(rc: RouteContext<unknown, unknown, unknown>): JobRegistry {
  const reg = rc.services.jobs?.registry;
  if (reg?.get(DEDUPE_SCAN_JOB) !== undefined) return reg;
  fallbackRegistry ??= createJobRegistry(jobHandlers());
  return fallbackRegistry;
}

/**
 * Bytes `first` to `last` of `handle`, read only as the client takes them (highWaterMark 0); the handle is closed at
 * the end, on an error, or when the client goes.
 */
function rangeStream(handle: FileHandle, first: number, last: number): ReadableStream<Uint8Array> {
  let position = first;
  let open = true;
  const close = async (): Promise<void> => {
    if (!open) return;
    open = false;
    await handle.close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const left = last + 1 - position;
          if (left <= 0) {
            await close();
            controller.close();
            return;
          }
          const buffer = new Uint8Array(Math.min(DOWNLOAD_CHUNK_BYTES, left));
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
          if (bytesRead === 0) throw new Error('the export file is shorter than its size');
          position += bytesRead;
          controller.enqueue(buffer.subarray(0, bytesRead));
        } catch (error) {
          await close();
          controller.error(error);
        }
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
}

/** `source` as a web stream; cancelling the stream (a client gone) ends the iteration, which closes the file. */
function streamOf(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await it.next();
      if (done === true) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await it.return?.();
    },
  });
}

const runsList = route({
  id: 'catalog.runs.list',
  method: 'GET',
  path: RUNS,
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  query: RunListQuery,
  handler: async (rc) => {
    const body: RunListResponse = await listRuns(rc.db.db, rc.query, viewerOf(rc));
    return { body };
  },
});

const runsGet = route({
  id: 'catalog.runs.get',
  method: 'GET',
  path: `${RUNS}/:id`,
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  params: RunParams,
  handler: async (rc) => {
    const body: RunView = await getRunView(rc.db.db, rc.params.id, viewerOf(rc));
    return { body };
  },
});

/** GET catalog/runs/:id/report: the run's CSV report; a HEAD answers the headers without opening the file. */
const runsReport = route({
  id: 'catalog.runs.report',
  method: 'GET',
  path: `${RUNS}/:id/report`,
  permission: 'catalog.records.read',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  params: RunParams,
  handler: async (rc) => {
    const file = await runReportFile(rc.db.db, rc.params.id, viewerOf(rc));
    const driver = localStorageDriver(rc.services.dataDir);
    const stored = await driver.stat(file.fileId);
    if (stored === null || stored.size !== file.size) {
      throw new DomainError('NOT_FOUND', { detail: 'Laporan proses tidak ditemukan / The run report was not found' });
    }
    const headers = fileResponseHeaders({ originalName: file.originalName, mime: 'text/csv; charset=utf-8', size: file.size });
    if (rc.c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
    const content = await driver.get(file.fileId);
    if (content === null) throw new DomainError('NOT_FOUND', { detail: 'Laporan proses tidak ditemukan / The run report was not found' });
    return new Response(streamOf(content), { status: 200, headers });
  },
});

const runsDownload = route({
  id: 'catalog.runs.download',
  method: 'GET',
  path: `${RUNS}/:id/download`,
  permission: 'catalog.export.run',
  mode: 'system',
  idempotency: 'none',
  audit: 'catalog.export.download',
  params: RunParams,
  handler: async (rc) => {
    const run = await runExportFile(rc.db.db, rc.params.id, rc.now);
    let handle: FileHandle;
    try {
      handle = await openRead(exportFilePath(rc.services.dataDir, run.runId, run.ext));
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw exportGone();
      throw error;
    }
    try {
      const size = (await handle.stat()).size;
      // A file of another size than the one the export finished with is not that export's (a write in progress, a
      // leftover): never served.
      if (run.size !== null && size !== run.size) throw exportGone();
      const etag = `"${run.runId}-${size}"`;
      const headers: Record<string, string> = {
        ...fileResponseHeaders({ originalName: `altis-katalog-${run.runId}.${run.ext}`, mime: EXPORT_MIME[run.ext], size }),
        'Accept-Ranges': 'bytes',
        ETag: etag,
      };
      // An empty file has no byte a range could name: it is served whole (RFC 9110 §14.2 lets a server ignore Range).
      const range = size === 0 ? null : byteRange(rc.c.req.header('range'), rc.c.req.header('if-range'), etag, size);
      // Thrown, not answered: a response the handler returns must carry the route's one audit entry, and a refusal
      // serves nothing (so it has no `Content-Range: bytes */<size>`; the detail names the size).
      if (range === 'unsatisfiable') {
        throw new DomainError('RANGE_NOT_SATISFIABLE', {
          detail: `Rentang di luar berkas ${size} byte / The range lies outside the ${size}-byte file`,
        });
      }
      const [first, last] = range ?? [0, size - 1];
      const bytes = Math.max(0, last - first + 1);
      // Committed before the first byte: a download that sends anything is always in the log.
      await rc.audit({ entity: 'catalog_runs', entityId: run.runId, meta: { format: run.format, bytes } });
      headers['Content-Length'] = String(bytes);
      if (range !== null) headers['Content-Range'] = `bytes ${first}-${last}/${size}`;
      return new Response(rangeStream(handle, first, last), { status: range === null ? 200 : 206, headers });
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  },
});

const dedupeScansCreate = route({
  id: 'catalog.dedupe_scans.create',
  method: 'POST',
  path: '/api/v1/catalog/dedupe-scans',
  permission: 'catalog.records.manage',
  idempotency: 'store',
  audit: null,
  body: DedupeScanBody,
  handler: async (rc) => {
    const body: RunStarted = await startDedupeScan(rc.tx(), registryOf(rc), { keyring: rc.config.keyring });
    rc.afterCommit(() => rc.services.jobs?.kick());
    return { status: 202, body };
  },
});

export const RUNS_ROUTES: RouteDecl[] = [runsList, runsGet, runsReport, runsDownload, dedupeScansCreate];
