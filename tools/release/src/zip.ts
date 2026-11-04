import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// A small, reproducible ZIP writer for the release zip (Task 17 rulings), and the reader the tests and the smoke run
// use to unpack it.
//
// Reproducible: the same entries give the same bytes. Every entry has the fixed modification time 2026-01-01 00:00
// (DOS time, no time zone), the mode of a regular file 0644 (UNIX "version made by", so extractors honour it), no
// extra field (no uid/gid/atime/mtime of the build host), no data descriptor, no comment. Entries are written in the
// order given; the caller sorts them. Data is deflated (zlib's deflateRaw, level 9) when that saves bytes, otherwise
// stored; deflate output is stable for one zlib build, so byte-identical zips assume the same Node.js release.
//
// Limits: ZIP64 is not written (under 4 GiB and 65 535 entries, far above a release); names are plain relative POSIX
// paths; no directory entries (extractors create the folders).

/** DOS date of 2026-01-01: (year − 1980) << 9 | month << 5 | day. */
export const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
/** DOS time 00:00:00. */
export const DOS_TIME = 0;
/** Permission bits of every entry. */
export const FILE_MODE = 0o644;

const S_IFREG = 0o100000;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_BYTES = 22;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** ZIP 2.0: deflate. */
const VERSION_NEEDED_DEFLATE = 20;
const VERSION_NEEDED_STORE = 10;
/** Host system 3 (UNIX) in the high byte: the external attributes carry a POSIX mode. */
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED_DEFLATE;
/** General purpose flag bit 11: the name is UTF-8. */
const FLAG_UTF8 = 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_32 = 0xffffffff;

export interface ZipInput {
  /** Relative POSIX path: no leading `/`, no empty, `.` or `..` segment, no backslash. */
  path: string;
  data: Uint8Array;
}

export interface ZipEntry {
  path: string;
  data: Buffer;
  method: number;
  compressedSize: number;
  /** POSIX mode from the external attributes (type bits included), e.g. 0o100644. */
  mode: number;
  dosDate: number;
  dosTime: number;
  flags: number;
  versionMadeBy: number;
  /** Extra field length in the central directory and in the local header. */
  extraLength: number;
  localExtraLength: number;
}

function zipError(code: string, detail: string): Error {
  return new Error(`${code}:${detail}`);
}

function checkPath(name: string): void {
  const bad =
    name === '' ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
  if (bad) throw zipError('ZIP_INVALID_PATH', JSON.stringify(name));
}

/**
 * The largest expansion a deflated entry may have: the readers refuse any entry above it as a zip bomb (spec §7.5,
 * 1c openArchive, the update package check), so the writer stores an entry that would compress further.
 */
export const MAX_DEFLATE_RATIO = 10;

/** The entry's data as written: deflated when that is smaller and within {@link MAX_DEFLATE_RATIO}, else stored. */
function encode(data: Uint8Array): { method: number; bytes: Buffer } {
  if (data.length > 0) {
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    if (deflated.length < data.length && data.length <= MAX_DEFLATE_RATIO * deflated.length) {
      return { method: METHOD_DEFLATE, bytes: deflated };
    }
  }
  return { method: METHOD_STORE, bytes: Buffer.from(data.buffer, data.byteOffset, data.byteLength) };
}

/**
 * The ZIP archive of `entries`, in the order given.
 *
 * @throws Error `ZIP_INVALID_PATH:<name>`, `ZIP_DUPLICATE_PATH:<name>`, `ZIP_TOO_LARGE:<what>`
 */
