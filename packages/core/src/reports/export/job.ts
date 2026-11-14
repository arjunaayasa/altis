import { withTx, type ReportRunsTable } from '@altis/db';
import { ensureHeadroom, removeTree, reportWorkDir, statOrNull, truncateFile } from '@altis/platform';
import { DEFAULT_LOCALE, isDomainError, isLocale, localDate } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import { REPORT_EXPORT_CURSOR_MAX, StoredRunParams } from '@altis/shared/api/reports';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { CatalogJobDeps } from '../../catalog/jobs-deps.js';
import { errorFields } from '../../context.js';
import type { JobContext, JobHandler, JobOutcome } from '../../jobs/types.js';
import { loadAccredSettings } from '../../settings/accreditation.js';
import { readSettings } from '../../settings/service.js';
import { reportById } from '../registry.js';
import type { ReportDefinition } from '../types.js';
import { CsvPhase } from './csv-phase.js';
import { renderDocument } from './document-phase.js';
import { endRun, recordedEnd, removeRunFiles, succeedRun } from './finish.js';
import { writePdf } from './pdf-phase.js';
import { RowsPhase } from './rows-phase.js';
import {
  ExportRunFailure,
  documentStateSchema,
  finishStateSchema,
  internalFailure,
  isDiskFull,
  rowsStateSchema,
  workFile,
  writeStateSchema,
  type DocumentState,
  type ExportFormat,
  type ExportRun,
  type FinishState,
  type RowsState,
  type WriteState,
} from './state.js';
import { XlsxPhase } from './xlsx-phase.js';

// `reports.export` (spec §4.15): writes a report run's file across slices, each within the slice's budget, its
// checkpoint in the job's payload, cancellable, and resumable after the process dies at any point.
//
// A slice reads the run (`report_runs`): a run that ended already (the housekeeping found it abandoned) leaves the job
// nothing to do but remove what is left of its work. The first slice moves the run from `queued` to `running` (a
// conditional update) and starts with an empty work folder `tmp/reports/<runId>/`. The definition's functions get the
// run's language (`report_runs.locale`; every accreditation run is stored in Indonesian), the stored `def` as their
// parameters, the run's creation as their clock and the slice's budget.
//
// A table report goes through three phases (rows-phase.ts; then csv-, xlsx- or pdf-phase.ts; then finish.ts): its rows
// into `rows.ndjson`, the file from them into `output.part` (with room for twice `rows.ndjson` proven first), then the
// run's end. A document report renders `output.part` itself (document-phase.ts), one render per slice, then ends. A
// slice does at least one step and goes on while more than 2 s, and more than 1.5 times its last step, is left of its
// budget; a PDF layout and a document's render only begin a slice. The end is done as soon as it is reached; a slice
// that dies inside it leaves its end recorded in the run, and the next slice finishes from there (finish.ts).
//
// Cancel (`ctx.cancelled()`): the run ends `cancelled`, its work folder and its file removed. A failure a retry cannot
// mend ends the run `failed` at once: REPORT_TOO_LARGE (a report without a count passed its format's limit; the job's
// message names the rows, the limit and the format), `disk_full` (ENOSPC/EDQUOT), `internal` (the definition answered
// what the export cannot hold). Any other error is retried by the queue; its last attempt ends the run `failed` with
// `internal`.

/** What the report jobs are built with: the catalogue jobs' facts and the running release (printed in the PDFs). */
export type ReportJobDeps = CatalogJobDeps & { appVersion: string };

/** The export job's payload: its run and, between slices, the phase, the report's cursor and the phase's state. */
export const ReportsExportPayload = z.strictObject({
  runId: ulidField,
  phase: z.enum(['rows', 'write', 'finish']).optional(),
  cursor: z.string().max(REPORT_EXPORT_CURSOR_MAX).nullable().optional(),
  state: z.unknown().optional(),
});

export type ReportsExportPayload = z.infer<typeof ReportsExportPayload>;

/** A slice stops when less than this, or 1.5 × its last step, is left of its budget. */
const SLICE_MARGIN_MS = 2_000;

const FORMATS: ReadonlySet<string> = new Set<ExportFormat>(['csv', 'xlsx', 'pdf', 'zip']);

/** Where a run is: a phase and its state (a document's rendering is stored as the payload's `write` phase). */
type Checkpoint =
  | { phase: 'rows'; cursor: string | null; state: RowsState }
  | { phase: 'write'; state: WriteState }
  | { phase: 'render'; state: DocumentState }
  | { phase: 'finish'; state: FinishState };

