import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorkDir, runWorkPath } from '../src/datapath.js';
import { dataDirOf, openUnderRoot, runWorkFileIn } from '../src/root-files.js';

// Phase 2 Task 10: files below a folder the operator named (the SLiMS folder of `slims:import --files-dir`), bounded by
// that folder's real path, and the files of a catalog run's work folder reached from the folder's DataPath.

let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-root-files-')));
  root = path.join(tmp, 'slims');
  await fsp.mkdir(path.join(root, 'repository', 'docs'), { recursive: true });
  await fsp.writeFile(path.join(root, 'repository', 'docs', 'a.pdf'), 'PDF bytes');
  await fsp.writeFile(path.join(tmp, 'secret.txt'), 'outside');
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (isDomainError(error) && error.code === 'INVALID_PATH_SEGMENT') return String(error.meta?.['reason']);
    throw error;
  }
  return undefined;
}

describe('openUnderRoot', () => {
  it('opens a regular file below the root for reading', async () => {
    const handle = await openUnderRoot(root, 'repository/docs/a.pdf');
    expect(handle).not.toBeNull();
    try {
      expect((await handle!.readFile()).toString()).toBe('PDF bytes');
    } finally {
      await handle!.close();
    }
  });

  it('answers null for a file that does not exist', async () => {
    expect(await openUnderRoot(root, 'repository/docs/missing.pdf')).toBeNull();
    expect(await openUnderRoot(root, 'repository/nothing/here.pdf')).toBeNull();
  });

  it.each([
    ['../secret.txt'],
    ['repository/../../secret.txt'],
    ['/etc/passwd'],
    ['repository\\docs\\a.pdf'],
    ['repository//a.pdf'],
    ['repository/./docs/a.pdf'],
    [''],
    ['C:/x'],
    [`repository/docs/a.pdf${String.fromCharCode(0)}`],
  ])('refuses the relative path %j', async (rel) => {
    expect(await refusal(openUnderRoot(root, rel))).toBe('invalid_rel');
  });

  it('refuses a symbolic link that leads out of the root', async () => {
    await fsp.symlink(path.join(tmp, 'secret.txt'), path.join(root, 'repository', 'docs', 'link.pdf'));
    expect(await refusal(openUnderRoot(root, 'repository/docs/link.pdf'))).toBe('escapes_root');
    await fsp.symlink(tmp, path.join(root, 'repository', 'up'));
    expect(await refusal(openUnderRoot(root, 'repository/up/secret.txt'))).toBe('escapes_root');
  });

  it('follows a symbolic link that stays inside the root', async () => {
    await fsp.symlink(path.join(root, 'repository', 'docs', 'a.pdf'), path.join(root, 'repository', 'b.pdf'));
    const handle = await openUnderRoot(root, 'repository/b.pdf');
    expect(handle).not.toBeNull();
    await handle!.close();
  });

  it('refuses a folder', async () => {
    expect(await refusal(openUnderRoot(root, 'repository/docs'))).toBe('not_a_file');
  });

  it('resolves the root itself through a symbolic link', async () => {
    const link = path.join(tmp, 'slims-link');
    await fsp.symlink(root, link);
    const handle = await openUnderRoot(link, 'repository/docs/a.pdf');
    expect(handle).not.toBeNull();
    await handle!.close();
  });

  it('throws the error of a root that does not exist', async () => {
    await expect(openUnderRoot(path.join(tmp, 'nope'), 'a.pdf')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('runWorkFileIn and dataDirOf', () => {
  const RUN = '01JBX5ZK3M8Q4R7T9V0W2Y6A1C';

  it('builds a work file of the run whose folder it is given, as runWorkPath does', async () => {
    const dataDir = path.join(tmp, 'data');
    await fsp.mkdir(dataDir);
    const dir = runWorkDir(dataDir, RUN);
    expect(runWorkFileIn(dir, 'biblio.ndjson')).toBe(runWorkPath(dataDir, RUN, 'biblio.ndjson'));
    expect(runWorkFileIn(dir, 'dump.bin')).toBe(runWorkPath(dataDir, RUN, 'dump.bin'));
    expect(dataDirOf(dir)).toBe(dataDir);
    expect(dataDirOf(runWorkPath(dataDir, RUN, 'dump.bin'))).toBe(dataDir);
  });

  it('refuses a name runWorkPath refuses and a folder that is not a run work folder', async () => {
    const dataDir = path.join(tmp, 'data');
    await fsp.mkdir(dataDir);
    const dir = runWorkDir(dataDir, RUN);
    expect(() => runWorkFileIn(dir, '../x.ndjson')).toThrow(expect.objectContaining({ code: 'INVALID_PATH_SEGMENT' }));
    expect(() => runWorkFileIn(dir, 'Biblio.ndjson')).toThrow(expect.objectContaining({ code: 'INVALID_PATH_SEGMENT' }));
    expect(() => runWorkFileIn(runWorkPath(dataDir, RUN, 'dump.bin'), 'x.ndjson')).toThrow(TypeError);
    expect(() => runWorkFileIn(path.join(tmp, 'elsewhere') as never, 'x.ndjson')).toThrow(TypeError);
    expect(() => dataDirOf(path.join(tmp, 'elsewhere') as never)).toThrow(TypeError);
  });
});
