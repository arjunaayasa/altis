import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWorkPath, type DataPath } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SlimsFileTooLargeError, openFilesDir, openFilesZip, type SlimsFilesSource } from '../../src/migration/slims/source/index.js';
import { S_IFDIR, S_IFLNK, S_IFREG, rawZip, unixAttributes, type RawEntry } from '../helpers/raw-zip.js';
import { slimsFixtureBytes } from '../support/slims-fixture/index.js';

// The files of a SLiMS install (spec §11.1): the uploaded zip (`slims.files`) or, from the CLI only, the SLiMS folder.
// Entries are opened only on request; a name that would leave the archive, a link and a folder are never served, and
// `maxBytes` bounds what an entry may inflate to (S10).

const MIB = 1024 * 1024;
let tmp: string;
let dataDir: string;

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-files-')));
  dataDir = path.join(tmp, 'data');
  await fsp.mkdir(dataDir);
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** `bytes` as the run's uploaded files archive. */
async function zipAt(bytes: Buffer): Promise<DataPath> {
  const p = runWorkPath(dataDir, newId(), 'files.bin');
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, bytes);
  return p;
}

async function read(files: SlimsFilesSource, rel: string, o?: { maxBytes?: number }): Promise<Buffer | null> {
  const stream = await files.open(rel, o);
  if (stream === null) return null;
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('no error');
}

const regular = (name: string, data: string | Buffer, extra: Partial<RawEntry> = {}): RawEntry => ({
  name,
  data: Buffer.isBuffer(data) ? data : Buffer.from(data),
  method: 8,
  ...extra,
});

