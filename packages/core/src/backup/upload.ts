import type { DB, Dialect } from '@altis/db';
import { copyFileTo, dataPath, removeFile, removeTree, renameRetry, statOrNull, type DataPath } from '@altis/platform';
import { DomainError, isDomainError, isUlid } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { readAltisbakHeader, type AltisbakHeader } from '../archive/altisbak.js';
import type { TxCtx } from '../context.js';
import { takeStagedUpload } from '../files/uploads.js';
import type { BackupItem } from './catalog.js';

// An uploaded `.altisbak` archive becomes a backup (spec §9.10, §13.5 `POST backups/upload`; preflight S15; plan
// Task 21). The route, in this order:
//
// 1. uploadedArchiveSource: the staged file of the subject's own upload (context `backup`, every byte received), read
//    outside any transaction;
// 2. readUploadedHeader: its clear header `altisbak.json` (no passphrase needed, S15): the format, and the four
//    descriptive fields the `backups` row needs (all NOT NULL in 0007);
// 3. registerUploadedBackup, in the route's transaction: takeStagedUpload (context `backup`) and the row `kind
//    'external'`, `status 'uploaded'`, under the upload's own id (a ULID nobody else holds), with the archive's size
//    and SHA-256 as the upload verified them (insertExternalBackupRow, which the CLI's `backup:restore <file>` shares
//    for an operator's file, 1d T29-CLI-REGISTER-AUDIT);
// 4. moveUploadedArchive after COMMIT (R37, D3: no file work in a re-runnable transaction): `tmp/<id>/upload.bin` →
//    `backups/<id>/archive.altisbak`, idempotent by the upload id.
//
// A request repeated after its COMMIT (its answer, or the move, was lost: P7) finds the row: step 1 reads the archive
// where it is now, step 3 returns the row as it is, step 4 finishes the move. Only the uploader repeats it: the upload
// session is gone by then, so the owner is the actor of the route's `backup.upload` entry for the backup (entity
// `backups`, written in the transaction that made the row); anyone else gets NOT_FOUND, as for an upload of someone
// else's. The route counts that entry as the repeat's own (rc.auditedBefore), so a resend appends none. Whether the
// archive carries this installation's HMAC is decided when it is restored: an encrypted manifest cannot be read
// without the passphrase.

/** The widths of `backups.app_version` and `backups.schema_version` (0007). */
const VERSION_COLUMN_MAX = 32;
/** A release version as a column holds it: printable ASCII. */
const PRINTABLE = /^[\x21-\x7e]+$/;
/** The route's audit entry of a registered upload: action and entity (entity id = the backup's id). */
const UPLOAD_AUDIT = { action: 'backup.upload', entity: 'backups' } as const;

type Db = Kysely<DB> | Transaction<DB>;

function notFound(): DomainError {
  return new DomainError('NOT_FOUND');
}

/**
 * Whether `owner` (`staff:<id>`) uploaded the registered backup `backupId`: the actor of its `backup.upload` entry. An
 * entry that audit retention has removed answers false (a repeat is meant for an answer lost moments ago).
 */
async function isUploader(db: Db, backupId: string, owner: string): Promise<boolean> {
  const staffId = owner.startsWith('staff:') ? owner.slice('staff:'.length) : '';
  if (!isUlid(staffId)) return false;
  const entry = await db
    .selectFrom('audit_log')
    .select('id')
    .where('action', '=', UPLOAD_AUDIT.action)
    .where('entity', '=', UPLOAD_AUDIT.entity)
    .where('entity_id', '=', backupId)
    .where('actor_type', '=', 'staff')
    .where('actor_id', '=', staffId)
    .limit(1)
    .executeTakeFirst();
  return entry !== undefined;
}

/** `backups/<backupId>/archive.altisbak`: where an uploaded archive is kept. */
export function uploadedArchivePath(dataDir: string, backupId: string): DataPath {
  return dataPath(dataDir, 'backups', backupId, 'archive.altisbak');
}