/** Where a run starts. */
function initialCheckpoint(def: ReportDefinition): Checkpoint {
  return def.kind === 'table' ? { phase: 'rows', cursor: null, state: { rows: 0, bytes: 0 } } : { phase: 'render', state: { resume: null } };
}

/**
 * The checkpoint a payload holds for `def`, or null at the start.
 *
 * @throws ExportRunFailure `internal` for a state this job cannot have written
 */
function checkpointOf(def: ReportDefinition, payload: ReportsExportPayload): Checkpoint | null {
  const parse = <T>(schema: z.ZodType<T>): T => {
    const parsed = schema.safeParse(payload.state);
    if (!parsed.success) throw internalFailure();
    return parsed.data;
  };
  switch (payload.phase) {
    case undefined:
      return null;
    case 'rows':
      if (def.kind !== 'table') throw internalFailure();
      return { phase: 'rows', cursor: payload.cursor ?? null, state: parse(rowsStateSchema) };
    case 'write':
      return def.kind === 'table' ? { phase: 'write', state: parse(writeStateSchema) } : { phase: 'render', state: parse(documentStateSchema) };
    case 'finish':
      return { phase: 'finish', state: parse(finishStateSchema) };
  }
}

/**
 * `reports.export`: interactive (its creator's page drives it), retryable from the API. `o.reportById` finds a run's
 * definition (default: the registry's).
 */
export function reportsExportJob(deps: () => ReportJobDeps, o: { reportById?: (id: string) => ReportDefinition | null } = {}): JobHandler<ReportsExportPayload> {
  const lookup = o.reportById ?? reportById;
  return {
    type: 'reports.export',
    permission: 'system.jobs.manage',
    retryable: 'api',
    interactive: true,
    payload: ReportsExportPayload,
    async run(ctx, payload) {
      const d = deps();
      const row = await ctx.db.selectFrom('report_runs').selectAll().where('id', '=', payload.runId).executeTakeFirst();
      if (row === undefined) {
        d.log.warn('report export: the job names no run', { jobId: ctx.jobId, runId: payload.runId });
        return { done: true, message: 'run missing' };
      }
      // Ended already (here, or by the housekeeping): what is left of its work goes; a succeeded run keeps its file.
      if (row.status !== 'queued' && row.status !== 'running') {
        await removeRunFiles({ runId: row.id, format: row.format, dataDir: d.dataDir }, row.status === 'succeeded');
        return { done: true, message: row.status };
      }
      return new ExportSlice(ctx, payload, d, row, lookup).run();
    },
  };
}

/** One slice of an export (see the top of this file). */
class ExportSlice {
  private ended = false;
  private cp: Checkpoint | null = null;
  private rows: RowsPhase | null = null;
  private csv: CsvPhase | null = null;
  private xlsx: XlsxPhase | null = null;
  /** `rows.ndjson` was checked and room for the write phase proven in this slice. */
  private readyToWrite = false;

  constructor(
    private readonly job: JobContext,
    private readonly payload: ReportsExportPayload,
    private readonly deps: ReportJobDeps,
    private readonly row: Selectable<ReportRunsTable>,
    private readonly lookup: (id: string) => ReportDefinition | null,
  ) {}

  async run(): Promise<JobOutcome<ReportsExportPayload>> {
    const last = await this.job.db.selectFrom('jobs').select(['attempts', 'max_attempts']).where('id', '=', this.job.jobId).executeTakeFirst();
    const lastAttempt = last !== undefined && Number(last.attempts) + 1 >= Number(last.max_attempts);
    try {
      return await this.slice();
    } catch (error) {
      await this.dropPhases();
      if (isDomainError(error) && error.code === 'JOB_LEASE_LOST') throw error;
      if (this.ended) throw error;
      if (error instanceof ExportRunFailure || isDiskFull(error)) {
        const code = error instanceof ExportRunFailure ? error.code : 'disk_full';
        await this.end('failed', code);
        return { done: true, message: error instanceof ExportRunFailure ? error.jobMessage : `failed: ${code}` };
      }
      this.deps.log.warn('report export: a slice failed, the queue retries it', { runId: this.row.id, reportId: this.row.report_id, lastAttempt, ...errorFields(error) });
      if (lastAttempt) {
        try {
          await this.end('failed', 'internal');
        } catch (second) {
          if (isDomainError(second) && second.code === 'JOB_LEASE_LOST') throw second;
        }
      }
      throw error;
    }
  }

