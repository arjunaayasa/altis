import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { canonicalize, encodeBase64Url } from '@altis/crypto';
import { ALTISBAK_ENTRY, altisbakCentralPath, dataPath, resetTestFaults, type DataPath } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AltisbakHeader } from '../../src/archive/altisbak.js';
import { wrapDek } from '../../src/archive/kdf.js';
import { STREAM_CHUNK, decryptStream } from '../../src/archive/stream-cipher.js';
import { openArchive } from '../../src/archive/zip-reader.js';
import { openAltisbakWriter, type AltisbakCheckpoint, type AltisbakWriter } from '../../src/archive/zip64-writer.js';

// The resumable ZIP64 `.altisbak` writer (spec §9.9): stored entries with data descriptors, ZIP64 extras, a ZIP64 end
// of central directory, STREAM-encrypted entries when a DEK is given, and a fixed-size checkpoint {offset, entry,
// chunk, crc32, prefix, centralBytes} that lets another process carry on inside an entry, the central-directory
// records being kept in the sidecar archive.central (ruling R1c-6).

const DEK = new Uint8Array(32).fill(4);

let dataDir: string;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-zip64-'));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

function archivePath(): DataPath {
  return dataPath(dataDir, 'backups', newId(), 'archive.altisbak');
}

function header(encrypted: boolean, backupId = '01JBQ7T1D1V6B3R6Z8Y2Q5W4XA'): AltisbakHeader {
  return {
    format: 'altis-backup/1',
    backupId,
    appVersion: '0.1.0',
    schemaVersion: '0009_ops_jobs',
    dialect: 'sqlite',
    consistency: 'snapshot',
    secrets: encrypted ? 'archive' : 'keyring',
    encryption: encrypted
      ? {
          alg: 'aes-256-gcm-stream-1',
          chunkBytes: 1048576,
          kdf: { alg: 'scrypt', N: 65536, r: 8, p: 1, salt: encodeBase64Url(new Uint8Array(16).fill(2)) },
          dek: wrapDek(new Uint8Array(32).fill(1), DEK),
        }
      : null,
  };
}

/** A deterministic `random`: SHA-256 of a counter that the caller can share between two writers. */
function counterRandom(): (n: number) => Uint8Array {
  let calls = 0;
  return (n) => {
    calls += 1;
    return createHash('sha256').update(`prefix-${calls}`).digest().subarray(0, n);
  };
}

const BLOB = randomBytes(1_200_000);
const BLOB_NAME = `blobs/${createHash('sha256').update(BLOB).digest('hex')}`;
const ENTRIES: [string, Buffer][] = [
  ['manifest.json', Buffer.from(JSON.stringify({ format: 'altis-backup/1', note: 'test manifest' }))],
  ['tables/branches/00001.jsonl.gz', randomBytes(2.5 * STREAM_CHUNK)],
  ['tables/branches/00002.jsonl.gz', randomBytes(1000)],
  [BLOB_NAME, BLOB],
];

/** `bytes` from `from` on, in 64 KiB pieces (a file read, which knows nothing of chunk boundaries). */
function source(bytes: Buffer): (from: number) => AsyncIterable<Uint8Array> {
  return async function* (from: number) {
    for (let i = from; i < bytes.byteLength; i += 65_536) yield bytes.subarray(i, Math.min(i + 65_536, bytes.byteLength));
  };
}

async function writeAll(w: AltisbakWriter): Promise<void> {
  for (const [name, bytes] of ENTRIES) {
    expect(await w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: Number.POSITIVE_INFINITY })).toBe('done');
  }
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
  crc32: number;
  size: number;
  stored: Buffer;
  flags: number;
  method: number;
}

/** Every entry of `bytes` as yauzl lists and reads it (stored bytes, not decrypted). */
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
            crc32: entry.crc32,
            size: entry.uncompressedSize,
            stored: Buffer.concat(parts),
            flags: entry.generalPurposeBitFlag,
            method: entry.compressionMethod,
          });
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  return out;
}

