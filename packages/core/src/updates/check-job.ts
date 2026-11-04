import type { FeedChannel, FeedEntry, VerifiedFeed } from '@altis/crypto/feed';
import { upsert, withTx, type DB, type DbHandle } from '@altis/db';
import { dataPath, parseCurrentState, readJsonWithBak } from '@altis/platform';
import { compareSemver, isDomainError, isSemver } from '@altis/shared';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { errorFields, type CoreLogger } from '../context.js';
import { publish } from '../events/publish.js';
import { enqueue } from '../jobs/enqueue.js';
import { createJobRegistry } from '../jobs/registry.js';
import type { JobHandler, JobRegistry } from '../jobs/types.js';
import { notify } from '../notifications/service.js';
import { readSettings, writeSettings } from '../settings/service.js';
import { pickCandidate } from './candidate.js';
import type { UpdateSource } from './source.js';

// The update check (spec §9.6 step 1; plan Task 28; decision D1d-30; preflight 1D-12, M6; ruling R1d-2).
//
// - runUpdateCheck: the verified feed of the channel `update.channel` (fetchFeed: the seq raised per channel, the feed's
//   keyset documents persisted, the freshness time reported as signed time), outside any transaction (P18: its own
//   15 s bound, below a 20 s slice). Then pickCandidate against the running release and, in one transaction:
//   - `update.check` = {at, channel, ok: true, error: null, seq, available: the entry to install or null, latest: the
//     highest version above the running one, steppingStone, expiresAt: the feed's freshness expiry} (1d review L14:
//     `channel`, what checkOfChannel reads);
//   - `update_available` to `system.update.read`, once per version: only for a version above `update.notified` (which
//     it then becomes), and never for the version a manual rollback pinned (`releases/current.json` `pinned`, §9.7);
//   - `update.checked {available}` on `system.update`, the transaction's last statement (§10.6).
//   A refused or unreachable feed stores `{ok: false, error: <code>}` and keeps what the last good check of the same
//   channel found while the feed that listed it is still fresh (its `expiresAt`): that entry was verified then, and an
//   update of it still downloads against its SHA-256. Review C07 (§9.6 "seq yang lebih rendah atau sudah kedaluwarsa
//   ditolak"): past that expiry it keeps no entry, and {@link offeredUpdate} (what `GET updates`, `POST updates/apply`
//   and the dashboard offer) offers none from a check whatever its age, so an install acts only on what an unexpired
//   feed said. The failure's reason goes to the log only (a 5xx reason never reaches a client, preflight M6). A lost database
//   connection is thrown, so the job is tried again. No feed URL at all (`FEED_UNREACHABLE` `no_feed_url`: a build
//   without `--feed-url` and none set) is not a failure: online checks are off, so nothing is stored, published or
//   warned, and an earlier check stays as it was (`noFeed` in the result; `GET updates` says so through the source's
//   feedConfigured, and the dashboard queues no check then).
// - updateCheckJob: the job `update.check` (permission `system.update.read`, retryable through the API, interactive: a
//   page may drive it), payload {reason}; one slice per run.
// - enqueueUpdateCheck: the job under the unique key `update.check`, so a second request joins the live one.
// - updateCheckThrottle: `POST updates/check` runs at most once per 60 s (`update.check.at` of the current channel's
//   check, checkOfChannel).
// - enqueueDashboardCheck: `GET dashboard` enqueues a check when `update.dashboard_check_at` is older than an hour
//   (§9.6 step 1, D1d-30), recording the time in the same transaction.
//
// Several processes may check at once (P6): every write is one transaction of settings that a later check overwrites.
// The decisions that must happen once are made under a row lock taken first in their transaction (created with the
// setting's default when absent): the `update.notified` row for the
// notification, the `update.dashboard_check_at` row for the dashboard's hourly check. A second process waits for the
// first one's commit and then reads what it wrote (PostgreSQL READ COMMITTED; MySQL/MariaDB take their snapshot at the
// first read, after the lock; SQLite writes one transaction at a time).

/** The job type of the update check. */
export const UPDATE_CHECK_JOB = 'update.check';
/** The unique key of a requested check (manual or dashboard): one live job at a time. */
export const UPDATE_CHECK_UNIQUE_KEY = 'update.check';
/** `POST updates/check` runs at most this often (D1d-30). */
export const UPDATE_CHECK_THROTTLE_MS = 60_000;
/** Opening the dashboard enqueues a check at most this often (§9.6 step 1, D1d-30). */
export const DASHBOARD_CHECK_INTERVAL_MS = 3_600_000;

