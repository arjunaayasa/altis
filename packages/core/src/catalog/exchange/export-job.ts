import type { FileHandle } from 'node:fs/promises';
import { withTx, type DB } from '@altis/db';
import {
  dataPath,
  ensureDir,
  ensureHeadroom,
  exportFilePath,
  openAppend,
  readBytes,
  removeFile,
  removeTree,
  runWorkDir,
  runWorkPath,
  statOrNull,
  truncateFile,
  writeBytesAtomic,
  type DataPath,
} from '@altis/platform';
import { EXPORT_FORMATS, isDomainError, isUlid, type ExportFormat } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import { ExportBody } from '@altis/shared/api/catalog/exchange';
import type { RunStarted } from '@altis/shared/api/catalog/runs';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { errorFields, type TxCtx } from '../../context.js';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import { enqueue } from '../../jobs/enqueue.js';
import type { JobContext, JobHandler, JobOutcome, JobRegistry } from '../../jobs/types.js';
import { MarcTooLongError } from '../../marc/record.js';
import { searchCatalog } from '../../search/search.js';
import { readSettings } from '../../settings/service.js';
import { loadCustomDefs } from '../data/custom-fields.js';
import { RUN_REPORT_MAX_ROWS, attachRunJob, createRun, finishRun, getRun, saveRunSummary, startRun, writeRunReport, type RunEnd, type RunRow } from '../data/runs.js';
import type { CatalogJobDeps } from '../jobs-deps.js';
import { loadRecordData } from '../records/data.js';
import { appendReportLines, reportLine, reportRowsOf, truncateReportLines } from './report-file.js';
import { EXPORT_EXTENSIONS, csvItemRows, csvRecordBytes, exportHead, exportTail, marcRecordBytes, staffMarc } from './writers.js';

// The export job `catalog.export` and how an export starts (Phase 2 spec §5.4, §12.3; plan Task 31; P2-21, S5,
// Review Focus 5).
//
// Starting (`POST catalog/exports`, `mode: system`, in its transaction; startCatalogExport): the run (kind `export`,
// options = the body), the job, `catalog.export.start`.
//
// The records: `filter.recordIds` (in the order given), else the admin search of `filter.q` (at most 10 000, in its
// order, read once by the first slice into `tmp/<runId>/record_ids.ndjson`), else a keyset over `records.id`. The other
// filters keep a record when it is live (or archived, with `includeArchived`; never merged), of the material type,
// changed since `changedSince`, and holding an item of the branch / of the collection type (not archived unless
// `includeArchived`). `csv-items` writes the items those filters keep.
//
// A slice: `ensureHeadroom` first; the file `exports/<runId>.<ext>` is cut back to the checkpoint's length (a file
// shorter than that, or a lost report, starts the export over), then batches of 200 records are appended
// (writers.ts). A record that ISO 2709 cannot hold is skipped and reported (`marc_too_long`, P2-21), so the file
// always reads back cleanly. At the slice's end the file is flushed, then the report rows, then the checkpoint is
// returned: a slice that dies before is redone from the last checkpoint. At the end: the tail, the report, and
// finishRun with the file's name and size and `expires_at = now + 7 d` (Task 19 serves it until then). Cancel or a
// failure removes the partial file.

/** The export job's type. */
export const CATALOG_EXPORT_JOB = 'catalog.export';