async function* once(bytes: Buffer): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function decrypted(name: string, stored: Buffer): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of decryptStream(DEK, name, once(stored))) out.push(Buffer.from(chunk));
  return Buffer.concat(out);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('openAltisbakWriter: format', () => {
  for (const encrypted of [false, true]) {
    it(`writes an archive yauzl lists and reads back byte-exactly (${encrypted ? 'encrypted' : 'plain'})`, async () => {
      const p = archivePath();
      const h = header(encrypted);
      const w = await openAltisbakWriter(p, { header: h, dek: encrypted ? DEK : null, checkpoint: null });
      await writeAll(w);
      const { size } = await w.finish();
      const bytes = await fsp.readFile(p);
      expect(size).toBe(bytes.byteLength);

      const listed = await listWithYauzl(bytes);
      expect(listed.map((e) => e.name)).toEqual(['altisbak.json', ...ENTRIES.map(([name]) => name)]);
      for (const e of listed) {
        expect(e.method).toBe(0);
        expect(e.flags).toBe(0x0808); // bit 3 (data descriptor) and bit 11 (UTF-8)
        expect(e.crc32).toBe(crc32(e.stored)); // the CRC of the stored bytes
        expect(e.size).toBe(e.stored.byteLength);
        expect(ALTISBAK_ENTRY.test(e.name)).toBe(true);
      }
      // the header is the first entry, always in clear
      expect(listed[0]!.stored.toString('utf8')).toBe(canonicalize(h));
      for (const [i, [name, plain]] of ENTRIES.entries()) {
        const stored = listed[i + 1]!.stored;
        expect((encrypted ? await decrypted(name, stored) : stored).equals(plain)).toBe(true);
      }

      // the guarded reader accepts it too
      const reader = await openArchive(p, { allow: ALTISBAK_ENTRY });
      try {
        expect(reader.entries().map((e) => e.name)).toEqual(listed.map((e) => e.name));
      } finally {
        await reader.close();
      }
    });
  }

  it('ends with a classic EOCD holding the 0xFFFF/0xFFFFFFFF markers and a ZIP64 record holding the true counts', async () => {
    const p = archivePath();
    const w = await openAltisbakWriter(p, { header: header(false), dek: null, checkpoint: null });
    await writeAll(w);
    await w.finish();
    const bytes = await fsp.readFile(p);

    const eocd = bytes.subarray(bytes.byteLength - 22);
    expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
    expect(eocd.readUInt16LE(4)).toBe(0); // this disk
    expect(eocd.readUInt16LE(6)).toBe(0); // the disk of the central directory
    expect(eocd.readUInt16LE(8)).toBe(0xffff);
    expect(eocd.readUInt16LE(10)).toBe(0xffff);
    expect(eocd.readUInt32LE(12)).toBe(0xffffffff);
    expect(eocd.readUInt32LE(16)).toBe(0xffffffff);
    expect(eocd.readUInt16LE(20)).toBe(0); // no comment

    const locator = bytes.subarray(bytes.byteLength - 42, bytes.byteLength - 22);
    expect(locator.readUInt32LE(0)).toBe(0x07064b50);
    expect(locator.readUInt32LE(16)).toBe(1); // total disks
    const recordAt = Number(locator.readBigUInt64LE(8));
    expect(recordAt).toBe(bytes.byteLength - 42 - 56);

    const record = bytes.subarray(recordAt, recordAt + 56);
    expect(record.readUInt32LE(0)).toBe(0x06064b50);
    expect(Number(record.readBigUInt64LE(4))).toBe(44);
    expect(Number(record.readBigUInt64LE(24))).toBe(5); // entries on this disk
    expect(Number(record.readBigUInt64LE(32))).toBe(5); // entries in total
    const cdSize = Number(record.readBigUInt64LE(40));
    const cdOffset = Number(record.readBigUInt64LE(48));
    expect(cdOffset + cdSize).toBe(recordAt);
    expect(bytes.readUInt32LE(cdOffset)).toBe(0x02014b50);

    // every central record carries a ZIP64 extra with the sizes and the local header offset
    let at = cdOffset;
    for (let i = 0; i < 5; i += 1) {
      expect(bytes.readUInt32LE(at + 20)).toBe(0xffffffff);
      expect(bytes.readUInt32LE(at + 24)).toBe(0xffffffff);
      expect(bytes.readUInt32LE(at + 42)).toBe(0xffffffff);
      const nameLength = bytes.readUInt16LE(at + 28);
      const extraLength = bytes.readUInt16LE(at + 30);
      const extra = bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      expect(extra.readUInt16LE(0)).toBe(0x0001);
      expect(extra.readUInt16LE(2)).toBe(24);
      const localAt = Number(extra.readBigUInt64LE(20));
      expect(bytes.readUInt32LE(localAt)).toBe(0x04034b50);
      // the local header: data descriptor flag, ZIP64 extra
      expect(bytes.readUInt16LE(localAt + 6)).toBe(0x0808);
      expect(bytes.readUInt16LE(localAt + 28)).toBe(20);
      expect(bytes.readUInt16LE(localAt + 30 + nameLength)).toBe(0x0001);
      // the ZIP64 data descriptor after the data
      const stored = Number(extra.readBigUInt64LE(12));
      const descriptor = localAt + 30 + nameLength + 20 + stored;
      expect(bytes.readUInt32LE(descriptor)).toBe(0x08074b50);
      expect(bytes.readUInt32LE(descriptor + 4)).toBe(bytes.readUInt32LE(at + 16));
      expect(Number(bytes.readBigUInt64LE(descriptor + 8))).toBe(stored);
      expect(Number(bytes.readBigUInt64LE(descriptor + 16))).toBe(stored);
      at += 46 + nameLength + extraLength;
    }
    expect(at).toBe(cdOffset + cdSize);
  });
});

