import { withTx } from '@altis/db';
import { dataPath, openRead, readBytes, removeFile, removeTree, renameRetry, runWorkDir, runWorkPath, statOrNull, writeBytesInFolder, type DataPath } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { finishRun, getRun, startRun, writeRunReport, type RunEnd, type RunRow } from '../../catalog/data/runs.js';
import { errorFields, txCtx, type Actor } from '../../context.js';
import type { JobContext, JobHandler, JobOutcome } from '../../jobs/types.js';
import type { SplitDumpReader } from '../../migration/slims/source/dump-split.js';
import { DumpParseError } from '../../migration/slims/source/sql-dump.js';
import type { SlimsRow, SlimsSource, SlimsTableInfo, SplitCheckpoint } from '../../migration/slims/source/types.js';
import { openStagedUsageSource, openUsageDbSource, splitUsageDump } from '../../migration/slims/source/usage.js';
import type { ReportJobDeps } from '../../reports/export/job.js';
import { loadAccredSettings } from '../../settings/accreditation.js';
import { resolveWindow, type DateSpan } from '../windows.js';
import {
  aggregateMonth,
  countItem,
  countLoan,
  countMember,
  countMemberType,
  countRead,
  countTitle,
  countVisit,
  emptyCounts,
  nextMonth,
  spanCells,
  type MemberInfo,
  type RowContext,
  type UsageCells,
  type UsageTable,
} from './count.js';
import { USAGE_REPORT_HEADER, usageReportRows, usageSummary, type UsageEnding } from './report.js';
import { slimsUsageRunSettings, type SlimsUsageRunSettings } from './settings.js';
import { slimsUsageConnect } from './source.js';
import { USAGE_PHASES, UsageRunFailure, UsageWork, initialState, type UsagePhase } from './work.js';
import { writeUsageImport } from './write.js';

// `accreditation.import_slims_usage`: one SLiMS usage import (spec §11.2, §10.7), slice by slice. SLiMS 9 table/column
// names (interoperability facts, no SLiMS code). Its phases, each one sliced (count.ts holds the counting rules, work.ts
// the work files and how a slice resumes):
//
//   split      a dump only: the dump (`tmp/<runId>/dump.bin`) into per-table staging, only the usage columns, every
//              member id hashed as it is split; once every table is staged and that is saved, the dump and whatever is
//              left of its upload are deleted: from here on no raw member id is on disk
//   members    member types, then members: hash → type and membership end
//   loans      titles and copies (their classes), then `loan`, then `loan_history`
//   visits     `visitor_count`: a guest counts at once, a member's check-in goes to its month's file
//   reads      `read_counter` (when the source has it): uses in the library
//   aggregate  month by month in calendar order: visits raw and without repeats, distinct visitors and borrowers
//   write      one transaction: the import replaces its own rows (write.ts); from here on it is not cancelled
//   report     the run report, the run's end (counts only), `accreditation.slims_usage.finish` by the system actor
//
// The source is read without any transaction open. The payload is a small checkpoint (the phase, the source's cursor,
// where the source is, how many slices saved their state); the work files carry the rest, and the state the last slice
// saved is what the next one resumes from.
//
// A cancel request before `write`, and a failure before `write` ends, end the run at once without touching the usage
// tables: the dump, the staging and the work files are deleted first, then the run's report and end are written. A
// failure the queue may retry (the database, the SLiMS server out of reach) is thrown for its retry, except on the
// job's last attempt, where the run is ended `failed` first. Every end removes the work folder.

const SYSTEM: Actor = { type: 'system', id: null, ip: null };
/** A slice keeps this much of its budget for saving its work. */
const SAVE_MARGIN_MS = 2_000;
/** Rows read from the source at once. */
const BATCH = 500;
/** The split's checkpoint stays within this (the payload is at most 65 535 bytes). */
const SPLIT_CHECKPOINT_MAX_BYTES = 16_384;
/** The staged table list is read back whole, up to this size. */
const TABLES_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** The connect timeout of a database source (10 s). */
const CONNECT_TIMEOUT_MS = 10_000;
/** The longest source cursor the payload mirrors. */
const CURSOR_MAX = 32_000;
/** The tables a source must have one of to be read as SLiMS usage. */
const USAGE_EVIDENCE: readonly string[] = ['loan', 'loan_history', 'visitor_count'];

