import { cancelHold, clearHoldShelf, holdShelf, listHolds, markHoldReady, placeHold } from '@altis/core';
import { ulidField } from '@altis/shared/api/common';
import {
  HoldBody,
  HoldListQuery,
  HoldReadyBody,
  type HoldActionResponse,
  type HoldCreateResponse,
  type HoldListResponse,
  type HoldShelfResponse,
} from '@altis/shared/api/holds';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// Holds and the hold shelf. At a branch (`circulation.desk.use` at `:branchId`):
//
//   POST branches/:branchId/circulation/holds                       HoldBody → 201 HoldCreateResponse    circulation.hold.create
//   POST branches/:branchId/circulation/holds/:id/cancel            (no body) → HoldActionResponse       circulation.hold.cancel
//   POST branches/:branchId/circulation/holds/:id/ready             HoldReadyBody → HoldActionResponse   circulation.hold.ready
//   GET  branches/:branchId/circulation/hold-shelf                  → HoldShelfResponse
//   POST branches/:branchId/circulation/hold-shelf/:holdId/clear    (no body) → HoldActionResponse       circulation.hold.shelf_clear
//
// and library-wide (`circulation.records.read`):
//
//   GET  circulation/holds                                          HoldListQuery → HoldListResponse
//
// A desk places holds for pickup at its own branch. A hold named by id must be one of the branch in the path (its
// pickup branch); any other is 404, as one that does not exist.

const API = '/api/v1/branches/:branchId/circulation';
const BranchParams = z.strictObject({ branchId: ulidField });
const HoldParams = z.strictObject({ branchId: ulidField, id: ulidField });
const ShelfParams = z.strictObject({ branchId: ulidField, holdId: ulidField });

const holdsCreate = route({
  id: 'circulation.desk.holds.create',
  method: 'POST',
  path: `${API}/holds`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.hold.create',
  params: BranchParams,
  body: HoldBody,
  handler: async (rc) => {
    const body: HoldCreateResponse = await placeHold(rc.tx(), {
      memberId: rc.body.memberId,
      recordId: rc.body.recordId,
      itemId: rc.body.itemId,
      pickupBranchId: rc.params.branchId,
      source: 'desk',
    });
    return { status: 201, body };
  },
});

const holdsCancel = route({
  id: 'circulation.desk.holds.cancel',
  method: 'POST',
  path: `${API}/holds/:id/cancel`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.hold.cancel',
  params: HoldParams,
  handler: async (rc) => {
    const body: HoldActionResponse = await cancelHold(rc.tx(), { holdId: rc.params.id, by: 'staff', branchId: rc.params.branchId });
    return { body };
  },
});

const holdsReady = route({
  id: 'circulation.desk.holds.ready',
  method: 'POST',
  path: `${API}/holds/:id/ready`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.hold.ready',
  params: HoldParams,
  body: HoldReadyBody,
  handler: async (rc) => {
    const body: HoldActionResponse = await markHoldReady(rc.tx(), { holdId: rc.params.id, branchId: rc.params.branchId, barcode: rc.body.barcode });
    return { body };
  },
});

const shelfGet = route({
  id: 'circulation.desk.hold_shelf.get',
  method: 'GET',
  path: `${API}/hold-shelf`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: null,
  params: BranchParams,
  handler: async (rc) => {
    const body: HoldShelfResponse = await holdShelf(rc.db.db, { branchId: rc.params.branchId }, rc.now);
    return { body };
  },
});

const shelfClear = route({
  id: 'circulation.desk.hold_shelf.clear',
  method: 'POST',
  path: `${API}/hold-shelf/:holdId/clear`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.hold.shelf_clear',
  params: ShelfParams,
  handler: async (rc) => {
    const body: HoldActionResponse = await clearHoldShelf(rc.tx(), { holdId: rc.params.holdId, branchId: rc.params.branchId });
    return { body };
  },
});

const holdsList = route({
  id: 'circulation.holds.list',
  method: 'GET',
  path: '/api/v1/circulation/holds',
  permission: 'circulation.records.read',
  idempotency: 'none',
  audit: null,
  query: HoldListQuery,
  handler: async (rc) => {
    const body: HoldListResponse = await listHolds(rc.db.db, rc.query);
    return { body };
  },
});

export const HOLD_ROUTES: RouteDecl[] = [holdsCreate, holdsCancel, holdsReady, shelfGet, shelfClear, holdsList];