/** Where an `update_available` notification leads (the Pembaruan screen). */
const UPDATES_LINK = '/admin/updates';

/** Who asked for a check: the daily schedule, the dashboard, or an admin (`POST updates/check`). */
export type UpdateCheckReason = 'schedule' | 'dashboard' | 'manual';

export type UpdateCheckPayload = { reason: UpdateCheckReason };

/** The payload of `update.check`. */
export const updateCheckPayload: z.ZodType<UpdateCheckPayload> = z.strictObject({ reason: z.enum(['schedule', 'dashboard', 'manual']) });

/** What the update check needs from its process. */
export interface UpdateCheckDeps {
  /** The process's feed client (services.updates.source). */
  source: Pick<UpdateSource, 'fetchFeed'>;
  /** The running release: entries above it are offered. */
  appVersion: string;
  /** DATA_DIR: `releases/current.json` names the pinned version. */
  dataDir: string;
}

/** The setting `update.check` (core/settings/registry.ts). */
export interface StoredUpdateCheck {
  at: number;
  /**
   * 1d review L14: the channel the check read (`update.channel` when it ran). Absent in a check stored before the
   * channel was recorded; {@link checkOfChannel} takes such a check for the current channel's.
   */
  channel?: FeedChannel;
  ok: boolean;
  error: string | null;
  seq: number | null;
  available: FeedEntry | null;
  latest: string | null;
  steppingStone: boolean;
  /**
   * Review C07: the `expiresAt` of the verified feed that listed `available` (epoch ms; §9.6 freshness). Null when no
   * good check stored one; absent in a check stored before it was recorded. Either offers nothing.
   */
  expiresAt?: number | null;
}

/**
 * Review C07 (§9.6): the entry `check` offers on `channel` to the running release `version` at `now`: its entry when it
 * is for that channel, SemVer-newer than `version`, and the feed that listed it is fresh (`now <= expiresAt`, as the
 * feed client accepts a feed); else null.
 */
export function offeredUpdate(check: StoredUpdateCheck | null, channel: FeedChannel, version: string, now: number): FeedEntry | null {
  const entry = check?.available ?? null;
  if (entry === null || entry.channel !== channel) return null;
  if (!fresh(check, now)) return null;
  return isSemver(version) && isSemver(entry.version) && compareSemver(entry.version, version) > 0 ? entry : null;
}

/** Whether the feed of `check` is still fresh at `now` (an unknown expiry is not). */
function fresh(check: StoredUpdateCheck | null, now: number): boolean {
  const expiresAt = check?.expiresAt;
  return typeof expiresAt === 'number' && now <= expiresAt;
}

/** What one check did. */
export interface UpdateCheckResult {
  ok: boolean;
  /** The error code of a failed check, else null. */
  error: string | null;
  /** The version to install as stored, or null. */
  available: string | null;
  /** The `update_available` notification went out for `available`. */
  notified: boolean;
  /** No update feed is configured: nothing was checked, stored or published (`ok` false, `error` null). */
  noFeed?: true;
}

/** What a check does without a feed URL (see the top of this file). */
const NO_FEED: UpdateCheckResult = Object.freeze({ ok: false, error: null, available: null, notified: false, noFeed: true });

/** The feed client found no feed base (UpdateSource.fetchFeed's `no_feed_url`). */
function isNoFeed(error: unknown): boolean {
  return isDomainError(error) && error.code === 'FEED_UNREACHABLE' && error.meta?.['reason'] === 'no_feed_url';
}

/** `e` with exactly the fields of the setting's strict `FEED_ENTRY` (R1d-2). */
function storedEntry(e: FeedEntry): FeedEntry {
  return {
    version: e.version,
    channel: e.channel,
    releasedAt: e.releasedAt,
    bootProtocol: e.bootProtocol,
    minUpgradeFrom: e.minUpgradeFrom,
    minCodeVersionAfter: e.minCodeVersionAfter,
    minNode: e.minNode,
    minDb: { mysql: e.minDb.mysql, mariadb: e.minDb.mariadb, postgres: e.minDb.postgres },
    size: e.size,
    sha256: e.sha256,
    url: e.url,
    notesUrl: e.notesUrl,
  };
}

/**
 * The version a manual rollback pinned (`releases/current.json` `pinned`), or null: also when the file cannot be read
 * (then no notification is held back for it; the bootloader repairs the file).
 */
