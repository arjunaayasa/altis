import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError, type DomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendLine,
  copyFileTo,
  dataDirUsage,
  fsyncDir,
  listNames,
  openAppend,
  openRead,
  openReadWrite,
  readBytes,
  removeFile,
  removeStaleTemps,
  removeTree,
  renameRetry,
  statOrNull,
  truncateFile,
  withTempSibling,
  writeBytesAtomic,
  writeBytesInFolder,
  writeExclusive,
  writeStreamAtomic,
} from '../src/data-files.js';
import { backupPartPath, dataPath, type DataPath } from '../src/datapath.js';
import { resetTestFaults } from '../src/fault.js';
import { errno } from './support.js';

let root: string; // realpath of a temp directory
let dataDir: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-data-files-')));
  dataDir = path.join(root, 'altis-data');
  await fsp.mkdir(dataDir);
  resetTestFaults();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fsp.chmod(path.join(root, 'altis-data'), 0o700).catch(() => undefined);
  await fsp.rm(root, { recursive: true, force: true });
});

const ULID = '01JBX5ZK3M8Q4R7T9V0W2Y6A1C';
const posix = process.platform !== 'win32';

const rejection = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

/** Every name below `dir`, relative to it, sorted; hidden temp files included. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = rel === '' ? entry.name : `${rel}/${entry.name}`;
      out.push(name);
      if (entry.isDirectory()) await walk(path.join(d, entry.name), name);
    }
  };
  await walk(dir, '');
  return out.sort();
}

/**
 * Makes every handle opened for writing reject its writes with `code` (as a full disk or an exhausted quota would),
 * for the files `match` selects.
 */
function failWrites(code: string, match: (file: string) => boolean = () => true): void {
  const realOpen = fsp.open.bind(fsp);
  vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
    const handle = await realOpen(...args);
    const [file, flags] = args;
    const writing = typeof flags === 'number' ? (flags & 3) !== fsConstants.O_RDONLY : flags !== undefined && flags !== 'r';
    if (typeof file === 'string' && writing && match(file)) {
      const fail = async (): Promise<never> => {
        throw errno(code);
      };
      Object.assign(handle, { write: fail, writeFile: fail, writev: fail, appendFile: fail });
    }
    return handle;
  }) as typeof fsp.open);
}

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

async function* failingAfter(part: string, error: Error): AsyncIterable<Uint8Array> {
  yield Buffer.from(part);
  throw error;
}

describe('readBytes', () => {
  it('returns the bytes of a file, and null when it does not exist', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp'));
    await fsp.writeFile(path.join(dataDir, 'tmp', 'op.json'), 'hello');
    expect((await readBytes(dataPath(dataDir, 'tmp', 'op.json')))?.toString()).toBe('hello');
    expect(await readBytes(dataPath(dataDir, 'tmp', 'report.json'))).toBeNull();
    expect(await readBytes(dataPath(dataDir, 'ops', ULID, 'op.json'))).toBeNull(); // missing folder too
  });

  it('refuses a file larger than maxBytes', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp'));
    await fsp.writeFile(path.join(dataDir, 'tmp', 'op.json'), 'x'.repeat(11));
    expect((await readBytes(dataPath(dataDir, 'tmp', 'op.json'), 11))?.length).toBe(11);
    const error = await rejection(readBytes(dataPath(dataDir, 'tmp', 'op.json'), 10));
    expect(error).toMatchObject({ code: 'STATE_CORRUPT', meta: { reason: 'too_large', maxBytes: 10 } });
  });

  it('refuses a folder', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp', ULID), { recursive: true });
    expect(await rejection(readBytes(dataPath(dataDir, 'tmp', ULID)))).toMatchObject({
      code: 'STATE_CORRUPT',
      meta: { reason: 'not_a_file' },
    });
  });

  it('refuses a maxBytes that is not a positive integer', async () => {
    await expect(readBytes(dataPath(dataDir, 'tmp', 'op.json'), 0)).rejects.toThrow(RangeError);
    await expect(readBytes(dataPath(dataDir, 'tmp', 'op.json'), 1.5)).rejects.toThrow(RangeError);
  });
});

