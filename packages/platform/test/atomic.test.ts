import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DomainError, isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteJson, readJsonWithBak } from '../src/atomic.js';
import { drive, errno } from './support.js';

const identity = (raw: unknown): unknown => raw;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-atomic-'));
  file = path.join(dir, 'current.json');
});

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
/** Makes the code under test believe it runs on `value`. Undone after every test. */
function fakePlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...realPlatform, value });
}

afterEach(async () => {
  Object.defineProperty(process, 'platform', realPlatform);
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fsp.rm(dir, { recursive: true, force: true });
});

const rawOf = (p: string): Promise<string> => fsp.readFile(p, 'utf8');
const listing = (): Promise<string[]> => fsp.readdir(dir).then((names) => names.sort());

describe('atomicWriteJson / readJsonWithBak', () => {
  it('round-trips a value', async () => {
    const value = { schema: 1, active: { version: '1.2.3', source: 'data' }, pending: null, list: [1, 'a', true] };
    await atomicWriteJson(file, value);
    expect(await readJsonWithBak(file, identity)).toEqual(value);
  });

  it('writes pretty JSON with a trailing newline', async () => {
    await atomicWriteJson(file, { a: 1 });
    expect(await rawOf(file)).toBe('{\n  "a": 1\n}\n');
  });

  it('returns null when neither the file nor its .bak exists', async () => {
    expect(await readJsonWithBak(file, identity)).toBeNull();
  });

  it('hands the parsed JSON to parse() and returns its result', async () => {
    await atomicWriteJson(file, { port: 3000 });
    const parse = vi.fn((raw: unknown) => (raw as { port: number }).port + 1);
    expect(await readJsonWithBak(file, parse)).toBe(3001);
    expect(parse).toHaveBeenCalledWith({ port: 3000 });
  });

  it('leaves no temporary files behind', async () => {
    await atomicWriteJson(file, { n: 1 });
    await atomicWriteJson(file, { n: 2 });
    expect(await listing()).toEqual(['current.json', 'current.json.bak']);
  });

  it('refuses a value JSON cannot represent, without touching the file', async () => {
    await atomicWriteJson(file, { n: 1 });
    await expect(atomicWriteJson(file, undefined)).rejects.toThrow(TypeError);
    expect(await listing()).toEqual(['current.json']);
    expect(await readJsonWithBak(file, identity)).toEqual({ n: 1 });
  });

  describe('.bak maintenance', () => {
    it('does not create a .bak for the very first write', async () => {
      await atomicWriteJson(file, { n: 1 });
      expect(fs.existsSync(`${file}.bak`)).toBe(false);
    });

    it('keeps the previous value in .bak after two writes', async () => {
      await atomicWriteJson(file, { n: 1 });
      await atomicWriteJson(file, { n: 2 });
      expect(JSON.parse(await rawOf(file))).toEqual({ n: 2 });
      expect(JSON.parse(await rawOf(`${file}.bak`))).toEqual({ n: 1 });
      await atomicWriteJson(file, { n: 3 });
      expect(JSON.parse(await rawOf(`${file}.bak`))).toEqual({ n: 2 });
    });

    it('does not replace a good .bak with a corrupt main file', async () => {
      await atomicWriteJson(file, { n: 1 });
      await atomicWriteJson(file, { n: 2 });
      await fsp.writeFile(file, 'xyz');
      await atomicWriteJson(file, { n: 3 });
      expect(JSON.parse(await rawOf(`${file}.bak`))).toEqual({ n: 1 });
      expect(await readJsonWithBak(file, identity)).toEqual({ n: 3 });
    });
  });

  describe('recovery', () => {
    it('returns the .bak value when the main file is truncated', async () => {
      await atomicWriteJson(file, { n: 1 });
      await atomicWriteJson(file, { n: 2 });
      await fsp.writeFile(file, 'xyz'); // 3 garbage bytes, as after a power cut
      expect(await readJsonWithBak(file, identity)).toEqual({ n: 1 });
    });

    it('returns the .bak value when the main file is empty', async () => {
      await atomicWriteJson(file, { n: 1 });
      await atomicWriteJson(file, { n: 2 });
      await fsp.writeFile(file, '');
      expect(await readJsonWithBak(file, identity)).toEqual({ n: 1 });
    });

    it('returns the .bak value when parse() rejects the main file', async () => {
      await atomicWriteJson(file, { schema: 1 });
      await atomicWriteJson(file, { schema: 'broken' });
      const parse = (raw: unknown): number => {
        const { schema } = raw as { schema: unknown };
        if (typeof schema !== 'number') throw new Error('schema must be a number');
        return schema;
      };
      expect(await readJsonWithBak(file, parse)).toBe(1);
    });

    it('returns the .bak value when the main file is missing', async () => {
      await atomicWriteJson(file, { n: 1 });
      await atomicWriteJson(file, { n: 2 });
      await fsp.rm(file);
      expect(await readJsonWithBak(file, identity)).toEqual({ n: 1 });
    });

    it('reads a main file that starts with a byte-order mark (hand-edited on Windows)', async () => {
      await fsp.writeFile(file, '﻿{"n":1}');
      expect(await readJsonWithBak(file, identity)).toEqual({ n: 1 });
    });

    const expectStateCorrupt = async (p: Promise<unknown>): Promise<DomainError> => {
      const error = await p.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isDomainError(error)).toBe(true);
      const domain = error as DomainError;
      expect(domain.code).toBe('STATE_CORRUPT');
      expect(domain.meta).toMatchObject({ reason: 'state_unreadable', path: file });
      expect(domain.message).toContain(file);
      return domain;
    };

    it('throws STATE_CORRUPT when the main file and the .bak are both corrupt', async () => {
      await atomicWriteJson(file, { n: 1 });
      await atomicWriteJson(file, { n: 2 });
      await fsp.writeFile(file, 'xyz');
      await fsp.writeFile(`${file}.bak`, '{"n":');
      await expectStateCorrupt(readJsonWithBak(file, identity));
    });

    it('throws STATE_CORRUPT when both parse as JSON but parse() rejects both', async () => {
      await atomicWriteJson(file, { n: 1 });
      await atomicWriteJson(file, { n: 2 });
      await expectStateCorrupt(
        readJsonWithBak(file, () => {
          throw new Error('never valid');
        }),
      );
    });

    it('throws STATE_CORRUPT when the main file is corrupt and there is no .bak', async () => {
      await fsp.writeFile(file, 'xyz');
      await expectStateCorrupt(readJsonWithBak(file, identity));
    });

    it('throws STATE_CORRUPT when only a corrupt .bak exists', async () => {
      await fsp.writeFile(`${file}.bak`, 'xyz');
      await expectStateCorrupt(readJsonWithBak(file, identity));
    });

    it('does not mistake an unreadable file for a missing one', async () => {
      await fsp.mkdir(file); // reading a directory fails with EISDIR, not ENOENT
      await expect(readJsonWithBak(file, identity)).rejects.toMatchObject({ code: 'EISDIR' });
    });
  });

  describe('rename retry', () => {
    it('retries EPERM twice (50 ms, then 100 ms) and then succeeds', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
      const times: number[] = [];
      const real = fsp.rename.bind(fsp);
      const spy = vi.spyOn(fsp, 'rename').mockImplementation((from, to) => {
        times.push(performance.now());
        return times.length <= 2 ? Promise.reject(errno('EPERM')) : real(from, to);
      });
      const write = atomicWriteJson(file, { n: 1 });
      await drive(write);
      await write;
      expect(spy).toHaveBeenCalledTimes(3);
      expect(times[1]! - times[0]!).toBe(50);
      expect(times[2]! - times[1]!).toBe(100);
      expect(await readJsonWithBak(file, identity)).toEqual({ n: 1 });
      expect(await listing()).toEqual(['current.json']);
    });

    it('retries EBUSY too, also while renaming the .bak', async () => {
      await atomicWriteJson(file, { n: 1 });
      let failures = 2;
      const real = fsp.rename.bind(fsp);
      const spy = vi.spyOn(fsp, 'rename').mockImplementation((from, to) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(errno('EBUSY'));
        }
        return real(from, to);
      });
      await atomicWriteJson(file, { n: 2 });
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4); // 2 failures, .bak, main
      expect(JSON.parse(await rawOf(file))).toEqual({ n: 2 });
      expect(JSON.parse(await rawOf(`${file}.bak`))).toEqual({ n: 1 });
      expect(await listing()).toEqual(['current.json', 'current.json.bak']);
    });

    it('gives up with the original error after about 10 s of EPERM, backing off from 50 ms to 1 s', async () => {
      await atomicWriteJson(file, { n: 1 });
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
      const times: number[] = [];
      vi.spyOn(fsp, 'rename').mockImplementation(() => {
        times.push(performance.now());
        return Promise.reject(errno('EPERM'));
      });
      const write = atomicWriteJson(file, { n: 2 });
      const outcome = write.then(
        () => undefined,
        (e: unknown) => e,
      );
      await drive(write);
      expect(await outcome).toMatchObject({ code: 'EPERM' });

      const gaps = times.slice(1).map((t, i) => t - times[i]!);
      expect(gaps.slice(0, 6)).toEqual([50, 100, 200, 400, 800, 1000]);
      expect(Math.max(...gaps)).toBe(1000);
      const elapsed = times.at(-1)! - times[0]!;
      expect(elapsed).toBeGreaterThanOrEqual(9000);
      expect(elapsed).toBeLessThanOrEqual(10_000);

      vi.useRealTimers();
      vi.restoreAllMocks();
      expect(await listing()).toEqual(['current.json']); // temp files removed, main untouched
      expect(await readJsonWithBak(file, identity)).toEqual({ n: 1 });
    });

    it('spends one 10 s budget on the .bak and the main rename together', async () => {
      await atomicWriteJson(file, { n: 1 });
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
      const real = fsp.rename.bind(fsp);
      const times: number[] = [];
      let bakFailures = 5; // 50 + 100 + 200 + 400 + 800 ms = 1.55 s of retrying before the .bak is in place
      vi.spyOn(fsp, 'rename').mockImplementation((from, to) => {
        times.push(performance.now());
        if (String(to).endsWith('.bak')) {
          if (bakFailures > 0) {
            bakFailures -= 1;
            return Promise.reject(errno('EPERM'));
          }
          return real(from, to);
        }
        return Promise.reject(errno('EPERM')); // the main file never gets through
      });
      const write = atomicWriteJson(file, { n: 2 });
      const outcome = write.then(
        () => undefined,
        (e: unknown) => e,
      );
      await drive(write);
      expect(await outcome).toMatchObject({ code: 'EPERM' });
      // Counted from the first rename attempt. With a fresh budget for the main rename it would be 11.5 s.
      const elapsed = times.at(-1)! - times[0]!;
      expect(elapsed).toBeGreaterThanOrEqual(9000);
      expect(elapsed).toBeLessThanOrEqual(10_000);
    });

    it('retries EACCES on Windows (an antivirus scanner or the indexer holding the file), then succeeds', async () => {
      await atomicWriteJson(file, { n: 1 });
      fakePlatform('win32');
      let failures = 2;
      const real = fsp.rename.bind(fsp);
      const spy = vi.spyOn(fsp, 'rename').mockImplementation((from, to) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(errno('EACCES'));
        }
        return real(from, to);
      });
      await atomicWriteJson(file, { n: 2 });
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4); // 2 failures, .bak, main
      expect(JSON.parse(await rawOf(file))).toEqual({ n: 2 });
      expect(JSON.parse(await rawOf(`${file}.bak`))).toEqual({ n: 1 });
      expect(await listing()).toEqual(['current.json', 'current.json.bak']);
    });

    it('does not retry EACCES on other platforms (a real permission problem)', async () => {
      await atomicWriteJson(file, { n: 1 });
      fakePlatform('linux');
      const spy = vi.spyOn(fsp, 'rename').mockRejectedValue(errno('EACCES'));
      await expect(atomicWriteJson(file, { n: 2 })).rejects.toMatchObject({ code: 'EACCES' });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not retry other errors and cleans up its temporary files', async () => {
      await atomicWriteJson(file, { n: 1 });
      fakePlatform('linux');
      const spy = vi.spyOn(fsp, 'rename').mockRejectedValue(errno('EACCES'));
      await expect(atomicWriteJson(file, { n: 2 })).rejects.toMatchObject({ code: 'EACCES' });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      expect(await listing()).toEqual(['current.json']);
      expect(await readJsonWithBak(file, identity)).toEqual({ n: 1 });
    });
  });

  describe('durability and permissions', () => {
    it.skipIf(process.platform === 'win32')('fsyncs the temporary file, then the directory', async () => {
      const handle = await fsp.open(file, 'w');
      const proto = Object.getPrototypeOf(handle) as { sync: () => Promise<void> };
      await handle.close();
      await fsp.rm(file);
      const calls: string[] = [];
      const realSync = proto.sync;
      vi.spyOn(proto, 'sync').mockImplementation(function (this: { fd: number }) {
        calls.push(fs.fstatSync(this.fd).isDirectory() ? 'dir' : 'file');
        return realSync.call(this);
      });
      const renamed: number[] = [];
      const realRename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, 'rename').mockImplementation((from, to) => {
        renamed.push(calls.length);
        return realRename(from, to);
      });
      await atomicWriteJson(file, { n: 1 });
      expect(calls).toEqual(['file', 'dir']);
      expect(renamed).toEqual([1]); // the file was synced before it was renamed over the main file
    });

    it.skipIf(process.platform === 'win32')('writes the file and its .bak with mode 0600 by default', async () => {
      await atomicWriteJson(file, { n: 1 });
      await atomicWriteJson(file, { n: 2 });
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fsp.stat(`${file}.bak`)).mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === 'win32')('honours opts.mode (subject to the umask)', async () => {
      const previous = process.umask(0o022);
      try {
        await atomicWriteJson(file, { n: 1 }, { mode: 0o644 });
        await atomicWriteJson(file, { n: 2 }, { mode: 0o644 });
      } finally {
        process.umask(previous);
      }
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o644);
      expect((await fsp.stat(`${file}.bak`)).mode & 0o777).toBe(0o644);
    });
  });
});
