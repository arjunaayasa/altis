import { verifyReleaseWithRoots, type KeysetSource, type ReleaseManifest, type TrustedKey } from '@altis/crypto';
import { upsert, withTx, type DB, type DbHandle } from '@altis/db';
import type { CurrentState } from '@altis/platform';
import { isTerminal } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { notify as notifyFn } from '../notifications/service.js';
import type { OpFile } from '../ops/files.js';
import { readSettings, writeSettings } from '../settings/service.js';
import { candidateOf, type Candidate } from './candidate.js';
import type { PrecheckFailure } from './precheck.js';

// A bundled release that differs from the running one (spec §9.8; plan Task 27; decision D1d-24; preflight B7, S9,
// S12, 1D-04). app.js classifies it (bundled.ts of the bootloader) and hands the server `ctx.bundledRelease` (rows 1,
// 2 and 4) or boots it in `schemaHold` (row 3); what to do about it is decided here, in server.mjs:
//
// - Row 1 ({@link bundledUpdatePlan}): a newer bundled release, not pinned, not failed before, no op running → the full
//   prechecks of §9.6 step 2 on its verified manifest ({@link bundledCandidate}), then an `update` op (source
//   `bundled`) begun at `verified`. Image mode never begins one (§9.8: one-click updates are hidden there; every new
//   image passes row 3).
// - Row 2: failed prechecks → `update.bundled_blocked {version, at, failures}` and one `update_blocked` notification per
//   version ({@link recordBundledBlocked}); the release keeps serving.
// - Row 3 (`schemaHold`): before anything else, a version whose update failed before (a `releases_log` row `aborted`,
//   `rolled_back`, `restored` or `restore_failed`, or an op.json update of it that ended otherwise than `done`) begins
//   nothing again ({@link failedBefore}, 1D-04): a restart of the same image never migrates a half-migrated database a
//   second time, and never makes a new `pre_update` backup that retention could trade for the good one. The
//   instruction then names the `pre_update` backup of that failure ({@link schemaHoldInstruction}).
// - Row 4: older or the same → nothing (Diagnostik shows it, Task 29).

/** The `releases_log` statuses of an update that failed: such a version is not begun again on its own (D1d-24). */
export const UPDATE_FAILED_STATUSES: ReadonlySet<string> = new Set(['aborted', 'rolled_back', 'restored', 'restore_failed']);

/** What row 1 does about the bundled release (D1d-24): begin an update, nothing, or say why not. */
export type BundledUpdatePlan = 'begin' | 'none' | 'failed_before' | 'pinned';

/**
 * Row 1's decision (D1d-24): `begin` needs a newer bundled release in data mode, no active op, `pinned` other than its
 * version, and no failed update of it (`lastAttempt`: the version's failed `releases_log` row if any, else its latest
 * row). A pin wins over a failure; an active op hides neither.
 */
export function bundledUpdatePlan(o: {
  bundled: { version: string; relation: 'newer' | 'same' | 'older' } | undefined;
  state: CurrentState;
  mode: 'data' | 'image';
  lastAttempt: { status: string } | null;
  opActive: boolean;
}): BundledUpdatePlan {
  const b = o.bundled;
  if (b === undefined || b.relation !== 'newer' || o.mode === 'image') return 'none';
  if (o.state.pinned === b.version) return 'pinned';
  if (o.lastAttempt !== null && UPDATE_FAILED_STATUSES.has(o.lastAttempt.status)) return 'failed_before';
  if (o.opActive) return 'none';
  return 'begin';
}

type Db = Kysely<DB> | Transaction<DB>;

/** One `releases_log` row of an update of a version, as §9.8 reads it. */
export interface UpdateAttempt {
  id: string;
  status: string;
  startedAt: number;
  backupId: string | null;
}

/**
 * The update attempt of `version` that decides §9.8 (D1d-24): its newest failed `releases_log` row when there is one,
 * else its newest row, else null.
 */
export async function bundledAttempt(db: Db, version: string): Promise<UpdateAttempt | null> {
  const rows = await db
    .selectFrom('releases_log')
    .select(['id', 'status', 'started_at', 'backup_id'])
    .where('version', '=', version)
    .where('action', '=', 'update')
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const pick = rows.find((r) => UPDATE_FAILED_STATUSES.has(r.status)) ?? rows[0];
  return pick === undefined ? null : { id: pick.id, status: pick.status, startedAt: Number(pick.started_at), backupId: pick.backup_id };
}

/**
 * Whether `version` failed before (1D-04, D1d-24): a failed `releases_log` row of it, or an op.json update of it that
 * ended otherwise than `done` (an op that has not ended is not a failure: the boot plan resumes it). `backupId` is the
 * `pre_update` backup of that failure (the row's, else the op's), what the instruction names; null for an update that
 * ended `aborted`, before its point of no return: the database was never changed, and the op abandoned that backup
 * (kind.ts cleanup), so there is nothing to restore. `from` is the release the failed update left, when the op names it.
 */
export async function failedBefore(
  db: Db,
  version: string,
  op: OpFile | 'corrupt' | null,
): Promise<{ failed: boolean; backupId: string | null; from: string | null; status: string | null }> {
  const attempt = await bundledAttempt(db, version);
  const rowFailed = attempt !== null && UPDATE_FAILED_STATUSES.has(attempt.status);
  const ofVersion = op !== null && op !== 'corrupt' && op.kind === 'update' && op.params['target'] === version ? op : null;
  const opFailed = ofVersion !== null && isTerminal(ofVersion.kind, ofVersion.state) && ofVersion.state !== 'done';
  const from = ofVersion !== null && typeof ofVersion.params['from'] === 'string' ? ofVersion.params['from'] : null;
  const status = rowFailed ? attempt.status : opFailed ? ofVersion.state : null;
  const named = (rowFailed ? attempt.backupId : null) ?? (opFailed ? ofVersion.backupId : null);
  return { failed: rowFailed || opFailed, backupId: status === 'aborted' ? null : named, from, status };
}

