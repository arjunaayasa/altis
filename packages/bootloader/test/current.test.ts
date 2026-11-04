import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promote, type CurrentState } from '../src/current.js';

// promote (spec §9.3, 1d Task 13): once the pending release is healthy, app.js promotes it under current.lock:
// `previous = active`, `active = pending`, `pending = null`. Only the caller whose version is pending promotes;
// anything else writes nothing. schema-meta.json is the migrator's to write (D1d-22), never promote's.

let root: string; // realpath of a temp directory
let dataDir: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-promote-')));
  dataDir = path.join(root, 'altis-data');
  await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const releasesFile = (name: string): string => path.join(dataDir, 'releases', name);
const readJson = async (name: string): Promise<unknown> => JSON.parse(await fsp.readFile(releasesFile(name), 'utf8')) as unknown;
const exists = (p: string): Promise<boolean> =>
  fsp.access(p).then(
    () => true,
    () => false,
  );

const PENDING_SINCE = 1767225600000;

/** active 0.1.0-test (bundled), previous 0.0.9-test (data), pending 0.2.0-test (data), a pin left by a rollback. */
const WITH_PENDING: CurrentState = {
  schema: 1,
  active: { version: '0.1.0-test', source: 'bundled' },
  previous: { version: '0.0.9-test', source: 'data' },
  pending: { version: '0.2.0-test', source: 'data' },
  pendingSince: PENDING_SINCE,
  pinned: '0.1.5-test',
};

const NOTHING_PENDING: CurrentState = { ...WITH_PENDING, pending: null, pendingSince: null };

async function writeCurrent(state: CurrentState): Promise<string> {
  const text = `${JSON.stringify(state)}\n`;
  await fsp.writeFile(releasesFile('current.json'), text);
  return text;
}

/** Waits long enough that a rewrite of a file would change its mtime on every file system the tests run on. */
const pastMtimeGranularity = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('promote', () => {
  it('promotes the caller when it is the pending release: previous = active, active = pending, pending cleared', async () => {
    await writeCurrent(WITH_PENDING);
    expect(await promote(dataDir, '0.2.0-test')).toBe('promoted');
    expect(await readJson('current.json')).toEqual({
      schema: 1,
      active: { version: '0.2.0-test', source: 'data' },
      previous: { version: '0.1.0-test', source: 'bundled' },
      pending: null,
      pendingSince: null,
      pinned: '0.1.5-test', // a pin is the update's or release:unpin's to clear, not the promotion's
    });
    // Written atomically, the state before it kept as the .bak; the lock released; schema-meta.json not touched.
    expect(await readJson('current.json.bak')).toEqual(WITH_PENDING);
    expect(await exists(releasesFile('current.lock'))).toBe(false);
    expect(await exists(releasesFile('schema-meta.json'))).toBe(false);
  });

  it('a caller that is not the pending release changes nothing (the file is not even rewritten)', async () => {
    const text = await writeCurrent(WITH_PENDING);
    const before = await fsp.stat(releasesFile('current.json'));
    await pastMtimeGranularity();
    expect(await promote(dataDir, '0.1.0-test')).toBe('not_pending');
    expect(await promote(dataDir, '0.0.9-test')).toBe('not_pending');
    expect(await fsp.readFile(releasesFile('current.json'), 'utf8')).toBe(text);
    expect((await fsp.stat(releasesFile('current.json'))).mtimeMs).toBe(before.mtimeMs);
    expect(await exists(releasesFile('current.json.bak'))).toBe(false);
    expect(await exists(releasesFile('current.lock'))).toBe(false);
  });

  it('nothing pending: not_pending, the file untouched', async () => {
    const text = await writeCurrent(NOTHING_PENDING);
    const before = await fsp.stat(releasesFile('current.json'));
    await pastMtimeGranularity();
    expect(await promote(dataDir, '0.2.0-test')).toBe('not_pending');
    expect(await promote(dataDir, '0.1.0-test')).toBe('not_pending');
    expect(await fsp.readFile(releasesFile('current.json'), 'utf8')).toBe(text);
    expect((await fsp.stat(releasesFile('current.json'))).mtimeMs).toBe(before.mtimeMs);
    expect(await exists(releasesFile('current.json.bak'))).toBe(false);
  });

  it('is idempotent: a second call by the promoted release (another process, a retry) is not_pending', async () => {
    await writeCurrent(WITH_PENDING);
    expect(await promote(dataDir, '0.2.0-test')).toBe('promoted');
    const after = await fsp.readFile(releasesFile('current.json'), 'utf8');
    expect(await promote(dataDir, '0.2.0-test')).toBe('not_pending');
    expect(await fsp.readFile(releasesFile('current.json'), 'utf8')).toBe(after);
  });

  it('promotes a pending release with no previous, keeping the source of each release', async () => {
    await writeCurrent({
      schema: 1,
      active: { version: '0.1.0-test', source: 'data' },
      previous: null,
      pending: { version: '0.2.0-test', source: 'bundled' },
      pendingSince: PENDING_SINCE,
      pinned: null,
    });
    expect(await promote(dataDir, '0.2.0-test')).toBe('promoted');
    expect(await readJson('current.json')).toEqual({
      schema: 1,
      active: { version: '0.2.0-test', source: 'bundled' },
      previous: { version: '0.1.0-test', source: 'data' },
      pending: null,
      pendingSince: null,
      pinned: null,
    });
  });

  it('two callers at once: exactly one promotes (current.lock)', async () => {
    await writeCurrent(WITH_PENDING);
    const results = await Promise.all([promote(dataDir, '0.2.0-test'), promote(dataDir, '0.2.0-test')]);
    expect([...results].sort()).toEqual(['not_pending', 'promoted']);
    expect(await readJson('current.json')).toMatchObject({ active: { version: '0.2.0-test' }, previous: { version: '0.1.0-test' }, pending: null });
  });

  it('a torn current.json is promoted from its .bak', async () => {
    await fsp.writeFile(releasesFile('current.json.bak'), JSON.stringify(WITH_PENDING));
    await fsp.writeFile(releasesFile('current.json'), '{"schema":');
    expect(await promote(dataDir, '0.2.0-test')).toBe('promoted');
    expect(await readJson('current.json')).toMatchObject({ active: { version: '0.2.0-test', source: 'data' }, pending: null, pendingSince: null });
  });

  it('throws STATE_CORRUPT when current.json and its .bak are both missing (only a boot creates it)', async () => {
    await expect(promote(dataDir, '0.2.0-test')).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
    expect(await exists(releasesFile('current.json'))).toBe(false);
  });
});
