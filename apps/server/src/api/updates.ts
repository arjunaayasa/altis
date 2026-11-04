import {
  beginRollback,
  candidateOf,
  checkOfChannel,
  enqueueUpdateCheck,
  offeredUpdate,
  readPackageManifest,
  readSettings,
  releaseSourceMode,
  rollbackAvailability,
  rollbackUnavailable,
  stagedUploadFile,
  throwPrecheck,
  updateCheckThrottle,
  uploadOwner,
  writeSettings,
  type Candidate,
  type OpStatus,
  type PrecheckReport,
  type StoredUpdateCheck,
  type UpdateParams,
} from '@altis/core';
import type { FeedEntry } from '@altis/crypto/feed';
import { dataPath, parseCurrentState, readJsonWithBak, type CurrentState } from '@altis/platform';
import { DomainError, compareSemver, isSemver } from '@altis/shared';
import {
  ChannelBody,
  SERVING_HEADER,
  UPDATE_HISTORY_PAGE_DEFAULT,
  UpdateApplyBody,
  UpdateHistoryQuery,
  UpdateUploadBody,
  type ChannelResponse,
  type ReleaseLogView,
  type UpdateChannel,
  type UpdateCheckResponse,
  type UpdateHistoryResponse,
  type UpdateOpResponse,
  type UpdateStatusView,
  type UpdateUploadDryRun,
  type UpdatesView,
} from '@altis/shared/api/updates';
import { issueOpsCookie } from '../http/ops-auth.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { loggableError } from '../safe-error.js';
import { appPrecheck } from '../services.js';

// The updates routes of Task 28 (spec §9.6-9.8, §13.5 "Update", §13.3 Pembaruan; route catalog `updates.*`; decisions
// D1d-11, D1d-30, D1d-31; preflight B5, S20, 1D-12, 1D-23). Every one is `mode: 'system'` (an edition's gate never
// keeps an install from its updates) and has no idempotency but the channel's.
//
//   GET  updates           `system.update.read`: UpdatesView: the running release, the channel, the last check and the
//                          release it found for this channel (newer than the running one), its prechecks as they stand
//                          (nothing written: the free space is proven when the update begins), the manual rollback's
//                          availability (§9.7), the pin, image mode (§9.8), whether a feed is configured (`onlineCheck`:
//                          none, online checks are off), the update or rollback op, a blocked bundled release
//   POST updates/check     `system.update.read`, `tx: 'self'`: at most once per 60 s (`update.check.at`, else 429
//                          UPDATE_CHECK_THROTTLED with Retry-After); the `update.check` job queued (a live one joined),
//                          then woken (worker mode) or driven here for one slice of at most 10 s (external mode) → 202
//   POST updates/apply     `system.update.run`, reauth, `tx: 'self'`: the version must be the one the last check of this
//                          channel found (else 404 UPDATE_NONE); the prechecks again, the free space proven; the `update`
//                          op begun with `{source: 'feed', entry}` and its `altis_ops` cookie → {opId}. The op writes
//                          `update.apply` when it ends (C25)
//   GET  updates/status    `opsAuth`, `restore-allow`: UpdateStatusView from op.json and current.json only (no table),
//                          `serving: 'server'` and `X-Altis-Serving: server` (S20). 1d Task 29: while no op runs (none,
//                          or it ended) also `bundledBlocked` (bundledBlockedOf: a settings read, never during a
//                          restore, null when it fails)
//   POST updates/upload    `system.update.run`, reauth, `tx: 'self'` (D1d-31, B5): the completed `update` upload of the
//                          caller is read where it is staged (never taken here), its signed manifest verified with the
//                          installation's keys, its prechecks run. `dryRun` → UpdateUploadDryRun, the upload untouched;
//                          else the refusal of a failed precheck, or the op begun with `{source: 'upload', uploadId,
//                          uploadBy, target}` (its `checking` step takes the caller's upload, review L11) → {opId}.
//                          One `update.upload` entry each
//   POST updates/rollback  `system.update.run`, reauth, `tx: 'self'`: the `rollback` op begun (409 ROLLBACK_UNAVAILABLE
//                          with its reason otherwise) and stepped once here → {opId}; the op writes `update.rollback`
//   PUT  updates/channel   `system.update.run`, `idempotency: store`: `update.channel`; audit `update.channel`
//                          {channel, previous}. The next check reads that channel's feed, with its own seq (1D-12)
//   GET  updates/history   `system.update.read`: `releases_log`, newest first, keyset paging on the id
//
// In image mode (`ALTIS_RELEASE_SOURCE=image`, §9.8: nothing is installed into DATA_DIR/releases, every new release is a
// new image) apply, upload and rollback answer 409 UPDATE_HIDDEN reason `image` before anything else (1D-23).
//
// The ops machine and the files are never touched inside a re-runnable transaction (R37, D3): the writes are
// `tx: 'self'`, with `rc.withTx` only around the queueing of the check.

