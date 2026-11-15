/**
 * The reports API vocabulary: the catalogue of report definitions, the paged preview, the export runs and their views.
 *
 * - A definition's parameters are described by {@link ReportParamSpec} (the admin builds its form from them) and
 *   checked by the definition's own schema on the server; the body only bounds their size here.
 * - A run stores its parameters as {@link StoredRunParams}: the definition's own values (`def`), the paper of a PDF and
 *   the warning codes the export wrote at its end. Only `def` reaches the report code.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/reports`.
 */
import { z } from 'zod';
import type { Locale } from '../i18n/index.js';
import type { ReportFormat, ReportRunStatus } from '../accreditation-vocab.js';
import { utf8Length } from './catalog/common.js';

// ---- limits --------------------------------------------------------------------------------------------------------

/** The most rows one preview page holds. */
export const REPORT_PREVIEW_MAX_LIMIT = 200;
/** The most rows an XLSX export holds. */
export const REPORT_XLSX_MAX_ROWS = 100_000;
/** The most rows a PDF export holds. */
export const REPORT_PDF_MAX_ROWS = 10_000;
/** The stored parameters of a run, as JSON, are at most this many UTF-8 bytes. */
export const REPORT_PARAMS_MAX_BYTES = 8_000;
/** A run's file is kept this many days. */
export const REPORT_RUN_TTL_DAYS = 7;
/** The largest ZIP a report run writes. */
export const REPORT_ZIP_MAX_BYTES = 2 * 1024 ** 3;
/** The most entries of a ZIP a report run writes. */
export const REPORT_ZIP_MAX_ENTRIES = 5_000;
/**
 * A report that scans the stock is previewed only up to this many live records; above it the preview is refused and
 * the screen offers the export instead.
 */
export const REPORT_SCAN_PREVIEW_MAX_RECORDS = 5_000;
/** The longest cursor of an export job's report step (it may carry a scan's running totals). */
export const REPORT_EXPORT_CURSOR_MAX = 32_000;
/** The longest cursor of a preview page. */
export const REPORT_PREVIEW_CURSOR_MAX = 1_024;
/** The most warning codes a run keeps, each at most {@link REPORT_WARNING_MAX_CHARS} characters. */
export const REPORT_WARNINGS_MAX = 20;
export const REPORT_WARNING_MAX_CHARS = 64;

// ---- definitions ---------------------------------------------------------------------------------------------------

/** What a parameter asks for; the form shows a control of that kind. */
export type ReportParamKind =
  | 'dateRange'
  | 'asOf'
  | 'year'
  | 'period'
  | 'branch'
  | 'location'
  | 'memberType'
  | 'collectionType'
  | 'materialType'
  | 'classPrefix'
  | 'className'
  | 'status'
  | 'text'
  | 'bool'
  | 'int'
  | 'language'
  // ---- Komunitas K4 (stocktake): a stocktake session ----
  | 'stocktake';

/**
 * One parameter of a definition. `options` lists the values of a `status` parameter; their labels are
 * `<optionLabelPrefix><value>` (a vocabulary's `vocab.<list>.`), or `report.option.<name>.<value>` without a prefix.
 * `min`/`max` bound an `int` or a `year`.
 */
export interface ReportParamSpec {
  name: string;
  kind: ReportParamKind;
  labelKey: string;
  required: boolean;
  multiple?: boolean;
  options?: readonly string[];
  optionLabelPrefix?: string;
  min?: number;
  max?: number;
}

/** The value of a `dateRange` parameter: either bound may be absent. */
export interface ReportDateRange {
  from?: string;
  to?: string;
}

/**
 * How a column's cells are written: `money` cells are numbers in major units, `date` cells are `YYYY-MM-DD` text,
 * `percent` cells are whole numbers (truncated).
 */
export type ReportColumnType = 'text' | 'int' | 'money' | 'date' | 'percent';

export interface ReportColumnView {
  key: string;
  labelKey: string;
  type: ReportColumnType;
}

/** One cell of a report row. */
export type ReportCell = string | number | null;

/**
 * A definition as the catalogue shows it to a user who may see it. `columns` is null when the columns depend on the
 * parameters (the preview answers them). `canExport`: the user holds the export permission and the definition is
 * exported through the generic run routes (a document is made by its own route).
 */
export interface ReportCatalogEntry {
  id: string;
  module: ReportModule;
  kind: 'table' | 'document';
  titleKey: string;
  personal: boolean;
  canExport: boolean;
  formats: ReportFormat[];
  orientation: 'portrait' | 'landscape';
  params: ReportParamSpec[];
  columns: ReportColumnView[] | null;
  // ---- Komunitas K5 (reports) ----
  /** The compact chart the report's screen draws above its preview; null (or absent) for none. */
  chart?: ReportChartSpec | null;
}

/** The module a definition belongs to: its card in the catalogue. */
export type ReportModule =
  | 'collection'
  | 'accreditation'
  | 'members'
  | 'visits'
  | 'circulation'
  | 'stocktake'
  // ---- Komunitas K5 (reports) ----
  | 'library'
  | 'system';

// ---- Komunitas K5 (reports) ----
/**
 * The compact chart a report's screen draws above its preview, from the rows the preview already holds (the table
 * stays the record): `rows` draws one bar per row, labelled with the cell of column `label` and as high as the cell of
 * column `value`; `totals` draws one bar per listed column, from the totals row, labelled with the column's heading.
 * A column the answer lacks is skipped (a definition's columns may depend on its parameters).
 */
