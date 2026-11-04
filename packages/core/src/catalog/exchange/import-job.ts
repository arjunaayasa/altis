import { withTx, type DB } from '@altis/db';
import {
  adoptRunWork,
  dataPath,
  openRead,
  removeFile,
  removeTree,
  renameRetry,
  runWorkDir,
  runWorkPath,
  statOrNull,
  type DataPath,
} from '@altis/platform';
import { DomainError, IMPORT_FORMATS, isDomainError, isUlid, type ImportFormat } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import { IMPORT_SAMPLE_MAX, ImportBody } from '@altis/shared/api/catalog/exchange';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { RunStarted } from '@altis/shared/api/catalog/runs';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { loadGrants } from '../../authz/grants.js';
import { errorFields, txCtx, type Actor, type TxCtx } from '../../context.js';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import { publish } from '../../events/publish.js';
import { enqueue } from '../../jobs/enqueue.js';
import type { JobContext, JobHandler, JobOutcome, JobRegistry } from '../../jobs/types.js';
import { indexRecords, stampChanged } from '../../search/index-records.js';
import { readSettings } from '../../settings/service.js';
import { loadCustomDefs } from '../data/custom-fields.js';
import { defaultCollectionTypeId, defaultMaterialTypeId } from '../data/defaults.js';
import {
  RUN_JSON_MAX_BYTES,
  RUN_REPORT_MAX_ROWS,
  RUN_WORK_KEEP_MS,
  attachRunJob,
  createRun,
  finishRun,
  getRun,
  saveRunSummary,
  startRun,
  writeRunReport,
  type RunEnd,
  type RunRow,
} from '../data/runs.js';
import type { CatalogJobDeps } from '../jobs-deps.js';
import { lockRecordRows } from '../records/service.js';
import { IMPORT_DETECT_BYTES, detectImportFormat } from './detect.js';
import {
  IMPORT_REPORT_HEADER,
  addCounts,
  emptyCounts,
  importBatch,
  type BatchSettings,
  type ImportCounts,
  type ImportIssue,
  type ImportReportRow,
  type ImportUnit,
} from './import-batch.js';
import { ImportFormatError, openImportSource, type ImportPosition, type ImportSource, type ReadUnit } from './import-read.js';
import { MasterLookup } from './match.js';
import { appendReportLines, reportLine, reportRowsOf, truncateReportLines } from './report-file.js';

// The import job `catalog.import` and how an import starts (Phase 2 spec §5.1–§5.3, §12.6; plan Task 31; S3, S11,
// S19, S21, M7; Review Focus 1 and 5).
//
// Starting (the route `POST catalog/imports`, in its transaction; startCatalogImport): the run (`catalog_runs`, kind
// `import`, options `{body, stagingId, adoptedFrom}`), the job, `catalog.import.start`. The file is the staged upload
// (moved to `tmp/<runId>/import.bin` after the COMMIT, and again by the first slice when that move was lost), or the
// work folder of a dry run (S3: same user, succeeded, finished less than 7 days ago, not adopted yet, marked adopted by
// a compare-and-set on its options, its folder renamed to the new run's after the COMMIT and again by the first slice).
//
// A slice:
// 1. A run that ended already (the housekeeping ends a run whose job died or was cancelled, Task 19) ends the job.
// 2. The work file is put in place; the report work file is cut back to what the saved counters cover.
// 3. The format is the body's, else the dry run's, else detected from the first 64 KiB (none → the run fails with
//    CATALOG_IMPORT_FORMAT).
// 4. The file is read from the checkpoint (import-read.ts) in batches of 200 units. Each batch is one transaction
//    (importBatch, import-batch.ts): its catalogue writes, its legacy-map rows, the run's counters and resume point,
//    the datestamp of the records it stamped moved to the clock read then (C14: `changed_at` = the moment the batch
//    commits, so an OAI harvest that ran while it was open still selects them next time), and
//    `catalog.bulk.changed {runId}` last. Its report rows are appended to the work file inside that transaction
//    (which is therefore never run twice by withTx, `retry: false`: a conflict cuts the rows off again and runs the
//    batch anew), so the counters, the rows and the writes always agree, whatever moment a SIGKILL comes. The batch
//    also saves the ids of the records it wrote (directly or through an item), and right after its COMMIT a
//    transaction of their own builds their documents once more (X1-1): its first statement locks those records, so
//    what it reads is the latest commit, then indexRecords, the saved ids cleared, `catalog.bulk.changed {runId}`. The
//    batch indexed them in its own transaction (spec §4.1: searchable the moment it commits), but on MySQL/MariaDB
//    (REPEATABLE READ) everything it read after its first plain read came from that read's snapshot: a librarian's save
//    of one of those records (an author, another item's status) that committed meanwhile is not in the document the
//    batch wrote over the librarian's. A slice that ended between the two (a kill, an error) does it at its next start,
//    and the run's end does it too. A dry run
//    runs the same batch and rolls it back: it writes only its counters, its first 20 drafts and its report (and keeps
//    its `import.bin`, S3). So a dry batch does not see what the earlier ones would have written (review L06): a
//    record or barcode repeated more than a batch apart counts as created twice there, where the real run matches,
//    skips or updates the second one. Within a batch the counts are the real run's. The admin says so under a dry run's
//    summary (`catalog.exchange.summary.dry_note`).
// 5. The resume point saved with a batch is the last exact reader boundary (import-read.ts) and the last unit done; a
//    resumed slice reads from the later of it and the job's checkpoint, and passes over the units already done. The
//    job's checkpoint (S21: the byte offset, the CSV state, the MARCXML prefixes) is that boundary at the slice's end.
//    Units passed over are no batch of the slice: a slice too short for more than one batch (a cron pass hands a job
//    down to its last 250 ms) still writes one, instead of stopping on the units the previous one already wrote.
// 6. A batch that fails for a reason other than a conflict or the environment is run again one unit per transaction;
//    a unit that fails alone is a report row `error` with its code, and the import goes on (Review Focus 5).
// 7. At the end of the file: the report (writeRunReport, the first 10 000 rows), finishRun, `catalog.import.finish`
//    (system actor, the counts in `meta`), and the work folder removed (a dry run keeps its `import.bin`). Cancel ends
//    the run `cancelled` the same way. A file that cannot be read (CATALOG_IMPORT_FORMAT) ends it `failed`; any other
//    failure is retried by the queue and fails the run on its last attempt.

