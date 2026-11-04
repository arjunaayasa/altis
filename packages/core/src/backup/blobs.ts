import { createHash } from 'node:crypto';
import { copyFileTo, dataPath, listNames, openRead, removeFile, statOrNull, uploadPath, type DataPath } from '@altis/platform';
import { isUlid } from '@altis/shared';
import type { CoreLogger } from '../context.js';
import { referencedBlobs } from './blob-refs.js';

// Content-addressed upload blobs (spec §9.9): `backups/blobs/<sha256>`, shared by every backup that includes files,
// referred to by each manifest's `blobs` list and removed once no manifest refers to them. A blob is a hard link to
// the upload's file where the file system allows one (no space used; uploads are never changed in place), a copy
// otherwise (copyFileTo).
//
// A blob is the upload's bytes only when they still have the SHA-256 of its `files` row: linkBlob hashes the upload
// before it links or copies it, and the prepared download hashes each blob again before it goes into an archive (a hard
// link shares the upload's inode, so damage in place reaches the blob later). An upload or blob that does not match
// (bit rot, an in-place edit of the same size) is left out, and a restore marks that file `missing` (spec §9.10)
// instead of refusing the whole archive over one attachment. A blob is one upload of a `file` context (completeUpload
// copies such an upload whole too; 16 MiB at most today), so it is hashed whole within a slice.

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** What {@link linkBlob} needs of a `files` row. */
export interface BlobSource {
  id: string;
  size: number;
  sha256: string;
  status: string;
}

/** `backups/blobs/<sha256>`. @throws DomainError `INVALID_PATH_SEGMENT` when `sha256` is not 64 lower-case hex digits */
export function blobPath(dataDir: string, sha256: string): DataPath {
  return dataPath(dataDir, 'backups', 'blobs', sha256);
}

/** Whether `file` is a `files` row a backup takes a blob of: status `ok`, a ULID id and a SHA-256. */
export function blobWanted(file: BlobSource): boolean {
  return file.status === 'ok' && isUlid(file.id) && SHA256_HEX.test(file.sha256) && Number.isSafeInteger(file.size) && file.size >= 0;
}

/** Whether the blob of `file` is in place: a regular file of the row's size. */
export async function blobPresent(dataDir: string, file: Pick<BlobSource, 'sha256' | 'size'>): Promise<boolean> {
  const info = await statOrNull(blobPath(dataDir, file.sha256));
  return info !== null && info.kind === 'file' && info.size === file.size;
}

/** The SHA-256 (lower-case hex) of the bytes of the file `p`. */
export async function fileSha256(p: DataPath): Promise<string> {
  const hash = createHash('sha256');
  const handle = await openRead(p);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let position = 0; ; ) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * Puts the blob of the upload `file` in place unless it is there already (a regular file of the row's size): a hard
 * link to `uploads/<yyyy>/<mm>/<id>`, or a copy. An upload whose file is gone, has another size than its row says or
 * bytes of another SHA-256 gets no blob (a restore marks it `missing`, spec §9.10).
 *
 * @returns true when the blob is in place afterwards; false for a row {@link blobWanted} refuses or a missing upload
 * @throws DomainError `DISK_QUOTA` (P21) after removing the partial copy
 */
export async function linkBlob(dataDir: string, file: BlobSource): Promise<boolean> {
  if (!blobWanted(file)) return false;
  if (await blobPresent(dataDir, file)) return true;
  const source = uploadPath(dataDir, file.id);
  const info = await statOrNull(source);
  if (info === null || info.kind !== 'file' || info.size !== file.size) return false;
  if ((await fileSha256(source)) !== file.sha256) return false;
  await copyFileTo(source, blobPath(dataDir, file.sha256));
  return true;
}

/**
 * Removes every blob of `backups/blobs` that the manifest of none of the backups `kept` names (referencedBlobs, 1d
 * T20-BLOB-RULE-THREE-COPIES), and returns how many it removed. Pass every backup that is kept. While a kept backup's
 * manifest cannot be read it removes nothing (logged with `log`). Names that are not a SHA-256 (a copy's hidden
 * temporary file) are left alone.
 *
 * Run it only while no backup that includes files is between its `blobs` and `manifest` phases: such a backup's blobs
 * are not in any manifest yet. The retention runs it at the end of a backup (backups never run two at a time: the
 * `backup:snapshot` lock and the ops lock); the files cleanup removes the same blobs while it holds `backup:snapshot`
 * itself (housekeeping/files.ts).
 */
export async function gcBlobs(dataDir: string, kept: readonly { id: string }[], log?: CoreLogger): Promise<number> {
  const { blobs: referenced, unreadable } = await referencedBlobs(dataDir, kept);
  if (unreadable.length > 0) {
    log?.warn('backup: a kept backup has no readable manifest; its upload blobs cannot be told apart, none is removed', { backupIds: unreadable });
    return 0;
  }
  let removed = 0;
  for (const name of await listNames(dataPath(dataDir, 'backups', 'blobs'))) {
    if (!SHA256_HEX.test(name) || referenced.has(name)) continue;
    await removeFile(blobPath(dataDir, name));
    removed += 1;
  }
  return removed;
}
