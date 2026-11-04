import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOS_DATE, DOS_TIME, FILE_MODE, MAX_DEFLATE_RATIO, extractZip, readZip, writeZip } from '../src/zip.js';

// The release zip writer (Task 17, ruling: byte-identical zips): entries in the given order, fixed mtime
// 2026-01-01 00:00, mode 0644, no extra field (no uid/gid/atime of the build host), deflate when it saves bytes.

const run = promisify(execFile);
let dir: string;

beforeAll(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-zip-')));
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const text = (s: string): Buffer => Buffer.from(s, 'utf8');

const SAMPLE = [
  // compresses, but less than MAX_DEFLATE_RATIO (a more repetitive file would be stored, see below)
  { path: 'a.txt', data: text(Array.from({ length: 50 }, (_, i) => `hello ${(i * 7919) % 1009} world ${(i * 104729) % 997}\n`).join('')) },
  { path: 'dir/empty', data: Buffer.alloc(0) },
  { path: 'dir/sub/x.json', data: text('{"x":1}\n') },
];

describe('writeZip / readZip', () => {
  it('round-trips names, order and bytes', () => {
    const entries = readZip(writeZip(SAMPLE));
    expect(entries.map((e) => e.path)).toEqual(['a.txt', 'dir/empty', 'dir/sub/x.json']);
    for (const [i, entry] of entries.entries()) expect(entry.data.equals(SAMPLE[i]!.data)).toBe(true);
  });

  it('writes fixed metadata: 2026-01-01 00:00, a regular file 0644 made on UNIX, no extra field, no flags', () => {
    expect(DOS_DATE).toBe(((2026 - 1980) << 9) | (1 << 5) | 1);
    expect(DOS_TIME).toBe(0);
    expect(FILE_MODE).toBe(0o644);
    for (const entry of readZip(writeZip(SAMPLE))) {
      expect(entry.dosDate).toBe(DOS_DATE);
      expect(entry.dosTime).toBe(DOS_TIME);
      expect(entry.mode).toBe(0o100644);
      expect(entry.versionMadeBy >> 8).toBe(3); // UNIX: the mode in the external attributes is honoured
      expect(entry.extraLength).toBe(0);
      expect(entry.localExtraLength).toBe(0);
      expect(entry.flags).toBe(0);
    }
  });

  it('deflates what compresses and stores what does not (an empty file)', () => {
    const [a, empty] = readZip(writeZip(SAMPLE));
    expect(a!.method).toBe(8);
    expect(a!.compressedSize).toBeLessThan(a!.data.length);
    expect(empty!.method).toBe(0);
    expect(empty!.compressedSize).toBe(0);
  });

  it('is deterministic: the same entries give the same bytes', () => {
    expect(writeZip(SAMPLE).equals(writeZip(SAMPLE.map((e) => ({ path: e.path, data: Buffer.from(e.data) }))))).toBe(true);
  });

  it('refuses a path that is absolute, has . or .. segments, a backslash, or appears twice', () => {
    for (const bad of ['/abs', 'a/../b', './a', 'a\\b', 'a//b', '', 'dir/']) {
      expect(() => writeZip([{ path: bad, data: Buffer.alloc(1) }]), bad).toThrow(/^ZIP_INVALID_PATH/);
    }
    expect(() => writeZip([SAMPLE[0]!, SAMPLE[0]!])).toThrow(/^ZIP_DUPLICATE_PATH:a\.txt/);
  });

  it('never writes an entry that expands more than MAX_DEFLATE_RATIO (readers refuse those as zip bombs)', () => {
    const zip = writeZip([
      { path: 'notices.txt', data: Buffer.from('a'.repeat(200_000)) }, // ~1000x compressible: stored
      { path: 'text.txt', data: Buffer.from(Array.from({ length: 4000 }, (_, i) => `line ${i * 7919} ${(i * 104729) % 9973}`).join('\n')) },
    ]);
    const methods: number[] = [];
    for (let at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); at >= 0; at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 4)) {
      const method = zip.readUInt16LE(at + 10);
      const packed = zip.readUInt32LE(at + 20);
      const size = zip.readUInt32LE(at + 24);
      methods.push(method);
      if (method === 8) expect(size).toBeLessThanOrEqual(MAX_DEFLATE_RATIO * packed);
    }
    expect(methods).toEqual([0, 8]); // the bomb-like entry is stored, ordinary text still deflates
    expect(readZip(zip).map((e) => e.data.length)).toEqual([200_000, expect.any(Number)]);
  });

  it('readZip refuses a damaged archive (CRC mismatch, truncated)', () => {
    const zip = writeZip(SAMPLE);
    const flipped = Buffer.from(zip);
    flipped[40] = flipped[40]! ^ 0xff; // inside the first entry's data
    expect(() => readZip(flipped)).toThrow(/^ZIP_INVALID/);
    expect(() => readZip(zip.subarray(0, zip.length - 10))).toThrow(/^ZIP_INVALID/);
  });
});

describe('extractZip', () => {
  it('writes every entry under the target folder with mode 0644', async () => {
    const target = path.join(dir, 'extract');
    const written = await extractZip(writeZip(SAMPLE), target);
    expect(written).toEqual(['a.txt', 'dir/empty', 'dir/sub/x.json']);
    expect(await fsp.readFile(path.join(target, 'dir', 'sub', 'x.json'), 'utf8')).toBe('{"x":1}\n');
    if (process.platform !== 'win32') expect((await fsp.stat(path.join(target, 'a.txt'))).mode & 0o777).toBe(0o644);
  });
});

describe('interoperability', () => {
  it('Info-ZIP unzip accepts the archive (when installed)', async (ctx) => {
    const unzip = await run('unzip', ['-v']).then(
      () => true,
      () => false,
    );
    if (!unzip) return ctx.skip();
    const file = path.join(dir, 'sample.zip');
    await fsp.writeFile(file, writeZip(SAMPLE));
    const { stdout } = await run('unzip', ['-t', file]);
    expect(stdout).toMatch(/No errors detected/);
    const listing = (await run('unzip', ['-Z', file])).stdout;
    expect(listing).toMatch(/-rw-r--r--.*a\.txt/);
    expect(listing).toMatch(/26-Jan-01 00:00|2026-Jan-01|01-Jan-26/);
  });
});
