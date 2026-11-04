import type { FeedChannel } from '@altis/crypto/feed';
import { countRows, type DB } from '@altis/db';
import { dataPath, parseCurrentState, readJsonWithBak, type CurrentState, type Env, type Runtime } from '@altis/platform';
import { OP_KIND_PERMISSION, compareSemver, isSemver, isTerminal, type IpTrust, type Permission } from '@altis/shared';
import {
  ALERT_KINDS,
  type Alert,
  type AlertKind,
  type AlertSeverity,
  type DashboardResponse,
  type DashboardUpdate,
} from '@altis/shared/api/dashboard';
import type { ScheduleView } from '@altis/shared/api/jobs';
import type { Kysely } from 'kysely';
import { can, type Grants } from '../authz/grants.js';
import { newestBackup, type BackupItem } from '../backup/catalog.js';
import { bundledReleaseFact } from '../diagnostics/collect.js';
import type { StoredProbe } from '../diagnostics/probes.js';
import type { EditionCheck, EditionService } from '../edition/edition.js';
import { lastRuns, runnerFresh } from '../jobs/run-records.js';
import { runnerMode } from '../jobs/runner.js';
import { readOpFile } from '../ops/files.js';
import type { OpsMachine } from '../ops/machine.js';
import { readSettings } from '../settings/service.js';
import { checkOfChannel, offeredUpdate, type StoredUpdateCheck } from '../updates/check-job.js';
import { releaseSourceMode } from '../updates/source-mode.js';
import { catalogAlerts } from './catalog-alerts.js';

// The system dashboard (spec §13.3 "Dasbor sistem"; plan Task 26; decision C33): the answer of `GET dashboard`, for
// every staff user, with each section and each alert filtered by the permission that guards its data (the table in
// @altis/shared/api/dashboard). Cheap reads only, each made only for a caller who may see what it feeds: the machine
// state the jobs and the browser test leave in instance settings (one query), the run records, the backups list, the
// `backup.daily` row, counts on `jobs`, one `notifications` probe, op.json.
//
// The alert rules (Review Focus 1: a missing runner shows on the dashboard):
//
//   runner_stale     error    external mode (passenger/litespeed, or ALTIS_RUNNER=off) and no worker, `jobs:run` or
//                             `POST /_cron` run recorded within 10 minutes (runnerFresh: drive and piggyback only run
//                             because of traffic, so they never count)
//   clock_anomaly    warning  `system.clock_anomaly` is set (the clock banner's severity)
//   exposure_failed  error    the last exposure check failed (§11: "banner merah bila gagal")
//   backup_missing   warning  `backup.daily` is on, the installation is at least 48 h old (from UTC midnight of its
//                             install date `trialStartedAt`: a fresh one has had no night to back up in yet), and no
//                             backup of this installation (not an uploaded `external` archive) is `ok` among those
//                             created within 48 h
//   backup_failed    warning  the newest finished backup of this installation (`ok` or `failed`, not `external`)
//                             failed: a backup still running, or stuck `running`, does not make up for it
//   jobs_dead        warning  dead jobs that finished within 7 days (`params.count`)
//   disk_low         warning  a `disk_low` notification within 24 h (P21)
//   ops_attention    error    the current op is `needs_attention`; shown to the holders of its kind's permission
//                             (OP_KIND_PERMISSION: who may take it over on /admin/_update), any op permission for an
//                             op whose kind cannot be read
//   ip_trust         warning  `system.ip_trust` is not `ok` (`params.suggestedHops` when the browser test found one)
//   audit_broken     error    the last audit chain verification failed (`audit.verified.ok` false)
//
// 1d Task 29 (preflight S13; the alerts Diagnostik itself does not raise):
//
//   keyset_full        warning  `system.keyset_full` is set: the keyset writer refused documents (R65c)
//   update_blocked     warning  `update.bundled_blocked` names a release newer than the running one (§9.8 row 2; a
//                               record of a release installed since says nothing any more)
//   bundled_ignored    info     the release bundled beside app.js is newer than `pending ?? active` but is not being
//                               installed: it is pinned (§9.7) or an update of it failed before (D1d-24). An older one
//                               is the normal state after a one-click update (the zip stays as it was): Diagnostik
//                               shows it, the dashboard does not
//   schema_hold        error    op.json holds a `schemaHold` update (source `self`, §9.8 row 3) that runs, waits for a
//                               person, or failed within the last hour (as ops/current shows an op that ended)
//
// `version.update` (system.update.read): what the last update check of the current channel found, newer than the
// running release (Task 28's `update.check`), whether this edition covers it (the edition seam: community, always),
// image mode, the pin.
// `edition` (everyone): the edition service's check, `{ edition, status }` (community: `community`, `active`).
//
// Phase 2 (preflight B2; Task 2 wires them, Task 15 gives them their causes), both through the hook
// ./catalog-alerts.ts, called once for a holder of `system.diagnostics.read`:
//
//   search_index_mismatch  warning  the search index disagrees with the catalog
//   oai_misconfigured      warning  OAI-PMH is on without an admin e-mail
//
// Alerts are listed errors first, then warnings, each group in the order of ALERT_KINDS.

