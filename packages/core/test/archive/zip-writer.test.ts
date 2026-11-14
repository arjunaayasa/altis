import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants as zlibConstants, crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { reportWorkPath, resetTestFaults, type DataPath } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openArchive } from '../../src/archive/zip-reader.js';
import {
  ZipLimitError,
  openZipWriter,
  zipWriterCheckpointSchema,
  type ZipWriter,
  type ZipWriterCheckpoint,
  type ZipWriterOptions,
} from '../../src/archive/zip-writer.js';

// The shared resumable ZIP writer: stored entries (with or without their size and CRC up front) and deflate entries
// written as independent sync-flushed segments, the central directory kept in a sidecar file, a small checkpoint from
// which another process carries on (inside an entry too), ZIP64 only where it is needed (or forced), and the limits on
// entries and bytes of a report ZIP.

const MIB = 1024 * 1024;
const MARK32 = 0xffff_ffff;

let dataDir: string;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-zip-writer-'));
});

afterEach(async () => {
  delete process.env['ALTIS_TEST_FAULT'];
  resetTestFaults();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

interface Files {
  archive: DataPath;
  central: DataPath;
}

/** The archive and its sidecar in the work folder of a new report run. */
function files(): Files {
  const runId = newId();
  return { archive: reportWorkPath(dataDir, runId, 'output.part'), central: reportWorkPath(dataDir, runId, 'output.central') };
}

/** `n` bytes that only depend on `seed`: SHA-256 of a counter, end to end. */
function fixedBytes(seed: string, n: number): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0, have = 0; have < n; i += 1, have += 32) parts.push(createHash('sha256').update(`${seed}-${i}`).digest());
  return Buffer.concat(parts).subarray(0, n);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function zipFromBuffer(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) =>
      error ? reject(error) : resolve(zip!),
    ),
  );
}

interface Listed {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  size: number;
  compressedSize: number;
  data: Buffer;
}