/** The tables each reading phase reads, in order. */
const PHASE_TABLES: Readonly<Partial<Record<UsagePhase, readonly UsageTable[]>>> = Object.freeze({
  members: ['mst_member_type', 'member'],
  loans: ['biblio', 'item', 'loan', 'loan_history'],
  visits: ['visitor_count'],
  reads: ['read_counter'],
});

/** The import's payload: its run and, between slices, the phase, the source's cursor and its state. */
export const importSlimsUsagePayload = z.strictObject({
  runId: ulidField,
  phase: z.string().min(1).max(32).optional(),
  cursor: z.string().max(32_000).nullable().optional(),
  state: z.unknown().optional(),
});

export type ImportSlimsUsagePayload = z.infer<typeof importSlimsUsagePayload>;

const sourceRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('db'),
    host: z.string().min(1).max(191),
    port: z.int().min(1).max(65_535),
    user: z.string().min(1).max(64),
    database: z.string().min(1).max(64),
    tls: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('dump'), uploadId: ulidField }),
]);
/** The payload's `state`: where the source is, and how many slices saved their state. */
const payloadStateSchema = z.strictObject({ source: sourceRefSchema, seq: z.int().min(0) });
const secretSchema = z.strictObject({ hashKey: z.string().min(1).max(64), password: z.string().max(256).optional() });
const stagedTablesSchema = z
  .array(
    z.looseObject({
      name: z.string().min(1).max(64),
      columns: z.array(z.string().min(1).max(64)).max(4096),
      primaryKey: z.array(z.string().min(1).max(64)).max(64),
      rows: z.int().min(0).nullable(),
    }),
  )
  .max(64);

type SourceRef = z.infer<typeof sourceRefSchema>;

/** What one process keeps for the import across its slices: the open source, the dump's reader between split slices. */
interface UsageIo {
  source: SlimsSource | null;
  split: { reader: SplitDumpReader | null };
}

async function closeIo(io: UsageIo): Promise<void> {
  const source = io.source;
  const reader = io.split.reader;
  io.source = null;
  io.split.reader = null;
  try {
    await source?.close();
  } finally {
    await reader?.close();
  }
}

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

/** Whether `error` ends the run at once (with a code for its report), or is left to the queue's retry. */
function failureOf(error: unknown): string | 'retry' {
  if (error instanceof UsageRunFailure) return error.code;
  if (error instanceof DumpParseError) return 'dump_invalid';
  if (isDomainError(error)) {
    switch (error.code) {
      case 'DISK_QUOTA':
        return 'disk_full';
      case 'DB_UNAVAILABLE':
      case 'TX_CONFLICT':
      case 'MIGRATION_SOURCE_UNREACHABLE':
        return 'retry';
      default:
        return 'error';
    }
  }
  if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return 'error';
  return 'retry';
}

/**
 * The `accreditation.import_slims_usage` handler: interactive (the wizard drives it), long and CPU-heavy, retried only
 * by its own process (its source may be a database that only this process reaches).
 */
export function importSlimsUsageJob(deps: () => ReportJobDeps): JobHandler<ImportSlimsUsagePayload> {
  return {
    type: 'accreditation.import_slims_usage',
    permission: 'accreditation.workspace.manage',
    retryable: 'origin-only',
    interactive: true,
    longRunning: true,
    cpuHeavy: true,
    payload: importSlimsUsagePayload,
    async run(ctx, payload) {
      const d = deps();
      const run = await getRun(ctx.db, payload.runId);
      if (run === null || run.kind !== 'slims_usage') {
        d.log.warn('SLiMS usage import: the job names no usage import run', { jobId: ctx.jobId, runId: payload.runId });
        return { done: true, message: 'run missing' };
      }
      if (run.status !== 'queued' && run.status !== 'running') {
        // A slice retried after the run ended: nothing is left to do but making sure its work (and its upload) is gone.
        await removeTree(runWorkDir(d.dataDir, run.id)).catch(() => undefined);
        const ref = payloadStateSchema.safeParse(payload.state);
        if (ref.success && ref.data.source.kind === 'dump') await removeTree(dataPath(d.dataDir, 'tmp', ref.data.source.uploadId)).catch(() => undefined);
        return { done: true, message: run.status };
      }
      return runUsageSlice(ctx, payload, d, run);
    },
  };
}

