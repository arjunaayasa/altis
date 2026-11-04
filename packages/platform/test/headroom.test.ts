import fsp, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureHeadroom } from '../src/headroom.js';
import { errno } from './support.js';

const MIB = 1024 * 1024;

// The probe cache lives in the module, so every test uses a directory of its own.
let dataDir: string;
let tmpDir: string;

beforeEach(async () => {
  dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-headroom-')));
  tmpDir = path.join(dataDir, 'tmp');
  await fsp.mkdir(tmpDir);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const listing = (): Promise<string[]> => fsp.readdir(tmpDir);

/** The real `fsp.open`, with `patch` applied to every handle it returns. */
function patchHandles(patch: (handle: FileHandle) => void) {
  const realOpen = fsp.open.bind(fsp);
  return vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
    const handle = await realOpen(...args);
    patch(handle);
    return handle;
  });
}

interface Fake {
  written: number;
  chunks: number[];
  opened: string[];
  syncs: number;
  closes: number;
}

interface FakeOptions {
  /** A write moves at most this many bytes (a short write). */
  chunkLimit?: number;
  /** The write that would take the total past this many bytes fails with EDQUOT. */
  failAfter?: number;
}

/** Replaces `fsp.open` with a handle that only counts what is written, so that big sizes cost no I/O. */
function fakeDisk(options: FakeOptions = {}): Fake {
  const { chunkLimit = Infinity, failAfter = Infinity } = options;
  const fake: Fake = { written: 0, chunks: [], opened: [], syncs: 0, closes: 0 };
  vi.spyOn(fsp, 'open').mockImplementation((async (file: string) => {
    fake.opened.push(String(file));
    return {
      write: async (_buffer: Uint8Array, _offset: number, length: number) => {
        const bytesWritten = Math.min(length, chunkLimit);
        if (fake.written + bytesWritten > failAfter) throw errno('EDQUOT');
        fake.chunks.push(length);
        fake.written += bytesWritten;
        return { bytesWritten };
      },
      sync: async () => {
        fake.syncs += 1;
      },
      close: async () => {
        fake.closes += 1;
      },
    };
  }) as unknown as typeof fsp.open);
  return fake;
}

