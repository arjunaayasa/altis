import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { ALTISBAK_ENTRY, dataPath, type DataPath } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openArchive, type ArchiveReader } from '../../src/archive/zip-reader.js';
import { S_IFDIR, S_IFLNK, S_IFREG, rawZip, unixAttributes, type RawEntry } from '../helpers/raw-zip.js';

// The guarded zip reader (spec §7.5 extraction rules, A6 "Arsip berisi ../ atau bom gzip ditolak"): yauzl on a
// handle opened by @altis/platform, every entry checked before anything is read.

const SHA = 'ab'.repeat(32);
const MANIFEST = 'manifest.json';

let dataDir: string;
const open: ArchiveReader[] = [];

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-zip-reader-'));
});

afterEach(async () => {
  for (const reader of open.splice(0)) await reader.close();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

async function place(bytes: Buffer): Promise<DataPath> {
  const p = dataPath(dataDir, 'tmp', newId(), 'archive.altisbak');
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, bytes);
  return p;
}

async function opened(bytes: Buffer, o: { maxEntries?: number } = {}): Promise<ArchiveReader> {
  const reader = await openArchive(await place(bytes), { allow: ALTISBAK_ENTRY, ...o });
  open.push(reader);
  return reader;
}

async function refusal(entries: readonly RawEntry[] | Buffer, o: { maxEntries?: number } = {}): Promise<unknown> {
  const bytes = Buffer.isBuffer(entries) ? entries : rawZip(entries);
  try {
    open.push(await openArchive(await place(bytes), { allow: ALTISBAK_ENTRY, ...o }));
  } catch (error) {
    return error;
  }
  throw new Error('expected openArchive to refuse the archive');
}

function reasonOf(error: unknown): string | null {
  if (!isDomainError(error) || error.code !== 'BACKUP_INVALID') throw error;
  return (error.meta?.['reason'] as string | undefined) ?? null;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of source) out.push(Buffer.from(chunk));
  return Buffer.concat(out);
}

async function readRejection(source: AsyncIterable<Uint8Array>): Promise<unknown> {
  try {
    await collect(source);
  } catch (error) {
    return error;
  }
  throw new Error('expected the read to fail');
}

describe('openArchive refuses hostile archives (A6)', () => {
  const ONE_MIB = Buffer.alloc(1024 * 1024);
  const fixtures: [string, RawEntry[], string][] = [
    ['../evil', [{ name: '../evil', data: Buffer.from('x') }], 'path'],
    ['/abs', [{ name: '/abs', data: Buffer.from('x') }], 'path'],
    ['a\\b', [{ name: 'a\\b', data: Buffer.from('x') }], 'path'],
    ['C:x', [{ name: 'C:x', data: Buffer.from('x') }], 'path'],
    ['a\\u0000b', [{ name: 'a\u0000b', data: Buffer.from('x') }], 'path'],
    [
      'a symlink entry',
      [{ name: MANIFEST, data: Buffer.from('/etc/passwd'), externalAttributes: unixAttributes(S_IFLNK | 0o777) }],
      'entry',
    ],
    ['extra.txt', [{ name: 'extra.txt', data: Buffer.from('x') }], 'entry'],
    [
      'two manifest.json',
      [
        { name: MANIFEST, data: Buffer.from('{}') },
        { name: MANIFEST, data: Buffer.from('{}') },
      ],
      'entry',
    ],
    [
      'an encrypted-flag entry',
      // traditional encryption: a 12-byte header before the data, so the stored size is 12 more
      [{ name: MANIFEST, raw: Buffer.alloc(14), uncompressedSize: 2, flags: 0x1 }],
      'format',
    ],
    ['a deflate entry of 1 KiB inflating to 1 MiB', [{ name: MANIFEST, data: ONE_MIB, method: 8 }], 'bomb'],
  ];

  for (const [title, entries, reason] of fixtures) {
    it(`refuses ${title} with BACKUP_INVALID reason ${reason}`, async () => {
      expect(reasonOf(await refusal(entries))).toBe(reason);
    });
  }

  it('checks the size of the deflate fixture: about 1 KiB inflating to 1 MiB', () => {
    expect(deflateRawSync(ONE_MIB).byteLength).toBeLessThan(2048);
  });

  it('refuses more path shapes: a nested .., a trailing .., an empty name, a lower-case drive letter', async () => {
    for (const name of ['tables/../manifest.json', 'blobs/..', '', 'c:/x', 'a/\u0000']) {
      expect(reasonOf(await refusal([{ name, data: Buffer.from('x') }]))).toBe('path');
    }
  });

  it('refuses a folder entry, a FIFO and a DOS folder attribute by their attributes', async () => {
    const cases: RawEntry[] = [
      { name: MANIFEST, externalAttributes: unixAttributes(S_IFDIR | 0o755) },
      { name: MANIFEST, externalAttributes: unixAttributes(0o010000 | 0o644) },
      { name: MANIFEST, versionMadeBy: 0x0014, externalAttributes: 0x10 },
    ];
    for (const entry of cases) expect(reasonOf(await refusal([entry]))).toBe('entry');
  });

  it('refuses a method other than stored or deflate', async () => {
    expect(reasonOf(await refusal([{ name: MANIFEST, data: Buffer.from('x'), method: 12, raw: Buffer.from('x') }]))).toBe('format');
  });

  it('refuses entries whose data overlap (the overlapping-file zip bomb)', async () => {
    const zip = rawZip([
      { name: `blobs/${SHA}`, data: Buffer.alloc(100, 1) },
      { name: MANIFEST, data: Buffer.from('{}') },
    ]);
    // point the second central record at the first entry's local header
    const cd = zip.readUInt32LE(zip.byteLength - 22 + 16);
    const second = cd + 46 + Buffer.byteLength(`blobs/${SHA}`);
    zip.writeUInt32LE(0, second + 42);
    expect(reasonOf(await refusal(zip))).toBe('bomb');
  });

  it('refuses more entries than maxEntries, and anything that is not a zip', async () => {
    const two = [
      { name: MANIFEST, data: Buffer.from('{}') },
      { name: 'altisbak.json', data: Buffer.from('{}') },
    ];
    expect(reasonOf(await refusal(two, { maxEntries: 1 }))).toBe('format');
    expect(reasonOf(await refusal(Buffer.from('not a zip at all, just text')))).toBe('format');
    const truncated = rawZip(two);
    expect(reasonOf(await refusal(truncated.subarray(0, truncated.byteLength - 5)))).toBe('format');
  });
});

