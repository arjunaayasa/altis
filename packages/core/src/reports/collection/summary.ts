// Stub: replaced by a later change in this milestone.
// The metadata of `collection.summary` is final; its rows are empty until the stock reader fills them.
import { z } from 'zod';
import { reportColumn, reportIdField, reportParam } from '../params.js';
import type { TableReport } from '../types.js';
import { dateField } from '@altis/shared/api/catalog/common';

/** The collection at a glance: titles, copies by status, titles by material type, copies by collection type and location. */
export const collectionSummaryReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.summary',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.summary.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [reportParam('branchId', 'branch'), reportParam('asOf', 'asOf')],
  paramsSchema: z.strictObject({ branchId: reportIdField.optional(), asOf: dateField.optional() }),
  columns: [reportColumn('section', 'text'), reportColumn('item', 'text'), reportColumn('titles', 'int'), reportColumn('items', 'int')],
  /** A stock on another day than today needs the scan (the run code leaves `asOf` out when it is today). */
  scanBased: (params: Record<string, unknown>) => params['asOf'] !== undefined,
  rows: async () => ({ rows: [], nextCursor: null }),
});
