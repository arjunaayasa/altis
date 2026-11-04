import type { DB } from '@altis/db';
import { isSemver, isUlid } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';

// `releases_log` (spec §9.6 step 7, §9.7; decision D1d-38; preflight B7): one row per update or rollback op, whose id
// is the op's id. The update op inserts it `running` at its first step (`checking`, or `verified` for an op begun
// there), and the op's end sets its final status. Retention reads its `done` rows (a `pre_update` backup goes after
// two later updates), Pembaruan lists them (`GET updates/history`), and §9.8's bundled-release rule reads the last
// row of a version (a version whose update failed is not begun again on its own).
//
// The row is idempotent by op id: an insert of an id already present does nothing, so a step that runs again (P7),
// `cancel` and `finishUpdate` may all insert it when absent. A final status is never changed again.

type Db = Kysely<DB> | Transaction<DB>;

export type ReleaseLogAction = 'update' | 'rollback';

export type ReleaseLogStatus = 'running' | 'done' | 'aborted' | 'rolled_back' | 'restored' | 'restore_failed' | 'failed';

/** The statuses that end a row: once set, nothing changes the row's status again. */
export const RELEASE_LOG_FINAL: ReadonlySet<string> = new Set(['done', 'aborted', 'rolled_back', 'restored', 'restore_failed', 'failed']);

/** The widths of the version columns (0007: `varchar(32)`). */
const VERSION_MAX = 32;
/** The longest `detail` (JSON text) a row keeps. */
const DETAIL_MAX = 4000;

/** One `releases_log` row as the update code reads it. */
export interface ReleaseLogRow {
  id: string;
  version: string;
  action: string;
  fromVersion: string | null;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  backupId: string | null;
  detail: Record<string, unknown> | null;
}

function checkVersion(name: string, value: unknown): string {
  if (typeof value !== 'string' || !isSemver(value) || value.length > VERSION_MAX) {
    throw new TypeError(`releases_log: ${name} must be a SemVer version of at most ${VERSION_MAX} characters, got ${JSON.stringify(value)}`);
  }
  return value;
}

function checkId(name: string, value: unknown): string {
  if (typeof value !== 'string' || !isUlid(value)) throw new TypeError(`releases_log: ${name} must be a ULID, got ${JSON.stringify(value)}`);
  return value;
}

function checkTime(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`releases_log: ${name} must be epoch ms, got ${String(value)}`);
  }
  return value;
}

/** `detail` as the column keeps it: JSON text of at most {@link DETAIL_MAX} characters (a longer one is cut down). */
function detailText(detail: Record<string, unknown>): string {
  const text = JSON.stringify(detail);
  if (text.length <= DETAIL_MAX) return text;
  return JSON.stringify({ truncated: true });
}

/**
 * Inserts the `running` row of op `r.id` unless a row of that id exists (then nothing happens: idempotent by op id).
 *
 * @throws TypeError for an id or backup id that is not a ULID, a version that is not SemVer (or is longer than the
 *   column), a time that is not epoch ms
 */
export async function insertReleaseLog(
  trx: Db,
  r: { id: string; version: string; action: ReleaseLogAction; fromVersion: string; startedAt: number; backupId: string | null },
): Promise<void> {
  const id = checkId('id', r.id);
  const version = checkVersion('version', r.version);
  const fromVersion = checkVersion('fromVersion', r.fromVersion);
  const startedAt = checkTime('startedAt', r.startedAt);
  if (r.action !== 'update' && r.action !== 'rollback') throw new TypeError(`releases_log: unknown action ${JSON.stringify(r.action)}`);
  const backupId = r.backupId === null ? null : checkId('backupId', r.backupId);
  const found = await trx.selectFrom('releases_log').select('id').where('id', '=', id).executeTakeFirst();
  if (found !== undefined) return;
  await trx
    .insertInto('releases_log')
    .values({
      id,
      version,
      action: r.action,
      from_version: fromVersion,
      status: 'running',
      started_at: startedAt,
      finished_at: null,
      backup_id: backupId,
      detail: null,
    })
    .execute();
}

/**
 * Sets the status of row `id`, unless it has a final status already ({@link RELEASE_LOG_FINAL}): `o.finishedAt` when
 * given, `o.backupId` when given (null clears it), `o.detail` as JSON when given.
 *
 * @returns true when the row was changed; false when there is no such row or its status is final
 * @throws TypeError for an unknown status, an id or backup id that is not a ULID, a time that is not epoch ms
 */
export async function setReleaseLogStatus(
  trx: Db,
  id: string,
  status: ReleaseLogStatus,
  o: { finishedAt?: number; backupId?: string | null; detail?: Record<string, unknown> } = {},
): Promise<boolean> {
  checkId('id', id);
  if (status !== 'running' && !RELEASE_LOG_FINAL.has(status)) throw new TypeError(`releases_log: unknown status ${JSON.stringify(status)}`);
  const set: { status: string; finished_at?: number; backup_id?: string | null; detail?: string } = { status };
  if (o.finishedAt !== undefined) set.finished_at = checkTime('finishedAt', o.finishedAt);
  if (o.backupId !== undefined) set.backup_id = o.backupId === null ? null : checkId('backupId', o.backupId);
  if (o.detail !== undefined) set.detail = detailText(o.detail);
  const r = await trx
    .updateTable('releases_log')
    .set(set)
    .where('id', '=', id)
    .where('status', 'not in', [...RELEASE_LOG_FINAL])
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/** Row `id` of `releases_log`, or null. */
export async function readReleaseLog(db: Db, id: string): Promise<ReleaseLogRow | null> {
  const row = await db.selectFrom('releases_log').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) return null;
  let detail: Record<string, unknown> | null = null;
  if (row.detail !== null) {
    try {
      const parsed: unknown = JSON.parse(row.detail);
      detail = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      detail = null;
    }
  }
  return {
    id: row.id,
    version: row.version,
    action: row.action,
    fromVersion: row.from_version,
    status: row.status,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    backupId: row.backup_id,
    detail,
  };
}
