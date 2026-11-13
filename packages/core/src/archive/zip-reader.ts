import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { openRead, type DataPath } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import yauzl, { type Entry, type ReadStreamOptions, type ZipFile } from 'yauzl';

// The guarded zip reader (spec §7.5 "Ekstraksi arsip", §9.10, A6): yauzl over a file handle that @altis/platform
// opened (M17), so no computed path reaches the file system outside platform. Every entry of the central directory
// is checked before anything is read, and the whole archive is refused (DomainError BACKUP_INVALID, `meta.reason`)
// at the first entry that is:
//
//   reason `path`    an empty name, an absolute path, a `..` segment, a backslash, a drive letter, a NUL, or a name
//                    flagged UTF-8 that is not;
//   reason `entry`   a symbolic link, folder, FIFO or other non-regular entry by its external attributes (or a name
//                    ending in `/`), a name the caller's allowlist refuses, or a name seen before;
//   reason `format`  encrypted (traditional or strong, or a masked central directory), compressed with anything but
//                    stored (0) or deflate (8), more entries than `maxEntries`, or not a readable zip at all;
//   reason `bomb`    a deflate entry declaring more than `maxRatio` (default 10) times its compressed size, or entries
//                    whose data overlap (the overlapping-file zip bomb).
//
// Names are decoded here, not by yauzl (`decodeStrings: false`): the checks see the bytes the archive holds, and an
// Info-ZIP Unicode-path extra field cannot show yauzl another name than the one checked. Reading checks again what
// the directory promised: a deflate entry is cut off with reason `bomb` past its declared size (validateEntrySizes),
// and a whole read whose CRC-32 differs from the directory's is reason `checksum`, raised after the last byte (so a
// consumer that writes through writeStreamAtomic keeps nothing).
//
// yauzl gets `autoClose: false` and its zipfile is never closed: yauzl would close the descriptor itself, behind the
// FileHandle's back. The reader closes the handle in close().

/** The default bound on the number of entries (`maxEntries`). */
export const ARCHIVE_MAX_ENTRIES = 100_000;
/** A deflate entry may declare at most this many times its compressed size (the default `maxRatio`). */
export const DEFLATE_MAX_RATIO = 10;

/** The bytes of a local file header before its name and extra field. */
const LOCAL_HEADER_BYTES = 30;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED_DIRECTORY = 0x2000;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** `version made by` host systems whose external attributes carry a Unix mode in their high half. */
const UNIX_HOSTS: ReadonlySet<number> = new Set([3 /* Unix */, 19 /* OS X */]);
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const DOS_DIRECTORY = 0x10;

type InvalidReason = 'path' | 'entry' | 'format' | 'bomb' | 'checksum';

/** One checked entry of an archive. */
export interface ArchiveEntry {
  /** Its position in the central directory, from 0. */
  readonly index: number;
  readonly name: string;
  /** 0 stored, 8 deflate. */
  readonly method: 0 | 8;
  /** The uncompressed size. */
  readonly size: number;
  readonly compressedSize: number;
  readonly crc32: number;
}

export interface ArchiveReader {
  /** Every entry, in central-directory order. */
  entries(): readonly ArchiveEntry[];
  /**
   * The (uncompressed) bytes of `e` from byte `from` (default 0) on. A whole read (`from` 0) is checked against the
   * entry's CRC-32 at its end.
   *
   * @throws RangeError at once for a `from` outside 0 … size; TypeError once the reader is closed
   * @throws (while reading) DomainError BACKUP_INVALID reason `bomb` (inflates past its declared size), `checksum`
   *   (CRC-32), `format` (too short, unreadable data); a file system error as it is
   */
  read(e: ArchiveEntry, o?: { from?: number }): AsyncIterable<Uint8Array>;
  /** Closes the file. Reads in progress fail; the reader cannot be used again. */
  close(): Promise<void>;
}

export interface OpenArchiveOptions {
  /** The entry names allowed (the `.altisbak` grammar ALTISBAK_ENTRY, for one). */
  allow: RegExp;
  /** At most this many entries (default {@link ARCHIVE_MAX_ENTRIES}). */
  maxEntries?: number;
  /**
   * A deflate entry may declare at most this many times its compressed size (default {@link DEFLATE_MAX_RATIO}). Only
   * for files ALTIS wrote itself, such as an XLSX read back in a test: spreadsheet XML compresses far beyond 10:1.
   */
  maxRatio?: number;
}

