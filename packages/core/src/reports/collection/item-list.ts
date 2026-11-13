// Stub: replaced by a later change in this milestone.
// The metadata of `collection.item_list` is final; its rows are empty until the stock reader fills them.
import { ITEM_STATUSES } from '@altis/shared';
import { dateField } from '@altis/shared/api/catalog/common';
import { z } from 'zod';
import { reportClassPrefixField, reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { TableReport } from '../types.js';

/** The copies of the collection, filtered. */
export const collectionItemListReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.item_list',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.item_list.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('branchId', 'branch'),
    reportParam('locationId', 'location'),
    reportParam('status', 'status', { multiple: true, options: ITEM_STATUSES, optionLabelPrefix: 'vocab.item_status.' }),
    reportParam('collectionTypeId', 'collectionType'),
    reportParam('materialTypeId', 'materialType'),
    reportParam('classPrefix', 'classPrefix'),
    reportParam('received', 'dateRange'),
    reportParam('asOf', 'asOf'),
  ],
  paramsSchema: z.strictObject({
    branchId: reportIdField.optional(),
    locationId: reportIdField.optional(),
    status: z.array(z.enum(ITEM_STATUSES)).min(1).max(ITEM_STATUSES.length).optional(),
    collectionTypeId: reportIdField.optional(),
    materialTypeId: reportIdField.optional(),
    classPrefix: reportClassPrefixField.optional(),
    received: reportDateRangeField.optional(),
    asOf: dateField.optional(),
  }),
  columns: [
    ...['barcode', 'inventory_no', 'title', 'call_number', 'collection_type', 'status', 'location'].map((key) => reportColumn(key, 'text')),
    reportColumn('received_date', 'date'),
    reportColumn('price', 'money'),
    reportColumn('acq_source', 'text'),
  ],
  scanBased: (params: Record<string, unknown>) => params['asOf'] !== undefined,
  rows: async () => ({ rows: [], nextCursor: null }),
});
