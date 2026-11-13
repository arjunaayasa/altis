// Stub: replaced by a later change in this milestone.
// The metadata of `collection.ddc_recap` is final; its rows are empty until the stock reader fills them.
import { dateField } from '@altis/shared/api/catalog/common';
import { z } from 'zod';
import { reportColumn, reportIdField, reportParam } from '../params.js';
import type { TableReport } from '../types.js';

/** How the recap breaks each class down (one `group` per row). */
export const DDC_RECAP_BREAKDOWNS = Object.freeze(['none', 'material_type', 'collection_type', 'language', 'fnr', 'medium'] as const);

/** Titles and copies per DDC main class (with divisions), `2X` and the other classes. */
export const collectionDdcRecapReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.ddc_recap',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.ddc_recap.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [
    reportParam('branchId', 'branch'),
    reportParam('asOf', 'asOf'),
    reportParam('locationId', 'location'),
    reportParam('collectionTypeId', 'collectionType'),
    reportParam('materialTypeId', 'materialType'),
    reportParam('divisions', 'bool'),
    reportParam('breakdown', 'status', { options: DDC_RECAP_BREAKDOWNS }),
  ],
  paramsSchema: z.strictObject({
    branchId: reportIdField.optional(),
    asOf: dateField.optional(),
    locationId: reportIdField.optional(),
    collectionTypeId: reportIdField.optional(),
    materialTypeId: reportIdField.optional(),
    divisions: z.boolean().optional(),
    breakdown: z.enum(DDC_RECAP_BREAKDOWNS).default('none'),
  }),
  columns: [
    reportColumn('class', 'text'),
    reportColumn('label', 'text'),
    reportColumn('group', 'text'),
    reportColumn('titles', 'int'),
    reportColumn('items', 'int'),
  ],
  scanBased: (params: Record<string, unknown>) => params['asOf'] !== undefined,
  rows: async () => ({ rows: [], nextCursor: null }),
});