const UPDATES = '/api/v1/updates';
const NO_STORE = { 'Cache-Control': 'no-store' };
/** What `updates/status` answers with besides NO_STORE: the server, not app.js, answered (S20). */
const SERVED = { ...NO_STORE, [SERVING_HEADER]: 'server' };
/** `POST updates/check` drives the queued check for at most this long in external mode (P9). */
export const UPDATE_CHECK_DRIVE_MS = 10_000;
/** `POST updates/rollback` steps its op for at most this long (pointers only: the checkpoint, then the flip). */
export const ROLLBACK_STEP_MS = 10_000;

/** The staff user of the request (every route but `updates.status` is a permission route, so step 9 found one). */
function subjectOf(rc: RouteContext<unknown, unknown, unknown>): string {
  if (rc.auth === null) throw new DomainError('AUTH_REQUIRED');
  return rc.auth.subjectId;
}

/** The app folder (`bundled-release/<v>` lives there), or '' for an app made without one. */
function appRootOf(rc: RouteContext<unknown, unknown, unknown>): string {
  return rc.services.install.appRoot ?? '';
}

/** Where this installation's releases come from (§9.8): `image` when ALTIS_RELEASE_SOURCE says so. */
function sourceModeOf(rc: RouteContext<unknown, unknown, unknown>): 'data' | 'image' {
  return releaseSourceMode(rc.services.configWriter.env);
}

/** 409 UPDATE_HIDDEN in image mode (§9.8, 1D-23): apply, upload and rollback install nothing into DATA_DIR/releases. */
function refuseInImageMode(rc: RouteContext<unknown, unknown, unknown>): void {
  if (sourceModeOf(rc) !== 'image') return;
  throw new DomainError('UPDATE_HIDDEN', {
    detail:
      'ALTIS berjalan dari image Docker: perbarui dengan docker compose pull && docker compose up -d / ' +
      'ALTIS runs from a Docker image: update with docker compose pull && docker compose up -d',
    meta: { reason: 'image' },
  });
}

/**
 * `releases/current.json` (read without its lock: a rename is atomic), or null when it is missing or cannot be used
 * (the bootloader writes and repairs it; Diagnostik reports it).
 */
async function readCurrent(rc: RouteContext<unknown, unknown, unknown>): Promise<CurrentState | null> {
  try {
    return await readJsonWithBak(dataPath(rc.services.dataDir, 'releases', 'current.json'), parseCurrentState);
  } catch (error) {
    rc.log.warn('updates: releases/current.json could not be read', { error: loggableError(error) });
    return null;
  }
}

/**
 * `update.bundled_blocked` as shown: only while its version is SemVer-newer than the running release `version`. The
 * record stays once that release was installed another way (one click, an offline upload; only the bundled update
 * clears it), so a release not newer is not reported (review L10: `GET updates` as `updates/status` and the dashboard).
 */
function blockedNewer(blocked: { version: string; failures: string[] } | null, version: string): UpdatesView['bundledBlocked'] {
  if (blocked === null || !isSemver(blocked.version) || !isSemver(version)) return null;
  return compareSemver(blocked.version, version) > 0 ? { version: blocked.version, failures: [...blocked.failures] } : null;
}

/**
 * 1d Task 29: `update.bundled_blocked` for `updates/status` and `/admin/_update` while no op runs: a newer bundled release
 * whose prechecks failed (§9.8 rows 2 and 3), or null (none; a release not newer than the installed one, installed
 * since; a restore under way, whose tables may be gone; a database that cannot be read, which the page must survive).
 * 1d review C16: newer than current.json's `active` (the running release's version when it cannot be read): a
 * schemaHold release whose prechecks failed runs as the blocked release itself, while `active` stays the one it left.
 */
export async function bundledBlockedOf(rc: RouteContext<unknown, unknown, unknown>): Promise<UpdateStatusView['bundledBlocked']> {
  if (rc.services.opsFence?.restoreInProgress() === true) return null;
  try {
    const blocked = await rc.services.settings.get<{ version: string; failures: string[] } | null>(rc.db.db, 'update.bundled_blocked');
    // 1d review C16: newer than current.json's `active` (the running release's version when it cannot be read).
    return blockedNewer(blocked, (await readCurrent(rc))?.active.version ?? rc.services.version);
  } catch (error) {
    rc.log.warn('updates: update.bundled_blocked could not be read', { error: loggableError(error) });
    return null;
  }
}