/** `backup_missing`: no `ok` backup created within this long (and an installation at least this old). */
const BACKUP_MISSING_MS = 48 * 3_600_000;
/** Dead jobs are reported for this long after they finished. */
const JOBS_DEAD_WINDOW_MS = 7 * 86_400_000;
/** A `disk_low` notification is reported for this long. */
const DISK_LOW_WINDOW_MS = 86_400_000;

/** The permission of each alert's data (every alert but `ops_attention`, whose permission is its op kind's). */
export const ALERT_PERMISSION: Readonly<Record<Exclude<AlertKind, 'ops_attention'>, Permission>> = Object.freeze({
  runner_stale: 'system.jobs.read',
  jobs_dead: 'system.jobs.read',
  clock_anomaly: 'system.diagnostics.read',
  exposure_failed: 'system.diagnostics.read',
  ip_trust: 'system.diagnostics.read',
  disk_low: 'system.diagnostics.read',
  backup_missing: 'system.backup.read',
  backup_failed: 'system.backup.read',
  audit_broken: 'system.audit.read',
  // 1d Task 29
  keyset_full: 'system.diagnostics.read',
  update_blocked: 'system.update.read',
  bundled_ignored: 'system.update.read',
  schema_hold: 'system.update.read',
  // ---- Phase 2 (catalog): Task 2 ----
  search_index_mismatch: 'system.diagnostics.read',
  oai_misconfigured: 'system.diagnostics.read',
});

/** Every op kind's permission: `ops_attention` for an op whose kind cannot be read goes to the holders of any. */
const OP_PERMISSIONS: readonly Permission[] = Object.freeze([...new Set(Object.values(OP_KIND_PERMISSION))]);

/** How bad each alert is (exhaustive: a kind without its row fails the build). */
export const ALERT_SEVERITY: Readonly<Record<AlertKind, AlertSeverity>> = Object.freeze({
  runner_stale: 'error',
  clock_anomaly: 'warning',
  exposure_failed: 'error',
  backup_missing: 'warning',
  backup_failed: 'warning',
  jobs_dead: 'warning',
  disk_low: 'warning',
  ops_attention: 'error',
  ip_trust: 'warning',
  audit_broken: 'error',
  // 1d Task 29
  keyset_full: 'warning',
  update_blocked: 'warning',
  bundled_ignored: 'info',
  schema_hold: 'error',
  // ---- Phase 2 (catalog): Task 2 ----
  search_index_mismatch: 'warning',
  oai_misconfigured: 'warning',
});

/** The admin page that explains or fixes each alert (exhaustive). */
export const ALERT_LINK: Readonly<Record<AlertKind, string>> = Object.freeze({
  runner_stale: '/admin/diagnostics',
  clock_anomaly: '/admin/diagnostics',
  exposure_failed: '/admin/diagnostics',
  backup_missing: '/admin/backups',
  backup_failed: '/admin/backups',
  jobs_dead: '/admin/jobs',
  disk_low: '/admin/diagnostics',
  ops_attention: '/admin/_update',
  ip_trust: '/admin/diagnostics',
  audit_broken: '/admin/audit',
  // 1d Task 29: Diagnostik, Pembaruan (Task 30)
  keyset_full: '/admin/diagnostics',
  update_blocked: '/admin/updates',
  bundled_ignored: '/admin/updates',
  schema_hold: '/admin/updates',
  // ---- Phase 2 (catalog): Task 2 ----
  search_index_mismatch: '/admin/diagnostics',
  oai_misconfigured: '/admin/diagnostics',
});