function invalid(reason: InvalidReason, why: string, cause?: unknown): DomainError {
  return new DomainError('BACKUP_INVALID', {
    detail: `Arsip ditolak: ${why} / The archive is refused: ${why}`,
    meta: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** A name for messages: JSON-quoted (NUL and control characters escaped) and bounded. */
function shown(name: string): string {
  const text = JSON.stringify(name);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function systemError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code);
}

/** A read or open error of yauzl or zlib as BACKUP_INVALID; DomainErrors and file system errors stay as they are. */
function mapped(error: unknown, what: string): unknown {
  if (isDomainError(error) || systemError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('too many bytes in the stream')) {
    return invalid('bomb', `${what} mengembang melebihi ukuran yang dinyatakan / inflates past its declared size`, error);
  }
  return invalid('format', `${what} tidak terbaca / is unreadable`, error);
}

function fromFd(fd: number): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromFd(
      fd,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: false, decodeStrings: false },
      (error, zipfile) => (error || zipfile === undefined ? reject(error ?? new Error('no zipfile')) : resolve(zipfile)),
    );
  });
}

/** Every central-directory record, each passed to `check` as it arrives; the first refusal stops the walk. */
function readDirectory(zip: ZipFile, check: (entry: Entry) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    // The listener stays: an 'error' event without one would be thrown as an uncaught exception.
    zip.on('error', (error: unknown) => fail(mapped(error, 'direktori pusat / the central directory')));
    zip.on('entry', (entry: Entry) => {
      if (settled) return;
      try {
        check(entry);
      } catch (error) {
        fail(error);
        return;
      }
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

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The entry's name: UTF-8 when flagged so (refused, `path`, when it is not), else its bytes one by one (Latin-1). */
function decodeName(entry: Entry): string {
  const raw = entry.fileName;
  if (typeof raw === 'string') return raw; // not reached: decodeStrings is false
  if ((entry.generalPurposeBitFlag & FLAG_UTF8) === 0) return raw.toString('latin1');
  try {
    return UTF8.decode(raw);
  } catch {
    throw invalid('path', `nama entri bukan UTF-8 yang sah / an entry name is not valid UTF-8`);
  }
}

function pathRefused(name: string): boolean {
  return (
    name === '' ||
    name.includes('\u0000') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').includes('..')
  );
}

/** Whether the entry is anything but a regular file: by its Unix mode, its DOS folder bit, or a trailing slash. */
function notRegular(entry: Entry, name: string): boolean {
  const attributes = entry.externalFileAttributes >>> 0;
  if (UNIX_HOSTS.has(entry.versionMadeBy >>> 8)) {
    const type = (attributes >>> 16) & S_IFMT;
    if (type !== 0 && type !== S_IFREG) return true;
  }
  return (attributes & DOS_DIRECTORY) !== 0 || name.endsWith('/');
}

/**
 * Opens the zip archive `path` for reading and checks every entry (see the module comment).
 *
 * @throws DomainError BACKUP_INVALID (`meta.reason` `path`, `entry`, `format` or `bomb`); the open error of the file
 *   (ENOENT, ...) as it is
 * @throws TypeError for an `allow` that is not a RegExp, a `maxEntries` that is not a positive integer or a `maxRatio`
 *   that is not a positive finite number
 */
export async function openArchive(path: DataPath, o: OpenArchiveOptions): Promise<ArchiveReader> {
  if (!(o?.allow instanceof RegExp)) throw new TypeError('openArchive: allow must be a RegExp');
  const maxEntries = o.maxEntries ?? ARCHIVE_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('openArchive: maxEntries must be a positive integer');
  const maxRatio = o.maxRatio ?? DEFLATE_MAX_RATIO;
  if (typeof maxRatio !== 'number' || !Number.isFinite(maxRatio) || maxRatio <= 0) throw new TypeError('openArchive: maxRatio must be a positive finite number');
  // A global or sticky RegExp keeps state between test() calls; a copy without those flags does not.
  const allow = new RegExp(o.allow.source, o.allow.flags.replace(/[gy]/g, ''));

  const handle = await openRead(path);
  try {
    let zip: ZipFile;
    try {
      zip = await fromFd(handle.fd);
    } catch (error) {
      throw mapped(error, 'berkas / the file');
    }
    if (zip.entryCount > maxEntries) {
      throw invalid('format', `lebih dari ${maxEntries} entri / more than ${maxEntries} entries`);
    }
    const raw: Entry[] = [];
    const entries: ArchiveEntry[] = [];
    const seen = new Set<string>();
    await readDirectory(zip, (entry) => {
      const name = decodeName(entry);
      if (pathRefused(name)) throw invalid('path', `nama entri ${shown(name)} keluar dari folder tujuan / the entry name ${shown(name)} leaves the target folder`);
      if (notRegular(entry, name)) throw invalid('entry', `${shown(name)} bukan berkas biasa / ${shown(name)} is not a regular file`);
      if (!allow.test(name)) throw invalid('entry', `${shown(name)} tidak diharapkan di arsip ini / ${shown(name)} is not expected in this archive`);
      if (seen.has(name)) throw invalid('entry', `${shown(name)} muncul dua kali / ${shown(name)} appears twice`);
      seen.add(name);
      const flags = entry.generalPurposeBitFlag;
      if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_DIRECTORY)) !== 0) {
        throw invalid('format', `${shown(name)} terenkripsi ZIP / ${shown(name)} uses ZIP encryption`);
      }
      const method = entry.compressionMethod;
      if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
        throw invalid('format', `${shown(name)} memakai metode kompresi ${method} / ${shown(name)} uses compression method ${method}`);
      }
      if (method === METHOD_DEFLATE && entry.uncompressedSize > maxRatio * entry.compressedSize) {
        throw invalid('bomb', `${shown(name)} mengembang lebih dari ${maxRatio}× / ${shown(name)} inflates more than ${maxRatio}×`);
      }
      raw.push(entry);
      entries.push(
        Object.freeze({
          index: entries.length,
          name,
          method,
          size: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          crc32: entry.crc32 >>> 0,
        }),
      );
    });
    refuseOverlaps(raw, zip.fileSize);
    return createReader(handle, zip, raw, entries);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Refuses entries whose data overlap: in file order, each entry's local header (at least 30 bytes and its name) and
 * data end before the next entry begins, and the last one inside the file.
 */
function refuseOverlaps(raw: readonly Entry[], fileSize: number): void {
  const order = [...raw].sort((a, b) => a.relativeOffsetOfLocalHeader - b.relativeOffsetOfLocalHeader);
  for (let i = 0; i < order.length; i += 1) {
    const e = order[i]!;
    const end = e.relativeOffsetOfLocalHeader + LOCAL_HEADER_BYTES + e.fileNameLength + e.compressedSize;
    const limit = i + 1 < order.length ? order[i + 1]!.relativeOffsetOfLocalHeader : fileSize;
    if (end > limit) throw invalid('bomb', 'data entri saling bertumpuk / entry data overlap');
  }
}

function openStream(zip: ZipFile, entry: Entry, options: ReadStreamOptions): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, options, (error, stream) => (error || stream === undefined ? reject(error ?? new Error('no stream')) : resolve(stream)));
  });
}

