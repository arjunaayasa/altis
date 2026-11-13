import { ulidField } from '@altis/shared/api/common';
import { dateField } from '@altis/shared/api/catalog/common';
import type { ReportColumnType, ReportParamKind, ReportParamSpec } from '@altis/shared/api/reports';
import { z } from 'zod';
import type { ReportColumn } from './types.js';

// The building blocks of the definitions' parameter lists, schemas and columns, so that every definition labels its
// parameters `report.param.<name>` and its columns `report.column.<key>`, and checks a value of each kind the same way.

/** A parameter of a definition, labelled `report.param.<name>`. */
export function reportParam(name: string, kind: ReportParamKind, o: Omit<Partial<ReportParamSpec>, 'name' | 'kind' | 'labelKey'> = {}): ReportParamSpec {
  return Object.freeze({ name, kind, labelKey: `report.param.${name}`, required: false, ...o });
}

/** A column of a table report, labelled `report.column.<key>`. */
export function reportColumn(key: string, type: ReportColumnType, o: Omit<Partial<ReportColumn>, 'key' | 'type' | 'labelKey'> = {}): ReportColumn {
  return Object.freeze({ key, labelKey: `report.column.${key}`, type, ...o });
}

/** A `dateRange` value: either bound may be absent; `from` after `to` is `{path: 'to', code: 'invalid'}`. */
export const reportDateRangeField = z.strictObject({ from: dateField.optional(), to: dateField.optional() }).check((ctx) => {
  const { from, to } = ctx.value;
  if (from !== undefined && to !== undefined && from > to) {
    ctx.issues.push({ code: 'custom', path: ['to'], params: { code: 'invalid' }, message: 'invalid', input: to });
  }
});

/** A `year` value. */
export const reportYearField = z.int().min(1900).max(2100);

/** The id of a branch, location, collection type, material type, language or period. */
export const reportIdField = ulidField;

/** A class number prefix (`59`, `2X`, `899.2`). */
export const reportClassPrefixField = z.string().trim().min(1).max(16).regex(/^[0-9A-Za-z.]*$/);

/** The parameter every accreditation report starts with: its period. */
export const PERIOD_PARAM: ReportParamSpec = reportParam('periodId', 'period', { required: true });
