import { withTx, type DB, type DbHandle } from '@altis/db';
import { openAppend, readBytes, removeTree, runWorkDir, runWorkPath, statOrNull, truncateFile, type DataPath } from '@altis/platform';
import { ulidField } from '@altis/shared/api/common';
import type { DedupeGroupReason, DedupeScanSummary, RunStarted } from '@altis/shared/api/catalog/runs';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { errorFields, type TxCtx } from '../../context.js';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import { enqueue } from '../../jobs/enqueue.js';
import type { JobContext, JobHandler, JobOutcome, JobRegistry } from '../../jobs/types.js';
import { RUN_REPORT_MAX_ROWS, attachRunJob, createRun, finishRun, getRun, saveRunSummary, startRun, writeRunReport } from '../data/runs.js';
import type { CatalogJobDeps } from '../jobs-deps.js';

// The duplicate scan of the catalogue (`catalog.dedupe_scan`; Phase 2 spec §3.3 "Pindai katalog", §12.2; plan Task 19,
// decision P2-12): groups of live records that share something exactly, no fuzzy matching (the editor's scored check
// is Task 16's), written to a CSV report of the run, with counts and a preview in the run's summary.
//
// - Groups: (a) `isbn`, the same ISBN `value_key` on 2 or more live records; (b) `title_year`, the same `title_key` and
//   `publication_year` on 2 or more live records (a record without a year, or whose title key is empty, is in no title
//   group: "the same year" needs one). A record may be in an ISBN group and a title group: it is a row of each.
// - Report rows `group, reason, record_id, title, year, isbn`: the group's number (in scan order, ISBN groups first),
//   the reason, the record, its title (cut at 300 characters), its year, and the group's ISBN key (for a title group the
//   record's first ISBN, or empty). writeRunReport keeps the first 10 000 rows and counts the rest (`# truncated,<n>`).
// - Summary (DedupeScanSummary): the group counts by reason, `records` (the report's rows, so a record in two groups
//   counts twice), and `preview`, the first 200 groups with at most 20 record ids each, as long as the preview stays
//   under 40 000 bytes of JSON (the run's summary is capped at 60 000; the CSV has every row).
//
// Slicing (C38, P9): a keyset over the group keys, ISBN keys first, then title keys. A range is the keys after the
// checkpoint `after` up to and including the key `DEDUPE_RANGE_ROWS` index rows further (`LIMIT 1 OFFSET n-1` on
// `ix_record_identifiers_type_value_key` or `ix_records_title_key`, an index-only read): a range never splits a key, so
// a group is always read whole, and each range reads a bounded number of rows. The rows of the groups found are
// appended to the work file `tmp/<runId>/groups.ndjson` (one JSON array per line, the first 10 000 rows only), whose
// length the checkpoint records (`bytes`):
//   - a slice that resumes after a kill cuts the file back to that length, dropping what the killed slice wrote after
//     its last checkpoint, and does that range again;
//   - a file shorter than the checkpoint (the machine lost writes) starts the scan again from the first key.
// The last slice writes the report (a report the run already owns, written by a slice killed before finishRun, is
// reused), ends the run `succeeded` and removes the work folder. A cancel ends the run `cancelled` and removes it too.

/** The job type, and the unique key that keeps one scan alive at a time. */
export const DEDUPE_SCAN_JOB = 'catalog.dedupe_scan';
export const DEDUPE_SCAN_UNIQUE_KEY = 'catalog.dedupe_scan';

/** How many key index rows one range covers (plus the rows of its last key). */
const DEDUPE_RANGE_ROWS = 2000;
/** The preview: at most this many groups, this many ids each, this many bytes of JSON. */
const PREVIEW_GROUPS = 200;
const PREVIEW_IDS = 20;
const PREVIEW_MAX_BYTES = 40_000;
/** A title is cut to this many characters in the report (the record id names the record). */
const TITLE_MAX = 300;
/** The work file holds at most 10 000 rows of at most a few KiB each. */
const WORK_FILE_MAX_BYTES = 64 * 1024 * 1024;
const WORK_FILE = 'groups.ndjson';
/** Another range only while this much of the slice's budget is left (the first range of a slice always runs). */
const RANGE_MARGIN_MS = 3000;
const ID_BATCH = 500;

