import type { DB } from '@altis/db';
import { removeTree, runWorkDir } from '@altis/platform';
import { DomainError } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { RUN_WORK_KEEP_MS, attachRunJob, createRun, getRun } from '../../catalog/data/runs.js';
import type { CatalogJobDeps } from '../../catalog/jobs-deps.js';
import { errorFields, type CoreLogger, type TxCtx } from '../../context.js';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import { enqueue } from '../../jobs/enqueue.js';
import type { JobHandler, JobRegistry } from '../../jobs/types.js';
import { readSettings } from '../../settings/service.js';
import { slimsAnalyzeStage } from './analyze-stage.js';
import { slimsStagesOverride } from './factory.js';
import { closeAbandonedSlimsRun } from './ending.js';
import { assertTargetEmpty } from './guard.js';
import { parseSlimsRunSettings, type SlimsDbTarget, type SlimsRunSettings } from './options.js';
import {
  SLIMS_CATALOG_STAGES,
  SLIMS_MIGRATION_JOB,
  catalogSkippedStage,
  migrateSlimsPayload,
  runSlimsMigrationSlice,
  slimsSplitStage,
  type MigrateSlimsPayload,
} from './pipeline.js';
import { slimsReportStage } from './report-stage.js';
import type { SlimsStage } from './stage.js';
import { archiveStage } from './stages/archive.js';
import { attachmentsStage } from './stages/attachments.js';
import { contentStage } from './stages/content.js';
import { coversStage } from './stages/covers.js';
import { itemsStage } from './stages/items.js';
import { mastersStage } from './stages/masters.js';
import { recordsStage } from './stages/records.js';
import { relationsStage } from './stages/relations.js';
// ---- Komunitas (SLiMS members and circulation) ----
import { circulationStage, liveCirculationCount } from './stages/circulation.js';
import { membersStage } from './stages/members.js';
import { staffStage } from './stages/staff.js';
import { visitsStage } from './stages/visits.js';

// The SLiMS migration job `catalog.migrate_slims` and how a migration starts (Phase 2 spec §11.1–§11.3, §12.6;
// plan Task 23; decisions D2-25, D2-26; preflight S3, S13, M15).
//
// Starting (the route and the CLI share it, in the caller's transaction):
// - one migration at a time per installation: a live job holding the unique key `catalog.migrate_slims` is joined
//   (liveSlimsMigration, before the caller takes any upload); the start itself enqueues with that key, and a holder
//   committed meanwhile by another transaction is a TX_CONFLICT, whose re-run joins it;
// - a migration run left `queued` or `running` with no live job (a job cancelled before it ran, a crash before the
//   last attempt ended it) is ended first, as its job ended (endOrphanRuns): nothing works on it any more, and no run
//   adopts a run that did not succeed, so the caller removes its work folder after the COMMIT (releaseEndedRunWork,
//   C16: its dump, files zip and partial staging would otherwise hold DATA_DIR for 7 days, S2);
// - S3: `fromRunId` names a dry run of the same user, succeeded, finished less than 7 days ago and never adopted, else
//   `{path: 'fromRunId', code: 'not_found'}`; a dump dry run takes no source (`exclusive`), a database one the same
//   host, port and database again (`required`, `mismatch`). The dry run is marked adopted (`adoptedBy`) in the same
//   transaction by a compare-and-set on its options, so two adoptions never both pass; its folder is renamed after the
//   COMMIT (adoptRunWork, by the caller, and again by the job's first slice), and the job skips the split;
// - a real run applies the target guard (guard.ts); a dry run writes nothing into the catalogue and is not refused;
// - the run (`catalog_runs`, kind `migration`) with options that never hold the password, the job with the password
//   sealed in `secret_param` (cleared at its terminal status), and `catalog.migration.start` (`meta`: dryRun,
//   sourceKind, priceMode, sourceName, adoptedFrom).
//
// The catalogue re-sync: `catalogMode` (`append`, or `sync`) and `skipCatalog` are stored with the options. A real run
// that skips the catalogue stages must follow a sync dry run (`fromRunId`, taken over as above) that ran them and found
// no source record or copy new, changed or gone (`catalogChanges` 0 in its summary): without such a dry run the start
// is refused `{path: 'skipCatalog', code: 'dry_run_required'}`, and with changes found 422 MIGRATION_PRECHECK_FAILED
// `{reason: 'catalog_changed', count}`. The target guard still applies. A dry run may skip them without a precheck (it
// writes nothing, and its summary never qualifies a skip). A run that skips them keeps their place in its stage list
// (the job's payload counts stages by index), each replaced by catalogSkippedStage, and the run's end counts the rows of
// their tables that no other stage accounted for as skipped `catalog_skipped`, so the reconciliation balances.
//
// The CLI starts its runs as the `cli` actor, which has no user id: it takes over the dry runs it started itself
// (`created_by` null), and no one else's.