/** The import job's type. */
export const CATALOG_IMPORT_JOB = 'catalog.import';

/** Units per batch (one transaction). The admin's dry-run note (`catalog.exchange.summary.dry_note`, L06) names it. */
const BATCH = 200;
/** The most file warnings a summary keeps. */
const WARNINGS_MAX = 50;
/** A slice stops after a batch it wrote once less than this, or 1.5 × that batch's time, is left of its budget. */
const SLICE_MARGIN_MS = 2_000;
/** The attempts of a batch that conflicts (withTx itself is told not to run it again). */
const CONFLICT_ATTEMPTS = 5;
/** The longest a batch waits before it runs again after a conflict. */
const CONFLICT_BACKOFF_MS = 200;
/** Records per locking statement of a refresh (step 4 of the top of this file). */
const REFRESH_CHUNK = 500;
/** The longest prefix map a checkpoint holds (readMarcXml bounds it far below). */
const PREFIX_ENTRIES_MAX = 80;
const PREFIX_TEXT_MAX = 8_192;

const SYSTEM: Actor = Object.freeze({ type: 'system', id: null, ip: null });

/**
 * readMarcXml's prefixes() as JSON brings it back: an object of strings, kept as parsed (a schema that copies its keys
 * would drop an own `__proto__`, which an XML prefix may be).
 */
function isPrefixMap(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= PREFIX_ENTRIES_MAX && entries.every(([k, s]) => k.length <= PREFIX_TEXT_MAX && typeof s === 'string' && s.length <= PREFIX_TEXT_MAX);
}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const checkpointSchema = z.strictObject({
  byteOffset: count,
  recordNo: count,
  csv: z.strictObject({ byteOffset: count, line: count, separator: z.enum([',', ';']), encoding: z.enum(['utf-8', 'cp1252']) }).optional(),
  xmlPrefixes: z.custom<Record<string, string>>(isPrefixMap).optional(),
});

/** The payload (and checkpoint) of `catalog.import` (S21). */
export const importJobPayload = z.strictObject({
  runId: ulidField,
  /** Null until the first slice detected it. */
  format: z.enum(IMPORT_FORMATS).nullable(),
  options: ImportBody,
  checkpoint: checkpointSchema,
});

export type ImportJobPayload = z.infer<typeof importJobPayload>;

/** A run's options (`catalog_runs.options`): the request body, where its file came from, and its adoption (S3). */
interface ImportRunOptions {
  body: ImportBody;
  /** The staged upload taken (`tmp/<stagingId>/upload.bin`), or null. */
  stagingId: string | null;
  /** The dry run whose work folder this run took over (S3), or null. */
  adoptedFrom: string | null;
  /** Set on a dry run once a real run took its folder over. */
  adoptedBy?: string;
}

// Not strict: a key a run of another edition stored (a `branchLimit`, ruling R13) is stripped, not refused.
const runOptionsSchema = z.object({
  body: ImportBody,
  stagingId: ulidField.nullable(),
  adoptedFrom: ulidField.nullable(),
  adoptedBy: ulidField.optional(),
});

/** What a run saves with each batch to resume exactly (see the top of this file). */
interface ResumeState {
  position: ImportPosition;
  /** The last unit done (≥ position.recordNo). */
  done: number;
  reportBytes: number;
  reportRows: number;
  reportDropped: number;
  /** The records the batches committed since the last refresh wrote: their documents are built again (X1-1). */
  reindex: string[];
}

/** The running summary of an import (`ImportSummary` of @altis/shared plus what the job resumes with). */
interface RunningSummary {
  counts: ImportCounts;
  warnings: string[];
  sample: RecordDraft[];
  resume: ResumeState;
}

type Db = Kysely<DB> | Transaction<DB>;

function fieldError(path: string, code: string): DomainError {
  return new DomainError('VALIDATION_FAILED', { detail: 'Permintaan impor tidak valid / The import request is not valid', meta: { errors: [{ path, code }] } });
}

// ---- test hook (R57) -------------------------------------------------------------------------------------------------

/** What a slice read (test profile): where it started, and how many bytes of the file its reader took. */
export interface ImportSliceRead {
  runId: string;
  startByte: number;
  bytesRead: number;
}

let sliceObserver: ((r: ImportSliceRead) => void) | null = null;

/**
 * Test-only (the resume test, S21): `fn` is called at the end of every import slice with what it read; null removes it.
 *
 * @throws TypeError outside the test profile
 */
export function __setImportSliceObserver(fn: ((r: ImportSliceRead) => void) | null): void {
  if (__BUILD_PROFILE__ !== 'test') throw new TypeError('__setImportSliceObserver is a test hook');
  sliceObserver = fn;
}

// ---- summary ---------------------------------------------------------------------------------------------------------

