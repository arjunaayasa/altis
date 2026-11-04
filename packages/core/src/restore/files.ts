import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { readPkBatch, type DbHandle } from '@altis/db';
import { openRead, statOrNull, uploadPath } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import { localStorageDriver } from '../files/serve.js';
import type { RestoreSource } from './source.js';

// The uploads of a restored database (spec §9.10 "berkas", A6; decision C18; plan Task 22, `finalizing` step 3). Every
// `files` row with status `ok`, in primary-key order:
//
// - its upload already in place (`uploads/<yyyy>/<mm>/<id>` of the row's size and SHA-256: the same installation, or a
//   restore run again) → left as it is;
// - else the backup's blob of that SHA-256 → stored through the local storage driver, which checks size and SHA-256
//   before the file appears (a blob that does not match is not stored);
// - else (no blob, a damaged one, or a restore asked to go without files) → the row's status becomes `missing`. The
//   report's `files.missing` is read from those statuses at the end (finalize.ts restoredLists), so a step killed
//   after its UPDATE loses no id.
//
// A restore only adds files (C18): an upload of the target that the restored database does not name stays on disk.

/** Rows per keyset read of `files`. */
const FILES_BATCH = 200;
const READ_CHUNK_BYTES = 256 * 1024;

/** The SHA-256 (hex) of the file `p`. */
async function sha256Of(p: ReturnType<typeof uploadPath>): Promise<string> {
  const hash = createHash('sha256');
  const handle: FileHandle = await openRead(p);
  try {
    for (let position = 0; ; ) {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/** Whether the upload of `row` is in place: a regular file of its size and SHA-256. */
async function uploadInPlace(dataDir: string, row: { id: string; size: number; sha256: string }): Promise<boolean> {
  const info = await statOrNull(uploadPath(dataDir, row.id));
  if (info === null || info.kind !== 'file' || info.size !== row.size) return false;
  return (await sha256Of(uploadPath(dataDir, row.id))) === row.sha256;
}

/**
 * One step of the files of a restore after the `files` row `after` (null: from the first): rows until `o.stopAt` (at
 * least one). Missing ones are marked `missing`. Returns where it stopped (`done` after the last row).
 *
 * @throws DomainError DISK_QUOTA (P21) while storing a file; the database's errors
 */
export async function restoreFilesStep(
  work: DbHandle,
  source: RestoreSource | null,
  o: { dataDir: string; withoutFiles: boolean; stopAt: number; clock: () => number },
  after: string | null,
): Promise<{ done: boolean; after: string | null }> {
  const storage = localStorageDriver(o.dataDir);
  let last = after;
  let first = true;
  for (;;) {
    const batch = await readPkBatch(work.db, work.dialect, 'files', {
      after: last === null ? null : [last],
      limit: FILES_BATCH,
      columns: ['id', 'size', 'sha256', 'status'],
    });
    for (const raw of batch) {
      if (!first && o.clock() >= o.stopAt) return { done: false, after: last };
      first = false;
      const row = { id: String(raw['id']), size: Number(raw['size']), sha256: String(raw['sha256']), status: String(raw['status']) };
      last = row.id;
      if (row.status !== 'ok') continue;
      let ok = false;
      if (!o.withoutFiles) {
        ok = await uploadInPlace(o.dataDir, row);
        if (!ok && source !== null) {
          const blob = await source.blob(row.sha256);
          if (blob !== null && blob.size === row.size) {
            try {
              await storage.put(row.id, blob.bytes(), { size: row.size, sha256: row.sha256 });
              ok = true;
            } catch (error) {
              if (!(isDomainError(error) && error.code === 'UPLOAD_MISMATCH')) throw error;
            }
          }
        }
      }
      if (ok) continue;
      await work.db.updateTable('files').set({ status: 'missing' }).where('id', '=', row.id).execute();
    }
    if (batch.length < FILES_BATCH) return { done: true, after: last };
  }
}
