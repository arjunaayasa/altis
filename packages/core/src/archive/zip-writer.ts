import type { FileHandle } from 'node:fs/promises';
import { constants as zlibConstants, crc32, deflateRawSync } from 'node:zlib';
import { openRead, openReadWrite, statOrNull, truncateFile, type DataPath } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { z } from 'zod';

// The shared resumable ZIP writer (spec §4.15 "Penulis ZIP64 bersama", §10.9): report XLSX files, evidence ZIPs and
// the `.altisbak` backup archive are all written through it, a job slice at a time. A slice can stop between two calls
// and the next slice, in any process, carries on from a small checkpoint, inside an entry too.
//
//   local header   signature, version 2.0 (4.5 with ZIP64), flags bit 11 (UTF-8 name) and, for an entry whose CRC
//                  and sizes are not known before its first byte, bit 3 (they follow in a data descriptor), method 0
//                  (stored) or 8 (deflate), the DOS time of `mtime` (default 1980-01-01 00:00, so that the same input
//                  gives the same bytes whoever writes it), the CRC and sizes (0 with bit 3), the name, and with ZIP64
//                  an extra field holding both sizes (0 with bit 3) while the header fields hold 0xFFFFFFFF
//   data           stored: the bytes as given. Deflate: one independent segment per write() call, each the raw
//                  deflate of that call's bytes ended by a sync flush (byte-aligned, never final), and at endEntry()
//                  a final empty block; the segments need no shared state, so a pause between two calls costs nothing
//   descriptor     with bit 3: signature, CRC-32, compressed and uncompressed size (8 bytes each with ZIP64)
//   ...
//   central dir    one record per entry: a Unix regular file of mode 0600; with ZIP64 both sizes and the local header
//                  offset in an extra field while the header fields hold 0xFFFFFFFF
//   end records    with ZIP64 (forced, or more entries or bytes than the classic fields hold): a ZIP64 end of central
//                  directory record, its locator, and a classic EOCD of 0xFFFF/0xFFFFFFFF markers; else a classic EOCD
//
// An entry gets ZIP64 fields when it is forced (`forceZip64`), when its local header starts at or past 0xFFFFFFFF, or
// when its declared size reaches 0xFFFFFFFF. An entry decided without ZIP64 cannot grow to 4 GiB (ZipLimitError
// 'bytes'): an entry that large is given its size up front, or the archive forces ZIP64.
//
// The central directory grows with every entry, so it is not kept in the checkpoint, which travels in a job payload:
// endEntry() appends the entry's central record to the sidecar file `central` and fsyncs it, after fsyncing the
// archive. finish() copies the sidecar's records in after the last entry (checking them as it goes) and writes the end
// records. The sidecar stays after finish(): a slice that died before it recorded the end finishes again from its last
// checkpoint, which needs the sidecar; it goes with its work folder.
//
// The checkpoint {offset, entries, centralBytes, open} is what checkpoint() made durable: `offset` bytes of the
// archive, `entries` finished entries whose central records are the first `centralBytes` bytes of the sidecar, and the
// entry in progress (name, method, header offset, CRC and sizes so far). A writer opened with a checkpoint cuts both
// files back to it (whatever a dead slice wrote after it goes) and carries on; whether the open entry promised its CRC
// and size in its header is read back from that header. The options (`mtime`, `forceZip64`, `descriptor`) must be the
// same for every writer of one archive.
//
// The writer opens a file only inside a call and closes it before returning, so a writer between two calls holds no
// file open and can simply be dropped. Writes smaller than 1 MiB are gathered in memory (copied) and written out with
// the next large one, at endEntry() or at checkpoint(), so a small entry costs one write of the archive and one of the
// sidecar. A failed call (a full disk, a source of the wrong size) cuts both files back to the last checkpoint,
// freeing what it wrote, and leaves the writer unusable: a new one is opened from the checkpoint. A ZipLimitError or a
// TypeError is raised before anything is written and leaves the writer as it was.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_END = 0x06054b50;
/** Bit 3: the CRC and sizes follow the data in a data descriptor. */
const FLAG_DESCRIPTOR = 0x0008;
/** Bit 11: the name is UTF-8. */
const FLAG_UTF8 = 0x0800;
const VERSION_CLASSIC = 20;
const VERSION_ZIP64 = 45;
/** Made by Unix (3), version 4.5. */
const VERSION_MADE_BY = (3 << 8) | 45;
/** A regular file, mode 0600, in the high half of the external attributes. */
const EXTERNAL_ATTRIBUTES = (0o100600 << 16) >>> 0;
const LOCAL_HEADER_BYTES = 30;
const LOCAL_ZIP64_EXTRA_BYTES = 4 + 16;
const CENTRAL_HEADER_BYTES = 46;
const CENTRAL_ZIP64_EXTRA_BYTES = 4 + 24;
const ZIP64_END_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;
const END_BYTES = 22;
const MARK16 = 0xffff;
const MARK32 = 0xffff_ffff;
/** The longest entry name, in UTF-8 bytes: a checkpoint with an open entry stays well under 4 KiB of JSON. */
const NAME_MAX_BYTES = 1024;
/** The shortest and the longest central record this writer writes. */
const CENTRAL_RECORD_MIN = CENTRAL_HEADER_BYTES + 1;
const CENTRAL_RECORD_MAX = CENTRAL_HEADER_BYTES + NAME_MAX_BYTES + CENTRAL_ZIP64_EXTRA_BYTES;
/** How much of the sidecar finish() copies at a time. */
const CENTRAL_COPY_BYTES = 1_048_576;
/** Smaller writes are gathered in memory up to this many bytes, so that a small entry costs one write of the archive. */
const FLUSH_BYTES = 1_048_576;
/** The bytes that close a deflate entry written in segments: a final empty block. */
const FINAL_BLOCK: Uint8Array = deflateRawSync(Buffer.alloc(0));
/** A C0 or C1 control character, DEL included. */
const CONTROL = /\p{Cc}/u;
/** A UTF-16 surrogate without its pair (no UTF-8 form). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The entry in progress, as a checkpoint carries it. */
export interface ZipEntryState {
  name: string;
  method: 0 | 8;
  /** Where its local header begins. */
  headerOffset: number;
  /** The CRC-32 of its uncompressed bytes so far. */
  crc32: number;
  /** Its data bytes so far (the deflate segments; for a stored entry the same as `size`). */
  compressedSize: number;
  /** Its uncompressed bytes so far. */
  size: number;
  /** Whether its local header has the ZIP64 extra field (and its data descriptor 8-byte sizes). */
  zip64: boolean;
}