function parseRunOptions(text: string): ImportRunOptions {
  return runOptionsSchema.parse(JSON.parse(text)) as ImportRunOptions;
}

/** The running summary a run saved (a new run: empty). */
function runningSummary(text: string): RunningSummary {
  const fresh: RunningSummary = {
    counts: emptyCounts(),
    warnings: [],
    sample: [],
    resume: { position: { byteOffset: 0, recordNo: 0 }, done: 0, reportBytes: 0, reportRows: 0, reportDropped: 0, reindex: [] },
  };
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return fresh;
  }
  if (typeof v !== 'object' || v === null) return fresh;
  const resume = v.resume as ResumeState | undefined;
  if (typeof resume !== 'object' || resume === null) return fresh;
  const n = (x: unknown): number => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0);
  const skipped: Record<string, number> = {};
  if (typeof v.skipped === 'object' && v.skipped !== null) for (const [k, x] of Object.entries(v.skipped)) skipped[k] = n(x);
  const position = checkpointSchema.safeParse(resume.position);
  return {
    counts: {
      read: n(v.read),
      created: n(v.created),
      updated: n(v.updated),
      skipped,
      duplicates: n(v.duplicates),
      itemsCreated: n(v.itemsCreated),
      errors: n(v.errors),
    },
    warnings: Array.isArray(v.warnings) ? v.warnings.filter((w): w is string => typeof w === 'string').slice(0, WARNINGS_MAX) : [],
    sample: Array.isArray(v.sample) ? (v.sample as RecordDraft[]).slice(0, IMPORT_SAMPLE_MAX) : [],
    resume: {
      position: position.success ? (position.data as ImportPosition) : fresh.resume.position,
      done: n(resume.done),
      reportBytes: n(resume.reportBytes),
      reportRows: n(resume.reportRows),
      reportDropped: n(resume.reportDropped),
      reindex: Array.isArray(resume.reindex) ? [...new Set(resume.reindex.filter((id): id is string => typeof id === 'string' && isUlid(id)))] : [],
    },
  };
}

/**
 * The summary JSON (ImportSummary): the counts, the warnings, a dry run's sample (drafts dropped from the end until the
 * whole is within RUN_JSON_MAX_BYTES, Review Focus 3), the resume state while the run goes on, and `error`/`reason`
 * for a run that failed.
 */
function summaryJson(s: RunningSummary, o: { dryRun: boolean; resume: boolean; error?: { code: string; reason: string } }): Record<string, unknown> {
  const base: Record<string, unknown> = { ...s.counts, warnings: s.warnings };
  if (o.error !== undefined) {
    base.error = o.error.code;
    base.reason = o.error.reason;
  }
  if (o.resume) base.resume = s.resume;
  if (!o.dryRun) return base;
  const sample = [...s.sample];
  for (;;) {
    const doc = { ...base, sample };
    if (Buffer.byteLength(JSON.stringify(doc), 'utf8') <= RUN_JSON_MAX_BYTES || sample.length === 0) return doc;
    sample.pop();
  }
}

function addWarnings(into: string[], add: readonly string[]): void {
  for (const w of add) if (!into.includes(w) && into.length < WARNINGS_MAX) into.push(w);
}

// ---- the job ---------------------------------------------------------------------------------------------------------

/** Why a run fails without a retry. */
class ImportRunFailure extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(`import failed: ${code} (${reason})`);
    this.name = 'ImportRunFailure';
  }
}

/** Thrown inside a dry run's batch transaction to roll it back with what it found. */
class DryRollback extends Error {
  constructor(readonly outcome: Awaited<ReturnType<typeof importBatch>>) {
    super('dry run rollback');
    this.name = 'DryRollback';
  }
}

/** An error that says nothing about the unit being written: the queue retries the slice. */
function environmental(error: unknown): boolean {
  if (error instanceof ImportFormatError || error instanceof ImportRunFailure) return true;
  if (!isDomainError(error)) return false;
  return ['TX_CONFLICT', 'DB_UNAVAILABLE', 'DISK_QUOTA', 'JOB_LEASE_LOST', 'STATE_CORRUPT'].includes(error.code);
}

function isConflict(error: unknown): boolean {
  return isDomainError(error) && error.code === 'TX_CONFLICT';
}