export type ReportChartSpec = { kind: 'rows'; label: string; value: string } | { kind: 'totals'; columns: readonly string[] };

/**
 * The language a definition's output is written in, wherever it is rendered (the preview and its printed copy, an
 * export): an accreditation definition always in Indonesian, the language of the files handed to the assessors,
 * whatever the reader's own language; any other in the reader's language `ui`.
 */
export function reportOutputLocale(module: ReportCatalogEntry['module'], ui: Locale): Locale {
  return module === 'accreditation' ? 'id' : ui;
}

/** `GET reports/catalog`. */
export interface ReportCatalogResponse {
  reports: ReportCatalogEntry[];
}

// ---- preview -------------------------------------------------------------------------------------------------------

/** The parameters of a definition as a body carries them; the definition's own schema checks them on the server. */
export const reportParamsField = z.record(z.string().max(64), z.unknown());

/** `POST reports/:reportId/preview`: one keyset page. */
export const ReportPreviewBody = z.strictObject({
  params: reportParamsField,
  cursor: z.string().min(1).max(REPORT_PREVIEW_CURSOR_MAX).nullable().optional(),
  limit: z.int().min(1).max(REPORT_PREVIEW_MAX_LIMIT).optional(),
});

export type ReportPreviewBody = z.infer<typeof ReportPreviewBody>;

/** One preview page; `totals` is the definition's totals row, or null when it has none. */
export interface ReportPreviewResponse {
  columns: ReportColumnView[];
  rows: ReportCell[][];
  nextCursor: string | null;
  totals: ReportCell[] | null;
}

// ---- runs ----------------------------------------------------------------------------------------------------------

/** The paper of a PDF export; the definition gives the orientation. */
export const REPORT_PAPERS = Object.freeze(['A4', 'F4'] as const);

export type ReportPaper = (typeof REPORT_PAPERS)[number];

export const ReportPdfOptions = z.strictObject({ paper: z.enum(REPORT_PAPERS) });

export type ReportPdfOptions = z.infer<typeof ReportPdfOptions>;

/** `POST reports/runs` and `POST reports/runs/personal`: an export of a table definition. */
export const ReportRunCreateBody = z.strictObject({
  reportId: z.string().min(1).max(64),
  format: z.enum(['csv', 'xlsx', 'pdf']),
  params: reportParamsField,
  pdf: ReportPdfOptions.optional(),
});

export type ReportRunCreateBody = z.infer<typeof ReportRunCreateBody>;

/** The answer of a run's start: the run and the job that writes it. */
export interface ReportRunStarted {
  id: string;
  jobId: string;
}

/** A check that refuses a value whose JSON is longer than `bytes` UTF-8 bytes (`too_big`). */
export function jsonBytesMax(bytes: number): z.core.$ZodCheck<unknown> {
  return z.check<unknown>((ctx) => {
    let text: string | undefined;
    try {
      text = JSON.stringify(ctx.value);
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      ctx.issues.push({ code: 'custom', params: { code: 'invalid' }, message: 'invalid', input: ctx.value });
    } else if (utf8Length(text) > bytes) {
      ctx.issues.push({ code: 'too_big', origin: 'string', maximum: bytes, inclusive: true, input: ctx.value });
    }
  });
}

/**
 * `report_runs.params`: the definition's own values after its schema (`def`, the only part the report code sees), the
 * paper of a PDF, and the warning codes the export's last phase wrote (at most {@link REPORT_WARNINGS_MAX}). The whole
 * JSON is at most {@link REPORT_PARAMS_MAX_BYTES} bytes.
 */
export const StoredRunParams = z
  .strictObject({
    def: z.record(z.string(), z.unknown()),
    pdf: ReportPdfOptions.optional(),
    warnings: z.array(z.string().min(1).max(REPORT_WARNING_MAX_CHARS)).max(REPORT_WARNINGS_MAX).optional(),
  })
  .check(jsonBytesMax(REPORT_PARAMS_MAX_BYTES));

export type StoredRunParams = z.infer<typeof StoredRunParams>;

/**
 * A run as the run list and the run page show it. `params` (the definition's values) and `warnings` are the viewer's
 * own run's only: null and empty for another staff member's run. `downloadable`: the viewer may download the file now.
 */
export interface ReportRunView {
  id: string;
  reportId: string;
  format: ReportFormat;
  locale: Locale;
  personal: boolean;
  status: ReportRunStatus;
  rowCount: number | null;
  nonLatinRows: number | null;
  outputSize: number | null;
  errorCode: string | null;
  jobId: string | null;
  expiresAt: number | null;
  createdAt: number;
  createdBy: string | null;
  finishedAt: number | null;
  params: Record<string, unknown> | null;
  paper: ReportPaper | null;
  warnings: string[];
  mine: boolean;
  downloadable: boolean;
}

/** `GET reports/runs`: the viewer's own runs, or every run (`all`, for a holder of the jobs permission). */
export const ReportRunListQuery = z.strictObject({
  scope: z.enum(['mine', 'all']).optional(),
  reportId: z.string().min(1).max(64).optional(),
  cursor: z.string().min(1).max(200).optional(),
  /** 1-200, as the query text. */
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .refine((s) => Number(s) <= 200)
    .optional(),
});

export type ReportRunListQuery = z.infer<typeof ReportRunListQuery>;

export interface ReportRunListResponse {
  runs: ReportRunView[];
  nextCursor: string | null;
}