async function pinnedVersion(dataDir: string, log: CoreLogger): Promise<string | null> {
  try {
    return (await readJsonWithBak(dataPath(dataDir, 'releases', 'current.json'), parseCurrentState))?.pinned ?? null;
  } catch (error) {
    log.warn('update check: releases/current.json could not be read; no version counts as pinned', errorFields(error));
    return null;
  }
}

/**
 * Locks the settings row `key` for the rest of `trx`, creating it with the JSON `null` (the default of both settings
 * locked here) when it is absent: an UPDATE that changes nothing takes the lock, an INSERT that collides waits for the
 * other transaction and then updates (upsert).
 */
async function lockSetting(trx: Transaction<DB>, key: 'update.notified' | 'update.dashboard_check_at', now: number): Promise<void> {
  const row = { value: 'null', is_secret: 0, scope: 'instance' as const, updated_at: now, updated_by: null };
  await upsert(trx, 'settings', { key }, row, { scope: 'instance' });
}

/**
 * 1d review L14: the stored check `check` if it is about `channel` (or names no channel: stored before the channel was
 * recorded), else null. After a channel change the last check says nothing of the new channel: not when it was checked,
 * not that nothing newer is there, and it holds no check of the new channel back (GET updates, `POST updates/check`'s
 * throttle, the dashboard's update card).
 */
export function checkOfChannel(check: StoredUpdateCheck | null, channel: FeedChannel): StoredUpdateCheck | null {
  return check === null || (check.channel !== undefined && check.channel !== channel) ? null : check;
}

/** Whether `version` is to be notified: above the last version notified (none yet counts as below every version). */
function notifiable(version: string, notified: unknown): boolean {
  return typeof notified !== 'string' || !isSemver(notified) || compareSemver(version, notified) > 0;
}

/**
 * One update check (see the top of this file).
 *
 * @throws DomainError `DB_UNAVAILABLE` (the feed's or the settings' database), and what the settings transaction throws;
 *   a TypeError for a feed client that fails in a way it never should (a bug: the job retries, then dies)
 */
export async function runUpdateCheck(h: DbHandle, d: UpdateCheckDeps, o: { now(): number; log: CoreLogger }): Promise<UpdateCheckResult> {
  const channel = (await readSettings(h.db, ['update.channel'], []))['update.channel'] as FeedChannel;
  let feed: VerifiedFeed | null = null;
  let failure: string | null = null;
  try {
    feed = await d.source.fetchFeed(channel);
  } catch (error) {
    if (isNoFeed(error)) {
      o.log.info('update check: no update feed is configured; online checks are off', { channel });
      return { ...NO_FEED };
    }
    if (!isDomainError(error) || error.code === 'DB_UNAVAILABLE') throw error;
    failure = error.code;
    o.log.warn('update check: the feed was not usable', { channel, ...errorFields(error), reason: error.meta?.['reason'] ?? null });
  }
  const pinned = feed === null ? null : await pinnedVersion(d.dataDir, o.log);
  const pick = feed === null ? null : pickCandidate(feed.entries, d.appVersion);

  return withTx(h, async (trx) => {
    const now = o.now();
    await lockSetting(trx, 'update.notified', now); // first: one check at a time decides the notification
    const stored = await readSettings(trx, ['update.check', 'update.notified'], []);
    // 1d review L14: what a failure keeps of the last check is that channel's only.
    const prev = checkOfChannel(stored['update.check'] as StoredUpdateCheck | null, channel);
    let next: StoredUpdateCheck;
    let notifyVersion: string | null = null;
    if (feed !== null && pick !== null) {
      next = {
        at: now,
        channel,
        ok: true,
        error: null,
        seq: feed.seq,
        available: pick.target === null ? null : storedEntry(pick.target),
        latest: pick.latest?.version ?? null,
        steppingStone: pick.steppingStone,
        expiresAt: feed.expiresAt,
      };
      const version = pick.target?.version ?? null;
      if (version !== null && version !== pinned && notifiable(version, stored['update.notified'])) notifyVersion = version;
    } else {
      // Review C07: what the last good check found, only while its feed is fresh.
      const kept = fresh(prev, now) ? prev : null;
      next = {
        at: now,
        channel,
        ok: false,
        error: failure,
        seq: prev?.seq ?? null,
        available: kept?.available ?? null,
        latest: kept?.latest ?? null,
        steppingStone: kept?.steppingStone ?? false,
        expiresAt: prev?.expiresAt ?? null,
      };
    }
    const patch = notifyVersion === null ? { 'update.check': next } : { 'update.check': next, 'update.notified': notifyVersion };
    await writeSettings(trx, patch, { keyring: [], now, actorId: null });
    if (notifyVersion !== null) {
      await notify(
        trx,
        {
          audience: { permission: 'system.update.read' },
          type: 'update.available',
          titleKey: 'notification.update_available.title',
          params: { version: notifyVersion },
          link: UPDATES_LINK,
        },
        now,
      );
    }
    // The last statement of the transaction (§10.6).
    const available = next.available?.version ?? null;
    await publish(trx, { channel: 'system.update', type: 'update.checked', payload: { available } });
    return { ok: next.ok, error: next.error, available, notified: notifyVersion !== null };
  });
}