/** One migration at a time per installation (§11.2). */
export const SLIMS_MIGRATION_UNIQUE_KEY = 'catalog.migrate_slims';

/** The stages of a migration run in their order: the catalogue's, then members, staff, visits and circulation. */
export const SLIMS_STAGES: readonly SlimsStage[] = Object.freeze([
  slimsSplitStage,
  slimsAnalyzeStage,
  mastersStage,
  recordsStage,
  relationsStage,
  itemsStage,
  // ---- Komunitas (SLiMS members and circulation) ----
  membersStage,
  staffStage,
  visitsStage,
  circulationStage,
  attachmentsStage,
  coversStage,
  contentStage,
  archiveStage,
  slimsReportStage,
]);

/**
 * The stage list a run uses: SLIMS_STAGES, or the framework's own around a test's middle stages (test profile); with
 * `skipCatalog`, each catalogue stage in it replaced by catalogSkippedStage (its place kept, see the top of this file).
 */
export function slimsRunStages(o: { skipCatalog?: boolean } = {}): readonly SlimsStage[] {
  const middle = slimsStagesOverride();
  const stages = middle === null ? SLIMS_STAGES : Object.freeze([slimsSplitStage, slimsAnalyzeStage, ...middle, slimsReportStage]);
  if (o.skipCatalog !== true) return stages;
  return Object.freeze(stages.map((stage) => (SLIMS_CATALOG_STAGES.includes(stage.name) ? catalogSkippedStage(stage) : stage)));
}

type Db = Kysely<DB> | Transaction<DB>;

/**
 * The `catalog.migrate_slims` handler: permission `catalog.migration.run`, `longRunning` and `cpuHeavy` (it holds
 * `jobs:heavy`, so it never overlaps an import, an export or a reindex), retryable only by its origin, and interactive
 * (the Migrasi SLiMS screen drives it where no worker runs, as cron does). Each slice: pipeline.ts.
 */
export function migrateSlimsJob(deps: () => CatalogJobDeps): JobHandler<MigrateSlimsPayload> {
  return {
    type: SLIMS_MIGRATION_JOB,
    permission: 'catalog.migration.run',
    retryable: 'origin-only',
    interactive: true,
    longRunning: true,
    cpuHeavy: true,
    payload: migrateSlimsPayload,
    async run(ctx, payload) {
      const d = deps();
      const run = await getRun(ctx.db, payload.runId);
      if (run === null || run.kind !== 'migration') {
        d.log.warn('SLiMS migration: the job names no migration run', { jobId: ctx.jobId, runId: payload.runId });
        return { done: true, message: 'run missing' };
      }
      // A slice retried after the run ended (P7) has nothing left to do.
      if (run.status !== 'queued' && run.status !== 'running') return { done: true, message: run.status };
      const settings = parseSlimsRunSettings(run.options);
      return runSlimsMigrationSlice(ctx, payload, d, slimsRunStages({ skipCatalog: settings.skipCatalog === true }), run, settings);
    },
  };
}

