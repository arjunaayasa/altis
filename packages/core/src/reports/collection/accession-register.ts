// Stub: replaced by a later change in this milestone.
// The metadata of `collection.accession_register` is final; its rows are empty until the stock reader fills them.
import { z } from 'zod';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { TableReport } from '../types.js';

/** The accession register: every copy by receiving date, then inventory number. */
export const collectionAccessionRegisterReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.accession_register',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.accession_register.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [reportParam('received', 'dateRange'), reportParam('branchId', 'branch')],
  paramsSchema: z.strictObject({ received: reportDateRangeField.optional(), branchId: reportIdField.optional() }),
  columns: [
    reportColumn('inventory_no', 'text'),
    reportColumn('barcode', 'text'),
    reportColumn('received_date', 'date'),
    ...['title', 'authors', 'edition', 'isbn', 'place', 'publisher', 'year', 'collation'].map((key) => reportColumn(key, 'text')),
    reportColumn('price', 'money'),
    reportColumn('source', 'text'),
    reportColumn('call_number', 'text'),
  ],
  rows: async () => ({ rows: [], nextCursor: null }),
});
