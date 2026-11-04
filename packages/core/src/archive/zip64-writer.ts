import { randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { canonicalize, decodeBase64Url, encodeBase64Url } from '@altis/crypto';
import { ALTISBAK_ENTRY, altisbakCentralPath, openReadWrite, truncateFile, type DataPath } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { z } from 'zod';
import { ALTISBAK_HEADER_ENTRY, altisbakHeaderSchema, type AltisbakHeader } from './altisbak.js';
import { ByteQueue, NONCE_PREFIX_BYTES, STREAM_CHUNK, STREAM_TAG_BYTES, encryptChunk, encryptedSize, streamChunkCount } from './stream-cipher.js';

// The resumable `.altisbak` writer (spec §9.9 "Download": "ZIP64, entri stored, bisa dilanjutkan dengan append";
// decision C13; M18). Every entry is written in chunks of 1 MiB of plaintext, so a job slice can stop between two
// chunks and the next slice, in any process, carry on inside the same entry:
//
//   local header   signature, version 4.5, flags bit 3 (sizes and CRC in the data descriptor) and bit 11 (UTF-8
//                  name), method 0 (stored), DOS time 1980-01-01 00:00 (the archive is byte-identical whoever writes
//                  it), CRC 0, sizes 0xFFFFFFFF, name, ZIP64 extra (original and compressed size, 0: bit 3)
//   data           the plaintext, or with a DEK the STREAM ciphertext: 7-byte prefix ‖ chunks (stream-cipher.ts)
//   descriptor     ZIP64 data descriptor: signature, CRC-32 of the stored bytes, both sizes as 8 bytes
//   ...
//   central dir    one record per entry: sizes and local header offset 0xFFFFFFFF with a ZIP64 extra holding them,
//                  a Unix regular file mode 0600
//   ZIP64 end of central directory record, ZIP64 locator, classic EOCD with 0xFFFF/0xFFFFFFFF markers
//
// The central directory grows with every entry, so it is not kept in the checkpoint, which travels in a job payload
// of at most 64 KiB (ruling R1c-6): each finished entry's central record is appended to the sidecar
// `archive.central` beside the archive (altisbakCentralPath) and fsynced before writeEntry returns 'done', and
// finish() copies the sidecar in after the last entry.
//
// The checkpoint {offset, entry, chunk, plainSize, crc32, prefix, centralBytes} is fixed-size and describes what is
// durable (fsynced): `offset` bytes of the archive, `entry` finished entries whose central records are the first
// `centralBytes` bytes of the sidecar, and of entry `entry` (of `plainSize` bytes) its header and `chunk` chunks, with
// the CRC-32 of its stored bytes so far and its nonce prefix. A writer opened with a checkpoint cuts the archive back to `offset` and
// the sidecar back to `centralBytes` (whatever a crashed slice appended after them goes, an entry finished after the
// checkpoint was taken included) and continues there. No whole-archive hash is kept: a hash state cannot cross
// slices, and re-reading 20 GiB at the end would break P9 (M18).
//
// A resume inside an entry encrypts its next chunks under the nonce prefix already on disk, which is safe only when
// the source yields the same bytes again. So only table parts and blobs (files never rewritten) pause inside;
// `manifest.json` is written whole, and from its start under a fresh prefix should a checkpoint lie inside it (R1c-6).
//
// The writer opens its files for each call and closes them before returning, so a paused writer holds nothing open
// and can simply be dropped. The sidecar stays after finish() (a repeated finish() needs it); it goes with its
// folder.

/** The flags of every entry: bit 3 (data descriptor) and bit 11 (UTF-8 name). */
const FLAGS = 0x0808;
/** Version 4.5 (ZIP64); made by Unix (3). */
const VERSION_NEEDED = 45;
const VERSION_MADE_BY = (3 << 8) | 45;
/** 1980-01-01 00:00:00, the earliest DOS date: constant, so that a resumed archive is byte-identical. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
/** A regular file, mode 0600, in the high half of the external attributes. */
const EXTERNAL_ATTRIBUTES = (0o100600 << 16) >>> 0;
const LOCAL_HEADER_BYTES = 30;
const LOCAL_EXTRA_BYTES = 4 + 16;
const CENTRAL_HEADER_BYTES = 46;
const CENTRAL_EXTRA_BYTES = 4 + 24;
const DESCRIPTOR_BYTES = 24;
const ZIP64_EOCD_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;
const EOCD_BYTES = 22;
const MARK16 = 0xffff;
const MARK32 = 0xffff_ffff;
/** A 7-byte nonce prefix as unpadded base64url. */
const PREFIX_TEXT = /^[A-Za-z0-9_-]{10}$/;

/** One finished entry: its name, the CRC-32 and size of its stored bytes, and where its local header begins. */
interface CentralRecord {
  name: string;
  crc32: number;
  size: number;
  offset: number;
}

/**
 * What is durable in the archive and its sidecar (see the module comment). Plain JSON of a fixed size (well under
 * 1 KiB, whatever the number of entries): it travels in a job payload (ruling R1c-6).
 */
export interface AltisbakCheckpoint {
  /** The archive's durable length. */
  offset: number;
  /** The number of finished entries, the header `altisbak.json` included (so at least 1). */
  entry: number;
  /** The chunks of entry `entry` already written (0: between entries). */
  chunk: number;
  /** The plaintext size of entry `entry` in progress (0 between entries): a resume must declare the same. */
  plainSize: number;
  /** The CRC-32 of the stored bytes of entry `entry` so far (0 between entries). */
  crc32: number;
  /** The nonce prefix (base64url) of the encrypted entry in progress; null between entries and without a DEK. */
  prefix: string | null;
  /** The sidecar's durable length: the central records of the `entry` finished entries. */
  centralBytes: number;
}

export interface AltisbakWriter {
  /**
   * Writes entry `name` (an ALTISBAK_ENTRY name other than the header) of `plainSize` bytes, which `source(fromByte)`
   * yields from byte `fromByte` on (a new call with a later `fromByte` after a pause). A `tables/` or `blobs/` entry
   * writes at least one chunk, then pauses between chunks once `clock() ≥ deadline`: 'paused' (call again, in this or
   * a new writer opened with checkpoint(), with the same name, size and source, which must yield the same bytes: a
   * file that is never rewritten) or 'done'. `manifest.json` is generated, so it never pauses: it is written whole,
   * and written again from its start under a fresh nonce prefix should a checkpoint lie inside it (ruling R1c-6). Either way what was written is fsynced first; for
   * 'done' the entry's central record is appended to the sidecar and fsynced too.
   *
   * @throws TypeError for a name that is not allowed or already written by this writer (one written by an earlier
   *   writer is refused by finish()), another entry than the one in progress, a call while another runs or after
   *   finish
   * @throws DomainError STATE_CORRUPT (`size_mismatch`) when the source yields fewer or more bytes than `plainSize`;
   *   DISK_QUOTA (P21); the source's own errors. The checkpoint then stays at the last durable state.
   */
  writeEntry(
    name: string,
    plainSize: number,
    source: (fromByte: number) => AsyncIterable<Uint8Array>,
    o: { deadline: number },
  ): Promise<'done' | 'paused'>;
  /** The durable state: what openAltisbakWriter needs to continue (a copy; JSON-safe). */
  checkpoint(): AltisbakCheckpoint;
  /**
   * Writes the central directory (the sidecar's records, checked as they are copied) and the end records after the
   * last entry, fsyncs, and returns the archive's size. Can be repeated from the same checkpoint by a new writer (a
   * crash before the caller recorded it): the sidecar is left in place.
   *
   * @throws TypeError while an entry is in progress, or a second time
   * @throws DomainError STATE_CORRUPT (`central_short`, `central_mismatch`) when the sidecar is shorter than the
   *   checkpoint or its bytes are not the central records of `entry` distinct entries; DISK_QUOTA (P21)
   */
  finish(): Promise<{ size: number }>;
}

export interface OpenAltisbakWriterOptions {
  header: AltisbakHeader;
  /** The DEK (32 bytes) of an encrypted archive (`header.encryption` set), null for a plain one. */
  dek: Uint8Array | null;
  /** Where to continue (null: a new archive, any old file at `path` is cut to nothing). */
  checkpoint: AltisbakCheckpoint | null;
  /** The source of nonce prefixes (default the CSPRNG); a test seam. */
  random?: (n: number) => Uint8Array;
  /** The clock deadlines are compared with (epoch ms; default Date.now); a test seam. */
  clock?: () => number;
}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const crcValue = z.number().int().min(0).max(MARK32);
/** The shape of an {@link AltisbakCheckpoint} (strict), for a job payload that carries one (Task 21). */
export const altisbakCheckpointSchema = z.strictObject({
  offset: count,
  entry: count.min(1),
  chunk: count,
  plainSize: count,
  crc32: crcValue,
  prefix: z.string().regex(PREFIX_TEXT).nullable(),
  centralBytes: count,
});

/** The shortest and the longest central record (names of 13 to 82 bytes: ALTISBAK_ENTRY). */
const CENTRAL_RECORD_MIN = CENTRAL_HEADER_BYTES + 13 + CENTRAL_EXTRA_BYTES;
const CENTRAL_RECORD_MAX = CENTRAL_HEADER_BYTES + 82 + CENTRAL_EXTRA_BYTES;
/**
 * The entries whose source cannot change between slices: table parts and content-addressed blobs, read from files
 * that are never rewritten. Only these pause inside, and a resume inside one goes on under its nonce prefix. Any
 * other entry (`manifest.json`; the header) is generated, so it is written whole in one call, and a checkpoint inside
 * one makes the writer write it again from its start under a fresh prefix (ruling R1c-6).
 */
const RESUMABLE_ENTRY = /^(tables|blobs)\//;
/** How much of the sidecar finish() copies at a time. */
const CENTRAL_COPY_BYTES = 1_048_576;

/** The sidecar is shorter than its checkpoint, or does not hold the central records of the entries written. */
function centralCorrupt(path: string, reason: 'central_short' | 'central_mismatch'): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail:
      `Catatan direktori pusat ${path} tidak cocok dengan titik lanjut arsip / ` +
      `The central directory records ${path} do not match the archive's checkpoint`,
    meta: { reason },
  });
}

