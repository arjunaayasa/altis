import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { appPath, readAppFile, removeAppFile, writeAppFileAtomic, type AppFileName, type AppPath } from '../src/app-paths.js';
import { errno } from './support.js';

// Files in the application folder (appRoot, next to app.js), which is not DATA_DIR: the install marker
// (spec §7.7), the restart file Passenger watches (P14), app.js and the DATA_DIR pointer.

let appRoot: string;

beforeEach(async () => {
  appRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-app-paths-')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.chmod(appRoot, 0o700).catch(() => undefined);
  await fsp.rm(appRoot, { recursive: true, force: true });
});

const posix = process.platform !== 'win32';
const asRoot = process.getuid?.() === 0;

describe('appPath', () => {
  it.each<[AppFileName, string[]]>([
    ['app.js', ['app.js']],
    ['altis-data-dir.txt', ['altis-data-dir.txt']],
    ['installed-marker', ['.altis', 'installed.json']],
    ['restart.txt', ['tmp', 'restart.txt']],
  ])('%s is <appRoot>/%j', (name, parts) => {
    const p = appPath(appRoot, name);
    expect(p).toBe(path.join(appRoot, ...parts));
    expectTypeOf(p).toEqualTypeOf<AppPath>();
  });

  it('the install marker ends with .altis/installed.json', () => {
    expect(appPath(appRoot, 'installed-marker').endsWith(path.join('.altis', 'installed.json'))).toBe(true);
  });

  it('resolves a relative appRoot against the working directory', () => {
    expect(appPath('some-app', 'app.js')).toBe(path.resolve('some-app', 'app.js'));
  });

  it('refuses any other name, whatever the type system says', () => {
    for (const name of ['config.json', '../x', '', 'toString', 'installed.json']) {
      expect(() => appPath(appRoot, name as AppFileName)).toThrow(expect.objectContaining({ code: 'INVALID_PATH_SEGMENT' }));
    }
  });
});

describe('reading, writing and removing app files', () => {
  it('writes atomically (creating .altis/ and tmp/), reads back, and removes', async () => {
    const marker = appPath(appRoot, 'installed-marker');
    expect(await readAppFile(marker, 1024)).toBeNull();
    expect(await writeAppFileAtomic(marker, '{"installId":"x"}')).toBe(true);
    expect((await readAppFile(marker, 1024))?.toString()).toBe('{"installId":"x"}');
    expect(await writeAppFileAtomic(marker, Buffer.from('{"installId":"y"}'))).toBe(true);
    expect((await readAppFile(marker, 1024))?.toString()).toBe('{"installId":"y"}');
    expect(await fsp.readdir(path.join(appRoot, '.altis'))).toEqual(['installed.json']); // no temp file left
    expect(await writeAppFileAtomic(appPath(appRoot, 'restart.txt'), '')).toBe(true);
    expect(await fsp.readdir(path.join(appRoot, 'tmp'))).toEqual(['restart.txt']);
    expect(await removeAppFile(marker)).toBe(true);
    expect(await removeAppFile(marker)).toBe(true); // already gone
    expect(await readAppFile(marker, 1024)).toBeNull();
  });

  it('refuses to read a file larger than maxBytes', async () => {
    await fsp.writeFile(path.join(appRoot, 'altis-data-dir.txt'), 'x'.repeat(100));
    await expect(readAppFile(appPath(appRoot, 'altis-data-dir.txt'), 99)).rejects.toMatchObject({ meta: { reason: 'too_large' } });
  });

  it.skipIf(!posix || asRoot)('returns false, never throws, when appRoot is read-only', async () => {
    await fsp.chmod(appRoot, 0o500);
    expect(await writeAppFileAtomic(appPath(appRoot, 'installed-marker'), '{}')).toBe(false);
    expect(await writeAppFileAtomic(appPath(appRoot, 'restart.txt'), '')).toBe(false);
    expect(await writeAppFileAtomic(appPath(appRoot, 'app.js'), '')).toBe(false);
    await fsp.chmod(appRoot, 0o700);
    expect(await fsp.readdir(appRoot)).toEqual([]);
  });

  it.skipIf(!posix || asRoot)('removeAppFile returns false when appRoot is read-only', async () => {
    await fsp.writeFile(path.join(appRoot, 'altis-data-dir.txt'), '/data');
    await fsp.chmod(appRoot, 0o500);
    expect(await removeAppFile(appPath(appRoot, 'altis-data-dir.txt'))).toBe(false);
  });

  it.each(['EROFS', 'EACCES', 'EPERM'])('returns false for %s', async (code) => {
    vi.spyOn(fsp, 'open').mockRejectedValue(errno(code));
    expect(await writeAppFileAtomic(appPath(appRoot, 'app.js'), 'x')).toBe(false);
  });

  it('throws other errors, a full disk as DISK_QUOTA', async () => {
    vi.spyOn(fsp, 'open').mockRejectedValue(errno('EDQUOT'));
    await expect(writeAppFileAtomic(appPath(appRoot, 'app.js'), 'x')).rejects.toMatchObject({ code: 'DISK_QUOTA' });
    vi.spyOn(fsp, 'open').mockRejectedValue(errno('EIO'));
    await expect(writeAppFileAtomic(appPath(appRoot, 'app.js'), 'x')).rejects.toMatchObject({ code: 'EIO' });
  });
});