/** Records per batch. */
const BATCH = 200;
/** The search of `filter.q` gives at most this many records (spec §5.4: 50 pages of 200). */
const SEARCH_EXPORT_MAX = 10_000;
const SEARCH_PAGE_SIZE = 200;
/** What `ensureHeadroom` proves before a slice writes. */
const HEADROOM_BYTES = 64 * 1024 * 1024;
/** A slice stops when less than this, or 1.5 × the last batch's time, is left of its budget. */
const SLICE_MARGIN_MS = 2_000;
const EXPIRES_MS = 7 * 86_400_000;
/** The report columns of an export. */
export const EXPORT_REPORT_HEADER: readonly string[] = Object.freeze(['record_id', 'level', 'code', 'title']);
const TITLE_MAX = 200;
const ID_BATCH = 500;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const exportCheckpoint = z.strictObject({
  /** `select`: the search of `filter.q` is still to be read; `write`: records are written. */
  phase: z.enum(['select', 'write']),
  /** The next index into the id list (`recordIds`, the search's ids). */
  index: count,
  /** The keyset's last id. */
  afterId: ulidField.nullable(),
  /** The file's length so far. */
  bytes: count,
  headDone: z.boolean(),
  /** The custom-field columns of a CSV export, fixed by its head. */
  customCodes: z.array(z.string().min(1).max(64)).max(1000),
  written: count,
  items: count,
  skipped: count,
  reportBytes: count,
  reportRows: count,
  reportDropped: count,
});

type ExportCheckpoint = z.infer<typeof exportCheckpoint>;

/** The payload (and checkpoint) of `catalog.export`. */
export const exportJobPayload = z.strictObject({ runId: ulidField, format: z.enum(EXPORT_FORMATS), checkpoint: exportCheckpoint });

export type ExportJobPayload = z.infer<typeof exportJobPayload>;

type ExportFilter = ExportBody['filter'];

function initialCheckpoint(filter: ExportFilter): ExportCheckpoint {
  return {
    phase: filter.recordIds === undefined && filter.q !== undefined && filter.q.trim() !== '' ? 'select' : 'write',
    index: 0,
    afterId: null,
    bytes: 0,
    headDone: false,
    customCodes: [],
    written: 0,
    items: 0,
    skipped: 0,
    reportBytes: 0,
    reportRows: 0,
    reportDropped: 0,
  };
}

/** Where the records come from (see the top of this file). */
function sourceOf(filter: ExportFilter): 'ids' | 'search' | 'keyset' {
  if (filter.recordIds !== undefined) return 'ids';
  return filter.q !== undefined && filter.q.trim() !== '' ? 'search' : 'keyset';
}

/** The ids of `ids` the filters keep, in the order of `ids`. */
async function keptIds(db: Kysely<DB>, ids: readonly string[], f: ExportFilter): Promise<string[]> {
  const kept = new Set<string>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    let q = db.selectFrom('records as r').select('r.id').where('r.id', 'in', unique.slice(i, i + ID_BATCH)).where('r.merged_into', 'is', null);
    if (f.includeArchived !== true) q = q.where('r.archived_at', 'is', null);
    if (f.materialTypeId !== undefined) q = q.where('r.material_type_id', '=', f.materialTypeId);
    if (f.changedSince !== undefined) q = q.where('r.changed_at', '>=', f.changedSince);
    if (f.branchId !== undefined || f.collectionTypeId !== undefined) {
      q = q.where((eb) => {
        let items = eb.selectFrom('items as i').select('i.id').whereRef('i.record_id', '=', 'r.id');
        if (f.branchId !== undefined) items = items.where('i.branch_id', '=', f.branchId);
        if (f.collectionTypeId !== undefined) items = items.where('i.collection_type_id', '=', f.collectionTypeId);
        if (f.includeArchived !== true) items = items.where('i.archived_at', 'is', null);
        return eb.exists(items);
      });
    }
    for (const r of await q.execute()) kept.add(r.id);
  }
  const seen = new Set<string>();
  return ids.filter((id) => kept.has(id) && !seen.has(id) && seen.add(id) !== undefined);
}