/** The staged file of upload `uploadId` (files/uploads.ts keeps it at `tmp/<id>/upload.bin`). */
function stagedArchivePath(dataDir: string, uploadId: string): DataPath {
  return dataPath(dataDir, 'tmp', uploadId, 'upload.bin');
}

/**
 * The clear header of the uploaded archive `path`, checked as `backups` row values: format `altis-backup/1` (the
 * guarded reader and the header schema), an `appVersion` and a `schemaVersion` of at most 32 printable characters.
 *
 * @throws DomainError BACKUP_INVALID (`format`, or the guarded reader's `path`, `entry`, `bomb`); NOT_FOUND when the
 *   file is gone
 */
export async function readUploadedHeader(path: DataPath): Promise<AltisbakHeader> {
  let header: AltisbakHeader;
  try {
    header = await readAltisbakHeader(path);
  } catch (error) {
    if (!isDomainError(error) && (error as { code?: unknown } | null)?.code === 'ENOENT') throw notFound();
    throw error;
  }
  for (const value of [header.appVersion, header.schemaVersion]) {
    if (value.length > VERSION_COLUMN_MAX || !PRINTABLE.test(value)) {
      throw new DomainError('BACKUP_INVALID', {
        detail:
          'Versi pada altisbak.json terlalu panjang atau tidak sah / The versions in altisbak.json are too long or not valid',
        meta: { reason: 'format' },
      });
    }
  }
  return header;
}

/**
 * The file to read the header of upload `uploadId` from: the staged file of `owner`'s upload in context `backup`
 * with every byte received; for an upload `owner` registered already (a repeated request), wherever its archive is now.
 *
 * @throws DomainError NOT_FOUND (no such upload of `owner` in context `backup`, nor such a backup of `owner`'s),
 *   UPLOAD_INCOMPLETE
 */
export async function uploadedArchiveSource(db: Db, dataDir: string, o: { uploadId: string; owner: string }): Promise<DataPath> {
  if (!isUlid(o.uploadId)) throw notFound();
  const session = await db
    .selectFrom('upload_sessions')
    .select(['context', 'size', 'received'])
    .where('id', '=', o.uploadId)
    .where('owner', '=', o.owner)
    .executeTakeFirst();
  if (session !== undefined) {
    if (session.context !== 'backup') throw notFound();
    if (Number(session.received) !== Number(session.size)) {
      throw new DomainError('UPLOAD_INCOMPLETE', {
        detail: 'Unggahan belum diterima seluruhnya / The upload has not arrived in full',
      });
    }
    return stagedArchivePath(dataDir, o.uploadId);
  }
  const row = await db.selectFrom('backups').select('kind').where('id', '=', o.uploadId).executeTakeFirst();
  if (row?.kind !== 'external' || !(await isUploader(db, o.uploadId, o.owner))) throw notFound();
  const staged = stagedArchivePath(dataDir, o.uploadId);
  return (await statOrNull(staged)) === null ? uploadedArchivePath(dataDir, o.uploadId) : staged;
}

/** A `backups` row as the list shows it (an uploaded archive has no manifest to read). */
function itemOf(row: {
  id: string;
  kind: string;
  status: string;
  size: number | null;
  created_at: number;
  consistency: string;
  schema_version: string;
  app_version: string;
  dialect: string;
}): BackupItem {
  return {
    id: row.id,
    kind: row.kind as BackupItem['kind'],
    status: row.status as BackupItem['status'],
    size: row.size === null ? null : Number(row.size),
    createdAt: Number(row.created_at),
    consistency: row.consistency as BackupItem['consistency'],
    includesFiles: false,
    external: row.kind === 'external',
    sameInstall: false,
    schemaVersion: row.schema_version,
    appVersion: row.app_version,
    dialect: row.dialect as Dialect,
  };
}

