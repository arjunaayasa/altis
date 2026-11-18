import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_ASSET_NAME,
  OPAC_FONT_NAME,
  parseCurrentState,
  readPreviousRelease,
  readReleaseFile,
  releaseDir,
  restartRequestedSince,
  type CurrentState,
} from '../src/release-files.js';

// Release files (Task 25): where a release lives (moved from the bootloader, S26), the read-only view of
// DATA_DIR/releases/current.json the server needs for the admin asset fallback, and the three kinds of public file a
// release serves (D31). app.js bundles this module, so it stays ES2017-compatible (P1).

let root: string; // realpath of a temp directory
let dataDir: string;
let appRoot: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-release-files-')));
  dataDir = path.join(root, 'altis-data');
  appRoot = path.join(root, 'app');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
});

function state(overrides: Partial<Record<keyof CurrentState, unknown>> = {}): Record<string, unknown> {
  return {
    schema: 1,
    active: { version: '0.2.0', source: 'data' },
    previous: null,
    pending: null,
    pendingSince: null,
    pinned: null,
    ...overrides,
  };
}

async function writeCurrent(value: unknown, file = 'current.json'): Promise<void> {
  await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'releases', file), JSON.stringify(value));
}

async function put(file: string, content: string | Buffer = 'x'): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
}

describe('releaseDir', () => {
  it('a bundled release lives in <appRoot>/bundled-release/<v>', () => {
    expect(releaseDir(appRoot, dataDir, { version: '1.2.3', source: 'bundled' })).toBe(path.join(appRoot, 'bundled-release', '1.2.3'));
  });

  it('a data release lives in DATA_DIR/releases/<v>', () => {
    expect(releaseDir(appRoot, dataDir, { version: '1.2.3-rc.1', source: 'data' })).toBe(path.join(dataDir, 'releases', '1.2.3-rc.1'));
  });

  it.each(['1.2', '../1.2.3', 'v1.2.3', ''])('a version that is not SemVer (%j) is a TypeError, for both sources', (version) => {
    expect(() => releaseDir(appRoot, dataDir, { version, source: 'bundled' })).toThrow(TypeError);
    expect(() => releaseDir(appRoot, dataDir, { version, source: 'data' })).toThrow(TypeError);
  });
});

describe('parseCurrentState', () => {
  it('returns a fresh copy of the known fields', () => {
    const raw = { ...state({ previous: { version: '0.1.0', source: 'bundled' }, pinned: '0.2.0' }), extra: true };
    expect(parseCurrentState(raw)).toEqual({
      schema: 1,
      active: { version: '0.2.0', source: 'data' },
      previous: { version: '0.1.0', source: 'bundled' },
      pending: null,
      pendingSince: null,
      pinned: '0.2.0',
    });
  });

  it.each([
    ['not an object', []],
    ['schema 2', state({ schema: 2 })],
    ['active not SemVer', state({ active: { version: 'x', source: 'data' } })],
    ['previous with another source', state({ previous: { version: '0.1.0', source: 'web' } })],
    ['pinned not SemVer', state({ pinned: 'latest' })],
  ])('refuses %s with a TypeError', (_name, raw) => {
    expect(() => parseCurrentState(raw)).toThrow(TypeError);
  });

  // 1d (Task 2, code map hazard 2): the first public app.js reads a pending release, so contract v1 freezes this shape.
  describe('a pending release (1d)', () => {
    const pendingState = {
      schema: 1,
      active: { version: '0.1.0-test', source: 'data' },
      previous: null,
      pending: { version: '0.2.0-test', source: 'data' },
      pendingSince: 1767225600000,
      pinned: null,
    };

    it('accepts a pending ref with an integer pendingSince (epoch ms) and returns it as is', () => {
      expect(parseCurrentState(pendingState)).toEqual(pendingState);
      expect(parseCurrentState({ ...pendingState, pending: { version: '0.2.0-test', source: 'bundled' } }).pending).toEqual({
        version: '0.2.0-test',
        source: 'bundled',
      });
    });

    it('returns a fresh copy of the pending ref, without its unknown fields', () => {
      const pending = { version: '0.2.0-test', source: 'data', extra: 1 };
      const parsed = parseCurrentState({ ...pendingState, pending });
      expect(parsed.pending).toEqual({ version: '0.2.0-test', source: 'data' });
      expect(parsed.pending).not.toBe(pending);
    });

    it('refuses a pending version equal to the active one, naming pending', () => {
      expect(() => parseCurrentState({ ...pendingState, pending: { version: '0.1.0-test', source: 'data' } })).toThrow(
        expect.objectContaining({ name: 'TypeError', message: expect.stringMatching(/pending/) }),
      );
    });

    it.each([null, undefined, 1.5, -1, '1767225600000', Number.NaN, 2 ** 53])(
      'refuses a pending release with pendingSince %j, naming pendingSince',
      (pendingSince) => {
        const raw: Record<string, unknown> = { ...pendingState, pendingSince };
        if (pendingSince === undefined) delete raw['pendingSince'];
        expect(() => parseCurrentState(raw)).toThrow(expect.objectContaining({ name: 'TypeError', message: expect.stringMatching(/pendingSince/) }));
      },
    );

    it('refuses a pendingSince without a pending release, naming pendingSince', () => {
      expect(() => parseCurrentState({ ...pendingState, pending: null, pendingSince: 5 })).toThrow(
        expect.objectContaining({ name: 'TypeError', message: expect.stringMatching(/pendingSince/) }),
      );
    });

    it.each([
      ['not a ref', 'x'],
      ['a version that is not SemVer', { version: 'next', source: 'data' }],
      ['another source', { version: '0.2.0-test', source: 'web' }],
    ])('refuses a pending entry that is %s, naming pending', (_name, pending) => {
      expect(() => parseCurrentState({ ...pendingState, pending })).toThrow(
        expect.objectContaining({ name: 'TypeError', message: expect.stringMatching(/pending/) }),
      );
    });

    it('a pending entry left out is refused like any other missing field (schema 1 names all six)', () => {
      const raw: Record<string, unknown> = { ...pendingState, pending: null, pendingSince: null };
      delete raw['pending'];
      expect(() => parseCurrentState(raw)).toThrow(expect.objectContaining({ name: 'TypeError', message: expect.stringMatching(/pending/) }));
    });

    it('ignores an unknown field', () => {
      expect(parseCurrentState({ ...pendingState, x: 1 })).toEqual(pendingState);
    });
  });
});

