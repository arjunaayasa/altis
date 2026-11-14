import type { DbHandle, DB } from '@altis/db';
import { reportWorkPath, type DataPath } from '@altis/platform';
import { isDomainError, type Locale } from '@altis/shared';
import { REPORT_WARNINGS_MAX, type StoredRunParams } from '@altis/shared/api/reports';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { xlsxCheckpointSchema } from '../../export/xlsx.js';
import type { JobContext } from '../../jobs/types.js';
import type { ReportCtx, ReportDefinition } from '../types.js';
import type { ReportJobDeps } from './job.js';

// What the phases of one export slice share: the run being written, its definition and the context the definition's
// functions get, the state each phase keeps in the job's checkpoint, and the failures that end a run at once.

/** The formats a run writes; the file's extension is the format. */
export type ExportFormat = 'csv' | 'xlsx' | 'pdf' | 'zip';

/** One run, as one slice of its export sees it. */
export interface ExportRun {
  runId: string;
  def: ReportDefinition;
  format: ExportFormat;
  /** `report_runs.locale`: the language of every text the file holds. */
  locale: Locale;
  /** `report_runs.params` as stored: `def` reaches the report code, `pdf` gives the paper. */
  stored: StoredRunParams;
  dataDir: string;
  deps: ReportJobDeps;
  job: JobContext;
  db: Kysely<DB>;
  handle: DbHandle;
  /** The context of the definition's functions: the stored `def`, the run's creation as `now`, the slice's budget. */
  report: ReportCtx;
  /** `library.name`. */
  libraryName: string;
  /** The name of the staff member who started the run ('' when the account is gone). */
  staffName: string;
}

/** A work file of the run. */
export function workFile(run: Pick<ExportRun, 'dataDir' | 'runId'>, name: 'rows.ndjson' | 'output.part' | 'output.central'): DataPath {
  return reportWorkPath(run.dataDir, run.runId, name);
}

/**
 * A failure that ends the run at once (no retry): its `report_runs.error_code` and the job's last message. A retry would
 * meet the same answer (a report over its format's limit, a definition that answers what the export cannot hold).
 */
export class ExportRunFailure extends Error {
  constructor(
    readonly code: string,
    readonly jobMessage: string = `failed: ${code}`,
  ) {
    super(`report export failed: ${code}`);
    this.name = 'ExportRunFailure';
  }
}

/** A definition answered something the export cannot write (a programming error of the report): the run fails. */
export function internalFailure(): ExportRunFailure {
  return new ExportRunFailure('internal');
}

/** The disk or the hosting quota is full (`ENOSPC`, `EDQUOT`, or the platform's `DISK_QUOTA` for them). */
export function isDiskFull(error: unknown): boolean {
  if (isDomainError(error)) return error.code === 'DISK_QUOTA';
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOSPC' || code === 'EDQUOT';
}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The rows phase: the data rows in `rows.ndjson` and its length (the cursor of the report is the payload's `cursor`). */
export const rowsStateSchema = z.strictObject({ rows: count, bytes: count });
export type RowsState = z.infer<typeof rowsStateSchema>;

/**
 * The write phase of a table report: the rows and the length of the finished `rows.ndjson`, how far it was read, and the
 * output so far: the length of a CSV's `output.part`, the XLSX writer's checkpoint (null before the workbook exists).
 */
export const writeStateSchema = z.strictObject({
  rows: count,
  ndjsonBytes: count,
  offset: count,
  outBytes: count,
  xlsx: xlsxCheckpointSchema.nullable(),
});
export type WriteState = z.infer<typeof writeStateSchema>;

/** The resume state of a document report's rendering, as its last slice answered it (null before the first). */
export const documentStateSchema = z.strictObject({
  resume: z.strictObject({ phase: z.string(), cursor: z.string().nullable(), state: z.unknown() }).nullable(),
});
export type DocumentState = z.infer<typeof documentStateSchema>;

/** The finished `output.part`: its size, the counts the run records and the warning codes of a document. */
export const finishStateSchema = z.strictObject({
  rows: count,
  nonLatinRows: count.nullable(),
  size: count,
  warnings: z.array(z.string()).max(REPORT_WARNINGS_MAX),
});
export type FinishState = z.infer<typeof finishStateSchema>;
