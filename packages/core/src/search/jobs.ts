import { fullTextClear, fullTextFamily, upsert, withTx, type DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { CatalogJobDeps } from '../catalog/jobs-deps.js';
import type { KeyringEntry } from '../crypto/secret-box.js';
import { publish } from '../events/publish.js';
import { enqueue } from '../jobs/enqueue.js';
import type { JobContext, JobHandler, JobOutcome, JobRegistry } from '../jobs/types.js';
import { indexRecords, stampChanged } from './index-records.js';
import { SEARCH_TERMS_BATCH, addSearchTermsBatch, clearSearchTerms, finishSearchTerms } from './terms.js';
import { SEARCH_TOKEN_VERSION } from './tokenize.js';

// `catalog.reindex` (Phase 2 spec §4.8, §12.6): rebuilds the index of the whole catalogue, of a list of records, or of
// the records linked to one authority (after a rename or a merge, S12); and (Task 15) the daily refresh of the spelling
// vocabulary. Sliced (C38): each slice runs batches while `budgetLeftMs()` leaves 3 s and no cancel is pending (the
// first batch of a slice always runs), and returns its checkpoint `{phase, cursor}`; every batch is idempotent, so a
// slice killed anywhere reruns from the last saved checkpoint (P7). Every batch first locks its record rows (C05), so
// its documents are built after any write of those records committed, never from an older snapshot.
//
// - `{scope: 'all'}`: mark `search_state` building and empty the index (FTS5 `'delete-all'` first) in one transaction;
//   then `docs`: every record (archived ones too, the admin may ask for them) by keyset over `id`, 500 per
//   transaction through indexRecords; then `terms`: `search_term` rebuilt from the documents (terms.ts, keyset over
//   `doc_no`); then `search_state` ready with its document count, build time and token format (SEARCH_TOKEN_VERSION).
//   Its checkpoint carries the token format it builds with (`tokenVersion`, written from the clear on): a slice that
//   finds another one (an update changed the tokenizer while the build was in flight, or the build was started by a
//   release that recorded none) starts again from the clear, so a build never marks ready an index that holds documents
//   of two formats (X2-2).
// - `{scope: 'terms'}` (the daily refresh of `catalog.housekeeping`, unique key `catalog.reindex:terms`): the `terms`
//   phase alone, while the index is ready and no full rebuild is queued or running (that one rebuilds the terms itself:
//   the refresh then ends at once, so two writers never share `search_term`).
// - `{agentId}`, `{subjectId}`, `{publisherId}`: the linked records' documents rewritten and their `changed_at` (and
//   the documents' copy) set to the clock read at the end of the batch, right before COMMIT (their public form changed;
//   C14: an OAI harvest running meanwhile answers an earlier responseDate), 500 per transaction, keyset over the
//   record id.
// - `{recordIds}`: those records' documents rewritten (the caller set `changed_at`).
//
// `catalog.bulk.changed {runId: <job id>}` on the `catalog` channel is the last statement of every transaction that
// changed documents (§12.6, §10.6).
//
// A request after a change (C04/C06/C24): the authority scopes are always asked for because what the index holds of the
// authority changed (a rename, a merge into it), and `{scope: 'all'}` is when the caller says so (`changed`: a location
// move, a custom field's visibility, over their list limits). A job of that scope that has not started (queued, no
// checkpoint) reads every link after the change commits, so it is joined. One that has started (running, or queued
// with a `cursor` or a `phase`) has passed records it will not see again: it is superseded instead. Its unique key is
// taken from it and a new job of the scope holds it; the superseded one holds `catalog.reindex:superseded:<its id>`
// instead (so the mark outlives its successor: a short successor may end before the old one's next slice) and ends at
// that next slice (`{done: true}`, nothing written), so two full rebuilds never interleave, the older one never marks
// the index ready over the newer one's partial index and never rewrites `search_term` after it. A superseded job ends
// `succeeded` with the message "Superseded by a newer job": whoever follows its id (the CLI, a JobProgress) sees it end
// before its successor does (followups P2-REINDEX-SUPERSEDED-FOLLOWER). The holder is read with a locking read (FOR UPDATE on MySQL/MariaDB
// and PostgreSQL; SQLite has one writer), so a claim of it waits for the caller's commit. A plain rebuild request (the
// route, the CLI, the boot, the housekeeping) joins whatever rebuild is live (M15), and the terms refresh is always
// joined.

/** The most record ids one `recordIds` reindex takes (larger sets are split by the caller, or reindexed `all`). */
export const REINDEX_RECORD_IDS_MAX = 1000;

/** The longest keyset cursor of a reindex checkpoint (an id, or a term with an id): the payload stays small (R1c-6). */
export const REINDEX_CURSOR_MAX = 512;

/** The unique key of the full rebuild: one at a time, joined by every other request (boot, route, CLI, housekeeping). */
export const REINDEX_ALL_KEY = 'catalog.reindex:all';
/** The unique key of the daily vocabulary refresh. */
export const REINDEX_TERMS_KEY = 'catalog.reindex:terms';

/** Records per transaction of a rebuild (§4.8: keyset batches of 500). */
const RECORDS_BATCH = 500;
/** No further batch starts in a slice with less budget left than this (the first one always runs). */
const SLICE_MARGIN_MS = 3000;

/** What a reindex covers: everything, the vocabulary, some records, or the records linked to one authority. */
export type ReindexScope =
  | { scope: 'all' }
  | { scope: 'terms' }
  | { recordIds: string[] /* ≤ REINDEX_RECORD_IDS_MAX */ }
  | { agentId: string }
  | { subjectId: string }
  | { publisherId: string };

/** The checkpoint the sliced job keeps beside its scope. */
const progress = {
  cursor: z.string().min(1).max(REINDEX_CURSOR_MAX).nullable().optional(),
  phase: z.enum(['docs', 'terms']).optional(),
};

/** The payload of `catalog.reindex`: exactly one scope (strict objects, so two scopes never pass) and its checkpoint. */
export const reindexPayload = z.union([
  z.strictObject({ scope: z.literal('all'), ...progress, tokenVersion: z.int().min(0).max(32_767).optional() }),
  z.strictObject({ scope: z.literal('terms'), ...progress }),
  z.strictObject({ recordIds: z.array(ulidField).min(1).max(REINDEX_RECORD_IDS_MAX), ...progress }),
  z.strictObject({ agentId: ulidField, ...progress }),
  z.strictObject({ subjectId: ulidField, ...progress }),
  z.strictObject({ publisherId: ulidField, ...progress }),
]);

export type ReindexPayload = z.infer<typeof reindexPayload>;

type AllPayload = Extract<ReindexPayload, { scope: 'all' | 'terms' }>;
type RecordsPayload = Exclude<ReindexPayload, { scope: 'all' | 'terms' }>;

/** The slice's guard: another batch only while the budget lasts and no cancel is pending (the first one always runs). */
function slicer(ctx: JobContext): { more(): boolean; ran(): void } {
  let ran = false;
  return {
    more: () => !ran || (ctx.budgetLeftMs() >= SLICE_MARGIN_MS && !ctx.cancelled()),
    ran: () => {
      ran = true;
    },
  };
}

/**
 * Locks the record rows `ids` with a write that changes nothing: a batch's first statement, so its documents are built
 * after any write of those records committed (C05; on MySQL/MariaDB the snapshot starts at the first plain read).
 */
async function lockRecords(trx: Transaction<DB>, ids: readonly string[]): Promise<void> {
  await trx
    .updateTable('records')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', 'in', ids)
    .execute();
}

/** The hint of a batch that changed documents: the transaction's last statement. */
function changed(trx: Transaction<DB>, jobId: string): Promise<void> {
  return publish(trx, { channel: 'catalog', type: 'catalog.bulk.changed', payload: { runId: jobId } });
}

/** Writes `search_state` (one row, id 1); a ready one with this release's token format (migration 0029). */
async function writeState(trx: Transaction<DB>, row: { status: 'building' | 'ready'; docs: number; job_id: string | null; built_at?: number }): Promise<void> {
  const set = {
    status: row.status,
    docs: row.docs,
    job_id: row.job_id,
    ...(row.built_at === undefined ? {} : { built_at: row.built_at }),
    ...(row.status === 'ready' ? { token_version: SEARCH_TOKEN_VERSION } : {}),
  };
  await upsert(trx, 'search_state', { id: 1 }, { built_at: null, token_version: null, ...set }, set);
}

/** A whole-number checkpoint (a `doc_no`), or null when `cursor` is none or not one. */
function docNoOf(cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined || !/^\d{1,15}$/.test(cursor)) return null;
  return Number(cursor);
}

