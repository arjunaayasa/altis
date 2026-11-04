import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDataDir } from '../src/datadir.js';

const BOM = String.fromCharCode(0xfeff);

let root: string;
let home: string;
let appRoot: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-datadir-')));
  home = path.join(root, 'home', 'u');
  appRoot = path.join(home, 'perpus', 'app');
  await fsp.mkdir(appRoot, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const pointer = (): string => path.join(appRoot, 'altis-data-dir.txt');

describe('resolveDataDir', () => {
  it('ALTIS_DATA_DIR wins over everything else', async () => {
    await fsp.writeFile(pointer(), '/somewhere/else\n');
    await fsp.mkdir(path.join(home, 'public_html'));
    const given = path.join(root, 'data');
    expect(resolveDataDir({ env: { ALTIS_DATA_DIR: given }, appRoot, home })).toEqual({ dir: given, source: 'env' });
  });

  it('trims ALTIS_DATA_DIR and resolves a relative value against appRoot', () => {
    expect(resolveDataDir({ env: { ALTIS_DATA_DIR: '  ../d  ' }, appRoot, home })).toEqual({
      dir: path.join(home, 'perpus', 'd'),
      source: 'env',
    });
  });

  it('treats an empty or blank ALTIS_DATA_DIR as unset', async () => {
    await fsp.writeFile(pointer(), '/from/pointer');
    expect(resolveDataDir({ env: { ALTIS_DATA_DIR: '' }, appRoot, home }).source).toBe('pointer');
    expect(resolveDataDir({ env: { ALTIS_DATA_DIR: '   ' }, appRoot, home }).source).toBe('pointer');
    expect(resolveDataDir({ env: { ALTIS_DATA_DIR: undefined }, appRoot, home }).source).toBe('pointer');
  });

  it('reads altis-data-dir.txt next to app.js, trimmed, when the environment does not name a directory', async () => {
    const given = path.join(root, 'srv', 'altis-data');
    await fsp.writeFile(pointer(), `  ${given}  \r\n`);
    await fsp.mkdir(path.join(home, 'public_html')); // the pointer outranks the public_html rule
    expect(resolveDataDir({ env: {}, appRoot, home })).toEqual({ dir: given, source: 'pointer' });
  });

  it('drops a byte-order mark from altis-data-dir.txt (Notepad adds one)', async () => {
    const given = path.join(root, 'srv', 'altis-data');
    await fsp.writeFile(pointer(), `${BOM}${given}\n`);
    expect(resolveDataDir({ env: {}, appRoot, home }).dir).toBe(given);
  });

  it('resolves a relative path in altis-data-dir.txt against appRoot', async () => {
    await fsp.writeFile(pointer(), '../../shared-data\n');
    expect(resolveDataDir({ env: {}, appRoot, home })).toEqual({ dir: path.join(home, 'shared-data'), source: 'pointer' });
  });

  it('ignores an empty altis-data-dir.txt', async () => {
    await fsp.writeFile(pointer(), ' \n\t\n');
    expect(resolveDataDir({ env: {}, appRoot, home }).source).toBe('sibling');
  });

  it('refuses an altis-data-dir.txt that exists but cannot be read, instead of choosing another directory', async () => {
    await fsp.mkdir(pointer()); // reading a directory fails with EISDIR
    let error: unknown;
    try {
      resolveDataDir({ env: {}, appRoot, home });
    } catch (e) {
      error = e;
    }
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'INVALID_CONFIG', meta: { reason: 'data_dir_pointer_unreadable' } });
    // bilingual operator message that names the file
    expect((error as { detail: string }).detail).toContain(pointer());
    expect((error as { detail: string }).detail).toContain(' / ');
  });

  it('takes the first line only: the rest of the file may be a note', async () => {
    const given = path.join(root, 'srv', 'altis-data');
    await fsp.writeFile(pointer(), `${given}\n# moved here on 2026-10-01\n/some/other/path\n`);
    expect(resolveDataDir({ env: {}, appRoot, home })).toEqual({ dir: given, source: 'pointer' });
    await fsp.writeFile(pointer(), `${given}\r${given}-2`); // a bare CR ends a line too
    expect(resolveDataDir({ env: {}, appRoot, home }).dir).toBe(given);
  });

  it('skips leading blank lines to find the first line', async () => {
    const given = path.join(root, 'srv', 'altis-data');
    await fsp.writeFile(pointer(), `\n  \n${given}\n`);
    expect(resolveDataDir({ env: {}, appRoot, home }).dir).toBe(given);
  });

  it.each([
    ['NUL', '/srv/da\0ta'],
    ['tab inside the path', '/srv/da\tta'],
    ['escape', '/srv/da\u001bta'],
    ['DEL', '/srv/da\u007fta'],
  ])('refuses an altis-data-dir.txt with a control character in the path (%s)', async (_name, content) => {
    await fsp.writeFile(pointer(), `${content}\n`);
    let error: unknown;
    try {
      resolveDataDir({ env: {}, appRoot, home });
    } catch (e) {
      error = e;
    }
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'INVALID_CONFIG', meta: { reason: 'data_dir_pointer_invalid' } });
    expect((error as { detail: string }).detail).toContain(pointer());
    expect((error as { detail: string }).detail).toContain(' / ');
  });

  it('does not look at control characters after the first line', async () => {
    await fsp.writeFile(pointer(), '/srv/ok\n\0\u0001 binary tail');
    expect(resolveDataDir({ env: {}, appRoot, home }).dir).toBe('/srv/ok');
  });

  it('uses $HOME/altis-data/<app folder name> when $HOME/public_html exists', async () => {
    await fsp.mkdir(path.join(home, 'public_html'));
    expect(resolveDataDir({ env: {}, appRoot, home })).toEqual({
      dir: path.join(home, 'altis-data', 'app'),
      source: 'home-altis-data',
    });
  });

  it('counts $HOME/public_html when it is a symlink to a directory', async () => {
    await fsp.mkdir(path.join(root, 'vol', 'html'), { recursive: true });
    await fsp.symlink(path.join(root, 'vol', 'html'), path.join(home, 'public_html'));
    expect(resolveDataDir({ env: {}, appRoot, home }).source).toBe('home-altis-data');
  });

  it('does not count a $HOME/public_html that is a file or a dangling symlink', async () => {
    await fsp.writeFile(path.join(home, 'public_html'), 'x');
    expect(resolveDataDir({ env: {}, appRoot, home }).source).toBe('sibling');
    await fsp.rm(path.join(home, 'public_html'));
    await fsp.symlink(path.join(root, 'gone'), path.join(home, 'public_html'));
    expect(resolveDataDir({ env: {}, appRoot, home }).source).toBe('sibling');
  });

  it('uses <appRoot>/../altis-data otherwise', () => {
    expect(resolveDataDir({ env: {}, appRoot, home })).toEqual({
      dir: path.join(home, 'perpus', 'altis-data'),
      source: 'sibling',
    });
  });

  it('normalises a trailing slash on appRoot', () => {
    expect(resolveDataDir({ env: {}, appRoot: `${appRoot}${path.sep}`, home }).dir).toBe(
      path.join(home, 'perpus', 'altis-data'),
    );
  });
});
