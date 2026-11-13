import { withTx, type DB } from '@altis/db';
import {
  adoptRunWork,
  dataPath,
  listNames,
  openRead,
  readBytes,
  removeFile,
  removeTree,
  renameRetry,
  runWorkDir,
  runWorkFileIn,
  runWorkPath,
  statOrNull,
  writeBytesAtomic,
  type DataPath,
} from '@altis/platform';
import { isDomainError } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import type { MigrationCharsetSample, MigrationSummary, SlimsVersion } from '@altis/shared/api/catalog/migration';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { RUN_JSON_MAX_BYTES, finishRun, saveRunSummary, startRun, writeRunReport, type RunEnd, type RunRow } from '../../catalog/data/runs.js';
import type { CatalogJobDeps } from '../../catalog/jobs-deps.js';
import { errorFields, txCtx, type Actor } from '../../context.js';
import { publish } from '../../events/publish.js';
import type { JobContext, JobOutcome } from '../../jobs/types.js';
import { SEARCH_TOKEN_VERSION } from '../../search/tokenize.js';
import { createCounters } from './counters.js';
import { releaseSlimsSearchIndex } from './ending.js';
import { slimsSources } from './factory.js';
import { stageOptions, type SlimsRunSettings } from './options.js';
import { reconcile } from './reconcile.js';
import { SLIMS_REPORT_HEADER, appendSlimsReport, slimsReportLine, slimsReportRows, slimsSummaryRows, truncateSlimsReport } from './report.js';
import { SPLIT_TABLE_NAME, type SplitDumpReader } from './source/dump-split.js';
import type { SlimsFilesSource, SlimsSource, SlimsTableInfo, SplitCheckpoint } from './source/types.js';
import type { SlimsReportRow, SlimsStage, SlimsStageContext } from './stage.js';

// The slices of a SLiMS migration run (Phase 2 spec §11.1–§11.3, §11.6; plan Task 23). One slice of the job
// `catalog.migrate_slims`:
//
// 1. reads the run (`catalog_runs`) and its options; a run that has ended already ends the job (a retried slice);
// 2. resumes from the checkpoint the summary keeps (`resume`: the stage, its cursor, the split checkpoint and the length
//    of the report work file), which is saved together with the counters after the stage work it covers committed; the
//    job's payload carries the same checkpoint, saved by the queue just after, so a process that died between the two
//    saves resumes from the summary's and counts nothing twice;
// 3. puts the run's input in place (idempotent, again after a crash): the dry run's work folder it adopts (S3), the
//    staged uploads or CLI copies it moves into `tmp/<runId>/` (`dump.bin`, `files.bin`); then cuts the report work
//    file back to the checkpoint's length. The start route does the same after its COMMIT (placeSlimsWork), so the
//    taken uploads, whose upload sessions are gone, are protected by the run's id (S2) while the job waits for its
//    first slice (C25); either may find the other did it first;
// 4. runs the current stage, then the next ones, until the slice's budget (less a margin for saving) is spent; at least
//    one stage call per slice, so a slice always moves;
// 5. appends the slice's report rows to the work file, then saves the counters and the checkpoint in one transaction
//    (`catalog.bulk.changed {runId}` its last statement after a writing stage of a real run), and hands the checkpoint
//    to the queue.
//
// The stages are `split` (dump sources only: the dump into per-table NDJSON staging, `tables.json` beside it), then
// `analyze` and `report` (analyze-stage.ts, report-stage.ts) around the middle eight of Tasks 37 and 38. The report
// stage ends the run through `finish`: the report file (writeRunReport), then in one transaction `finishRun`, the
// search index `ready` (a real run that holds it; or a full rebuild queued over documents of another token format:
// ending.ts releaseSlimsSearchIndex), `catalog.migration.finish` by the system actor, and the bulk event.
//
// Work folder (S2, S3, S10): only a succeeded dry run keeps `tmp/<runId>/` once it ended (its real run adopts it), less
// its dump; any other run's folder is removed when it ends. A run that ends otherwise than succeeded removes its input
// and staging (all but the report work file) before it writes anything, and writes its report rows best effort, so a
// run that filled the disk (S10) can still end, and on SQLite (`DATA_DIR/db/`) commit its end.
//
// Failures (decision for P7): a cancel request ends the run `cancelled`; DISK_QUOTA (S10: `disk_full`), an unsupported
// source, lost input and programming errors end it `failed` at once with a report row, and the job succeeds with the
// message `failed: <code>`; anything else (the database, the source's connection) is thrown for the queue's retry,
// except on the job's last attempt, where the run is ended `failed` first so it never stays `running` under a dead job.

/** The type of the migration job. */
export const SLIMS_MIGRATION_JOB = 'catalog.migrate_slims';

/** The longest stage cursor the checkpoint keeps (a keyset cursor, a line number, a stage's own JSON). */
export const SLIMS_CURSOR_MAX = 4096;

/** A slice keeps this much of its budget for appending its report rows and saving its counters. */
const SAVE_MARGIN_MS = 2_000;
/** The report rows a slice buffers before it appends them to the work file. */
const BUFFER_MAX_BYTES = 1024 * 1024;
/** The split checkpoint's JSON (one entry per staged table) stays within this: the payload is ≤ 65 535 bytes. */
const SPLIT_CHECKPOINT_MAX_BYTES = 16_384;
/** `tables.json` is read back whole, up to this size. */
const TABLES_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** The rows per target table counted before and after the run (M13). */
export const SLIMS_TARGET_TABLES = Object.freeze([
  'records',
  'items',
  'agents',
  'subjects',
  'publishers',
  'attachments',
  'pages',
  'migration_map',
  'migration_archive',
] as const);

