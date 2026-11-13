import { withTx } from '@altis/db';
import { removeFile, removeTree, renameRetry, reportExportPath, reportWorkDir, statOrNull, type ReportFileExt } from '@altis/platform';
import { REPORT_RUN_TTL_DAYS, StoredRunParams } from '@altis/shared/api/reports';
import { internalFailure, workFile, type ExportRun, type FinishState } from './state.js';

// The end of a run (spec §4.15, §3.7):
// - succeeded: `output.part` is renamed to `exports/reports/<runId>.<format>`; the run gets its status, its row count,
//   its count of non-Latin rows (a PDF's only), the file's name and size, `finished_at` and `expires_at` seven days
//   later, and a document's warning codes in its parameters; then the work folder is removed at once. A slice that died
//   between the rename and the run's update finds the file in place and finishes the update.
// - failed (with its error code) or cancelled: the run is ended and its work folder and any file it had are removed.
// Each update is conditional on the run being live: a run another process ended (the housekeeping found it abandoned)
// stays as that process left it, and what this export wrote is removed.

const DAY_MS = 86_400_000;

const FORMATS: ReadonlySet<string> = new Set<ReportFileExt>(['csv', 'xlsx', 'pdf', 'zip']);

/** `stored` with `warnings`, dropping the last codes until the whole JSON fits its limit. */
function paramsWithWarnings(stored: StoredRunParams, warnings: readonly string[]): string {
  for (let n = warnings.length; n >= 0; n -= 1) {
    const next = { ...stored, ...(n === 0 ? {} : { warnings: warnings.slice(0, n) }) };
    if (StoredRunParams.safeParse(next).success) return JSON.stringify(next);
  }
  return JSON.stringify(stored);
}

/** Ends the run `succeeded` with `state` (see the top of this file); false when another process had ended it. */
export async function succeedRun(run: ExportRun, state: FinishState): Promise<boolean> {
  const part = workFile(run, 'output.part');
  const target = reportExportPath(run.dataDir, run.runId, run.format);
  const pending = await statOrNull(part);
  if (pending !== null) {
    if (pending.kind !== 'file' || pending.size !== state.size) throw internalFailure();
    await renameRetry(part, target);
  }
  const written = await statOrNull(target);
  if (written === null || written.kind !== 'file' || written.size !== state.size) throw internalFailure();

  const now = run.job.now();
  const ended = await withTx(run.handle, async (trx) => {
    const r = await trx
      .updateTable('report_runs')
      .set({
        status: 'succeeded',
        row_count: state.rows,
        non_latin_rows: state.nonLatinRows,
        output_name: `${run.runId}.${run.format}`,
        output_size: written.size,
        finished_at: now,
        expires_at: now + REPORT_RUN_TTL_DAYS * DAY_MS,
        ...(state.warnings.length === 0 ? {} : { params: paramsWithWarnings(run.stored, state.warnings) }),
      })
      .where('id', '=', run.runId)
      .where('status', '=', 'running')
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  });
  if (!ended) await removeFile(target).catch(() => undefined);
  await removeTree(reportWorkDir(run.dataDir, run.runId)).catch(() => undefined);
  return ended;
}

/** A run's end as the failure and cancel paths know it: its format may be one this build does not write. */
export interface RunToEnd {
  runId: string;
  format: string;
  dataDir: string;
  handle: ExportRun['handle'];
  job: ExportRun['job'];
}

/** Removes the run's work folder and, unless `keepFile`, its file in `exports/reports/`. Never throws. */
export async function removeRunFiles(run: Pick<RunToEnd, 'runId' | 'format' | 'dataDir'>, keepFile: boolean): Promise<void> {
  if (!keepFile && FORMATS.has(run.format)) await removeFile(reportExportPath(run.dataDir, run.runId, run.format as ReportFileExt)).catch(() => undefined);
  await removeTree(reportWorkDir(run.dataDir, run.runId)).catch(() => undefined);
}

/** Ends the run `failed` (with `code`) or `cancelled` and removes what it wrote. */
export async function endRun(run: RunToEnd, status: 'failed' | 'cancelled', code: string | null): Promise<void> {
  const now = run.job.now();
  const keepFile = await withTx(run.handle, async (trx) => {
    const r = await trx
      .updateTable('report_runs')
      .set({ status, error_code: code, finished_at: now })
      .where('id', '=', run.runId)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 1) return false;
    // Ended elsewhere: a succeeded run's file is its download.
    const row = await trx.selectFrom('report_runs').select('status').where('id', '=', run.runId).executeTakeFirst();
    return row?.status === 'succeeded';
  });
  await removeRunFiles(run, keepFile);
}
