// Stub: replaced by a later change in this milestone.
// The metadata of `collection.data_quality` is final; its rows are empty until the stock reader fills them.
import { z } from 'zod';
import { reportColumn, reportIdField, reportParam } from '../params.js';
import type { TableReport } from '../types.js';

/** Copies and records whose processing is incomplete, one problem per row. */
export const collectionDataQualityReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.data_quality',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.data_quality.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [reportParam('branchId', 'branch')],
  paramsSchema: z.strictObject({ branchId: reportIdField.optional() }),
  columns: ['problem', 'barcode', 'title', 'call_number', 'location', 'detail'].map((key) => reportColumn(key, 'text')),
  rows: async () => ({ rows: [], nextCursor: null }),
});
