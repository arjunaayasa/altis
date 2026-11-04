import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { openRead, openUnderRoot, realPathOf, type DataPath } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { SlimsFileTooLargeError, type SlimsFilesSource } from './types.js';

// The attachment, cover and content files of a SLiMS install (spec §11.1): the uploaded zip (`slims.files`, read with
// yauzl) or, from the CLI only, the SLiMS folder itself (`--files-dir`, every file bounded by the folder's real path,
// @altis/platform openUnderRoot). Paths are SLiMS-relative and `/`-separated: `repository/<dir>/<name>`,
// `images/docs/<image>`, `images/content/<image>`. They come from SLiMS data, so they are untrusted.
//
// Zip: the central directory is read once; an entry is served only when its name is a plain relative path (no empty,
// `.` or `..` segment, no leading `/`, drive letter, backslash or NUL), it is a regular file (not a link, folder or
// device by its attributes, not a name ending in `/`), it is not encrypted, it is stored or deflated, and no other
// entry has its name. Every other entry is never served (a SLiMS zip made by hand often holds folder entries, so the
// archive itself is not refused for them). A zip whose SLiMS folder sits inside a top folder (`slims9/repository/...`)
// is read from that folder: the shallowest one holding `repository/`, `images/docs/` or `images/content/` (a zip of a
// whole SLiMS install holds other `images/` folders too), and a zip with two such folders side by side is refused. A name not found as written is looked up again ignoring letter case, when exactly one
// entry matches (files copied from a Windows install).
//
// Sizes (S10): entries are opened only on request; `open(rel, {maxBytes})` makes the iterator throw
// SlimsFileTooLargeError when the declared size, or the bytes actually produced, pass `maxBytes`; yauzl's
// `validateEntrySizes` stays on, so an entry that inflates past its own declared size throws it too. A whole read is
// checked against the entry's CRC-32 after its last byte (a damaged entry throws then).

/** The most entries a files zip may hold. */
export const FILES_ZIP_MAX_ENTRIES = 500_000;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const UNIX_HOSTS: ReadonlySet<number> = new Set([3, 19]);
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const DOS_DIRECTORY = 0x10;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const READ_CHUNK = 64 * 1024;