function createReader(handle: FileHandle, zip: ZipFile, raw: readonly Entry[], entries: readonly ArchiveEntry[]): ArchiveReader {
  let closed = false;
  const listed = Object.freeze([...entries]);

  async function* readEntry(e: ArchiveEntry, entry: Entry, from: number): AsyncGenerator<Uint8Array, void, undefined> {
    const what = `entri ${shown(e.name)} / entry ${shown(e.name)}`;
    let stream: Readable;
    try {
      // Stored: the bytes from `from` as they are. Deflate: inflated (and bounded by its declared size), then skipped.
      stream = await openStream(zip, entry, e.method === METHOD_STORED ? { decodeFileData: false, start: from } : {});
    } catch (error) {
      throw mapped(error, what);
    }
    let skip = e.method === METHOD_STORED ? 0 : from;
    let crc = 0;
    let produced = 0;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        produced += chunk.byteLength;
        if (from === 0) crc = crc32(chunk, crc);
        let out = chunk;
        if (skip > 0) {
          const cut = Math.min(skip, out.byteLength);
          out = out.subarray(cut);
          skip -= cut;
        }
        if (out.byteLength > 0) yield out;
      }
    } catch (error) {
      throw mapped(error, what);
    } finally {
      stream.destroy();
    }
    const expected = e.method === METHOD_STORED ? e.size - from : e.size;
    if (produced !== expected) throw invalid('format', `${what} terpotong / is truncated`);
    if (from === 0 && crc >>> 0 !== e.crc32) throw invalid('checksum', `CRC-32 ${what} tidak cocok / the CRC-32 of ${what} does not match`);
  }

  return {
    entries: () => listed,
    read(e, o = {}) {
      if (closed) throw new TypeError('ArchiveReader.read: the reader is closed');
      const entry = raw[e?.index];
      if (entry === undefined || listed[e.index] !== e) throw new TypeError('ArchiveReader.read: not an entry of this archive');
      const from = o.from ?? 0;
      if (!Number.isSafeInteger(from) || from < 0 || from > e.size) {
        throw new RangeError(`ArchiveReader.read: from must be an integer from 0 to ${e.size}, got ${String(from)}`);
      }
      return readEntry(e, entry, from);
    },
    async close() {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}