describe('openFilesZip', () => {
  it('serves the fixture files on request and answers null for the missing ones', async () => {
    const { filesZip, expected } = slimsFixtureBytes();
    const files = await openFilesZip(await zipAt(filesZip));
    try {
      const pdf = await read(files, 'repository/docs/laskar.pdf');
      expect(pdf!.subarray(0, 8).toString()).toBe('%PDF-1.4');
      expect(await files.size('repository/docs/laskar.pdf')).toBe(pdf!.length);
      expect(await read(files, 'images/docs/cover-1.jpg')).not.toBeNull();
      expect(await read(files, 'images/content/peta.png')).not.toBeNull();
      for (const missing of expected.traps.missingFiles) expect(await files.open(missing.rel)).toBeNull();
      expect(await files.open('images/docs/cover-21.jpg')).toBeNull();
      expect(await files.open('repository/')).toBeNull();
      expect(await files.size('repository/docs/hilang.pdf')).toBeNull();
      const big = expected.traps.attachments.tooLarge[0]!;
      expect((await read(files, big.rel))!.length).toBe(big.bytes);
      const error = await failure(read(files, big.rel, { maxBytes: MIB }));
      expect(error).toBeInstanceOf(SlimsFileTooLargeError);
      expect(error).toMatchObject({ rel: big.rel, limit: MIB });
    } finally {
      await files.close();
    }
  });

  it('refuses an entry ../x and every other name that leaves the archive, links and folders, and keeps the rest', async () => {
    const zip = rawZip([
      regular('../x', 'escape'),
      regular('/etc/passwd', 'absolute'),
      regular('repository\\win.pdf', 'backslash'),
      regular('C:/drive.pdf', 'drive'),
      regular(`repository/nul${String.fromCharCode(0)}.pdf`, 'nul'),
      regular('repository/a/../../y.pdf', 'dotdot'),
      regular('repository/link.pdf', '/etc/passwd', { method: 0, externalAttributes: unixAttributes(S_IFLNK | 0o777) }),
      regular('repository/folder', '', { method: 0, externalAttributes: unixAttributes(S_IFDIR | 0o755) }),
      regular('repository/ok.pdf', 'fine', { externalAttributes: unixAttributes(S_IFREG | 0o644) }),
    ]);
    const files = await openFilesZip(await zipAt(zip));
    try {
      for (const rel of ['../x', 'x', '/etc/passwd', 'etc/passwd', 'repository\\win.pdf', 'repository/win.pdf', 'C:/drive.pdf', 'repository/a/../../y.pdf', 'y.pdf', 'repository/link.pdf', 'repository/folder']) {
        expect([rel, await files.open(rel)]).toEqual([rel, null]);
        expect([rel, await files.size(rel)]).toEqual([rel, null]);
      }
      expect((await read(files, 'repository/ok.pdf'))!.toString()).toBe('fine');
    } finally {
      await files.close();
    }
  });

  it('refuses an entry that inflates past maxBytes, whatever size it declares (S10)', async () => {
    const tenMib = Buffer.alloc(10 * MIB, 0x41);
    const zip = rawZip([
      { name: 'repository/liar.pdf', data: tenMib, method: 8, uncompressedSize: 1024 }, // declares 1 KiB
      regular('repository/large.pdf', Buffer.alloc(2 * MIB, 0x42)), // declares its 2 MiB honestly
      regular('repository/small.pdf', 'small'),
    ]);
    const files = await openFilesZip(await zipAt(zip));
    try {
      expect(await failure(read(files, 'repository/liar.pdf', { maxBytes: MIB }))).toBeInstanceOf(SlimsFileTooLargeError);
      expect(await failure(read(files, 'repository/liar.pdf'))).toBeInstanceOf(SlimsFileTooLargeError); // past its own declared size
      expect(await failure(read(files, 'repository/large.pdf', { maxBytes: MIB }))).toBeInstanceOf(SlimsFileTooLargeError);
      expect((await read(files, 'repository/small.pdf', { maxBytes: MIB }))!.toString()).toBe('small');
    } finally {
      await files.close();
    }
  });

  it('throws after the last byte of an entry whose CRC-32 does not match', async () => {
    const zip = rawZip([{ name: 'repository/damaged.pdf', data: Buffer.from('aaaa'), method: 0, raw: Buffer.from('abab') }]);
    const files = await openFilesZip(await zipAt(zip));
    try {
      const error = await failure(read(files, 'repository/damaged.pdf'));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SlimsFileTooLargeError);
      expect(String((error as Error).message)).toMatch(/unreadable/);
    } finally {
      await files.close();
    }
  });

  it('finds the SLiMS folder inside a top folder, and a name in another letter case when only one matches', async () => {
    const zip = rawZip([regular('slims9/repository/Docs/Buku.PDF', 'a'), regular('slims9/images/docs/c.jpg', 'b'), regular('other/readme.txt', 'c')]);
    const files = await openFilesZip(await zipAt(zip));
    try {
      expect((await read(files, 'repository/Docs/Buku.PDF'))!.toString()).toBe('a');
      expect((await read(files, 'repository/docs/buku.pdf'))!.toString()).toBe('a');
      expect((await read(files, 'images/docs/c.jpg'))!.toString()).toBe('b');
      expect(await files.open('other/readme.txt')).toBeNull();
    } finally {
      await files.close();
    }
  });

  it('a zip of a whole SLiMS install: the folder holding repository/ or images/docs/ wins over an earlier nested images/ (C18)', async () => {
    // Listed first (central-directory order): a theme's images/, a JS library's images/, macOS's resource forks.
    const zip = rawZip([
      regular('slims9/template/default/assets/images/logo.png', 'logo'),
      regular('slims9/admin/admin_template/default/images/x.png', 'x'),
      regular('__MACOSX/slims9/images/docs/._a.jpg', 'fork'),
      regular('slims9/images/docs/a.jpg', 'a'),
      regular('slims9/images/content/p.png', 'p'),
      regular('slims9/repository/b.pdf', 'b'),
    ]);
    const files = await openFilesZip(await zipAt(zip));
    try {
      expect((await read(files, 'images/docs/a.jpg'))?.toString()).toBe('a');
      expect((await read(files, 'images/content/p.png'))?.toString()).toBe('p');
      expect((await read(files, 'repository/b.pdf'))?.toString()).toBe('b');
      expect((await read(files, 'template/default/assets/images/logo.png'))?.toString()).toBe('logo');
      expect(await files.open('images/logo.png')).toBeNull();
    } finally {
      await files.close();
    }
    // Only the data folders count: a root images/ of a theme does not make the root the SLiMS folder.
    const rooted = await openFilesZip(await zipAt(rawZip([regular('images/logo.png', 'logo'), regular('slims9/repository/b.pdf', 'b')])));
    try {
      expect((await read(rooted, 'repository/b.pdf'))?.toString()).toBe('b');
    } finally {
      await rooted.close();
    }
  });

  // ---- the stocktake reports ----
  it('reads the stocktake reports `files/reports/`, from a top folder that holds only them too', async () => {
    const only = await openFilesZip(await zipAt(rawZip([regular('slims9/files/reports/stock_take_1_report.html', 'r1'), regular('slims9/files/cache/x.tmp', 'x')])));
    try {
      expect((await read(only, 'files/reports/stock_take_1_report.html'))?.toString()).toBe('r1');
      expect(await only.open('slims9/files/reports/stock_take_1_report.html')).toBeNull();
    } finally {
      await only.close();
    }
    const both = await openFilesZip(await zipAt(rawZip([regular('repository/a.pdf', 'a'), regular('files/reports/stock_take_2_report.html', 'r2')])));
    try {
      expect((await read(both, 'files/reports/stock_take_2_report.html'))?.toString()).toBe('r2');
      expect(await both.open('files/reports/../../repository/a.pdf')).toBeNull();
    } finally {
      await both.close();
    }
  });

  it('refuses a zip holding two SLiMS folders side by side (files_zip_ambiguous) rather than picking one (C18)', async () => {
    const zip = rawZip([regular('slims8/repository/a.pdf', 'a'), regular('slims9/images/docs/b.jpg', 'b')]);
    const error = await failure(openFilesZip(await zipAt(zip)));
    expect(isDomainError(error) && [error.code, error.meta?.['reason']]).toEqual(['MIGRATION_SOURCE_UNSUPPORTED', 'files_zip_ambiguous']);
    // The run's report shows the detail (failureOf): it names the two folders, so the admin can fix the archive.
    expect(isDomainError(error) && error.detail).toBe(
      'Arsip berkas memuat dua folder SLiMS (slims8/, slims9/); unggah satu saja / The files archive holds two SLiMS folders (slims8/, slims9/); upload one only',
    );
    // A crafted name is cut and loses its control characters in that detail.
    const long = `${'x'.repeat(100)}\u0007/`;
    const crafted = await failure(openFilesZip(await zipAt(rawZip([regular(`${long}repository/a.pdf`, 'a'), regular('lain/repository/b.pdf', 'b')]))));
    expect(isDomainError(crafted) && crafted.detail).toBe(
      `Arsip berkas memuat dua folder SLiMS (${'x'.repeat(64)}, lain/); unggah satu saja / The files archive holds two SLiMS folders (${'x'.repeat(64)}, lain/); upload one only`,
    );
  });

  it('refuses a file that is not a zip', async () => {
    const error = await failure(openFilesZip(await zipAt(Buffer.from('not a zip file at all'))));
    expect(isDomainError(error) && [error.code, error.meta?.['reason']]).toEqual(['MIGRATION_SOURCE_UNSUPPORTED', 'files_zip_invalid']);
  });
});

