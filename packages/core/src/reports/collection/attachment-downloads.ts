// Stub: replaced by a later change in this milestone.
// The metadata of `collection.attachment_downloads` is final; its rows are empty until the reader fills them.
import { z } from 'zod';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { TableReport } from '../types.js';

/** Who may open an attachment. */
export const ATTACHMENT_REPORT_ACCESS = Object.freeze(['public', 'staff'] as const);

/** How often each attachment was opened (counts only, never who). */
export const collectionAttachmentDownloadsReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.attachment_downloads',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.attachment_downloads.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [reportParam('created', 'dateRange'), reportParam('materialTypeId', 'materialType'), reportParam('access', 'status', { options: ATTACHMENT_REPORT_ACCESS })],
  paramsSchema: z.strictObject({
    created: reportDateRangeField.optional(),
    materialTypeId: reportIdField.optional(),
    access: z.enum(ATTACHMENT_REPORT_ACCESS).optional(),
  }),
  columns: [reportColumn('title', 'text'), reportColumn('attachment', 'text'), reportColumn('mime', 'text'), reportColumn('downloads', 'int')],
  rows: async () => ({ rows: [], nextCursor: null }),
});