  private async slice(): Promise<JobOutcome<ReportsExportPayload>> {
    const job = this.job;
    if (this.row.status === 'queued') {
      const started = await withTx(job.handle, async (trx) => {
        const r = await trx.updateTable('report_runs').set({ status: 'running' }).where('id', '=', this.row.id).where('status', '=', 'queued').executeTakeFirst();
        return Number(r.numUpdatedRows) === 1;
      });
      if (!started) return { done: true, message: 'run ended' };
    }
    const run = await this.prepare();
    // An earlier slice recorded the run's end and died before it was done: finish from that end, wherever the file is.
    const recorded = recordedEnd(this.row, run.stored);
    if (recorded !== null) {
      this.cp = { phase: 'finish', state: recorded };
      return this.succeed(run, recorded);
    }
    let cp = checkpointOf(run.def, this.payload);
    if (cp === null) {
      await removeTree(reportWorkDir(run.dataDir, run.runId));
      cp = initialCheckpoint(run.def);
    }
    this.cp = cp;

    let lastStepMs = 0;
    for (let steps = 0; ; steps += 1) {
      if (job.cancelled()) {
        await this.dropPhases();
        await this.end('cancelled', null);
        return { continueWith: this.checkpointPayload(), progress: this.progress(), message: 'cancelled' };
      }
      const at = this.cp!;
      if (at.phase === 'finish') return this.succeed(run, at.state);
      if (steps > 0 && (this.beginsSlice(run) || job.budgetLeftMs() < Math.max(SLICE_MARGIN_MS, 1.5 * lastStepMs))) break;
      const started = performance.now();
      await this.step(run);
      lastStepMs = performance.now() - started;
      await job.heartbeat({ progress: this.progress() });
    }
    await this.closePhases();
    return { continueWith: this.checkpointPayload(), progress: this.progress() };
  }

  /** The run as this slice works on it. @throws ExportRunFailure `internal` for a run this build cannot write */
  private async prepare(): Promise<ExportRun> {
    const { row, job } = this;
    const def = this.lookup(row.report_id);
    if (def === null || !FORMATS.has(row.format) || !(def.formats as readonly string[]).includes(row.format)) throw internalFailure();
    let stored: StoredRunParams;
    try {
      stored = StoredRunParams.parse(JSON.parse(row.params));
    } catch {
      throw internalFailure();
    }
    const locale = isLocale(row.locale) ? row.locale : DEFAULT_LOCALE;
    const s = await readSettings(job.db, ['library.name', 'library.timezone'], []);
    const tz = s['library.timezone'] as string;
    const staff = row.created_by === null ? undefined : await job.db.selectFrom('staff_users').select('name').where('id', '=', row.created_by).executeTakeFirst();
    const createdAt = Number(row.created_at);
    return {
      runId: row.id,
      def,
      format: row.format as ExportFormat,
      locale,
      stored,
      dataDir: this.deps.dataDir,
      deps: this.deps,
      job,
      db: job.db,
      handle: job.handle,
      report: {
        db: job.db,
        locale,
        tz,
        now: createdAt,
        today: localDate(tz, createdAt),
        settings: await loadAccredSettings(job.db),
        params: stored.def,
        budgetLeftMs: () => job.budgetLeftMs(),
      },
      libraryName: s['library.name'] as string,
      staffName: staff?.name ?? '',
    };
  }

  /** The next step takes a slice of its own: a PDF layout, a document's render. */
  private beginsSlice(run: ExportRun): boolean {
    return this.cp?.phase === 'render' || (this.cp?.phase === 'write' && run.format === 'pdf');
  }

  /** One step of the run's current phase. */
  private async step(run: ExportRun): Promise<void> {
    const cp = this.cp!;
    switch (cp.phase) {
      case 'rows': {
        if (this.rows === null) {
          this.rows = await RowsPhase.open(run, cp.state);
          if (this.rows === null) {
            // `rows.ndjson` was lost: the rows start over.
            await this.restart(run);
            return;
          }
        }
        const next = await this.rows.step(cp.cursor);
        const state = this.rows.current;
        if (next !== null) {
          this.cp = { phase: 'rows', cursor: next, state };
          return;
        }
        await this.rows.close();
        this.rows = null;
        this.cp = { phase: 'write', state: { rows: state.rows, ndjsonBytes: state.bytes, offset: 0, outBytes: 0, xlsx: null } };
        return;
      }
      case 'write': {
        if (!(await this.prepareWrite(run, cp.state))) return;
        if (run.format === 'csv') {
          this.csv ??= await CsvPhase.open(run, cp.state);
          const done = await this.csv.step();
          const state = this.csv.current;
          if (!done) {
            this.cp = { phase: 'write', state };
            return;
          }
          await this.csv.close();
          this.csv = null;
          this.cp = { phase: 'finish', state: { rows: state.rows, nonLatinRows: null, size: state.outBytes, warnings: [] } };
          return;
        }
        if (run.format === 'xlsx') {
          this.xlsx ??= await XlsxPhase.open(run, cp.state);
          const r = await this.xlsx.step();
          if (!r.done) {
            this.cp = { phase: 'write', state: this.xlsx.current };
            return;
          }
          this.xlsx = null;
          this.cp = { phase: 'finish', state: { rows: cp.state.rows, nonLatinRows: null, size: r.size, warnings: [] } };
          return;
        }
        if (run.format === 'pdf') {
          this.cp = { phase: 'finish', state: await writePdf(run, cp.state) };
          return;
        }
        throw internalFailure();
      }
      case 'render': {
        const r = await renderDocument(run, cp.state);
        this.cp = r.done ? { phase: 'finish', state: r.finish } : { phase: 'render', state: r.state };
        return;
      }
      case 'finish':
        return;
    }
  }

