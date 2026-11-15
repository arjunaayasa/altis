import { createManualVisit, createStation, listStations, listVisits, newStationCode, revokeStation, staffCheckIn, visitSummary, voidVisit } from '@altis/core';
import { ulidField } from '@altis/shared/api/common';
import {
  StationCreateBody,
  StationListQuery,
  VisitCheckinBody,
  VisitCreateBody,
  VisitListQuery,
  VisitSummaryQuery,
  type StationCodeResponse,
  type StationListResponse,
  type VisitCheckinResponse,
  type VisitCreateResponse,
  type VisitListResponse,
  type VisitSummary,
} from '@altis/shared/api/visits';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// Visits and guestbook stations:
//
//   GET    visits                                              visits.records.read     VisitListQuery → VisitListResponse
//   GET    visits/summary                                      visits.records.read     VisitSummaryQuery → VisitSummary
//   GET    visits/stations                                     visits.records.read     StationListQuery → StationListResponse
//   POST   branches/:branchId/visits                           visits.records.manage   VisitCreateBody → 201 VisitCreateResponse  visits.visit.create
//   POST   branches/:branchId/visits/checkin                   visits.records.manage   VisitCheckinBody → VisitCheckinResponse   (not audited)
//   POST   branches/:branchId/visits/:id/void                  visits.records.manage   (no body) → 204                          visits.visit.void
//   POST   branches/:branchId/visits/stations                  visits.stations.manage  StationCreateBody → 201 StationCodeResponse  visits.station.create
//   POST   branches/:branchId/visits/stations/:id/activation-code  visits.stations.manage  → StationCodeResponse               visits.station.activation_code
//   DELETE branches/:branchId/visits/stations/:id              visits.stations.manage  → 204                                     visits.station.revoke  system
//
// A visit or a station of another branch than the path's is 404. A staff check-in is a count, not a change: not
// audited, no stored response (a repeat within the window is not counted anyway). An activation code is in the answer
// that made it only (no stored response). Revoking a station is a `system` route, as disabling a user is.

const API = '/api/v1/visits';
const BRANCH_API = '/api/v1/branches/:branchId/visits';
const BranchParams = z.strictObject({ branchId: ulidField });
const IdParams = z.strictObject({ branchId: ulidField, id: ulidField });

const visitsList = route({
  id: 'visits.list',
  method: 'GET',
  path: API,
  permission: 'visits.records.read',
  idempotency: 'none',
  audit: null,
  query: VisitListQuery,
  handler: async (rc) => {
    const body: VisitListResponse = await listVisits(rc.db.db, rc.query);
    return { body };
  },
});

const visitsSummary = route({
  id: 'visits.summary',
  method: 'GET',
  path: `${API}/summary`,
  permission: 'visits.records.read',
  idempotency: 'none',
  audit: null,
  query: VisitSummaryQuery,
  handler: async (rc) => {
    const body: VisitSummary = await visitSummary(rc.db.db, rc.query, rc.now);
    return { body };
  },
});

const stationsList = route({
  id: 'visits.stations.list',
  method: 'GET',
  path: `${API}/stations`,
  permission: 'visits.records.read',
  idempotency: 'none',
  audit: null,
  query: StationListQuery,
  handler: async (rc) => {
    const body: StationListResponse = await listStations(rc.db.db, rc.query, rc.now);
    return { body };
  },
});

const visitsCreate = route({
  id: 'visits.create',
  method: 'POST',
  path: BRANCH_API,
  permission: 'visits.records.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'visits.visit.create',
  params: BranchParams,
  body: VisitCreateBody,
  handler: async (rc) => {
    const body: VisitCreateResponse = await createManualVisit(rc.tx(), rc.params.branchId, rc.body);
    return { status: 201, body };
  },
});

const visitsCheckin = route({
  id: 'visits.checkin',
  method: 'POST',
  path: `${BRANCH_API}/checkin`,
  permission: 'visits.records.manage',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: null,
  params: BranchParams,
  body: VisitCheckinBody,
  handler: async (rc) => {
    const r = await staffCheckIn(rc.tx(), rc.params.branchId, rc.body);
    const body: VisitCheckinResponse = { outcome: r.outcome, visitId: r.visitId, firstName: r.firstName, expired: r.expired, suspended: r.suspended };
    return { body };
  },
});

const visitsVoid = route({
  id: 'visits.void',
  method: 'POST',
  path: `${BRANCH_API}/:id/void`,
  permission: 'visits.records.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'visits.visit.void',
  params: IdParams,
  handler: async (rc) => {
    await voidVisit(rc.tx(), rc.params.branchId, rc.params.id);
    return { status: 204 };
  },
});

const stationsCreate = route({
  id: 'visits.stations.create',
  method: 'POST',
  path: `${BRANCH_API}/stations`,
  permission: 'visits.stations.manage',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: 'visits.station.create',
  params: BranchParams,
  body: StationCreateBody,
  handler: async (rc) => {
    const body: StationCodeResponse = await createStation(rc.tx(), rc.params.branchId, rc.body);
    return { status: 201, body };
  },
});

const stationsCode = route({
  id: 'visits.stations.activation_code',
  method: 'POST',
  path: `${BRANCH_API}/stations/:id/activation-code`,
  permission: 'visits.stations.manage',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: 'visits.station.activation_code',
  params: IdParams,
  handler: async (rc) => {
    const body: StationCodeResponse = await newStationCode(rc.tx(), rc.params.branchId, rc.params.id);
    return { body };
  },
});

const stationsRevoke = route({
  id: 'visits.stations.revoke',
  method: 'DELETE',
  path: `${BRANCH_API}/stations/:id`,
  permission: 'visits.stations.manage',
  branchParam: 'branchId',
  mode: 'system',
  idempotency: 'store',
  audit: 'visits.station.revoke',
  params: IdParams,
  handler: async (rc) => {
    await revokeStation(rc.tx(), rc.params.branchId, rc.params.id);
    return { status: 204 };
  },
});

/** The visits API: the library-wide reads (literal paths first), then a branch's writes. */
export const VISITS_ROUTES: RouteDecl[] = [visitsSummary, stationsList, visitsList, visitsCreate, visitsCheckin, stationsCreate, stationsCode, stationsRevoke, visitsVoid];
