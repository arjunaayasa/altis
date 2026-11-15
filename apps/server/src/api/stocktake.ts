import {
  can,
  cancelStocktake,
  createJobRegistry,
  createStocktake,
  finishStocktake,
  getStocktake,
  listStocktakeItems,
  listStocktakes,
  listStocktakeUnknown,
  localStorageDriver,
  scanStocktake,
  stocktakeMinutes,
  stocktakeOfficers,
  assertStocktakeOfBranch,
  undoStocktakeScan,
  uploadStocktakeCodes,
  type JobRegistry,
  type StocktakeJobDeps,
} from '@altis/core';
import { DomainError } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import {
  StocktakeCreateBody,
  StocktakeFinishBody,
  StocktakeItemsQuery,
  StocktakeScanBody,
  StocktakeUnknownQuery,
  StocktakeUploadBody,
  type StocktakeActionResponse,
  type StocktakeCreateResponse,
  type StocktakeItemsResponse,
  type StocktakeJobResponse,
  type StocktakeListResponse,
  type StocktakeOfficersResponse,
  type StocktakeScanResponse,
  type StocktakeUndoResponse,
  type StocktakeUnknownResponse,
  type StocktakeView,
} from '@altis/shared/api/stocktake';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { jobHandlers } from '../jobs/runtime.js';

// Stocktake (inventarisasi) at a branch: `stocktake.scan.use` at `:branchId` unless named otherwise.
//
//   GET    branches/:branchId/stocktakes                              → StocktakeListResponse
//   POST   branches/:branchId/stocktakes                              StocktakeCreateBody → 201        sessions.manage   stocktake.session.create
//   GET    branches/:branchId/stocktakes/:id                          → StocktakeView
//   GET    branches/:branchId/stocktakes/:id/items                    StocktakeItemsQuery → page
//   GET    branches/:branchId/stocktakes/:id/unknown-codes            StocktakeUnknownQuery → page
//   GET    branches/:branchId/stocktakes/:id/officers                 → StocktakeOfficersResponse
//   POST   branches/:branchId/stocktakes/:id/scans                    StocktakeScanBody → StocktakeScanResponse (store)
//   DELETE branches/:branchId/stocktakes/:id/scans/:itemId            → StocktakeUndoResponse (none; another officer's
//                                                                       scan needs sessions.manage and is audited
//                                                                       stocktake.scan.cancel_other)
//   POST   branches/:branchId/stocktakes/:id/uploads                  StocktakeUploadBody → 202        stocktake.upload
//   POST   branches/:branchId/stocktakes/:id/finish                   StocktakeFinishBody → 202        sessions.manage, reauth   stocktake.session.finish
//   POST   branches/:branchId/stocktakes/:id/cancel                   → StocktakeActionResponse        sessions.manage   stocktake.session.cancel
//   GET    branches/:branchId/stocktakes/:id/minutes                  → application/pdf (mode system: a download): the
//                                                                       file stored at the finish, else built now
//
// A session named by id must be of the branch in the path; any other is 404, as one that does not exist.

const API = '/api/v1/branches/:branchId/stocktakes';
const BranchParams = z.strictObject({ branchId: ulidField });
const IdParams = z.strictObject({ branchId: ulidField, id: ulidField });
const ScanParams = z.strictObject({ branchId: ulidField, id: ulidField, itemId: ulidField });

let fallbackRegistry: JobRegistry | null = null;

/** The handlers a stocktake job is queued with: the job runtime's, else (no runtime in this process yet) the handler array's. */
function jobDeps(rc: RouteContext<unknown, unknown, unknown>): StocktakeJobDeps {
  const reg = rc.services.jobs?.registry;
  const registry = reg?.get('stocktake.prepare') !== undefined ? reg : (fallbackRegistry ??= createJobRegistry(jobHandlers()));
  return { registry, keyring: rc.config.keyring };
}

const list = route({
  id: 'stocktake.sessions.list',
  method: 'GET',
  path: API,
  permission: 'stocktake.scan.use',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: null,
  params: BranchParams,
  handler: async (rc) => {
    const body: StocktakeListResponse = await listStocktakes(rc.db.db, rc.params.branchId);
    return { body };
  },
});

const create = route({
  id: 'stocktake.sessions.create',
  method: 'POST',
  path: API,
  permission: 'stocktake.sessions.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'stocktake.session.create',
  params: BranchParams,
  body: StocktakeCreateBody,
  handler: async (rc) => {
    const body: StocktakeCreateResponse = await createStocktake(rc.tx(), rc.params.branchId, rc.body, jobDeps(rc));
    rc.afterCommit(() => rc.services.jobs?.kick());
    return { status: 201, body };
  },
});

const get = route({
  id: 'stocktake.sessions.get',
  method: 'GET',
  path: `${API}/:id`,
  permission: 'stocktake.scan.use',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => {
    const body: StocktakeView = await getStocktake(rc.db.db, rc.params.branchId, rc.params.id);
    return { body };
  },
});