/** What is durable in the archive and its sidecar (see the module comment). Plain JSON, at most 4 096 bytes. */
export interface ZipWriterCheckpoint {
  offset: number;
  entries: number;
  centralBytes: number;
  open: ZipEntryState | null;
}

export interface ZipWriterOptions {
  /** Where to carry on (null: a new archive; both files are cut to nothing). */
  checkpoint: ZipWriterCheckpoint | null;
  /** At most this many entries (ZipLimitError 'entries' beyond). Default: no bound. */
  maxEntries?: number;
  /** At most this many bytes in the finished file, central directory and end records included (ZipLimitError 'bytes'). Default: no bound. */
  maxBytes?: number;
  /** The modification time of every entry (epoch ms; its UTC calendar fields, 1980 to 2107). Default 1980-01-01 00:00. */
  mtime?: number;
  /** ZIP64 fields on every entry and ZIP64 end records, whatever the sizes (the `.altisbak` layout; a test profile). */
  forceZip64?: boolean;
  /**
   * When an entry has a data descriptor: 'when_unknown' (default) only when its CRC and sizes are not known before its
   * first byte; 'always' on every entry (the `.altisbak` layout).
   */
  descriptor?: 'always' | 'when_unknown';
}

export interface ZipWriter {
  /**
   * Begins entry `name` (a relative, `/`-separated path: no `..` or `.` segment, no empty segment, no `\`, no leading
   * `/`, no drive letter, no control character, at most 1 024 UTF-8 bytes; not a name this writer wrote already).
   * A stored entry given `size` and `crc32` has them in its local header and no data descriptor (unless `descriptor` is
   * 'always'); `size` alone (or for a deflate entry) is checked at endEntry.
   *
   * @throws TypeError for a bad name or option, or while an entry is open; ZipLimitError 'entries' or 'bytes'
   */
  beginEntry(name: string, o: { method: 0 | 8; size?: number; crc32?: number }): Promise<void>;
  /**
   * Appends `chunk` to the open entry: as it is (stored), or as one independent sync-flushed deflate segment (deflate).
   * An empty chunk writes nothing.
   *
   * @throws TypeError outside an entry; ZipLimitError 'bytes'; DomainError STATE_CORRUPT `size_mismatch` past the
   *   declared size, DISK_QUOTA (the writer is then unusable)
   */
  write(chunk: Uint8Array): Promise<void>;
  /**
   * Ends the open entry (the final deflate block, the data descriptor), fsyncs the archive, and appends the entry's
   * central record to the sidecar and fsyncs it.
   *
   * @throws TypeError outside an entry; ZipLimitError 'bytes'; DomainError STATE_CORRUPT `size_mismatch` or
   *   `crc_mismatch` against what the header promised, DISK_QUOTA (the writer is then unusable)
   */
  endEntry(): Promise<void>;
  /** A whole entry in one call: its CRC and sizes are known up front (beginEntry, write, endEntry otherwise). */
  addEntry(name: string, bytes: Uint8Array, o: { method: 0 | 8 }): Promise<void>;
  /** Fsyncs what was written since the last sync and returns the durable state (a copy; JSON-safe). */
  checkpoint(): Promise<ZipWriterCheckpoint>;
  /**
   * Writes the central directory (the sidecar's records, checked as they are copied) and the end records, fsyncs, and
   * returns the file's size and entry count. Can be repeated by a new writer from the checkpoint taken before it.
   *
   * @throws TypeError while an entry is open; ZipLimitError 'bytes'; DomainError STATE_CORRUPT (`central_short`,
   *   `central_mismatch`) when the sidecar does not hold the records of the entries written, DISK_QUOTA
   */
  finish(): Promise<{ size: number; entries: number }>;
  /** The archive's length so far (its data, before the central directory). */
  readonly bytesWritten: number;
}

/**
 * An archive would get more entries or bytes than the writer allows (`maxEntries`, `maxBytes`), or an entry written
 * without ZIP64 fields would reach 4 GiB. Raised before anything of the call is written; the writer stays usable.
 */
