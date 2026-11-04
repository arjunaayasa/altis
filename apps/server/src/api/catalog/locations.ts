import {
  archiveLocation,
  createJobRegistry,
  createLocation,
  enqueueLocationReindex,
  listLocations,
  setLocationMap,
  updateLocation,
  type JobRegistry,
} from '@altis/core';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import {
  LocationBody,
  LocationListQuery,
  LocationMapBody,
  LocationPatchBody,
  type LocationListResponse,
  type LocationUpdateResponse,
} from '@altis/shared/api/catalog/locations';
import { ulidField, versionField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { jobHandlers } from '../../jobs/runtime.js';

// The catalog API routes of locations and shelf maps (Phase 2 spec §2.2 `locations`, §3.6, §12.2, §12.3; plan Task
// 14, route catalog): the list, and the branch-scoped writes create, update, archive and map.
//
// - The list needs `catalog.records.read` (every branch's tree, or one with `?branchId=`). The writes need
//   `catalog.locations.manage` at the branch of the path (`branches/:branchId/…`, `branchParam: 'branchId'`, so 1d's
//   branch-limit gate works on them unchanged, §12.3); the services answer NOT_FOUND for a location of another branch.
// - The writes are `store` routes and answer `StoreResponse` (`{id, version}`), never the view (S15); the screen reads
//   the tree again with GET. A create answers 201. Archive takes the row's `version` in its body (`{version}`). An
//   update that moved a location to another room also names the locations whose map box it cleared
//   (`LocationUpdateResponse.boxesCleared`, Task 40).
// - The services audit in the handler's transaction (one entry each, `catalog.master.*` with entity `locations`; the
//   map is an update).
// - A patch that moves a location or changes whether it is public queues the reindex of the records shelved below it
//   in the same transaction (§4.6 facets `lc` and `av`) and wakes the worker after the commit.

const LIST = '/api/v1/catalog/locations';
const LOCATIONS = '/api/v1/branches/:branchId/locations';
const BranchParams = z.strictObject({ branchId: ulidField });
const LocationParams = z.strictObject({ branchId: ulidField, id: ulidField });
/** The body of the archive: the location's version. */
const VersionBody = z.strictObject({ version: versionField });

const locationsList = route({
  id: 'catalog.locations.list',
  method: 'GET',
  path: LIST,
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  query: LocationListQuery,
  handler: async (rc) => {
    const body: LocationListResponse = { items: await listLocations(rc.db.db, rc.query) };
    return { body };
  },
});

const locationsCreate = route({
  id: 'catalog.locations.create',
  method: 'POST',
  path: LOCATIONS,
  permission: 'catalog.locations.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'catalog.master.create',
  params: BranchParams,
  body: LocationBody,
  handler: async (rc) => {
    const r = await createLocation(rc.tx(), rc.params.branchId, rc.body);
    const body: StoreResponse = { id: r.id, version: r.version };
    return { status: 201, body };
  },
});

let fallbackRegistry: JobRegistry | null = null;

/** The job handlers of this release: the runtime's, else (no runtime in this process yet) the handler array's. */
function registryOf(rc: RouteContext): JobRegistry {
  const runtime = rc.services.jobs;
  if (runtime !== null) return runtime.registry;
  fallbackRegistry ??= createJobRegistry(jobHandlers());
  return fallbackRegistry;
}

/** Queues the reindex of what is shelved at or below `id` (enqueueLocationReindex) and wakes the worker after the commit. */
async function queueReindex(rc: RouteContext, branchId: string, id: string): Promise<void> {
  const queued = await enqueueLocationReindex(rc.tx().trx, registryOf(rc), branchId, id, {
    now: rc.now,
    keyring: rc.config.keyring,
    createdBy: rc.auth?.subjectId ?? null,
  });
  if (queued > 0) rc.afterCommit(() => rc.services.jobs?.kick());
}

const locationsUpdate = route({
  id: 'catalog.locations.update',
  method: 'PATCH',
  path: `${LOCATIONS}/:id`,
  permission: 'catalog.locations.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'catalog.master.update',
  params: LocationParams,
  body: LocationPatchBody,
  handler: async (rc) => {
    const r = await updateLocation(rc.tx(), rc.params.branchId, rc.params.id, rc.body);
    if (r.reindex) await queueReindex(rc, rc.params.branchId, r.id);
    const body: LocationUpdateResponse = r.boxesCleared.length === 0 ? { id: r.id, version: r.version } : { id: r.id, version: r.version, boxesCleared: r.boxesCleared };
    return { body };
  },
});

const locationsArchive = route({
  id: 'catalog.locations.archive',
  method: 'DELETE',
  path: `${LOCATIONS}/:id`,
  permission: 'catalog.locations.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'catalog.master.archive',
  params: LocationParams,
  body: VersionBody,
  handler: async (rc) => {
    const { version } = await archiveLocation(rc.tx(), rc.params.branchId, rc.params.id, rc.body.version);
    const body: StoreResponse = { id: rc.params.id, version };
    return { body };
  },
});

/** PUT …/:id/map: a room's floor plan, or an area's or a shelf's box on it. */
const locationsMap = route({
  id: 'catalog.locations.map',
  method: 'PUT',
  path: `${LOCATIONS}/:id/map`,
  permission: 'catalog.locations.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'catalog.master.update',
  params: LocationParams,
  body: LocationMapBody,
  handler: async (rc) => {
    const { version } = await setLocationMap(rc.tx(), rc.params.branchId, rc.params.id, rc.body);
    const body: StoreResponse = { id: rc.params.id, version };
    return { body };
  },
});

export const LOCATIONS_ROUTES: RouteDecl[] = [locationsList, locationsCreate, locationsUpdate, locationsArchive, locationsMap];