const REPORT_HEADER: readonly string[] = Object.freeze(['group', 'reason', 'record_id', 'title', 'year', 'isbn']);
const PHASES = ['isbn', 'title_year', 'report'] as const;
type Phase = (typeof PHASES)[number];
const REASONS = ['isbn', 'title_year'] as const satisfies readonly DedupeGroupReason[];
const PROGRESS: Readonly<Record<Phase, number>> = { isbn: 10, title_year: 50, report: 90 };
const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The payload: the run, and the checkpoint of a scan that continues (absent on the first slice). */
export const dedupeScanPayload = z.strictObject({
  runId: ulidField,
  phase: z.enum(PHASES).optional(),
  /** The last key of the last range done in this phase; null at its start. */
  after: z.string().min(1).max(1024).nullable().optional(),
  groups: z.strictObject({ isbn: count, title_year: count }).optional(),
  records: count.optional(),
  /** Rows in the work file (at most 10 000) and its length in bytes. */
  kept: z.int().min(0).max(RUN_REPORT_MAX_ROWS).optional(),
  bytes: count.optional(),
  preview: z
    .array(z.strictObject({ reason: z.enum(REASONS), recordIds: z.array(ulidField).min(2).max(PREVIEW_IDS) }))
    .max(PREVIEW_GROUPS)
    .optional(),
});

export type DedupeScanPayload = z.infer<typeof dedupeScanPayload>;

interface ScanState {
  phase: Phase;
  after: string | null;
  groups: { isbn: number; title_year: number };
  records: number;
  kept: number;
  bytes: number;
  preview: { reason: DedupeGroupReason; recordIds: string[] }[];
}

/** One group of a range: the reason, the shared ISBN key of an ISBN group, the records in id order. */
interface Group {
  reason: DedupeGroupReason;
  isbn: string | null;
  ids: string[];
}

function initialState(): ScanState {
  return { phase: 'isbn', after: null, groups: { isbn: 0, title_year: 0 }, records: 0, kept: 0, bytes: 0, preview: [] };
}

function stateOf(p: DedupeScanPayload): ScanState {
  return {
    phase: p.phase ?? 'isbn',
    after: p.after ?? null,
    groups: p.groups ?? { isbn: 0, title_year: 0 },
    records: p.records ?? 0,
    kept: p.kept ?? 0,
    bytes: p.bytes ?? 0,
    preview: p.preview ?? [],
  };
}

function payloadOf(runId: string, s: ScanState): DedupeScanPayload {
  return { runId, phase: s.phase, after: s.after, groups: s.groups, records: s.records, kept: s.kept, bytes: s.bytes, preview: s.preview };
}

function summaryOf(s: ScanState): DedupeScanSummary & Record<string, unknown> {
  return { groups: { ...s.groups }, records: s.records, preview: s.preview };
}

/** `title` cut to {@link TITLE_MAX} characters (code points), with `...` when cut. */
function cutTitle(title: string): string {
  if (title.length <= TITLE_MAX) return title;
  const points = Array.from(title);
  return points.length <= TITLE_MAX ? title : `${points.slice(0, TITLE_MAX).join('')}...`;
}

/** The runs of equal `key` in `rows` (ordered by key, then id) that hold 2 records or more. */
function groupsOf(rows: readonly { key: string; id: string; isbn: string | null }[], reason: DedupeGroupReason): Group[] {
  const groups: Group[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (j < rows.length && rows[j]!.key === rows[i]!.key) j += 1;
    if (j - i >= 2) groups.push({ reason, isbn: rows[i]!.isbn, ids: rows.slice(i, j).map((r) => r.id) });
    i = j;
  }
  return groups;
}

/** The last key of the range after `after` (`rangeRows` key index rows on), or null when the rest is one range. */
async function upperKey(db: Kysely<DB>, reason: DedupeGroupReason, after: string | null, rangeRows: number): Promise<string | null> {
  if (reason === 'isbn') {
    let q = db.selectFrom('record_identifiers').select('value_key as k').where('type', '=', 'isbn');
    if (after !== null) q = q.where('value_key', '>', after);
    return (await q.orderBy('value_key').limit(1).offset(rangeRows - 1).executeTakeFirst())?.k ?? null;
  }
  let q = db.selectFrom('records').select('title_key as k');
  if (after !== null) q = q.where('title_key', '>', after);
  return (await q.orderBy('title_key').limit(1).offset(rangeRows - 1).executeTakeFirst())?.k ?? null;
}

