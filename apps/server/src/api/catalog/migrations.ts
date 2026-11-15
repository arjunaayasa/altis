import {
  SLIMS_STAGES,
  createJobRegistry,
  liveSlimsMigration,
  markSlimsCutoverStep,
  slimsCutover,
  placeSlimsWork,
  releaseEndedRunWork,
  slimsSources,
  startSlimsMigration,
  takeStagedUpload,
  uploadOwner,
  type SlimsSource,
} from '@altis/core';
import { runWorkDir, statOrNull } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { SlimsCutoverStepBody, SlimsStartBody, SlimsTestBody, type SlimsCutoverView, type SlimsTestResponse } from '@altis/shared/api/catalog/migration';
import type { RunStarted } from '@altis/shared/api/catalog/runs';
import { route, type RouteDecl } from '../../http/route.js';
import { jobHandlers } from '../../jobs/runtime.js';

// The catalog API routes of the SLiMS migration (Phase 2 spec §11.1–§11.2, §12.2, §12.3; plan Task 23; decisions
// P2-17, D2-25; preflight S3, S13). Both are `catalog.migration.run` (a super admin's only: admin lacks it, K2) with a
// re-authentication within 5 minutes, and `idempotency: none`: their bodies carry a database password, which reaches
// nothing but the source (the test) or the job's sealed `secret_param` (the start).
//
// - `catalog.migrations.slims.test` (`mode: read`, `tx: self`: it connects outward, never inside a transaction):
//   opens the database through the source factory, lists its tables and detects the version. Always 200 (P2-17):
//   `{ok: true, version, tables, missing}`, or `{ok: false, code, reason}` with `MIGRATION_SOURCE_UNREACHABLE` (the
//   reason is the failure's code, never its message) or `MIGRATION_SOURCE_UNSUPPORTED` (a source that looks like
//   neither SLiMS 8 nor 9). `tables` lists the tables the migration reads that the source has, with their rows (-1
//   when the source does not know them).
// - `catalog.migrations.slims.start`: a live migration is joined (200 `{runId, jobId, joined: true}`, its start entry
//   counted once per actor); otherwise the staged uploads of the caller are taken (a dump's `source.uploadId`,
//   `filesUploadId`), startSlimsMigration creates the run and the job and audits `catalog.migration.start`, and 201
//   `{runId, jobId}`. With `fromRunId` (S3) `prepare` checks that the dry run's work folder is still there, and after
//   the COMMIT the folder is renamed to the new run's, and the taken uploads are moved into it (C25: their upload
//   sessions are gone, so only the run's id protects them from the files cleanup while the job waits); the job's first
//   slice does both again if this was lost. Before that, the hook removes the work folders of the orphaned runs the
//   start ended (C16, C17: a job cancelled while queued, or dead).

const API = '/api/v1/catalog/migrations/slims';
/** The connection test's connect timeout (§11.1: 10 s). */
const CONNECT_TIMEOUT_MS = 10_000;
/** A failure reason shown to the admin: a short code. */
const REASON = /^[A-Za-z0-9_.:-]{1,100}$/;

function fieldError(path: string, code: string): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Permintaan migrasi tidak valid / The migration request is not valid',
    meta: { errors: [{ path, code }] },
  });
}

/** Why a connection failed, as a code: the DomainError's `meta.reason`, else the error's code, else `unreachable`. */
function reasonOf(error: unknown): string {
  const meta = isDomainError(error) ? (error.meta as { reason?: unknown } | undefined) : undefined;
  if (typeof meta?.reason === 'string' && REASON.test(meta.reason)) return meta.reason;
  const c = (error as { code?: unknown } | null)?.code;
  if (typeof c === 'string' && REASON.test(c) && !(isDomainError(error) && c === 'MIGRATION_SOURCE_UNREACHABLE')) return c;
  return 'unreachable';
}