describe('writeExclusive', () => {
  it('creates the file once: true, then false without touching it', async () => {
    const p = dataPath(dataDir, 'ops', 'op.json');
    expect(await writeExclusive(p, '{"a":1}')).toBe(true);
    expect(await writeExclusive(p, '{"b":2}')).toBe(false);
    expect(await fsp.readFile(p, 'utf8')).toBe('{"a":1}');
    expect(await tree(path.join(dataDir, 'ops'))).toEqual(['op.json']); // no temp file left by either call
  });

  it.skipIf(!posix)('creates it with mode 0600 by default, or the mode given, and missing folders with 0700', async () => {
    const p = dataPath(dataDir, 'ops', ULID, 'op.json');
    expect(await writeExclusive(p, new Uint8Array([1, 2, 3]))).toBe(true);
    expect((await fsp.stat(p)).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(path.join(dataDir, 'ops', ULID))).mode & 0o777).toBe(0o700);
    const q = dataPath(dataDir, 'ops', 'maintenance.json');
    expect(await writeExclusive(q, 'x', 0o640)).toBe(true);
    expect((await fsp.stat(q)).mode & 0o777 & ~process.umask()).toBe(0o640 & ~process.umask());
  });

  it('never creates DATA_DIR itself', async () => {
    const missing = path.join(root, 'not-there');
    expect(await rejection(writeExclusive(dataPath(missing, 'ops', 'op.json'), 'x'))).toMatchObject({ code: 'ENOENT' });
    expect(await statOrNull(dataPath(missing, 'root'))).toBeNull();
  });

  it('removes the file it created, and the folders below the area folder, when the disk is full (P21)', async () => {
    failWrites('EDQUOT');
    const error = (await rejection(writeExclusive(dataPath(dataDir, 'ops', ULID, 'op.json'), 'x'))) as DomainError;
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'DISK_QUOTA', status: 507, meta: { code: 'EDQUOT' } });
    expect(await tree(dataDir)).toEqual(['ops']); // the area folder stays: other processes may be using it
  });

  /**
   * Holds the first write through a handle opened with `wx` in `dir` until `release()`; `reached` resolves once that
   * write is waiting. Every later handle writes at once.
   */
  function stallFirstWrite(dir: string): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const realOpen = fsp.open.bind(fsp);
    let stalled = false;
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      const [file, flags] = args;
      if (!stalled && typeof file === 'string' && flags === 'wx' && path.dirname(file) === dir) {
        stalled = true;
        const write = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>;
        Object.assign(handle, {
          write: async (...a: unknown[]) => {
            arrived();
            await gate;
            return write(...a);
          },
        });
      }
      return handle;
    }) as typeof fsp.open);
    return { reached, release };
  }

  it('publishes the file whole: while its content is being written, the file does not exist yet', async () => {
    const p = dataPath(dataDir, 'ops', 'op.json');
    const { reached, release } = stallFirstWrite(path.dirname(p));
    const writing = writeExclusive(p, '{"op":1}');
    await reached;
    // A process killed at this moment (P7) leaves no empty or partial op.json, and a reader finds none.
    expect(await statOrNull(p)).toBeNull();
    expect(await readBytes(p)).toBeNull();
    release();
    expect(await writing).toBe(true);
    expect(await fsp.readFile(p, 'utf8')).toBe('{"op":1}');
    expect(await tree(path.join(dataDir, 'ops'))).toEqual(['op.json']); // no temp file left
  });

  it('a caller that gets false reads the full content of the one that got true, never a part', async () => {
    const p = dataPath(dataDir, 'root', 'install-code.txt');
    const { reached, release } = stallFirstWrite(path.dirname(p));
    const first = writeExclusive(p, 'code-of-the-first-caller');
    await reached; // the first caller's write is under way
    const second = await writeExclusive(p, 'code-of-the-second-caller');
    const seenRightAfterSecond = await fsp.readFile(p, 'utf8');
    release();
    const firstResult = await first;
    expect([firstResult, second].sort()).toEqual([false, true]);
    const winner = firstResult ? 'code-of-the-first-caller' : 'code-of-the-second-caller';
    expect(seenRightAfterSecond).toBe(winner);
    expect(await fsp.readFile(p, 'utf8')).toBe(winner);
    expect((await tree(dataDir)).filter((name) => name.startsWith('.'))).toEqual([]); // no temp file left
  });

  it('leaves neither the file nor a temp file when publishing it fails', async () => {
    const p = dataPath(dataDir, 'ops', ULID, 'op.json');
    vi.spyOn(fsp, 'link').mockRejectedValue(errno('EIO'));
    expect(await rejection(writeExclusive(p, 'x'))).toMatchObject({ code: 'EIO' });
    expect(await tree(dataDir)).toEqual(['ops']);
  });

  it('turns a full disk while publishing into DISK_QUOTA and leaves nothing behind (P21)', async () => {
    vi.spyOn(fsp, 'link').mockRejectedValue(errno('ENOSPC'));
    const error = await rejection(writeExclusive(dataPath(dataDir, 'ops', ULID, 'op.json'), 'x'));
    expect(error).toMatchObject({ code: 'DISK_QUOTA', meta: { code: 'ENOSPC' } });
    expect(await tree(dataDir)).toEqual(['ops']);
  });

  it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR'])(
    'still creates the file exclusively on a file system without hard links (link: %s, e.g. FAT/exFAT)',
    async (code) => {
      vi.spyOn(fsp, 'link').mockRejectedValue(errno(code));
      const p = dataPath(dataDir, 'ops', 'op.json');
      expect(await writeExclusive(p, '{"a":1}')).toBe(true);
      expect(await writeExclusive(p, '{"b":2}')).toBe(false);
      expect(await fsp.readFile(p, 'utf8')).toBe('{"a":1}');
      expect(await tree(path.join(dataDir, 'ops'))).toEqual(['op.json']); // no temp file left
    },
  );

  it('creates the file without hard links even when removing the temp file first is refused (a scanner holding it)', async () => {
    vi.spyOn(fsp, 'link').mockRejectedValue(errno('EPERM'));
    const realRm = fsp.rm.bind(fsp);
    let refused = 0;
    vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (path.basename(String(target)).startsWith('.') && refused === 0) {
        refused += 1;
        throw errno('EBUSY');
      }
      return realRm(target, options);
    });
    const p = dataPath(dataDir, 'ops', 'op.json');
    expect(await writeExclusive(p, '{"a":1}')).toBe(true);
    expect(refused).toBe(1);
    expect(await fsp.readFile(p, 'utf8')).toBe('{"a":1}');
    expect(await tree(path.join(dataDir, 'ops'))).toEqual(['op.json']); // the temp file went in the end
  });

  it('counts a link that was made although it reported EEXIST (a retransmitted NFS request) as its own', async () => {
    const realLink = fsp.link.bind(fsp);
    vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => {
      await realLink(from, to);
      throw errno('EEXIST');
    });
    const p = dataPath(dataDir, 'ops', 'op.json');
    expect(await writeExclusive(p, '{"a":1}')).toBe(true);
    expect(await fsp.readFile(p, 'utf8')).toBe('{"a":1}');
    expect(await tree(path.join(dataDir, 'ops'))).toEqual(['op.json']);
  });
});