/** The live migration (its job holds the unique key), or null. */
export async function liveSlimsMigration(db: Db): Promise<{ runId: string; jobId: string } | null> {
  const job = await db.selectFrom('jobs').select(['id', 'payload']).where('unique_key', '=', SLIMS_MIGRATION_UNIQUE_KEY).executeTakeFirst();
  if (job === undefined) return null;
  let runId: unknown;
  try {
    runId = (JSON.parse(job.payload) as { runId?: unknown }).runId;
  } catch {
    runId = null;
  }
  if (typeof runId !== 'string') throw new DomainError('STATE_CORRUPT', { detail: 'Tugas migrasi tanpa run / A migration job without its run', meta: { reason: 'migration_job' } });
  return { runId, jobId: job.id };
}

/**
 * Ends every migration run still `queued` or `running` (none of them has a live job: see the top of this file) as its
 * job ended: `cancelled` for a cancelled job (one cancelled while queued never ran its cancel), else `failed`; each with
 * the bookkeeping of ending.ts (C17: the search index, `catalog.migration.finish`).
 *
 * @returns the ids of the runs it ended (their work folders go after the COMMIT: releaseEndedRunWork)
 */
async function endOrphanRuns(trx: Transaction<DB>, now: number): Promise<string[]> {
  const orphans = await trx
    .selectFrom('catalog_runs as r')
    .leftJoin('jobs as j', 'j.id', 'r.job_id')
    .select(['r.id', 'r.job_id', 'r.dry_run', 'j.status as job_status'])
    .where('r.kind', '=', 'migration')
    .where('r.status', 'in', ['queued', 'running'])
    .execute();
  const endedIds: string[] = [];
  for (const r of orphans) {
    const status = r.job_status === 'cancelled' ? 'cancelled' : 'failed';
    const ended = await trx
      .updateTable('catalog_runs')
      .set({ status, finished_at: now })
      .where('id', '=', r.id)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (Number(ended.numUpdatedRows) === 0) continue;
    await closeAbandonedSlimsRun(trx, { runId: r.id, jobId: r.job_id, status, dryRun: Number(r.dry_run) === 1, now });
    endedIds.push(r.id);
  }
  return endedIds;
}

/**
 * After the COMMIT of a start: removes the work folder `tmp/<runId>/` of every run it ended (`endedRunIds`), best
 * effort, as the housekeeping ending does (C16, C17). Never rejects: a folder left behind is logged, and the housekeeping's
 * `work` phase takes it 7 days after the run's end (S2).
 */
export async function releaseEndedRunWork(dataDir: string, runIds: readonly string[], log: CoreLogger): Promise<void> {
  for (const runId of runIds) {
    await removeTree(runWorkDir(dataDir, runId)).catch((error: unknown) => {
      log.warn('SLiMS migration: the work folder of a run the start ended could not be removed', { runId, ...errorFields(error) });
    });
  }
}

function fieldError(path: string, code: string): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Permintaan migrasi tidak valid / The migration request is not valid',
    meta: { errors: [{ path, code }] },
  });
}

/** What a migration starts with (the route's body, or the CLI's flags, made concrete). */
export interface SlimsStartInput {
  dryRun: boolean;
  sourceKind: 'db' | 'dump';
  /** The database (without its password) of a `db` source; null for a dump. */
  db: SlimsDbTarget | null;
  /** The database password (sealed into the job's secret); null for a dump. */
  password: string | null;
  /** `tmp/<id>/upload.bin` holds the dump (a staged upload taken, or the CLI's copy); null otherwise. */
  dumpStagingId: string | null;
  files: 'zip' | 'dir' | null;
  filesStagingId: string | null;
  /** The CLI's `--files-dir`, its real path. */
  filesDir: string | null;
  branchId: string;
  priceMode: SlimsRunSettings['priceMode'];
  sourceName: string;
  allowNonEmpty: boolean;
  confirmLibraryName: string | null;
  /** S3: the dry run whose work this run takes over. */
  fromRunId: string | null;
  // ---- Komunitas K1 (catalogue re-sync) ----
  /** `append` when absent. */
  catalogMode?: 'append' | 'sync';
  /** Skip the catalogue stages (a real run: after a sync dry run that found no change). */
  skipCatalog?: boolean;
  // ---- Komunitas (SLiMS members and circulation) ----
  /** The member, visit and circulation options (each one's default when absent). */
  people?: SlimsRunSettings['people'];
}