describe('openAltisbakWriter: pause and resume', () => {
  /** The archive written in one go, with a fresh deterministic `random`. */
  async function uninterrupted(h: AltisbakHeader): Promise<Buffer> {
    const p = archivePath();
    const w = await openAltisbakWriter(p, { header: h, dek: h.encryption === null ? null : DEK, checkpoint: null, random: counterRandom() });
    await writeAll(w);
    await w.finish();
    return fsp.readFile(p);
  }

  for (const encrypted of [false, true]) {
    it(`pauses between chunks under an injected clock and resumes byte-identically in new writers (${encrypted ? 'encrypted' : 'plain'})`, async () => {
      const h = header(encrypted); // one header: its wrapped DEK has a random IV
      const expected = await uninterrupted(h);
      const p = archivePath();
      const random = counterRandom(); // shared: the random stream carries on, as the CSPRNG would
      const clock = (): number => 1000;
      let w = await openAltisbakWriter(p, { header: h, dek: encrypted ? DEK : null, checkpoint: null, random, clock });
      let pauses = 0;
      for (const [name, bytes] of ENTRIES) {
        for (;;) {
          // a deadline already reached: the writer writes one chunk and pauses before the next
          const outcome = await w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: 1000 });
          if (outcome === 'done') break;
          pauses += 1;
          const cp: AltisbakCheckpoint = JSON.parse(JSON.stringify(w.checkpoint()));
          expect(cp.chunk).toBeGreaterThan(0);
          expect(cp.prefix === null).toBe(!encrypted);
          // a crash after the checkpoint: garbage after `offset`, which the next writer cuts off
          await fsp.appendFile(p, randomBytes(777));
          w = await openAltisbakWriter(p, { header: h, dek: encrypted ? DEK : null, checkpoint: cp, random, clock });
        }
      }
      expect(pauses).toBe(2 + 1); // the 2.5 MiB part has 3 chunks, the 1.2 MB blob 2
      await w.finish();
      const actual = await fsp.readFile(p);
      expect(actual.equals(expected)).toBe(true);
    });
  }

  it('resumes between entries, and finishes again from the last checkpoint after a crash in finish', async () => {
    const expected = await uninterrupted(header(false));
    const p = archivePath();
    const random = counterRandom();
    let w = await openAltisbakWriter(p, { header: header(false), dek: null, checkpoint: null, random });
    const first = JSON.parse(JSON.stringify(w.checkpoint())) as AltisbakCheckpoint;
    expect(first.entry).toBe(1);
    expect(first.chunk).toBe(0);
    expect(first.centralBytes).toBe(46 + 'altisbak.json'.length + 28); // one central record, in the sidecar
    expect((await fsp.stat(altisbakCentralPath(p))).size).toBe(first.centralBytes);
    for (const [name, bytes] of ENTRIES) {
      await w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: Number.POSITIVE_INFINITY });
      w = await openAltisbakWriter(p, { header: header(false), dek: null, checkpoint: JSON.parse(JSON.stringify(w.checkpoint())), random });
    }
    const beforeFinish = JSON.parse(JSON.stringify(w.checkpoint())) as AltisbakCheckpoint;
    await w.finish();
    // finish again from the same checkpoint (the process died before it could record that it had finished)
    const again = await openAltisbakWriter(p, { header: header(false), dek: null, checkpoint: beforeFinish, random });
    await again.finish();
    expect((await fsp.readFile(p)).equals(expected)).toBe(true);
  });

  it('leaves the file at its last durable checkpoint after a full disk or a failing source, and can retry (P21)', async () => {
    const p = archivePath();
    const w = await openAltisbakWriter(p, { header: header(true), dek: DEK, checkpoint: null, random: counterRandom() });
    const before = w.checkpoint();
    const [name, bytes] = ENTRIES[1]!;

    resetTestFaults();
    process.env['ALTIS_TEST_FAULT'] = 'disk-full:backups:1'; // the next write under backups/
    let full: unknown;
    try {
      full = await rejection(w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: Number.POSITIVE_INFINITY }));
    } finally {
      delete process.env['ALTIS_TEST_FAULT'];
      resetTestFaults();
    }
    expect(isDomainError(full) && full.code).toBe('DISK_QUOTA');
    expect(w.checkpoint()).toEqual(before);
    expect((await fsp.stat(p)).size).toBe(before.offset);

    // a source that fails after 1.5 MiB: the bytes written for this entry are cut off again
    const failing = async function* (from: number): AsyncIterable<Uint8Array> {
      yield* source(bytes.subarray(0, 1.5 * STREAM_CHUNK))(from);
      throw new Error('the part file went away');
    };
    await expect(w.writeEntry(name, bytes.byteLength, failing, { deadline: Number.POSITIVE_INFINITY })).rejects.toThrow('the part file went away');
    expect(w.checkpoint()).toEqual(before);
    expect((await fsp.stat(p)).size).toBe(before.offset);

    expect(await w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: Number.POSITIVE_INFINITY })).toBe('done');
    await w.finish();
    const listed = await listWithYauzl(await fsp.readFile(p));
    expect(listed.map((e) => e.name)).toEqual(['altisbak.json', name]);
    expect((await decrypted(name, listed[1]!.stored)).equals(bytes)).toBe(true);
  });

  it('writes an empty entry and refuses misuse', async () => {
    const p = archivePath();
    const w = await openAltisbakWriter(p, { header: header(true), dek: DEK, checkpoint: null });
    expect(await w.writeEntry(`blobs/${'0'.repeat(64)}`, 0, source(Buffer.alloc(0)), { deadline: 0 })).toBe('done');
    await expect(w.writeEntry('extra.txt', 1, source(Buffer.alloc(1)), { deadline: 0 })).rejects.toThrow(TypeError);
    await expect(w.writeEntry('altisbak.json', 1, source(Buffer.alloc(1)), { deadline: 0 })).rejects.toThrow(TypeError);
    await expect(w.writeEntry(`blobs/${'0'.repeat(64)}`, 0, source(Buffer.alloc(0)), { deadline: 0 })).rejects.toThrow(TypeError);
    // a source with fewer or more bytes than declared
    const short = await rejection(w.writeEntry('manifest.json', 10, source(Buffer.alloc(9)), { deadline: Number.POSITIVE_INFINITY }));
    expect(isDomainError(short) && short.code).toBe('STATE_CORRUPT');
    const w2 = await openAltisbakWriter(archivePath(), { header: header(false), dek: null, checkpoint: null });
    const long = await rejection(w2.writeEntry('manifest.json', 10, source(Buffer.alloc(11)), { deadline: Number.POSITIVE_INFINITY }));
    expect(isDomainError(long) && long.code).toBe('STATE_CORRUPT');
    // a DEK without encryption in the header, or the other way round
    await expect(openAltisbakWriter(archivePath(), { header: header(false), dek: DEK, checkpoint: null })).rejects.toThrow(TypeError);
    await expect(openAltisbakWriter(archivePath(), { header: header(true), dek: null, checkpoint: null })).rejects.toThrow(TypeError);
  });

  it('refuses to resume another entry than the one in progress, a file shorter than the checkpoint, and finish mid-entry', async () => {
    const p = archivePath();
    const clock = (): number => 5;
    const w = await openAltisbakWriter(p, { header: header(false), dek: null, checkpoint: null, clock });
    const [name, bytes] = ENTRIES[1]!;
    expect(await w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: 0 })).toBe('paused');
    await expect(w.finish()).rejects.toThrow(TypeError);
    const cp = w.checkpoint();
    const resumed = await openAltisbakWriter(p, { header: header(false), dek: null, checkpoint: cp, clock });
    const other = await rejection(resumed.writeEntry('tables/branches/00009.jsonl.gz', bytes.byteLength, source(bytes), { deadline: 0 }));
    expect(other).toBeInstanceOf(TypeError);
    await fsp.truncate(p, cp.offset - 1);
    const shorter = await rejection(openAltisbakWriter(p, { header: header(false), dek: null, checkpoint: cp, clock }));
    expect(isDomainError(shorter) && shorter.code).toBe('STATE_CORRUPT');
  });
});