const items = route({
  id: 'stocktake.sessions.items',
  method: 'GET',
  path: `${API}/:id/items`,
  permission: 'stocktake.scan.use',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  query: StocktakeItemsQuery,
  handler: async (rc) => {
    const body: StocktakeItemsResponse = await listStocktakeItems(rc.db.db, rc.params.branchId, rc.params.id, rc.query);
    return { body };
  },
});

const unknownCodes = route({
  id: 'stocktake.sessions.unknown_codes',
  method: 'GET',
  path: `${API}/:id/unknown-codes`,
  permission: 'stocktake.scan.use',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  query: StocktakeUnknownQuery,
  handler: async (rc) => {
    const body: StocktakeUnknownResponse = await listStocktakeUnknown(rc.db.db, rc.params.branchId, rc.params.id, rc.query);
    return { body };
  },
});

const officers = route({
  id: 'stocktake.sessions.officers',
  method: 'GET',
  path: `${API}/:id/officers`,
  permission: 'stocktake.scan.use',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => {
    await assertStocktakeOfBranch(rc.db.db, rc.params.branchId, rc.params.id);
    const body: StocktakeOfficersResponse = await stocktakeOfficers(rc.db.db, rc.params.id);
    return { body };
  },
});

const scan = route({
  id: 'stocktake.scans.create',
  method: 'POST',
  path: `${API}/:id/scans`,
  permission: 'stocktake.scan.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: null,
  params: IdParams,
  body: StocktakeScanBody,
  handler: async (rc) => {
    const body: StocktakeScanResponse = await scanStocktake(rc.tx(), {
      branchId: rc.params.branchId,
      id: rc.params.id,
      barcode: rc.body.barcode,
      ...(rc.body.locationId === undefined ? {} : { locationId: rc.body.locationId }),
    });
    return { body };
  },
});

const undo = route({
  id: 'stocktake.scans.delete',
  method: 'DELETE',
  path: `${API}/:id/scans/:itemId`,
  permission: 'stocktake.scan.use',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: null,
  alsoAudits: ['stocktake.scan.cancel_other'],
  params: ScanParams,
  handler: async (rc) => {
    const auth = rc.auth;
    if (auth === null) throw new DomainError('AUTH_REQUIRED');
    const body: StocktakeUndoResponse = await undoStocktakeScan(rc.tx(), {
      branchId: rc.params.branchId,
      id: rc.params.id,
      itemId: rc.params.itemId,
      mayUndoOthers: can(auth.grants, 'stocktake.sessions.manage', rc.params.branchId),
    });
    return { body };
  },
});

const upload = route({
  id: 'stocktake.uploads.create',
  method: 'POST',
  path: `${API}/:id/uploads`,
  permission: 'stocktake.scan.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'stocktake.upload',
  params: IdParams,
  body: StocktakeUploadBody,
  handler: async (rc) => {
    const body: StocktakeJobResponse = await uploadStocktakeCodes(
      rc.tx(),
      {
        branchId: rc.params.branchId,
        id: rc.params.id,
        uploadId: rc.body.uploadId,
        ...(rc.body.locationId === undefined ? {} : { locationId: rc.body.locationId }),
        dataDir: rc.services.dataDir,
      },
      jobDeps(rc),
    );
    rc.afterCommit(() => rc.services.jobs?.kick());
    return { status: 202, body };
  },
});

const finish = route({
  id: 'stocktake.sessions.finish',
  method: 'POST',
  path: `${API}/:id/finish`,
  permission: 'stocktake.sessions.manage',
  branchParam: 'branchId',
  reauth: true,
  idempotency: 'store',
  audit: 'stocktake.session.finish',
  params: IdParams,
  body: StocktakeFinishBody,
  handler: async (rc) => {
    const body: StocktakeJobResponse = await finishStocktake(rc.tx(), rc.params.branchId, rc.params.id, rc.body, jobDeps(rc));
    rc.afterCommit(() => rc.services.jobs?.kick());
    return { status: 202, body };
  },
});

const cancel = route({
  id: 'stocktake.sessions.cancel',
  method: 'POST',
  path: `${API}/:id/cancel`,
  permission: 'stocktake.sessions.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'stocktake.session.cancel',
  params: IdParams,
  handler: async (rc) => {
    const body: StocktakeActionResponse = await cancelStocktake(rc.tx(), rc.params.branchId, rc.params.id);
    return { body };
  },
});

const minutes = route({
  id: 'stocktake.sessions.minutes',
  method: 'GET',
  path: `${API}/:id/minutes`,
  permission: 'stocktake.scan.use',
  branchParam: 'branchId',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => {
    const pdf = await stocktakeMinutes(rc.db.db, localStorageDriver(rc.services.dataDir), rc.params.branchId, rc.params.id);
    return new Response(pdf.bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${pdf.name}"`,
        'Content-Length': String(pdf.bytes.byteLength),
        'Cache-Control': 'private, no-store',
      },
    });
  },
});

export const STOCKTAKE_ROUTES: RouteDecl[] = [list, create, get, items, unknownCodes, officers, scan, undo, upload, finish, cancel, minutes];