/** Whether a full rebuild is queued or running. */
async function fullRebuildLive(ctx: JobContext): Promise<boolean> {
  const row = await ctx.db
    .selectFrom('jobs')
    .select('id')
    .where('unique_key', '=', REINDEX_ALL_KEY)
    .where('status', 'in', ['queued', 'running'])
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The unique key a superseded job holds instead of its scope's (see the top of this file): its own, so it stays marked
 * after its successor ended and gave the scope's key up. No other write gives a live job a key (a retried dead job has
 * none), and a terminal status clears it.
 */
function supersededKeyOf(jobId: string): string {
  return `catalog.reindex:superseded:${jobId}`;
}

/**
 * Whether a request after this job started took its scope's unique key (see the top of this file): this job holds the
 * superseded mark, or another job holds the scope's key. The job holding it, or that held it, does everything this one
 * would still do.
 */
async function superseded(ctx: JobContext, scope: ReindexScope): Promise<boolean> {
  const key = uniqueKeyOf(scope);
  if (key === undefined) return false;
  const own = await ctx.db.selectFrom('jobs').select('unique_key').where('id', '=', ctx.jobId).executeTakeFirst();
  if (own?.unique_key === supersededKeyOf(ctx.jobId)) return true;
  const holder = await ctx.db.selectFrom('jobs').select('id').where('unique_key', '=', key).executeTakeFirst();
  return holder !== undefined && holder.id !== ctx.jobId;
}