/** The `update.check` job (see the top of this file); `deps` is read at every run. */
export function updateCheckJob(deps: () => UpdateCheckDeps): JobHandler<UpdateCheckPayload> {
  return {
    type: UPDATE_CHECK_JOB,
    permission: 'system.update.read',
    retryable: 'api',
    interactive: true,
    payload: updateCheckPayload,
    async run(ctx, p) {
      const r = await runUpdateCheck(ctx.handle, deps(), { now: () => ctx.now(), log: ctx.log });
      if (r.noFeed !== true) {
        ctx.log.info('update check done', { reason: p.reason, ok: r.ok, error: r.error, available: r.available, notified: r.notified });
      }
      return { done: true };
    },
  };
}

/** A registry that only enqueues `update.check` (its payload schema): a check is queued without the job runtime. */
const enqueueRegistry: JobRegistry = createJobRegistry([
  updateCheckJob(() => {
    throw new TypeError('update.check: this registry only enqueues (the job runtime runs the check)');
  }),
]);

/**
 * Enqueues an update check in `trx` for `o.reason`, or joins the live one (unique key {@link UPDATE_CHECK_UNIQUE_KEY}:
 * `existing`). Re-runnable with the transaction (R37).
 */
export async function enqueueUpdateCheck(
  trx: Transaction<DB>,
  o: { reason: UpdateCheckReason; now: number; createdBy?: string | null },
): Promise<{ id: string; existing: boolean }> {
  return enqueue(
    trx,
    enqueueRegistry,
    { type: UPDATE_CHECK_JOB, payload: { reason: o.reason }, uniqueKey: UPDATE_CHECK_UNIQUE_KEY, createdBy: o.createdBy ?? null },
    { now: o.now, keyring: [] },
  );
}

/**
 * The wait (whole seconds, at least 1) before another manual check may run, when the last check (`lastAt`, epoch ms)
 * was less than {@link UPDATE_CHECK_THROTTLE_MS} ago; null when it may run now. A last check dated more than that ahead
 * of `now` (a clock set back) does not hold checks back.
 */
export function updateCheckThrottle(lastAt: number | null, now: number): number | null {
  if (lastAt === null) return null;
  const since = now - lastAt;
  if (since >= UPDATE_CHECK_THROTTLE_MS || since <= -UPDATE_CHECK_THROTTLE_MS) return null;
  return Math.max(1, Math.ceil((UPDATE_CHECK_THROTTLE_MS - Math.max(0, since)) / 1000));
}

/**
 * `GET dashboard`'s check (§9.6 step 1): under the lock of its settings row, when `update.dashboard_check_at` is unset
 * or more than an hour from `o.now` (either way: a clock set back does not stop the checks), records `o.now` there and
 * enqueues a check for `dashboard` in `trx`; otherwise does nothing. Call it as the transaction's first statement, in
 * a withTx callback that may run again (R37).
 *
 * @returns the job's id (a live one joined counts), or null when a check was enqueued less than an hour ago
 */
export async function enqueueDashboardCheck(trx: Transaction<DB>, o: { now: number; createdBy?: string | null }): Promise<string | null> {
  await lockSetting(trx, 'update.dashboard_check_at', o.now); // first: of two dashboards opened at once, one enqueues
  const at = (await readSettings(trx, ['update.dashboard_check_at'], []))['update.dashboard_check_at'] as number | null;
  if (!dashboardCheckDue(at, o.now)) return null;
  await writeSettings(trx, { 'update.dashboard_check_at': o.now }, { keyring: [], now: o.now, actorId: null });
  const job = await enqueueUpdateCheck(trx, { reason: 'dashboard', now: o.now, createdBy: o.createdBy ?? null });
  return job.id;
}

/** Whether a dashboard check last enqueued at `at` (null: never) is due again at `now`. */
export function dashboardCheckDue(at: number | null, now: number): boolean {
  return at === null || Math.abs(now - at) >= DASHBOARD_CHECK_INTERVAL_MS;
}