/**
 * The stored check's entry if it is for `channel`, newer than the running release and its feed still fresh at the
 * request's time (review C07, §9.6: core offeredUpdate); else null.
 */
function offered(rc: RouteContext<unknown, unknown, unknown>, check: StoredUpdateCheck | null, channel: UpdateChannel): FeedEntry | null {
  return offeredUpdate(check, channel, rc.services.version, rc.now);
}

/** The candidate a feed entry describes (extraction checks these against the signed manifest, §9.6). */
function candidateOfEntry(e: FeedEntry): Candidate {
  return {
    version: e.version,
    releasedAt: e.releasedAt,
    bootProtocol: e.bootProtocol,
    minUpgradeFrom: e.minUpgradeFrom,
    minCodeVersionAfter: e.minCodeVersionAfter,
    minNode: e.minNode,
    minDb: { mysql: e.minDb.mysql, mariadb: e.minDb.mariadb, postgres: e.minDb.postgres },
    size: e.size,
  };
}

/** The prechecks of `c` for the running release, as the update op runs them (services appPrecheck). */
function precheckOf(rc: RouteContext<unknown, unknown, unknown>, c: Candidate, o: { proveHeadroom?: boolean } = {}): Promise<PrecheckReport> {
  return appPrecheck({ dataDir: rc.services.dataDir, h: rc.db, edition: rc.services.edition, version: rc.services.version }, c, o);
}

/** The update settings `GET updates` and `POST updates/apply` read. */
async function updateSettings(rc: RouteContext<unknown, unknown, unknown>): Promise<{ channel: UpdateChannel; check: StoredUpdateCheck | null }> {
  const s = await readSettings(rc.db.db, ['update.channel', 'update.check'], []);
  const channel = s['update.channel'] as UpdateChannel;
  // 1d review L14: the check of the channel in force only (one of another channel neither offers nor throttles).
  return { channel, check: checkOfChannel(s['update.check'] as StoredUpdateCheck | null, channel) };
}

/** Begins the `update` op with `params`, sets its `altis_ops` cookie, and wakes a worker loop (it steps the op). */
async function beginUpdate(rc: RouteContext<unknown, unknown, unknown>, params: UpdateParams): Promise<UpdateOpResponse> {
  const handle = await rc.services.ops.begin('update', { type: 'staff', id: subjectOf(rc) }, params);
  issueOpsCookie(rc.c, handle);
  rc.services.jobs?.kick();
  return { opId: handle.opId };
}

const get = route({
  id: 'updates.get',
  method: 'GET',
  path: UPDATES,
  permission: 'system.update.read',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  async handler(rc) {
    const { services } = rc;
    const mode = sourceModeOf(rc);
    const s = await readSettings(rc.db.db, ['update.channel', 'update.check', 'update.bundled_blocked'], []);
    const channel = s['update.channel'] as UpdateChannel;
    // 1d review L14: a check of another channel (before a channel change) says nothing of this one.
    const check = checkOfChannel(s['update.check'] as StoredUpdateCheck | null, channel);
    const blocked = s['update.bundled_blocked'] as { version: string; failures: string[] } | null;
    const entry = offered(rc, check, channel);
    const state = await readCurrent(rc);
    let rollback: UpdatesView['rollback'];
    if (mode === 'image') rollback = { available: false, reason: 'image', target: state?.previous?.version ?? null };
    else if (state === null) rollback = { available: false, reason: 'no_previous', target: null };
    else rollback = await rollbackAvailability(services.dataDir, state, appRootOf(rc));
    const status: OpStatus | null = await services.ops.current();
    const body: UpdatesView = {
      current: { version: services.version, appJs: services.appJsVersion, bootProtocol: 1 },
      channel,
      check: check === null ? null : { at: check.at, ok: check.ok, error: check.error },
      available:
        entry === null || check === null
          ? null
          : { version: entry.version, releasedAt: entry.releasedAt, notesUrl: entry.notesUrl, steppingStone: check.steppingStone, latest: check.latest },
      precheck: entry === null ? null : await precheckOf(rc, candidateOfEntry(entry), { proveHeadroom: false }),
      rollback,
      pinned: state?.pinned ?? null,
      oneClick: mode === 'data',
      dockerPull: mode === 'image' || services.runtime === 'docker',
      onlineCheck: services.updates.source.feedConfigured(),
      op: status !== null && (status.kind === 'update' || status.kind === 'rollback') ? status : null,
      bundledBlocked: blockedNewer(blocked, state?.active.version ?? services.version), // review L10, C16
    };
    return { body, headers: NO_STORE };
  },
});