describe('writeBytesAtomic', () => {
  it('replaces the file as a whole and leaves no temp file', async () => {
    const p = dataPath(dataDir, 'tmp', 'report.json');
    await writeBytesAtomic(p, 'first');
    await writeBytesAtomic(p, Buffer.from('second'));
    expect(await fsp.readFile(p, 'utf8')).toBe('second');
    expect(await tree(dataDir)).toEqual(['tmp', 'tmp/report.json']);
  });

  it.skipIf(!posix)('writes mode 0600 by default', async () => {
    const p = dataPath(dataDir, 'tmp', 'report.json');
    await writeBytesAtomic(p, 'x');
    expect((await fsp.stat(p)).mode & 0o777).toBe(0o600);
  });

  it.each(['EDQUOT', 'ENOSPC'])('turns %s into DISK_QUOTA, keeps the old content and leaves no partial file (P21)', async (code) => {
    const p = dataPath(dataDir, 'tmp', 'report.json');
    await writeBytesAtomic(p, 'old');
    failWrites(code);
    const error = await rejection(writeBytesAtomic(p, 'new'));
    expect(error).toMatchObject({ code: 'DISK_QUOTA', meta: { code } });
    expect((error as DomainError).cause).toMatchObject({ code });
    expect(await fsp.readFile(p, 'utf8')).toBe('old');
    expect(await tree(dataDir)).toEqual(['tmp', 'tmp/report.json']);
  });

  it('passes other errors through as they are, still cleaning up', async () => {
    failWrites('EIO');
    const error = await rejection(writeBytesAtomic(dataPath(dataDir, 'tmp', ULID, 'report.json'), 'x'));
    expect(isDomainError(error)).toBe(false);
    expect(error).toMatchObject({ code: 'EIO' });
    expect(await tree(dataDir)).toEqual(['tmp']);
  });
});

describe('writeBytesInFolder', () => {
  it('replaces the file as writeBytesAtomic does while its folder exists', async () => {
    const p = dataPath(dataDir, 'backups', ULID, 'prepared.json');
    await fsp.mkdir(path.dirname(p), { recursive: true });
    expect(await writeBytesInFolder(p, 'first')).toBe(true);
    expect(await writeBytesInFolder(p, Buffer.from('second'))).toBe(true);
    expect(await fsp.readFile(p, 'utf8')).toBe('second');
    expect(await tree(dataDir)).toEqual(['backups', `backups/${ULID}`, `backups/${ULID}/prepared.json`]);
  });

  it('never creates a missing folder: false, and nothing is written', async () => {
    const p = dataPath(dataDir, 'backups', ULID, 'downloads', ULID, 'prepared.json');
    await fsp.mkdir(path.join(dataDir, 'backups'));
    expect(await writeBytesInFolder(p, 'x')).toBe(false);
    expect(await tree(dataDir)).toEqual(['backups']);
  });

  it('turns ENOSPC into DISK_QUOTA and keeps the old content (P21)', async () => {
    const p = dataPath(dataDir, 'tmp', 'report.json');
    await writeBytesAtomic(p, 'old');
    failWrites('ENOSPC');
    expect(await rejection(writeBytesInFolder(p, 'new'))).toMatchObject({ code: 'DISK_QUOTA' });
    expect(await fsp.readFile(p, 'utf8')).toBe('old');
    expect(await tree(dataDir)).toEqual(['tmp', 'tmp/report.json']);
  });
});

