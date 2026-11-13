// Stub: replaced by a later change in this milestone.
// The metadata of `collection.acquisitions` is final; its rows are empty until the stock reader fills them.
import { ACQ_SOURCES } from '@altis/shared';
import { z } from 'zod';
import { reportColumn, reportIdField, reportParam, reportYearField } from '../params.js';
import type { ReportColumn, TableReport } from '../types.js';

/** What the matrix counts. */
export const ACQUISITION_UNITS = Object.freeze(['titles', 'items'] as const);

/** The matrix: one row per year of acquisition (and one for undated copies), one column per DDC main class. */
const MATRIX_COLUMNS: readonly ReportColumn[] = Object.freeze([
  reportColumn('year', 'text'),
  ...['c000', 'c100', 'c200', 'c300', 'c400', 'c500', 'c600', 'c700', 'c800', 'c900', 'c2x', 'cnon', 'total'].map((key) => reportColumn(key, 'int')),
]);

/** The copies acquired in `detailYear`. */
const DETAIL_COLUMNS: readonly ReportColumn[] = Object.freeze([
  reportColumn('barcode', 'text'),
  reportColumn('title', 'text'),
  reportColumn('class', 'text'),
  reportColumn('collection_type', 'text'),
  reportColumn('acq_date', 'date'),
  reportColumn('acq_basis', 'text'),
  reportColumn('price', 'money'),
  reportColumn('acq_source', 'text'),
  reportColumn('supplier', 'text'),
]);

/** Acquisitions per year and DDC main class; with `detailYear`, that year's copies. Always a scan of the stock. */
export const collectionAcquisitionsReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.acquisitions',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.acquisitions.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('yearFrom', 'year', { min: 1900, max: 2100 }),
    reportParam('yearTo', 'year', { min: 1900, max: 2100 }),
    reportParam('branchId', 'branch'),
    reportParam('acqSource', 'status', { options: ACQ_SOURCES, optionLabelPrefix: 'vocab.acq_source.' }),
    reportParam('unit', 'status', { options: ACQUISITION_UNITS }),
    reportParam('detailYear', 'year', { min: 1900, max: 2100 }),
  ],
  paramsSchema: z.strictObject({
    yearFrom: reportYearField.optional(),
    yearTo: reportYearField.optional(),
    branchId: reportIdField.optional(),
    acqSource: z.enum(ACQ_SOURCES).optional(),
    unit: z.enum(ACQUISITION_UNITS).default('titles'),
    detailYear: reportYearField.optional(),
  }),
  columns: (params: Record<string, unknown>) => (params['detailYear'] === undefined ? MATRIX_COLUMNS : DETAIL_COLUMNS),
  scanBased: () => true,
  rows: async () => ({ rows: [], nextCursor: null }),
});