function unsupported(reason: string, cause?: unknown): DomainError {
  return new DomainError('MIGRATION_SOURCE_UNSUPPORTED', {
    detail: 'Berkas SLiMS tidak dapat dibaca / The SLiMS files cannot be read',
    meta: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** A plain relative `/`-separated path (no empty, `.` or `..` segment, no leading `/`, drive letter, `\` or NUL). */
export function safeRelativePath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel === '' || rel.length > 4096) return false;
  if (rel.includes('\\') || rel.includes(String.fromCharCode(0)) || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The entry's name: UTF-8 when its bytes are valid UTF-8 (flagged or not), else its bytes one by one. */
function entryName(entry: Entry): string {
  const raw = entry.fileName;
  if (typeof raw === 'string') return raw;
  try {
    return UTF8.decode(raw);
  } catch {
    return (entry.generalPurposeBitFlag & FLAG_UTF8) !== 0 ? '' : raw.toString('latin1');
  }
}

function regularFile(entry: Entry, name: string): boolean {
  const attributes = entry.externalFileAttributes >>> 0;
  if (UNIX_HOSTS.has(entry.versionMadeBy >>> 8)) {
    const type = (attributes >>> 16) & S_IFMT;
    if (type !== 0 && type !== S_IFREG) return false;
  }
  return (attributes & DOS_DIRECTORY) === 0 && !name.endsWith('/');
}

function servable(entry: Entry): boolean {
  if ((entry.generalPurposeBitFlag & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) return false;
  return entry.compressionMethod === 0 || entry.compressionMethod === 8;
}

function openZip(fd: number): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromFd(fd, { lazyEntries: true, validateEntrySizes: true, autoClose: false, decodeStrings: false }, (error, zip) =>
      error || zip === undefined ? reject(error ?? new Error('no zipfile')) : resolve(zip),
    );
  });
}

function readDirectory(zip: ZipFile, onEntry: (entry: Entry) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    zip.on('error', (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    zip.on('entry', (entry: Entry) => {
      if (settled) return;
      onEntry(entry);
      zip.readEntry();
    });
    zip.once('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.readEntry();
  });
}

function openStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => (error || stream === undefined ? reject(error ?? new Error('no stream')) : resolve(stream)));
  });
}

/** A name inside a SLiMS data folder: the folders before the first `repository/`, `images/docs/` or `images/content/`. */
const SLIMS_DATA_FOLDER = /^((?:[^/]+\/)*?)(?:repository|images\/(?:docs|content))\//i;

/** The characters of a folder name the ambiguity's detail shows at most. */
const SHOWN_FOLDER_MAX = 64;

/** A folder name of the zip as the ambiguity's detail shows it: without control or bidi characters, cut. */
function shownFolder(prefix: string): string {
  return Array.from(prefix.replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ''))
    .slice(0, SHOWN_FOLDER_MAX)
    .join('');
}

/**
 * The prefix (`<top>/`) under which the zip holds the SLiMS folder, '' when it holds it at its root (or holds none): the
 * shallowest folder that holds a SLiMS data folder (`repository/`, `images/docs/`, `images/content/`). Any other
 * `images/` (a theme's, a JS library's) and macOS's `__MACOSX/` never count, wherever the zip lists them.
 *
 * @throws DomainError `MIGRATION_SOURCE_UNSUPPORTED` (`files_zip_ambiguous`) when two folders of that depth both hold one;
 *   its detail (the run's report, C18) names the first two, so the admin knows what to take out of the archive
 */
function slimsPrefix(names: readonly string[]): string {
  let best: string | null = null;
  let depth = Infinity;
  let other: string | null = null;
  for (const name of names) {
    if (name.startsWith('__MACOSX/')) continue;
    const m = SLIMS_DATA_FOLDER.exec(name);
    if (m === null) continue;
    const prefix = m[1]!;
    const d = prefix.split('/').length;
    if (d < depth) {
      best = prefix;
      depth = d;
      other = null;
    } else if (d === depth && prefix !== best && other === null) {
      other = prefix;
    }
  }
  if (other !== null) {
    const both = `${shownFolder(best!)}, ${shownFolder(other)}`;
    throw new DomainError('MIGRATION_SOURCE_UNSUPPORTED', {
      detail: `Arsip berkas memuat dua folder SLiMS (${both}); unggah satu saja / The files archive holds two SLiMS folders (${both}); upload one only`,
      meta: { reason: 'files_zip_ambiguous' },
    });
  }
  return best ?? '';
}

/**
 * The files of the uploaded SLiMS files archive at `path` (see the module comment).
 *
 * @throws DomainError `MIGRATION_SOURCE_UNSUPPORTED` (`meta.reason` `files_zip_invalid`: not a readable zip;
 *   `files_zip_too_many_entries`: more than {@link FILES_ZIP_MAX_ENTRIES} entries; `files_zip_ambiguous`: two SLiMS
 *   folders side by side)
 */
export async function openFilesZip(path: DataPath): Promise<SlimsFilesSource> {
  const handle = await openRead(path);
  try {
    let zip: ZipFile;
    try {
      zip = await openZip(handle.fd);
    } catch (error) {
      throw unsupported('files_zip_invalid', error);
    }
    if (zip.entryCount > FILES_ZIP_MAX_ENTRIES) throw unsupported('files_zip_too_many_entries');
    const all: { name: string; entry: Entry }[] = [];
    try {
      await readDirectory(zip, (entry) => all.push({ name: entryName(entry), entry }));
    } catch (error) {
      throw unsupported('files_zip_invalid', error);
    }
    const counts = new Map<string, number>();
    for (const { name } of all) counts.set(name, (counts.get(name) ?? 0) + 1);
    const prefix = slimsPrefix(all.map((a) => a.name));
    const byName = new Map<string, Entry>();
    const byFolded = new Map<string, Entry[]>();
    for (const { name, entry } of all) {
      if (!name.startsWith(prefix) || counts.get(name) !== 1) continue;
      const rel = name.slice(prefix.length);
      if (!safeRelativePath(rel) || !safeRelativePath(name) || !regularFile(entry, name) || !servable(entry)) continue;
      byName.set(rel, entry);
      const folded = rel.toLowerCase();
      byFolded.set(folded, [...(byFolded.get(folded) ?? []), entry]);
    }
    const find = (rel: string): Entry | null => {
      if (!safeRelativePath(rel)) return null;
      const exact = byName.get(rel);
      if (exact !== undefined) return exact;
      const folded = byFolded.get(rel.toLowerCase());
      return folded !== undefined && folded.length === 1 ? folded[0]! : null;
    };
    let closed = false;

    async function* entryBytes(rel: string, entry: Entry, maxBytes: number | undefined): AsyncGenerator<Uint8Array> {
      if (closed) throw new TypeError('SlimsFilesSource: the source is closed');
      if (maxBytes !== undefined && entry.uncompressedSize > maxBytes) throw new SlimsFileTooLargeError(rel, maxBytes);
      let stream: Readable;
      try {
        stream = await openStream(zip, entry);
      } catch (error) {
        throw new Error(`SLiMS file ${JSON.stringify(rel)} is unreadable`, { cause: error });
      }
      let produced = 0;
      let crc = 0;
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          produced += chunk.length;
          if (maxBytes !== undefined && produced > maxBytes) throw new SlimsFileTooLargeError(rel, maxBytes);
          crc = crc32(chunk, crc);
          yield chunk;
        }
        if (crc >>> 0 !== entry.crc32 >>> 0) throw new Error('CRC-32 mismatch');
      } catch (error) {
        if (error instanceof SlimsFileTooLargeError) throw error;
        const message = error instanceof Error ? error.message : '';
        // validateEntrySizes: the entry inflates past the size it declares.
        if (message.startsWith('too many bytes in the stream')) throw new SlimsFileTooLargeError(rel, maxBytes ?? entry.uncompressedSize);
        throw new Error(`SLiMS file ${JSON.stringify(rel)} is unreadable`, { cause: error });
      } finally {
        stream.destroy();
      }
    }

    return {
      async open(rel, o = {}) {
        const entry = find(rel);
        return entry === null ? null : entryBytes(rel, entry, o.maxBytes);
      },
      async size(rel) {
        const entry = find(rel);
        return entry === null ? null : entry.uncompressedSize;
      },
      async close() {
        if (closed) return;
        closed = true;
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** `root/rel` opened through openUnderRoot, or null for a path that is not served (missing, refused, not a file). */
async function openServed(root: string, rel: string): Promise<FileHandle | null> {
  if (!safeRelativePath(rel)) return null;
  try {
    return await openUnderRoot(root, rel);
  } catch (error) {
    if (isDomainError(error) && error.code === 'INVALID_PATH_SEGMENT') return null;
    throw error;
  }
}

/**
 * The files of the SLiMS folder `root` on this machine (CLI `--files-dir` only): each file is reached through
 * openUnderRoot, so its real path must lie inside the folder's (a link out of it is not served). A file is opened
 * again when it is read, so an iterator that is never read holds nothing open.
 *
 * @throws DomainError `MIGRATION_SOURCE_UNSUPPORTED` (`meta.reason` `files_dir_missing`) when the folder does not exist
 */
export async function openFilesDir(root: string): Promise<SlimsFilesSource> {
  if ((await realPathOf(root)) === null) throw unsupported('files_dir_missing');

  async function* fileBytes(rel: string, maxBytes: number | undefined): AsyncGenerator<Uint8Array> {
    const handle = await openServed(root, rel);
    if (handle === null) throw new Error(`SLiMS file ${JSON.stringify(rel)} disappeared`);
    try {
      const size = (await handle.stat()).size;
      if (maxBytes !== undefined && size > maxBytes) throw new SlimsFileTooLargeError(rel, maxBytes);
      let produced = 0;
      for (;;) {
        const buffer = Buffer.alloc(READ_CHUNK);
        const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, produced);
        if (bytesRead === 0) break;
        produced += bytesRead;
        if (maxBytes !== undefined && produced > maxBytes) throw new SlimsFileTooLargeError(rel, maxBytes);
        yield buffer.subarray(0, bytesRead);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    async open(rel, o = {}) {
      const handle = await openServed(root, rel);
      if (handle === null) return null;
      await handle.close().catch(() => undefined);
      return fileBytes(rel, o.maxBytes);
    },
    async size(rel) {
      const handle = await openServed(root, rel);
      if (handle === null) return null;
      try {
        return (await handle.stat()).size;
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    async close() {},
  };
}