  /** The run's work is lost: its work folder emptied, the run starts over. */
  private async restart(run: ExportRun): Promise<void> {
    await this.dropPhases();
    await removeTree(reportWorkDir(run.dataDir, run.runId));
    this.cp = initialCheckpoint(run.def);
  }

  /**
   * Before the first write step of a slice: `rows.ndjson` holds what the rows phase recorded (else the rows start over:
   * false), and there is room for twice its size.
   */
  private async prepareWrite(run: ExportRun, state: WriteState): Promise<boolean> {
    if (this.readyToWrite) return true;
    const ndjson = workFile(run, 'rows.ndjson');
    const info = await statOrNull(ndjson);
    if (state.ndjsonBytes > 0 && (info === null || info.kind !== 'file' || info.size < state.ndjsonBytes)) {
      await this.restart(run);
      return false;
    }
    if (info !== null && info.kind === 'file' && info.size > state.ndjsonBytes) await truncateFile(ndjson, state.ndjsonBytes);
    await ensureHeadroom(run.dataDir, 2 * state.ndjsonBytes);
    this.readyToWrite = true;
    return true;
  }

  /** The end of the slice: open files flushed, the XLSX writer's checkpoint taken into the state. */
  private async closePhases(): Promise<void> {
    if (this.rows !== null) {
      await this.rows.close();
      this.rows = null;
    }
    if (this.csv !== null) {
      await this.csv.close();
      this.csv = null;
    }
    if (this.xlsx !== null) {
      await this.xlsx.close();
      if (this.cp?.phase === 'write') this.cp = { phase: 'write', state: this.xlsx.current };
      this.xlsx = null;
    }
  }

  /** Open files closed without a checkpoint (an error, a cancel, a restart): the next step starts from the stored one. */
  private async dropPhases(): Promise<void> {
    await this.rows?.close().catch(() => undefined);
    await this.csv?.close().catch(() => undefined);
    this.rows = null;
    this.csv = null;
    this.xlsx = null;
  }

  private async succeed(run: ExportRun, state: FinishState): Promise<JobOutcome<ReportsExportPayload>> {
    const ended = await succeedRun(run, state);
    this.ended = true;
    if (!ended) return { done: true, message: 'run ended' };
    return state.warnings.length > 0 ? { done: true, message: 'warnings' } : { done: true };
  }

  private async end(status: 'failed' | 'cancelled', code: string | null): Promise<void> {
    if (this.ended) return;
    await endRun({ runId: this.row.id, format: this.row.format, dataDir: this.deps.dataDir, handle: this.job.handle, job: this.job }, status, code);
    this.ended = true;
  }

  private checkpointPayload(): ReportsExportPayload {
    const runId = this.row.id;
    const cp = this.cp;
    if (cp === null) return { runId };
    switch (cp.phase) {
      case 'rows':
        return { runId, phase: 'rows', cursor: cp.cursor, state: cp.state };
      case 'write':
      case 'render':
        return { runId, phase: 'write', state: cp.state };
      case 'finish':
        return { runId, phase: 'finish', state: cp.state };
    }
  }

  /** A rough share done: the rows phase up to 40, the write phase by how much of `rows.ndjson` is written. */
  private progress(): number {
    const cp = this.cp;
    if (cp === null) return 0;
    switch (cp.phase) {
      case 'rows':
        return Math.min(40, 5 + Math.floor(cp.state.rows / 1000));
      case 'write':
        return 40 + Math.floor((55 * cp.state.offset) / Math.max(1, cp.state.ndjsonBytes));
      case 'render':
        return 50;
      case 'finish':
        return 99;
    }
  }
}