/**
 * In `trx`: inserts the backup row of an `.altisbak` archive that came from outside (`kind 'external'`, `status
 * 'uploaded'`, the archive's size and SHA-256, the clear header's versions, dialect and consistency, created `now`)
 * under the id `id`, a ULID nobody else holds. Shared by the upload route (registerUploadedBackup, the upload's id)
 * and the CLI's `backup:restore <file>` (a new id; 1d T29-CLI-REGISTER-AUDIT, preflight S16), so both register the
 * same columns.
 *
 * @returns the row as the list shows it
 */
export async function insertExternalBackupRow(
  trx: Transaction<DB>,
  o: { id: string; size: number; sha256: string; header: AltisbakHeader; now: number },
): Promise<BackupItem> {
  const row = {
    id: o.id,
    kind: 'external',
    size: o.size,
    sha256: o.sha256,
    schema_version: o.header.schemaVersion,
    app_version: o.header.appVersion,
    dialect: o.header.dialect,
    consistency: o.header.consistency,
    status: 'uploaded',
    created_at: o.now,
  };
  await trx.insertInto('backups').values(row).execute();
  return itemOf(row);
}

/**
 * In the route's transaction `tx`: takes `owner`'s completed upload `uploadId` (context `backup`, takeStagedUpload)
 * and inserts its backup row (insertExternalBackupRow: id = the upload's id, the upload's size and SHA-256). For an
 * upload `owner` registered before (a repeated request) it returns that row. The file stays staged:
 * moveUploadedArchive after COMMIT.
 *
 * @throws DomainError NOT_FOUND (also for a backup someone else uploaded), UPLOAD_INCOMPLETE (takeStagedUpload)
 */
export async function registerUploadedBackup(
  tx: TxCtx,
  o: { uploadId: string; owner: string; dataDir: string; now: number; header: AltisbakHeader },
): Promise<BackupItem> {
  if (!isUlid(o.uploadId)) throw notFound();
  const trx = tx.trx;
  const existing = await trx.selectFrom('backups').selectAll().where('id', '=', o.uploadId).executeTakeFirst();
  if (existing !== undefined) {
    if (existing.kind !== 'external' || !(await isUploader(trx, o.uploadId, o.owner))) throw notFound();
    return itemOf(existing);
  }
  const taken = await takeStagedUpload(trx, { uploadId: o.uploadId, owner: o.owner, context: 'backup', dataDir: o.dataDir });
  return insertExternalBackupRow(trx, { id: o.uploadId, size: taken.size, sha256: taken.sha256, header: o.header, now: o.now });
}

/**
 * Moves the registered upload `uploadId`'s staged file to `backups/<id>/archive.altisbak` (a rename; across file
 * systems a copy, then the source removed) and removes its staging folder. Idempotent: a target already there with the
 * source gone counts as moved, and a target there beside its source (a copy whose source removal was lost) only loses
 * the source.
 *
 * @throws DomainError STATE_CORRUPT when neither file is there; DISK_QUOTA (P21) from a copy
 */
export async function moveUploadedArchive(dataDir: string, uploadId: string): Promise<void> {
  const from = stagedArchivePath(dataDir, uploadId);
  const to = uploadedArchivePath(dataDir, uploadId);
  if ((await statOrNull(from)) !== null) {
    if ((await statOrNull(to)) === null) {
      try {
        await renameRetry(from, to);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'EXDEV') throw error;
        await copyFileTo(from, to);
        await removeFile(from);
      }
    } else {
      await removeFile(from);
    }
  } else if ((await statOrNull(to)) === null) {
    throw new DomainError('STATE_CORRUPT', {
      detail: `Arsip unggahan ${uploadId} tidak ditemukan / The uploaded archive ${uploadId} is gone`,
      meta: { reason: 'upload_missing' },
    });
  }
  await removeTree(dataPath(dataDir, 'tmp', uploadId));
}