export class ZipLimitError extends Error {
  readonly kind: 'entries' | 'bytes';
  /** The bound. */
  readonly max: number;
  /** The entries or bytes the archive (or the entry) would have had. */
  readonly value: number;

  constructor(kind: 'entries' | 'bytes', max: number, value: number) {
    super(`ZIP archive limit reached: ${value} ${kind}, at most ${max}`);
    this.name = 'ZipLimitError';
    this.kind = kind;
    this.max = max;
    this.value = value;
  }
}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** The shape of a {@link ZipWriterCheckpoint} (strict), for a job payload that carries one. */
export const zipWriterCheckpointSchema = z.strictObject({
  offset: count,
  entries: count,
  centralBytes: count,
  open: z
    .strictObject({
      name: z.string().min(1).max(NAME_MAX_BYTES),
      method: z.union([z.literal(0), z.literal(8)]),
      headerOffset: count,
      crc32: z.number().int().min(0).max(MARK32),
      compressedSize: count,
      size: count,
      zip64: z.boolean(),
    })
    .nullable(),
});

/** Whether `name` is an entry name this writer writes (see ZipWriter.beginEntry). */
function nameAllowed(name: unknown): name is string {
  if (typeof name !== 'string' || name === '' || CONTROL.test(name) || LONE_SURROGATE.test(name)) return false;
  if (name.includes('\\') || /^[A-Za-z]:/.test(name)) return false;
  if (Buffer.byteLength(name, 'utf8') > NAME_MAX_BYTES) return false;
  return name.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function entryName(name: unknown, what: string): Buffer {
  if (!nameAllowed(name)) throw new TypeError(`${what}: ${JSON.stringify(String(name)).slice(0, 80)} is not an entry name`);
  return Buffer.from(name, 'utf8');
}

function corrupt(reason: string, detail: string): DomainError {
  return new DomainError('STATE_CORRUPT', { detail, meta: { reason } });
}

function centralCorrupt(path: string, reason: 'central_short' | 'central_mismatch'): DomainError {
  return corrupt(
    reason,
    `Catatan direktori pusat ${path} tidak cocok dengan titik lanjut arsip / ` +
      `The central directory records ${path} do not match the archive's checkpoint`,
  );
}

function sizeMismatch(name: string, size: number): DomainError {
  return corrupt(
    'size_mismatch',
    `Isi entri ${name} tidak berjumlah ${size} byte seperti yang dinyatakan / The content of entry ${name} is not the ${size} bytes declared`,
  );
}

/** `ENOSPC`/`EDQUOT` from a write or fsync as DISK_QUOTA; anything else as it is. */
function quotaMapped(error: unknown, path: string): unknown {
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  if (code !== 'ENOSPC' && code !== 'EDQUOT') return error;
  return new DomainError('DISK_QUOTA', {
    detail:
      `Ruang disk atau kuota hosting habis saat menulis ${path} (${code}) / ` +
      `The disk is full or the hosting quota is used up while writing ${path} (${code})`,
    meta: { code },
    cause: error,
  });
}

/** The DOS date and time of `ms` (UTC fields, 2-second resolution), within 1980-01-01 … 2107-12-31. */
function dosStamp(ms: number | undefined): { date: number; time: number } {
  if (ms === undefined) return { date: (1 << 5) | 1, time: 0 };
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (year < 1980) return { date: (1 << 5) | 1, time: 0 };
  if (year > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

function u64(buffer: Buffer, value: number, at: number): void {
  buffer.writeBigUInt64LE(BigInt(value), at);
}

/** An entry as the writer keeps it while it is open. */
interface OpenEntry {
  name: string;
  nameBytes: Buffer;
  method: 0 | 8;
  headerOffset: number;
  crc: number;
  compressedSize: number;
  size: number;
  zip64: boolean;
  /** Bit 3: the CRC and sizes follow in a data descriptor. */
  descriptor: boolean;
  /** A deflate entry written in segments (closed by FINAL_BLOCK); addEntry writes one whole deflate stream. */
  segmented: boolean;
  /** What the header promised (or the caller declared), checked at endEntry; null when unknown. */
  expectSize: number | null;
  expectCrc: number | null;
  expectCompressed: number | null;
}

function localHeaderBytes(nameBytes: number, zip64: boolean): number {
  return LOCAL_HEADER_BYTES + nameBytes + (zip64 ? LOCAL_ZIP64_EXTRA_BYTES : 0);
}

function localHeader(e: OpenEntry, stamp: { date: number; time: number }): Buffer {
  const b = Buffer.alloc(localHeaderBytes(e.nameBytes.byteLength, e.zip64));
  const crc = e.descriptor ? 0 : e.expectCrc!;
  const size = e.descriptor ? 0 : e.expectSize!;
  const compressed = e.descriptor ? 0 : e.expectCompressed!;
  b.writeUInt32LE(SIG_LOCAL, 0);
  b.writeUInt16LE(e.zip64 ? VERSION_ZIP64 : VERSION_CLASSIC, 4);
  b.writeUInt16LE(FLAG_UTF8 | (e.descriptor ? FLAG_DESCRIPTOR : 0), 6);
  b.writeUInt16LE(e.method, 8);
  b.writeUInt16LE(stamp.time, 10);
  b.writeUInt16LE(stamp.date, 12);
  b.writeUInt32LE(crc, 14);
  b.writeUInt32LE(e.zip64 ? MARK32 : compressed, 18);
  b.writeUInt32LE(e.zip64 ? MARK32 : size, 22);
  b.writeUInt16LE(e.nameBytes.byteLength, 26);
  b.writeUInt16LE(e.zip64 ? LOCAL_ZIP64_EXTRA_BYTES : 0, 28);
  e.nameBytes.copy(b, LOCAL_HEADER_BYTES);
  if (e.zip64) {
    const x = LOCAL_HEADER_BYTES + e.nameBytes.byteLength;
    b.writeUInt16LE(0x0001, x);
    b.writeUInt16LE(16, x + 2);
    u64(b, size, x + 4); // original size
    u64(b, compressed, x + 12); // compressed size
  }
  return b;
}

function dataDescriptor(crc: number, compressed: number, size: number, zip64: boolean): Buffer {
  const b = Buffer.alloc(zip64 ? 24 : 16);
  b.writeUInt32LE(SIG_DESCRIPTOR, 0);
  b.writeUInt32LE(crc, 4);
  if (zip64) {
    u64(b, compressed, 8);
    u64(b, size, 16);
  } else {
    b.writeUInt32LE(compressed, 8);
    b.writeUInt32LE(size, 12);
  }
  return b;
}

function centralRecord(e: OpenEntry, crc: number, compressed: number, stamp: { date: number; time: number }): Buffer {
  const b = Buffer.alloc(CENTRAL_HEADER_BYTES + e.nameBytes.byteLength + (e.zip64 ? CENTRAL_ZIP64_EXTRA_BYTES : 0));
  b.writeUInt32LE(SIG_CENTRAL, 0);
  b.writeUInt16LE(VERSION_MADE_BY, 4);
  b.writeUInt16LE(e.zip64 ? VERSION_ZIP64 : VERSION_CLASSIC, 6);
  b.writeUInt16LE(FLAG_UTF8 | (e.descriptor ? FLAG_DESCRIPTOR : 0), 8);
  b.writeUInt16LE(e.method, 10);
  b.writeUInt16LE(stamp.time, 12);
  b.writeUInt16LE(stamp.date, 14);
  b.writeUInt32LE(crc, 16);
  b.writeUInt32LE(e.zip64 ? MARK32 : compressed, 20);
  b.writeUInt32LE(e.zip64 ? MARK32 : e.size, 24);
  b.writeUInt16LE(e.nameBytes.byteLength, 28);
  b.writeUInt16LE(e.zip64 ? CENTRAL_ZIP64_EXTRA_BYTES : 0, 30);
  b.writeUInt16LE(0, 32); // comment
  b.writeUInt16LE(0, 34); // disk
  b.writeUInt16LE(0, 36); // internal attributes
  b.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
  b.writeUInt32LE(e.zip64 ? MARK32 : e.headerOffset, 42);
  e.nameBytes.copy(b, CENTRAL_HEADER_BYTES);
  if (e.zip64) {
    const x = CENTRAL_HEADER_BYTES + e.nameBytes.byteLength;
    b.writeUInt16LE(0x0001, x);
    b.writeUInt16LE(24, x + 2);
    u64(b, e.size, x + 4); // original size
    u64(b, compressed, x + 12); // compressed size
    u64(b, e.headerOffset, x + 20); // local header offset
  }
  return b;
}

/** The end records: with ZIP64, its end record, its locator and a classic EOCD of markers; else a classic EOCD. */
function endRecords(entries: number, cdOffset: number, cdSize: number, zip64: boolean): Buffer {
  if (!zip64) {
    const b = Buffer.alloc(END_BYTES);
    b.writeUInt32LE(SIG_END, 0);
    b.writeUInt16LE(entries, 8);
    b.writeUInt16LE(entries, 10);
    b.writeUInt32LE(cdSize, 12);
    b.writeUInt32LE(cdOffset, 16);
    return b;
  }
  const b = Buffer.alloc(ZIP64_END_BYTES + ZIP64_LOCATOR_BYTES + END_BYTES);
  b.writeUInt32LE(SIG_ZIP64_END, 0);
  u64(b, ZIP64_END_BYTES - 12, 4);
  b.writeUInt16LE(VERSION_MADE_BY, 12);
  b.writeUInt16LE(VERSION_ZIP64, 14);
  b.writeUInt32LE(0, 16); // this disk
  b.writeUInt32LE(0, 20); // the disk of the central directory
  u64(b, entries, 24);
  u64(b, entries, 32);
  u64(b, cdSize, 40);
  u64(b, cdOffset, 48);
  const l = ZIP64_END_BYTES;
  b.writeUInt32LE(SIG_ZIP64_LOCATOR, l);
  b.writeUInt32LE(0, l + 4);
  u64(b, cdOffset + cdSize, l + 8);
  b.writeUInt32LE(1, l + 16);
  const e = l + ZIP64_LOCATOR_BYTES;
  b.writeUInt32LE(SIG_END, e);
  b.writeUInt16LE(MARK16, e + 8);
  b.writeUInt16LE(MARK16, e + 10);
  b.writeUInt32LE(MARK32, e + 12);
  b.writeUInt32LE(MARK32, e + 16);
  return b;
}

async function writeAt(handle: FileHandle, data: Uint8Array, position: number): Promise<void> {
  let done = 0;
  while (done < data.byteLength) {
    const { bytesWritten } = await handle.write(data, done, data.byteLength - done, position + done);
    if (!(bytesWritten > 0)) throw new Error('write made no progress');
    done += bytesWritten;
  }
}

async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const out = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(out, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return out.subarray(0, done);
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Checks, as finish() copies them, that the sidecar's bytes are central records as centralRecord() writes them: names
 * this writer allows, each once, local headers in increasing order before the end of the data.
 */
class CentralCheck {
  private pending: Buffer = Buffer.alloc(0);
  private readonly names = new Set<string>();
  private previous = -1;

  constructor(private readonly dataEnd: number) {}

  /** Takes the next bytes; false as soon as they cannot be such records. */
  push(bytes: Buffer): boolean {
    let data = this.pending.byteLength > 0 ? Buffer.concat([this.pending, bytes]) : bytes;
    while (data.byteLength >= CENTRAL_HEADER_BYTES) {
      const nameLength = data.readUInt16LE(28);
      const extraLength = data.readUInt16LE(30);
      const length = CENTRAL_HEADER_BYTES + nameLength + extraLength;
      if (data.byteLength < length) break;
      if (!this.record(data.subarray(0, length), nameLength, extraLength)) return false;
      data = data.subarray(length);
    }
    this.pending = Buffer.from(data);
    return true;
  }

  /** Whether the bytes taken were exactly `entries` whole records. */
  end(entries: number): boolean {
    return this.pending.byteLength === 0 && this.names.size === entries;
  }

  private record(r: Buffer, nameLength: number, extraLength: number): boolean {
    if (r.readUInt32LE(0) !== SIG_CENTRAL || r.readUInt16LE(32) !== 0) return false;
    if (nameLength === 0 || nameLength > NAME_MAX_BYTES) return false;
    if (extraLength !== 0 && extraLength !== CENTRAL_ZIP64_EXTRA_BYTES) return false;
    let name: string;
    try {
      name = UTF8.decode(r.subarray(CENTRAL_HEADER_BYTES, CENTRAL_HEADER_BYTES + nameLength));
    } catch {
      return false;
    }
    if (!nameAllowed(name) || this.names.has(name)) return false;
    let at = r.readUInt32LE(42);
    if (extraLength > 0) {
      const x = CENTRAL_HEADER_BYTES + nameLength;
      if (at !== MARK32 || r.readUInt16LE(x) !== 0x0001 || r.readUInt16LE(x + 2) !== 24) return false;
      at = Number(r.readBigUInt64LE(x + 20));
    } else if (at === MARK32) {
      return false;
    }
    if (at <= this.previous || at >= this.dataEnd) return false;
    this.previous = at;
    this.names.add(name);
    return true;
  }
}

/** A checkpoint as checkpoint() returns them, or a TypeError. */
function checkpointOf(cp: ZipWriterCheckpoint, forceZip64: boolean): ZipWriterCheckpoint {
  const parsed = zipWriterCheckpointSchema.safeParse(cp);
  const bad = (why: string): TypeError => new TypeError(`openZipWriter: the checkpoint is not valid (${why})`);
  if (!parsed.success) throw bad('shape');
  const c = parsed.data;
  if (c.centralBytes < c.entries * CENTRAL_RECORD_MIN || c.centralBytes > c.entries * CENTRAL_RECORD_MAX) throw bad('centralBytes');
  const open = c.open;
  if (open !== null) {
    if (!nameAllowed(open.name)) throw bad('name');
    if (open.method === 0 && open.compressedSize !== open.size) throw bad('size');
    if (forceZip64 && !open.zip64) throw bad('zip64');
    if (!open.zip64 && (open.size >= MARK32 || open.compressedSize >= MARK32 || open.headerOffset >= MARK32)) throw bad('zip64');
    if (open.headerOffset + localHeaderBytes(Buffer.byteLength(open.name, 'utf8'), open.zip64) + open.compressedSize !== c.offset) {
      throw bad('offset');
    }
  }
  return { offset: c.offset, entries: c.entries, centralBytes: c.centralBytes, open: open === null ? null : { ...open } };
}

/**
 * The open entry of a checkpoint, completed from its local header in the archive (whether it has a data descriptor,
 * and what CRC and sizes it promised).
 *
 * @throws DomainError STATE_CORRUPT `archive_mismatch` when the header there is not the entry's
 */
async function reopenEntry(path: DataPath, open: ZipEntryState): Promise<OpenEntry> {
  const nameBytes = Buffer.from(open.name, 'utf8');
  const length = localHeaderBytes(nameBytes.byteLength, open.zip64);
  const handle = await openRead(path);
  let h: Buffer;
  try {
    h = await readAt(handle, length, open.headerOffset);
  } finally {
    await handle.close();
  }
  const mismatch = (): DomainError =>
    corrupt(
      'archive_mismatch',
      `Entri yang sedang ditulis di ${path} tidak cocok dengan titik lanjutnya / The entry in progress in ${path} does not match its checkpoint`,
    );
  if (
    h.byteLength !== length ||
    h.readUInt32LE(0) !== SIG_LOCAL ||
    h.readUInt16LE(8) !== open.method ||
    (h.readUInt16LE(6) & FLAG_UTF8) === 0 ||
    h.readUInt16LE(28) !== (open.zip64 ? LOCAL_ZIP64_EXTRA_BYTES : 0) ||
    !h.subarray(LOCAL_HEADER_BYTES, LOCAL_HEADER_BYTES + nameBytes.byteLength).equals(nameBytes)
  ) {
    throw mismatch();
  }
  const descriptor = (h.readUInt16LE(6) & FLAG_DESCRIPTOR) !== 0;
  if (!descriptor && open.method !== 0) throw mismatch(); // a deflate entry in progress is always written in segments
  const x = LOCAL_HEADER_BYTES + nameBytes.byteLength;
  const declaredSize = open.zip64 ? Number(h.readBigUInt64LE(x + 4)) : h.readUInt32LE(22);
  return {
    name: open.name,
    nameBytes,
    method: open.method,
    headerOffset: open.headerOffset,
    crc: open.crc32,
    compressedSize: open.compressedSize,
    size: open.size,
    zip64: open.zip64,
    descriptor,
    segmented: open.method === 8,
    expectSize: descriptor ? null : declaredSize,
    expectCrc: descriptor ? null : h.readUInt32LE(14),
    expectCompressed: descriptor ? null : declaredSize,
  };
}

/** Creates `p` when missing and cuts it to nothing. */
async function createEmpty(p: DataPath): Promise<void> {
  const handle = await openReadWrite(p);
  try {
    await handle.truncate(0);
  } finally {
    await handle.close();
  }
}

/**
 * Opens the archive `path`, with its central-directory sidecar `central`, for writing: a new one (checkpoint null:
 * both files are created or cut to nothing) or the one `o.checkpoint` describes (both files are cut back to it).
 *
 * @throws TypeError for an option or a checkpoint that checkpoint() cannot have returned
 * @throws DomainError STATE_CORRUPT (`archive_short`, `central_short`) when a file is shorter than the checkpoint says,
 *   (`archive_mismatch`) when the open entry's local header is not where the checkpoint puts it; DISK_QUOTA
 */
export async function openZipWriter(path: DataPath, central: DataPath, o: ZipWriterOptions): Promise<ZipWriter> {
  if (typeof o !== 'object' || o === null) throw new TypeError('openZipWriter: options are required');
  const maxEntries = o.maxEntries ?? Number.MAX_SAFE_INTEGER;
  const maxBytes = o.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('openZipWriter: maxEntries must be a positive integer');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('openZipWriter: maxBytes must be a positive integer');
  if (o.mtime !== undefined && (typeof o.mtime !== 'number' || !Number.isFinite(o.mtime))) throw new TypeError('openZipWriter: mtime must be a finite number');
  const forceZip64 = o.forceZip64 ?? false;
  if (typeof forceZip64 !== 'boolean') throw new TypeError('openZipWriter: forceZip64 must be a boolean');
  const mode = o.descriptor ?? 'when_unknown';
  if (mode !== 'always' && mode !== 'when_unknown') throw new TypeError("openZipWriter: descriptor must be 'always' or 'when_unknown'");
  if (o.checkpoint === undefined) throw new TypeError('openZipWriter: checkpoint must be given (null for a new archive)');
  const stamp = dosStamp(o.mtime);

  let base: ZipWriterCheckpoint;
  let open: OpenEntry | null = null;
  if (o.checkpoint === null) {
    base = { offset: 0, entries: 0, centralBytes: 0, open: null };
    await createEmpty(path);
    await createEmpty(central);
  } else {
    base = checkpointOf(o.checkpoint, forceZip64);
    const archive = await statOrNull(path);
    if (archive === null || archive.kind !== 'file' || archive.size < base.offset) {
      throw corrupt('archive_short', `Arsip ${path} lebih pendek dari titik lanjutnya / The archive ${path} is shorter than its checkpoint`);
    }
    const sidecar = await statOrNull(central);
    if ((sidecar === null && base.centralBytes > 0) || (sidecar !== null && (sidecar.kind !== 'file' || sidecar.size < base.centralBytes))) {
      throw centralCorrupt(central, 'central_short');
    }
    if (base.open !== null) open = await reopenEntry(path, base.open);
    await truncateFile(path, base.offset);
    if (sidecar !== null) await truncateFile(central, base.centralBytes);
  }

  /** The archive's length: what is in the file (`flushed`) and the bytes gathered in `pending`. */
  let offset = base.offset;
  let flushed = base.offset;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let entries = base.entries;
  let centralBytes = base.centralBytes;
  /** Bytes were written to the archive file since its last fsync. */
  let dirty = false;
  let busy = false;
  let finished = false;
  let broken = false;
  /** The names written by this writer: a name written by an earlier one is refused by finish(). */
  const written = new Set<string>();

  /** A call, one at a time, on a writer that is neither finished nor broken. */
  async function call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (finished) throw new TypeError(`ZipWriter.${what}: the archive is finished`);
    if (broken) throw new TypeError(`ZipWriter.${what}: an earlier call failed; open a writer again from the last checkpoint`);
    if (busy) throw new TypeError(`ZipWriter.${what}: another call is still running`);
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }

  /** Runs the writing part of a call; on failure both files go back to the last checkpoint and the writer breaks. */
  async function io(file: DataPath, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      broken = true;
      pending = [];
      pendingBytes = 0;
      await truncateFile(path, base.offset).catch(() => undefined);
      if ((await statOrNull(central).catch(() => null)) !== null) await truncateFile(central, base.centralBytes).catch(() => undefined);
      throw quotaMapped(error, file);
    }
  }

  /**
   * Appends `parts` to the archive (the caller moves `offset`): gathered in memory (a copy) while the pending bytes stay
   * under FLUSH_BYTES and `force` is false, else written out with the pending bytes, and fsynced when `sync`.
   */
  async function append(parts: readonly Uint8Array[], force: boolean, sync: boolean): Promise<void> {
    const more = parts.reduce((n, p) => n + p.byteLength, 0);
    if (!force && pendingBytes + more < FLUSH_BYTES) {
      for (const p of parts) pending.push(Buffer.from(p));
      pendingBytes += more;
      return;
    }
    if (pendingBytes + more === 0 && !(sync && dirty)) return;
    const handle = await openReadWrite(path);
    let at = flushed;
    try {
      for (const p of [...pending, ...parts]) {
        await writeAt(handle, p, at);
        at += p.byteLength;
      }
      if (sync) await handle.sync();
    } finally {
      await handle.close();
    }
    flushed = at;
    pending = [];
    pendingBytes = 0;
    dirty = !sync;
  }

  /** Appends `record` at `centralBytes` of the sidecar (cut there first) and fsyncs it. */
  async function appendCentral(record: Buffer): Promise<void> {
    const handle = await openReadWrite(central);
    try {
      await handle.truncate(centralBytes);
      await writeAt(handle, record, centralBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** ZipLimitError when `more` bytes of data or central records would take the archive past maxBytes. */
  function checkBytes(more: number): void {
    const total = offset + centralBytes + more;
    if (total > maxBytes) throw new ZipLimitError('bytes', maxBytes, total);
  }

  /** ZipLimitError when an entry without ZIP64 fields would reach 4 GiB. */
  function checkClassic(e: OpenEntry, size: number, compressed: number): void {
    if (!e.zip64 && (size >= MARK32 || compressed >= MARK32)) throw new ZipLimitError('bytes', MARK32 - 1, Math.max(size, compressed));
  }

  function checkNew(name: unknown, method: unknown, what: string): Buffer {
    if (open !== null) throw new TypeError(`ZipWriter.${what}: entry ${open.name} is still open`);
    const nameBytes = entryName(name, `ZipWriter.${what}`);
    if (written.has(name as string)) throw new TypeError(`ZipWriter.${what}: ${String(name)} is written already`);
    if (method !== 0 && method !== 8) throw new TypeError(`ZipWriter.${what}: method must be 0 (stored) or 8 (deflate)`);
    if (entries + 1 > maxEntries) throw new ZipLimitError('entries', maxEntries, entries + 1);
    return nameBytes;
  }

  /** Writes `tail` (and fsyncs the archive), then the entry's central record: the entry is finished. */
  async function finishEntry(e: OpenEntry, head: readonly Uint8Array[], crc: number, compressed: number): Promise<void> {
    const tail: Uint8Array[] = [...head];
    if (e.descriptor) tail.push(dataDescriptor(crc, compressed, e.size, e.zip64));
    const record = centralRecord(e, crc, compressed, stamp);
    const tailBytes = tail.reduce((n, p) => n + p.byteLength, 0);
    checkBytes(tailBytes + record.byteLength);
    await io(path, async () => {
      if (e.expectSize !== null && e.size !== e.expectSize) throw sizeMismatch(e.name, e.expectSize);
      if (e.expectCompressed !== null && compressed !== e.expectCompressed) throw sizeMismatch(e.name, e.expectCompressed);
      if (e.expectCrc !== null && crc !== e.expectCrc) {
        throw corrupt('crc_mismatch', `CRC-32 entri ${e.name} tidak sesuai yang dinyatakan / The CRC-32 of entry ${e.name} is not the one declared`);
      }
      await append(tail, true, true);
    });
    offset += tailBytes;
    await io(central, () => appendCentral(record));
    centralBytes += record.byteLength;
    entries += 1;
    written.add(e.name);
    open = null;
  }

  return {
    get bytesWritten() {
      return offset;
    },

    beginEntry(name, o) {
      return call('beginEntry', async () => {
        const nameBytes = checkNew(name, o?.method, 'beginEntry');
        const { method, size, crc32: crc } = o;
        if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) throw new TypeError('ZipWriter.beginEntry: size must be a non-negative safe integer');
        if (crc !== undefined && (!Number.isInteger(crc) || crc < 0 || crc > MARK32)) throw new TypeError('ZipWriter.beginEntry: crc32 must be an unsigned 32-bit integer');
        if (crc !== undefined && size === undefined) throw new TypeError('ZipWriter.beginEntry: crc32 goes with size');
        const known = method === 0 && size !== undefined && crc !== undefined;
        const e: OpenEntry = {
          name,
          nameBytes,
          method,
          headerOffset: offset,
          crc: 0,
          compressedSize: 0,
          size: 0,
          zip64: forceZip64 || offset >= MARK32 || (size !== undefined && size >= MARK32),
          descriptor: mode === 'always' || !known,
          segmented: method === 8,
          expectSize: size ?? null,
          expectCrc: crc ?? null,
          expectCompressed: method === 0 ? (size ?? null) : null,
        };
        const header = localHeader(e, stamp);
        checkBytes(header.byteLength);
        await io(path, () => append([header], false, false));
        offset += header.byteLength;
        open = e;
      });
    },

    write(chunk) {
      return call('write', async () => {
        const e = open;
        if (e === null) throw new TypeError('ZipWriter.write: no entry is open');
        if (!(chunk instanceof Uint8Array)) throw new TypeError('ZipWriter.write: chunk must be a Uint8Array');
        if (chunk.byteLength === 0) return;
        const data = e.method === 8 ? deflateRawSync(chunk, { finishFlush: zlibConstants.Z_SYNC_FLUSH }) : chunk;
        const size = e.size + chunk.byteLength;
        const compressed = e.compressedSize + data.byteLength;
        checkClassic(e, size, compressed);
        checkBytes(data.byteLength);
        await io(path, async () => {
          if (e.expectSize !== null && size > e.expectSize) throw sizeMismatch(e.name, e.expectSize);
          await append([data], false, false);
        });
        offset += data.byteLength;
        e.size = size;
        e.compressedSize = compressed;
        e.crc = crc32(chunk, e.crc) >>> 0;
      });
    },

    endEntry() {
      return call('endEntry', async () => {
        const e = open;
        if (e === null) throw new TypeError('ZipWriter.endEntry: no entry is open');
        const head = e.segmented ? [FINAL_BLOCK] : [];
        const compressed = e.compressedSize + (e.segmented ? FINAL_BLOCK.byteLength : 0);
        checkClassic(e, e.size, compressed);
        await finishEntry(e, head, e.crc >>> 0, compressed);
      });
    },

    addEntry(name, bytes, o) {
      return call('addEntry', async () => {
        const nameBytes = checkNew(name, o?.method, 'addEntry');
        if (!(bytes instanceof Uint8Array)) throw new TypeError('ZipWriter.addEntry: bytes must be a Uint8Array');
        const method = o.method;
        const data = method === 8 ? deflateRawSync(bytes) : bytes;
        const crc = crc32(bytes) >>> 0;
        const e: OpenEntry = {
          name,
          nameBytes,
          method,
          headerOffset: offset,
          crc,
          compressedSize: data.byteLength,
          size: bytes.byteLength,
          zip64: forceZip64 || offset >= MARK32 || bytes.byteLength >= MARK32 || data.byteLength >= MARK32,
          descriptor: mode === 'always',
          segmented: false,
          expectSize: bytes.byteLength,
          expectCrc: crc,
          expectCompressed: data.byteLength,
        };
        // the header, the data and the descriptor go to the archive in one write
        await finishEntry(e, [localHeader(e, stamp), data], crc, data.byteLength);
      });
    },

    checkpoint() {
      return call('checkpoint', async () => {
        await io(path, () => append([], true, true));
        base = {
          offset,
          entries,
          centralBytes,
          open:
            open === null
              ? null
              : {
                  name: open.name,
                  method: open.method,
                  headerOffset: open.headerOffset,
                  crc32: open.crc >>> 0,
                  compressedSize: open.compressedSize,
                  size: open.size,
                  zip64: open.zip64,
                },
        };
        return { ...base, open: base.open === null ? null : { ...base.open } };
      });
    },

    finish() {
      return call('finish', async () => {
        if (open !== null) throw new TypeError(`ZipWriter.finish: entry ${open.name} is still open`);
        if (pendingBytes !== 0 || flushed !== offset) throw new Error('ZipWriter.finish: bytes of a finished entry are still pending');
        const zip64 = forceZip64 || entries >= MARK16 || offset >= MARK32 || centralBytes >= MARK32;
        const tail = endRecords(entries, offset, centralBytes, zip64);
        const size = offset + centralBytes + tail.byteLength;
        if (size > maxBytes) throw new ZipLimitError('bytes', maxBytes, size);
        await io(path, async () => {
          const info = await statOrNull(central);
          if ((info?.size ?? 0) < centralBytes) throw centralCorrupt(central, 'central_short');
          const sidecar = info === null ? null : await openRead(central);
          let handle: FileHandle | null = null;
          try {
            if (sidecar !== null && (await sidecar.stat()).size < centralBytes) throw centralCorrupt(central, 'central_short');
            handle = await openReadWrite(path);
            const check = new CentralCheck(offset);
            for (let at = 0; at < centralBytes; ) {
              const piece = await readAt(sidecar!, Math.min(CENTRAL_COPY_BYTES, centralBytes - at), at);
              if (piece.byteLength === 0) throw centralCorrupt(central, 'central_short');
              if (!check.push(piece)) throw centralCorrupt(central, 'central_mismatch');
              await writeAt(handle, piece, offset + at);
              at += piece.byteLength;
            }
            if (!check.end(entries)) throw centralCorrupt(central, 'central_mismatch');
            await writeAt(handle, tail, offset + centralBytes);
            await handle.sync();
          } finally {
            await handle?.close();
            await sidecar?.close();
          }
        });
        finished = true;
        return { size, entries };
      });
    },
  };
}