/** The code a unit that failed alone is reported with. */
function failureCode(error: unknown): string {
  return isDomainError(error) ? error.code : 'internal';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The `catalog.import` handler: permission `catalog.import.run`, `longRunning` and `cpuHeavy` (it holds `jobs:heavy`),
 * `interactive` (the Impor screen drives it where no worker runs), retryable through the API (a slice redone resumes
 * exactly). See the top of this file.
 */
export function importJob(deps: () => CatalogJobDeps): JobHandler<ImportJobPayload> {
  return {
    type: CATALOG_IMPORT_JOB,
    permission: 'catalog.import.run',
    retryable: 'api',
    interactive: true,
    longRunning: true,
    cpuHeavy: true,
    payload: importJobPayload,
    async run(ctx, payload) {
      const d = deps();
      const run = await getRun(ctx.db, payload.runId);
      if (run === null || run.kind !== 'import') {
        d.log.warn('catalog import: the job names no import run', { jobId: ctx.jobId, runId: payload.runId });
        return { done: true, message: 'run missing' };
      }
      // A slice retried after the run ended (P7), or a run the housekeeping ended (Task 19): nothing left to do.
      if (run.status !== 'queued' && run.status !== 'running') return { done: true, message: run.status };
      return new ImportSlice(ctx, payload, d, run).run();
    },
  };
}

/** One slice of an import (see the top of this file). */
class ImportSlice {
  private readonly runId: string;
  private readonly dataDir: string;
  private readonly dryRun: boolean;
  private readonly options: ImportRunOptions;
  private readonly state: RunningSummary;
  private readonly actor: Actor;
  private format: ImportFormat | null;
  private position: ImportPosition;
  private headerReported = false;
  private finished = false;

  constructor(
    private readonly ctx: JobContext,
    private readonly payload: ImportJobPayload,
    private readonly deps: CatalogJobDeps,
    private readonly row: RunRow,
  ) {
    this.runId = row.id;
    this.dataDir = deps.dataDir;
    this.dryRun = Number(row.dry_run) === 1;
    this.options = parseRunOptions(row.options);
    this.state = runningSummary(row.summary);
    this.actor = row.created_by === null ? SYSTEM : { type: 'staff', id: row.created_by, ip: null };
    this.format = payload.format ?? (row.format as ImportFormat | null);
    // The later of the job's checkpoint and the resume point of the last batch committed.
    const saved = this.state.resume.position;
    this.position = saved.recordNo >= payload.checkpoint.recordNo ? saved : (payload.checkpoint as ImportPosition);
  }

  private file(): DataPath {
    return runWorkPath(this.dataDir, this.runId, 'import.bin');
  }

  async run(): Promise<JobOutcome<ImportJobPayload>> {
    const last = await this.ctx.db.selectFrom('jobs').select(['attempts', 'max_attempts']).where('id', '=', this.ctx.jobId).executeTakeFirst();
    const lastAttempt = last !== undefined && Number(last.attempts) + 1 >= Number(last.max_attempts);
    try {
      return await this.slice();
    } catch (error) {
      if (isDomainError(error) && error.code === 'JOB_LEASE_LOST') throw error;
      if (this.finished) throw error;
      if (error instanceof ImportFormatError) return this.fail('CATALOG_IMPORT_FORMAT', error.reason);
      if (error instanceof ImportRunFailure) return this.fail(error.code, error.reason);
      this.deps.log.warn('catalog import: a slice failed, the queue retries it', { runId: this.runId, lastAttempt, ...errorFields(error) });
      if (lastAttempt) {
        try {
          await this.fail('error', failureCode(error));
        } catch (second) {
          if (isDomainError(second) && second.code === 'JOB_LEASE_LOST') throw second;
        }
      }
      throw error;
    }
  }

  private async slice(): Promise<JobOutcome<ImportJobPayload>> {
    const { ctx } = this;
    if (this.row.status === 'queued') await withTx(ctx.handle, (trx) => startRun(trx, this.runId, ctx.now()));
    // The documents of a batch whose slice ended before its refresh (step 4 of the top of this file).
    await this.refresh();
    await this.prepareWork();
    const format = await this.detect();
    const settings = await this.batchSettings(format);
    const leader = await new MasterLookup(ctx.db).leaderResolver();
    const fileSize = (await statOrNull(this.file()))?.size ?? 0;
    const startByte = this.position.byteOffset;
    const source = await openImportSource(this.file(), format, this.position, { leader });
    let lastBatchMs = 0;
    try {
      for (let batches = 0; ; ) {
        if (ctx.cancelled()) {
          await this.finish('cancelled');
          return { continueWith: this.checkpoint(format), progress: this.progress(fileSize), message: 'cancelled' };
        }
        if (batches > 0 && ctx.budgetLeftMs() < Math.max(SLICE_MARGIN_MS, 1.5 * lastBatchMs)) break;
        const units = await source.next(BATCH);
        if (units.length === 0) {
          // A file without a unit still reports its header's problems and its warnings.
          const rows = this.fileRows(source);
          addWarnings(this.state.warnings, source.warnings());
          if (rows.length > 0) await this.batch(settings, [], rows, null, this.state.resume.done);
          await this.finish('succeeded');
          return { done: true, message: 'succeeded' };
        }
        const started = Date.now();
        if (await this.commit(source, settings, units)) {
          batches += 1;
          lastBatchMs = Date.now() - started;
        }
        await this.refresh();
        await ctx.heartbeat({ progress: this.progress(fileSize) });
      }
    } finally {
      sliceObserver?.({ runId: this.runId, startByte, bytesRead: source.bytesRead() });
      await source.close().catch(() => undefined);
    }
    return { continueWith: this.checkpoint(format), progress: this.progress(fileSize) };
  }

  private checkpoint(format: ImportFormat): ImportJobPayload {
    return { runId: this.runId, format, options: this.payload.options, checkpoint: { ...this.position } };
  }

  private progress(fileSize: number): number {
    return fileSize === 0 ? 0 : Math.min(99, Math.floor((100 * this.position.byteOffset) / fileSize));
  }

  // ---- work files -------------------------------------------------------------------------------------------------------

  /** Step 2 of the top of this file. */
  private async prepareWork(): Promise<void> {
    const file = this.file();
    const { adoptedFrom, stagingId } = this.options;
    if ((await statOrNull(file))?.kind !== 'file') {
      if (adoptedFrom !== null) {
        try {
          await adoptRunWork(this.dataDir, adoptedFrom, this.runId);
        } catch (error) {
          // The route's own rename (after its COMMIT) may have won the race: the file is there then.
          if ((await statOrNull(file))?.kind !== 'file') {
            if (isDomainError(error) && (error.code === 'NOT_FOUND' || error.code === 'INVALID_PATH_SEGMENT')) throw new ImportRunFailure('CATALOG_IMPORT_FORMAT', 'work_missing');
            throw error;
          }
        }
      } else if (stagingId !== null) {
        await moveStaged(this.dataDir, stagingId, file);
      }
      if ((await statOrNull(file))?.kind !== 'file') throw new ImportRunFailure('CATALOG_IMPORT_FORMAT', 'work_missing');
    }
    if (stagingId !== null) await removeTree(dataPath(this.dataDir, 'tmp', stagingId)).catch(() => undefined);
    const resume = this.state.resume;
    if (!(await truncateReportLines(this.dataDir, this.runId, resume.reportBytes))) {
      // The work file lost rows the counters cover (its folder was lost and found again): they cannot come back.
      addWarnings(this.state.warnings, ['report_incomplete']);
      resume.reportBytes = (await statOrNull(runWorkPath(this.dataDir, this.runId, 'report.csv')))?.size ?? 0;
    }
  }

  /** Step 3 of the top of this file. */
  private async detect(): Promise<ImportFormat> {
    if (this.format !== null) return this.format;
    const head = await readHead(this.file());
    if (head === null) throw new ImportRunFailure('CATALOG_IMPORT_FORMAT', 'work_missing');
    const format = detectImportFormat(head);
    if (format === null) throw new ImportFormatError('unknown_format');
    await withTx(this.ctx.handle, (trx) => trx.updateTable('catalog_runs').set({ format }).where('id', '=', this.runId).where('format', 'is', null).execute());
    this.format = format;
    return format;
  }

  /** What every batch of this slice is processed with: the grants of the run's creator (S11), read once. */
  private async batchSettings(format: ImportFormat): Promise<BatchSettings> {
    const db = this.ctx.db;
    const body = this.options.body;
    const s = await readSettings(db, ['catalog.dedupe.threshold', 'catalog.defaultMaterialTypeId', 'catalog.defaultCollectionTypeId'], []);
    let defaults: { material: string; collection: string };
    try {
      defaults = {
        material: await defaultMaterialTypeId(db, body.defaultMaterialTypeId ?? (s['catalog.defaultMaterialTypeId'] as string | null)),
        collection: await defaultCollectionTypeId(db, body.defaultCollectionTypeId ?? (s['catalog.defaultCollectionTypeId'] as string | null)),
      };
    } catch (error) {
      if (isDomainError(error) && error.code === 'VALIDATION_FAILED') throw new ImportRunFailure('VALIDATION_FAILED', 'no_default_master');
      throw error;
    }
    return {
      runId: this.runId,
      format,
      matchOn: body.matchOn,
      onMatch: body.onMatch,
      onDuplicate: body.onDuplicate,
      createItems: body.createItems,
      branchId: body.branchId ?? null,
      defaultMaterialTypeId: defaults.material,
      defaultCollectionTypeId: defaults.collection,
      threshold: s['catalog.dedupe.threshold'] as number,
      grants: this.row.created_by === null ? null : await loadGrants(db, this.row.created_by),
      recordDefs: await loadCustomDefs(db, 'records'),
      itemDefs: await loadCustomDefs(db, 'items'),
    };
  }

  // ---- batches ----------------------------------------------------------------------------------------------------------

  /** The report rows of the file itself (its header's problems, its warnings), reported with the first batch. */
  private fileRows(source: ImportSource): ImportReportRow[] {
    if (this.headerReported || this.position.recordNo !== 0 || this.position.byteOffset !== 0) return [];
    this.headerReported = true;
    const issues: ImportIssue[] = [...source.warnings().map((w): ImportIssue => ({ level: 'warning', code: w })), ...source.headerIssues()];
    return issues.map((i) => ['0', '1', i.level, i.code, i.field ?? '', '', '']);
  }

  /**
   * Processes `units` (step 4 of the top of this file): those already done are passed over; the rest are one batch,
   * or one unit per transaction when the batch failed for one of them (step 6).
   */
  /** Writes the batch `units`; false when every unit was done already and the file has no rows to report (step 5). */
  private async commit(source: ImportSource, settings: BatchSettings, units: readonly ReadUnit[]): Promise<boolean> {
    const boundary = [...units].reverse().find((u) => u.boundary !== null)?.boundary ?? null;
    const todo = units.filter((u) => u.unit.recordNo > this.state.resume.done);
    const lastNo = units[units.length - 1]!.unit.recordNo;
    const fileRows = this.fileRows(source);
    addWarnings(this.state.warnings, source.warnings());
    if (todo.length === 0 && fileRows.length === 0) {
      if (boundary !== null) this.position = boundary;
      return false;
    }
    try {
      await this.batch(settings, todo.map((u) => u.unit), fileRows, boundary, lastNo);
      return true;
    } catch (error) {
      if (environmental(error) || todo.length === 0) throw error;
      if (todo.length === 1) {
        await this.failedUnit(settings, todo[0]!.unit, error, fileRows, boundary, lastNo);
        return true;
      }
      this.deps.log.warn('catalog import: a batch failed, it runs again one unit at a time', { runId: this.runId, ...errorFields(error) });
    }
    // One unit per transaction; the file's rows go with the first, the batch's boundary with the last.
    for (const [i, u] of todo.entries()) {
      const lastOne = i === todo.length - 1;
      const rows = i === 0 ? fileRows : [];
      const at = lastOne ? boundary : null;
      const through = lastOne ? lastNo : u.unit.recordNo;
      try {
        await this.batch(settings, [u.unit], rows, at, through);
      } catch (unitError) {
        if (environmental(unitError)) throw unitError;
        await this.failedUnit(settings, u.unit, unitError, rows, at, through);
      }
    }
    return true;
  }

  /** A unit that failed alone: one report row `error` with its failure's code, in a transaction of its own. */
  private async failedUnit(
    settings: BatchSettings,
    unit: ImportUnit,
    error: unknown,
    fileRows: ImportReportRow[],
    boundary: ImportPosition | null,
    through: number,
  ): Promise<void> {
    this.deps.log.warn('catalog import: a unit failed and is reported', { runId: this.runId, recordNo: unit.recordNo, ...errorFields(error) });
    const failed: ImportUnit = { kind: 'error', recordNo: unit.recordNo, line: unit.line, code: failureCode(error) };
    await this.batch(settings, [failed], fileRows, boundary, through);
  }

  /**
   * One batch in one transaction (see step 4 of the top of this file), its conflicts run again here (withTx is told
   * not to, since the report rows are appended inside it). The state in memory changes only once it committed.
   */
  private async batch(
    settings: BatchSettings,
    units: readonly ImportUnit[],
    fileRows: readonly ImportReportRow[],
    boundary: ImportPosition | null,
    through: number,
  ): Promise<void> {
    const { ctx, runId, dataDir } = this;
    for (let attempt = 1; ; attempt += 1) {
      const before = this.state.resume.reportBytes;
      let next: RunningSummary;
      try {
        if (this.dryRun) {
          let outcome: Awaited<ReturnType<typeof importBatch>>;
          try {
            await withTx(ctx.handle, async (trx) => {
              throw new DryRollback(await importBatch(txCtx(trx, ctx.now(), this.actor), settings, units));
            }, { retry: false });
            throw new TypeError('a dry import batch was not rolled back');
          } catch (error) {
            if (!(error instanceof DryRollback)) throw error;
            outcome = error.outcome;
          }
          next = await this.nextState(outcome, units, fileRows, boundary, through);
          const saved = next;
          await withTx(ctx.handle, (trx) => saveRunSummary(trx, runId, summaryJson(saved, { dryRun: true, resume: true })));
        } else {
          next = await withTx(
            ctx.handle,
            async (trx) => {
              const tx = txCtx(trx, ctx.now(), this.actor);
              const outcome = await importBatch(tx, settings, units);
              // The rows are flushed before the COMMIT: a kill after it finds them, one before it cuts them off again.
              const state = await this.nextState(outcome, units, fileRows, boundary, through);
              await saveRunSummary(trx, runId, summaryJson(state, { dryRun: false, resume: true }));
              // The datestamp of what the batch stamped moves to the clock read right before its COMMIT (C14).
              await stampChanged(trx, outcome.recordIds, ctx.now(), { from: tx.now });
              if (outcome.wrote) await publish(trx, { channel: 'catalog', type: 'catalog.bulk.changed', payload: { runId } });
              return state;
            },
            { retry: false },
          );
        }
      } catch (error) {
        await truncateReportLines(dataDir, runId, before);
        if (isConflict(error) && attempt < CONFLICT_ATTEMPTS) {
          await sleep(Math.min(CONFLICT_BACKOFF_MS, 10 * 2 ** attempt) + Math.floor(Math.random() * 10));
          continue;
        }
        throw error;
      }
      Object.assign(this.state, next);
      if (boundary !== null) this.position = boundary;
      return;
    }
  }

  /** The state after a batch with `outcome`, its rows appended to the report work file (the first 10 000 only). */
  private async nextState(
    outcome: Awaited<ReturnType<typeof importBatch>>,
    units: readonly ImportUnit[],
    fileRows: readonly ImportReportRow[],
    boundary: ImportPosition | null,
    through: number,
  ): Promise<RunningSummary> {
    const s = this.state;
    const rows = [...fileRows, ...outcome.rows];
    const room = Math.max(0, RUN_REPORT_MAX_ROWS - s.resume.reportRows);
    const kept = rows.slice(0, room);
    const reportBytes = await appendReportLines(this.dataDir, this.runId, kept.map(reportLine));
    const sample = [...s.sample];
    if (this.dryRun) {
      for (const u of units) if (u.kind === 'record' && sample.length < IMPORT_SAMPLE_MAX) sample.push(u.draft);
    }
    return {
      counts: addCounts(s.counts, outcome.counts),
      warnings: [...s.warnings],
      sample,
      resume: {
        position: boundary ?? s.resume.position,
        done: Math.max(s.resume.done, through),
        reportBytes,
        reportRows: s.resume.reportRows + kept.length,
        reportDropped: s.resume.reportDropped + (rows.length - kept.length),
        // A dry batch was rolled back: nothing of it to build again.
        reindex: this.dryRun ? s.resume.reindex : [...new Set([...s.resume.reindex, ...outcome.recordIds])],
      },
    };
  }

  /**
   * Builds the documents of the records the batches committed since the last refresh wrote once more, in a transaction
   * of their own whose first statement locks those records (step 4 of the top of this file, X1-1): on MySQL/MariaDB the
   * snapshot then starts after any save of them committed, and a save that comes later waits for this one and builds
   * its own document after it. Their ids leave the saved summary in the same transaction, and `catalog.bulk.changed`
   * is its last statement. `changed_at` is not touched: the batch stamped what it changed (C14).
   */
  private async refresh(): Promise<void> {
    const ids = [...this.state.resume.reindex].sort();
    if (ids.length === 0) return;
    const { ctx, runId } = this;
    const next: RunningSummary = { ...this.state, resume: { ...this.state.resume, reindex: [] } };
    await withTx(ctx.handle, async (trx) => {
      for (let i = 0; i < ids.length; i += REFRESH_CHUNK) await lockRecordRows(trx, ids.slice(i, i + REFRESH_CHUNK));
      await indexRecords(trx, ids, ctx.now());
      await saveRunSummary(trx, runId, summaryJson(next, { dryRun: this.dryRun, resume: true }));
      await publish(trx, { channel: 'catalog', type: 'catalog.bulk.changed', payload: { runId } });
    });
    this.state.resume = next.resume;
  }

  // ---- the end ----------------------------------------------------------------------------------------------------------

  private async fail(code: string, reason: string): Promise<JobOutcome<ImportJobPayload>> {
    this.deps.log.warn('catalog import: the run failed', { runId: this.runId, code, reason });
    await this.finish('failed', { code, reason });
    return { done: true, message: `failed: ${code}` };
  }

  /** Step 7 of the top of this file. */
  private async finish(status: RunEnd, error?: { code: string; reason: string }): Promise<void> {
    if (this.finished) return;
    const { ctx, runId, dataDir } = this;
    try {
      await this.refresh();
    } catch (refreshError) {
      // A run that fails or is cancelled ends even when the documents of its last batch could not be built again.
      if (status === 'succeeded' || (isDomainError(refreshError) && refreshError.code === 'JOB_LEASE_LOST')) throw refreshError;
      this.deps.log.warn('catalog import: the documents of an ending run could not be built again', { runId, ...errorFields(refreshError) });
    }
    const now = ctx.now();
    const s = this.state;
    let reportFileId =
      (
        await ctx.db
          .selectFrom('files')
          .select('id')
          .where('owner_type', '=', 'catalog_runs')
          .where('owner_id', '=', runId)
          .where('context', '=', 'catalog.report')
          .limit(1)
          .executeTakeFirst()
      )?.id ?? null;
    if (reportFileId === null) {
      // The failure's own row, appended to what the counters cover (a finish run again after a kill writes it once).
      if (error !== undefined && (await truncateReportLines(dataDir, runId, s.resume.reportBytes))) {
        await appendReportLines(dataDir, runId, [reportLine([String(s.resume.done), '', 'error', error.code, error.reason, '', ''])]).catch(() => undefined);
      }
      try {
        reportFileId = await writeRunReport(ctx.handle, this.deps.storage, runId, IMPORT_REPORT_HEADER, reportRowsOf(dataDir, runId, s.resume.reportDropped), {
          now,
          createdBy: this.row.created_by,
        });
      } catch (writeError) {
        // A run that fails or is cancelled ends without its report rather than not at all.
        if (status === 'succeeded') throw writeError;
        this.deps.log.warn('catalog import: the report of an ending run could not be written', { runId, ...errorFields(writeError) });
      }
    }
    const summary = summaryJson(s, { dryRun: this.dryRun, resume: false, ...(error === undefined ? {} : { error }) });
    const skipped = Object.values(s.counts.skipped).reduce((a, b) => a + b, 0);
    const meta = {
      status,
      dryRun: this.dryRun,
      format: this.format,
      read: s.counts.read,
      created: s.counts.created,
      updated: s.counts.updated,
      skipped,
      duplicates: s.counts.duplicates,
      itemsCreated: s.counts.itemsCreated,
      errors: s.counts.errors,
      jobId: ctx.jobId,
    };
    await ctx.heartbeat();
    await withTx(ctx.handle, async (trx) => {
      const ended = await finishRun(trx, runId, { status, summary, reportFileId }, now);
      if (ended) await txCtx(trx, now, SYSTEM).audit({ action: 'catalog.import.finish', entity: 'catalog_runs', entityId: runId, meta });
    });
    this.finished = true;
    // A succeeded dry run keeps its input for the real run (S3); everything else of the work folder goes (best effort).
    if (this.dryRun && status === 'succeeded') await removeFile(runWorkPath(dataDir, runId, 'report.csv')).catch(() => undefined);
    else await removeTree(runWorkDir(dataDir, runId)).catch(() => undefined);
  }
}

// ---- starting ----------------------------------------------------------------------------------------------------------

/** A live row of `table` with `id`, or a field error at `path`. */
async function checkLive(db: Db, table: 'branches' | 'material_types' | 'collection_types', id: string | undefined, path: string): Promise<void> {
  if (id === undefined) return;
  const row = await db
    .selectFrom(table as 'branches')
    .select('id')
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) throw fieldError(path, 'not_found');
}

