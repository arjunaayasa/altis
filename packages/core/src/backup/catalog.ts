import type { DB, Dialect } from '@altis/db';
import { isDomainError, isUlid } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { readManifest, verifyManifestHmac, type BackupKind, type BackupManifest } from './manifest.js';

// The backups list (the Backup screen, `GET backups`): the `backups` rows (history: kept by a restore, never deleted,
// a removed backup keeps its row with status `deleted`), each joined with its manifest when it has one.

/** One backup as the list shows it. */
export interface BackupItem {
  id: string;
  kind: BackupKind;
  status: 'running' | 'ok' | 'failed' | 'deleted' | 'uploaded';
  /** Bytes on disk once the backup is `ok` (or the uploaded archive's size); null before. */
  size: number | null;
  createdAt: number;
  consistency: 'snapshot' | 'frozen';
  /** The manifest says it holds the uploads' blobs. */
  includesFiles: boolean;
  /** An archive uploaded from elsewhere (kind `external`). */
  external: boolean;
  /** Its manifest carries this installation's HMAC (an uploaded archive is checked when it is restored). */
  sameInstall: boolean;
  schemaVersion: string;
  appVersion: string;
  dialect: Dialect;
}

/** The manifest of a backup row when it has a readable one; null otherwise (unfinished, uploaded, gone, damaged). */
async function manifestOf(dataDir: string, id: string): Promise<BackupManifest | null> {
  if (!isUlid(id)) return null;
  try {
    return await readManifest(dataDir, id);
  } catch (error) {
    // A damaged manifest shows as a backup without one; the restore refuses it with its own error.
    if (isDomainError(error) && error.code === 'BACKUP_INVALID') return null;
    throw error;
  }
}

const ITEM_COLUMNS = ['id', 'kind', 'status', 'size', 'created_at', 'consistency', 'schema_version', 'app_version', 'dialect'] as const;

type ItemRow = { id: string; kind: string; status: string; size: number | null; created_at: number; consistency: string; schema_version: string; app_version: string; dialect: string };

/** A `backups` row as the list shows it, with `includesFiles` and `sameInstall` from its manifest (unless deleted). */
async function itemOf(row: ItemRow, dataDir: string, sessionKey: Uint8Array): Promise<BackupItem> {
  const manifest = row.status === 'deleted' ? null : await manifestOf(dataDir, row.id);
  return {
    id: row.id,
    kind: row.kind as BackupKind,
    status: row.status as BackupItem['status'],
    size: row.size,
    createdAt: row.created_at,
    consistency: row.consistency as BackupItem['consistency'],
    includesFiles: manifest?.includesFiles ?? false,
    external: row.kind === 'external',
    sameInstall: manifest !== null && verifyManifestHmac(sessionKey, manifest),
    schemaVersion: row.schema_version,
    appVersion: row.app_version,
    dialect: row.dialect as Dialect,
  };
}

/**
 * Every `backups` row, newest first (`created_at`, then id), with `includesFiles` and `sameInstall` read from its
 * manifest (`backups/<id>/manifest.json`, HMAC checked with `sessionKey`). Rows without a manifest (running, failed,
 * deleted, uploaded) have both false.
 */
export async function listBackups(db: Kysely<DB> | Transaction<DB>, dataDir: string, sessionKey: Uint8Array): Promise<BackupItem[]> {
  const rows = await db.selectFrom('backups').select(ITEM_COLUMNS).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  const items: BackupItem[] = [];
  for (const row of rows) items.push(await itemOf(row, dataDir, sessionKey));
  return items;
}

/**
 * The newest backup that is not deleted, in {@link listBackups}' order and shape, or null: the one manifest the
 * dashboard and Diagnostik read per request (their reads stay cheap, however many backups are kept).
 */
export async function newestBackup(db: Kysely<DB> | Transaction<DB>, dataDir: string, sessionKey: Uint8Array): Promise<BackupItem | null> {
  const row = await db
    .selectFrom('backups')
    .select(ITEM_COLUMNS)
    .where('status', '!=', 'deleted')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? null : itemOf(row, dataDir, sessionKey);
}