const check = route({
  id: 'updates.check',
  method: 'POST',
  path: `${UPDATES}/check`,
  permission: 'system.update.read',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  async handler(rc) {
    const subject = subjectOf(rc);
    const { check: last } = await updateSettings(rc);
    const wait = updateCheckThrottle(last?.at ?? null, rc.now);
    if (wait !== null) {
      throw new DomainError('UPDATE_CHECK_THROTTLED', {
        detail: `Pembaruan baru saja diperiksa; coba lagi dalam ${wait} detik / Updates were just checked; try again in ${wait} seconds`,
        meta: { retryAfterS: wait },
      });
    }
    const job = await rc.withTx((tx) => enqueueUpdateCheck(tx.trx, { reason: 'manual', now: rc.now, createdBy: subject }));
    const jobs = rc.services.jobs;
    if (jobs !== null && jobs.mode === 'worker') jobs.kick();
    else if (jobs !== null && !rc.services.retired) {
      // External mode: the check runs now, in this request (P9: one slice), rather than at the next cron call. Its
      // failure stays the job's (it is tried again), never this answer's.
      try {
        await jobs.drive(job.id, { budgetMs: UPDATE_CHECK_DRIVE_MS });
      } catch (error) {
        rc.log.warn('updates: driving the update check failed', { jobId: job.id, error: loggableError(error) });
      }
    }
    const body: UpdateCheckResponse = { jobId: job.id };
    return { status: 202, body, headers: NO_STORE };
  },
});

const apply = route<UpdateApplyBody>({
  id: 'updates.apply',
  method: 'POST',
  path: `${UPDATES}/apply`,
  permission: 'system.update.run',
  reauth: true,
  mode: 'system',
  idempotency: 'none',
  // C25: the op writes `update.apply` when it ends.
  audit: null,
  tx: 'self',
  body: UpdateApplyBody,
  async handler(rc) {
    refuseInImageMode(rc);
    const { channel, check: last } = await updateSettings(rc);
    const entry = offered(rc, last, channel);
    if (entry === null || entry.version !== rc.body.version) {
      throw new DomainError('UPDATE_NONE', {
        detail:
          `Versi ${rc.body.version} bukan pembaruan yang ditemukan pemeriksaan terakhir; periksa pembaruan lagi / ` +
          `Version ${rc.body.version} is not the update the last check found; check for updates again`,
      });
    }
    // §9.6 step 2 again, now with the free space proven: the entitlement, a snapshot backup or the disk may have changed.
    throwPrecheck(await precheckOf(rc, candidateOfEntry(entry)));
    const params: UpdateParams = { source: 'feed', target: entry.version, from: rc.services.version, entry, staging: null, needsBackup: null };
    const body = await beginUpdate(rc, params);
    return { body, headers: NO_STORE };
  },
});

const status = route({
  id: 'updates.status',
  method: 'GET',
  path: `${UPDATES}/status`,
  opsAuth: true,
  mode: 'system',
  maintenance: 'restore-allow',
  idempotency: 'none',
  audit: null,
  async handler(rc) {
    // DATA_DIR only: a restore past its point of no return may have dropped every table.
    const op = await rc.services.ops.current();
    const state = await readCurrent(rc);
    const bundledBlocked = op === null || op.terminal ? await bundledBlockedOf(rc) : null; // 1d Task 29
    const body: UpdateStatusView = {
      op,
      releases:
        state === null
          ? { active: rc.services.version, previous: null, pending: null, pinned: null }
          : {
              active: state.active.version,
              previous: state.previous?.version ?? null,
              pending: state.pending?.version ?? null,
              pinned: state.pinned,
            },
      serving: 'server',
      bundledBlocked,
    };
    return { body, headers: SERVED };
  },
});