/** The outcome of a superseded job. */
const SUPERSEDED: JobOutcome<ReindexPayload> = { done: true, message: 'Digantikan tugas yang lebih baru / Superseded by a newer job' };

/** `{scope: 'all'}` and `{scope: 'terms'}` (see the top of this file). */
async function runAll(ctx: JobContext, p: AllPayload): Promise<JobOutcome<ReindexPayload>> {
  const full = p.scope === 'all';
  if (full && (await superseded(ctx, { scope: 'all' }))) return SUPERSEDED;
  if (!full) {
    // The refresh yields to a full rebuild, and has nothing to refresh while the index is not ready.
    const state = await ctx.db.selectFrom('search_state').select('status').where('id', '=', 1).executeTakeFirst();
    if (state?.status !== 'ready' || (await fullRebuildLive(ctx))) return { done: true };
  }
  let phase: 'docs' | 'terms' | undefined = full ? p.phase : 'terms';
  let cursor: string | null = p.cursor ?? null;
  if (full && phase !== undefined && (p.scope !== 'all' || p.tokenVersion !== SEARCH_TOKEN_VERSION)) {
    // Started under another token format (see the top of this file): the documents it wrote go with the clear.
    phase = undefined;
    cursor = null;
  }
  const slice = slicer(ctx);
  const records = full ? await ctx.db.selectFrom('records').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst() : undefined;
  const total = Math.max(1, Number(records?.n ?? 1));
  // The records an earlier slice already indexed (those up to the checkpoint), so the progress goes on from there.
  let done = 0;
  if (full && phase === 'docs' && cursor !== null) {
    const before = await ctx.db.selectFrom('records').select((eb) => eb.fn.countAll<number>().as('n')).where('id', '<=', cursor).executeTakeFirst();
    done = Number(before?.n ?? 0);
  }
  const checkpoint = (pct: number): JobOutcome<ReindexPayload> => ({
    continueWith: { scope: p.scope, ...(phase === undefined ? {} : { phase, ...(full ? { tokenVersion: SEARCH_TOKEN_VERSION } : {}) }), cursor },
    progress: pct,
  });
  const pctDocs = () => Math.min(89, Math.floor((90 * done) / total));
  for (;;) {
    if (!slice.more()) return checkpoint(phase === 'terms' ? 90 : pctDocs());
    const now = ctx.now();
    if (phase === undefined) {
      await withTx(ctx.handle, async (trx) => {
        await writeState(trx, { status: 'building', docs: 0, job_id: ctx.jobId });
        await fullTextClear(trx, fullTextFamily(trx));
        await trx.deleteFrom('search_facet').execute();
        await trx.deleteFrom('search_doc').execute();
        await changed(trx, ctx.jobId);
      });
      phase = 'docs';
      cursor = null;
      slice.ran();
      continue;
    }
    if (phase === 'docs') {
      let q = ctx.db.selectFrom('records').select('id').orderBy('id').limit(RECORDS_BATCH);
      if (cursor !== null) q = q.where('id', '>', cursor);
      const ids = (await q.execute()).map((r) => r.id);
      if (ids.length === 0) {
        phase = 'terms';
        cursor = null;
        continue;
      }
      await withTx(ctx.handle, async (trx) => {
        await lockRecords(trx, ids);
        await indexRecords(trx, ids, now);
        await changed(trx, ctx.jobId);
      });
      cursor = ids[ids.length - 1]!;
      done += ids.length;
      slice.ran();
      await ctx.heartbeat({ progress: pctDocs() });
      continue;
    }
    // phase 'terms': cleared once (cursor null), then batches after the checkpoint's doc_no.
    const after = docNoOf(cursor);
    if (after === null) {
      await withTx(ctx.handle, (trx) => clearSearchTerms(trx));
      cursor = '0';
      slice.ran();
      continue;
    }
    const last = await withTx(ctx.handle, (trx) => addSearchTermsBatch(trx, after, SEARCH_TERMS_BATCH));
    slice.ran();
    if (last !== null) {
      cursor = String(last);
      await ctx.heartbeat({ progress: 90 });
      continue;
    }
    await withTx(ctx.handle, async (trx) => {
      await finishSearchTerms(trx);
      if (full) {
        const docs = await trx.selectFrom('search_doc').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
        await writeState(trx, { status: 'ready', docs: Number(docs?.n ?? 0), job_id: null, built_at: ctx.now() });
      }
    });
    return { done: true };
  }
}