/** A promise that is settled from outside. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('ensureHeadroom', () => {
  it('succeeds for 1 MB and leaves no temporary file', async () => {
    await expect(ensureHeadroom(dataDir, MIB)).resolves.toBeUndefined();
    expect(await listing()).toEqual([]);
  });

  it('writes its probe as tmp/headroom-<random> with mode 0600, exclusively, then fsyncs and removes it', async () => {
    const open = patchHandles(() => undefined);
    await ensureHeadroom(dataDir, MIB);
    expect(open).toHaveBeenCalledTimes(1);
    const [file, flags, mode] = open.mock.calls[0] as [string, string, number];
    expect(path.dirname(file)).toBe(tmpDir);
    expect(path.basename(file)).toMatch(/^headroom-[0-9a-f]{16}$/);
    expect(flags).toBe('wx');
    expect(mode).toBe(0o600);
    expect(await listing()).toEqual([]);
  });

  it('fsyncs before it closes', async () => {
    const order: string[] = [];
    patchHandles((handle) => {
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      handle.sync = async () => {
        order.push('sync');
        await sync();
      };
      handle.close = async () => {
        order.push('close');
        await close();
      };
    });
    await ensureHeadroom(dataDir, MIB);
    expect(order).toEqual(['sync', 'close']);
  });

  it('creates tmp when it does not exist yet, but not DATA_DIR itself', async () => {
    await fsp.rm(tmpDir, { recursive: true });
    await ensureHeadroom(dataDir, MIB);
    expect(await listing()).toEqual([]);

    const missing = path.join(dataDir, 'not', 'there');
    await expect(ensureHeadroom(missing, MIB)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['EDQUOT', 'ENOSPC'])('turns %s from a write into DISK_QUOTA and leaves no file', async (code) => {
    patchHandles((handle) => {
      handle.write = (async () => {
        throw errno(code);
      }) as unknown as FileHandle['write'];
    });
    const error = await ensureHeadroom(dataDir, MIB).catch((e: unknown) => e);
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'DISK_QUOTA',
      status: 507,
      meta: { reason: 'headroom', code, requested: MIB, probed: MIB },
    });
    // bilingual detail that says how much room was needed
    expect((error as { detail: string }).detail).toContain(' / ');
    expect((error as { cause?: unknown }).cause).toMatchObject({ code });
    expect(await listing()).toEqual([]);
  });

  it('turns EDQUOT raised by fsync (NFS reports it late) into DISK_QUOTA and leaves no file', async () => {
    patchHandles((handle) => {
      handle.sync = (async () => {
        throw errno('EDQUOT');
      }) as unknown as FileHandle['sync'];
    });
    await expect(ensureHeadroom(dataDir, MIB)).rejects.toMatchObject({ code: 'DISK_QUOTA' });
    expect(await listing()).toEqual([]);
  });

  it('turns EDQUOT raised while creating the probe file into DISK_QUOTA', async () => {
    vi.spyOn(fsp, 'open').mockRejectedValue(errno('EDQUOT'));
    await expect(ensureHeadroom(dataDir, MIB)).rejects.toMatchObject({ code: 'DISK_QUOTA' });
  });

  it('lets other I/O errors through untouched, still cleaning up', async () => {
    patchHandles((handle) => {
      handle.write = (async () => {
        throw errno('EIO');
      }) as unknown as FileHandle['write'];
    });
    await expect(ensureHeadroom(dataDir, MIB)).rejects.toMatchObject({ code: 'EIO' });
    expect(await listing()).toEqual([]);
  });

  it('writes zeros', async () => {
    let seen = Buffer.alloc(0);
    patchHandles((handle) => {
      const write = handle.write.bind(handle) as (b: Uint8Array, o: number, l: number) => Promise<{ bytesWritten: number }>;
      handle.write = (async (buffer: Uint8Array, offset: number, length: number) => {
        if (seen.length === 0) seen = Buffer.from(buffer.subarray(offset, offset + length));
        return write(buffer, offset, length);
      }) as unknown as FileHandle['write'];
    });
    await ensureHeadroom(dataDir, MIB);
    expect(seen.length).toBe(MIB);
    expect(seen.every((byte) => byte === 0)).toBe(true);
  });

  describe('size (R10)', () => {
    it('writes exactly the bytes asked for, in 1 MiB chunks, the last one short', async () => {
      const fake = fakeDisk();
      await ensureHeadroom(dataDir, 2.5 * MIB);
      expect(fake.chunks).toEqual([MIB, MIB, 0.5 * MIB]);
      expect(fake.written).toBe(2.5 * MIB);
    });

    it('never rounds up: 1 byte writes 1 byte, 64 MiB + 1 byte writes 64 MiB', async () => {
      const small = fakeDisk();
      await ensureHeadroom(dataDir, 1);
      expect(small.written).toBe(1);

      const big = fakeDisk();
      await ensureHeadroom(dataDir, 64 * MIB + 1); // bigger than what is proven, so it probes
      expect(big.written).toBe(64 * MIB);
    });

    it('rounds a fractional byte count up to the next whole byte', async () => {
      const fake = fakeDisk();
      await ensureHeadroom(dataDir, 1.5);
      expect(fake.written).toBe(2);
    });

    it('writes exactly 64 MiB for a request of 64 MiB', async () => {
      const fake = fakeDisk();
      await ensureHeadroom(dataDir, 64 * MIB);
      expect(fake.written).toBe(64 * MIB);
      expect(fake.chunks).toHaveLength(64);
    });

    it('never writes more than 64 MiB, however much is asked for', async () => {
      const fake = fakeDisk();
      await ensureHeadroom(dataDir, 50 * 1024 * MIB);
      expect(fake.written).toBe(64 * MIB);
    });

    it('relies on the ENOSPC/EDQUOT abort path for a request above 64 MiB: the write that fails aborts the probe', async () => {
      const fake = fakeDisk({ failAfter: 10 * MIB });
      const error = await ensureHeadroom(dataDir, 200 * MIB).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: 'DISK_QUOTA',
        meta: { code: 'EDQUOT', requested: 200 * MIB, probed: 64 * MIB },
      });
      // both sizes are in the operator's message
      expect((error as { detail: string }).detail).toContain('200');
      expect((error as { detail: string }).detail).toContain('64');
      expect(fake.written).toBe(10 * MIB);
      expect(await listing()).toEqual([]);
    });

    it('keeps writing when a write is short', async () => {
      const fake = fakeDisk({ chunkLimit: 300 * 1024 });
      await ensureHeadroom(dataDir, MIB);
      expect(fake.written).toBe(MIB);
      expect(fake.syncs).toBe(1);
      expect(fake.closes).toBe(1);
    });

    it('stops when a write makes no progress instead of spinning', async () => {
      fakeDisk({ chunkLimit: 0 });
      await expect(ensureHeadroom(dataDir, MIB)).rejects.toThrow();
    });

    it('does nothing for 0 bytes', async () => {
      const open = patchHandles(() => undefined);
      await ensureHeadroom(dataDir, 0);
      expect(open).not.toHaveBeenCalled();
    });

    it.each([-1, NaN, Infinity, -Infinity])('refuses %s bytes', async (bytes) => {
      await expect(ensureHeadroom(dataDir, bytes)).rejects.toThrow(RangeError);
    });
  });

  describe('cache (R10)', () => {
    it('does not probe again within 10 minutes', async () => {
      vi.useFakeTimers({ toFake: ['performance'] });
      const open = patchHandles(() => undefined);
      await ensureHeadroom(dataDir, MIB);
      vi.advanceTimersByTime(10 * 60 * 1000 - 1);
      await ensureHeadroom(dataDir, MIB);
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('probes again after 10 minutes', async () => {
      vi.useFakeTimers({ toFake: ['performance'] });
      const open = patchHandles(() => undefined);
      await ensureHeadroom(dataDir, MIB);
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      await ensureHeadroom(dataDir, MIB);
      expect(open).toHaveBeenCalledTimes(2);
    });

    it('a 1 MiB request after a 64 MiB probe is a cache hit', async () => {
      const fake = fakeDisk();
      await ensureHeadroom(dataDir, 64 * MIB);
      await ensureHeadroom(dataDir, MIB);
      await ensureHeadroom(dataDir, 63 * MIB + 1);
      expect(fake.opened).toHaveLength(1);
    });

    it('a request above 64 MiB is a hit once 64 MiB is proven', async () => {
      const fake = fakeDisk();
      await ensureHeadroom(dataDir, 64 * MIB);
      await ensureHeadroom(dataDir, 5000 * MIB);
      expect(fake.opened).toHaveLength(1);
    });

    it('a bigger request than the proven size probes again, and the proven size becomes that one', async () => {
      const fake = fakeDisk();
      await ensureHeadroom(dataDir, MIB);
      await ensureHeadroom(dataDir, 2 * MIB);
      expect(fake.opened).toHaveLength(2);
      expect(fake.written).toBe(3 * MIB);
      await ensureHeadroom(dataDir, MIB);
      await ensureHeadroom(dataDir, 2 * MIB);
      expect(fake.opened).toHaveLength(2);
      await ensureHeadroom(dataDir, 2 * MIB + 1);
      expect(fake.opened).toHaveLength(3);
    });

    it('keeps the proven size at the maximum when a smaller probe finishes last', async () => {
      const release = gate();
      let opened = 0;
      vi.spyOn(fsp, 'open').mockImplementation((async () => {
        opened += 1;
        let written = 0;
        return {
          write: async (_b: Uint8Array, _o: number, length: number) => {
            written += length;
            return { bytesWritten: length };
          },
          sync: async () => {
            if (written === MIB) await release.promise; // the 1 MiB probe is the slow one
          },
          close: async () => undefined,
        };
      }) as unknown as typeof fsp.open);

      const small = ensureHeadroom(dataDir, MIB);
      const large = ensureHeadroom(dataDir, 2 * MIB); // the small one cannot vouch for this, so it probes on its own
      await large;
      release.open();
      await small;
      expect(opened).toBe(2);
      await ensureHeadroom(dataDir, 2 * MIB); // still proven: the late, smaller result did not lower it
      expect(opened).toBe(2);
    });

    it('has one entry per real directory: a symlink to the same directory shares it', async () => {
      const link = `${dataDir}-link`;
      await fsp.symlink(dataDir, link);
      try {
        const fake = fakeDisk();
        await ensureHeadroom(dataDir, MIB);
        await ensureHeadroom(link, MIB);
        expect(fake.opened).toHaveLength(1);
      } finally {
        await fsp.rm(link, { force: true });
      }
    });

    it('probes separately for another directory', async () => {
      const fake = fakeDisk();
      await ensureHeadroom(dataDir, MIB);
      const other = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-headroom-other-'));
      try {
        await fsp.mkdir(path.join(other, 'tmp'));
        await ensureHeadroom(other, MIB);
        expect(fake.opened).toHaveLength(2);
      } finally {
        await fsp.rm(other, { recursive: true, force: true });
      }
    });

    it('does not cache a failure', async () => {
      let failing = true;
      patchHandles((handle) => {
        if (!failing) return;
        handle.write = (async () => {
          throw errno('EDQUOT');
        }) as unknown as FileHandle['write'];
      });
      await expect(ensureHeadroom(dataDir, MIB)).rejects.toMatchObject({ code: 'DISK_QUOTA' });
      failing = false;
      await expect(ensureHeadroom(dataDir, MIB)).resolves.toBeUndefined();
    });

    it('a failure does not discard what an earlier probe proved', async () => {
      const fake = fakeDisk({ failAfter: MIB });
      await ensureHeadroom(dataDir, MIB);
      await expect(ensureHeadroom(dataDir, 2 * MIB)).rejects.toMatchObject({ code: 'DISK_QUOTA' });
      await ensureHeadroom(dataDir, MIB);
      expect(fake.opened).toHaveLength(2); // the third call was a hit
    });

    it('fresh: probes again although the cache would answer (a re-check while writing, S10), and still shares a probe in flight', async () => {
      const fake = fakeDisk();
      await ensureHeadroom(dataDir, 64 * MIB);
      await ensureHeadroom(dataDir, 64 * MIB, { fresh: true });
      await ensureHeadroom(dataDir, MIB, { fresh: true });
      expect(fake.opened).toHaveLength(3);
      expect(fake.written).toBe(129 * MIB);
      await ensureHeadroom(dataDir, MIB); // the cache still answers a caller that does not ask for a fresh probe
      expect(fake.opened).toHaveLength(3);
      await Promise.all([ensureHeadroom(dataDir, 2 * MIB, { fresh: true }), ensureHeadroom(dataDir, MIB, { fresh: true })]);
      expect(fake.opened).toHaveLength(4);
    });

    it('a concurrent caller waits on an in-flight probe that is at least as big as its request', async () => {
      const fake = fakeDisk();
      await Promise.all([ensureHeadroom(dataDir, 2 * MIB), ensureHeadroom(dataDir, MIB), ensureHeadroom(dataDir, 2 * MIB)]);
      expect(fake.opened).toHaveLength(1);
    });

    it('a concurrent caller does not rely on a smaller in-flight probe', async () => {
      const fake = fakeDisk();
      await Promise.all([ensureHeadroom(dataDir, MIB), ensureHeadroom(dataDir, 2 * MIB)]);
      expect(fake.opened).toHaveLength(2);
    });

    it('hands a failed shared probe to every waiter, each with its own requested size, and the next call probes afresh', async () => {
      let failing = true;
      const realOpen = fsp.open.bind(fsp);
      const open = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        const handle = await realOpen(...args);
        if (failing) {
          handle.write = (async () => {
            throw errno('ENOSPC');
          }) as unknown as FileHandle['write'];
        }
        return handle;
      });
      const results = await Promise.allSettled([ensureHeadroom(dataDir, 2 * MIB), ensureHeadroom(dataDir, MIB)]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      const metas = results.map((r) => (r as PromiseRejectedResult).reason.meta);
      expect(metas).toEqual([
        expect.objectContaining({ requested: 2 * MIB, probed: 2 * MIB }),
        expect.objectContaining({ requested: MIB, probed: 2 * MIB }),
      ]);
      expect(open).toHaveBeenCalledTimes(1);
      failing = false;
      await expect(ensureHeadroom(dataDir, MIB)).resolves.toBeUndefined();
      expect(open).toHaveBeenCalledTimes(2);
    });
  });

  describe('leftovers of a killed probe', () => {
    const old = async (name: string, ageMs: number): Promise<string> => {
      const file = path.join(tmpDir, name);
      await fsp.writeFile(file, 'x');
      const past = new Date(Date.now() - ageMs);
      await fsp.utimes(file, past, past);
      return file;
    };

    it('removes headroom-* files older than an hour and nothing else', async () => {
      await old('headroom-0123456789abcdef', 2 * 3600 * 1000);
      const fresh = await old('headroom-fedcba9876543210', 60 * 1000);
      const other = await old('headroom-notahexname', 2 * 3600 * 1000);
      const unrelated = await old('upload-1.part', 2 * 3600 * 1000);
      await ensureHeadroom(dataDir, MIB);
      expect((await listing()).sort()).toEqual(
        [fresh, other, unrelated].map((file) => path.basename(file)).sort(),
      );
    });

    it('does not let a failing sweep break the probe', async () => {
      await old('headroom-0123456789abcdef', 2 * 3600 * 1000);
      const realRm = fsp.rm.bind(fsp);
      vi.spyOn(fsp, 'rm').mockImplementation(async (file, options) => {
        if (String(file).endsWith('0123456789abcdef')) throw errno('EACCES');
        return realRm(file, options);
      });
      await expect(ensureHeadroom(dataDir, MIB)).resolves.toBeUndefined();
    });
  });
});