const upload = route<UpdateUploadBody>({
  id: 'updates.upload',
  method: 'POST',
  path: `${UPDATES}/upload`,
  permission: 'system.update.run',
  reauth: true,
  mode: 'system',
  idempotency: 'none',
  audit: 'update.upload',
  tx: 'self',
  body: UpdateUploadBody,
  async handler(rc) {
    refuseInImageMode(rc);
    const subject = subjectOf(rc);
    const { uploadId } = rc.body;
    const dryRun = rc.body.dryRun === true;
    const updates = rc.services.updates;
    if (updates.packageKeys === undefined) throw new TypeError('updates.upload: the app has no package keys (services.updates.packageKeys)');
    // B5: read in place, never taken here (the op's `checking` step takes it), so a dry run leaves it for the real call.
    const staged = await stagedUploadFile(rc.db.db, { uploadId, owner: uploadOwner(subject), context: 'update', dataDir: rc.services.dataDir });
    const manifest = await readPackageManifest(staged.path, await updates.packageKeys());
    const report = await precheckOf(rc, candidateOf(manifest, staged.size));
    if (dryRun) {
      await rc.audit({ entity: 'upload_sessions', entityId: uploadId, meta: { uploadId, version: manifest.version, dryRun: true, ok: report.ok } });
      const body: UpdateUploadDryRun = { version: manifest.version, releasedAt: manifest.releasedAt, precheck: report };
      return { body, headers: NO_STORE };
    }
    throwPrecheck(report);
    const params: UpdateParams = {
      source: 'upload',
      uploadId,
      uploadBy: subject, // review L11: a takeover does not change whose upload the op takes
      target: manifest.version,
      from: rc.services.version,
      entry: null,
      staging: null,
      needsBackup: null,
    };
    const body = await beginUpdate(rc, params);
    await rc.audit({ entity: 'releases_log', entityId: body.opId, meta: { uploadId, version: manifest.version, dryRun: false, ok: true } });
    return { body, headers: NO_STORE };
  },
});

const rollback = route({
  id: 'updates.rollback',
  method: 'POST',
  path: `${UPDATES}/rollback`,
  permission: 'system.update.run',
  reauth: true,
  mode: 'system',
  idempotency: 'none',
  // The op writes `update.rollback` when it ends.
  audit: null,
  tx: 'self',
  async handler(rc) {
    refuseInImageMode(rc);
    const subject = subjectOf(rc);
    if ((await readCurrent(rc)) === null) throw rollbackUnavailable('no_previous');
    const handle = await beginRollback(rc.services.ops, { dataDir: rc.services.dataDir, appRoot: appRootOf(rc), actor: { type: 'staff', id: subject } });
    issueOpsCookie(rc.c, handle);
    // One step here: the checkpoint and the flip (pointers only, no maintenance). What it leaves, the worker, the page or
    // the next cron call finishes; a step that fails leaves the op for them.
    if (!rc.services.retired) {
      try {
        await rc.services.ops.step(ROLLBACK_STEP_MS);
      } catch (error) {
        rc.log.warn('updates: stepping the rollback failed', { opId: handle.opId, error: loggableError(error) });
      }
    }
    const body: UpdateOpResponse = { opId: handle.opId };
    return { body, headers: NO_STORE };
  },
});

const channelPut = route<ChannelBody>({
  id: 'updates.channel',
  method: 'PUT',
  path: `${UPDATES}/channel`,
  permission: 'system.update.run',
  mode: 'system',
  idempotency: 'store',
  audit: 'update.channel',
  body: ChannelBody,
  async handler(rc) {
    const tx = rc.tx();
    const { channel } = rc.body;
    const previous = (await readSettings(tx.trx, ['update.channel'], []))['update.channel'] as UpdateChannel;
    await writeSettings(tx.trx, { 'update.channel': channel }, { keyring: rc.config.keyring, now: rc.now, actorId: subjectOf(rc) });
    await tx.audit({ action: 'update.channel', entity: 'settings', entityId: 'update.channel', meta: { channel, previous } });
    rc.afterCommit(() => rc.services.settings.invalidate());
    const body: ChannelResponse = { channel };
    return { body };
  },
});

const history = route<unknown, UpdateHistoryQuery>({
  id: 'updates.history',
  method: 'GET',
  path: `${UPDATES}/history`,
  permission: 'system.update.read',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  query: UpdateHistoryQuery,
  async handler(rc) {
    const limit = rc.query.limit ?? UPDATE_HISTORY_PAGE_DEFAULT;
    let q = rc.db.db.selectFrom('releases_log').selectAll();
    if (rc.query.before !== undefined) q = q.where('id', '<', rc.query.before);
    const rows = await q.orderBy('id', 'desc').limit(limit + 1).execute();
    const items: ReleaseLogView[] = rows.slice(0, limit).map((r) => ({
      id: r.id,
      version: r.version,
      action: r.action,
      fromVersion: r.from_version,
      status: r.status,
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at === null ? null : Number(r.finished_at),
      backupId: r.backup_id,
    }));
    const body: UpdateHistoryResponse = { items, nextBefore: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
    return { body, headers: NO_STORE };
  },
});

/** The updates routes, in the order of the route catalog. */
export const UPDATES_ROUTES: RouteDecl[] = [get, check, apply, status, upload, rollback, channelPut, history];