describe('renameRetry', () => {
  it('retries EBUSY (Windows scanners) and succeeds', async () => {
    const from = dataPath(dataDir, 'tmp', 'op.json');
    const to = dataPath(dataDir, 'tmp', 'report.json');
    await writeBytesAtomic(from, 'x');
    const realRename = fsp.rename.bind(fsp);
    let refused = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (refused < 2) {
        refused += 1;
        throw errno('EBUSY');
      }
      return realRename(a, b);
    });
    await renameRetry(from, to);
    expect(refused).toBe(2);
    expect(await fsp.readFile(to, 'utf8')).toBe('x');
    expect(await statOrNull(from)).toBeNull();
  });

  it('gives up after 10 s of EPERM', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
    const from = dataPath(dataDir, 'tmp', 'op.json');
    await fsp.mkdir(path.join(dataDir, 'tmp'));
    await fsp.writeFile(from, 'x');
    const rename = vi.spyOn(fsp, 'rename').mockRejectedValue(errno('EPERM'));
    const result = rejection(renameRetry(from, dataPath(dataDir, 'tmp', 'report.json')));
    // The first attempt follows real I/O (the folder check), which fake timers cannot advance: wait for it.
    while (rename.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(9_000);
    const before = rename.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toMatchObject({ code: 'EPERM' });
    expect(before).toBeGreaterThan(5);
  });

  it('throws any other error at once', async () => {
    const rename = vi.spyOn(fsp, 'rename');
    const error = await rejection(renameRetry(dataPath(dataDir, 'tmp', 'op.json'), dataPath(dataDir, 'tmp', 'report.json')));
    expect(error).toMatchObject({ code: 'ENOENT' });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("creates the target's folder (archiving ops/op.json to ops/<opId>/op.json)", async () => {
    const from = dataPath(dataDir, 'ops', 'op.json');
    await writeExclusive(from, '{}');
    await renameRetry(from, dataPath(dataDir, 'ops', ULID, 'op.json'));
    expect(await tree(path.join(dataDir, 'ops'))).toEqual([ULID, `${ULID}/op.json`]);
  });
});

describe('removeTree and removeFile', () => {
  it('refuses DATA_DIR itself and every area root', async () => {
    await fsp.mkdir(path.join(dataDir, 'backups'));
    expect(await rejection(removeTree(dataPath(dataDir, 'backups')))).toBeInstanceOf(TypeError);
    expect(await rejection(removeTree(dataPath(dataDir, 'root')))).toBeInstanceOf(TypeError);
    expect(await rejection(removeTree(dataPath(dataDir, 'tmp')))).toBeInstanceOf(TypeError);
    expect(await statOrNull(dataPath(dataDir, 'backups'))).toMatchObject({ kind: 'dir' });
  });

  it('refuses a path outside every DATA_DIR this process knows', async () => {
    expect(await rejection(removeTree(root as DataPath))).toBeInstanceOf(TypeError);
    expect(await rejection(removeTree('/' as DataPath))).toBeInstanceOf(TypeError);
    expect(await statOrNull(dataPath(dataDir, 'root'))).toMatchObject({ kind: 'dir' });
  });

  it('removes a folder below an area, and accepts one that is gone already', async () => {
    const p = backupPartPath(dataDir, ULID, 'branches', 1, new Set(['branches']));
    await writeBytesAtomic(p, 'x');
    await removeTree(dataPath(dataDir, 'backups', ULID));
    expect(await tree(dataDir)).toEqual(['backups']);
    await removeTree(dataPath(dataDir, 'backups', ULID));
  });

  it('removeFile removes one file and accepts one that is gone already', async () => {
    const p = dataPath(dataDir, 'tmp', 'op.json');
    await writeBytesAtomic(p, 'x');
    await removeFile(p);
    await removeFile(p);
    expect(await tree(dataDir)).toEqual(['tmp']);
  });

  it('removeFile refuses a folder', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp', ULID), { recursive: true });
    expect(await rejection(removeFile(dataPath(dataDir, 'tmp', ULID)))).toMatchObject({ code: 'ERR_FS_EISDIR' });
    expect(await tree(dataDir)).toEqual(['tmp', `tmp/${ULID}`]);
  });

  // fs.rm ignores maxRetries/retryDelay without `recursive`: a scanner or the indexer holding the file for a moment
  // (Windows) must be waited out by removeFile itself.
  it.each(['EPERM', 'EBUSY'])('removeFile retries %s and succeeds', async (code) => {
    const p = dataPath(dataDir, 'tmp', 'op.json');
    await writeBytesAtomic(p, 'x');
    const realRm = fsp.rm.bind(fsp);
    let refused = 0;
    vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (refused < 2) {
        refused += 1;
        throw errno(code);
      }
      return realRm(target, options);
    });
    await removeFile(p);
    expect(refused).toBe(2);
    expect(await tree(dataDir)).toEqual(['tmp']);
  });

  it('removeFile gives up after 10 s of EBUSY, and throws any other error at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
    const rm = vi.spyOn(fsp, 'rm').mockRejectedValue(errno('EBUSY'));
    const result = rejection(removeFile(dataPath(dataDir, 'tmp', 'op.json')));
    while (rm.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(9_000);
    const before = rm.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toMatchObject({ code: 'EBUSY' });
    expect(before).toBeGreaterThan(5);
    rm.mockReset().mockRejectedValue(errno('EIO'));
    expect(await rejection(removeFile(dataPath(dataDir, 'tmp', 'op.json')))).toMatchObject({ code: 'EIO' });
    expect(rm).toHaveBeenCalledTimes(1);
  });
});