/** 1d Task 29: an op that ended stays on the dashboard this long (as ops/current shows it, OpsMachine). */
const OP_ENDED_SHOWN_MS = 3_600_000;

const SEVERITY_ORDER: readonly AlertSeverity[] = ['error', 'warning', 'info'];

export interface DashboardOptions {
  /** The live handle's Kysely (no transaction: a dashboard reads, and each read stands alone). */
  db: Kysely<DB>;
  dataDir: string;
  /** config.json's sessionKey as bytes: the backups' manifest HMAC (`lastBackup.sameInstall`). */
  sessionKey: Uint8Array;
  /** The caller's grants: they decide every section and alert. */
  grants: Grants;
  now: number;
  /** The running release. */
  version: string;
  /** app.js's version (BootContext.appJsVersion), null when the bootloader gave none. */
  appJsVersion: string | null;
  /** The runtime and the environment of this process: the runner mode (runnerMode). */
  runtime: Runtime;
  env: Env;
  /**
   * config.json's `install.trialStartedAt` (`YYYY-MM-DD`): the install date (the field keeps its name for config.json
   * compatibility, ruling R6). `backup_missing` waits until the installation is 48 h old.
   */
  trialStartedAt: string;
  /** The app's ops machine: `current()` reads op.json (asked only of a holder of an op permission). */
  ops: Pick<OpsMachine, 'current'>;
  /** The schedules as `GET schedules` lists them (the server's listScheduleViews), read only for `system.jobs.read`. */
  listSchedules(db: Kysely<DB>): Promise<ScheduleView[]>;
  /** The edition seam (ruling R1): its check names the edition (shown to everyone) and decides `update.entitled`. */
  edition: Pick<EditionService, 'check'>;
  /** 1d Task 29: the app folder (`bundled-release/<v>`); without one no bundled release is looked for. */
  appRoot: string | undefined;
}

/** `YYYY-MM-DD` as UTC midnight epoch ms, or null when it is not a calendar date. */
function calendarDay(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = Date.UTC(y, mo - 1, d);
  const back = new Date(at);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? at : null;
}

/** A count or a minimum as the drivers return it (number, numeric string, bigint), or null. */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Counts by status, and how long the oldest due job has waited (a job whose time has not come waits for its time). */
async function queueOf(db: Kysely<DB>, now: number): Promise<NonNullable<DashboardResponse['queue']>> {
  const count = (status: string): Promise<number> => countRows(db.selectFrom('jobs').where('status', '=', status).select('id'));
  const queued = await count('queued');
  const running = await count('running');
  const dead = await count('dead');
  const oldest = await db
    .selectFrom('jobs')
    .select((eb) => eb.fn.min('run_at').as('m'))
    .where('status', '=', 'queued')
    .where('run_at', '<=', now)
    .executeTakeFirst();
  const runAt = numberOrNull(oldest?.m);
  return { queued, running, dead, oldestQueuedMs: runAt === null ? null : Math.max(0, now - runAt) };
}