/** The ISBN groups of the keys in (`after`, `upper`]. */
async function isbnGroups(db: Kysely<DB>, after: string | null, upper: string | null): Promise<Group[]> {
  let q = db
    .selectFrom('record_identifiers as ri')
    .innerJoin('records as r', 'r.id', 'ri.record_id')
    .select(['ri.value_key as key', 'ri.record_id as id'])
    .where('ri.type', '=', 'isbn')
    .where('r.archived_at', 'is', null);
  if (after !== null) q = q.where('ri.value_key', '>', after);
  if (upper !== null) q = q.where('ri.value_key', '<=', upper);
  const rows = await q.orderBy('ri.value_key').orderBy('ri.record_id').execute();
  return groupsOf(
    rows.map((r) => ({ key: r.key, id: r.id, isbn: r.key })),
    'isbn',
  );
}

/** The title + year groups of the title keys in (`after`, `upper`]. */
async function titleYearGroups(db: Kysely<DB>, after: string | null, upper: string | null): Promise<Group[]> {
  let q = db
    .selectFrom('records')
    .select(['id', 'title_key', 'publication_year'])
    .where('archived_at', 'is', null)
    .where('publication_year', 'is not', null)
    .where('title_key', '!=', '');
  if (after !== null) q = q.where('title_key', '>', after);
  if (upper !== null) q = q.where('title_key', '<=', upper);
  const rows = await q.orderBy('title_key').orderBy('publication_year').orderBy('id').execute();
  return groupsOf(
    rows.map((r) => ({ key: JSON.stringify([r.title_key, r.publication_year]), id: r.id, isbn: null })),
    'title_year',
  );
}

/** The title and year of each record of `groups`, and the first ISBN of those in title groups. */
async function details(db: Kysely<DB>, groups: readonly Group[]): Promise<Map<string, { title: string; year: string | null; isbn: string | null }>> {
  const out = new Map<string, { title: string; year: string | null; isbn: string | null }>();
  const ids = [...new Set(groups.flatMap((g) => g.ids))];
  const titleIds = new Set(groups.filter((g) => g.reason === 'title_year').flatMap((g) => g.ids));
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    for (const r of await db.selectFrom('records').select(['id', 'title', 'publication_year']).where('id', 'in', batch).execute()) {
      out.set(r.id, { title: cutTitle(r.title), year: r.publication_year, isbn: null });
    }
    const wanted = batch.filter((id) => titleIds.has(id));
    if (wanted.length === 0) continue;
    const isbns = await db
      .selectFrom('record_identifiers')
      .select(['record_id', 'value_key'])
      .where('type', '=', 'isbn')
      .where('record_id', 'in', wanted)
      .orderBy('record_id')
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
    for (const r of isbns) {
      const d = out.get(r.record_id);
      if (d !== undefined && d.isbn === null) d.isbn = r.value_key;
    }
  }
  return out;
}