/** The first IMPORT_DETECT_BYTES of `file`, or null when there is no such file. */
async function readHead(file: DataPath): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof openRead>>;
  try {
    handle = await openRead(file);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const head = Buffer.alloc(IMPORT_DETECT_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The format an import of `body` will be read as, as far as it can be told before it starts (S11 at the route, which
 * must know whether items are written): the body's, else the adopted dry run's (its first slice stored the one it
 * detected), else the one detected from the head of the staged upload `tmp/<uploadId>/upload.bin`, as the first slice
 * will. Null when none can be told: no such run or file (the start refuses it), or nothing detected (the run fails
 * CATALOG_IMPORT_FORMAT).
 */
export async function importFormatBeforeStart(db: Db, dataDir: string, body: ImportBody): Promise<ImportFormat | null> {
  if (body.format !== undefined) return body.format;
  if (body.fromRunId !== undefined) {
    const run = await getRun(db, body.fromRunId);
    return run !== null && run.kind === 'import' && (IMPORT_FORMATS as readonly (string | null)[]).includes(run.format) ? (run.format as ImportFormat) : null;
  }
  if (body.uploadId === undefined) return null;
  const head = await readHead(dataPath(dataDir, 'tmp', body.uploadId, 'upload.bin'));
  return head === null ? null : detectImportFormat(head);
}

/**
 * The checks of S3 on `fromRunId` for the staff user `userId`: an import dry run of that user, succeeded, finished less
 * than 7 days ago and not adopted yet.
 *
 * @returns the dry run and its options (for the compare-and-set that marks it adopted)
 * @throws DomainError VALIDATION_FAILED `{path: 'fromRunId', code: 'not_found'}`
 */
async function checkImportAdoption(db: Db, o: { fromRunId: string; userId: string | null; now: number }): Promise<{ run: RunRow; options: ImportRunOptions }> {
  const run = await getRun(db, o.fromRunId);
  const notFound = fieldError('fromRunId', 'not_found');
  if (
    run === null ||
    run.kind !== 'import' ||
    Number(run.dry_run) !== 1 ||
    run.status !== 'succeeded' ||
    o.userId === null ||
    run.created_by !== o.userId ||
    run.finished_at === null ||
    Number(run.finished_at) <= o.now - RUN_WORK_KEEP_MS
  ) {
    throw notFound;
  }
  let options: ImportRunOptions;
  try {
    options = parseRunOptions(run.options);
  } catch {
    throw notFound;
  }
  if (options.adoptedBy !== undefined) throw notFound;
  return { run, options };
}

/**
 * Starts an import in `tx` (see the top of this file): `stagingId` is the staged upload the caller took (null with
 * `body.fromRunId`). The caller moves the staged file, or renames the adopted dry run's folder, after the COMMIT (the
 * first slice does it again when that was lost) and wakes the runner.
 *
 * @throws DomainError VALIDATION_FAILED at `fromRunId` (S3), `branchId`, `defaultMaterialTypeId`,
 *   `defaultCollectionTypeId` (`not_found`)
 */
export async function startCatalogImport(
  tx: TxCtx,
  registry: JobRegistry,
  input: { body: ImportBody; stagingId: string | null },
  o: { keyring: readonly KeyringEntry[] },
): Promise<RunStarted> {
  const { trx } = tx;
  const body = input.body;
  await checkLive(trx, 'branches', body.branchId, 'branchId');
  await checkLive(trx, 'material_types', body.defaultMaterialTypeId, 'defaultMaterialTypeId');
  await checkLive(trx, 'collection_types', body.defaultCollectionTypeId, 'defaultCollectionTypeId');
  const adopted = body.fromRunId === undefined ? null : await checkImportAdoption(trx, { fromRunId: body.fromRunId, userId: tx.actor.id, now: tx.now });
  const format = body.format ?? (adopted?.run.format as ImportFormat | null | undefined) ?? null;
  const options: ImportRunOptions = {
    body,
    stagingId: adopted === null ? input.stagingId : null,
    adoptedFrom: body.fromRunId ?? null,
  };
  const runId = await createRun(tx, { kind: 'import', dryRun: body.dryRun, format, options: options as unknown as Record<string, unknown> });
  const payload: ImportJobPayload = { runId, format, options: body, checkpoint: { byteOffset: 0, recordNo: 0 } };
  const queued = await enqueue(
    trx,
    registry,
    { type: CATALOG_IMPORT_JOB, payload, createdBy: tx.actor.type === 'staff' ? tx.actor.id : null },
    { now: tx.now, keyring: o.keyring },
  );
  await attachRunJob(trx, runId, queued.id);
  if (adopted !== null) {
    // Two adoptions of one dry run never both pass: the second's compare finds the options changed.
    const marked = await trx
      .updateTable('catalog_runs')
      .set({ options: JSON.stringify({ ...adopted.options, adoptedBy: runId }) })
      .where('id', '=', adopted.run.id)
      .where('options', '=', adopted.run.options)
      .executeTakeFirst();
    if (Number(marked.numUpdatedRows) !== 1) throw fieldError('fromRunId', 'not_found');
  }
  await tx.audit({
    action: 'catalog.import.start',
    entity: 'catalog_runs',
    entityId: runId,
    meta: {
      dryRun: body.dryRun,
      format,
      matchOn: body.matchOn,
      onMatch: body.onMatch,
      onDuplicate: body.onDuplicate,
      createItems: body.createItems,
      adoptedFrom: body.fromRunId ?? null,
    },
  });
  return { runId, jobId: queued.id };
}

/**
 * After the start's COMMIT (the route's hook; the first slice does the same when this is lost): the staged upload
 * becomes the run's `import.bin`, or the adopted dry run's folder becomes the run's. Best effort.
 */
export async function placeImportWork(dataDir: string, runId: string, o: { stagingId: string | null; fromRunId: string | null }): Promise<void> {
  const file = runWorkPath(dataDir, runId, 'import.bin');
  if ((await statOrNull(file))?.kind === 'file') return;
  if (o.fromRunId !== null) {
    await adoptRunWork(dataDir, o.fromRunId, runId).catch(async (error: unknown) => {
      // The first slice, in another process, may have renamed it first.
      if ((await statOrNull(file))?.kind !== 'file') throw error;
    });
  } else if (o.stagingId !== null) {
    await moveStaged(dataDir, o.stagingId, file);
    await removeTree(dataPath(dataDir, 'tmp', o.stagingId));
  }
}

/**
 * Moves the staged upload `tmp/<stagingId>/upload.bin` to `file` when it is there. The route's hook and a first slice
 * in another process may both try: the one that finds the upload gone while `file` exists has nothing to do.
 */
async function moveStaged(dataDir: string, stagingId: string, file: DataPath): Promise<void> {
  const staged = dataPath(dataDir, 'tmp', stagingId, 'upload.bin');
  if ((await statOrNull(staged))?.kind !== 'file') return;
  try {
    await renameRetry(staged, file);
  } catch (error) {
    if ((await statOrNull(file))?.kind !== 'file') throw error;
  }
}
