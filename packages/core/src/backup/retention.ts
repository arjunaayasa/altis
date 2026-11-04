import type { DbHandle } from '@altis/db';
import { dataPath, removeTree } from '@altis/platform';
import { errorFields, type CoreLogger } from '../context.js';
import { readClockAnomaly } from '../scheduler/clock.js';
import { gcBlobs } from './blobs.js';
import type { BackupKind } from './manifest.js';
import { BACKUP_PREPARE_DOWNLOAD_JOB, preparedDownloadLive } from './prepare-download.js';

// Count-based backup retention (spec §9.9 "Jadwal dan retensi"; decision C30), run at the end of every backup:
//
// - scheduled: the 7 newest, plus the newest scheduled backup of each of the 4 newest ISO weeks (library time) that lie
//   before the week of the oldest of those 7 (the "4 mingguan"); counted, not dated, so a server that was off for a
//   month still keeps 4 weekly backups;
// - pre_update: only the newest, and only until two updates (`releases_log` rows `action 'update'`, `status 'done'`)
//   have started after it;
// - manual: the 10 newest; pre_restore: the 3 newest; external: the 5 newest (decision C30: a busy admin cannot fill
//   the disk).
//
// It ranks backups by `created_at`, which the clock of the moment stamped. While `system.clock_anomaly` is raised
// (spec §10.4: the purges that go by time are skipped during the anomaly) nothing is removed: a backup stamped by a
// clock that went back would rank oldest and go as soon as it finished. The caller's `keep` ids (the backup that just
// finished) are never removed either, whatever their stamp.
//
// Only finished backups count and go (`ok`, and `uploaded` archives); `running` and `failed` rows are left alone, and so
// is a backup whose download is being prepared (a live `backup.prepare_download` job, holding its unique key
// `backup.prepare_download:<id>:<preparer>`): its job reads the backup's parts and blobs slice by slice, so the backup
// stays until a later run after the job has ended; so does one whose prepared download may still be fetched (its
// archive is in the backup's folder: 1 hour after it was ready, 5 minutes after it was served, C15). A removed backup's row gets `status 'deleted'` first (history rows are never deleted, §6.5), then its folder goes: a
// process that dies in between, or a removal that fails (logged; the run goes on), leaves a folder of a `deleted` row,
// never a row that lists a folder that is gone; the files cleanup removes such a folder a day later. Upload
// blobs no kept manifest refers to are then removed (gcBlobs), unless another backup is running (its blobs may not be
// in a manifest yet) or a kept backup's manifest cannot be read (its blobs cannot be told apart). A `running` row that
// nothing works on any more is ended by the files cleanup (backup/orphans.ts), which then collects the blobs itself.

/** How many backups of each kind stay (scheduled: the daily ones, the weekly ones come on top). */
const KEEP: Readonly<Record<BackupKind, number>> = { scheduled: 7, pre_update: 1, manual: 10, pre_restore: 3, external: 5 };
/** Weekly scheduled backups kept before the daily ones. */
const WEEKS_KEPT = 4;
/** A pre_update backup goes once this many updates were done after it. */
const UPDATES_AFTER_PRE_UPDATE = 2;

const DAY_MS = 86_400_000;
/** Each zone's formatter, built once (P6: a cache of derived facts). */
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The ISO 8601 week (`2026-W38`) of the calendar day `at` falls on in the zone `tz` (library time).
 *
 * @throws RangeError for an unknown zone
 */