/**
 * The checks on `fromRunId` (see the top of this file) for the staff user `userId` (null with `cli`: the CLI,
 * which takes over the dry runs it started itself).
 *
 * @returns the dry run's settings, its options text (for the compare-and-set), and the catalogue changes its summary
 *   counted (a sync dry run; null for any other)
 * @throws DomainError `VALIDATION_FAILED` at `fromRunId` (`not_found`) or `source` (`exclusive`, `required`, `mismatch`)
 */
export async function checkSlimsAdoption(
  db: Db,
  o: { fromRunId: string; userId: string | null; cli?: boolean; now: number; sourceKind: 'db' | 'dump' | null; db: SlimsDbTarget | null },
): Promise<{ settings: SlimsRunSettings; optionsText: string; catalogChanges: number | null; memberNoCollisions: number | null }> {
  const run = await getRun(db, o.fromRunId);
  const notFound = fieldError('fromRunId', 'not_found');
  if (
    run === null ||
    run.kind !== 'migration' ||
    Number(run.dry_run) !== 1 ||
    run.status !== 'succeeded' ||
    (o.userId === null && o.cli !== true) ||
    run.created_by !== o.userId ||
    run.finished_at === null ||
    Number(run.finished_at) <= o.now - RUN_WORK_KEEP_MS
  ) {
    throw notFound;
  }
  let settings: SlimsRunSettings;
  try {
    settings = parseSlimsRunSettings(run.options);
  } catch {
    throw notFound;
  }
  if (settings.adoptedBy !== undefined) throw notFound;
  if (settings.sourceKind === 'dump') {
    if (o.sourceKind !== null) throw fieldError('source', 'exclusive');
  } else {
    if (o.sourceKind !== 'db' || o.db === null) throw fieldError('source', 'required');
    const before = settings.db;
    if (before === null || before.host.toLowerCase() !== o.db.host.toLowerCase() || before.port !== o.db.port || before.database !== o.db.database) {
      throw fieldError('source', 'mismatch');
    }
  }
  return { settings, optionsText: run.options, catalogChanges: catalogChangesOf(run.summary), memberNoCollisions: countOf(run.summary, 'memberNoCollisions') };
}