function sizeMismatch(name: string, plainSize: number): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail:
      `Isi entri ${name} tidak berjumlah ${plainSize} byte seperti yang dinyatakan / ` +
      `The content of entry ${name} is not the ${plainSize} bytes declared`,
    meta: { reason: 'size_mismatch' },
  });
}

/** `ENOSPC`/`EDQUOT` from a write or fsync as DISK_QUOTA (P21); anything else as it is. */
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

function u64(buffer: Buffer, value: number, at: number): void {
  buffer.writeBigUInt64LE(BigInt(value), at);
}

function localHeader(name: Buffer): Buffer {
  const b = Buffer.alloc(LOCAL_HEADER_BYTES + name.byteLength + LOCAL_EXTRA_BYTES);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(VERSION_NEEDED, 4);
  b.writeUInt16LE(FLAGS, 6);
  b.writeUInt16LE(0, 8); // stored
  b.writeUInt16LE(DOS_TIME, 10);
  b.writeUInt16LE(DOS_DATE, 12);
  b.writeUInt32LE(0, 14); // CRC-32: in the data descriptor
  b.writeUInt32LE(MARK32, 18);
  b.writeUInt32LE(MARK32, 22);
  b.writeUInt16LE(name.byteLength, 26);
  b.writeUInt16LE(LOCAL_EXTRA_BYTES, 28);
  name.copy(b, LOCAL_HEADER_BYTES);
  const x = LOCAL_HEADER_BYTES + name.byteLength;
  b.writeUInt16LE(0x0001, x);
  b.writeUInt16LE(16, x + 2);
  // original and compressed size: 0 here, as bit 3 asks; the data descriptor holds them
  return b;
}