/** The next record ids of a records or authority scope after `cursor` (at most 500, in id order). */
async function nextRecords(ctx: JobContext, p: RecordsPayload, cursor: string | null): Promise<string[]> {
  if ('recordIds' in p) {
    return [...new Set(p.recordIds)]
      .sort()
      .filter((id) => cursor === null || id > cursor)
      .slice(0, RECORDS_BATCH);
  }
  if ('publisherId' in p) {
    let q = ctx.db.selectFrom('records').select('id').where('publisher_id', '=', p.publisherId).orderBy('id').limit(RECORDS_BATCH);
    if (cursor !== null) q = q.where('id', '>', cursor);
    return (await q.execute()).map((r) => r.id);
  }
  if ('agentId' in p) {
    let q = ctx.db
      .selectFrom('record_agents')
      .select('record_id')
      .where('agent_id', '=', p.agentId)
      .groupBy('record_id')
      .orderBy('record_id')
      .limit(RECORDS_BATCH);
    if (cursor !== null) q = q.where('record_id', '>', cursor);
    return (await q.execute()).map((r) => r.record_id);
  }
  let q = ctx.db.selectFrom('record_subjects').select('record_id').where('subject_id', '=', p.subjectId).orderBy('record_id').limit(RECORDS_BATCH);
  if (cursor !== null) q = q.where('record_id', '>', cursor);
  return (await q.execute()).map((r) => r.record_id);
}