describe('openFilesDir', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(tmp, 'slims');
    await fsp.mkdir(path.join(root, 'repository', 'docs'), { recursive: true });
    await fsp.mkdir(path.join(root, 'images', 'docs'), { recursive: true });
    await fsp.writeFile(path.join(root, 'repository', 'docs', 'a.pdf'), 'PDF');
    await fsp.writeFile(path.join(root, 'images', 'docs', 'big.jpg'), Buffer.alloc(2 * MIB, 1));
    await fsp.writeFile(path.join(tmp, 'secret.txt'), 'outside');
    await fsp.symlink(path.join(tmp, 'secret.txt'), path.join(root, 'repository', 'docs', 'escape.pdf'));
  });

  it('serves files below the SLiMS folder on request, bounded by its real path', async () => {
    const files = await openFilesDir(root);
    try {
      expect((await read(files, 'repository/docs/a.pdf'))!.toString()).toBe('PDF');
      expect(await files.size('repository/docs/a.pdf')).toBe(3);
      expect(await files.open('repository/docs/missing.pdf')).toBeNull();
      expect(await files.open('../secret.txt')).toBeNull();
      expect(await files.open('repository/../../secret.txt')).toBeNull();
      expect(await files.open('repository/docs/escape.pdf')).toBeNull();
      expect(await files.open('repository/docs')).toBeNull();
      expect(await files.size('repository/docs/escape.pdf')).toBeNull();
      expect(await failure(read(files, 'images/docs/big.jpg', { maxBytes: MIB }))).toBeInstanceOf(SlimsFileTooLargeError);
      expect((await read(files, 'images/docs/big.jpg'))!.length).toBe(2 * MIB);
    } finally {
      await files.close();
    }
  });

  it('refuses a folder that does not exist', async () => {
    const error = await failure(openFilesDir(path.join(tmp, 'nope')));
    expect(isDomainError(error) && [error.code, error.meta?.['reason']]).toEqual(['MIGRATION_SOURCE_UNSUPPORTED', 'files_dir_missing']);
  });
});