describe('listNames and statOrNull', () => {
  it('lists regular files and folders only, sorted; [] for a missing folder', async () => {
    const dir = path.join(dataDir, 'tmp');
    await fsp.mkdir(path.join(dir, ULID), { recursive: true });
    await fsp.writeFile(path.join(dir, 'b.json'), '');
    await fsp.writeFile(path.join(dir, 'a.json'), '');
    if (posix) await fsp.symlink(path.join(dir, 'a.json'), path.join(dir, 'link'));
    expect(await listNames(dataPath(dataDir, 'tmp'))).toEqual([ULID, 'a.json', 'b.json']); // code-unit order
    expect(await listNames(dataPath(dataDir, 'ops'))).toEqual([]);
  });

  it('reports size, mtime and kind; null when missing; a symbolic link is "other"', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp'));
    await fsp.writeFile(path.join(dataDir, 'tmp', 'op.json'), '12345');
    expect(await statOrNull(dataPath(dataDir, 'tmp', 'op.json'))).toEqual({
      size: 5,
      mtimeMs: (await fsp.stat(path.join(dataDir, 'tmp', 'op.json'))).mtimeMs,
      kind: 'file',
    });
    expect(await statOrNull(dataPath(dataDir, 'tmp'))).toMatchObject({ kind: 'dir' });
    expect(await statOrNull(dataPath(dataDir, 'tmp', 'report.json'))).toBeNull();
    expect(await statOrNull(dataPath(dataDir, 'tmp', 'op.json', 'report.json'))).toBeNull(); // ENOTDIR
    if (posix) {
      await fsp.symlink(path.join(dataDir, 'tmp', 'op.json'), path.join(dataDir, 'tmp', 'report.json'));
      expect(await statOrNull(dataPath(dataDir, 'tmp', 'report.json'))).toMatchObject({ kind: 'other' });
    }
  });
});

describe('handles', () => {
  it('openAppend creates the folders and appends', async () => {
    const p = dataPath(dataDir, 'logs', 'audit-anchor.log');
    for (const line of ['a\n', 'b\n']) {
      const handle = await openAppend(p);
      try {
        await handle.write(line);
      } finally {
        await handle.close();
      }
    }
    expect(await fsp.readFile(p, 'utf8')).toBe('a\nb\n');
  });

  it('openReadWrite creates the file, never truncates it, and allows positioned writes; truncateFile shortens it', async () => {
    const p = dataPath(dataDir, 'tmp', ULID, 'upload.bin');
    let handle = await openReadWrite(p);
    await handle.write(Buffer.from('hello world'), 0, 11, 0);
    await handle.close();
    handle = await openReadWrite(p);
    await handle.write(Buffer.from('W'), 0, 1, 6);
    await handle.close();
    expect(await fsp.readFile(p, 'utf8')).toBe('hello World');
    await truncateFile(p, 5);
    expect(await fsp.readFile(p, 'utf8')).toBe('hello');
  });

  it('openRead reads, and refuses a folder', async () => {
    const p = dataPath(dataDir, 'tmp', 'op.json');
    await writeBytesAtomic(p, 'abc');
    const handle = await openRead(p);
    try {
      expect((await handle.readFile()).toString()).toBe('abc');
    } finally {
      await handle.close();
    }
    expect(await rejection(openRead(dataPath(dataDir, 'tmp')))).toMatchObject({ meta: { reason: 'not_a_file' } });
  });

  it('openAppend turns a full disk into DISK_QUOTA and removes the folders it created', async () => {
    vi.spyOn(fsp, 'open').mockRejectedValue(errno('ENOSPC'));
    expect(await rejection(openAppend(dataPath(dataDir, 'ops', ULID, 'op.json')))).toMatchObject({
      code: 'DISK_QUOTA',
      meta: { code: 'ENOSPC' },
    });
    expect(await tree(dataDir)).toEqual(['ops']);
  });

  it('fsyncDir syncs a folder', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp'));
    await fsyncDir(dataPath(dataDir, 'tmp'));
  });
});