/** `{recordIds}` and the authority scopes (see the top of this file). */
async function runRecords(ctx: JobContext, p: RecordsPayload): Promise<JobOutcome<ReindexPayload>> {
  const touch = !('recordIds' in p);
  if (touch && (await superseded(ctx, scopeOfPayload(p)))) return SUPERSEDED;
  let cursor: string | null = p.cursor ?? null;
  const slice = slicer(ctx);
  for (;;) {
    if (!slice.more()) return { continueWith: { ...p, cursor }, progress: 50 };
    const ids = await nextRecords(ctx, p, cursor);
    if (ids.length === 0) return { done: true };
    await withTx(ctx.handle, async (trx) => {
      await lockRecords(trx, ids);
      await indexRecords(trx, ids, ctx.now());
      // The OAI datestamp is read after the documents are built, right before COMMIT (C14): a harvest that read the old
      // one while this batch was open answered an earlier responseDate, so its next `from` still selects these.
      if (touch) await stampChanged(trx, ids, ctx.now());
      await changed(trx, ctx.jobId);
    });
    cursor = ids[ids.length - 1]!;
    slice.ran();
    await ctx.heartbeat();
  }
}

/**
 * The `catalog.reindex` handler (see the top of this file): permission `system.diagnostics.manage` (Diagnostik's
 * "Bangun ulang indeks"), `longRunning` (it holds `jobs:heavy`, so a slice never overlaps one of an import or a
 * migration), retryable from the API, and `interactive` (C26, as E22 made the migration and the export): where no worker
 * runs (Passenger/LiteSpeed, `external` mode) and the cron stopped, piggyback never takes a heavy job, so a page drives
 * it slice by slice (`POST jobs/:id/drive`: Diagnostik's JobProgress after "Bangun ulang indeks", which joins the
 * rebuild the boot queued after a restore, and the job's own page). It needs nothing of `deps`.
 */
export function reindexJob(deps: () => CatalogJobDeps): JobHandler<ReindexPayload> {
  void deps;
  return {
    type: 'catalog.reindex',
    permission: 'system.diagnostics.manage',
    retryable: 'api',
    longRunning: true,
    interactive: true,
    payload: reindexPayload,
    async run(ctx, payload) {
      if ('scope' in payload) return runAll(ctx, payload);
      return runRecords(ctx, payload);
    },
  };
}

/** The scope of an authority payload, without its checkpoint. */
function scopeOfPayload(p: RecordsPayload): ReindexScope {
  if ('agentId' in p) return { agentId: p.agentId };
  if ('subjectId' in p) return { subjectId: p.subjectId };
  if ('publisherId' in p) return { publisherId: p.publisherId };
  return { recordIds: p.recordIds };
}

/** The unique key of a scope: one live reindex per scope, none for a record list (each list is its own work). */
function uniqueKeyOf(scope: ReindexScope): string | undefined {
  if ('scope' in scope) return scope.scope === 'all' ? REINDEX_ALL_KEY : REINDEX_TERMS_KEY;
  if ('agentId' in scope) return `catalog.reindex:agent:${scope.agentId}`;
  if ('subjectId' in scope) return `catalog.reindex:subject:${scope.subjectId}`;
  if ('publisherId' in scope) return `catalog.reindex:publisher:${scope.publisherId}`;
  return undefined;
}

