// Stub: replaced by a later change in this milestone.
// The metadata of `collection.title_list` is final; its rows are empty until the stock reader fills them.
import { AUDIENCES } from '@altis/shared';
import { dateField } from '@altis/shared/api/catalog/common';
import { z } from 'zod';
import { reportClassPrefixField, reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { TableReport } from '../types.js';

/** A year of publication (older than the years of acquisition). */
const PUBLICATION_YEAR = z.int().min(1000).max(2100);

/** The titles of the collection with their copies, filtered. */
export const collectionTitleListReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.title_list',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.title_list.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('materialTypeId', 'materialType'),
    reportParam('collectionTypeId', 'collectionType'),
    reportParam('classPrefix', 'classPrefix'),
    reportParam('languageId', 'language'),
    reportParam('input', 'dateRange'),
    reportParam('pubYearFrom', 'year', { min: 1000, max: 2100 }),
    reportParam('pubYearTo', 'year', { min: 1000, max: 2100 }),
    reportParam('branchId', 'branch'),
    reportParam('locationId', 'location'),
    reportParam('fictionOnly', 'bool'),
    reportParam('localWorkOnly', 'bool'),
    reportParam('audience', 'status', { options: AUDIENCES, optionLabelPrefix: 'vocab.audience.' }),
    reportParam('asOf', 'asOf'),
  ],
  paramsSchema: z.strictObject({
    materialTypeId: reportIdField.optional(),
    collectionTypeId: reportIdField.optional(),
    classPrefix: reportClassPrefixField.optional(),
    languageId: reportIdField.optional(),
    input: reportDateRangeField.optional(),
    pubYearFrom: PUBLICATION_YEAR.optional(),
    pubYearTo: PUBLICATION_YEAR.optional(),
    branchId: reportIdField.optional(),
    locationId: reportIdField.optional(),
    fictionOnly: z.boolean().optional(),
    localWorkOnly: z.boolean().optional(),
    audience: z.enum(AUDIENCES).optional(),
    asOf: dateField.optional(),
  }),
  columns: [
    ...['title', 'edition', 'publisher', 'place', 'year', 'isbn_issn', 'classification', 'call_number'].map((key) => reportColumn(key, 'text')),
    reportColumn('items', 'int'),
  ],
  scanBased: (params: Record<string, unknown>) => params['asOf'] !== undefined,
  rows: async () => ({ rows: [], nextCursor: null }),
});
