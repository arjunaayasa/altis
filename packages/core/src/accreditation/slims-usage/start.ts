import { randomBytes } from 'node:crypto';
import type { DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { SlimsUsageStartBody } from '@altis/shared/api/accreditation';
import type { Transaction } from 'kysely';
import { attachRunJob, createRun, finishRun, type RunEnd } from '../../catalog/data/runs.js';
import { txCtx, type Actor } from '../../context.js';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import { enqueue } from '../../jobs/enqueue.js';
import { JOB_SECRET_MAX, type JobRegistry } from '../../jobs/types.js';
import type { AccredSettings } from '../../settings/accreditation.js';
import type { ImportSlimsUsagePayload } from './job.js';
import { slimsUsageRunSettings, type SlimsUsageRunSettings } from './settings.js';

// How a SLiMS usage import starts (`POST accreditation/periods/:id/slims-usage`, in the route's transaction): the
// period it is started from must exist; one import runs at a time per installation (a live import is joined: its job
// holds the unique key `accreditation.import_slims_usage`); an import left `queued` or `running` with no live job (one
// cancelled before it ran, or whose job died) is ended first, as its job ended, and its work folder goes after the
// COMMIT. The run (`catalog_runs`, kind `slims_usage`) keeps the options of slimsUsageRunSettings, with the repeat-visit
// window in force now; its job keeps, sealed in `secret_param` and dropped at its end, the key the member ids are
// hashed with (32 random bytes) and the database password. The usage rows are global (no period is locked).

/** One usage import at a time per installation. */
export const SLIMS_USAGE_UNIQUE_KEY = 'accreditation.import_slims_usage';

/** The import's job type. */
export const SLIMS_USAGE_JOB = 'accreditation.import_slims_usage';

/** A member type id the mapping may name (it becomes the row group `slims_type:<id>`). */
const TYPE_ID = /^[0-9A-Za-z_-]{1,36}$/;

/** What a start answers: the run and its job, whether they were a live import's, and the orphaned runs it ended. */
export interface SlimsUsageStarted {
  runId: string;
  jobId: string;
  /** True: an import was running, and this is it. */
  joined: boolean;
  /** The runs this start ended (their work folders go after the COMMIT). */
  endedRunIds: readonly string[];
}

/** Where the import reads from, as its job's payload keeps it (no password: that is in the job's secret). */
export type UsageSourceRef =
  | { kind: 'db'; host: string; port: number; user: string; database: string; tls: boolean }
  | { kind: 'dump'; uploadId: string };

/** The job's secret: the hash key (base64 of 32 bytes) and, for a database, its password. */
export interface UsageSecret {
  hashKey: string;
  password?: string;
}

const SYSTEM: Actor = { type: 'system', id: null, ip: null };

function fieldError(path: string, code: string): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Permintaan impor penggunaan tidak valid / The usage import request is not valid',
    meta: { errors: [{ path, code }] },
  });
}

/** The live import (its job holds the unique key), or null. */
async function liveImport(trx: Transaction<DB>): Promise<{ runId: string; jobId: string } | null> {
  const job = await trx.selectFrom('jobs').select(['id', 'payload']).where('unique_key', '=', SLIMS_USAGE_UNIQUE_KEY).executeTakeFirst();
  if (job === undefined) return null;
  let runId: unknown;
  try {
    runId = (JSON.parse(job.payload) as { runId?: unknown }).runId;
  } catch {
    runId = null;
  }
  if (typeof runId !== 'string') throw new DomainError('STATE_CORRUPT', { detail: 'Tugas impor tanpa run / An import job without its run', meta: { reason: 'usage_import_job' } });
  return { runId, jobId: job.id };
}

/**
 * The end of an import run nobody works on any more (its job was cancelled before it ran, or died): the finish entry
 * the import's own end would have written, by the system actor, in `trx`.
 */
export async function closeAbandonedUsageRun(trx: Transaction<DB>, o: { runId: string; status: RunEnd; now: number }): Promise<void> {
  await txCtx(trx, o.now, SYSTEM).audit({
    action: 'accreditation.slims_usage.finish',
    entity: 'catalog_runs',
    entityId: o.runId,
    meta: { status: o.status, months: 0, rows: 0 },
  });
}