export function writeZip(entries: readonly ZipInput[]): Buffer {
  if (entries.length > MAX_ENTRIES) throw zipError('ZIP_TOO_LARGE', `${entries.length} entries`);
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    checkPath(entry.path);
    if (seen.has(entry.path)) throw zipError('ZIP_DUPLICATE_PATH', entry.path);
    seen.add(entry.path);
    const name = Buffer.from(entry.path, 'utf8');
    const flags = /^[\x20-\x7e]*$/.test(entry.path) ? 0 : FLAG_UTF8;
    const { method, bytes } = encode(entry.data);
    const crc = zlib.crc32(entry.data) >>> 0;
    const versionNeeded = method === METHOD_DEFLATE ? VERSION_NEEDED_DEFLATE : VERSION_NEEDED_STORE;
    if (entry.data.length > MAX_32 || bytes.length > MAX_32 || offset > MAX_32) throw zipError('ZIP_TOO_LARGE', entry.path);

    const local = Buffer.alloc(LOCAL_HEADER_BYTES);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(versionNeeded, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, bytes);

    const central = Buffer.alloc(CENTRAL_HEADER_BYTES);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(versionNeeded, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(((S_IFREG | FILE_MODE) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += LOCAL_HEADER_BYTES + name.length + bytes.length;
  }
  const centralBytes = centrals.reduce((sum, b) => sum + b.length, 0);
  if (offset + centralBytes > MAX_32) throw zipError('ZIP_TOO_LARGE', 'archive');
  const end = Buffer.alloc(END_BYTES);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

function invalid(detail: string): Error {
  return zipError('ZIP_INVALID', detail);
}

function findEnd(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - END_BYTES - 0xffff);
  for (let at = zip.length - END_BYTES; at >= lowest; at--) {
    if (zip.readUInt32LE(at) === END_SIGNATURE && at + END_BYTES + zip.readUInt16LE(at + 20) === zip.length) return at;
  }
  throw invalid('no end of central directory');
}

/**
 * Every entry of a ZIP archive, in central-directory order, with its data inflated and its CRC-32 checked. Reads what
 * {@link writeZip} writes (and other plain archives: stored or deflated, no encryption, no ZIP64, single disk).
 *
 * @throws Error `ZIP_INVALID:<detail>`
 */
export function readZip(input: Uint8Array): ZipEntry[] {
  const zip = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (zip.length < END_BYTES) throw invalid('too short');
  const end = findEnd(zip);
  const count = zip.readUInt16LE(end + 10);
  const centralSize = zip.readUInt32LE(end + 12);
  let at = zip.readUInt32LE(end + 16);
  if (at + centralSize > end) throw invalid('central directory out of range');

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_HEADER_BYTES > end || zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw invalid(`central header ${i}`);
    const versionMadeBy = zip.readUInt16LE(at + 4);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const dosTime = zip.readUInt16LE(at + 12);
    const dosDate = zip.readUInt16LE(at + 14);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const external = zip.readUInt32LE(at + 38);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + CENTRAL_HEADER_BYTES, at + CENTRAL_HEADER_BYTES + nameLength).toString('utf8');
    at += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;

    if ((flags & 0x0001) !== 0) throw invalid(`${name}: encrypted`);
    if (localAt + LOCAL_HEADER_BYTES > zip.length || zip.readUInt32LE(localAt) !== LOCAL_SIGNATURE) throw invalid(`${name}: local header`);
    const localNameLength = zip.readUInt16LE(localAt + 26);
    const localExtraLength = zip.readUInt16LE(localAt + 28);
    const start = localAt + LOCAL_HEADER_BYTES + localNameLength + localExtraLength;
    if (start + compressedSize > zip.length) throw invalid(`${name}: data out of range`);
    const raw = zip.subarray(start, start + compressedSize);
    let data: Buffer;
    if (method === METHOD_STORE) data = Buffer.from(raw);
    else if (method === METHOD_DEFLATE) {
      try {
        data = zlib.inflateRawSync(raw);
      } catch (error) {
        throw invalid(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else throw invalid(`${name}: method ${method}`);
    if (data.length !== size || zlib.crc32(data) >>> 0 !== crc) throw invalid(`${name}: size or CRC-32 mismatch`);
    entries.push({
      path: name,
      data,
      method,
      compressedSize,
      mode: external >>> 16,
      dosDate,
      dosTime,
      flags,
      versionMadeBy,
      extraLength,
      localExtraLength,
    });
  }
  return entries;
}

/**
 * Unpacks `zip` into `dir` (created when missing): every entry as a file with mode 0644. Refuses names that could land
 * outside `dir`. Returns the paths written, in archive order.
 *
 * @throws Error `ZIP_INVALID:<detail>`, `ZIP_INVALID_PATH:<name>`
 */
export async function extractZip(zip: Uint8Array, dir: string): Promise<string[]> {
  const entries = readZip(zip);
  const root = path.resolve(dir);
  // A directory entry ("dir/") is checked without its trailing slash; writeZip writes none.
  for (const entry of entries) checkPath(entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path);
  await fsp.mkdir(root, { recursive: true });
  const written: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, ...entry.path.replace(/\/$/, '').split('/'));
    if (entry.path.endsWith('/')) {
      await fsp.mkdir(target, { recursive: true });
      continue;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, entry.data, { mode: FILE_MODE });
    await fsp.chmod(target, FILE_MODE);
    written.push(entry.path);
  }
  return written;
}