/** The backups part: the newest backup not deleted, the next daily run, and the two backup alerts. */
async function backupsOf(
  o: DashboardOptions,
  raise: (kind: AlertKind) => void,
): Promise<{ lastBackup: BackupItem | null; nextBackupAt: number | null }> {
  const { db, now } = o;
  const daily = await db.selectFrom('schedules').select(['enabled', 'next_run_at']).where('name', '=', 'backup.daily').executeTakeFirst();
  const dailyOn = daily !== undefined && Number(daily.enabled) === 1;
  // The alerts look at this installation's own backups (an uploaded archive backs nothing of it up), by their rows
  // alone: only the backup shown has its manifest read (cheap reads, however many backups are kept).
  const ours = db.selectFrom('backups').where('kind', '!=', 'external');
  const newestFinished = await ours
    .select('status')
    .where('status', 'in', ['ok', 'failed'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (newestFinished?.status === 'failed') raise('backup_failed');
  const installedAt = calendarDay(o.trialStartedAt);
  const oldEnough = installedAt !== null && now - installedAt >= BACKUP_MISSING_MS;
  if (dailyOn && oldEnough) {
    const recent = await ours.select('id').where('status', '=', 'ok').where('created_at', '>=', now - BACKUP_MISSING_MS).limit(1).executeTakeFirst();
    if (recent === undefined) raise('backup_missing');
  }
  return { lastBackup: await newestBackup(db, o.dataDir, o.sessionKey), nextBackupAt: dailyOn ? Number(daily.next_run_at) : null };
}

type Exposure = { at: number; ok: boolean; url: string | null } | null;
type Verified = { ok: boolean } | null;

// ---- 1d Task 29 ---------------------------------------------------------------------------------------------------

/** The settings the 1d parts read, by the permission that shows them. */
const UPDATE_SETTINGS = ['update.channel', 'update.check', 'update.bundled_blocked'] as const;

/** `newer` is a SemVer above the SemVer `than`. */
function isNewer(newer: string, than: string): boolean {
  return isSemver(newer) && isSemver(than) && compareSemver(newer, than) > 0;
}

/** releases/current.json, or null when it is missing or unusable (the bootloader repairs it; the dashboard only reads). */
async function currentState(dataDir: string): Promise<CurrentState | null> {
  try {
    return await readJsonWithBak(dataPath(dataDir, 'releases', 'current.json'), parseCurrentState);
  } catch {
    return null;
  }
}

/**
 * The update card (see the top of this file): the stored check's entry when it is for the current channel, newer than
 * the running release and its feed still fresh (review C07), as `GET updates` offers it (offeredUpdate).
 */
function updateOf(o: DashboardOptions, check: EditionCheck, s: Record<string, unknown>, state: CurrentState | null): DashboardUpdate {
  const channel = s['update.channel'] as FeedChannel;
  // 1d review L14: the check of the channel in force only (one of another channel never says "checked, nothing newer").
  const stored = checkOfChannel(s['update.check'] as StoredUpdateCheck | null, channel);
  const offered = offeredUpdate(stored, channel, o.version, o.now);
  return {
    available:
      offered === null || stored === null
        ? null
        : { version: offered.version, releasedAt: offered.releasedAt, notesUrl: offered.notesUrl, steppingStone: stored.steppingStone },
    checkedAt: stored?.at ?? null,
    // Without a release to install there is nothing this edition could fail to cover.
    entitled: offered === null || check.notEntitled(offered.releasedAt) === null,
    oneClick: releaseSourceMode(o.env) === 'data',
    pinned: state?.pinned ?? null,
  };
}

/**
 * `schema_hold`: op.json holds a `schemaHold` update (source `self`) that has not ended `done` and, when it ended,
 * ended within the hour. An op.json that cannot be read says nothing here (`ops_attention` covers it).
 */
async function schemaHoldShown(o: DashboardOptions): Promise<boolean> {
  let op;
  try {
    op = await readOpFile(o.dataDir);
  } catch {
    return false;
  }
  if (op === null || op === 'corrupt' || op.kind !== 'update' || op.params['source'] !== 'self' || op.state === 'done') return false;
  return !isTerminal(op.kind, op.state) || o.now <= (op.finishedAt ?? op.heartbeatAt) + OP_ENDED_SHOWN_MS;
}

/**
 * 1d Task 29: the update card and its alerts (see the top of this file), for `system.update.read` only: current.json
 * and the bundled release are read only then. `check` is the edition's (it decides `entitled`).
 */
async function updates(
  o: DashboardOptions,
  check: EditionCheck,
  may: (p: Permission) => boolean,
  body: DashboardResponse,
  raise: (kind: AlertKind) => void,
): Promise<void> {
  if (!may('system.update.read')) return;
  const s = await readSettings(o.db, UPDATE_SETTINGS, []);
  const state = await currentState(o.dataDir);
  body.version.update = updateOf(o, check, s, state);
  const blocked = s['update.bundled_blocked'] as { version: string } | null;
  if (blocked !== null && isNewer(blocked.version, o.version)) raise('update_blocked');
  if (state !== null) {
    const bundled = await bundledReleaseFact({
      db: o.db,
      dataDir: o.dataDir,
      appRoot: o.appRoot,
      appJsVersion: o.appJsVersion,
      state,
      mode: releaseSourceMode(o.env),
      blockedVersion: blocked?.version ?? null,
    });
    if (bundled !== null && (bundled.note === 'pinned' || bundled.note === 'failed_before')) raise('bundled_ignored');
  }
  if (await schemaHoldShown(o)) raise('schema_hold');
}

/**
 * The dashboard of the caller whose grants `o.grants` are (see the top of this file).
 *
 * @throws what the reads throw (DomainError DB_UNAVAILABLE)
 */
export async function dashboardSummary(o: DashboardOptions): Promise<DashboardResponse> {
  const { db, grants, now } = o;
  const may = (p: Permission): boolean => can(grants, p);
  const raised = new Map<AlertKind, Alert>();
  const raise = (kind: AlertKind, params?: Record<string, string | number>): void => {
    if (kind !== 'ops_attention' && !may(ALERT_PERMISSION[kind])) return;
    raised.set(kind, {
      kind,
      severity: ALERT_SEVERITY[kind],
      messageKey: `alert.${kind}`,
      ...(params === undefined ? {} : { params }),
      link: ALERT_LINK[kind],
    });
  };

  const check = await o.edition.check();
  const body: DashboardResponse = {
    version: { current: o.version, appJs: o.appJsVersion, bootProtocol: 1, update: null },
    edition: { edition: check.edition, status: check.status },
    lastBackup: null,
    nextBackupAt: null,
    queue: null,
    scheduler: null,
    alerts: [],
  };

  if (may('system.jobs.read')) {
    body.queue = await queueOf(db, now);
    const mode = runnerMode(o.runtime, o.env);
    const runs = await lastRuns(db);
    body.scheduler = { runner: { mode, lastRuns: runs }, schedules: await o.listSchedules(db) };
    if (mode === 'external' && !runnerFresh(runs, now)) raise('runner_stale');
    const dead = await countRows(
      db.selectFrom('jobs').where('status', '=', 'dead').where('finished_at', '>=', now - JOBS_DEAD_WINDOW_MS).select('id'),
    );
    if (dead > 0) raise('jobs_dead', { count: dead });
  }

  if (may('system.backup.read')) Object.assign(body, await backupsOf(o, raise));

  const diagnostics = may('system.diagnostics.read');
  const audit = may('system.audit.read');
  if (diagnostics || audit) {
    const s = await readSettings(
      db,
      ['system.clock_anomaly', 'system.exposure', 'system.ip_trust', 'system.probe', 'audit.verified', 'system.keyset_full'],
      [],
    );
    if (diagnostics) {
      if (s['system.keyset_full'] !== null) raise('keyset_full'); // 1d Task 29
      if (s['system.clock_anomaly'] !== null) raise('clock_anomaly');
      if ((s['system.exposure'] as Exposure)?.ok === false) raise('exposure_failed');
      if ((s['system.ip_trust'] as IpTrust) !== 'ok') {
        const hops = (s['system.probe'] as StoredProbe | null)?.xff.suggestedHops ?? null;
        raise('ip_trust', hops === null ? undefined : { suggestedHops: hops });
      }
      const low = await db
        .selectFrom('notifications')
        .select('id')
        .where('title_key', '=', 'notification.disk_low.title')
        .where('created_at', '>=', now - DISK_LOW_WINDOW_MS)
        .limit(1)
        .executeTakeFirst();
      if (low !== undefined) raise('disk_low');
      // ---- Phase 2 (catalog): Task 2 ----
      await catalogAlerts(db, (kind) => raise(kind));
    }
    if (audit && (s['audit.verified'] as Verified)?.ok === false) raise('audit_broken');
  }

  if (OP_PERMISSIONS.some((p) => may(p))) {
    const op = await o.ops.current();
    if (op !== null && op.needsAttention && (op.kind === null || may(OP_KIND_PERMISSION[op.kind]))) raise('ops_attention');
  }

  await updates(o, check, may, body, raise); // 1d Task 29

  body.alerts = SEVERITY_ORDER.flatMap((severity) =>
    ALERT_KINDS.flatMap((kind) => {
      const alert = raised.get(kind);
      return alert !== undefined && alert.severity === severity ? [alert] : [];
    }),
  );
  return body;
}
