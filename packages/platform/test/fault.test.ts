import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileTo, withTempSibling, writeBytesAtomic, writeExclusive, writeStreamAtomic } from '../src/data-files.js';
import { dataPath } from '../src/datapath.js';
import { faultArmed, faultMatchesVersion, killSelf, resetTestFaults, type TestFault } from '../src/fault.js';

// Test faults (decision C27, S13): ALTIS_TEST_FAULT=<name>[:<arg>], only in the test profile (R57).

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-fault-')));
  dataDir = path.join(root, 'altis-data');
  await fsp.mkdir(dataDir);
  resetTestFaults();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetTestFaults();
  await fsp.rm(root, { recursive: true, force: true });
});

const ULID = '01JBX5ZK3M8Q4R7T9V0W2Y6A1C';

describe('faultArmed', () => {
  it('returns the text after <name>: in ALTIS_TEST_FAULT', () => {
    expect(faultArmed({ ALTIS_TEST_FAULT: 'restore-mid-load:3:replay' }, 'restore-mid-load')).toBe('3:replay');
    expect(faultArmed({ ALTIS_TEST_FAULT: 'restore-mid-load:3' }, 'restore-mid-load')).toBe('3');
    expect(faultArmed({ ALTIS_TEST_FAULT: 'kill-mid-slice:k-7' }, 'kill-mid-slice')).toBe('k-7');
    expect(faultArmed({ ALTIS_TEST_FAULT: 'export-mid-part:2' }, 'export-mid-part')).toBe('2');
    expect(faultArmed({ ALTIS_TEST_FAULT: 'disk-full:tmp:2' }, 'disk-full')).toBe('tmp:2');
  });

  it("returns '' for the bare name", () => {
    expect(faultArmed({ ALTIS_TEST_FAULT: 'kill-mid-slice' }, 'kill-mid-slice')).toBe('');
  });

  it('returns null for another name, a name that only shares a prefix, or no fault at all', () => {
    const names: TestFault[] = ['kill-mid-slice', 'disk-full', 'export-mid-part'];
    for (const name of names) expect(faultArmed({ ALTIS_TEST_FAULT: 'restore-mid-load:3:replay' }, name)).toBeNull();
    expect(faultArmed({ ALTIS_TEST_FAULT: 'disk-fullish:tmp:2' }, 'disk-full')).toBeNull();
    expect(faultArmed({ ALTIS_TEST_FAULT: 'xdisk-full:tmp:2' }, 'disk-full')).toBeNull();
    expect(faultArmed({ ALTIS_TEST_FAULT: '' }, 'disk-full')).toBeNull();
    expect(faultArmed({}, 'disk-full')).toBeNull();
  });

  it('is always null outside the test profile (R57)', () => {
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    expect(faultArmed({ ALTIS_TEST_FAULT: 'restore-mid-load:3:replay' }, 'restore-mid-load')).toBeNull();
    expect(faultArmed({ ALTIS_TEST_FAULT: 'kill-mid-slice' }, 'kill-mid-slice')).toBeNull();
  });

  it('counts an undefined __BUILD_PROFILE__ as production', () => {
    vi.stubGlobal('__BUILD_PROFILE__', undefined);
    expect(faultArmed({ ALTIS_TEST_FAULT: 'kill-mid-slice' }, 'kill-mid-slice')).toBeNull();
  });
});