type TargetTable = (typeof SLIMS_TARGET_TABLES)[number];
type Db = Kysely<DB> | Transaction<DB>;

const SYSTEM: Actor = { type: 'system', id: null, ip: null };

/**
 * What splitDump's checkpoint and table list name (source/dump-split.ts): a table as the split tracks it (its own
 * rule, SPLIT_TABLE_NAME), and a staging file (`<table>.ndjson`, the table list's `split_tables.ndjson`). Task 39: the
 * checkpoint is splitDump's own shape, with its `rows` and `headroomAt`; a stricter schema here failed every split
 * that needed a second slice, and a stricter rule for `tables.json` every dump holding a table with a capital letter.
 */
const SPLIT_TABLE = SPLIT_TABLE_NAME;
const SPLIT_FILE = /^[A-Za-z0-9_$-]{1,64}\.ndjson$/;

const splitCheckpointSchema = z.strictObject({
  offset: z.int().min(0),
  files: z.record(z.string().regex(SPLIT_FILE), z.int().min(0)),
  rows: z.record(z.string().regex(SPLIT_TABLE), z.int().min(0)).optional(),
  headroomAt: z.int().min(0).optional(),
});

/** The payload of `catalog.migrate_slims`: the run, the stage (an index into the run's stage list), its cursor. */
export const migrateSlimsPayload = z.strictObject({
  runId: ulidField,
  stage: z.int().min(0).max(63),
  cursor: z.string().min(1).max(SLIMS_CURSOR_MAX).nullable(),
  split: splitCheckpointSchema.optional(),
});

export type MigrateSlimsPayload = z.infer<typeof migrateSlimsPayload>;

/** The staged dump's tables as `tables.json` keeps them (Task 10's SlimsTableInfo, its own extra fields kept). */
const stagedTables = z
  .array(
    z.looseObject({
      name: z.string().regex(SPLIT_TABLE),
      columns: z.array(z.string().min(1).max(64)).max(4096),
      primaryKey: z.array(z.string().min(1).max(64)).max(64),
      rows: z.int().min(0).nullable(),
    }),
  )
  .max(4096);

/** A failure that ends the run `failed` with the report row `code` (and `detail`), without the queue's retries. */
export class SlimsRunFailure extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`SLiMS migration failed: ${code}`);
    this.name = 'SlimsRunFailure';
    this.code = code;
    this.detail = detail;
  }
}

/** Where a run stands: saved in the summary after every slice, with the counters. */
export interface SlimsResume {
  /** The index of the current stage in the run's stage list. */
  stage: number;
  cursor: string | null;
  split?: SplitCheckpoint;
  /** The length of the report work file the counters cover. */
  reportBytes: number;
}

/** What the summary keeps besides the counters (MigrationSummary's other fields, and the framework's own). */
export interface SlimsPipelineState {
  version: SlimsVersion | null;
  stage: string | null;
  charset: MigrationCharsetSample[];
  targets: { table: string; before: number; after: number }[];
  checks: MigrationSummary['checks'];
  /** The SLiMS title of each checked `biblio` row, by its id (cut to 120 characters). */
  checkSource: Record<string, string>;
  missingFiles: number;
  nonstandardBarcodes: number;
  warnings: string[];
  /** A real run holds the search index `building` (released when the run ends: ending.ts releaseSlimsSearchIndex). */
  indexBuilding: boolean;
  resume: SlimsResume;
}

/** What the framework's own stages (`split`, `analyze`, `report`) get besides the stage context. */
export interface SlimsPipeline {
  readonly runId: string;
  readonly jobId: string;
  readonly run: RunRow;
  readonly settings: SlimsRunSettings;
  readonly dryRun: boolean;
  readonly deps: CatalogJobDeps;
  readonly db: Kysely<DB>;
  readonly stages: readonly SlimsStage[];
  readonly state: SlimsPipelineState;
  /** C19: the dump's reader the split keeps between the slices of this process (the job session's). */
  readonly splitKeep: { reader: SplitDumpReader | null };
  /** The tables the run's middle stages read (their `reads`). */
  readTables(): ReadonlySet<string>;
  /** A summary warning code, once. */
  warn(code: string): void;
  /** Marks the search index `building` (a real run, before its writing stages) when the run may hold it (X2-1). */
  markIndexBuilding(): Promise<void>;
  /** Writes the staged dump's tables (`tables.json`) for the stages after the split. */
  saveStagedTables(tables: readonly SlimsTableInfo[]): Promise<void>;
  /** Ends the run with `status` (the report, the run row, the finish audit). Idempotent within the slice. */
  finish(status: RunEnd): Promise<void>;
}

/** The context of a framework stage. */
export interface SlimsPipelineContext extends SlimsStageContext {
  readonly pipeline: SlimsPipeline;
}

/**
 * The pipeline of `c`, which the framework's own stages need.
 *
 * @throws TypeError when `c` is not a context the framework made
 */