describe('openAltisbakWriter: a fixed-size checkpoint, the central directory in a sidecar (ruling R1c-6)', () => {
  /**
   * Enough entries for their central records (about 150 bytes each) to outgrow a job payload (jobs.payload is TEXT,
   * at most 65 535 bytes on MySQL/MariaDB) more than twice over, which a checkpoint holding them could never fit in;
   * and past the crashes at entries 250 and 750 and the reopen at 999 below. More only made the test slow under load.
   */
  const MANY = 1200;
  /** MANY small blob entries; a name only has to fit the grammar here. */
  const many: [string, Buffer][] = Array.from({ length: MANY }, (_, i) => {
    const bytes = Buffer.from(`blob ${i}`);
    return [`blobs/${createHash('sha256').update(bytes).digest('hex')}`, bytes];
  });
  const ALL = Number.POSITIVE_INFINITY;

  it(`keeps the serialized checkpoint of a ${MANY}-entry archive under 1 KiB and resumes byte-identically`, async () => {
    // fsync is counted, not done: at about 5 ms each on the development Mac, the ~5 000 of this test would take 25 s
    // (the other tests here sync for real, P21)
    const probe = await fsp.open(path.join(dataDir, 'probe'), 'w');
    const handleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const syncs = vi.spyOn(handleProto, 'sync').mockResolvedValue(undefined);
    onTestFinished(() => syncs.mockRestore());
    const plain = header(false);
    const straight = archivePath();
    const w1 = await openAltisbakWriter(straight, { header: plain, dek: null, checkpoint: null });
    for (const [name, bytes] of many) await w1.writeEntry(name, bytes.byteLength, source(bytes), { deadline: ALL });
    await w1.finish();
    const expected = await fsp.readFile(straight);

    const p = archivePath();
    const central = altisbakCentralPath(p);
    let w = await openAltisbakWriter(p, { header: plain, dek: null, checkpoint: null });
    let largest = 0;
    for (const [i, [name, bytes]] of many.entries()) {
      const before = JSON.stringify(w.checkpoint());
      largest = Math.max(largest, Buffer.byteLength(before));
      expect(await w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: ALL })).toBe('done');
      if (i % 500 === 250) {
        // The process died after this entry was written and its central record appended, but before the new
        // checkpoint reached the job payload (plus some garbage on both files): the next slice starts from the
        // checkpoint before it, both files are cut back, and the entry is written again.
        await fsp.appendFile(p, randomBytes(333));
        await fsp.appendFile(central, randomBytes(99));
        w = await openAltisbakWriter(p, { header: plain, dek: null, checkpoint: JSON.parse(before) as AltisbakCheckpoint });
        expect(await w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: ALL })).toBe('done');
      }
      if (i % 1000 === 999) w = await openAltisbakWriter(p, { header: plain, dek: null, checkpoint: JSON.parse(JSON.stringify(w.checkpoint())) });
    }
    const last = JSON.stringify(w.checkpoint());
    largest = Math.max(largest, Buffer.byteLength(last));
    expect(largest).toBeLessThan(1024);
    // What the sidecar holds would not fit in a job payload, twice over.
    expect((await fsp.stat(central)).size).toBeGreaterThan(2 * 65_535);
    // both files were synced for every entry written (twice for the rewritten ones)
    const rewritten = many.filter((_, i) => i % 500 === 250).length;
    expect(rewritten).toBe(2);
    expect(syncs.mock.calls.length).toBeGreaterThanOrEqual(2 * (2 * MANY + rewritten));
    expect(JSON.parse(last)).toMatchObject({ entry: MANY + 1, chunk: 0, prefix: null });
    expect(JSON.parse(last).centralBytes).toBe((await fsp.stat(central)).size);

    const { size } = await w.finish();
    const actual = await fsp.readFile(p);
    expect(size).toBe(actual.byteLength);
    expect(actual.equals(expected)).toBe(true);
    const reader = await openArchive(p, { allow: ALTISBAK_ENTRY });
    try {
      expect(reader.entries().map((e) => e.name)).toEqual(['altisbak.json', ...many.map(([name]) => name)]);
    } finally {
      await reader.close();
    }
  }, 120_000);

  it('refuses a sidecar shorter than its checkpoint, and finish refuses a sidecar that is not the records written', async () => {
    const p = archivePath();
    const central = altisbakCentralPath(p);
    const w = await openAltisbakWriter(p, { header: header(false), dek: null, checkpoint: null });
    await writeAll(w);
    const cp = w.checkpoint();

    await fsp.truncate(central, cp.centralBytes - 1);
    const short = await rejection(openAltisbakWriter(p, { header: header(false), dek: null, checkpoint: cp }));
    expect(isDomainError(short) && short.code).toBe('STATE_CORRUPT');
    expect(isDomainError(short) && short.meta?.['reason']).toBe('central_short');

    // the same length but other bytes (a record's name damaged): finish writes no central directory
    await fsp.truncate(central, 0);
    await fsp.writeFile(central, Buffer.alloc(cp.centralBytes, 0x41));
    const resumed = await openAltisbakWriter(p, { header: header(false), dek: null, checkpoint: cp });
    const damaged = await rejection(resumed.finish());
    expect(isDomainError(damaged) && damaged.code).toBe('STATE_CORRUPT');
    expect(isDomainError(damaged) && damaged.meta?.['reason']).toBe('central_mismatch');
    expect((await fsp.stat(p)).size).toBe(cp.offset);
  });

  it('a full disk while appending the central record leaves both files at the last checkpoint (P21)', async () => {
    const p = archivePath();
    const central = altisbakCentralPath(p);
    const w = await openAltisbakWriter(p, { header: header(false), dek: null, checkpoint: null });
    const before = w.checkpoint();
    const [name, bytes] = ENTRIES[2]!;
    resetTestFaults();
    process.env['ALTIS_TEST_FAULT'] = 'disk-full:backups:2'; // the archive opens, the sidecar does not
    let full: unknown;
    try {
      full = await rejection(w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: ALL }));
    } finally {
      delete process.env['ALTIS_TEST_FAULT'];
      resetTestFaults();
    }
    expect(isDomainError(full) && full.code).toBe('DISK_QUOTA');
    expect(w.checkpoint()).toEqual(before);
    expect((await fsp.stat(p)).size).toBe(before.offset);
    expect((await fsp.stat(central)).size).toBe(before.centralBytes);
    expect(await w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: ALL })).toBe('done');
    await w.finish();
    const listed = await listWithYauzl(await fsp.readFile(p));
    expect(listed.map((e) => e.name)).toEqual(['altisbak.json', name]);
  });
});