/**
 * The manifest of the bundled release folder `dir`, verified `all` with the installation's keys (S9: the folder itself
 * is checked, not only its manifest), and its candidate: `size` is the sum of the manifest's file sizes.
 *
 * @throws `Error('RELEASE_INVALID:<reason>')` when the folder does not verify
 */
export async function bundledCandidate(
  dir: string,
  keys: { roots: readonly TrustedKey[]; sources: KeysetSource[]; refuseDevKids: boolean },
): Promise<{ manifest: ReleaseManifest; candidate: Candidate }> {
  const manifest = await verifyReleaseWithRoots(dir, keys.roots.slice(), { check: 'all', sources: keys.sources, refuseDevKids: keys.refuseDevKids });
  return { manifest, candidate: candidateOf(manifest, manifest.files.reduce((sum, f) => sum + f.size, 0)) };
}

/** At most this many failures are recorded (the setting's bound). */
const FAILURES_MAX = 8;

/**
 * Row 2 (and row 3's failed prechecks): `update.bundled_blocked` = `{version, at, failures}` and, the first time this
 * version is blocked, one `update_blocked` notification to `system.update.run`, in one transaction. Review L05 (P6):
 * every process that starts records it, so the row is locked first (created with the setting's default, the JSON
 * `null`, when absent; as the update check locks `update.notified`): a second process waits for the first one's commit
 * and then reads what it wrote (PostgreSQL READ COMMITTED; MySQL/MariaDB take their snapshot at the first read, after
 * the lock; SQLite writes one transaction at a time), so a version is notified once.
 *
 * @returns whether the notification went out (false: this version was blocked before)
 */
export async function recordBundledBlocked(
  h: DbHandle,
  o: { version: string; failures: readonly PrecheckFailure[] | readonly string[]; now: number; notify?: typeof notifyFn },
): Promise<boolean> {
  const send = o.notify ?? notifyFn;
  return withTx(h, async (trx) => {
    const lock = { value: 'null', is_secret: 0, scope: 'instance' as const, updated_at: o.now, updated_by: null };
    await upsert(trx, 'settings', { key: 'update.bundled_blocked' }, lock, { scope: 'instance' }); // first: the row lock
    const before = (await readSettings(trx, ['update.bundled_blocked'], []))['update.bundled_blocked'] as { version: string } | null;
    const value = { version: o.version, at: o.now, failures: o.failures.slice(0, FAILURES_MAX) };
    await writeSettings(trx, { 'update.bundled_blocked': value }, { keyring: [], now: o.now, actorId: null });
    if (before !== null && before.version === o.version) return false;
    // The notification last: its event is the transaction's last statement (§10.6).
    await send(
      trx,
      {
        audience: { permission: 'system.update.run' },
        type: 'update.blocked',
        titleKey: 'notification.update_blocked.title',
        params: { version: o.version },
        link: '/admin/updates',
      },
      o.now,
    );
    return true;
  });
}

/** Clears `update.bundled_blocked` when it names `version` (its update was begun after all). */
export async function clearBundledBlocked(h: DbHandle, version: string, now: number): Promise<void> {
  await withTx(h, async (trx) => {
    const before = (await readSettings(trx, ['update.bundled_blocked'], []))['update.bundled_blocked'] as { version: string } | null;
    if (before === null || before.version !== version) return;
    await writeSettings(trx, { 'update.bundled_blocked': null }, { keyring: [], now, actorId: null });
  });
}

/**
 * The instruction of a `schemaHold` that failed (§9.8 row 3 "jalankan lagi image/zip versi sebelumnya, lalu pulihkan
 * backup `pre_update`"), bilingual, at most 2000 characters (op.json's bound): with a backup, run the previous image or
 * zip again, switch maintenance off (the failure keeps its flag up, and `backup:restore` refuses under maintenance, as
 * /admin/_update's CLI lines say) and restore that backup; without one (the update failed before it changed the
 * database), run the previous image or zip again and switch maintenance off.
 */
export function schemaHoldInstruction(o: { version: string; from: string | null; backupId: string | null }): string {
  const previous = o.from === null ? '' : ` (${o.from})`;
  if (o.backupId !== null) {
    return (
      `Pembaruan database ke versi ${o.version} gagal; ALTIS tetap dalam pemeliharaan. Jalankan lagi image/zip versi ` +
      `sebelumnya${previous}, matikan pemeliharaan, lalu pulihkan backup pre_update ${o.backupId}: ` +
      `node app.js maintenance:off, lalu node app.js backup:restore ${o.backupId} / ` +
      `The database update to version ${o.version} failed; ALTIS stays in maintenance. Run the image/zip of the previous ` +
      `version${previous} again, switch maintenance off, then restore the pre_update backup ${o.backupId}: ` +
      `node app.js maintenance:off, then node app.js backup:restore ${o.backupId}`
    );
  }
  return (
    `Pembaruan ke versi ${o.version} gagal sebelum database diubah; ALTIS tetap dalam pemeliharaan. Jalankan lagi ` +
    `image/zip versi sebelumnya${previous}, lalu matikan pemeliharaan: node app.js maintenance:off / ` +
    `The update to version ${o.version} failed before the database was changed; ALTIS stays in maintenance. Run the ` +
    `image/zip of the previous version${previous} again, then switch maintenance off: node app.js maintenance:off`
  );
}