describe('copyFileTo', () => {
  it('hard-links the file when it can', async () => {
    const from = dataPath(dataDir, 'tmp', 'upload.bin');
    await writeBytesAtomic(from, 'blob');
    const to = dataPath(dataDir, 'backups', 'blobs', 'a'.repeat(64));
    await copyFileTo(from, to);
    expect(await fsp.readFile(to, 'utf8')).toBe('blob');
    if (posix) expect((await fsp.stat(to)).ino).toBe((await fsp.stat(from)).ino);
    expect(await tree(path.join(dataDir, 'backups'))).toEqual(['blobs', `blobs/${'a'.repeat(64)}`]);
    // Again onto the same link: rename() between two links of one file does nothing, the temp link must still go.
    await copyFileTo(from, to);
    expect(await tree(path.join(dataDir, 'backups'))).toEqual(['blobs', `blobs/${'a'.repeat(64)}`]);
  });

  it('copies when linking fails (another volume, a file system without links)', async () => {
    const from = dataPath(dataDir, 'tmp', 'upload.bin');
    await writeBytesAtomic(from, 'blob');
    vi.spyOn(fsp, 'link').mockRejectedValue(errno('EXDEV'));
    const to = dataPath(dataDir, 'uploads', ULID);
    await copyFileTo(from, to);
    expect(await fsp.readFile(to, 'utf8')).toBe('blob');
    expect((await fsp.stat(to)).ino).not.toBe((await fsp.stat(from)).ino);
    expect(await tree(path.join(dataDir, 'uploads'))).toEqual([ULID]);
  });

  it('turns a full disk during the copy into DISK_QUOTA and leaves nothing behind', async () => {
    const from = dataPath(dataDir, 'tmp', 'upload.bin');
    await writeBytesAtomic(from, 'blob');
    vi.spyOn(fsp, 'link').mockRejectedValue(errno('EXDEV'));
    vi.spyOn(fsp, 'copyFile').mockRejectedValue(errno('EDQUOT'));
    expect(await rejection(copyFileTo(from, dataPath(dataDir, 'uploads', ULID)))).toMatchObject({ code: 'DISK_QUOTA' });
    expect(await tree(dataDir)).toEqual(['tmp', 'tmp/upload.bin', 'uploads']);
  });
});