describe('openAltisbakWriter: a nonce prefix is never reused on bytes that may differ (ruling R1c-6)', () => {
  const BIG = 2.5 * STREAM_CHUNK;
  /** The bytes of `manifest.json` as yauzl reads them (stored, not decrypted). */
  async function storedManifest(p: DataPath): Promise<Buffer> {
    const listed = await listWithYauzl(await fsp.readFile(p));
    return listed.find((e) => e.name === 'manifest.json')!.stored;
  }

  it('writes a generated entry (manifest.json) over 1 MiB in one call, never pausing inside it', async () => {
    const p = archivePath();
    const clock = (): number => 1000;
    const w = await openAltisbakWriter(p, { header: header(true), dek: DEK, checkpoint: null, random: counterRandom(), clock });
    const manifest = randomBytes(BIG);
    expect(await w.writeEntry('manifest.json', manifest.byteLength, source(manifest), { deadline: 1000 })).toBe('done');
    expect(w.checkpoint()).toMatchObject({ entry: 2, chunk: 0, prefix: null });
    // an immutable source (a part) still pauses between chunks
    const [name, bytes] = ENTRIES[1]!;
    expect(await w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: 1000 })).toBe('paused');
    expect(w.checkpoint()).toMatchObject({ entry: 2, chunk: 1 });
  });

  it('rewrites a generated entry from its start with a fresh prefix when a checkpoint lies inside it', async () => {
    // A checkpoint inside manifest.json (as a slice that paused there would have left): its chunk 0 is on disk under
    // the old prefix. The manifest is generated again with other bytes; the writer must not encrypt them under that
    // prefix from chunk 1 on, but write the whole entry again under a new one.
    const p = archivePath();
    const random = counterRandom();
    const w = await openAltisbakWriter(p, { header: header(true), dek: DEK, checkpoint: null, random });
    const before = w.checkpoint();
    const first = randomBytes(BIG);
    expect(await w.writeEntry('manifest.json', first.byteLength, source(first), { deadline: Number.POSITIVE_INFINITY })).toBe('done');
    const file = await fsp.readFile(p);
    const prefixAt = before.offset + 30 + 'manifest.json'.length + 20;
    const oldPrefix = file.subarray(prefixAt, prefixAt + 7);
    const chunkEnd = prefixAt + 7 + STREAM_CHUNK + 16;
    const inside: AltisbakCheckpoint = {
      ...before,
      offset: chunkEnd,
      chunk: 1,
      plainSize: BIG,
      crc32: crc32(file.subarray(prefixAt, chunkEnd)),
      prefix: encodeBase64Url(oldPrefix),
    };

    const second = randomBytes(STREAM_CHUNK / 2); // generated again, and smaller this time
    const resumed = await openAltisbakWriter(p, { header: header(true), dek: DEK, checkpoint: inside, random });
    expect(await resumed.writeEntry('manifest.json', second.byteLength, source(second), { deadline: Number.POSITIVE_INFINITY })).toBe('done');
    await resumed.finish();
    const stored = await storedManifest(p);
    expect(stored.subarray(0, 7).equals(oldPrefix)).toBe(false);
    expect((await decrypted('manifest.json', stored)).equals(second)).toBe(true);
  });

  it('refuses to resume a part with another size than the one in progress', async () => {
    const p = archivePath();
    const clock = (): number => 5;
    const w = await openAltisbakWriter(p, { header: header(true), dek: DEK, checkpoint: null, random: counterRandom(), clock });
    const [name, bytes] = ENTRIES[1]!;
    expect(await w.writeEntry(name, bytes.byteLength, source(bytes), { deadline: 0 })).toBe('paused');
    const cp = JSON.parse(JSON.stringify(w.checkpoint())) as AltisbakCheckpoint;
    expect(cp).toMatchObject({ chunk: 1, plainSize: bytes.byteLength });
    // a checkpoint whose size leaves no chunk to come is not one checkpoint() returns
    for (const plainSize of [0, cp.chunk * STREAM_CHUNK]) {
      await expect(openAltisbakWriter(p, { header: header(true), dek: DEK, checkpoint: { ...cp, plainSize }, clock })).rejects.toThrow(TypeError);
    }
    const resumed = await openAltisbakWriter(p, { header: header(true), dek: DEK, checkpoint: cp, random: counterRandom(), clock });
    const longer = Buffer.concat([bytes, Buffer.alloc(1)]);
    const other = await rejection(resumed.writeEntry(name, longer.byteLength, source(longer), { deadline: 0 }));
    expect(other).toBeInstanceOf(TypeError);
    expect(resumed.checkpoint()).toEqual(cp);
    expect(await resumed.writeEntry(name, bytes.byteLength, source(bytes), { deadline: Number.POSITIVE_INFINITY })).toBe('done');
  });
});