/** Every entry of `bytes` as yauzl lists and reads it (inflated, sizes validated). */
async function listWithYauzl(bytes: Buffer): Promise<Listed[]> {
  const zip = await zipFromBuffer(bytes);
  const out: Listed[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve());
    zip.on('entry', (entry: Entry) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const parts: Buffer[] = [];
        stream!.on('data', (d: Buffer) => parts.push(d));
        stream!.on('error', reject);
        stream!.on('end', () => {
          out.push({
            name: entry.fileName.toString(),
            method: entry.compressionMethod,
            flags: entry.generalPurposeBitFlag,
            crc32: entry.crc32,
            size: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            data: Buffer.concat(parts),
          });
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  return out;
}

/** Every entry as the guarded reader lists and reads it. */
async function listWithReader(p: DataPath, o: { maxRatio?: number } = {}): Promise<{ name: string; method: number; size: number; crc32: number; data: Buffer }[]> {
  const reader = await openArchive(p, { allow: /^[^\0]+$/u, ...o });
  try {
    const out = [];
    for (const e of reader.entries()) {
      const parts: Buffer[] = [];
      for await (const chunk of reader.read(e)) parts.push(Buffer.from(chunk));
      out.push({ name: e.name, method: e.method, size: e.size, crc32: e.crc32, data: Buffer.concat(parts) });
    }
    return out;
  } finally {
    await reader.close();
  }
}

interface Streamed {
  name: string;
  flags: number;
  method: number;
  header: { crc32: number; size: number; compressedSize: number };
  data: Buffer;
}

/**
 * A strict streaming reader, test-local: it walks the local headers front to back and never looks at the central
 * directory, as a mail scanner or an upload form that unpacks on the fly does. Like Java's ZipInputStream it refuses a
 * stored entry whose sizes are only in a data descriptor (it cannot find where such an entry ends) and finds the end of
 * a deflate entry by inflating it.
 */
function streamEntries(bytes: Buffer): Streamed[] {
  const out: Streamed[] = [];
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const flags = bytes.readUInt16LE(at + 6);
    const method = bytes.readUInt16LE(at + 8);
    let crc = bytes.readUInt32LE(at + 14);
    let compressedSize = bytes.readUInt32LE(at + 18);
    let size = bytes.readUInt32LE(at + 22);
    const nameLength = bytes.readUInt16LE(at + 26);
    const extraLength = bytes.readUInt16LE(at + 28);
    const name = utf8.decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const extra = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + extraLength);
    const zip64 = extraLength >= 20 && extra.readUInt16LE(0) === 0x0001;
    if (zip64) {
      size = Number(extra.readBigUInt64LE(4));
      compressedSize = Number(extra.readBigUInt64LE(12));
    }
    const header = { crc32: crc, size, compressedSize };
    const dataAt = at + 30 + nameLength + extraLength;
    let data: Buffer;
    if ((flags & 0x0008) === 0) {
      const raw = bytes.subarray(dataAt, dataAt + compressedSize);
      data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
      at = dataAt + compressedSize;
    } else {
      if (method !== 8) throw new Error(`stored entry ${name} has its sizes in a data descriptor only`);
      const inflated = inflateRawSync(bytes.subarray(dataAt), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      data = inflated.buffer;
      let d = dataAt + inflated.engine.bytesWritten;
      if (bytes.readUInt32LE(d) === 0x08074b50) d += 4;
      crc = bytes.readUInt32LE(d);
      compressedSize = zip64 ? Number(bytes.readBigUInt64LE(d + 4)) : bytes.readUInt32LE(d + 4);
      size = zip64 ? Number(bytes.readBigUInt64LE(d + 12)) : bytes.readUInt32LE(d + 8);
      if (compressedSize !== inflated.engine.bytesWritten) throw new Error(`entry ${name}: the descriptor's compressed size is wrong`);
      at = d + (zip64 ? 20 : 12);
    }
    if (data.byteLength !== size || crc32(data) !== crc) throw new Error(`entry ${name}: size or CRC-32 do not match`);
    out.push({ name, flags, method, header, data });
  }
  if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('the entries are not followed by the central directory');
  return out;
}

/** One step of writing an archive. */
type Step = (w: ZipWriter) => Promise<void>;

const STORED = fixedBytes('stored', 3 * MIB);
/** Five pieces of hex text (compressible, about 2:1). */
const SEGMENTS = Array.from({ length: 5 }, (_, i) => Buffer.from(fixedBytes(`segment-${i}`, 20_000 + 1_000 * i).toString('hex')));
const UTF8_NAME = 'profil/Daftar judul – القرآن.pdf';
const PDF = Buffer.from('%PDF-1.4\n% contoh\n%%EOF\n');

/** The archive of the round trip: a 3 MiB stored entry in 1 MiB chunks, a deflate entry of 5 segments, an empty entry, a UTF-8 name. */
const STEPS: Step[] = [
  (w) => w.beginEntry('K-koleksi/stok.bin', { method: 0, size: STORED.byteLength, crc32: crc32(STORED) }),
  (w) => w.write(STORED.subarray(0, MIB)),
  (w) => w.write(STORED.subarray(MIB, 2 * MIB)),
  (w) => w.write(STORED.subarray(2 * MIB)),
  (w) => w.endEntry(),
  (w) => w.beginEntry('xl/worksheets/sheet1.xml', { method: 8 }),
  ...SEGMENTS.map((s): Step => (w) => w.write(s)),
  (w) => w.endEntry(),
  (w) => w.addEntry('kosong.txt', new Uint8Array(0), { method: 0 }),
  (w) => w.addEntry(UTF8_NAME, PDF, { method: 0 }),
];
/** The step after which the stored entry has two chunks written, and after which the deflate entry has three segments. */
const AFTER_SECOND_CHUNK = 2;
const AFTER_THIRD_SEGMENT = 5 + 3;

async function writeSteps(f: Files, steps: readonly Step[], o: Partial<ZipWriterOptions> = {}): Promise<Buffer> {
  const w = await openZipWriter(f.archive, f.central, { checkpoint: null, ...o });
  for (const step of steps) await step(w);
  const { size, entries } = await w.finish();
  const bytes = await fsp.readFile(f.archive);
  expect(size).toBe(bytes.byteLength);
  expect(entries).toBeGreaterThanOrEqual(0);
  return bytes;
}

describe('openZipWriter: round trip', () => {
  it('writes stored, deflate, empty and UTF-8 named entries that the guarded reader and yauzl read back', async () => {
    const bytes = await writeSteps(files(), STEPS);
    const f = files();
    const again = await writeSteps(f, STEPS);
    expect(again.equals(bytes)).toBe(true); // deterministic

    const expected = [
      { name: 'K-koleksi/stok.bin', method: 0, data: STORED },
      { name: 'xl/worksheets/sheet1.xml', method: 8, data: Buffer.concat(SEGMENTS) },
      { name: 'kosong.txt', method: 0, data: Buffer.alloc(0) },
      { name: UTF8_NAME, method: 0, data: PDF },
    ];
    const read = await listWithReader(f.archive);
    expect(read.map((e) => e.name)).toEqual(expected.map((e) => e.name));
    for (const [i, e] of expected.entries()) {
      expect(read[i]!.method).toBe(e.method);
      expect(read[i]!.crc32).toBe(crc32(e.data));
      expect(read[i]!.size).toBe(e.data.byteLength);
      expect(read[i]!.data.equals(e.data)).toBe(true);
    }

    const listed = await listWithYauzl(bytes);
    expect(listed.map((e) => e.name)).toEqual(expected.map((e) => e.name));
    for (const [i, e] of expected.entries()) {
      expect(listed[i]!.crc32).toBe(crc32(e.data));
      expect(listed[i]!.data.equals(e.data)).toBe(true);
      expect(listed[i]!.flags & 0x0800).toBe(0x0800); // UTF-8 names
    }
    // the size and CRC of the stored entry and of the added ones were known up front: no data descriptor
    expect(listed.map((e) => e.flags & 0x0008)).toEqual([0, 0x0008, 0, 0]);
    // the deflate entry is a run of sync-flushed segments closed by a final empty block
    const deflated = listed[1]!;
    expect(deflated.compressedSize).toBe(
      SEGMENTS.reduce((n, s) => n + deflateRawSync(s, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).byteLength, 0) + deflateRawSync(Buffer.alloc(0)).byteLength,
    );
    // no ZIP64 is needed here: the archive ends with a classic EOCD holding the true counts
    const eocd = bytes.subarray(bytes.byteLength - 22);
    expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
    expect(eocd.readUInt16LE(8)).toBe(4);
    expect(eocd.readUInt16LE(10)).toBe(4);
    expect(eocd.readUInt32LE(16) + eocd.readUInt32LE(12)).toBe(bytes.byteLength - 22);
    expect(bytes.readUInt32LE(bytes.byteLength - 42)).not.toBe(0x07064b50); // no ZIP64 locator
  });

  it('writes the DOS time of `mtime` and a regular-file mode in every header', async () => {
    const f = files();
    const mtime = Date.UTC(2026, 10, 14, 13, 45, 31);
    await writeSteps(f, [(w) => w.addEntry('a.txt', Buffer.from('a'), { method: 0 })], { mtime });
    const bytes = await fsp.readFile(f.archive);
    expect(bytes.readUInt16LE(10)).toBe((13 << 11) | (45 << 5) | 15);
    expect(bytes.readUInt16LE(12)).toBe(((2026 - 1980) << 9) | (11 << 5) | 14);
    const listed = await listWithYauzl(bytes);
    expect(listed).toHaveLength(1);
    const cd = bytes.readUInt32LE(bytes.byteLength - 6);
    expect(bytes.readUInt16LE(cd + 12)).toBe((13 << 11) | (45 << 5) | 15);
    expect(bytes.readUInt32LE(cd + 38) >>> 16).toBe(0o100600);

    // without `mtime`: 1980-01-01 00:00, so that the same input always gives the same bytes
    const g = files();
    await writeSteps(g, [(w) => w.addEntry('a.txt', Buffer.from('a'), { method: 0 })]);
    const plain = await fsp.readFile(g.archive);
    expect(plain.readUInt16LE(10)).toBe(0);
    expect(plain.readUInt16LE(12)).toBe((1 << 5) | 1);
  });
});

describe('openZipWriter: checkpoints', () => {
  for (const [label, after] of [
    ['after the second chunk of a stored entry', AFTER_SECOND_CHUNK],
    ['in the middle of a deflate entry', AFTER_THIRD_SEGMENT],
  ] as const) {
    it(`resumes ${label} after a crash, byte-identically`, async () => {
      const expected = await writeSteps(files(), STEPS);
      const f = files();
      const w = await openZipWriter(f.archive, f.central, { checkpoint: null });
      for (const step of STEPS.slice(0, after + 1)) await step(w);
      const cp = JSON.parse(JSON.stringify(await w.checkpoint())) as ZipWriterCheckpoint;
      expect(cp.open).not.toBeNull();
      expect(Buffer.byteLength(JSON.stringify(cp))).toBeLessThanOrEqual(4096);
      expect(zipWriterCheckpointSchema.safeParse(cp).success).toBe(true);
      expect(cp.offset).toBe(w.bytesWritten);
      // the slice goes on writing, then the process dies: 100 bytes more that no checkpoint covers
      await STEPS[after + 1]!(w);
      await fsp.appendFile(f.archive, fixedBytes('garbage', 100));
      await fsp.appendFile(f.central, fixedBytes('garbage', 10));

      const resumed = await openZipWriter(f.archive, f.central, { checkpoint: cp });
      expect(resumed.bytesWritten).toBe(cp.offset);
      for (const step of STEPS.slice(after + 1)) await step(resumed);
      await resumed.finish();
      expect((await fsp.readFile(f.archive)).equals(expected)).toBe(true);
    });
  }

  it('resumes between entries, and finishes again from the checkpoint before finish (the sidecar stays)', async () => {
    const expected = await writeSteps(files(), STEPS);
    const f = files();
    let w = await openZipWriter(f.archive, f.central, { checkpoint: null });
    for (const [i, step] of STEPS.entries()) {
      await step(w);
      if (i === 4 || i === STEPS.length - 2) w = await openZipWriter(f.archive, f.central, { checkpoint: await w.checkpoint() });
    }
    const beforeFinish = await w.checkpoint();
    expect(beforeFinish).toMatchObject({ entries: 4, open: null });
    expect((await fsp.stat(f.central)).size).toBe(beforeFinish.centralBytes);
    await w.finish();
    const again = await openZipWriter(f.archive, f.central, { checkpoint: beforeFinish });
    await again.finish();
    expect((await fsp.readFile(f.archive)).equals(expected)).toBe(true);
  });

  it('refuses a checkpoint it cannot have returned, and files shorter than the checkpoint', async () => {
    const f = files();
    const w = await openZipWriter(f.archive, f.central, { checkpoint: null });
    for (const step of STEPS.slice(0, AFTER_SECOND_CHUNK + 1)) await step(w);
    const cp = await w.checkpoint();
    const open = cp.open!;
    for (const bad of [
      { ...cp, offset: cp.offset + 1 },
      { ...cp, open: { ...open, name: '../x' } },
      { ...cp, open: { ...open, size: open.size + 1 } },
      { ...cp, entries: 1 },
      { ...cp, extra: 1 },
    ]) {
      await expect(openZipWriter(f.archive, f.central, { checkpoint: bad as ZipWriterCheckpoint })).rejects.toThrow(TypeError);
    }
    // a checkpoint whose open entry is not the one at its offset in the file
    const other = await rejection(openZipWriter(f.archive, f.central, { checkpoint: { ...cp, open: { ...open, name: 'K-koleksi/stok.bix' } } }));
    expect(isDomainError(other) && other.code).toBe('STATE_CORRUPT');
    await fsp.truncate(f.archive, cp.offset - 1);
    const short = await rejection(openZipWriter(f.archive, f.central, { checkpoint: cp }));
    expect(isDomainError(short) && short.code).toBe('STATE_CORRUPT');
    expect(isDomainError(short) && short.meta?.['reason']).toBe('archive_short');
  });

  it('keeps the checkpoint of an entry with a long name under 4 KiB, and refuses a longer name', async () => {
    const f = files();
    const w = await openZipWriter(f.archive, f.central, { checkpoint: null });
    const long = `${'judul-'.repeat(100)}${'ق'.repeat(200)}`; // 600 + 400 bytes
    expect(Buffer.byteLength(long)).toBe(1000);
    await w.beginEntry(long, { method: 8 });
    await w.write(Buffer.from('x'));
    expect(Buffer.byteLength(JSON.stringify(await w.checkpoint()))).toBeLessThanOrEqual(4096);
    await w.endEntry();
    await expect(w.beginEntry('x'.repeat(1025), { method: 0 })).rejects.toThrow(TypeError);
  });
});

describe('openZipWriter: failures leave the files at the last checkpoint', () => {
  it('a full disk while appending the central record', async () => {
    const f = files();
    const w = await openZipWriter(f.archive, f.central, { checkpoint: null });
    await w.addEntry('a.txt', Buffer.from('satu'), { method: 0 });
    const cp = await w.checkpoint();
    resetTestFaults();
    process.env['ALTIS_TEST_FAULT'] = 'disk-full:tmp:2'; // the archive opens, the sidecar does not
    const full = await rejection(w.addEntry('b.txt', Buffer.from('dua'), { method: 8 }));
    delete process.env['ALTIS_TEST_FAULT'];
    resetTestFaults();
    expect(isDomainError(full) && full.code).toBe('DISK_QUOTA');
    expect((await fsp.stat(f.archive)).size).toBe(cp.offset);
    expect((await fsp.stat(f.central)).size).toBe(cp.centralBytes);
    // the writer is done for; a new one carries on from the checkpoint
    await expect(w.addEntry('c.txt', Buffer.from('tiga'), { method: 0 })).rejects.toThrow(TypeError);
    const resumed = await openZipWriter(f.archive, f.central, { checkpoint: cp });
    await resumed.addEntry('b.txt', Buffer.from('dua'), { method: 8 });
    await resumed.finish();
    expect((await listWithReader(f.archive)).map((e) => [e.name, e.data.toString()])).toEqual([
      ['a.txt', 'satu'],
      ['b.txt', 'dua'],
    ]);
  });

  it('an entry whose bytes differ from the size and CRC promised in its header', async () => {
    const f = files();
    const w = await openZipWriter(f.archive, f.central, { checkpoint: null });
    const cp = await w.checkpoint();
    await w.beginEntry('a.bin', { method: 0, size: 10, crc32: crc32(Buffer.alloc(10)) });
    const long = await rejection(w.write(Buffer.alloc(11)));
    expect(isDomainError(long) && long.code).toBe('STATE_CORRUPT');
    expect((await fsp.stat(f.archive)).size).toBe(cp.offset);

    for (const [bytes, reason] of [
      [Buffer.alloc(9), 'size_mismatch'],
      [Buffer.alloc(10, 1), 'crc_mismatch'],
    ] as const) {
      const g = await openZipWriter(f.archive, f.central, { checkpoint: cp });
      await g.beginEntry('a.bin', { method: 0, size: 10, crc32: crc32(Buffer.alloc(10)) });
      await g.write(bytes);
      const error = await rejection(g.endEntry());
      expect(isDomainError(error) && error.meta?.['reason']).toBe(reason);
    }
  });
});

describe('openZipWriter: limits', () => {
  it('refuses a third entry with maxEntries 2, and stays usable', async () => {
    const f = files();
    const w = await openZipWriter(f.archive, f.central, { checkpoint: null, maxEntries: 2 });
    await w.addEntry('a.txt', Buffer.from('a'), { method: 0 });
    await w.addEntry('b.txt', Buffer.from('b'), { method: 8 });
    const error = await rejection(w.beginEntry('c.txt', { method: 0 }));
    expect(error).toBeInstanceOf(ZipLimitError);
    expect(error).toMatchObject({ kind: 'entries', max: 2, value: 3 });
    await expect(w.addEntry('c.txt', Buffer.from('c'), { method: 0 })).rejects.toMatchObject({ kind: 'entries' });
    expect((await w.finish()).entries).toBe(2);
  });

  it('refuses an entry that would take the archive past maxBytes, before writing it', async () => {
    const f = files();
    const w = await openZipWriter(f.archive, f.central, { checkpoint: null, maxBytes: 1024 });
    const before = w.bytesWritten;
    const added = await rejection(w.addEntry('big.bin', fixedBytes('big', 2048), { method: 0 }));
    expect(added).toBeInstanceOf(ZipLimitError);
    expect(added).toMatchObject({ kind: 'bytes', max: 1024 });
    expect(w.bytesWritten).toBe(before);
    await w.beginEntry('big.bin', { method: 0 });
    const written = await rejection(w.write(fixedBytes('big', 2048)));
    expect(written).toMatchObject({ kind: 'bytes', max: 1024 });
    await w.write(Buffer.from('small'));
    await w.endEntry();
    const { size } = await w.finish();
    expect(size).toBeLessThanOrEqual(1024);
  });
});

describe('openZipWriter: ZIP64', () => {
  it('with forceZip64, writes the sizes and offsets in ZIP64 extra fields, which the readers use', async () => {
    const f = files();
    const bytes = await writeSteps(
      f,
      [
        (w) => w.addEntry('a.txt', Buffer.from('isi a'), { method: 0 }),
        (w) => w.beginEntry('empty.xml', { method: 8 }),
        (w) => w.endEntry(),
        (w) => w.beginEntry('b.bin', { method: 0, size: 3, crc32: crc32(Buffer.from('abc')) }),
        (w) => w.write(Buffer.from('abc')),
        (w) => w.endEntry(),
      ],
      { forceZip64: true },
    );
    const read = await listWithReader(f.archive);
    expect(read.map((e) => [e.name, e.method, e.size, e.data.toString()])).toEqual([
      ['a.txt', 0, 5, 'isi a'],
      ['empty.xml', 8, 0, ''],
      ['b.bin', 0, 3, 'abc'],
    ]);
    expect(read[1]!.crc32).toBe(0);
    expect((await listWithYauzl(bytes)).map((e) => e.size)).toEqual([5, 0, 3]);

    // the ZIP64 end record and its locator, before a classic EOCD of markers
    const locator = bytes.subarray(bytes.byteLength - 42, bytes.byteLength - 22);
    expect(locator.readUInt32LE(0)).toBe(0x07064b50);
    const recordAt = Number(locator.readBigUInt64LE(8));
    expect(bytes.readUInt32LE(recordAt)).toBe(0x06064b50);
    expect(Number(bytes.readBigUInt64LE(recordAt + 32))).toBe(3);
    const cdOffset = Number(bytes.readBigUInt64LE(recordAt + 48));
    let at = cdOffset;
    for (let i = 0; i < 3; i += 1) {
      expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
      expect(bytes.readUInt32LE(at + 20)).toBe(MARK32);
      expect(bytes.readUInt32LE(at + 24)).toBe(MARK32);
      expect(bytes.readUInt32LE(at + 42)).toBe(MARK32);
      const nameLength = bytes.readUInt16LE(at + 28);
      expect(bytes.readUInt16LE(at + 30)).toBe(28);
      expect(bytes.readUInt16LE(at + 46 + nameLength)).toBe(0x0001);
      const localAt = Number(bytes.readBigUInt64LE(at + 46 + nameLength + 4 + 16));
      expect(bytes.readUInt32LE(localAt)).toBe(0x04034b50);
      expect(bytes.readUInt16LE(localAt + 28)).toBe(20); // a ZIP64 extra in the local header too
      at += 46 + nameLength + 28;
    }
    // the streaming reader reads the stored entries from the ZIP64 extra of their local headers
    expect(streamEntries(bytes).map((e) => [e.name, e.data.toString()])).toEqual([
      ['a.txt', 'isi a'],
      ['empty.xml', ''],
      ['b.bin', 'abc'],
    ]);
  });
});

describe('openZipWriter: strict streaming readers', () => {
  it('can read every entry whose size and CRC were known before its first byte, from its local header', async () => {
    const f = files();
    const evidence = fixedBytes('evidence', 2 * MIB + 17);
    const bytes = await writeSteps(f, [
      (w) => w.addEntry('00-berkas-bukti.pdf', PDF, { method: 0 }),
      (w) => w.addEntry('profil/catatan.txt', Buffer.from('catatan '.repeat(200)), { method: 8 }),
      (w) => w.beginEntry('K-koleksi/12-01-foto-rak.jpg', { method: 0, size: evidence.byteLength, crc32: crc32(evidence) }),
      (w) => w.write(evidence.subarray(0, MIB)),
      (w) => w.write(evidence.subarray(MIB)),
      (w) => w.endEntry(),
      (w) => w.beginEntry('xl/worksheets/sheet1.xml', { method: 8 }),
      ...SEGMENTS.map((s): Step => (w) => w.write(s)),
      (w) => w.endEntry(),
    ]);
    const streamed = streamEntries(bytes);
    expect(streamed.map((e) => e.name)).toEqual(['00-berkas-bukti.pdf', 'profil/catatan.txt', 'K-koleksi/12-01-foto-rak.jpg', 'xl/worksheets/sheet1.xml']);
    expect(streamed[0]!.data.equals(PDF)).toBe(true);
    expect(streamed[2]!.data.equals(evidence)).toBe(true);
    expect(streamed[3]!.data.equals(Buffer.concat(SEGMENTS))).toBe(true);
    for (const e of streamed.slice(0, 3)) {
      expect(e.flags & 0x0008).toBe(0);
      expect(e.header.crc32).toBe(crc32(e.data));
      expect(e.header.size).toBe(e.data.byteLength);
      expect(e.header.compressedSize).toBe(e.method === 0 ? e.data.byteLength : deflateRawSync(e.data).byteLength);
    }
  });

  it('(control) refuses a stored entry written without its size, which has a data descriptor', async () => {
    const f = files();
    const bytes = await writeSteps(f, [
      (w) => w.beginEntry('a.bin', { method: 0 }),
      (w) => w.write(Buffer.from('abc')),
      (w) => w.endEntry(),
    ]);
    expect(() => streamEntries(bytes)).toThrow(/data descriptor/);
    expect((await listWithReader(f.archive)).map((e) => e.data.toString())).toEqual(['abc']);
  });

  it("with descriptor 'always', every entry has a data descriptor", async () => {
    const f = files();
    const bytes = await writeSteps(
      f,
      [
        (w) => w.addEntry('a.txt', Buffer.from('a'), { method: 0 }),
        (w) => w.addEntry('b.txt', Buffer.from('b'), { method: 8 }),
        (w) => w.beginEntry('c.bin', { method: 0, size: 1, crc32: crc32(Buffer.from('c')) }),
        (w) => w.write(Buffer.from('c')),
        (w) => w.endEntry(),
      ],
      { descriptor: 'always' },
    );
    const listed = await listWithYauzl(bytes);
    expect(listed.map((e) => [e.name, e.flags, e.data.toString()])).toEqual([
      ['a.txt', 0x0808, 'a'],
      ['b.txt', 0x0808, 'b'],
      ['c.bin', 0x0808, 'c'],
    ]);
  });
});

describe('openZipWriter: names and misuse', () => {
  it('refuses names that are not relative, /-separated paths of plain characters', async () => {
    const f = files();
    const w = await openZipWriter(f.archive, f.central, { checkpoint: null });
    for (const name of ['', '../x', 'a/../b', 'a\\b', '/abs', 'a\u0001b', 'a\u007fb', 'a//b', 'dir/', './a', 'C:x', 'a\ud800b', 42]) {
      await expect(w.addEntry(name as string, Buffer.from('x'), { method: 0 })).rejects.toThrow(TypeError);
    }
    await w.addEntry('ok/nama berkas (1).txt', Buffer.from('x'), { method: 0 });
    await expect(w.addEntry('ok/nama berkas (1).txt', Buffer.from('x'), { method: 0 })).rejects.toThrow(TypeError);
    expect((await w.finish()).entries).toBe(1);
  });

  it('refuses writes outside an entry, a second open entry, finish with an entry open, and any call after finish', async () => {
    const f = files();
    const w = await openZipWriter(f.archive, f.central, { checkpoint: null });
    await expect(w.write(Buffer.from('x'))).rejects.toThrow(TypeError);
    await expect(w.endEntry()).rejects.toThrow(TypeError);
    await w.beginEntry('a.txt', { method: 8 });
    await expect(w.beginEntry('b.txt', { method: 8 })).rejects.toThrow(TypeError);
    await expect(w.addEntry('b.txt', Buffer.from('x'), { method: 8 })).rejects.toThrow(TypeError);
    await expect(w.finish()).rejects.toThrow(TypeError);
    await w.endEntry();
    await w.finish();
    await expect(w.addEntry('b.txt', Buffer.from('x'), { method: 0 })).rejects.toThrow(TypeError);
    await expect(w.checkpoint()).rejects.toThrow(TypeError);
    await expect(openZipWriter(f.archive, f.central, { checkpoint: null, maxEntries: 0 })).rejects.toThrow(TypeError);
    await expect(openZipWriter(f.archive, f.central, { checkpoint: null, mtime: Number.NaN })).rejects.toThrow(TypeError);
  });
});

describe('openArchive: maxRatio', () => {
  it('refuses a deflate entry inflating past the default ratio, and accepts it under a larger maxRatio', async () => {
    const f = files();
    await writeSteps(f, [(w) => w.addEntry('a.xml', Buffer.from('<row/>'.repeat(10_000)), { method: 8 })]);
    const refused = await rejection(openArchive(f.archive, { allow: /^a\.xml$/ }));
    expect(isDomainError(refused) && refused.meta?.['reason']).toBe('bomb');
    const read = await listWithReader(f.archive, { maxRatio: 1000 });
    expect(read[0]!.data.toString()).toBe('<row/>'.repeat(10_000));
    for (const maxRatio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(openArchive(f.archive, { allow: /^a\.xml$/, maxRatio })).rejects.toThrow(TypeError);
    }
  });
});
