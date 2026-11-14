import { createHash } from 'node:crypto';
import { withTx, type CatalogRunsTable, type DB, type DbHandle } from '@altis/db';
import { newId } from '@altis/shared';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import { CSV_BOM, csvRow } from '../../export/csv.js';
import type { StorageDriver } from '../../files/serve.js';

// Catalog runs (Phase 2 spec §2.2 `catalog_runs`, §5.3, §5.4, §11.6): one row per import, export, migration or dedupe
// scan, which its job moves from `queued` through `running` to a terminal status. `options` (never a secret) and
// `summary` are JSON capped at 60 000 bytes (MySQL TEXT; a run reports counters, the details go to the report file).
//
// - The report is a generated `files` row (not an upload) with `context 'catalog.report'`, owned by the run (`owner_type
//   'catalog_runs'`), staff-only, `text/csv`: the header, the first 10 000 rows, and `# truncated,<n>` when n more came.
//   It is written outside any transaction (a file, then its row: a row never names a missing file).
// - A run's work folder `tmp/<runId>/` holds its staging (an import's `import.bin`, the dump's NDJSON, `files.bin`,
//   `report.csv`). Appending to a file does not touch its folder's mtime, so the files cleanup asks
//   protectedRunWorkIds before removing an old `tmp/<ulid>/` (S2): a queued or running run keeps its folder, and so
//   does a finished one for 7 days, since a real run adopts its dry run's input (S3).

/**
 * What a catalog run does; `slims_usage` is the read-only import of SLiMS usage statistics into an accreditation period,
 * `member_import` the CSV import of members.
 */
export type RunKind =
  | 'import'
  | 'export'
  | 'migration'
  | 'dedupe_scan'
  // ---- Komunitas K1 (runs) ----
  | 'slims_usage'
  // ---- Komunitas (members and circulation) ----
  | 'member_import';

/** A run's terminal status. */
export type RunEnd = 'succeeded' | 'failed' | 'cancelled';

/** A `catalog_runs` row. */
export type RunRow = Selectable<CatalogRunsTable>;

/** `options` and `summary`: at most this many bytes of JSON. */
export const RUN_JSON_MAX_BYTES = 60_000;
/** A report keeps this many data rows. */
export const RUN_REPORT_MAX_ROWS = 10_000;
/** A finished run's work folder is kept this long after it finished (S2: a dry run's input is reused, S3). */
export const RUN_WORK_KEEP_MS = 7 * 86_400_000;

const RUN_KINDS: readonly RunKind[] = [
  'import',
  'export',
  'migration',
  'dedupe_scan',
  // ---- Komunitas K1 (runs) ----
  'slims_usage',
  // ---- Komunitas (members and circulation) ----
  'member_import',
];
const RUN_ENDS: readonly RunEnd[] = ['succeeded', 'failed', 'cancelled'];
const ID_BATCH = 500;

type Db = Kysely<DB> | Transaction<DB>;

/** `value` as JSON text of at most {@link RUN_JSON_MAX_BYTES}; a TypeError otherwise. */
function runJson(what: string, value: Record<string, unknown>): string {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || json[0] !== '{') throw new TypeError(`${what} must be a JSON object`);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > RUN_JSON_MAX_BYTES) throw new TypeError(`${what} is ${bytes} bytes of JSON, more than ${RUN_JSON_MAX_BYTES}`);
  return json;
}

/**
 * Creates a `queued` run of `r.kind` by the transaction's actor, at its time, and returns its id.
 *
 * @throws TypeError for an unknown kind, or `options` over 60 000 bytes of JSON
 */
export async function createRun(
  tx: TxCtx,
  r: { kind: RunKind; dryRun: boolean; format: string | null; options: Record<string, unknown> },
): Promise<string> {
  if (!RUN_KINDS.includes(r.kind)) throw new TypeError(`createRun(): unknown kind ${JSON.stringify(r.kind)}`);
  const options = runJson('createRun(): options', r.options);
  const id = newId(tx.now);
  await tx.trx
    .insertInto('catalog_runs')
    .values({
      id,
      kind: r.kind,
      status: 'queued',
      dry_run: r.dryRun ? 1 : 0,
      format: r.format,
      options,
      summary: '{}',
      report_file_id: null,
      output_name: null,
      output_size: null,
      expires_at: null,
      job_id: null,
      created_at: tx.now,
      created_by: tx.actor.id,
      finished_at: null,
    })
    .execute();
  return id;
}

/** Records the job that runs `runId`. */
export async function attachRunJob(trx: Transaction<DB>, runId: string, jobId: string): Promise<void> {
  await trx.updateTable('catalog_runs').set({ job_id: jobId }).where('id', '=', runId).execute();
}

/**
 * Marks a queued run `running` (its job's first slice). A run already running (a slice resumed after a crash) or
 * finished is left as it is. `now` is the slice's time (the row keeps no start time of its own).
 */