describe('ArchiveReader', () => {
  const blob = randomBytes(7000); // incompressible: a deflate entry far below the 10× ratio
  const manifest = Buffer.from('{"format":"altis-backup/1"}');

  it('lists the entries and reads stored and deflate entries byte-exactly', async () => {
    const reader = await opened(
      rawZip([
        { name: MANIFEST, data: manifest },
        { name: `blobs/${SHA}`, data: blob, method: 8 },
      ]),
    );
    const entries = reader.entries();
    expect(entries.map((e) => [e.name, e.method, e.size])).toEqual([
      [MANIFEST, 0, manifest.byteLength],
      [`blobs/${SHA}`, 8, blob.byteLength],
    ]);
    expect((await collect(reader.read(entries[0]!))).equals(manifest)).toBe(true);
    expect((await collect(reader.read(entries[1]!))).equals(blob)).toBe(true);
    // twice, and from an offset
    expect((await collect(reader.read(entries[1]!))).equals(blob)).toBe(true);
    expect((await collect(reader.read(entries[0]!, { from: 10 }))).equals(manifest.subarray(10))).toBe(true);
    expect((await collect(reader.read(entries[1]!, { from: 4000 }))).equals(blob.subarray(4000))).toBe(true);
    expect(await collect(reader.read(entries[0]!, { from: manifest.byteLength }))).toHaveLength(0);
    expect(() => reader.read(entries[0]!, { from: manifest.byteLength + 1 })).toThrow(RangeError);
  });

  it('stops reading part way without leaving anything open', async () => {
    const reader = await opened(rawZip([{ name: `blobs/${SHA}`, data: Buffer.alloc(3 * 1024 * 1024, 7) }]));
    for await (const chunk of reader.read(reader.entries()[0]!)) {
      expect(chunk.byteLength).toBeGreaterThan(0);
      break;
    }
    expect((await collect(reader.read(reader.entries()[0]!))).byteLength).toBe(3 * 1024 * 1024);
  });

  it('refuses a stored entry whose CRC-32 does not match its bytes', async () => {
    const zip = rawZip([{ name: MANIFEST, data: manifest }]);
    zip[30 + MANIFEST.length] = 0x5b; // the first data byte: '{' → '['
    const reader = await opened(zip);
    expect(reasonOf(await readRejection(reader.read(reader.entries()[0]!)))).toBe('checksum');
  });

  it('refuses a deflate entry that inflates to more than its declared size', async () => {
    const data = randomBytes(200); // incompressible: the declared ratio stays below 10
    const compressed = deflateRawSync(data);
    const reader = await opened(rawZip([{ name: MANIFEST, raw: compressed, method: 8, uncompressedSize: 100, data }]));
    expect(reasonOf(await readRejection(reader.read(reader.entries()[0]!)))).toBe('bomb');
  });

  it('accepts a regular file made on DOS and a Unix entry without a file type', async () => {
    const reader = await opened(
      rawZip([
        { name: MANIFEST, data: manifest, versionMadeBy: 0x0014, externalAttributes: 0x20 },
        { name: 'altisbak.json', data: manifest, externalAttributes: 0 },
        { name: `blobs/${SHA}`, data: blob, externalAttributes: unixAttributes(S_IFREG | 0o600) },
      ]),
    );
    expect(reader.entries()).toHaveLength(3);
  });
});