/** Whether a request of `scope` follows a change of what the index holds (see the top of this file). */
function afterChange(scope: ReindexScope, changed: boolean | undefined): boolean {
  if ('scope' in scope) return scope.scope === 'all' && changed === true;
  return !('recordIds' in scope);
}

/** Whether the job row `holder` has started: running, or queued with a checkpoint (or a payload this file never wrote). */
function hasStarted(holder: { status: string; payload: string }): boolean {
  if (holder.status !== 'queued') return true;
  try {
    const p = JSON.parse(holder.payload) as Record<string, unknown> | null;
    return typeof p !== 'object' || p === null || p['cursor'] !== undefined || p['phase'] !== undefined;
  } catch {
    return true;
  }
}

/**
 * Queues a `catalog.reindex` of `scope` in the caller's transaction `trx` (enqueue's rules, R37): with the unique key
 * `catalog.reindex:all`, `…:terms`, `…:agent:<id>`, `…:subject:<id>` or `…:publisher:<id>`; a `recordIds` list has no
 * key. A plain request joins a reindex of the same scope that is still queued or running (its id is returned,
 * `existing: true`). A request after a change (the authority scopes always, `all` with `o.changed`) joins only one that
 * has not started, and supersedes one that has (see the top of this file). The caller wakes the worker after the commit
 * (`rc.afterCommit(() => rc.services.jobs?.kick())`).
 *
 * @param registry a registry with the `catalog.reindex` handler (the runtime's, or one of {@link searchJobs})
 * @param o.changed `{scope: 'all'}` only: the caller changed data every record's document may hold, so a rebuild that
 *   has started does not cover it
 * @throws DomainError `VALIDATION_FAILED` for a scope the payload schema refuses (no record id, more than 1000, an id
 *   that is not a ULID); `TX_CONFLICT` when the key's holder changed between the locking read and enqueue's own read
 *   (MySQL/MariaDB's snapshot): withTx runs the transaction again; TypeError as enqueue
 */
export async function enqueueReindex(
  trx: Transaction<DB>,
  registry: JobRegistry,
  scope: ReindexScope,
  o: { now: number; keyring: readonly KeyringEntry[]; createdBy: string | null; changed?: boolean },
): Promise<{ jobId: string; existing: boolean }> {
  const uniqueKey = uniqueKeyOf(scope);
  const input = { type: 'catalog.reindex', payload: scope, createdBy: o.createdBy, ...(uniqueKey === undefined ? {} : { uniqueKey }) };
  if (uniqueKey === undefined || !afterChange(scope, o.changed)) {
    const { id, existing } = await enqueue(trx, registry, input, { now: o.now, keyring: o.keyring });
    return { jobId: id, existing };
  }
  const read = trx.selectFrom('jobs').select(['id', 'status', 'payload']).where('unique_key', '=', uniqueKey);
  const holder = await (fullTextFamily(trx) === 'fts5' ? read : read.forUpdate()).executeTakeFirst();
  if (holder !== undefined) {
    if (!hasStarted(holder)) return { jobId: holder.id, existing: true };
    await trx.updateTable('jobs').set({ unique_key: supersededKeyOf(holder.id), updated_at: o.now }).where('id', '=', holder.id).execute();
  }
  const { id, existing } = await enqueue(trx, registry, input, { now: o.now, keyring: o.keyring });
  if (existing) {
    throw new DomainError('TX_CONFLICT', {
      detail: 'Tugas indeks berubah selagi dibaca; transaksi diulang / The reindex job changed while it was read; the transaction is run again',
      meta: { attempts: 1, code: 'JOB_UNIQUE_KEY' },
    });
  }
  return { jobId: id, existing: false };
}

/** The search jobs (one list, so apps/server/src/jobs/catalog.ts and the housekeeping registry share it). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function searchJobs(deps: () => CatalogJobDeps): JobHandler<any>[] {
  return [reindexJob(deps)];
}