export async function startRun(trx: Transaction<DB>, runId: string, now: number): Promise<void> {
  void now;
  await trx.updateTable('catalog_runs').set({ status: 'running' }).where('id', '=', runId).where('status', '=', 'queued').execute();
}

/**
 * Replaces a run's summary (its job saves its counters as it goes).
 *
 * @throws TypeError when the summary is over 60 000 bytes of JSON (nothing written)
 */
export async function saveRunSummary(trx: Transaction<DB>, runId: string, summary: Record<string, unknown>): Promise<void> {
  const json = runJson('saveRunSummary(): summary', summary);
  await trx.updateTable('catalog_runs').set({ summary: json }).where('id', '=', runId).execute();
}

/**
 * Ends a queued or running run with `f.status` at `now`, with its final summary and, when given, its report file, its
 * output file (`DATA_DIR/exports/<outputName>`, `outputSize` bytes) and when that expires. A run that has ended already
 * is left as it is (a retried slice): the return value says whether this call ended it.
 *
 * @throws TypeError for a status that is not terminal, or a summary over 60 000 bytes of JSON (nothing written)
 */
export async function finishRun(
  trx: Transaction<DB>,
  runId: string,
  f: {
    status: RunEnd;
    summary: Record<string, unknown>;
    reportFileId?: string | null;
    outputName?: string | null;
    outputSize?: number | null;
    expiresAt?: number | null;
  },
  now: number,
): Promise<boolean> {
  if (!RUN_ENDS.includes(f.status)) throw new TypeError(`finishRun(): ${JSON.stringify(f.status)} is not a terminal status`);
  const summary = runJson('finishRun(): summary', f.summary);
  const result = await trx
    .updateTable('catalog_runs')
    .set({
      status: f.status,
      summary,
      report_file_id: f.reportFileId ?? null,
      output_name: f.outputName ?? null,
      output_size: f.outputSize ?? null,
      expires_at: f.expiresAt ?? null,
      finished_at: now,
    })
    .where('id', '=', runId)
    .where('status', 'in', ['queued', 'running'])
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** The run `id`, or null. */
export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  return (await db.selectFrom('catalog_runs').selectAll().where('id', '=', id).executeTakeFirst()) ?? null;
}

/**
 * Writes the report of run `runId` (a generated `files` row): a CSV (BOM, `,`, every cell through csvRow) of `header` and the
 * first 10 000 of `rows`, then `# truncated,<n>` when n more came (all of `rows` is read, to count them). The file is
 * stored through `storage`, then its `files` row is written (`context 'catalog.report'`, `owner_type 'catalog_runs'`,
 * `owner_id` the run, `access 'staff'`, `mime 'text/csv'`). Call it outside any transaction: it runs its own.
 *
 * @returns the file's id (for finishRun's `reportFileId`)
 */
export async function writeRunReport(
  h: DbHandle,
  storage: StorageDriver,
  runId: string,
  header: readonly string[],
  rows: AsyncIterable<readonly string[]> | Iterable<readonly string[]>,
  o: { now: number; createdBy: string | null },
): Promise<string> {
  const parts: Buffer[] = [Buffer.from(CSV_BOM + csvRow(header, ','), 'utf8')];
  let kept = 0;
  let dropped = 0;
  for await (const row of rows) {
    if (kept < RUN_REPORT_MAX_ROWS) {
      parts.push(Buffer.from(csvRow(row, ','), 'utf8'));
      kept += 1;
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) parts.push(Buffer.from(csvRow(['# truncated', String(dropped)], ','), 'utf8'));
  const data = Buffer.concat(parts);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const fileId = newId(o.now);
  await storage.put(fileId, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), { size: data.byteLength, sha256 });
  await withTx(h, async (trx) => {
    await trx
      .insertInto('files')
      .values({
        id: fileId,
        original_name: `report-${runId}.csv`,
        mime: 'text/csv',
        size: data.byteLength,
        sha256,
        context: 'catalog.report',
        owner_type: 'catalog_runs',
        owner_id: runId,
        access: 'staff',
        status: 'ok',
        created_at: o.now,
        created_by: o.createdBy,
      })
      .execute();
  });
  return fileId;
}

/**
 * The ids among `ids` whose work folder `tmp/<id>/` must stay (S2): those naming a run that is `queued` or `running`,
 * or that finished less than {@link RUN_WORK_KEEP_MS} before `now` (a terminal run without `finished_at` counts from
 * its creation).
 */
export async function protectedRunWorkIds(db: Db, ids: readonly string[], now: number): Promise<Set<string>> {
  const kept = new Set<string>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const rows = await db
      .selectFrom('catalog_runs')
      .select(['id', 'status', 'finished_at', 'created_at'])
      .where('id', 'in', unique.slice(i, i + ID_BATCH))
      .execute();
    for (const r of rows) {
      const live = r.status === 'queued' || r.status === 'running';
      if (live || (r.finished_at ?? r.created_at) > now - RUN_WORK_KEEP_MS) kept.add(r.id);
    }
  }
  return kept;
}