export function pipelineOf(c: SlimsStageContext): SlimsPipeline {
  const p = (c as Partial<SlimsPipelineContext>).pipeline;
  if (p === undefined) throw new TypeError('a framework stage of the SLiMS migration runs only inside its job');
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/** `s` cut to `max` code points. */
export function cutText(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join('');
}

/** The rows of `table` (a fixed name). */
async function rowCount(db: Db, table: TargetTable): Promise<number> {
  const row = await db
    .selectFrom(table as 'records')
    .select((eb) => eb.fn.countAll<number | string | bigint>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** The rows of every target table (M13). */
export async function slimsTargetCounts(db: Db): Promise<Record<TargetTable, number>> {
  const out = {} as Record<TargetTable, number>;
  for (const t of SLIMS_TARGET_TABLES) out[t] = await rowCount(db, t);
  return out;
}

/** The documents of the search index. */
async function searchDocs(trx: Transaction<DB>): Promise<number> {
  return Number((await trx.selectFrom('search_doc').select((eb) => eb.fn.countAll<number | string | bigint>().as('n')).executeTakeFirstOrThrow()).n);
}

/**
 * Marks the one `search_state` row `building` under job `jobId` (markIndexBuilding, X2-1) when a run may hold it: a
 * `ready` index, which the run's own documents keep complete; a missing row only while the catalogue has no record
 * (nothing a rebuild would add); a row this job holds already (the slice that took it died before its summary saved).
 * A row another build holds (a full rebuild that runs, was cancelled or died) and a missing row over records (after a
 * restore) are left to that rebuild, or to the one the boot and the housekeeping queue: a run that did not take the
 * index never marks it ready (its end and closeAbandonedSlimsRun look for this job's id), so the OPAC keeps its "results
 * may be incomplete" notice until the index holds every record. The taken row keeps the token format of the documents
 * it holds (`token_version`) only when it is this release's (SEARCH_TOKEN_VERSION; an empty index, inserted, is), so
 * that the run's end marks the index ready only over documents of one format (X2-2, ending.ts releaseSlimsSearchIndex).
 *
 * @returns whether the run holds the index
 */
async function takeSearchState(trx: Transaction<DB>, jobId: string): Promise<boolean> {
  const found = await trx.selectFrom('search_state').select(['status', 'job_id', 'token_version']).where('id', '=', 1).executeTakeFirst();
  if (found === undefined) {
    if ((await trx.selectFrom('records').select('id').limit(1).executeTakeFirst()) !== undefined) return false;
    await trx
      .insertInto('search_state')
      .values({ id: 1, status: 'building', docs: await searchDocs(trx), job_id: jobId, built_at: null, token_version: SEARCH_TOKEN_VERSION })
      .execute();
    return true;
  }
  if (found.status !== 'ready') return found.status === 'building' && found.job_id === jobId;
  const current = found.token_version !== null && Number(found.token_version) === SEARCH_TOKEN_VERSION;
  const taken = await trx
    .updateTable('search_state')
    .set({ status: 'building', docs: await searchDocs(trx), job_id: jobId, token_version: current ? SEARCH_TOKEN_VERSION : null })
    .where('id', '=', 1)
    .where('status', '=', 'ready')
    .executeTakeFirst();
  return Number(taken.numUpdatedRows) > 0;
}

function objectOf(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/** The state a summary holds (tolerant: anything missing or malformed starts empty), with `payload` as the fallback checkpoint. */
function stateOf(summary: Record<string, unknown>, payload: MigrateSlimsPayload): SlimsPipelineState {
  const resumeRaw = objectOf(summary['resume']);
  let resume: SlimsResume = { stage: payload.stage, cursor: payload.cursor, reportBytes: 0, ...(payload.split === undefined ? {} : { split: payload.split }) };
  if (resumeRaw !== null) {
    const cursor = resumeRaw['cursor'];
    const split = splitCheckpointSchema.safeParse(resumeRaw['split']);
    resume = {
      stage: int(resumeRaw['stage']),
      cursor: typeof cursor === 'string' && cursor !== '' && cursor.length <= SLIMS_CURSOR_MAX ? cursor : null,
      reportBytes: int(resumeRaw['reportBytes']),
      ...(split.success ? { split: split.data } : {}),
    };
  }
  const version = summary['version'];
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const checkSource: Record<string, string> = {};
  for (const [k, v] of Object.entries(objectOf(summary['checkSource']) ?? {})) if (typeof v === 'string') checkSource[k] = v;
  return {
    version: version === '9' || version === '8' || version === 'unknown' ? version : null,
    stage: typeof summary['stage'] === 'string' ? summary['stage'] : null,
    charset: Array.isArray(summary['charset']) ? (summary['charset'] as MigrationCharsetSample[]) : [],
    targets: Array.isArray(summary['targets']) ? (summary['targets'] as SlimsPipelineState['targets']) : [],
    checks: Array.isArray(summary['checks']) ? (summary['checks'] as MigrationSummary['checks']) : [],
    checkSource,
    missingFiles: int(summary['missingFiles']),
    nonstandardBarcodes: int(summary['nonstandardBarcodes']),
    warnings: strings(summary['warnings']),
    indexBuilding: summary['indexBuilding'] === true,
    resume,
  };
}

/** `run.summary` as an object ({} when it is not one). */
function summaryObject(run: RunRow): Record<string, unknown> {
  try {
    return objectOf(JSON.parse(run.summary)) ?? {};
  } catch {
    return {};
  }
}

/**
 * `doc` within the 60 000 bytes of `catalog_runs.summary`: the charset samples, then the repair samples, then the
 * checked titles, then the warnings, then the charset columns, then the repair counts give way (the report has them
 * all); the table counts, which the reconciliation needs, never do.
 *
 * @throws TypeError when even the table counts alone do not fit
 */
function bounded(
  doc: Record<string, unknown> & { samples: unknown[]; charset: MigrationCharsetSample[]; warnings: string[]; fixes: Record<string, unknown> },
): Record<string, unknown> {
  const size = (): number => Buffer.byteLength(JSON.stringify(doc), 'utf8');
  for (let bytes = size(); bytes > RUN_JSON_MAX_BYTES; bytes = size()) {
    const withSamples = doc.charset.filter((c) => c.samples.length > 0);
    if (withSamples.length > 0) {
      const widest = withSamples.reduce((a, b) => (b.samples.length > a.samples.length ? b : a));
      widest.samples = widest.samples.slice(0, -1);
    } else if (doc.samples.length > 0) {
      doc.samples = doc.samples.slice(0, -1);
    } else if (Object.keys(objectOf(doc['checkSource']) ?? {}).length > 0) {
      doc['checkSource'] = {};
    } else if (doc.warnings.length > 0) {
      doc.warnings = doc.warnings.slice(0, -1);
    } else if (doc.charset.length > 0) {
      doc.charset = doc.charset.slice(0, -1);
    } else if (Object.keys(doc.fixes).length > 0) {
      doc.fixes = {};
    } else {
      throw new TypeError(`the SLiMS migration summary is ${bytes} bytes of JSON even without its samples`);
    }
  }
  return doc;
}

/** Whether `error` ends the run at once (a code and a detail for the report), or is left to the queue's retry. */
function failureOf(error: unknown): { code: string; detail: string } | 'retry' {
  if (error instanceof SlimsRunFailure) return { code: error.code, detail: error.detail };
  if (isDomainError(error)) {
    switch (error.code) {
      case 'DISK_QUOTA':
        return { code: 'disk_full', detail: 'Ruang disk tidak cukup / Not enough disk space' };
      case 'MIGRATION_SOURCE_UNSUPPORTED':
        return { code: 'source_unsupported', detail: error.detail ?? 'Sumber tidak didukung / The source is not supported' };
      case 'DB_UNAVAILABLE':
      case 'TX_CONFLICT':
      case 'MIGRATION_SOURCE_UNREACHABLE':
        return 'retry';
      default:
        return { code: 'error', detail: error.code };
    }
  }
  if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) {
    return { code: 'error', detail: error.name };
  }
  return 'retry';
}

// ---------------------------------------------------------------------------------------------------------------
// The job session: the run's source and files, opened on first use and kept across the slices of one process.

interface SlimsIo {
  source: SlimsSource | null;
  /** undefined: not opened yet in this session. */
  files: SlimsFilesSource | null | undefined;
  /** C19: the dump's reader between two split slices (a gzipped dump is then never decompressed twice). */
  split: { reader: SplitDumpReader | null };
}

async function closeIo(io: SlimsIo): Promise<void> {
  const source = io.source;
  const files = io.files;
  const reader = io.split.reader;
  io.source = null;
  io.files = undefined;
  io.split.reader = null;
  try {
    await source?.close();
  } finally {
    try {
      await files?.close();
    } finally {
      await reader?.close();
    }
  }
}

/** A source for the `split` stage, which has none yet: any use is a programming error. */
const NO_SOURCE: SlimsSource = Object.freeze({
  kind: 'dump' as const,
  tables: () => Promise.reject(new TypeError('the SLiMS source is not open during the split')),
  rows: () => Promise.reject(new TypeError('the SLiMS source is not open during the split')),
  close: () => Promise.resolve(),
});

/** Whether the file `p` starts with the gzip magic bytes. */
async function isGzip(p: DataPath): Promise<boolean> {
  const handle = await openRead(p);
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    return bytesRead === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The run's input

/**
 * Moves the staged file `tmp/<id>/upload.bin` to `target` unless that is done, and removes `tmp/<id>/`. The start
 * route's hook and the first slice (maybe in another process) may both try: the one that finds the upload gone, or
 * loses the rename, while `target` is there has nothing to do.
 *
 * @returns false when neither the upload nor `target` is there
 */
async function placeStaged(dataDir: string, id: string, target: DataPath): Promise<boolean> {
  const from = dataPath(dataDir, 'tmp', id, 'upload.bin');
  const placed = async (): Promise<boolean> => (await statOrNull(target))?.kind === 'file';
  if (!(await placed())) {
    if ((await statOrNull(from))?.kind === 'file') {
      try {
        await renameRetry(from, target);
      } catch (error) {
        if (!(await placed())) throw error;
      }
    } else if (!(await placed())) {
      return false;
    }
  }
  await removeTree(dataPath(dataDir, 'tmp', id));
  return true;
}

/**
 * After the start's COMMIT (the route's hook; the first slice does the same when this is lost): the adopted dry run's
 * folder becomes the run's (S3), and the taken uploads become its `dump.bin` and `files.bin` (C25), so that its id
 * protects them (S2) however long the job waits. An input already in place is left as it is.
 *
 * @throws what the renames throw (an adoption whose folder is gone included) when nothing is in place afterwards
 */
export async function placeSlimsWork(
  dataDir: string,
  runId: string,
  o: { fromRunId: string | null; dumpStagingId: string | null; filesStagingId: string | null },
): Promise<void> {
  if (o.fromRunId !== null) {
    await adoptRunWork(dataDir, o.fromRunId, runId).catch(async (error: unknown) => {
      // The job's first slice, in another process, may have renamed it first.
      if ((await statOrNull(runWorkDir(dataDir, runId)))?.kind !== 'dir') throw error;
    });
  }
  if (o.dumpStagingId !== null) await placeStaged(dataDir, o.dumpStagingId, runWorkPath(dataDir, runId, 'dump.bin'));
  if (o.filesStagingId !== null) await placeStaged(dataDir, o.filesStagingId, runWorkPath(dataDir, runId, 'files.bin'));
}

// ---------------------------------------------------------------------------------------------------------------
// The split stage (dump sources only)

/**
 * `split`: a dump source's `dump.bin` into one NDJSON staging file per table (Task 10's splitDump, from the checkpoint
 * the run keeps, for the slice's budget), then `tables.json`. A database source, and a run that adopted its dry run's
 * staging (S3), have nothing to split.
 */
export const slimsSplitStage: SlimsStage = Object.freeze({
  name: 'split' as const,
  reads: Object.freeze([]) as readonly string[],
  async run(c: SlimsStageContext): Promise<{ done: boolean; cursor: string | null }> {
    const p = pipelineOf(c);
    if (p.settings.sourceKind !== 'dump' || p.settings.adoptedFrom !== null) return { done: true, cursor: null };
    const dump = runWorkPath(c.dataDir, c.runId, 'dump.bin');
    const r = await slimsSources().splitDump({
      dumpPath: dump,
      gz: await isGzip(dump),
      stagingDir: runWorkDir(c.dataDir, c.runId),
      checkpoint: p.state.resume.split ?? null,
      budgetMs: Math.max(1, c.budgetLeftMs()),
      // C19: read on where this process's last slice stopped; a skip without it renews the lease as it goes.
      keep: p.splitKeep,
      heartbeat: () => c.heartbeat(0, 'split'),
    });
    if (!r.done) {
      const checkpoint = splitCheckpointSchema.safeParse(r.checkpoint);
      if (!checkpoint.success) throw new TypeError('splitDump returned a malformed checkpoint');
      if (Buffer.byteLength(JSON.stringify(checkpoint.data), 'utf8') > SPLIT_CHECKPOINT_MAX_BYTES) {
        throw new SlimsRunFailure('source_too_wide', 'Dump memuat terlalu banyak tabel / The dump holds too many tables');
      }
      p.state.resume.split = checkpoint.data;
      return { done: false, cursor: null };
    }
    await p.saveStagedTables(r.tables);
    delete p.state.resume.split;
    return { done: true, cursor: null };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// A skipped catalogue stage

/** The catalogue stages a run with `skipCatalog` skips. */
export const SLIMS_CATALOG_STAGES: readonly SlimsStage['name'][] = Object.freeze(['masters', 'records', 'relations', 'items', 'attachments', 'covers']);

/**
 * `stage` skipped (a run with `skipCatalog`, job.ts): it writes and counts nothing, and reports the skip once. Its
 * `reads` stay (the analyze stage counts their rows as the source's); the run's end counts every row of them that no
 * other stage accounted for as skipped `catalog_skipped` (finish, below), so the reconciliation balances.
 */
export function catalogSkippedStage(stage: SlimsStage): SlimsStage {
  return Object.freeze({
    name: stage.name,
    reads: stage.reads,
    async run(c: SlimsStageContext): Promise<{ done: boolean; cursor: string | null }> {
      c.report({
        table: '',
        legacyKey: null,
        code: 'catalog_skipped',
        detail: `Tahap katalog ${stage.name} dilewati: uji kering sinkron tidak menemukan perubahan / The catalogue stage ${stage.name} was skipped: the sync dry run found no change`,
      });
      return { done: true, cursor: null };
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// One slice

/**
 * Runs one slice of the migration run `payload.runId` with the run's stage list `stages` (see the top of this file).
 *
 * @throws what the queue should retry (the database, the source's connection), and DomainError `JOB_LEASE_LOST`
 */
export async function runSlimsMigrationSlice(
  ctx: JobContext,
  payload: MigrateSlimsPayload,
  deps: CatalogJobDeps,
  stages: readonly SlimsStage[],
  run: RunRow,
  settings: SlimsRunSettings,
): Promise<JobOutcome<MigrateSlimsPayload>> {
  const runId = run.id;
  const dryRun = Number(run.dry_run) === 1;
  const dataDir = deps.dataDir;
  const state = stateOf(summaryObject(run), payload);
  const lines: string[] = [];
  let buffered = 0;
  let writing = false;
  let finished = false;
  let finishedStatus: RunEnd | null = null;

  const counters = createCounters(summaryObject(run), {
    onSample: (column, fix, before, after) =>
      addRow({ table: column.split('.')[0] ?? '', legacyKey: null, code: 'sample', detail: `${column} [${fix}]: ${before} => ${after}` }),
  });
  // The run's list is [split, analyze, ...the middle stages, report] (job.ts).
  const middle = new Set(stages.slice(2, -1));
  const reads = new Set(stages.flatMap((s) => (middle.has(s) ? [...s.reads] : [])));
  const { value: io } = await ctx.session<SlimsIo>(async () => ({ source: null, files: undefined, split: { reader: null } }), closeIo);

  function addRow(r: SlimsReportRow): void {
    if (typeof r !== 'object' || r === null || typeof r.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(r.code)) {
      throw new TypeError('a SLiMS report row needs a lower-case code');
    }
    if (r.code === 'missing_file') state.missingFiles += 1;
    if (r.code === 'barcode_nonstandard') state.nonstandardBarcodes += 1;
    const line = slimsReportLine(r);
    lines.push(line);
    buffered += line.length;
  }

  /** Appends the buffered report rows to the work file; rows an append could not write stay buffered. */
  async function flush(): Promise<void> {
    if (lines.length === 0) return;
    state.resume.reportBytes = await appendSlimsReport(dataDir, runId, lines);
    lines.length = 0;
    buffered = 0;
  }

  function warn(code: string): void {
    if (!state.warnings.includes(code) && state.warnings.length < 50) state.warnings.push(cutText(code, 120));
  }

  function summaryOf(withReconciliation: boolean): Record<string, unknown> {
    const counts = counters.toJSON();
    // A sync dry run that ran the catalogue stages counts what a real sync would write (startSlimsMigration's precheck
    // of a run that skips them); its per-table counts are kept for the next slice.
    const catalogDry = dryRun && settings.catalogMode === 'sync' && settings.skipCatalog !== true;
    const doc = {
      version: state.version,
      stage: state.stage,
      tables: counts.tables,
      unread: counts.unread,
      reconciliation: withReconciliation ? reconcile(counts) : null,
      fixes: counts.fixes,
      samples: counts.samples,
      charset: state.charset.map((c) => ({ ...c, samples: [...c.samples] })),
      targets: state.targets,
      checks: state.checks,
      missingFiles: state.missingFiles,
      nonstandardBarcodes: state.nonstandardBarcodes,
      warnings: [...state.warnings],
      indexBuilding: state.indexBuilding,
      resume: state.resume,
      checkSource: { ...state.checkSource },
      vanished: counts.vanished,
      ...(catalogDry ? { changes: counts.changes, catalogChanges: Object.values(counts.changes).reduce((a, b) => a + b, 0) } : {}),
    };
    return bounded(doc);
  }

  async function source(): Promise<SlimsSource> {
    if (io.source !== null) return io.source;
    if (settings.sourceKind === 'db') {
      if (settings.db === null) throw new TypeError('a database migration run without its database');
      const secret = await ctx.secretParam();
      if (secret === null) throw new SlimsRunFailure('password_missing', 'Kata sandi basis data SLiMS tidak tersedia / The SLiMS database password is not available');
      const password = new TextDecoder().decode(secret);
      secret.fill(0);
      io.source = await slimsSources().openDbSource({ ...settings.db, password }, { connectTimeoutMs: 10_000 });
    } else {
      const raw = await readBytes(runWorkPath(dataDir, runId, 'tables.json'), TABLES_FILE_MAX_BYTES);
      if (raw === null) throw new SlimsRunFailure('work_missing', 'Daftar tabel dump tidak ditemukan / The dump\'s table list is gone');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new SlimsRunFailure('work_corrupt', 'Daftar tabel dump rusak / The dump\'s table list is damaged');
      }
      const tables = stagedTables.safeParse(parsed);
      if (!tables.success) throw new SlimsRunFailure('work_corrupt', 'Daftar tabel dump rusak / The dump\'s table list is damaged');
      io.source = slimsSources().openStagedDumpSource(runWorkDir(dataDir, runId), tables.data as SlimsTableInfo[]);
    }
    return io.source;
  }

  async function files(): Promise<SlimsFilesSource | null> {
    if (io.files !== undefined) return io.files;
    if (settings.files === 'zip') {
      const zip = runWorkPath(dataDir, runId, 'files.bin');
      if ((await statOrNull(zip))?.kind !== 'file') throw new SlimsRunFailure('work_missing', 'Arsip berkas SLiMS tidak ditemukan / The SLiMS files archive is gone');
      io.files = await slimsSources().openFilesZip(zip);
    } else if (settings.files === 'dir') {
      if (settings.filesDir === null) throw new TypeError('a files-dir migration run without its folder');
      io.files = await slimsSources().openFilesDir(settings.filesDir);
    } else {
      io.files = null;
    }
    return io.files;
  }

  /** Removes the run's work files but the report work file, best effort: an ending nothing adopts frees the disk first. */
  async function freeStaging(): Promise<void> {
    const dir = runWorkDir(dataDir, runId);
    try {
      await closeIo(io); // the files archive may be open
      for (const name of await listNames(dir)) {
        if (name === 'report.csv') continue;
        let file: DataPath;
        try {
          file = runWorkFileIn(dir, name);
        } catch {
          continue; // no work file's name (a temporary sibling): left to the folder's removal
        }
        await removeFile(file);
      }
    } catch (error) {
      deps.log.warn('SLiMS migration: the staging of an ending run could not be removed', { runId, ...errorFields(error) });
    }
  }

  /** After the end: a succeeded dry run keeps its folder for its real run (S3), less the dump; any other's goes. */
  async function releaseWork(status: RunEnd): Promise<void> {
    try {
      await closeIo(io);
      if (dryRun && status === 'succeeded') {
        if (settings.sourceKind === 'dump') await removeFile(runWorkPath(dataDir, runId, 'dump.bin'));
      } else {
        await removeTree(runWorkDir(dataDir, runId));
      }
    } catch (error) {
      deps.log.warn('SLiMS migration: the work folder of an ended run could not be removed', { runId, ...errorFields(error) });
    }
  }

  /**
   * A run that skipped the catalogue stages: every row of their tables that no stage accounted for is skipped
   * `catalog_skipped` (computed from the counters, so a finish done again adds nothing).
   */
  function countSkippedCatalogue(): void {
    if (settings.skipCatalog !== true) return;
    const counts = counters.toJSON();
    const tables = new Set(stages.filter((s) => SLIMS_CATALOG_STAGES.includes(s.name)).flatMap((s) => [...s.reads]));
    for (const table of [...tables].sort()) {
      if (!Object.hasOwn(counts.tables, table) || counts.unread.includes(table)) continue;
      const t = counts.tables[table]!;
      const skipped = Object.values(t.skipped).reduce((a, b) => a + b, 0);
      const left = t.source - (t.migrated + t.merged + skipped + t.archived - (counts.vanished[table] ?? 0));
      if (left > 0) counters.skipped(table, 'catalog_skipped', left);
    }
  }

  async function finish(status: RunEnd): Promise<void> {
    if (finished) return;
    if (status === 'succeeded') countSkippedCatalogue();
    if (status !== 'succeeded') await freeStaging();
    const now = ctx.now();
    const counts = await slimsTargetCounts(ctx.db);
    state.targets = SLIMS_TARGET_TABLES.map((table) => ({
      table,
      before: state.targets.find((t) => t.table === table)?.before ?? counts[table],
      after: counts[table],
    }));
    if (status === 'succeeded' && !reconcile(counters.toJSON()).ok) warn('reconciliation_diff');
    try {
      await flush();
    } catch (error) {
      // A run that fails or is cancelled ends without its rows in the work file (they still reach the report below).
      if (status === 'succeeded') throw error;
      deps.log.warn('SLiMS migration: the report rows of an ending run could not be written', { runId, ...errorFields(error) });
    }
    const doc = summaryOf(true) as unknown as MigrationSummary;
    let reportFileId: string | null =
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
      const head = slimsSummaryRows({ summary: doc, settings, dryRun, status, baseUrl: deps.baseUrl, checkSource: state.checkSource });
      async function* rows(): AsyncGenerator<readonly string[]> {
        yield* head;
        yield* slimsReportRows(dataDir, runId);
        for (const line of lines) yield JSON.parse(line) as string[]; // rows the work file could not take
      }
      try {
        reportFileId = await writeRunReport(ctx.handle, deps.storage, runId, SLIMS_REPORT_HEADER, rows(), { now, createdBy: run.created_by });
      } catch (error) {
        // A run that fails or is cancelled ends without its report rather than not at all.
        if (status === 'succeeded') throw error;
        deps.log.warn('SLiMS migration: the report of an ending run could not be written', { runId, ...errorFields(error) });
      }
    }
    const tables = Object.values(doc.tables);
    const total = (pick: (t: (typeof tables)[number]) => number): number => tables.reduce((sum, t) => sum + pick(t), 0);
    const meta = {
      status,
      dryRun,
      ok: doc.reconciliation?.ok ?? false,
      tables: tables.length,
      source: total((t) => t.source),
      migrated: total((t) => t.migrated),
      merged: total((t) => t.merged),
      skipped: total((t) => Object.values(t.skipped).reduce((a, b) => a + b, 0)),
      archived: total((t) => t.archived),
      jobId: ctx.jobId,
    };
    await ctx.heartbeat();
    await withTx(ctx.handle, async (trx) => {
      const ended = await finishRun(trx, runId, { status, summary: doc as unknown as Record<string, unknown>, reportFileId }, now);
      if (!ended) return;
      if (!dryRun && state.indexBuilding) await releaseSlimsSearchIndex(trx, { jobId: ctx.jobId, now });
      await txCtx(trx, now, SYSTEM).audit({ action: 'catalog.migration.finish', entity: 'catalog_runs', entityId: runId, meta });
      if (!dryRun) await publish(trx, { channel: 'catalog', type: 'catalog.bulk.changed', payload: { runId } });
    });
    finished = true;
    finishedStatus = status;
    await releaseWork(status);
  }

  const pipeline: SlimsPipeline = {
    runId,
    jobId: ctx.jobId,
    run,
    settings,
    dryRun,
    deps,
    db: ctx.db,
    stages,
    state,
    splitKeep: io.split,
    readTables: () => reads,
    warn,
    async markIndexBuilding() {
      if (dryRun) return;
      state.indexBuilding = await withTx(ctx.handle, (trx) => takeSearchState(trx, ctx.jobId));
    },
    async saveStagedTables(tables) {
      await writeBytesAtomic(runWorkPath(dataDir, runId, 'tables.json'), JSON.stringify(tables));
    },
    finish,
  };

  const budgetLeft = (): number => Math.max(0, ctx.budgetLeftMs() - SAVE_MARGIN_MS);
  const progress = (): number => Math.min(99, Math.floor((100 * Math.min(state.resume.stage, stages.length)) / stages.length));
  const checkpoint = (): MigrateSlimsPayload => ({
    runId,
    stage: Math.min(state.resume.stage, 63),
    cursor: state.resume.cursor,
    ...(state.resume.split === undefined ? {} : { split: state.resume.split }),
  });

  async function contextFor(stage: SlimsStage): Promise<SlimsPipelineContext> {
    return {
      h: ctx.handle,
      source: stage.name === 'split' ? NO_SOURCE : await source(),
      files: middle.has(stage) ? await files() : null,
      runId,
      options: stageOptions(settings),
      dryRun,
      now: ctx.now(),
      clock: () => ctx.now(),
      storage: deps.storage,
      dataDir,
      counters,
      report: addRow,
      budgetLeftMs: budgetLeft,
      heartbeat: (value, message) => ctx.heartbeat({ progress: value, message }),
      pipeline,
    };
  }

  /** Puts the staged file `tmp/<id>/upload.bin` at `target` unless that is done (placeStaged). */
  async function moveStaged(id: string, target: DataPath): Promise<void> {
    if (!(await placeStaged(dataDir, id, target))) {
      throw new SlimsRunFailure('work_missing', 'Berkas unggahan migrasi tidak ditemukan / The migration\'s uploaded file is gone');
    }
  }

  /** Step 3 of the top of this file. */
  async function prepareWork(): Promise<void> {
    const workDir = runWorkDir(dataDir, runId);
    if (settings.adoptedFrom !== null && (await statOrNull(workDir)) === null) {
      try {
        await adoptRunWork(dataDir, settings.adoptedFrom, runId);
      } catch (error) {
        // The start route's own rename (after its COMMIT) may have won the race: the folder is there then.
        if ((await statOrNull(workDir))?.kind !== 'dir') {
          if (isDomainError(error) && error.code === 'NOT_FOUND') {
            throw new SlimsRunFailure('work_missing', 'Folder kerja uji kering tidak ditemukan / The dry run\'s work folder is gone');
          }
          throw error;
        }
      }
    }
    const dump = runWorkPath(dataDir, runId, 'dump.bin');
    if (settings.dumpStagingId !== null) {
      if (state.resume.stage === 0) await moveStaged(settings.dumpStagingId, dump);
      else await removeTree(dataPath(dataDir, 'tmp', settings.dumpStagingId));
    }
    if (settings.filesStagingId !== null) await moveStaged(settings.filesStagingId, runWorkPath(dataDir, runId, 'files.bin'));
    // The split is done: the dump itself is not needed any more (its staging is).
    if (settings.sourceKind === 'dump' && state.resume.stage > 0) await removeFile(dump);
    if (!(await truncateSlimsReport(dataDir, runId, state.resume.reportBytes))) {
      throw new SlimsRunFailure('work_missing', 'Berkas kerja laporan tidak lengkap / The report work file is incomplete');
    }
  }

  async function save(): Promise<void> {
    await flush();
    await ctx.heartbeat();
    const summary = summaryOf(false);
    await withTx(ctx.handle, async (trx) => {
      await saveRunSummary(trx, runId, summary);
      if (writing) await publish(trx, { channel: 'catalog', type: 'catalog.bulk.changed', payload: { runId } });
    });
  }

  async function fail(code: string, detail: string): Promise<JobOutcome<MigrateSlimsPayload>> {
    addRow({ table: '', legacyKey: null, code, detail });
    warn(code);
    await finish('failed');
    return { done: true, message: `failed: ${code}` };
  }

  /** A cancel request ends the run `cancelled` (its report, its finish); the queue then ends the job `cancelled`. */
  async function cancelRun(): Promise<JobOutcome<MigrateSlimsPayload>> {
    addRow({ table: '', legacyKey: null, code: 'cancelled', detail: 'Migrasi dibatalkan / The migration was cancelled' });
    await finish('cancelled');
    return { continueWith: checkpoint(), progress: progress(), message: 'cancelled' };
  }

  async function slices(): Promise<JobOutcome<MigrateSlimsPayload>> {
    if (run.status === 'queued') await withTx(ctx.handle, (trx) => startRun(trx, runId, ctx.now()));
    await prepareWork();
    let calls = 0;
    while (state.resume.stage < stages.length) {
      if (calls > 0 && budgetLeft() <= 0) break;
      if (ctx.cancelled()) return cancelRun();
      const stage = stages[state.resume.stage]!;
      state.stage = stage.name;
      await ctx.heartbeat({ progress: progress(), message: stage.name });
      const result = await stage.run(await contextFor(stage), state.resume.cursor);
      calls += 1;
      if (middle.has(stage) && !dryRun) writing = true;
      if (finished) return { done: true, message: finishedStatus ?? 'succeeded' };
      if (typeof result !== 'object' || result === null || typeof result.done !== 'boolean') {
        throw new TypeError(`SLiMS stage ${stage.name} returned no {done, cursor}`);
      }
      const cursor = result.cursor ?? null;
      if (cursor !== null && (typeof cursor !== 'string' || cursor === '' || cursor.length > SLIMS_CURSOR_MAX)) {
        throw new TypeError(`SLiMS stage ${stage.name} returned a cursor that is not 1-${SLIMS_CURSOR_MAX} characters`);
      }
      if (result.done) {
        state.resume.stage += 1;
        state.resume.cursor = null;
      } else {
        state.resume.cursor = cursor;
      }
      if (buffered > BUFFER_MAX_BYTES) await flush();
    }
    if (state.resume.stage >= stages.length) {
      // The report stage ends the run; a stage list without one ends it here.
      await finish('succeeded');
      return { done: true, message: finishedStatus ?? 'succeeded' };
    }
    // C17: a cancel the slice's heartbeats saw while a stage spent its budget ends the run here, not only its job.
    if (ctx.cancelled()) return cancelRun();
    await save();
    return { continueWith: checkpoint(), progress: progress(), message: state.stage ?? undefined };
  }

  const last = await ctx.db.selectFrom('jobs').select(['attempts', 'max_attempts']).where('id', '=', ctx.jobId).executeTakeFirst();
  const lastAttempt = last !== undefined && Number(last.attempts) + 1 >= Number(last.max_attempts);
  try {
    return await slices();
  } catch (error) {
    if (isDomainError(error) && error.code === 'JOB_LEASE_LOST') throw error;
    if (finished) throw error;
    const failure = failureOf(error);
    if (failure === 'retry') {
      deps.log.warn('SLiMS migration: a slice failed, the queue retries it', { runId, lastAttempt, ...errorFields(error) });
      if (lastAttempt) {
        try {
          await fail('error', isDomainError(error) ? error.code : error instanceof Error ? error.name : 'error');
        } catch (second) {
          if (isDomainError(second) && second.code === 'JOB_LEASE_LOST') throw second;
        }
      }
      throw error;
    }
    deps.log.warn('SLiMS migration: the run failed', { runId, code: failure.code, ...errorFields(error) });
    try {
      return await fail(failure.code, failure.detail);
    } catch (second) {
      if (isDomainError(second) && second.code === 'JOB_LEASE_LOST') throw second;
      throw error;
    }
  }
}
