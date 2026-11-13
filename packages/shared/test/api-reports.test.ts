import { describe, expect, it } from 'vitest';
import { issueCode } from '../src/api/common.js';
import {
  REPORT_EXPORT_CURSOR_MAX,
  REPORT_PARAMS_MAX_BYTES,
  REPORT_PDF_MAX_ROWS,
  REPORT_PREVIEW_MAX_LIMIT,
  REPORT_RUN_TTL_DAYS,
  REPORT_SCAN_PREVIEW_MAX_RECORDS,
  REPORT_XLSX_MAX_ROWS,
  REPORT_ZIP_MAX_BYTES,
  REPORT_ZIP_MAX_ENTRIES,
  ReportPreviewBody,
  ReportRunCreateBody,
  ReportRunListQuery,
  StoredRunParams,
} from '../src/api/reports.js';

// The reports API contracts: the preview's page, the run's body and its stored parameters (the definition's values, the
// paper of a PDF and the warning codes, bounded as one JSON value), and the limits the framework works with.

interface Parser {
  safeParse(v: unknown): { success: boolean; error?: { issues: { code: string; path: PropertyKey[]; params?: Record<string, unknown> }[] } };
}

/** The `{path, code}` field errors the server would answer for `value`. */
function errorsOf(schema: Parser, value: unknown): { path: string; code: string }[] {
  const r = schema.safeParse(value);
  if (r.success) return [];
  return r.error!.issues.map((i) => ({ path: i.path.map(String).join('.'), code: issueCode(i) }));
}

describe('the report limits', () => {
  it('are the values the framework is built around', () => {
    expect([REPORT_PREVIEW_MAX_LIMIT, REPORT_XLSX_MAX_ROWS, REPORT_PDF_MAX_ROWS, REPORT_PARAMS_MAX_BYTES, REPORT_RUN_TTL_DAYS]).toEqual([
      200, 100_000, 10_000, 8_000, 7,
    ]);
    expect([REPORT_ZIP_MAX_BYTES, REPORT_ZIP_MAX_ENTRIES, REPORT_SCAN_PREVIEW_MAX_RECORDS, REPORT_EXPORT_CURSOR_MAX]).toEqual([
      2_147_483_648, 5_000, 5_000, 32_000,
    ]);
  });
});

describe('ReportPreviewBody', () => {
  it('takes the parameters, a cursor and a limit of 1-200', () => {
    expect(errorsOf(ReportPreviewBody, { params: { asOf: '2026-06-30' }, cursor: 'abc', limit: 200 })).toEqual([]);
    expect(errorsOf(ReportPreviewBody, { params: {}, cursor: null })).toEqual([]);
  });

  it('refuses a limit of 201, a cursor over 1 024 characters and an unknown key', () => {
    expect(errorsOf(ReportPreviewBody, { params: {}, limit: 201 })).toEqual([{ path: 'limit', code: 'too_big' }]);
    expect(errorsOf(ReportPreviewBody, { params: {}, limit: 0 })).toEqual([{ path: 'limit', code: 'too_small' }]);
    expect(errorsOf(ReportPreviewBody, { params: {}, cursor: 'x'.repeat(1025) })).toEqual([{ path: 'cursor', code: 'too_big' }]);
    expect(errorsOf(ReportPreviewBody, { params: {}, extra: 1 })).toEqual([{ path: '', code: 'unrecognized_keys' }]);
  });
});

describe('ReportRunCreateBody', () => {
  it('takes a table format and the paper of a PDF', () => {
    expect(errorsOf(ReportRunCreateBody, { reportId: 'collection.summary', format: 'pdf', params: {}, pdf: { paper: 'F4' } })).toEqual([]);
    expect(errorsOf(ReportRunCreateBody, { reportId: 'collection.summary', format: 'xlsx', params: {} })).toEqual([]);
  });

  it('refuses a document format, another paper, an unknown key of `pdf` and an id over 64 characters', () => {
    expect(errorsOf(ReportRunCreateBody, { reportId: 'accreditation.dossier', format: 'zip', params: {} })).toEqual([{ path: 'format', code: 'invalid_value' }]);
    expect(errorsOf(ReportRunCreateBody, { reportId: 'x', format: 'pdf', params: {}, pdf: { paper: 'Letter' } })).toEqual([
      { path: 'pdf.paper', code: 'invalid_value' },
    ]);
    expect(errorsOf(ReportRunCreateBody, { reportId: 'x', format: 'pdf', params: {}, pdf: { paper: 'A4', margin: 1 } })).toEqual([
      { path: 'pdf', code: 'unrecognized_keys' },
    ]);
    expect(errorsOf(ReportRunCreateBody, { reportId: 'r'.repeat(65), format: 'csv', params: {} })).toEqual([{ path: 'reportId', code: 'too_big' }]);
  });
});

describe('StoredRunParams', () => {
  it('holds the definition values apart from the paper and the warnings', () => {
    const stored = { def: { asOf: '2026-06-30', branchId: null }, pdf: { paper: 'A4' }, warnings: ['component_over_limit'] };
    expect(StoredRunParams.parse(stored)).toEqual(stored);
    expect(StoredRunParams.parse({ def: {} })).toEqual({ def: {} });
  });

  it('refuses a paper key inside nothing but `pdf`, a 21st warning, a warning over 64 characters and an unknown key', () => {
    expect(errorsOf(StoredRunParams, { def: {}, paper: 'A4' })).toEqual([{ path: '', code: 'unrecognized_keys' }]);
    expect(errorsOf(StoredRunParams, { def: {}, warnings: Array.from({ length: 21 }, (_, i) => `w${i}`) })).toEqual([{ path: 'warnings', code: 'too_big' }]);
    expect(errorsOf(StoredRunParams, { def: {}, warnings: ['w'.repeat(65)] })).toEqual([{ path: 'warnings.0', code: 'too_big' }]);
  });

  it('bounds the whole JSON at 8 000 bytes, the multi-byte characters counted as bytes', () => {
    const fits = { def: { title: 'x'.repeat(REPORT_PARAMS_MAX_BYTES - JSON.stringify({ def: { title: '' } }).length) } };
    expect(JSON.stringify(fits)).toHaveLength(REPORT_PARAMS_MAX_BYTES);
    expect(errorsOf(StoredRunParams, fits)).toEqual([]);
    expect(errorsOf(StoredRunParams, { def: { title: 'ب'.repeat(4000) } })).toEqual([{ path: '', code: 'too_big' }]);
  });
});

describe('ReportRunListQuery', () => {
  it('takes the scope, a report and a limit of 1-200 as text', () => {
    expect(errorsOf(ReportRunListQuery, { scope: 'all', reportId: 'collection.summary', limit: '200' })).toEqual([]);
    expect(errorsOf(ReportRunListQuery, { limit: '201' }).map((e) => e.path)).toEqual(['limit']);
    expect(errorsOf(ReportRunListQuery, { limit: '0' }).map((e) => e.path)).toEqual(['limit']);
    expect(errorsOf(ReportRunListQuery, { scope: 'others' })).toEqual([{ path: 'scope', code: 'invalid_value' }]);
  });
});
