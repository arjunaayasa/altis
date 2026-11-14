import type { FileHandle } from 'node:fs/promises';
import {
  contentDisposition,
  copySnapshotDossier,
  createJobRegistry,
  enqueueEvaluate,
  fileResponseHeaders,
  freezePeriod,
  getResults,
  getSnapshot,
  listSnapshots,
  loadAccredSettings,
  localStorageDriver,
  openSnapshotDossier,
  unfreezePeriod,
  type JobRegistry,
} from '@altis/core';
import { openRead } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { FreezeBody } from '@altis/shared/api/accreditation';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { byteRange, rangeStream } from '../../http/range.js';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { jobHandlers } from '../../jobs/runtime.js';

// The routes of a period's results, its evaluation, its freeze and reopening, and its snapshots (spec §5.2, §10.4,
// §10.10). Reading needs `accreditation.workspace.read`, freezing and reopening `accreditation.workspace.manage`;
// accreditation is library-wide in this edition, so no route has a branch.
//
//   GET  accreditation/periods/:id/results     the results with the score computed as they are read
//   POST accreditation/periods/:id/evaluate    queues the evaluation (`mode: read`: it changes no data of the library);
//                                              a live evaluation of the period is joined; 202 `{jobId, existing}`
//   POST accreditation/periods/:id/freeze      `store`; the freeze's own conditional update comes first; 201 `{id:
//                                              <snapshot>, version}`. After the COMMIT the newest whole evidence file
//                                              PDF finished after the results were computed is copied for the snapshot
//   POST accreditation/periods/:id/unfreeze    `store`, a fresh re-authentication; 200 `{id, version}`
//   GET  accreditation/periods/:id/snapshots   the snapshots, newest first
//   GET  accreditation/snapshots/:id           one snapshot with its compact values
//   GET  accreditation/snapshots/:id/dossier   the snapshot's evidence file copy: a fresh re-authentication (it names
//                                              the staff), `mode: system` like every download, a side-effect GET (HEAD
//                                              → 404, no cross-site request) with no transaction around the handler.
//                                              One `Range: bytes=a-b` → 206; whatever serves bytes appends one
//                                              `reports.run.download {snapshotId}`, committed before the first byte.

const API = '/api/v1/accreditation';
const PERIODS = `${API}/periods`;
const IdParams = z.strictObject({ id: ulidField });

let fallbackRegistry: JobRegistry | null = null;

/** The handlers the evaluation is queued with: the job runtime's, else (no runtime in this process yet) the handler array's. */
function registryOf(rc: RouteContext<unknown, unknown, unknown>): JobRegistry {
  const reg = rc.services.jobs?.registry;
  if (reg?.get('accreditation.evaluate') !== undefined) return reg;
  fallbackRegistry ??= createJobRegistry(jobHandlers());
  return fallbackRegistry;
}

const resultsGet = route({
  id: 'accreditation.results.get',
  method: 'GET',
  path: `${PERIODS}/:id/results`,
  permission: 'accreditation.workspace.read',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => ({ body: await getResults(rc.db.db, rc.params.id, await loadAccredSettings(rc.db.db), rc.now) }),
});

const evaluate = route({
  id: 'accreditation.periods.evaluate',
  method: 'POST',
  path: `${PERIODS}/:id/evaluate`,
  permission: 'accreditation.workspace.read',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => {
    const userId = rc.auth?.subjectId;
    if (userId === undefined) throw new DomainError('AUTH_REQUIRED');
    const body = await enqueueEvaluate(rc.tx().trx, rc.params.id, { now: rc.now, createdBy: userId, registry: registryOf(rc), keyring: rc.config.keyring });
    rc.afterCommit(() => rc.services.jobs?.kick());
    return { status: 202, body };
  },
});