// 1d Task 2 (spec §12.5, D1d-25): the update faults.
describe('update faults (1d)', () => {
  it.each([
    ['migrate:9001_test_expand', 'migrate', '9001_test_expand'],
    ['migrate-slow:160', 'migrate-slow', '160'],
    ['migrate-ddl:2', 'migrate-ddl', '2'],
    ['health:0.3.0-test', 'health', '0.3.0-test'],
    ['boot-crash:0.2.0-test', 'boot-crash', '0.2.0-test'],
    ['boot-crash', 'boot-crash', ''],
    ['download-corrupt', 'download-corrupt', ''],
    ['download-corrupt:1024', 'download-corrupt', '1024'],
  ] as const)('%s arms %s with the argument %j', (value, name, arg) => {
    expect(faultArmed({ ALTIS_TEST_FAULT: value }, name)).toBe(arg);
  });

  it('keeps names that share a prefix apart (migrate, migrate-slow, migrate-ddl)', () => {
    expect(faultArmed({ ALTIS_TEST_FAULT: 'migrate-slow:160' }, 'migrate')).toBeNull();
    expect(faultArmed({ ALTIS_TEST_FAULT: 'migrate-ddl:2' }, 'migrate')).toBeNull();
    expect(faultArmed({ ALTIS_TEST_FAULT: 'migrate:9001_test_expand' }, 'migrate-slow')).toBeNull();
    expect(faultArmed({ ALTIS_TEST_FAULT: 'health:0.3.0-test' }, 'boot-crash')).toBeNull();
  });

  describe('faultMatchesVersion', () => {
    it('is true only for the version the fault names', () => {
      const env = { ALTIS_TEST_FAULT: 'health:0.3.0-test' };
      expect(faultMatchesVersion(env, 'health', '0.3.0-test')).toBe(true);
      expect(faultMatchesVersion(env, 'health', '0.2.0-test')).toBe(false);
      expect(faultMatchesVersion(env, 'boot-crash', '0.3.0-test')).toBe(false);
    });

    it('is true for any version when the fault names none', () => {
      const env = { ALTIS_TEST_FAULT: 'boot-crash' };
      for (const version of ['0.1.0-test', '0.2.0-test', '1.0.0']) expect(faultMatchesVersion(env, 'boot-crash', version)).toBe(true);
      expect(faultMatchesVersion(env, 'health', '0.2.0-test')).toBe(false);
    });

    it('is false when no fault or another fault is armed', () => {
      expect(faultMatchesVersion({}, 'health', '0.2.0-test')).toBe(false);
      expect(faultMatchesVersion({ ALTIS_TEST_FAULT: 'migrate:9001_test_expand' }, 'health', '0.2.0-test')).toBe(false);
      expect(faultMatchesVersion({ ALTIS_TEST_FAULT: 'healthy:0.2.0-test' }, 'health', '0.2.0-test')).toBe(false);
    });

    it('is always false outside the test profile (R57)', () => {
      vi.stubGlobal('__BUILD_PROFILE__', 'production');
      expect(faultMatchesVersion({ ALTIS_TEST_FAULT: 'health:0.3.0-test' }, 'health', '0.3.0-test')).toBe(false);
      expect(faultMatchesVersion({ ALTIS_TEST_FAULT: 'boot-crash' }, 'boot-crash', '0.2.0-test')).toBe(false);
      const update: TestFault[] = ['migrate', 'migrate-slow', 'migrate-ddl', 'health', 'boot-crash', 'download-corrupt'];
      for (const name of update) expect(faultArmed({ ALTIS_TEST_FAULT: `${name}:1` }, name)).toBeNull();
    });
  });
});

describe('killSelf', () => {
  it('sends SIGKILL to this very process (as 1a install fault does) and never returns', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(() => killSelf()).toThrow();
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');
  });
});