/**
 * One slice of the usage import of `run` (see the top of this file).
 *
 * @throws what the queue should retry, and DomainError `JOB_LEASE_LOST`
 */
async function runUsageSlice(ctx: JobContext, payload: ImportSlimsUsagePayload, d: ReportJobDeps, run: RunRow): Promise<JobOutcome<ImportSlimsUsagePayload>> {
  const runId = run.id;
  const dataDir = d.dataDir;
  const { value: io } = await ctx.session<UsageIo>(async () => ({ source: null, split: { reader: null } }), closeIo);
  const ref = payloadStateSchema.safeParse(payload.state);
  const source: SourceRef | null = ref.success ? ref.data.source : null;
  let settings: SlimsUsageRunSettings | null = null;
  let work: UsageWork | null = null;
  let finished = false;

  const budgetLeft = (): number => Math.max(0, ctx.budgetLeftMs() - SAVE_MARGIN_MS);
  const given = (USAGE_PHASES as readonly string[]).includes(payload.phase ?? '') ? (payload.phase as UsagePhase) : null;
  const phaseOf = (): UsagePhase => work?.state.phase ?? given ?? (source?.kind === 'db' ? 'members' : 'split');
  const progress = (): number => Math.min(99, Math.floor((100 * USAGE_PHASES.indexOf(phaseOf())) / USAGE_PHASES.length));
  const checkpoint = (): ImportSlimsUsagePayload => {
    const cursor = work?.state.cursor ?? null;
    return {
      runId,
      phase: phaseOf(),
      cursor: cursor !== null && cursor.length <= CURSOR_MAX ? cursor : null,
      ...(source === null ? {} : { state: { source, seq: work?.state.seq ?? 0 } }),
    };
  };

  /** The dump and what is left of its upload (a dump source). */
  async function removeDumpInput(): Promise<void> {
    if (source?.kind !== 'dump') return;
    await removeFile(runWorkPath(dataDir, runId, 'dump.bin'));
    await removeTree(dataPath(dataDir, 'tmp', source.uploadId));
  }

  /** Everything of the run on disk: its work folder, its dump, its upload's leftovers. Best effort. */
  async function removeWork(): Promise<void> {
    try {
      await closeIo(io);
      await removeDumpInput();
      await removeTree(runWorkDir(dataDir, runId));
    } catch (error) {
      d.log.warn('SLiMS usage import: the work folder of an ending run could not be removed', { runId, ...errorFields(error) });
    }
  }

  async function finish(status: RunEnd, failure: string | null = null): Promise<void> {
    if (finished) return;
    // An ending that stores nothing frees the disk first: the dump, the staging and every work file.
    if (status !== 'succeeded') await removeWork();
    const now = ctx.now();
    const state = work?.state ?? null;
    const ending: UsageEnding = {
      status,
      sourceKind: settings?.sourceKind ?? source?.kind ?? 'dump',
      cutoverOn: settings?.cutoverOn ?? null,
      dedupeMinutes: settings?.dedupeMinutes ?? 0,
      phase: phaseOf(),
      failure,
      counts: state?.counts ?? emptyCounts(),
      written: state?.written ?? null,
    };
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
      try {
        reportFileId = await writeRunReport(ctx.handle, d.storage, runId, USAGE_REPORT_HEADER, usageReportRows(ending), { now, createdBy: run.created_by });
      } catch (error) {
        // The run ends without its report rather than not at all.
        d.log.warn('SLiMS usage import: the report could not be written', { runId, ...errorFields(error) });
      }
    }
    const written = ending.written ?? { months: 0, rows: 0 };
    await ctx.heartbeat();
    await withTx(ctx.handle, async (trx) => {
      const ended = await finishRun(trx, runId, { status, summary: usageSummary(ending), reportFileId }, now);
      if (!ended) return;
      await txCtx(trx, now, SYSTEM).audit({
        action: 'accreditation.slims_usage.finish',
        entity: 'catalog_runs',
        entityId: runId,
        meta: { status, months: written.months, rows: written.rows },
      });
    });
    finished = true;
    await removeWork();
  }

  async function fail(code: string): Promise<JobOutcome<ImportSlimsUsagePayload>> {
    await finish('failed', code);
    return { done: true, message: `failed: ${code}` };
  }

  /** A cancel request ends the run `cancelled`; the queue then ends the job `cancelled`. */
  async function cancelRun(): Promise<JobOutcome<ImportSlimsUsagePayload>> {
    await finish('cancelled');
    return { continueWith: checkpoint(), progress: progress(), message: 'cancelled' };
  }

  /** The job's secret: the hash key and the database password. */
  async function secret(): Promise<{ hashKey: Uint8Array; password: string | null }> {
    const raw = await ctx.secretParam();
    if (raw === null) throw new UsageRunFailure('secret_missing');
    let parsed: z.infer<typeof secretSchema>;
    try {
      parsed = secretSchema.parse(JSON.parse(new TextDecoder().decode(raw)));
    } catch {
      throw new UsageRunFailure('secret_invalid');
    } finally {
      raw.fill(0);
    }
    const hashKey = new Uint8Array(Buffer.from(parsed.hashKey, 'base64'));
    if (hashKey.byteLength < 16) throw new UsageRunFailure('secret_invalid');
    return { hashKey, password: parsed.password ?? null };
  }

  /** The source of the reading phases: the database, or the staged dump. */
  async function openSource(src: SourceRef): Promise<SlimsSource> {
    if (io.source !== null) return io.source;
    if (src.kind === 'db') {
      const s = await secret();
      try {
        io.source = await openUsageDbSource(
          { host: src.host, port: src.port, user: src.user, password: s.password ?? '', database: src.database, tls: src.tls },
          { hashKey: s.hashKey, connectTimeoutMs: CONNECT_TIMEOUT_MS, connect: slimsUsageConnect() },
        );
      } finally {
        s.hashKey.fill(0);
      }
    } else {
      const raw = await readBytes(runWorkPath(dataDir, runId, 'usage-tables.json'), TABLES_FILE_MAX_BYTES);
      if (raw === null) throw new UsageRunFailure('work_missing');
      let tables: SlimsTableInfo[];
      try {
        tables = stagedTablesSchema.parse(JSON.parse(raw.toString('utf8'))) as SlimsTableInfo[];
      } catch {
        throw new UsageRunFailure('work_corrupt');
      }
      io.source = openStagedUsageSource(runWorkDir(dataDir, runId), tables);
    }
    return io.source;
  }

  /** Puts the dump's upload in place as `dump.bin` unless it is there (the start route's hook may have done it). */
  async function placeDump(uploadId: string): Promise<void> {
    const target = runWorkPath(dataDir, runId, 'dump.bin');
    const from = dataPath(dataDir, 'tmp', uploadId, 'upload.bin');
    const placed = async (): Promise<boolean> => (await statOrNull(target))?.kind === 'file';
    if (!(await placed())) {
      if ((await statOrNull(from))?.kind !== 'file') throw new UsageRunFailure('work_missing');
      try {
        await renameRetry(from, target);
      } catch (error) {
        if (!(await placed())) throw error;
      }
    }
    await removeTree(dataPath(dataDir, 'tmp', uploadId));
  }

  // ---- the phases ----

  function advance(w: UsageWork): void {
    w.state.phase = USAGE_PHASES[USAGE_PHASES.indexOf(w.state.phase) + 1]!;
    w.state.step = 0;
    w.state.cursor = null;
  }

  async function split(w: UsageWork): Promise<void> {
    const dump = runWorkPath(dataDir, runId, 'dump.bin');
    if ((await statOrNull(dump))?.kind !== 'file') throw new UsageRunFailure('work_missing');
    const s = await secret();
    let r: { done: boolean; checkpoint: SplitCheckpoint; tables: SlimsTableInfo[] };
    try {
      r = await splitUsageDump({
        dumpPath: dump,
        gz: await isGzip(dump),
        stagingDir: runWorkDir(dataDir, runId),
        checkpoint: w.state.split,
        budgetMs: Math.max(1, budgetLeft()),
        keep: io.split,
        heartbeat: () => ctx.heartbeat({ progress: progress(), message: 'split' }),
        hashKey: s.hashKey,
      });
    } finally {
      s.hashKey.fill(0);
    }
    if (!r.done) {
      if (Buffer.byteLength(JSON.stringify(r.checkpoint), 'utf8') > SPLIT_CHECKPOINT_MAX_BYTES) throw new UsageRunFailure('source_too_wide');
      w.state.split = r.checkpoint;
      return;
    }
    if (!(await writeBytesInFolder(runWorkPath(dataDir, runId, 'usage-tables.json'), JSON.stringify(r.tables)))) throw new UsageRunFailure('work_missing');
    w.state.split = null;
    advance(w);
    // Every table is staged and checkpointed: that is saved first, then the dump goes. Past this point nothing is split
    // again, and no raw member id is left on disk.
    await w.save();
    await removeDumpInput();
  }

  function countRow(c: RowContext, table: UsageTable, row: SlimsRow): void {
    switch (table) {
      case 'mst_member_type':
        return countMemberType(c, row);
      case 'member':
        return countMember(c, row);
      case 'biblio':
        return countTitle(c, row);
      case 'item':
        return countItem(c, row);
      case 'loan':
      case 'loan_history':
        return countLoan(c, table, row);
      case 'visitor_count':
        return countVisit(c, row);
      case 'read_counter':
        return countRead(c, row);
    }
  }

  /** What the rules of the rows of `phase` read: only what that phase needs is loaded from the work files. */
  async function rowContext(w: UsageWork, phase: UsagePhase, cutoverOn: string | null): Promise<RowContext> {
    const catalog = phase === 'loans' || phase === 'reads';
    const members = phase === 'members' || phase === 'loans' ? await w.members() : new Map<string, MemberInfo>();
    const items = catalog ? await w.items() : new Map<string, string>();
    const titles = catalog ? await w.titles() : new Map<string, string>();
    const seenLoans = phase === 'loans' ? await w.loans() : new Set<string>();
    const spanItems = catalog ? await Promise.all([0, 1, 2].map((k) => w.set(`span${k}-items`))) : [];
    const spanTitles = catalog ? await Promise.all([0, 1, 2].map((k) => w.set(`span${k}-titles`))) : [];
    return {
      counts: w.state.counts,
      cutoverOn,
      spans: w.state.spans,
      members,
      items,
      titles,
      seenLoans,
      types: w.state.types,
      addMember(hash, info) {
        members.set(hash, info);
        w.appendLine('usage-members.bin', [hash, info.type, info.expire]);
      },
      addItem(code, titleId) {
        items.set(code, titleId);
        w.appendLine('usage-items.bin', [code, titleId]);
      },
      addTitle(titleId, key) {
        titles.set(titleId, key);
        w.appendLine('usage-titles.bin', [titleId, key]);
      },
      addLoanId(loanId) {
        seenLoans.add(loanId);
        w.appendLine('usage-loans.bin', loanId);
      },
      entry(kind, month, e) {
        w.appendEntry(kind, month, e);
      },
      used(span, itemCode, titleId) {
        if (itemCode !== null && !spanItems[span]!.has(itemCode)) {
          spanItems[span]!.add(itemCode);
          w.changed(`span${span}-items`);
        }
        if (titleId !== null && !spanTitles[span]!.has(titleId)) {
          spanTitles[span]!.add(titleId);
          w.changed(`span${span}-titles`);
        }
      },
    };
  }

  /** One page of the table a reading phase is at. */
  async function read(w: UsageWork, s: SlimsUsageRunSettings, src: SourceRef, tables: readonly UsageTable[]): Promise<void> {
    if (w.state.step >= tables.length) {
      advance(w);
      return;
    }
    const opened = await openSource(src);
    const present = new Set((await opened.tables()).map((t) => t.name));
    if (w.state.phase === 'members' && w.state.step === 0 && w.state.cursor === null && !USAGE_EVIDENCE.some((t) => present.has(t))) {
      throw new UsageRunFailure('source_unsupported');
    }
    const table = tables[w.state.step]!;
    if (!present.has(table)) {
      w.state.step += 1;
      w.state.cursor = null;
      return;
    }
    const page = await opened.rows(table, w.state.cursor, BATCH);
    const c = await rowContext(w, w.state.phase, s.cutoverOn);
    w.state.counts.rows[table] = (w.state.counts.rows[table] ?? 0) + page.rows.length;
    for (const row of page.rows) countRow(c, table, row);
    // What the page appended is written out once enough waits: a slice's memory stays the same however many rows it reads.
    await w.flushOver();
    if (page.next === null) {
      w.state.step += 1;
      w.state.cursor = null;
    } else {
      w.state.cursor = page.next;
    }
  }

  /** One month of the aggregate step. */
  async function aggregate(w: UsageWork, s: SlimsUsageRunSettings): Promise<void> {
    const months = w.state.months;
    if (w.state.step >= months.length) {
      advance(w);
      return;
    }
    const month = months[w.state.step]!;
    const spanVisitors = await Promise.all([0, 1, 2].map((k) => w.set(`span${k}-visitors`)));
    const spanBorrowers = await Promise.all([0, 1, 2].map((k) => w.set(`span${k}-borrowers`)));
    const carry = aggregateMonth(w.state.counts, {
      month,
      visits: await w.entries('visits', month),
      borrows: await w.entries('borrows', month),
      carryIn: await w.carryInto(month),
      dedupeMinutes: s.dedupeMinutes,
      members: await w.members(),
      spans: w.state.spans,
      spanVisitors,
      spanBorrowers,
    });
    for (const k of [0, 1, 2]) {
      w.changed(`span${k}-visitors`);
      w.changed(`span${k}-borrowers`);
    }
    await w.writeCarry(nextMonth(month), carry);
    w.state.step += 1;
  }

  /** The write step: past it, the import is no longer cancelled. */
  async function write(w: UsageWork, s: SlimsUsageRunSettings): Promise<void> {
    const members = await w.members();
    const cells: UsageCells[] = [];
    for (const k of [0, 1, 2]) {
      cells.push(
        spanCells({
          span: w.state.spans[k]!,
          members,
          borrowers: await w.set(`span${k}-borrowers`),
          visitors: await w.set(`span${k}-visitors`),
          items: (await w.set(`span${k}-items`)).size,
          titles: (await w.set(`span${k}-titles`)).size,
        }),
      );
    }
    const memberTypeIds = new Set<string>();
    for (const m of members.values()) if (m.type !== null) memberTypeIds.add(m.type);
    const accred = await loadAccredSettings(ctx.db);
    await ctx.markPointOfNoReturn();
    w.state.written = await writeUsageImport(ctx.handle, {
      runId,
      now: ctx.now(),
      createdBy: run.created_by,
      cutoverOn: s.cutoverOn,
      spans: w.state.spans,
      monthly: w.state.counts.monthly,
      spanCells: cells,
      types: w.state.types,
      memberTypeIds: [...memberTypeIds].sort(),
      ...(s.memberTypeGroups === undefined ? {} : { memberTypeGroups: s.memberTypeGroups }),
      ...(s.unknownMemberGroup === undefined ? {} : { unknownMemberGroup: s.unknownMemberGroup }),
      unknownMemberGroupDefault: accred.unknownMemberGroupDefault,
    });
    advance(w);
    await w.save();
  }

  /** Whether a cancel of the job was requested (always false from the write on: the import is then past cancelling). */
  async function cancelRequested(phase: UsagePhase): Promise<boolean> {
    if (USAGE_PHASES.indexOf(phase) >= USAGE_PHASES.indexOf('write')) return false;
    const row = await ctx.db.selectFrom('jobs').select('cancel_requested').where('id', '=', ctx.jobId).executeTakeFirst();
    return row !== undefined && Number(row.cancel_requested) === 1;
  }

  /** The import's spans: the period it was started from and the two before it, oldest first. */
  async function periodSpans(periodId: string): Promise<DateSpan[]> {
    const period = await ctx.db.selectFrom('accred_periods').select(['starts_on', 'ends_on']).where('id', '=', periodId).executeTakeFirst();
    if (period === undefined) throw new UsageRunFailure('period_missing');
    const spans = resolveWindow('three_periods', { startsOn: period.starts_on, endsOn: period.ends_on }, period.ends_on).slices;
    if (spans === null || spans.length !== 3) throw new TypeError('the three periods resolve to three spans');
    return spans.map((x) => ({ from: x.from, to: x.to }));
  }

  async function slices(): Promise<JobOutcome<ImportSlimsUsagePayload>> {
    if (source === null) throw new UsageRunFailure('payload_invalid');
    let options: unknown;
    try {
      options = JSON.parse(run.options);
    } catch {
      options = null;
    }
    const parsed = slimsUsageRunSettings.safeParse(options);
    if (!parsed.success) throw new UsageRunFailure('options_invalid');
    const s = parsed.data;
    settings = s;
    if (run.status === 'queued') await withTx(ctx.handle, (trx) => startRun(trx, runId, ctx.now()));
    const spans = await periodSpans(s.periodId);
    const w = await UsageWork.open(dataDir, runId, () => initialState(source.kind === 'dump' ? 'split' : 'members', spans));
    work = w;
    // No state while the payload says slices saved one: the work was lost.
    if (w.state.seq === 0 && ref.success && ref.data.seq > 0) throw new UsageRunFailure('work_missing');
    if (source.kind === 'dump') {
      if (w.state.phase === 'split') await placeDump(source.uploadId);
      else await removeDumpInput(); // past the split the dump never outlives it, a crash in between included
    }

    let steps = 0;
    for (;;) {
      if (steps > 0 && budgetLeft() <= 0) break;
      if (ctx.cancelled()) return cancelRun();
      const phase = w.state.phase;
      await ctx.heartbeat({ progress: progress(), message: phase });
      steps += 1;
      if (phase === 'report') {
        await finish('succeeded');
        return { done: true, message: 'succeeded' };
      }
      if (phase === 'split') await split(w);
      else if (phase === 'aggregate') await aggregate(w, s);
      else if (phase === 'write') await write(w, s);
      else await read(w, s, source, PHASE_TABLES[phase]!);
    }
    // A cancel requested during the slice ends the run here, not only its job (the queue would end the job alone): the
    // heartbeats may not have read it yet, so the job's row is asked once more before the slice hands its work back.
    if (ctx.cancelled() || (await cancelRequested(w.state.phase))) return cancelRun();
    await w.save();
    return { continueWith: checkpoint(), progress: progress(), message: w.state.phase };
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
      d.log.warn('SLiMS usage import: a slice failed, the queue retries it', { runId, lastAttempt, ...errorFields(error) });
      if (lastAttempt) {
        try {
          await fail('error');
        } catch (second) {
          if (isDomainError(second) && second.code === 'JOB_LEASE_LOST') throw second;
        }
      } else {
        await closeIo(io).catch(() => undefined);
      }
      throw error;
    }
    d.log.warn('SLiMS usage import: the run failed', { runId, code: failure, ...errorFields(error) });
    try {
      return await fail(failure);
    } catch (second) {
      if (isDomainError(second) && second.code === 'JOB_LEASE_LOST') throw second;
      throw error;
    }
  }
}