/** Appends `data` to the work file `p` (created with its folder when missing). */
async function append(p: DataPath, data: Buffer): Promise<void> {
  const handle = await openAppend(p);
  try {
    for (let at = 0; at < data.byteLength; ) {
      const { bytesWritten } = await handle.write(data, at, data.byteLength - at);
      at += bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

/**
 * The state `s` against the work file `p`: bytes past the checkpoint (a killed slice's) are cut off; a file shorter
 * than the checkpoint starts the scan again (emptied first).
 */
async function aligned(p: DataPath, s: ScanState): Promise<ScanState> {
  const info = await statOrNull(p);
  const size = info === null ? 0 : info.size;
  if (size < s.bytes) {
    if (info !== null) await truncateFile(p, 0);
    return initialState();
  }
  if (size > s.bytes) await truncateFile(p, s.bytes);
  return s;
}

/** The next range of the phase of `s`: its groups counted, previewed and written (the first 10 000 rows). */
async function nextRange(db: Kysely<DB>, work: DataPath, s: ScanState, rangeRows: number): Promise<ScanState> {
  const reason = s.phase === 'isbn' ? 'isbn' : 'title_year';
  const upper = await upperKey(db, reason, s.after, rangeRows);
  const groups = reason === 'isbn' ? await isbnGroups(db, s.after, upper) : await titleYearGroups(db, s.after, upper);
  const next: ScanState = { ...s, groups: { ...s.groups }, preview: [...s.preview] };
  if (groups.length > 0) {
    const info = await details(db, groups);
    const lines: string[] = [];
    let previewBytes = Buffer.byteLength(JSON.stringify(next.preview), 'utf8');
    for (const g of groups) {
      const before = next.groups.isbn + next.groups.title_year;
      next.groups[g.reason] += 1;
      // The first groups only: once one did not fit, none after it is previewed.
      if (next.preview.length === before && before < PREVIEW_GROUPS) {
        const entry = { reason: g.reason, recordIds: g.ids.slice(0, PREVIEW_IDS) };
        const added = Buffer.byteLength(JSON.stringify(entry), 'utf8') + (next.preview.length === 0 ? 0 : 1);
        if (previewBytes + added <= PREVIEW_MAX_BYTES) {
          next.preview.push(entry);
          previewBytes += added;
        }
      }
      for (const id of g.ids) {
        next.records += 1;
        if (next.kept + lines.length >= RUN_REPORT_MAX_ROWS) continue;
        const d = info.get(id);
        const row = [String(before + 1), g.reason, id, d?.title ?? '', d?.year ?? '', (g.isbn ?? d?.isbn) ?? ''];
        lines.push(`${JSON.stringify(row)}\n`);
      }
    }
    if (lines.length > 0) {
      const data = Buffer.from(lines.join(''), 'utf8');
      await append(work, data);
      next.bytes += data.byteLength;
      next.kept += lines.length;
    }
  }
  if (upper === null) {
    next.phase = reason === 'isbn' ? 'title_year' : 'report';
    next.after = null;
  } else {
    next.after = upper;
  }
  return next;
}

/** The rows of the report: the work file's, then one empty row per row it did not keep (writeRunReport counts them). */
async function* reportRows(work: DataPath, s: ScanState): AsyncIterable<readonly string[]> {
  if (s.kept > 0) {
    const bytes = await readBytes(work, WORK_FILE_MAX_BYTES);
    for (const line of (bytes?.toString('utf8') ?? '').split('\n')) {
      if (line === '') continue;
      const row: unknown = JSON.parse(line);
      if (!Array.isArray(row) || !row.every((c) => typeof c === 'string')) throw new TypeError('dedupe scan: a work file row is not a list of texts');
      yield row as string[];
    }
  }
  const dropped: readonly string[] = Object.freeze([]);
  for (let i = s.kept; i < s.records; i += 1) yield dropped;
}

/** The report a slice killed before finishRun already stored for run `runId`, or null. */
async function storedReport(db: Kysely<DB>, runId: string): Promise<string | null> {
  const row = await db
    .selectFrom('files')
    .select('id')
    .where('owner_type', '=', 'catalog_runs')
    .where('owner_id', '=', runId)
    .where('context', '=', 'catalog.report')
    .where('status', '=', 'ok')
    .orderBy('id')
    .executeTakeFirst();
  return row?.id ?? null;
}

/** Removes the run's work folder; a failure is logged (files.cleanup removes it later). */
async function removeWork(d: CatalogJobDeps, runId: string): Promise<void> {
  try {
    await removeTree(runWorkDir(d.dataDir, runId));
  } catch (error) {
    d.log.warn('dedupe scan: the work folder could not be removed', { runId, ...errorFields(error) });
  }
}

/**
 * The `catalog.dedupe_scan` handler (see the top of this file): permission `catalog.records.manage` (who starts a scan),
 * heavy (it reads the whole catalogue: never beside an import or a reindex), driven from the Duplikat screen when no
 * worker runs. It is retried only by its route: a scan that died is started again as a new run.
 *
 * @param o.rangeRows the key index rows of one range (tests use small ones); default 2000
 */
export function dedupeScanJob(deps: () => CatalogJobDeps, o: { rangeRows?: number } = {}): JobHandler<DedupeScanPayload> {
  const rangeRows = o.rangeRows ?? DEDUPE_RANGE_ROWS;
  if (!Number.isSafeInteger(rangeRows) || rangeRows < 1) throw new RangeError('dedupeScanJob: rangeRows must be a positive integer');
  return {
    type: DEDUPE_SCAN_JOB,
    permission: 'catalog.records.manage',
    retryable: 'origin-only',
    cpuHeavy: true,
    interactive: true,
    payload: dedupeScanPayload,
    async run(ctx: JobContext, p: DedupeScanPayload): Promise<JobOutcome<DedupeScanPayload>> {
      const run = await getRun(ctx.db, p.runId);
      if (run === null || TERMINAL.has(run.status)) return { done: true };
      const d = deps();
      const h: DbHandle = ctx.handle;
      const runId = p.runId;
      if (run.status === 'queued') await withTx(h, (trx) => startRun(trx, runId, ctx.now()));
      const work = runWorkPath(d.dataDir, runId, WORK_FILE);

      const cancel = async (s: ScanState): Promise<JobOutcome<DedupeScanPayload>> => {
        await withTx(h, (trx) => finishRun(trx, runId, { status: 'cancelled', summary: summaryOf(s) }, ctx.now()));
        await removeWork(d, runId);
        // A continue of a job whose cancel was requested ends it `cancelled` (jobs/slice.ts).
        return { continueWith: payloadOf(runId, s), progress: PROGRESS[s.phase] };
      };
      const pause = async (s: ScanState): Promise<JobOutcome<DedupeScanPayload>> => {
        await withTx(h, (trx) => saveRunSummary(trx, runId, summaryOf(s)));
        return { continueWith: payloadOf(runId, s), progress: PROGRESS[s.phase] };
      };

      let s = await aligned(work, stateOf(p));
      let ranges = 0;
      while (s.phase !== 'report') {
        if (ctx.cancelled()) return cancel(s);
        if (ranges > 0 && ctx.budgetLeftMs() < RANGE_MARGIN_MS) return pause(s);
        s = await nextRange(ctx.db, work, s, rangeRows);
        ranges += 1;
        await ctx.heartbeat({ progress: PROGRESS[s.phase] });
      }
      if (ctx.cancelled()) return cancel(s);
      if (ranges > 0 && ctx.budgetLeftMs() < RANGE_MARGIN_MS) return pause(s);

      const now = ctx.now();
      const reportFileId =
        (await storedReport(ctx.db, runId)) ??
        (await writeRunReport(h, d.storage, runId, REPORT_HEADER, reportRows(work, s), { now, createdBy: run.created_by }));
      await withTx(h, (trx) => finishRun(trx, runId, { status: 'succeeded', summary: summaryOf(s), reportFileId }, now));
      await removeWork(d, runId);
      return { done: true };
    },
  };
}

/**
 * Starts a duplicate scan in the caller's transaction (`POST catalog/dedupe-scans`): a `dedupe_scan` run by the
 * transaction's actor and its `catalog.dedupe_scan` job, with the unique key {@link DEDUPE_SCAN_UNIQUE_KEY}. While a
 * scan is queued or running, that scan is answered instead (the new run is not kept), so a second click joins the
 * first. The caller wakes the worker after the commit.
 *
 * @param registry a registry with the `catalog.dedupe_scan` handler (the runtime's, or one of catalogRunJobs)
 * @throws TypeError as enqueue (no handler in `registry`, ...)
 */
export async function startDedupeScan(tx: TxCtx, registry: JobRegistry, o: { keyring: readonly KeyringEntry[] }): Promise<RunStarted> {
  const runId = await createRun(tx, { kind: 'dedupe_scan', dryRun: false, format: null, options: {} });
  const job = await enqueue(
    tx.trx,
    registry,
    { type: DEDUPE_SCAN_JOB, payload: { runId }, uniqueKey: DEDUPE_SCAN_UNIQUE_KEY, createdBy: tx.actor.id },
    { now: tx.now, keyring: o.keyring },
  );
  if (!job.existing) {
    await attachRunJob(tx.trx, runId, job.id);
    return { runId, jobId: job.id };
  }
  // A live scan holds the key: answer it, and drop the run made for this request (nobody saw it).
  await tx.trx.deleteFrom('catalog_runs').where('id', '=', runId).execute();
  const live = await tx.trx.selectFrom('catalog_runs').select('id').where('job_id', '=', job.id).where('kind', '=', 'dedupe_scan').executeTakeFirst();
  if (live !== undefined) return { runId: live.id, jobId: job.id };
  const holder = await tx.trx.selectFrom('jobs').select('payload').where('id', '=', job.id).executeTakeFirst();
  let named: unknown;
  try {
    named = holder === undefined ? null : JSON.parse(holder.payload);
  } catch {
    named = null;
  }
  const parsed = dedupeScanPayload.safeParse(named);
  if (!parsed.success) throw new TypeError('startDedupeScan: the live scan job names no run');
  return { runId: parsed.data.runId, jobId: job.id };
}
