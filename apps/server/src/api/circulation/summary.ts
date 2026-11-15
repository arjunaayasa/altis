import { circulationDaySummary } from '@altis/core';
import { ulidField } from '@altis/shared/api/common';
import type { CirculationDaySummary } from '@altis/shared/api/circulation-summary';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// The dashboard's numbers of the day at a desk's branch (`circulation.desk.use` at `:branchId`):
//
//   GET branches/:branchId/circulation/summary   → CirculationDaySummary (today's loans and returns, overdue loans,
//                                                   holds ready for pickup)

const summaryGet = route({
  id: 'circulation.desk.summary',
  method: 'GET',
  path: '/api/v1/branches/:branchId/circulation/summary',
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: null,
  params: z.strictObject({ branchId: ulidField }),
  handler: async (rc) => {
    const body: CirculationDaySummary = await circulationDaySummary(rc.db.db, rc.params.branchId, rc.now);
    return { body };
  },
});

export const CIRCULATION_SUMMARY_ROUTES: RouteDecl[] = [summaryGet];
