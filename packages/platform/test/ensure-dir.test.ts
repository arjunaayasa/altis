import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDir } from '../src/ensure-dir.js';

let root: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-ensure-dir-')));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('ensureDir', () => {
  it('creates the directory and its missing parents', async () => {
    const dir = path.join(root, 'a', 'b', 'db');
    await ensureDir(dir);
    expect((await fsp.stat(dir)).isDirectory()).toBe(true);
  });

  it('accepts a directory that already exists and leaves its content alone', async () => {
    const dir = path.join(root, 'db');
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, 'keep'), 'x');
    await ensureDir(dir);
    await ensureDir(dir);
    expect(await fsp.readFile(path.join(dir, 'keep'), 'utf8')).toBe('x');
  });

  it.skipIf(process.platform === 'win32')('creates new directories private to the owner (0700)', async () => {
    const dir = path.join(root, 'p', 'db');
    await ensureDir(dir);
    expect((await fsp.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(path.join(root, 'p'))).mode & 0o777).toBe(0o700);
  });

  it('rejects when a file stands where the directory should be', async () => {
    const file = path.join(root, 'db');
    await fsp.writeFile(file, 'x');
    await expect(ensureDir(file)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});