/** Ends every import run still `queued` or `running` (none has a live job when this runs). */
async function endOrphanRuns(trx: Transaction<DB>, now: number): Promise<string[]> {
  const orphans = await trx
    .selectFrom('catalog_runs as r')
    .leftJoin('jobs as j', 'j.id', 'r.job_id')
    .select(['r.id', 'r.summary', 'j.status as job_status'])
    .where('r.kind', '=', 'slims_usage')
    .where('r.status', 'in', ['queued', 'running'])
    .execute();
  const ended: string[] = [];
  for (const r of orphans) {
    const status: RunEnd = r.job_status === 'cancelled' ? 'cancelled' : 'failed';
    let summary: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(r.summary);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) summary = parsed as Record<string, unknown>;
    } catch {
      summary = {};
    }
    if (!(await finishRun(trx, r.id, { status, summary }, now))) continue;
    await closeAbandonedUsageRun(trx, { runId: r.id, status, now });
    ended.push(r.id);
  }
  return ended;
}

/**
 * Starts a usage import from period `periodId` in `trx` (see the top of this file). The route takes a dump's upload
 * after this, in the same transaction, unless the answer is a joined live import.
 *
 * @throws DomainError `NOT_FOUND` (no such period), `VALIDATION_FAILED` (`memberTypeGroups.<id>`: `invalid`, a type id
 *   that cannot name a row group), `TX_CONFLICT` (another start committed a live import meanwhile)
 */
export async function startSlimsUsageImport(
  trx: Transaction<DB>,
  periodId: string,
  body: SlimsUsageStartBody,
  o: { now: number; createdBy: string; registry: JobRegistry; keyring: readonly KeyringEntry[]; settings: AccredSettings },
): Promise<SlimsUsageStarted> {
  const period = await trx.selectFrom('accred_periods').select('id').where('id', '=', periodId).where('archived_at', 'is', null).executeTakeFirst();
  if (period === undefined) throw new DomainError('NOT_FOUND', { detail: 'Periode akreditasi tidak ditemukan / Accreditation period not found' });
  const live = await liveImport(trx);
  if (live !== null) return { ...live, joined: true, endedRunIds: [] };
  for (const id of Object.keys(body.memberTypeGroups ?? {})) {
    if (!TYPE_ID.test(id)) throw fieldError(`memberTypeGroups.${id}`, 'invalid');
  }
  const endedRunIds = await endOrphanRuns(trx, o.now);

  const source = body.source;
  const options: SlimsUsageRunSettings = slimsUsageRunSettings.parse({
    sourceKind: source.kind,
    periodId,
    cutoverOn: body.cutoverOn ?? null,
    ...(body.memberTypeGroups === undefined ? {} : { memberTypeGroups: body.memberTypeGroups }),
    ...(body.unknownMemberGroup === undefined ? {} : { unknownMemberGroup: body.unknownMemberGroup }),
    dedupeMinutes: o.settings.dedupeMinutes,
  });
  const staff: Actor = { type: 'staff', id: o.createdBy, ip: null };
  const runId = await createRun(txCtx(trx, o.now, staff), { kind: 'slims_usage', dryRun: false, format: null, options });

  const ref: UsageSourceRef =
    source.kind === 'db'
      ? { kind: 'db', host: source.db.host, port: source.db.port, user: source.db.user, database: source.db.database, tls: source.db.tls }
      : { kind: 'dump', uploadId: source.uploadId };
  const secret: UsageSecret = { hashKey: randomBytes(32).toString('base64'), ...(source.kind === 'db' ? { password: source.db.password } : {}) };
  const sealed = new TextEncoder().encode(JSON.stringify(secret));
  if (sealed.byteLength > JOB_SECRET_MAX) throw new TypeError('the usage import secret is too large');
  const payload: ImportSlimsUsagePayload = { runId, phase: source.kind === 'dump' ? 'split' : 'members', cursor: null, state: { source: ref, seq: 0 } };
  const queued = await enqueue(trx, o.registry, { type: SLIMS_USAGE_JOB, payload, uniqueKey: SLIMS_USAGE_UNIQUE_KEY, createdBy: o.createdBy, secret: sealed }, { now: o.now, keyring: o.keyring });
  sealed.fill(0);
  // A live import committed by another transaction after this one began: the re-run joins it.
  if (queued.existing) throw new DomainError('TX_CONFLICT', { detail: 'Impor lain baru dimulai / Another import just started' });
  await attachRunJob(trx, runId, queued.id);
  return { runId, jobId: queued.id, joined: false, endedRunIds };
}