describe('writeStreamAtomic and withTempSibling (S14)', () => {
  const T = new Set(['branches']);

  it('writes a stream through a hidden temp sibling and returns the byte count', async () => {
    const p = backupPartPath(dataDir, ULID, 'branches', 1, T);
    expect(await writeStreamAtomic(p, chunks('ab', 'cde', ''))).toEqual({ bytes: 5 });
    expect(await fsp.readFile(p, 'utf8')).toBe('abcde');
    expect(await tree(path.join(dataDir, 'backups', ULID))).toEqual(['tables', 'tables/branches', 'tables/branches/00001.jsonl.gz']);
  });

  it('a failing source leaves neither the file nor a temp file, and keeps an older file as it was', async () => {
    const p = backupPartPath(dataDir, ULID, 'branches', 1, T);
    const boom = new Error('source failed');
    expect(await rejection(writeStreamAtomic(p, failingAfter('abc', boom)))).toBe(boom);
    expect(await tree(dataDir)).toEqual(['backups']);
    await writeStreamAtomic(p, chunks('old'));
    expect(await rejection(writeStreamAtomic(p, failingAfter('abc', boom)))).toBe(boom);
    expect(await fsp.readFile(p, 'utf8')).toBe('old');
    expect(await tree(path.join(dataDir, 'backups', ULID, 'tables', 'branches'))).toEqual(['00001.jsonl.gz']);
  });

  it('turns a full disk into DISK_QUOTA without leaving a partial file (P21)', async () => {
    const p = backupPartPath(dataDir, ULID, 'branches', 2, T);
    failWrites('EDQUOT');
    expect(await rejection(writeStreamAtomic(p, chunks('abc')))).toMatchObject({ code: 'DISK_QUOTA', meta: { code: 'EDQUOT' } });
    expect(await tree(dataDir)).toEqual(['backups']);
  });

  it('withTempSibling hands fn a hidden sibling of p, then moves it over p', async () => {
    const p = dataPath(dataDir, 'db', ULID, 'snapshot.sqlite');
    let seen = '';
    await withTempSibling(p, async (tmp) => {
      seen = tmp;
      expect(path.dirname(tmp)).toBe(path.dirname(p));
      expect(path.basename(tmp).startsWith('.')).toBe(true);
      await fsp.writeFile(tmp, 'sqlite bytes');
    });
    expect(await fsp.readFile(p, 'utf8')).toBe('sqlite bytes');
    expect(await statOrNull(seen as DataPath)).toBeNull();
    expect(await tree(path.join(dataDir, 'db'))).toEqual([ULID, `${ULID}/snapshot.sqlite`]);
  });

  it('withTempSibling removes the temp file when fn fails, and p stays as it was', async () => {
    const p = dataPath(dataDir, 'db', ULID, 'snapshot.sqlite');
    await writeBytesAtomic(p, 'old');
    const boom = new Error('copy failed');
    const error = await rejection(
      withTempSibling(p, async (tmp) => {
        await fsp.writeFile(tmp, 'partial');
        throw boom;
      }),
    );
    expect(error).toBe(boom);
    expect(await fsp.readFile(p, 'utf8')).toBe('old');
    expect(await tree(path.join(dataDir, 'db'))).toEqual([ULID, `${ULID}/snapshot.sqlite`]);
  });

  it("withTempSibling also removes SQLite's side files of the temp file when fn fails", async () => {
    const p = dataPath(dataDir, 'db', ULID, 'snapshot.sqlite');
    await writeBytesAtomic(p, 'old');
    const boom = new Error('vacuum failed');
    const error = await rejection(
      withTempSibling(p, async (tmp) => {
        await fsp.writeFile(tmp, 'partial');
        await fsp.writeFile(`${tmp}-journal`, 'journal');
        throw boom;
      }),
    );
    expect(error).toBe(boom);
    expect(await tree(path.join(dataDir, 'db'))).toEqual([ULID, `${ULID}/snapshot.sqlite`]);
  });

  it('withTempSibling maps a quota error from fn to DISK_QUOTA and cleans up', async () => {
    const p = dataPath(dataDir, 'db', ULID, 'snapshot.sqlite');
    const error = await rejection(
      withTempSibling(p, async (tmp) => {
        await fsp.writeFile(tmp, 'partial');
        throw errno('ENOSPC');
      }),
    );
    expect(error).toMatchObject({ code: 'DISK_QUOTA', meta: { code: 'ENOSPC' } });
    expect(await tree(dataDir)).toEqual(['db']);
  });
});

describe('dataDirUsage', () => {
  async function threeFiles(): Promise<void> {
    await fsp.mkdir(path.join(dataDir, 'tmp'));
    await fsp.mkdir(path.join(dataDir, 'backups', ULID), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'config.json'), '0123456789');
    await fsp.writeFile(path.join(dataDir, 'tmp', 'op.json'), '0123456789');
    await fsp.writeFile(path.join(dataDir, 'backups', ULID, 'manifest.json'), '0123456789');
  }

  it('adds up the regular files under DATA_DIR', async () => {
    await threeFiles();
    expect(await dataDirUsage(dataDir)).toEqual({ bytes: 30, files: 3, truncated: false });
  });

  it('stops after maxEntries and says so', async () => {
    await threeFiles();
    const usage = await dataDirUsage(dataDir, { maxEntries: 2 });
    expect(usage.truncated).toBe(true);
    expect(usage.files).toBeLessThanOrEqual(2);
  });

  it('stops after maxMs and says so', async () => {
    await threeFiles();
    expect((await dataDirUsage(dataDir, { maxMs: 0 })).truncated).toBe(true);
  });

  it.skipIf(!posix)('does not follow symbolic links', async () => {
    await threeFiles();
    await fsp.writeFile(path.join(root, 'outside'), 'x'.repeat(1000));
    await fsp.symlink(path.join(root, 'outside'), path.join(dataDir, 'tmp', 'link'));
    await fsp.symlink(root, path.join(dataDir, 'tmp', 'dirlink'));
    expect(await dataDirUsage(dataDir)).toEqual({ bytes: 30, files: 3, truncated: false });
  });

  it('is zero for a DATA_DIR that does not exist', async () => {
    expect(await dataDirUsage(path.join(root, 'nothing'))).toEqual({ bytes: 0, files: 0, truncated: false });
  });
});