/** The next keyset page: the ids after `afterId` the filters keep, in id order. */
async function keysetIds(db: Kysely<DB>, afterId: string | null, f: ExportFilter): Promise<{ ids: string[]; scanned: string | null }> {
  let q = db.selectFrom('records as r').select('r.id').where('r.merged_into', 'is', null);
  if (afterId !== null) q = q.where('r.id', '>', afterId);
  if (f.includeArchived !== true) q = q.where('r.archived_at', 'is', null);
  if (f.materialTypeId !== undefined) q = q.where('r.material_type_id', '=', f.materialTypeId);
  if (f.changedSince !== undefined) q = q.where('r.changed_at', '>=', f.changedSince);
  if (f.branchId !== undefined || f.collectionTypeId !== undefined) {
    q = q.where((eb) => {
      let items = eb.selectFrom('items as i').select('i.id').whereRef('i.record_id', '=', 'r.id');
      if (f.branchId !== undefined) items = items.where('i.branch_id', '=', f.branchId);
      if (f.collectionTypeId !== undefined) items = items.where('i.collection_type_id', '=', f.collectionTypeId);
      if (f.includeArchived !== true) items = items.where('i.archived_at', 'is', null);
      return eb.exists(items);
    });
  }
  const rows = await q.orderBy('r.id').limit(BATCH).execute();
  const ids = rows.map((r) => r.id);
  return { ids, scanned: ids.at(-1) ?? afterId };
}

/** The ids of the admin search of `filter.q` (at most 10 000, in the search's order). */
async function searchIds(db: Kysely<DB>, f: ExportFilter, now: number): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; out.length < SEARCH_EXPORT_MAX; page += 1) {
    const result = await searchCatalog(
      db,
      {
        text: f.q ?? '',
        scope: 'admin',
        filters: {
          ...(f.materialTypeId === undefined ? {} : { materialTypeIds: [f.materialTypeId] }),
          ...(f.collectionTypeId === undefined ? {} : { collectionTypeIds: [f.collectionTypeId] }),
          ...(f.branchId === undefined ? {} : { branchIds: [f.branchId] }),
          includeArchived: f.includeArchived === true,
          includeHidden: true,
        },
        sort: 'relevance',
        page,
        pageSize: SEARCH_PAGE_SIZE,
      },
      { now },
    );
    out.push(...result.recordIds);
    if (result.recordIds.length < SEARCH_PAGE_SIZE || result.pageLimitReached) break;
  }
  return [...new Set(out)].slice(0, SEARCH_EXPORT_MAX);
}

/** The search's ids the first slice saved. */
async function savedSearchIds(dataDir: string, runId: string): Promise<string[] | null> {
  const raw = await readBytes(runWorkPath(dataDir, runId, 'record_ids.ndjson'), 1024 * 1024);
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw.toString('utf8'));
    return Array.isArray(v) && v.every((x) => typeof x === 'string' && isUlid(x)) ? (v as string[]) : null;
  } catch {
    return null;
  }
}

/** Why an export fails without a retry. */
class ExportRunFailure extends Error {
  constructor(readonly code: string) {
    super(`export failed: ${code}`);
    this.name = 'ExportRunFailure';
  }
}

/**
 * The `catalog.export` handler: permission `catalog.export.run`, `longRunning` (it holds `jobs:heavy`), `interactive`
 * (the Impor/Ekspor screen drives it where no worker runs), retryable through the API. See the top of this file.
 */
export function exportJob(deps: () => CatalogJobDeps): JobHandler<ExportJobPayload> {
  return {
    type: CATALOG_EXPORT_JOB,
    permission: 'catalog.export.run',
    retryable: 'api',
    interactive: true,
    longRunning: true,
    payload: exportJobPayload,
    async run(ctx, payload) {
      const d = deps();
      const run = await getRun(ctx.db, payload.runId);
      if (run === null || run.kind !== 'export') {
        d.log.warn('catalog export: the job names no export run', { jobId: ctx.jobId, runId: payload.runId });
        return { done: true, message: 'run missing' };
      }
      // A run that ended already (a retried slice, or the housekeeping ended it, Task 19): nothing left to do.
      if (run.status !== 'queued' && run.status !== 'running') return { done: true, message: run.status };
      return new ExportSlice(ctx, payload, d, run).run();
    },
  };
}

/** One slice of an export (see the top of this file). */
class ExportSlice {
  private readonly runId: string;
  private readonly format: ExportFormat;
  private readonly filter: ExportFilter;
  private cp: ExportCheckpoint;
  private readonly rows: string[] = [];
  private finished = false;