describe('readPreviousRelease', () => {
  it('returns the previous ref of current.json', async () => {
    await writeCurrent(state({ previous: { version: '0.1.0', source: 'data' } }));
    expect(await readPreviousRelease(dataDir)).toEqual({ version: '0.1.0', source: 'data' });
  });

  it('returns null when current.json names no previous release', async () => {
    await writeCurrent(state());
    expect(await readPreviousRelease(dataDir)).toBeNull();
  });

  it('returns null when current.json does not exist, and never creates it (read-only)', async () => {
    expect(await readPreviousRelease(dataDir)).toBeNull();
    await expect(fsp.stat(path.join(dataDir, 'releases', 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(dataDir, 'releases', 'current.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('falls back to current.json.bak when the main file is torn', async () => {
    await writeCurrent(state({ previous: { version: '0.1.0', source: 'bundled' } }), 'current.json.bak');
    await fsp.writeFile(path.join(dataDir, 'releases', 'current.json'), '{"schema":');
    expect(await readPreviousRelease(dataDir)).toEqual({ version: '0.1.0', source: 'bundled' });
  });

  it('throws STATE_CORRUPT when neither current.json nor its .bak is usable', async () => {
    await writeCurrent(state({ schema: 9 }));
    const error = await readPreviousRelease(dataDir).catch((e: unknown) => e);
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'STATE_CORRUPT' });
  });
});

describe('ADMIN_ASSET_NAME', () => {
  it.each([
    'index-Bk3x_9aQ.js',
    'index-Dq0-1a2b.css',
    '_virtual_react-jsx.js',
    'inter-latin-400-normal.woff2',
    'logo.svg',
    'icon-192.png',
    'favicon.ico',
    'a.b.c.js',
  ])('accepts %s', (name) => {
    expect(ADMIN_ASSET_NAME.test(name)).toBe(true);
  });

  it.each([
    '',
    '.vite',
    '.hidden.js',
    'x.js.map',
    'index.html',
    'manifest.json',
    'x.JS',
    '-x.js',
    '../x.js',
    'a/b.js',
    'a\\b.js',
    'a..js',
    'a .js',
    'a\u0000.js',
    'x.js\n',
  ])('refuses %j', (name) => {
    expect(ADMIN_ASSET_NAME.test(name)).toBe(false);
  });
});

describe('readReleaseFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join(root, 'release');
    await put(path.join(dir, 'public', 'admin', 'index.html'), '<!doctype html>');
    await put(path.join(dir, 'public', 'admin', 'assets', 'index-abc.js'), 'console.log(1)');
    await put(path.join(dir, 'public', 'THIRD_PARTY_NOTICES.txt'), 'MIT');
    await put(path.join(dir, 'server.mjs'), 'export {}');
    await put(path.join(root, 'secret.js'), 'secret');
  });

  it('reads public/admin/index.html, public/admin/assets/<name> and public/THIRD_PARTY_NOTICES.txt', async () => {
    expect((await readReleaseFile(dir, 'admin-index'))?.toString()).toBe('<!doctype html>');
    expect((await readReleaseFile(dir, 'admin-asset', 'index-abc.js'))?.toString()).toBe('console.log(1)');
    expect((await readReleaseFile(dir, 'legal'))?.toString()).toBe('MIT');
  });

  it('returns null for a file that does not exist (and for a release directory that does not)', async () => {
    expect(await readReleaseFile(dir, 'admin-asset', 'nope.js')).toBeNull();
    await fsp.rm(path.join(dir, 'public', 'THIRD_PARTY_NOTICES.txt'));
    expect(await readReleaseFile(dir, 'legal')).toBeNull();
    expect(await readReleaseFile(path.join(root, 'missing'), 'admin-index')).toBeNull();
  });

  it('returns null for a name that fails ADMIN_ASSET_NAME, without touching the file system', async () => {
    await put(path.join(dir, 'public', 'admin', 'assets', 'index-abc.js.map'), '{}');
    await put(path.join(dir, 'public', 'admin', 'assets', '.vite', 'manifest.json'), '{}');
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const realpath = vi.spyOn(fs.promises, 'realpath');
    for (const name of ['../../server.mjs', '../../../secret.js', 'index-abc.js.map', '.vite', '', undefined]) {
      expect(await readReleaseFile(dir, 'admin-asset', name)).toBeNull();
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it('returns null for a file whose real path leaves public/ (a symbolic link)', async () => {
    await fsp.symlink(path.join(root, 'secret.js'), path.join(dir, 'public', 'admin', 'assets', 'evil.js'));
    await fsp.symlink(path.join(dir, 'server.mjs'), path.join(dir, 'public', 'admin', 'assets', 'server.js'));
    const readFile = vi.spyOn(fs.promises, 'readFile');
    expect(await readReleaseFile(dir, 'admin-asset', 'evil.js')).toBeNull();
    expect(await readReleaseFile(dir, 'admin-asset', 'server.js')).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('follows a symbolic link that stays inside public/', async () => {
    await fsp.symlink(path.join(dir, 'public', 'THIRD_PARTY_NOTICES.txt'), path.join(dir, 'public', 'admin', 'assets', 'notices.js'));
    expect((await readReleaseFile(dir, 'admin-asset', 'notices.js'))?.toString()).toBe('MIT');
  });

  it('opac-font: reads public/opac/<name> for a name that matches OPAC_FONT_NAME, nothing else', async () => {
    await put(path.join(dir, 'public', 'opac', 'plus-jakarta-sans-latin-0123456789.woff2'), 'wOF2');
    await put(path.join(dir, 'public', 'opac', 'notes.txt'), 'x');
    expect((await readReleaseFile(dir, 'opac-font', 'plus-jakarta-sans-latin-0123456789.woff2'))?.toString()).toBe('wOF2');
    expect(await readReleaseFile(dir, 'opac-font', 'plus-jakarta-sans-latin-ext-0123456789.woff2')).toBeNull();
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const realpath = vi.spyOn(fs.promises, 'realpath');
    for (const name of ['notes.txt', '../admin/index.html', '../../server.mjs', 'a.b.woff2', 'A.woff2', '.woff2', 'a/b.woff2', 'a.woff2\n', '', undefined]) {
      expect(OPAC_FONT_NAME.test(String(name))).toBe(false);
      expect(await readReleaseFile(dir, 'opac-font', name)).toBeNull();
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
    // A link that leaves public/ is not read.
    await fsp.symlink(path.join(root, 'secret.js'), path.join(dir, 'public', 'opac', 'evil.woff2'));
    expect(await readReleaseFile(dir, 'opac-font', 'evil.woff2')).toBeNull();
  });

  it('returns null for a directory carrying an asset name', async () => {
    await fsp.mkdir(path.join(dir, 'public', 'admin', 'assets', 'chunk.js'));
    expect(await readReleaseFile(dir, 'admin-asset', 'chunk.js')).toBeNull();
  });
});

describe('restartRequestedSince (1d Task 25, preflight 1D-21)', () => {
  const touch = async (at: number): Promise<void> => {
    await fsp.mkdir(path.join(appRoot, 'tmp'), { recursive: true });
    const file = path.join(appRoot, 'tmp', 'restart.txt');
    await fsp.writeFile(file, '');
    await fsp.utimes(file, new Date(at), new Date(at));
  };

  it('false without <appRoot>/tmp/restart.txt (and without the folder)', async () => {
    expect(await restartRequestedSince(appRoot, Date.now())).toBe(false);
  });

  it('true when restart.txt was touched at or after `since`, false when touched before it', async () => {
    const since = Date.UTC(2026, 9, 30, 3, 0, 10, 0);
    await touch(since + 5000);
    expect(await restartRequestedSince(appRoot, since)).toBe(true);
    await touch(since);
    expect(await restartRequestedSince(appRoot, since)).toBe(true);
    await touch(since - 5000);
    expect(await restartRequestedSince(appRoot, since)).toBe(false);
  });

  it('compares whole seconds: a file system that keeps seconds only still counts a touch right after `since`', async () => {
    const since = Date.UTC(2026, 9, 30, 3, 0, 10, 700);
    await touch(Date.UTC(2026, 9, 30, 3, 0, 10, 0)); // the same second, truncated
    expect(await restartRequestedSince(appRoot, since)).toBe(true);
    await touch(Date.UTC(2026, 9, 30, 3, 0, 9, 999));
    expect(await restartRequestedSince(appRoot, since)).toBe(false);
  });

  it('never creates anything', async () => {
    await restartRequestedSince(appRoot, 0);
    await expect(fsp.stat(appRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