describe('appendLine and removeStaleTemps (1c Task 18)', () => {
  it('appendLine creates the file (mode 0600) and its folders, and appends one line per call', async () => {
    const p = dataPath(dataDir, 'logs', 'audit-anchor.log');
    await appendLine(p, '{"seq":1}');
    await appendLine(p, '{"seq":2}');
    expect(await fsp.readFile(p, 'utf8')).toBe('{"seq":1}\n{"seq":2}\n');
    if (posix) expect((await fsp.stat(p)).mode & 0o777).toBe(0o600);
  });

  it('appendLine refuses a text with a line break or a NUL, before writing anything', async () => {
    const p = dataPath(dataDir, 'logs', 'audit-anchor.log');
    for (const text of ['a\nb', 'a\rb', 'a\u0000b']) {
      expect(await rejection(appendLine(p, text))).toBeInstanceOf(TypeError);
    }
    expect(await tree(dataDir)).toEqual([]);
  });

  it('appendLine turns a full disk into DISK_QUOTA; the lines before it stay', async () => {
    const p = dataPath(dataDir, 'logs', 'audit-anchor.log');
    await appendLine(p, 'first');
    failWrites('EDQUOT', (file) => file === p);
    expect(await rejection(appendLine(p, 'second'))).toMatchObject({ code: 'DISK_QUOTA', meta: { code: 'EDQUOT' } });
    vi.restoreAllMocks();
    expect(await fsp.readFile(p, 'utf8')).toBe('first\n');
  });

  it('removeStaleTemps removes the hidden temporary siblings older than the age given, and nothing else', async () => {
    const dir = path.join(dataDir, 'backups');
    await fsp.mkdir(path.join(dir, 'blobs'), { recursive: true });
    const now = Date.now();
    const DAY = 86_400_000;
    const at = async (name: string, ageMs: number, kind: 'file' | 'dir' = 'file'): Promise<void> => {
      const file = path.join(dir, name);
      if (kind === 'dir') await fsp.mkdir(file);
      else await fsp.writeFile(file, 'x');
      const t = new Date(now - ageMs);
      await fsp.utimes(file, t, t);
    };
    await at('.manifest.json.tmp-123-0123456789ab', DAY + 1000); // stale: removed
    await at('.snapshot.sqlite.tmp-77-abcdefabcdef-journal', DAY + 1000); // a SQLite side file of one: removed
    await at('.manifest.json.tmp-124-0123456789ac', DAY - 60_000); // fresh: kept
    await at('.keep', 2 * DAY); // not a temporary sibling: kept
    await at('.x.tmp-1-0123456789ab', 2 * DAY, 'dir'); // a folder: kept
    await at(ULID, 2 * DAY, 'dir');
    expect(await removeStaleTemps(dataPath(dataDir, 'backups'), { now, olderThanMs: DAY })).toBe(2);
    expect(await tree(dir)).toEqual(['.keep', '.manifest.json.tmp-124-0123456789ac', '.x.tmp-1-0123456789ab', ULID, 'blobs']);
    // A missing folder holds none.
    expect(await removeStaleTemps(dataPath(dataDir, 'tmp'), { now, olderThanMs: DAY })).toBe(0);
  });

  it('removeStaleTemps with depth: the subfolders down to that many levels too (never through a link)', async () => {
    const now = Date.now();
    const DAY = 86_400_000;
    const stale = async (rel: string): Promise<void> => {
      const file = path.join(dataDir, 'backups', ULID, rel);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, 'x');
      const t = new Date(now - 2 * DAY);
      await fsp.utimes(file, t, t);
    };
    await stale('.manifest.json.tmp-1-0123456789ab'); // depth 0: removed
    await stale('tables/audit_log/.00003.jsonl.gz.tmp-9-abcdefabcdef'); // depth 2: removed
    await stale('tables/audit_log/deeper/.x.tmp-9-abcdefabcdef'); // depth 3: kept
    if (posix) {
      // A link to a folder holding a stale temp is not followed.
      const outside = path.join(root, 'outside');
      await fsp.mkdir(outside);
      await fsp.writeFile(path.join(outside, '.y.tmp-1-0123456789ab'), 'x');
      const t = new Date(now - 2 * DAY);
      await fsp.utimes(path.join(outside, '.y.tmp-1-0123456789ab'), t, t);
      await fsp.symlink(outside, path.join(dataDir, 'backups', ULID, 'tables', 'linked'));
    }
    expect(await removeStaleTemps(dataPath(dataDir, 'backups', ULID), { now, olderThanMs: DAY, depth: 2 })).toBe(2);
    expect((await tree(path.join(dataDir, 'backups', ULID))).filter((n) => n.includes('.tmp-'))).toEqual([
      'tables/audit_log/deeper/.x.tmp-9-abcdefabcdef',
    ]);
    if (posix) expect(await fsp.readdir(path.join(root, 'outside'))).toEqual(['.y.tmp-1-0123456789ab']);
    for (const depth of [-1, 1.5, 17]) {
      expect(await rejection(removeStaleTemps(dataPath(dataDir, 'backups', ULID), { now, olderThanMs: DAY, depth }))).toBeInstanceOf(RangeError);
    }
  });
});