export function isoWeekOf(at: number, tz: string): string {
  let format = formatters.get(tz);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' });
    formatters.set(tz, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const day = Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']));
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday 0 ... Sunday 6
  const thursday = day + (3 - weekday) * DAY_MS; // the ISO year is the year of the week's Thursday
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

interface Row {
  id: string;
  kind: string;
  created_at: number;
}

/** The scheduled backups that stay (rows newest first): see the top of this file. */
function keptScheduled(rows: readonly Row[], tz: string): Set<string> {
  const daily = rows.slice(0, KEEP.scheduled);
  const keep = new Set(daily.map((r) => r.id));
  const oldestDaily = daily.at(-1);
  if (oldestDaily === undefined) return keep;
  const dailyWeek = isoWeekOf(oldestDaily.created_at, tz);
  const weeks = new Set<string>();
  for (const r of rows.slice(KEEP.scheduled)) {
    if (weeks.size >= WEEKS_KEPT) break;
    const week = isoWeekOf(r.created_at, tz);
    // ISO week names sort like the weeks themselves.
    if (week >= dailyWeek || weeks.has(week)) continue;
    weeks.add(week);
    keep.add(r.id); // the first one seen of a week is its newest
  }
  return keep;
}

/**
 * Applies the retention (see the top of this file) at `now`, ISO weeks in the zone `tz` (`library.timezone`), never
 * removing the backups of `keep`; nothing at all while the clock anomaly is raised. Run it outside any withTx callback:
 * each row is changed in a statement of its own, the folders after them.
 *
 * @returns the ids of the backups it removed, oldest first
 */
export async function applyBackupRetention(
  h: DbHandle,
  dataDir: string,
  o: { now: number; tz: string; log?: CoreLogger; keep?: readonly string[] },
): Promise<string[]> {
  if ((await readClockAnomaly(h.db)) !== null) {
    o.log?.info('backup: the retention waits while the clock anomaly is raised');
    return [];
  }
  const rows = await h.db
    .selectFrom('backups')
    .select(['id', 'kind', 'created_at'])
    .where('status', 'in', ['ok', 'uploaded'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const byKind = new Map<string, Row[]>();
  for (const r of rows) {
    const row = { id: r.id, kind: r.kind, created_at: Number(r.created_at) };
    const list = byKind.get(row.kind);
    if (list === undefined) byKind.set(row.kind, [row]);
    else list.push(row);
  }

  const keep = new Set<string>(o.keep ?? []);
  for (const [kind, list] of byKind) {
    if (kind === 'scheduled') {
      for (const id of keptScheduled(list, o.tz)) keep.add(id);
    } else if (kind === 'pre_update') {
      const newest = list[0];
      if (newest === undefined) continue;
      const updates = await h.db
        .selectFrom('releases_log')
        .select('id')
        .where('action', '=', 'update')
        .where('status', '=', 'done')
        .where('started_at', '>', newest.created_at)
        .limit(UPDATES_AFTER_PRE_UPDATE)
        .execute();
      if (updates.length < UPDATES_AFTER_PRE_UPDATE) keep.add(newest.id);
    } else {
      const count = Object.hasOwn(KEEP, kind) ? KEEP[kind as BackupKind] : Number.POSITIVE_INFINITY;
      for (const r of list.slice(0, count)) keep.add(r.id);
    }
  }

  const doomed = rows.filter((r) => !keep.has(r.id)).reverse();
  const deleted: string[] = [];
  for (const { id } of doomed) {
    // A download of it that is ready and may still be fetched (C15): its archive lives in the backup's folder.
    if (await preparedDownloadLive(dataDir, id, o.now)) continue;
    const changed = await h.db
      .updateTable('backups')
      .set({ status: 'deleted' })
      .where('id', '=', id)
      .where('status', 'in', ['ok', 'uploaded'])
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('jobs')
              .select('jobs.id')
              .where('jobs.type', '=', BACKUP_PREPARE_DOWNLOAD_JOB)
              // The id is a ULID: no LIKE wildcard in it (the `_` of the type name matches itself too).
              .where('jobs.unique_key', 'like', `${BACKUP_PREPARE_DOWNLOAD_JOB}:${id}:%`),
          ),
        ),
      )
      .executeTakeFirst();
    // Removed meanwhile by another run, or its download is being prepared (kept for a later run).
    if (Number(changed.numUpdatedRows) !== 1) continue;
    deleted.push(id);
    try {
      await removeTree(dataPath(dataDir, 'backups', id));
    } catch (error) {
      // The row is `deleted` already: housekeeping.files removes what is left of the folder later (its `leftovers`
      // phase), as it does for a run killed between the two. The other backups and the blobs go on now.
      o.log?.warn('backup: the folder of a backup the retention removed could not be removed yet', { backupId: id, ...errorFields(error) });
    }
  }
  if (deleted.length > 0) await collectBlobs(h, dataDir, o.log);
  return deleted;
}

/**
 * gcBlobs over every kept (`ok`) backup, unless another backup is running (see the top of this file); gcBlobs itself
 * removes nothing while a kept manifest cannot be read (the one rule of blob-refs.ts).
 */
export async function collectBlobs(h: DbHandle, dataDir: string, log: CoreLogger | undefined): Promise<void> {
  const running = await h.db.selectFrom('backups').select('id').where('status', '=', 'running').limit(1).execute();
  if (running.length > 0) return;
  const kept = await h.db.selectFrom('backups').select('id').where('status', '=', 'ok').orderBy('id').execute();
  await gcBlobs(dataDir, kept, log);
}