const freeze = route({
  id: 'accreditation.periods.freeze',
  method: 'POST',
  path: `${PERIODS}/:id/freeze`,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.period.freeze',
  params: IdParams,
  body: FreezeBody,
  handler: async (rc) => {
    const body = await freezePeriod(rc.tx(), rc.params.id, rc.body, rc.now);
    const dataDir = rc.services.dataDir;
    rc.afterCommit(async () => {
      await copySnapshotDossier(rc.db, body.id, { dataDir, storage: localStorageDriver(dataDir), now: rc.now, log: rc.log });
    });
    return { status: 201, body };
  },
});

const unfreeze = route({
  id: 'accreditation.periods.unfreeze',
  method: 'POST',
  path: `${PERIODS}/:id/unfreeze`,
  permission: 'accreditation.workspace.manage',
  reauth: true,
  idempotency: 'store',
  audit: 'accreditation.period.unfreeze',
  params: IdParams,
  handler: async (rc) => ({ body: await unfreezePeriod(rc.tx(), rc.params.id, rc.now) }),
});

const snapshotsList = route({
  id: 'accreditation.snapshots.list',
  method: 'GET',
  path: `${PERIODS}/:id/snapshots`,
  permission: 'accreditation.workspace.read',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => ({ body: await listSnapshots(rc.db.db, rc.params.id) }),
});

const snapshotsGet = route({
  id: 'accreditation.snapshots.get',
  method: 'GET',
  path: `${API}/snapshots/:id`,
  permission: 'accreditation.workspace.read',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => ({ body: await getSnapshot(rc.db.db, rc.params.id) }),
});

function fileGone(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Berkas bukti snapshot tidak ditemukan / The snapshot evidence file was not found' });
}

const snapshotsDossier = route({
  id: 'accreditation.snapshots.dossier',
  method: 'GET',
  path: `${API}/snapshots/:id/dossier`,
  permission: 'accreditation.workspace.read',
  reauth: true,
  mode: 'system',
  idempotency: 'none',
  audit: 'reports.run.download',
  params: IdParams,
  handler: async (rc) => {
    const file = await openSnapshotDossier(rc.db.db, rc.params.id, rc.services.dataDir);
    let handle: FileHandle;
    try {
      handle = await openRead(file.path);
    } catch (error) {
      const errno = (error as { code?: unknown } | null)?.code;
      if (errno === 'ENOENT' || errno === 'ENOTDIR') throw fileGone();
      throw error;
    }
    try {
      const size = (await handle.stat()).size;
      // A file of another size than the one recorded is not the copy that was made: never served.
      if (size !== file.size) throw fileGone();
      const etag = `"${file.snapshotId}-${size}"`;
      const headers: Record<string, string> = {
        ...fileResponseHeaders({ originalName: file.fileName, mime: file.mime, size }),
        'Content-Disposition': contentDisposition('attachment', file.fileName),
        'Accept-Ranges': 'bytes',
        ETag: etag,
      };
      const range = size === 0 ? null : byteRange(rc.c.req.header('range'), rc.c.req.header('if-range'), etag, size);
      // Thrown, not answered: a response the handler returns carries the route's one audit entry, and a refusal serves
      // nothing.
      if (range === 'unsatisfiable') {
        throw new DomainError('RANGE_NOT_SATISFIABLE', {
          detail: `Rentang di luar berkas ${size} byte / The range lies outside the ${size}-byte file`,
        });
      }
      const [first, last] = range ?? [0, size - 1];
      // Committed before the first byte: a download that sends anything is always in the log.
      await rc.audit({ entity: 'accred_snapshots', entityId: file.snapshotId, meta: { snapshotId: file.snapshotId } });
      headers['Content-Length'] = String(Math.max(0, last - first + 1));
      if (range !== null) headers['Content-Range'] = `bytes ${first}-${last}/${size}`;
      return new Response(rangeStream(handle, first, last), { status: range === null ? 200 : 206, headers });
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  },
});

export const RESULT_ROUTES: RouteDecl[] = [resultsGet, evaluate, freeze, unfreeze, snapshotsList, snapshotsGet, snapshotsDossier];
