import { isDomainError, isUlid } from '@altis/shared';
import { readManifest } from './manifest.js';

// The one rule for which upload blobs a backup still needs (spec §9.9; 1d, T20-BLOB-RULE-THREE-COPIES): a blob
// (`backups/blobs/<sha256>`) is referenced while the manifest of a kept backup names it, and while a kept backup's
// manifest cannot be read its blobs cannot be told apart, so no blob may go at all. The three collectors share it:
// gcBlobs (blobs.ts), the backup retention's collectBlobs (retention.ts) and the files cleanup's `blobs` phase
// (housekeeping/files.ts).

/** What {@link referencedBlobs} found. */
export interface BlobReferences {
  /** The SHA-256 of every blob a readable kept manifest names. */
  blobs: Set<string>;
  /**
   * The kept backups whose manifest cannot be read (missing, not a manifest, an id that is not a ULID), in the order
   * given. While any is listed, the caller removes no blob.
   */
  unreadable: string[];
}

/**
 * The blobs the manifests of the backups `kept` name (the caller's kept set: today every `ok` backup), and the kept
 * backups whose manifest cannot be read (see the top of this file).
 *
 * @throws what reading a manifest throws besides a DomainError (an I/O failure): the caller then removes nothing either
 */
export async function referencedBlobs(dataDir: string, kept: readonly { id: string }[]): Promise<BlobReferences> {
  const blobs = new Set<string>();
  const unreadable: string[] = [];
  for (const { id } of kept) {
    if (!isUlid(id)) {
      unreadable.push(id);
      continue;
    }
    let manifest;
    try {
      manifest = await readManifest(dataDir, id);
    } catch (error) {
      if (!isDomainError(error)) throw error;
      manifest = null;
    }
    if (manifest === null) {
      unreadable.push(id);
      continue;
    }
    for (const blob of manifest.blobs) blobs.add(blob.sha256);
  }
  return { blobs, unreadable };
}
