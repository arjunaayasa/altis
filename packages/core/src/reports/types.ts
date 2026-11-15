import type { DB, TableName } from '@altis/db';
import type { Locale, Permission } from '@altis/shared';
import type { ReportCell, ReportChartSpec, ReportColumnType, ReportModule, ReportParamSpec } from '@altis/shared/api/reports';
import type { Kysely } from 'kysely';
import type { z } from 'zod';
import type { StorageDriver } from '../files/serve.js';
import type { AccredSettings } from '../settings/accreditation.js';

// The report definitions (spec §4.15): every report the admin can preview or export is one definition in the registry
// (registry.ts). A table report answers rows page by page; a document report renders its own output file across
// slices. Both are plain data plus functions over a context the run or the preview builds, so a definition never
// opens a transaction of its own or reads a request.

/**
 * A column of a table report. `source` names the table column the cells come from when that column is registered as
 * personal data (`PERSONAL_COLUMNS`): such a column makes the report personal (personal.ts). `widthChars` is the PDF
 * and XLSX width hint.
 */
export interface ReportColumn {
  key: string;
  labelKey: string;
  type: ReportColumnType;
  source?: { table: TableName; column: string };
  widthChars?: number;
}

/**
 * What a definition's functions get. `params` is the run's stored `def` (the body's parameters after the definition's
 * own schema) and nothing else; `budgetLeftMs()` is the request's budget in a preview and the slice's in an export.
 */
export interface ReportCtx {
  db: Kysely<DB>;
  locale: Locale;
  /** The IANA time zone dates are cut in (`library.timezone`). */
  tz: string;
  now: number;
  /** `now` as a calendar date in `tz`. */
  today: string;
  settings: AccredSettings;
  params: Record<string, unknown>;
  budgetLeftMs(): number;
  /**
   * Whether this call may read the whole stock through the stock scan: false in a preview of a library above
   * `REPORT_SCAN_PREVIEW_MAX_RECORDS` live records. A report that reaches the scan only part way through its rows (the
   * data-quality list's last problem) asks before it starts the scan. Absent: it may (an export, a document).
   */
  mayScanStock?(): Promise<boolean>;
}

/** One row of a table report, in the order of its columns. */
export type ReportRow = readonly ReportCell[];

interface ReportBase {
  /** `<module>.<name>`, at most 64 characters (`report_runs.report_id`). */
  id: string;
  module: ReportModule;
  /** `report.<id>.title`. */
  titleKey: string;
  /** What it takes to see and preview the report. */
  permission: Permission;
  /** What it takes to export it (default: {@link permission}). */
  exportPermission?: Permission;
  /** The report holds personal data: its export needs a fresh re-authentication and is audited. */
  personal: boolean;
  /**
   * A further permission some values of the parameters need (as the body sends them, before the definition's schema):
   * the preview and the export routes check it beside {@link permission}. Null: none.
   */
  extraPermission?(params: Readonly<Record<string, unknown>>): Permission | null;
  // ---- Komunitas K4 (stocktake) ----
  /**
   * The branch the parameters (as the body sends them, or as a run stored them) address, for a definition whose
   * permission is a branch permission (a stocktake report: the session's branch): the routes check the permission at
   * that branch, so a role granted at one branch only may use the report there. Null (or no such function): no one
   * branch, and the permission is needed globally.
   */
  branchOf?(db: Kysely<DB>, params: Readonly<Record<string, unknown>>): Promise<string | null>;
  params: readonly ReportParamSpec[];
  /** Checks a body's parameters; its output is the stored `def`. */
  paramsSchema: z.ZodType<Record<string, unknown>>;
  orientation: 'portrait' | 'landscape';
}

/**
 * A report of rows, previewed page by page and exported as CSV, XLSX or PDF. `columns` may depend on the parameters
 * (a breakdown, a detail year, a section).
 *
 * A scan-based report (`scanBased(params)`: the answer needs a scan of the whole stock) may answer `{rows: [],
 * nextCursor}` while its scan runs: the cursor carries the running totals (at most `REPORT_EXPORT_CURSOR_MAX`
 * characters) and the scan stops when `budgetLeftMs()` drops below 2 000. Its preview is refused above
 * `REPORT_SCAN_PREVIEW_MAX_RECORDS` live records.
 */
export interface TableReport extends ReportBase {
  kind: 'table';
  formats: readonly ('csv' | 'xlsx' | 'pdf')[];
  columns: readonly ReportColumn[] | ((params: Record<string, unknown>) => readonly ReportColumn[]);
  rows(ctx: ReportCtx, cursor: string | null, limit: number): Promise<{ rows: ReportRow[]; nextCursor: string | null }>;
  /** The totals row, or null when the report has none. */
  totals?(ctx: ReportCtx): Promise<ReportRow | null>;
  /** The number of rows an export will have, when it can be known up front (null: unknown, the size check waits). */
  count?(ctx: ReportCtx): Promise<number | null>;
  scanBased?(params: Record<string, unknown>): boolean;
  // ---- Komunitas K5 (reports) ----
  /** The compact chart the report's screen draws from its preview rows (none when absent). */
  chart?: ReportChartSpec;
}

/** What a document report renders with: the run, its work folder and the facts its pages print. */
export interface DocumentCtx extends ReportCtx {
  runId: string;
  format: 'pdf' | 'zip';
  dataDir: string;
  storage: StorageDriver;
  libraryName: string;
  staffName: string;
  appVersion: string;
  budgetLeftMs(): number;
  heartbeat(progress: number, message?: string): Promise<void>;
  cancelled(): Promise<boolean>;
}

/** Where a document's rendering stopped: its JSON is at most 60 000 bytes. */
export type DocumentResume = { phase: string; cursor: string | null; state: unknown };

/** One slice of a document's rendering: finished (with its counts and warning codes), or where to go on. */
export type DocumentStep = { done: true; rowCount: number; nonLatinRows: number; warnings: string[] } | { done: false; resume: DocumentResume };

/** A report that writes its own file (`reportWorkPath(…, 'output.part')`) across slices: a PDF or a ZIP. */
export interface DocumentReport extends ReportBase {
  kind: 'document';
  formats: readonly ('pdf' | 'zip')[];
  // ---- Komunitas K5 (reports) ----
  /**
   * The document is started through the generic run routes (`POST reports/runs`, with its parameters, as a table
   * report is) and listed as exportable; without it, a route of its own makes it (the accreditation documents).
   */
  runRoutes?: boolean;
  render(ctx: DocumentCtx, resume: DocumentResume | null): Promise<DocumentStep>;
}

export type ReportDefinition = TableReport | DocumentReport;