const testConnection = route({
  id: 'catalog.migrations.slims.test',
  method: 'POST',
  path: `${API}/test-connection`,
  permission: 'catalog.migration.run',
  reauth: true,
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: SlimsTestBody,
  handler: async (rc) => {
    const { kind, ...db } = rc.body.source;
    void kind;
    let source: SlimsSource | null = null;
    let body: SlimsTestResponse;
    try {
      source = await slimsSources().openDbSource(db, { connectTimeoutMs: CONNECT_TIMEOUT_MS });
      const tables = await source.tables();
      const info = slimsSources().detectSlimsVersion(tables);
      const reads = new Set(SLIMS_STAGES.flatMap((s) => s.reads));
      const listed = tables
        .filter((t) => reads.has(t.name))
        .map((t) => ({ name: t.name, rows: t.rows ?? -1 }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      body =
        info.version === 'unknown'
          ? {
              ok: false,
              code: 'MIGRATION_SOURCE_UNSUPPORTED',
              reason: 'not_slims',
              version: info.version,
              tables: listed,
              missing: [...info.missing],
            }
          : { ok: true, version: info.version, tables: listed, missing: [...info.missing] };
    } catch (error) {
      const unsupported = isDomainError(error) && error.code === 'MIGRATION_SOURCE_UNSUPPORTED';
      body = { ok: false, code: unsupported ? 'MIGRATION_SOURCE_UNSUPPORTED' : 'MIGRATION_SOURCE_UNREACHABLE', reason: reasonOf(error) };
    } finally {
      await source?.close().catch(() => undefined);
    }
    return { body };
  },
});

const start = route({
  id: 'catalog.migrations.slims.start',
  method: 'POST',
  path: API,
  permission: 'catalog.migration.run',
  reauth: true,
  idempotency: 'none',
  audit: 'catalog.migration.start',
  body: SlimsStartBody,
  prepare: async (rc) => {
    // S3: a dry run whose work folder is gone (expired, adopted already) cannot be taken over.
    const from = rc.body.fromRunId;
    if (from !== undefined && (await statOrNull(runWorkDir(rc.services.dataDir, from)))?.kind !== 'dir') throw fieldError('fromRunId', 'not_found');
  },
  handler: async (rc) => {
    const tx = rc.tx();
    const dataDir = rc.services.dataDir;
    const live = await liveSlimsMigration(tx.trx);
    if (live !== null) {
      // One migration at a time (§11.2): the live one is the answer, and its start is audited once per actor.
      if (!(await rc.auditedBefore({ entity: 'catalog_runs', entityId: live.runId }))) {
        await rc.audit({ entity: 'catalog_runs', entityId: live.runId, meta: { joined: true } });
      }
      const body: RunStarted & { joined: true } = { ...live, joined: true };
      return { status: 200, body };
    }
    const userId = rc.auth?.subjectId;
    if (userId === undefined) throw new DomainError('AUTH_REQUIRED');
    const b = rc.body;
    const take = async (uploadId: string, context: 'slims.dump' | 'slims.files', path: string): Promise<string> => {
      try {
        await takeStagedUpload(tx.trx, { uploadId, owner: uploadOwner(userId), context, dataDir });
      } catch (error) {
        if (isDomainError(error) && error.code === 'NOT_FOUND') throw fieldError(path, 'not_found');
        throw error;
      }
      return uploadId;
    };
    const dumpStagingId = b.source?.kind === 'dump' ? await take(b.source.uploadId, 'slims.dump', 'source.uploadId') : null;
    const filesStagingId = b.filesUploadId === undefined ? null : await take(b.filesUploadId, 'slims.files', 'filesUploadId');
    const db = b.source?.kind === 'db' ? b.source : null;
    const registry = rc.services.jobs?.registry ?? createJobRegistry(jobHandlers());
    const started = await startSlimsMigration(
      tx,
      registry,
      {
        dryRun: b.dryRun,
        sourceKind: b.source?.kind ?? 'dump',
        db: db === null ? null : { host: db.host, port: db.port, user: db.user, database: db.database, tls: db.tls },
        password: db?.password ?? null,
        dumpStagingId,
        files: filesStagingId === null ? null : 'zip',
        filesStagingId,
        filesDir: null,
        branchId: b.branchId,
        priceMode: b.priceMode,
        sourceName: b.sourceName,
        allowNonEmpty: b.allowNonEmpty,
        confirmLibraryName: b.confirmLibraryName ?? null,
        fromRunId: b.fromRunId ?? null,
        // ---- Komunitas K1 (catalogue re-sync): startSlimsMigration's precheck refuses a skip without a qualifying
        // sync dry run (`skipCatalog` `dry_run_required`, or MIGRATION_PRECHECK_FAILED `catalog_changed`).
        ...(b.catalogMode === undefined ? {} : { catalogMode: b.catalogMode }),
        ...(b.skipCatalog === undefined ? {} : { skipCatalog: b.skipCatalog }),
        // ---- Komunitas (SLiMS members and circulation): a real run is refused while the dry run it takes over found
        // member numbers that collide (MIGRATION_PRECHECK_FAILED `member_no_collision`), and a `replace` of circulation
        // once ALTIS lends on its own (MIGRATION_CIRCULATION_LIVE).
        ...(b.people === undefined ? {} : { people: b.people }),
      },
      { keyring: rc.config.keyring },
    );
    rc.afterCommit(async () => {
      try {
        // The orphaned runs the start ended free their folders first (C16, C17): the new run's split needs the space.
        await releaseEndedRunWork(dataDir, started.endedRunIds, rc.log);
        // The run's input in its folder at once (S3, C25): the first slice may wait for hours (jobs:heavy, no cron).
        await placeSlimsWork(dataDir, started.runId, { fromRunId: b.fromRunId ?? null, dumpStagingId, filesStagingId });
      } finally {
        rc.services.jobs?.kick();
      }
    });
    const body: RunStarted = { runId: started.runId, jobId: started.jobId };
    return { status: 201, body };
  },
});

// ---- Komunitas (SLiMS members and circulation) ----
// The cut-over checklist of the move from SLiMS (core migration/slims/cutover.ts): what holds "Mulai melayani" back, and
// an item marked done (`reprint_opened`: the reprint list was opened; `serve`: the library serves in ALTIS from now
// on, refused 422 MIGRATION_PRECHECK_FAILED `cutover_incomplete` while a required item does not hold).

const cutoverView = route({
  id: 'catalog.migrations.slims.cutover',
  method: 'GET',
  path: `${API}/cutover`,
  permission: 'catalog.migration.run',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const body: SlimsCutoverView = await slimsCutover(rc.db.db);
    return { body };
  },
});

const cutoverStep = route({
  id: 'catalog.migrations.slims.cutover_step',
  method: 'POST',
  path: `${API}/cutover/steps`,
  permission: 'catalog.migration.run',
  reauth: true,
  idempotency: 'none',
  audit: 'catalog.migration.cutover',
  body: SlimsCutoverStepBody,
  handler: async (rc) => {
    const body: SlimsCutoverView = await markSlimsCutoverStep(rc.tx(), rc.body.step);
    return { body };
  },
});

export const MIGRATION_ROUTES: RouteDecl[] = [testConnection, start, cutoverView, cutoverStep];