  constructor(
    private readonly ctx: JobContext,
    private readonly payload: ExportJobPayload,
    private readonly deps: CatalogJobDeps,
    private readonly row: RunRow,
  ) {
    this.runId = row.id;
    this.format = payload.format;
    this.filter = ExportBody.parse(JSON.parse(row.options)).filter;
    this.cp = { ...payload.checkpoint };
  }

  private file(): DataPath {
    return exportFilePath(this.deps.dataDir, this.runId, EXPORT_EXTENSIONS[this.format]);
  }

  async run(): Promise<JobOutcome<ExportJobPayload>> {
    const last = await this.ctx.db.selectFrom('jobs').select(['attempts', 'max_attempts']).where('id', '=', this.ctx.jobId).executeTakeFirst();
    const lastAttempt = last !== undefined && Number(last.attempts) + 1 >= Number(last.max_attempts);
    try {
      return await this.slice();
    } catch (error) {
      if (isDomainError(error) && error.code === 'JOB_LEASE_LOST') throw error;
      if (this.finished) throw error;
      if (error instanceof ExportRunFailure) {
        await this.finish('failed', error.code);
        return { done: true, message: `failed: ${error.code}` };
      }
      this.deps.log.warn('catalog export: a slice failed, the queue retries it', { runId: this.runId, lastAttempt, ...errorFields(error) });
      if (lastAttempt) {
        try {
          await this.finish('failed', isDomainError(error) ? error.code : 'error');
        } catch (second) {
          if (isDomainError(second) && second.code === 'JOB_LEASE_LOST') throw second;
        }
      }
      throw error;
    }
  }