function dataDescriptor(crc: number, size: number): Buffer {
  const b = Buffer.alloc(DESCRIPTOR_BYTES);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(crc, 4);
  u64(b, size, 8);
  u64(b, size, 16);
  return b;
}

function centralRecord(r: CentralRecord): Buffer {
  const name = Buffer.from(r.name, 'utf8');
  const b = Buffer.alloc(CENTRAL_HEADER_BYTES + name.byteLength + CENTRAL_EXTRA_BYTES);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(VERSION_MADE_BY, 4);
  b.writeUInt16LE(VERSION_NEEDED, 6);
  b.writeUInt16LE(FLAGS, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(DOS_TIME, 12);
  b.writeUInt16LE(DOS_DATE, 14);
  b.writeUInt32LE(r.crc32, 16);
  b.writeUInt32LE(MARK32, 20);
  b.writeUInt32LE(MARK32, 24);
  b.writeUInt16LE(name.byteLength, 28);
  b.writeUInt16LE(CENTRAL_EXTRA_BYTES, 30);
  b.writeUInt16LE(0, 32); // comment
  b.writeUInt16LE(0, 34); // disk
  b.writeUInt16LE(0, 36); // internal attributes
  b.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
  b.writeUInt32LE(MARK32, 42);
  name.copy(b, CENTRAL_HEADER_BYTES);
  const x = CENTRAL_HEADER_BYTES + name.byteLength;
  b.writeUInt16LE(0x0001, x);
  b.writeUInt16LE(24, x + 2);
  u64(b, r.size, x + 4); // original size
  u64(b, r.size, x + 12); // compressed size
  u64(b, r.offset, x + 20); // local header offset
  return b;
}

/** The ZIP64 end of central directory record, its locator and the classic EOCD with the ZIP64 markers. */
function endRecords(entries: number, cdOffset: number, cdSize: number): Buffer {
  const b = Buffer.alloc(ZIP64_EOCD_BYTES + ZIP64_LOCATOR_BYTES + EOCD_BYTES);
  b.writeUInt32LE(0x06064b50, 0);
  u64(b, ZIP64_EOCD_BYTES - 12, 4);
  b.writeUInt16LE(VERSION_MADE_BY, 12);
  b.writeUInt16LE(VERSION_NEEDED, 14);
  b.writeUInt32LE(0, 16); // this disk
  b.writeUInt32LE(0, 20); // the disk of the central directory
  u64(b, entries, 24);
  u64(b, entries, 32);
  u64(b, cdSize, 40);
  u64(b, cdOffset, 48);
  const l = ZIP64_EOCD_BYTES;
  b.writeUInt32LE(0x07064b50, l);
  b.writeUInt32LE(0, l + 4);
  u64(b, cdOffset + cdSize, l + 8);
  b.writeUInt32LE(1, l + 16);
  const e = l + ZIP64_LOCATOR_BYTES;
  b.writeUInt32LE(0x06054b50, e);
  b.writeUInt16LE(0, e + 4);
  b.writeUInt16LE(0, e + 6);
  b.writeUInt16LE(MARK16, e + 8);
  b.writeUInt16LE(MARK16, e + 10);
  b.writeUInt32LE(MARK32, e + 12);
  b.writeUInt32LE(MARK32, e + 16);
  b.writeUInt16LE(0, e + 20);
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

/** Pulls exact-size pieces out of an async iterable of bytes. */
class Pull {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly queue = new ByteQueue();
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  /** Exactly `n` bytes, or null when the source ends first. */
  async take(n: number): Promise<Buffer | null> {
    while (this.queue.length < n && !this.ended) {
      const next = await this.iterator.next();
      if (next.done === true) this.ended = true;
      else if (!(next.value instanceof Uint8Array)) throw new TypeError('writeEntry: the source must yield Uint8Arrays');
      else this.queue.push(next.value);
    }
    return this.queue.length < n ? null : this.queue.take(n);
  }

  /** Whether the source has nothing more. */
  async exhausted(): Promise<boolean> {
    return (await this.take(1)) === null;
  }

  /** Lets the source release what it holds (a file it reads). */
  async close(): Promise<void> {
    if (!this.ended) await this.iterator.return?.();
  }
}

interface State {
  offset: number;
  entry: number;
  chunk: number;
  plainSize: number;
  crc32: number;
  prefix: Uint8Array | null;
  centralBytes: number;
}

function copyCheckpoint(s: State): AltisbakCheckpoint {
  return {
    offset: s.offset,
    entry: s.entry,
    chunk: s.chunk,
    plainSize: s.plainSize,
    crc32: s.crc32,
    prefix: s.prefix === null ? null : encodeBase64Url(s.prefix),
    centralBytes: s.centralBytes,
  };
}

/** A checkpoint as checkpoint() returns them, or a TypeError. */
function stateOf(cp: AltisbakCheckpoint, encrypted: boolean): State {
  const parsed = altisbakCheckpointSchema.safeParse(cp);
  const bad = (why: string): TypeError => new TypeError(`openAltisbakWriter: the checkpoint is not valid (${why})`);
  if (!parsed.success) throw bad('shape');
  const c = parsed.data;
  // the records of `entry` finished entries, each of a length a name of the grammar gives
  if (c.centralBytes < c.entry * CENTRAL_RECORD_MIN || c.centralBytes > c.entry * CENTRAL_RECORD_MAX) throw bad('centralBytes');
  const inEncryptedEntry = c.chunk > 0 && encrypted;
  if ((c.prefix !== null) !== inEncryptedEntry) throw bad('prefix');
  const prefix = c.prefix === null ? null : decodeBase64Url(c.prefix);
  if (prefix !== null && prefix.byteLength !== NONCE_PREFIX_BYTES) throw bad('prefix');
  if (c.chunk === 0 && c.crc32 !== 0) throw bad('crc32');
  // inside an entry, at least one chunk is still to come; between entries, no size
  if (c.chunk === 0 ? c.plainSize !== 0 : c.plainSize <= c.chunk * STREAM_CHUNK) throw bad('plainSize');
  return { offset: c.offset, entry: c.entry, chunk: c.chunk, plainSize: c.plainSize, crc32: c.crc32, prefix, centralBytes: c.centralBytes };
}

/**
 * Checks, as finish() copies them, that the sidecar's bytes are `entries` central records as centralRecord() writes
 * them: names of the grammar, the header first, no name twice, local headers in increasing order before `offset`.
 */
class CentralCheck {
  private pending: Buffer = Buffer.alloc(0);
  private readonly names = new Set<string>();
  private previous = -1;

  constructor(private readonly offset: number) {}

  /** Takes the next bytes; false as soon as they cannot be such records. */
  push(bytes: Buffer): boolean {
    let data = this.pending.byteLength > 0 ? Buffer.concat([this.pending, bytes]) : bytes;
    while (data.byteLength >= CENTRAL_HEADER_BYTES) {
      const nameLength = data.readUInt16LE(28);
      const length = CENTRAL_HEADER_BYTES + nameLength + CENTRAL_EXTRA_BYTES;
      if (data.byteLength < length) break;
      if (!this.record(data.subarray(0, length), nameLength)) return false;
      data = data.subarray(length);
    }
    this.pending = Buffer.from(data);
    return true;
  }

  /** Whether the bytes taken were exactly `entries` whole records. */
  end(entries: number): boolean {
    return this.pending.byteLength === 0 && this.names.size === entries;
  }

  private record(r: Buffer, nameLength: number): boolean {
    if (r.readUInt32LE(0) !== 0x02014b50 || r.readUInt16LE(30) !== CENTRAL_EXTRA_BYTES) return false;
    const name = r.toString('utf8', CENTRAL_HEADER_BYTES, CENTRAL_HEADER_BYTES + nameLength);
    if (!ALTISBAK_ENTRY.test(name) || this.names.has(name)) return false;
    if ((this.names.size === 0) !== (name === ALTISBAK_HEADER_ENTRY)) return false;
    const x = CENTRAL_HEADER_BYTES + nameLength;
    if (r.readUInt16LE(x) !== 0x0001 || r.readUInt16LE(x + 2) !== 24) return false;
    const at = Number(r.readBigUInt64LE(x + 20));
    if (at <= this.previous || at >= this.offset) return false;
    this.previous = at;
    this.names.add(name);
    return true;
  }
}

/**
 * Opens the `.altisbak` archive `path` (an `archive.altisbak`; its sidecar is altisbakCentralPath(path)) for writing:
 * a new one (checkpoint null: both files are cut to nothing and the clear header `altisbak.json` written as the first
 * entry) or the one `checkpoint` describes (the archive is cut back to `checkpoint.offset`, the sidecar to
 * `checkpoint.centralBytes`).
 *
 * @throws TypeError for a header that does not fit the format, a DEK that is not 32 bytes or does not match
 *   `header.encryption` (both or neither), a checkpoint that checkpoint() cannot have returned
 * @throws DomainError STATE_CORRUPT (`archive_short`, `central_short`) when the archive or the sidecar is shorter than
 *   the checkpoint says (replaced or cut); DISK_QUOTA (P21); INVALID_PATH_SEGMENT when `path` is not an
 *   `archive.altisbak` (altisbakCentralPath)
 */
export async function openAltisbakWriter(path: DataPath, o: OpenAltisbakWriterOptions): Promise<AltisbakWriter> {
  const header = altisbakHeaderSchema.safeParse(o?.header);
  if (!header.success) throw new TypeError('openAltisbakWriter: the header does not fit the altisbak.json format');
  const dek = o.dek;
  if (dek !== null && (!(dek instanceof Uint8Array) || dek.byteLength !== 32)) throw new TypeError('openAltisbakWriter: the DEK must be 32 bytes');
  if ((dek !== null) !== (header.data.encryption !== null)) {
    throw new TypeError('openAltisbakWriter: a DEK goes with header.encryption, and only with it');
  }
  const random = o.random ?? ((n: number) => randomBytes(n));
  const clock = o.clock ?? Date.now;
  if (typeof random !== 'function' || typeof clock !== 'function') throw new TypeError('openAltisbakWriter: random and clock must be functions');

  const central = altisbakCentralPath(path);
  /** The size of `p`, created empty when missing. */
  const sizeOf = async (p: DataPath): Promise<number> => {
    const handle = await openReadWrite(p);
    try {
      return (await handle.stat()).size;
    } finally {
      await handle.close();
    }
  };

  let state: State;
  if (o.checkpoint === null) {
    state = { offset: 0, entry: 0, chunk: 0, plainSize: 0, crc32: 0, prefix: null, centralBytes: 0 };
    await sizeOf(path);
    await truncateFile(path, 0);
    await sizeOf(central);
    await truncateFile(central, 0);
  } else {
    state = stateOf(o.checkpoint, dek !== null);
    if ((await sizeOf(path)) < state.offset) {
      throw new DomainError('STATE_CORRUPT', {
        detail: `Arsip ${path} lebih pendek dari titik lanjutnya / The archive ${path} is shorter than its checkpoint`,
        meta: { reason: 'archive_short' },
      });
    }
    if ((await sizeOf(central)) < state.centralBytes) throw centralCorrupt(central, 'central_short');
    await truncateFile(path, state.offset);
    await truncateFile(central, state.centralBytes);
  }
  /** The names written by this writer: a name already written by an earlier one is refused by finish(). */
  const written = new Set<string>();

  /**
   * Appends `record` at `state.centralBytes` of the sidecar (cut there first) and fsyncs it; on failure the sidecar
   * is cut back again.
   */
  async function appendCentral(record: Buffer): Promise<void> {
    const handle = await openReadWrite(central);
    try {
      await handle.truncate(state.centralBytes);
      await writeAt(handle, record, state.centralBytes);
      await handle.sync();
    } catch (error) {
      await handle.truncate(state.centralBytes).catch(() => undefined);
      throw quotaMapped(error, central);
    } finally {
      await handle.close();
    }
  }

  let busy = false;
  let finished = false;

  /** One entry, or its continuation (see AltisbakWriter.writeEntry). */
  async function write(
    name: string,
    plainSize: number,
    source: (fromByte: number) => AsyncIterable<Uint8Array>,
    deadline: number,
    encrypted: boolean,
  ): Promise<'done' | 'paused'> {
    const nameBytes = Buffer.from(name, 'utf8');
    const headerBytes = LOCAL_HEADER_BYTES + nameBytes.byteLength + LOCAL_EXTRA_BYTES;
    const chunks = streamChunkCount(plainSize);
    const storedSize = encrypted ? encryptedSize(plainSize) : plainSize;
    const resumable = RESUMABLE_ENTRY.test(name);
    let chunk = state.chunk;
    let { offset: position, crc32: crc, prefix } = state;
    // A part or blob goes on where it paused: it must be the same size (its chunks then reach past `chunk`). A
    // generated entry starts again below, whatever its size now.
    if (chunk > 0 && resumable && (plainSize !== state.plainSize || chunk >= chunks)) {
      throw new TypeError(`writeEntry: the entry in progress has ${state.plainSize} bytes, not ${plainSize}`);
    }

    const handle = await openReadWrite(path);
    let pull: Pull | null = null;
    try {
      let headerAt = position;
      if (chunk > 0) {
        // Inside an entry: every chunk before `chunk` was a full one, so the header lies a known distance back.
        const stored = encrypted ? NONCE_PREFIX_BYTES + chunk * (STREAM_CHUNK + STREAM_TAG_BYTES) : chunk * STREAM_CHUNK;
        headerAt = position - stored - headerBytes;
        const head = headerAt >= 0 ? await readAt(handle, LOCAL_HEADER_BYTES + nameBytes.byteLength, headerAt) : Buffer.alloc(0);
        if (
          head.byteLength !== LOCAL_HEADER_BYTES + nameBytes.byteLength ||
          head.readUInt32LE(0) !== 0x04034b50 ||
          !head.subarray(LOCAL_HEADER_BYTES).equals(nameBytes)
        ) {
          throw new TypeError(`writeEntry: the entry in progress is not ${name}`);
        }
        if (!resumable) {
          // A generated entry may come out with other bytes this time: it is written again from its start under a
          // fresh nonce prefix, so that no (prefix, index) nonce encrypts two different plaintexts (ruling R1c-6). The
          // durable state steps back to the entry's start, which is durable since the checkpoint lies after it.
          state = { ...state, offset: headerAt, chunk: 0, plainSize: 0, crc32: 0, prefix: null };
          position = headerAt;
          chunk = 0;
        }
      }
      if (chunk === 0) {
        await writeAt(handle, localHeader(nameBytes), position);
        position += headerBytes;
        crc = 0;
        prefix = null;
        if (encrypted) {
          prefix = random(NONCE_PREFIX_BYTES);
          if (!(prefix instanceof Uint8Array) || prefix.byteLength !== NONCE_PREFIX_BYTES) throw new TypeError('random() must return the bytes asked for');
          await writeAt(handle, prefix, position);
          position += NONCE_PREFIX_BYTES;
          crc = crc32(prefix, crc);
        }
      }

      pull = new Pull(source(chunk * STREAM_CHUNK));
      for (let k = chunk; k < chunks; k += 1) {
        const want = Math.min(STREAM_CHUNK, plainSize - k * STREAM_CHUNK);
        const plain = await pull.take(want);
        if (plain === null) throw sizeMismatch(name, plainSize);
        const data = encrypted ? encryptChunk(dek!, prefix!, k, k === chunks - 1, name, plain) : plain;
        await writeAt(handle, data, position);
        position += data.byteLength;
        crc = crc32(data, crc);
        if (resumable && k + 1 < chunks && clock() >= deadline) {
          await handle.sync();
          state = { ...state, offset: position, chunk: k + 1, plainSize, crc32: crc, prefix };
          return 'paused';
        }
      }
      if (!(await pull.exhausted())) throw sizeMismatch(name, plainSize);
      await writeAt(handle, dataDescriptor(crc, storedSize), position);
      position += DESCRIPTOR_BYTES;
      if (position - headerAt !== headerBytes + storedSize + DESCRIPTOR_BYTES) throw new Error('writeEntry: the entry has the wrong length');
      await handle.sync();
      const record = centralRecord({ name, crc32: crc >>> 0, size: storedSize, offset: headerAt });
      await appendCentral(record);
      written.add(name);
      state = {
        offset: position,
        entry: state.entry + 1,
        chunk: 0,
        plainSize: 0,
        crc32: 0,
        prefix: null,
        centralBytes: state.centralBytes + record.byteLength,
      };
      return 'done';
    } catch (error) {
      // Back to the last durable state, which also frees what this call wrote (P21: no partial bytes left).
      await handle.truncate(state.offset).catch(() => undefined);
      throw quotaMapped(error, path);
    } finally {
      await pull?.close().catch(() => undefined);
      await handle.close();
    }
  }

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (finished) throw new TypeError('AltisbakWriter: the archive is finished');
    if (busy) throw new TypeError('AltisbakWriter: another call is still running');
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }

  if (o.checkpoint === null) {
    const bytes = Buffer.from(canonicalize(header.data), 'utf8');
    await write(ALTISBAK_HEADER_ENTRY, bytes.byteLength, async function* (from) {
      yield bytes.subarray(from);
    }, Number.POSITIVE_INFINITY, false);
  }

  return {
    writeEntry(name, plainSize, source, s) {
      return guarded(async () => {
        if (typeof name !== 'string' || !ALTISBAK_ENTRY.test(name) || name === ALTISBAK_HEADER_ENTRY) {
          throw new TypeError(`writeEntry: ${JSON.stringify(name)} is not an entry name of an archive`);
        }
        if (written.has(name)) throw new TypeError(`writeEntry: ${name} is written already`);
        if (!Number.isSafeInteger(plainSize) || plainSize < 0) throw new TypeError('writeEntry: plainSize must be a non-negative safe integer');
        if (typeof source !== 'function') throw new TypeError('writeEntry: source must be a function');
        if (typeof s?.deadline !== 'number' || Number.isNaN(s.deadline)) throw new TypeError('writeEntry: deadline must be a number');
        return write(name, plainSize, source, s.deadline, dek !== null);
      });
    },
    checkpoint: () => copyCheckpoint(state),
    finish() {
      return guarded(async () => {
        if (state.chunk !== 0) throw new TypeError('finish: an entry is still in progress');
        const directoryBytes = state.centralBytes;
        const tail = endRecords(state.entry, state.offset, directoryBytes);
        await truncateFile(path, state.offset);
        const records = await openReadWrite(central);
        let handle: FileHandle | null = null;
        try {
          if ((await records.stat()).size < directoryBytes) throw centralCorrupt(central, 'central_short');
          handle = await openReadWrite(path);
          // the central directory: the sidecar's records, checked as they are copied in
          const check = new CentralCheck(state.offset);
          for (let at = 0; at < directoryBytes; ) {
            const piece = await readAt(records, Math.min(CENTRAL_COPY_BYTES, directoryBytes - at), at);
            if (piece.byteLength === 0) throw centralCorrupt(central, 'central_short');
            if (!check.push(piece)) throw centralCorrupt(central, 'central_mismatch');
            await writeAt(handle, piece, state.offset + at);
            at += piece.byteLength;
          }
          if (!check.end(state.entry)) throw centralCorrupt(central, 'central_mismatch');
          await writeAt(handle, tail, state.offset + directoryBytes);
          await handle.sync();
        } catch (error) {
          await handle?.truncate(state.offset).catch(() => undefined);
          throw quotaMapped(error, path);
        } finally {
          await handle?.close();
          await records.close();
        }
        finished = true;
        return { size: state.offset + directoryBytes + tail.byteLength };
      });
    },
  };
}