describe('disk-full:<area>:<n> (S13)', () => {
  it('makes the n-th data-files write under that area throw DISK_QUOTA, and only that one', async () => {
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:tmp:2');
    await fsp.mkdir(path.join(dataDir, 'tmp'));
    const first = dataPath(dataDir, 'tmp', 'op.json');
    const second = dataPath(dataDir, 'tmp', 'report.json');
    const third = dataPath(dataDir, 'tmp', 'prepared.json');
    await writeBytesAtomic(first, 'one');
    const error = await writeBytesAtomic(second, 'two').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'DISK_QUOTA', meta: { code: 'EDQUOT' } });
    await writeBytesAtomic(third, 'three');
    expect(await fsp.readFile(first, 'utf8')).toBe('one');
    expect(await fsp.readFile(third, 'utf8')).toBe('three');
    expect((await fsp.readdir(path.join(dataDir, 'tmp'))).sort()).toEqual(['op.json', 'prepared.json']); // nothing partial
  });

  it('fails copyFileTo, withTempSibling and writeStreamAtomic after their temp file exists, and removes it', async () => {
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:backups:1');
    await fsp.mkdir(path.join(dataDir, 'tmp'));
    const from = dataPath(dataDir, 'tmp', 'upload.bin');
    await writeBytesAtomic(from, 'blob'); // tmp/: not counted
    const blob = dataPath(dataDir, 'backups', 'blobs', 'a'.repeat(64));
    await expect(copyFileTo(from, blob)).rejects.toMatchObject({ code: 'DISK_QUOTA', meta: { code: 'EDQUOT' } });
    resetTestFaults();
    const copy = dataPath(dataDir, 'backups', ULID, 'snapshot.sqlite');
    await expect(withTempSibling(copy, (tmp) => fsp.writeFile(tmp, 'sqlite'))).rejects.toMatchObject({ code: 'DISK_QUOTA' });
    resetTestFaults();
    const part = dataPath(dataDir, 'backups', ULID, 'manifest.json');
    async function* source(): AsyncIterable<Uint8Array> {
      yield Buffer.from('{}');
    }
    await expect(writeStreamAtomic(part, source())).rejects.toMatchObject({ code: 'DISK_QUOTA' });
    expect(await fsp.readdir(path.join(dataDir, 'backups'))).toEqual([]); // no temp file, no folder below the area
    expect(await fsp.readFile(from, 'utf8')).toBe('blob');
  });

  it('counts only writes under the named area', async () => {
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:tmp:1');
    await fsp.mkdir(path.join(dataDir, 'ops'));
    await fsp.mkdir(path.join(dataDir, 'tmp'));
    expect(await writeExclusive(dataPath(dataDir, 'ops', 'op.json'), '{}')).toBe(true);
    await writeBytesAtomic(dataPath(dataDir, 'ops', ULID, 'op.json'), '{}');
    await expect(writeBytesAtomic(dataPath(dataDir, 'tmp', 'op.json'), '{}')).rejects.toMatchObject({ code: 'DISK_QUOTA' });
  });

  it('is not armed outside the test profile, nor for a malformed argument', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp'));
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:tmp:1');
    await writeBytesAtomic(dataPath(dataDir, 'tmp', 'op.json'), 'a');
    vi.unstubAllGlobals();
    for (const spec of ['disk-full', 'disk-full:tmp', 'disk-full:tmp:0', 'disk-full:tmp:x', 'disk-full::1']) {
      vi.stubEnv('ALTIS_TEST_FAULT', spec);
      await writeBytesAtomic(dataPath(dataDir, 'tmp', 'op.json'), spec);
    }
    expect(await fsp.readFile(path.join(dataDir, 'tmp', 'op.json'), 'utf8')).toBe('disk-full::1');
  });

  it('accepts the area releases (1d): the second write under releases/ fails, the first succeeds', async () => {
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:releases:2');
    await fsp.mkdir(path.join(dataDir, 'releases'));
    const first = dataPath(dataDir, 'releases', 'current.json');
    await writeBytesAtomic(first, 'one');
    await expect(writeBytesAtomic(dataPath(dataDir, 'releases', '0.2.0-test', 'manifest.json'), 'two')).rejects.toMatchObject({
      code: 'DISK_QUOTA',
      meta: { code: 'EDQUOT' },
    });
    expect(await fsp.readFile(first, 'utf8')).toBe('one');
    expect(await fsp.readdir(path.join(dataDir, 'releases'))).toEqual(['current.json']);
  });

  it('starts counting again when the fault changes, or after resetTestFaults()', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp'));
    const p = dataPath(dataDir, 'tmp', 'op.json');
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:tmp:2');
    await writeBytesAtomic(p, '1');
    resetTestFaults();
    await writeBytesAtomic(p, '2'); // the first write again
    await expect(writeBytesAtomic(p, '3')).rejects.toMatchObject({ code: 'DISK_QUOTA' });
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:tmp:1');
    await expect(writeBytesAtomic(p, '4')).rejects.toMatchObject({ code: 'DISK_QUOTA' });
    expect(await fsp.readFile(p, 'utf8')).toBe('2');
  });
});