  private async slice(): Promise<JobOutcome<ExportJobPayload>> {
    const { ctx, runId } = this;
    const dataDir = this.deps.dataDir;
    if (this.row.status === 'queued') await withTx(ctx.handle, (trx) => startRun(trx, runId, ctx.now()));
    await ensureDir(dataPath(dataDir, 'exports'));
    await ensureHeadroom(dataDir, HEADROOM_BYTES);
    await this.cutBack();
    if (this.cp.phase === 'select') {
      const ids = await searchIds(ctx.db, this.filter, ctx.now());
      await writeBytesAtomic(runWorkPath(dataDir, runId, 'record_ids.ndjson'), JSON.stringify(ids));
      this.cp = { ...this.cp, phase: 'write' };
    }
    const settings = await readSettings(ctx.db, ['catalog.marcOrgCode'], []);
    const marc = { orgCode: settings['catalog.marcOrgCode'] as string | null, baseUrl: this.deps.baseUrl, includeItems: this.filter.includeItems === true };
    const ids = sourceOf(this.filter) === 'search' ? await savedSearchIds(dataDir, runId) : null;
    if (sourceOf(this.filter) === 'search' && ids === null) throw new ExportRunFailure('work_missing');
    const list = sourceOf(this.filter) === 'ids' ? [...new Set(this.filter.recordIds)] : (ids ?? []);

    const handle = await openAppend(this.file());
    let lastBatchMs = 0;
    try {
      if (!this.cp.headDone) {
        const customCodes =
          this.format === 'csv-records' || this.format === 'csv-items'
            ? (await loadCustomDefs(ctx.db, this.format === 'csv-records' ? 'records' : 'items')).filter((d) => !d.archived).map((d) => d.code)
            : [];
        await this.write(handle, [exportHead(this.format, customCodes)]);
        this.cp = { ...this.cp, headDone: true, customCodes };
      }
      for (let batches = 0; ; batches += 1) {
        if (ctx.cancelled()) {
          await handle.sync();
          await this.finish('cancelled', null);
          return { continueWith: this.checkpoint(), progress: this.progress(list.length), message: 'cancelled' };
        }
        if (batches > 0 && ctx.budgetLeftMs() < Math.max(SLICE_MARGIN_MS, 1.5 * lastBatchMs)) break;
        const started = Date.now();
        const next = await this.nextIds(list);
        if (next === null) {
          await this.write(handle, [exportTail(this.format)]);
          await handle.sync();
          await this.finish('succeeded', null);
          return { done: true, message: 'succeeded' };
        }
        await this.write(handle, await this.render(next, marc));
        lastBatchMs = Date.now() - started;
        await ctx.heartbeat({ progress: this.progress(list.length) });
      }
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    await this.flushRows();
    await withTx(ctx.handle, (trx) => saveRunSummary(trx, runId, this.summary()));
    return { continueWith: this.checkpoint(), progress: this.progress(list.length) };
  }

  private checkpoint(): ExportJobPayload {
    return { runId: this.runId, format: this.format, checkpoint: { ...this.cp } };
  }

  private progress(listLength: number): number {
    if (listLength === 0) return 0;
    return Math.min(99, Math.floor((100 * this.cp.index) / listLength));
  }

  private summary(): Record<string, unknown> {
    return { records: this.cp.written, items: this.cp.items, skipped: { marc_too_long: this.cp.skipped }, bytes: this.cp.bytes };
  }

  /** The file and the report work file cut back to the checkpoint; the export starts over when either lost bytes. */
  private async cutBack(): Promise<void> {
    const file = this.file();
    const info = await statOrNull(file);
    const lost = this.cp.bytes > 0 && (info === null || info.kind !== 'file' || info.size < this.cp.bytes);
    if (lost || !(await truncateReportLines(this.deps.dataDir, this.runId, this.cp.reportBytes))) {
      this.deps.log.warn('catalog export: the partial file was lost, the export starts over', { runId: this.runId });
      this.cp = initialCheckpoint(this.filter);
      await removeFile(file).catch(() => undefined);
      await removeFile(runWorkPath(this.deps.dataDir, this.runId, 'report.csv')).catch(() => undefined);
      return;
    }
    if (info !== null && info.size > this.cp.bytes) await truncateFile(file, this.cp.bytes);
  }

  /** The next batch of record ids (possibly empty after the filters), or null when every source is read. */
  private async nextIds(list: readonly string[]): Promise<string[] | null> {
    const db = this.ctx.db;
    if (sourceOf(this.filter) === 'keyset') {
      const page = await keysetIds(db, this.cp.afterId, this.filter);
      if (page.ids.length === 0) return null;
      this.cp = { ...this.cp, afterId: page.scanned, index: this.cp.index + page.ids.length };
      return page.ids;
    }
    if (this.cp.index >= list.length) return null;
    const slice = list.slice(this.cp.index, this.cp.index + BATCH);
    this.cp = { ...this.cp, index: this.cp.index + slice.length };
    return keptIds(db, slice, this.filter);
  }

  /** The bytes of the records `ids` (the skipped ones reported). */
  private async render(ids: readonly string[], marc: { orgCode: string | null; baseUrl: string; includeItems: boolean }): Promise<Uint8Array[]> {
    if (ids.length === 0) return [];
    const db = this.ctx.db;
    if (this.format === 'csv-items') {
      const { rows, count: n } = await csvItemRows(db, ids, this.filter, this.cp.customCodes);
      this.cp = { ...this.cp, written: this.cp.written + ids.length, items: this.cp.items + n };
      return rows;
    }
    const isMarc = this.format === 'marc21' || this.format === 'marcxml' || this.format === 'marcjson';
    const data = await loadRecordData(db, ids, { publicOnly: false, includeItems: isMarc && marc.includeItems });
    const out: Uint8Array[] = [];
    let written = 0;
    let skipped = 0;
    for (const id of ids) {
      const d = data.get(id);
      if (d === undefined) continue;
      if (!isMarc) {
        out.push(csvRecordBytes(d, this.cp.customCodes));
        written += 1;
        continue;
      }
      try {
        out.push(marcRecordBytes(this.format as 'marc21' | 'marcxml' | 'marcjson', staffMarc(d, marc)));
        written += 1;
      } catch (error) {
        if (!(error instanceof MarcTooLongError)) throw error;
        skipped += 1;
        const title = Array.from(d.title).slice(0, TITLE_MAX).join('');
        this.report([id, 'skipped', 'marc_too_long', title]);
      }
    }
    this.cp = { ...this.cp, written: this.cp.written + written, skipped: this.cp.skipped + skipped };
    return out;
  }

  private report(row: readonly string[]): void {
    if (this.cp.reportRows + this.rows.length < RUN_REPORT_MAX_ROWS) this.rows.push(reportLine(row));
    else this.cp = { ...this.cp, reportDropped: this.cp.reportDropped + 1 };
  }

  /** The slice's report rows appended (after the file was flushed). */
  private async flushRows(): Promise<void> {
    const reportBytes = await appendReportLines(this.deps.dataDir, this.runId, this.rows);
    this.cp = { ...this.cp, reportBytes, reportRows: this.cp.reportRows + this.rows.length };
    this.rows.length = 0;
  }

  private async write(handle: FileHandle, parts: readonly Uint8Array[]): Promise<void> {
    for (const part of parts) {
      let written = 0;
      while (written < part.byteLength) written += (await handle.write(part, written, part.byteLength - written)).bytesWritten;
      this.cp = { ...this.cp, bytes: this.cp.bytes + part.byteLength };
    }
  }

  private async finish(status: RunEnd, code: string | null): Promise<void> {
    if (this.finished) return;
    const { ctx, runId } = this;
    const dataDir = this.deps.dataDir;
    const now = ctx.now();
    if (status === 'failed' && code !== null) this.report(['', 'error', code, '']);
    await this.flushRows();
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
      try {
        reportFileId = await writeRunReport(ctx.handle, this.deps.storage, runId, EXPORT_REPORT_HEADER, reportRowsOf(dataDir, runId, this.cp.reportDropped), {
          now,
          createdBy: this.row.created_by,
        });
      } catch (error) {
        if (status === 'succeeded') throw error;
        this.deps.log.warn('catalog export: the report of an ending run could not be written', { runId, ...errorFields(error) });
      }
    }
    const file = this.file();
    const size = status === 'succeeded' ? ((await statOrNull(file))?.size ?? null) : null;
    if (status === 'succeeded' && size !== this.cp.bytes) throw new TypeError('catalog export: the file does not have the length written');
    const summary = { ...this.summary(), ...(code === null ? {} : { error: code }) };
    await ctx.heartbeat();
    await withTx(ctx.handle, (trx) =>
      finishRun(
        trx,
        runId,
        status === 'succeeded'
          ? { status, summary, reportFileId, outputName: `${runId}.${EXPORT_EXTENSIONS[this.format]}`, outputSize: size, expiresAt: now + EXPIRES_MS }
          : { status, summary, reportFileId },
        now,
      ),
    );
    this.finished = true;
    if (status !== 'succeeded') await removeFile(file).catch(() => undefined);
    await removeTree(runWorkDir(dataDir, runId)).catch(() => undefined);
  }
}

/**
 * Starts an export in `tx` (see the top of this file); the caller wakes the runner after the COMMIT.
 */
export async function startCatalogExport(tx: TxCtx, registry: JobRegistry, body: ExportBody, o: { keyring: readonly KeyringEntry[] }): Promise<RunStarted> {
  const runId = await createRun(tx, { kind: 'export', dryRun: false, format: body.format, options: body as unknown as Record<string, unknown> });
  const payload: ExportJobPayload = { runId, format: body.format, checkpoint: initialCheckpoint(body.filter) };
  const queued = await enqueue(
    tx.trx,
    registry,
    { type: CATALOG_EXPORT_JOB, payload, createdBy: tx.actor.type === 'staff' ? tx.actor.id : null },
    { now: tx.now, keyring: o.keyring },
  );
  await attachRunJob(tx.trx, runId, queued.id);
  const f = body.filter;
  await tx.audit({
    action: 'catalog.export.start',
    entity: 'catalog_runs',
    entityId: runId,
    meta: {
      format: body.format,
      filters: Object.keys(f)
        .filter((k) => f[k as keyof ExportFilter] !== undefined)
        .sort(),
      recordIds: f.recordIds?.length ?? 0,
    },
  });
  return { runId, jobId: queued.id };
}