/** A count `name` of a stored summary: a non-negative integer, or null when the summary has none. */
function countOf(summary: string, name: string): number | null {
  try {
    const n = (JSON.parse(summary) as Record<string, unknown> | null)?.[name];
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

// ---- Komunitas (SLiMS members and circulation) ----

/**
 * The prechecks of the member and circulation stages on a real run: a dry run taken over that found member numbers
 * colliding once normalised refuses it (they must be changed in SLiMS first: an old card would open the wrong member);
 * a `replace` of circulation is refused while ALTIS lends, takes holds or charges on its own.
 *
 * @throws DomainError 422 `MIGRATION_PRECHECK_FAILED {reason: 'member_no_collision', count}`, 409
 *   `MIGRATION_CIRCULATION_LIVE {count}`
 */
async function checkPeople(trx: Transaction<DB>, input: SlimsStartInput, adopted: { memberNoCollisions: number | null } | null): Promise<void> {
  const collisions = adopted?.memberNoCollisions ?? 0;
  if (collisions > 0) {
    throw new DomainError('MIGRATION_PRECHECK_FAILED', {
      detail:
        `Uji kering menemukan ${collisions} nomor anggota SLiMS yang bertabrakan setelah dinormalkan (member_no_collision); ubah nomornya di SLiMS lebih dulu / ` +
        `The dry run found ${collisions} SLiMS member numbers that collide once normalised (member_no_collision); change them in SLiMS first`,
      meta: { reason: 'member_no_collision', count: collisions },
    });
  }
  if (input.people?.circulationMode === 'replace') {
    const live = await liveCirculationCount(trx);
    if (live > 0) {
      throw new DomainError('MIGRATION_CIRCULATION_LIVE', {
        detail: `ALTIS sudah mencatat ${live} baris sirkulasi sendiri / ALTIS already holds ${live} circulation rows of its own`,
        meta: { count: live },
      });
    }
  }
}

/** `catalogChanges` of a stored summary: a non-negative integer, or null when the summary has none. */
function catalogChangesOf(summary: string): number | null {
  try {
    const n = (JSON.parse(summary) as { catalogChanges?: unknown } | null)?.catalogChanges;
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The precheck of a real run that skips the catalogue stages (see the top of this file), on the dry run it takes over.
 *
 * @throws DomainError `VALIDATION_FAILED {path: 'skipCatalog', code: 'dry_run_required'}`, 422
 *   `MIGRATION_PRECHECK_FAILED {reason: 'catalog_changed', count}`
 */
function checkSkipCatalog(adopted: { settings: SlimsRunSettings; catalogChanges: number | null } | null): void {
  if (adopted === null || adopted.settings.catalogMode !== 'sync' || adopted.settings.skipCatalog === true || adopted.catalogChanges === null) {
    throw fieldError('skipCatalog', 'dry_run_required');
  }
  const count = adopted.catalogChanges;
  if (count > 0) {
    throw new DomainError('MIGRATION_PRECHECK_FAILED', {
      detail:
        `Uji kering menemukan ${count} cantuman atau eksemplar SLiMS yang baru, berubah, atau hilang (catalog_changed); ` +
        'jalankan dengan mode katalog sync agar katalog ikut diselaraskan / ' +
        `The dry run found ${count} SLiMS records or copies that are new, changed or gone (catalog_changed); ` +
        'run with the catalogue mode sync so that the catalogue is re-synced too',
      meta: { reason: 'catalog_changed', count },
    });
  }
}

/**
 * Starts a migration in `tx` (see the top of this file): there must be no live migration (liveSlimsMigration first).
 * After the COMMIT the caller removes the work folders of the runs it ended (releaseEndedRunWork with `endedRunIds`),
 * renames the adopted dry run's folder (adoptRunWork) and wakes the runner.
 *
 * @returns the new run and its job, and the ids of the orphaned runs it ended
 * @throws DomainError `VALIDATION_FAILED` (S3, as checkSlimsAdoption; `branchId` `not_found`), `MIGRATION_TARGET_NOT_EMPTY`
 *   (a real run, guard.ts), `TX_CONFLICT` when another start committed a live migration meanwhile
 */
export async function startSlimsMigration(
  tx: TxCtx,
  registry: JobRegistry,
  input: SlimsStartInput,
  o: { keyring: readonly KeyringEntry[] },
): Promise<{ runId: string; jobId: string; endedRunIds: readonly string[] }> {
  const trx = tx.trx;
  const branch = await trx.selectFrom('branches').select('id').where('id', '=', input.branchId).where('archived_at', 'is', null).executeTakeFirst();
  if (branch === undefined) throw fieldError('branchId', 'not_found');
  let adopted: { settings: SlimsRunSettings; optionsText: string; catalogChanges: number | null; memberNoCollisions: number | null } | null = null;
  const skipCatalog = input.skipCatalog === true;
  if (skipCatalog && !input.dryRun && input.fromRunId === null) throw fieldError('skipCatalog', 'dry_run_required');
  if (input.fromRunId !== null) {
    adopted = await checkSlimsAdoption(trx, {
      fromRunId: input.fromRunId,
      userId: tx.actor.id,
      cli: tx.actor.type === 'cli',
      now: tx.now,
      sourceKind: adoptedSourceKind(input),
      db: input.db,
    });
  }
  if (skipCatalog && !input.dryRun) checkSkipCatalog(adopted);
  if (!input.dryRun) await checkPeople(trx, input, adopted);
  if (!input.dryRun) {
    const libraryName = String((await readSettings(trx, ['library.name'], []))['library.name']);
    await assertTargetEmpty(trx, { allowNonEmpty: input.allowNonEmpty, confirmLibraryName: input.confirmLibraryName, libraryName });
  }
  const endedRunIds = await endOrphanRuns(trx, tx.now);

  const sourceKind = adopted?.settings.sourceKind ?? input.sourceKind;
  const settings: SlimsRunSettings = {
    sourceKind,
    db: sourceKind === 'db' ? input.db : null,
    branchId: input.branchId,
    priceMode: input.priceMode,
    sourceName: input.sourceName,
    allowNonEmpty: input.allowNonEmpty,
    dumpStagingId: adopted === null ? input.dumpStagingId : null,
    // An adopted run keeps the dry run's files archive (in the folder it adopts).
    files: adopted === null ? input.files : adopted.settings.files === 'zip' ? 'zip' : null,
    filesStagingId: adopted === null ? input.filesStagingId : null,
    filesDir: adopted === null ? input.filesDir : null,
    adoptedFrom: input.fromRunId,
    catalogMode: input.catalogMode ?? 'append',
    skipCatalog,
    ...(input.people === undefined ? {} : { people: input.people }),
  };
  const runId = await createRun(tx, { kind: 'migration', dryRun: input.dryRun, format: null, options: settings });
  // A database source and an adopted dump start at `analyze` (S3: no split).
  const stage = sourceKind === 'db' || adopted !== null ? 1 : 0;
  const payload: MigrateSlimsPayload = { runId, stage, cursor: null };
  const queued = await enqueue(
    trx,
    registry,
    {
      type: SLIMS_MIGRATION_JOB,
      payload,
      uniqueKey: SLIMS_MIGRATION_UNIQUE_KEY,
      createdBy: tx.actor.type === 'staff' ? tx.actor.id : null,
      ...(sourceKind === 'db' && input.password !== null ? { secret: new TextEncoder().encode(input.password) } : {}),
    },
    { now: tx.now, keyring: o.keyring },
  );
  // A live migration committed by another transaction after this one began: the re-run joins it.
  if (queued.existing) throw new DomainError('TX_CONFLICT', { detail: 'Migrasi lain baru dimulai / Another migration just started' });
  await attachRunJob(trx, runId, queued.id);
  if (adopted !== null) {
    const marked = await trx
      .updateTable('catalog_runs')
      .set({ options: JSON.stringify({ ...adopted.settings, adoptedBy: runId }) })
      .where('id', '=', input.fromRunId!)
      .where('options', '=', adopted.optionsText)
      .executeTakeFirst();
    if (Number(marked.numUpdatedRows) !== 1) throw fieldError('fromRunId', 'not_found');
  }
  await tx.audit({
    action: 'catalog.migration.start',
    entity: 'catalog_runs',
    entityId: runId,
    meta: {
      dryRun: input.dryRun,
      sourceKind,
      priceMode: input.priceMode,
      sourceName: input.sourceName,
      adoptedFrom: input.fromRunId,
      ...(input.people === undefined ? {} : { membersMode: input.people.membersMode ?? 'append', circulationMode: input.people.circulationMode ?? 'append' }),
    },
  });
  return { runId, jobId: queued.id, endedRunIds };
}

/** The source kind the request names when it adopts a dry run (a dump is never named again: null). */
function adoptedSourceKind(input: SlimsStartInput): 'db' | 'dump' | null {
  if (input.sourceKind === 'db' && input.db !== null) return 'db';
  return input.dumpStagingId === null ? null : 'dump';
}
