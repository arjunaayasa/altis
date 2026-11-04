import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_LOCK_WAIT_MS, initialState, readCurrentState, updateCurrentState } from '../src/current-state.js';
import type { CurrentState } from '../src/release-files.js';

// DATA_DIR/releases/current.json (spec §9.3), shared by app.js and the server (1d Task 2): read, initialised and
// changed under releases/current.lock with the atomic-file rules (temp → fsync → rename, `.bak`).

let root: string; // realpath of a temp directory
let dataDir: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-current-state-')));
  dataDir = path.join(root, 'altis-data');
  await fsp.mkdir(dataDir);
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

const BASE: CurrentState = {
  schema: 1,
  active: { version: '0.1.0-test', source: 'data' },
  previous: null,
  pending: null,
  pendingSince: null,
  pinned: null,
};

async function writeCurrent(value: unknown, name = 'current.json'): Promise<void> {
  await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
  await fsp.writeFile(releasesFile(name), typeof value === 'string' ? value : JSON.stringify(value));
}

describe('initialState', () => {
  it('names the bundled release as active and nothing else', () => {
    expect(initialState('0.1.0-test')).toEqual({
      schema: 1,
      active: { version: '0.1.0-test', source: 'bundled' },
      previous: null,
      pending: null,
      pendingSince: null,
      pinned: null,
    });
  });

  it('waits for current.lock longer than a lock can stay fresh without its holder', () => {
    expect(CURRENT_LOCK_WAIT_MS).toBe(45_000);
  });
});

describe('readCurrentState', () => {
  it('creates current.json with the initial state when there is none, and returns it', async () => {
    expect(await readCurrentState(dataDir, '0.1.0-test')).toEqual(initialState('0.1.0-test'));
    expect(await readJson('current.json')).toEqual(initialState('0.1.0-test'));
    expect(await exists(releasesFile('current.lock'))).toBe(false);
  });

  it('returns the state of an existing file, a pending release included', async () => {
    const pending: CurrentState = { ...BASE, pending: { version: '0.2.0-test', source: 'data' }, pendingSince: 1767225600000 };
    await writeCurrent(pending);
    expect(await readCurrentState(dataDir, '0.9.0-test')).toEqual(pending);
  });

  it('repairs a torn main file from its .bak', async () => {
    await writeCurrent(BASE, 'current.json.bak');
    await writeCurrent('{"schema":');
    expect(await readCurrentState(dataDir, '0.9.0-test')).toEqual(BASE);
    expect(await readJson('current.json')).toEqual(BASE);
  });

  it('keeps the fields a later release added when it repairs a torn main file from its .bak (contract v1)', async () => {
    await writeCurrent({ ...BASE, lastHealthyAt: 1767225600000 }, 'current.json.bak');
    await writeCurrent('{"schema":');
    expect(await readCurrentState(dataDir, '0.9.0-test')).toEqual(BASE);
    expect(await readJson('current.json')).toEqual({ ...BASE, lastHealthyAt: 1767225600000 });
  });

  it('throws STATE_CORRUPT when neither the file nor its .bak is usable', async () => {
    await writeCurrent('{"schema":');
    await writeCurrent({ schema: 2 }, 'current.json.bak');
    await expect(readCurrentState(dataDir, '0.1.0-test')).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
  });
});

describe('updateCurrentState', () => {
  it('applies the change, writes it atomically with a .bak of the old state, and returns it', async () => {
    await writeCurrent(BASE);
    const result = await updateCurrentState(dataDir, (s) => ({ ...s, pinned: '0.2.0-test' }));
    const expected = { ...BASE, pinned: '0.2.0-test' };
    expect(result).toEqual({ state: expected, changed: true });
    expect(await readJson('current.json')).toEqual(expected);
    expect(await readJson('current.json.bak')).toEqual(BASE);
    expect(await exists(releasesFile('current.lock'))).toBe(false);
  });

  it('hands the change a state of its own, so changing it in place is safe', async () => {
    await writeCurrent(BASE);
    const result = await updateCurrentState(dataDir, (s) => {
      s.previous = { version: '0.0.9', source: 'data' };
      return s;
    });
    expect(result.state.previous).toEqual({ version: '0.0.9', source: 'data' });
    expect(await readJson('current.json')).toEqual({ ...BASE, previous: { version: '0.0.9', source: 'data' } });
  });

  it('serialises two concurrent changes: both end up in the file', async () => {
    await writeCurrent(BASE);
    const [a, b] = await Promise.all([
      updateCurrentState(dataDir, (s) => ({ ...s, pinned: '0.2.0-test' })),
      updateCurrentState(dataDir, (s) => ({ ...s, pending: { version: '0.3.0-test', source: 'data' }, pendingSince: 1767225600000 })),
    ]);
    const final = { ...BASE, pinned: '0.2.0-test', pending: { version: '0.3.0-test', source: 'data' }, pendingSince: 1767225600000 };
    expect(await readJson('current.json')).toEqual(final);
    // The one that ran second saw the first one's change.
    expect([a.state, b.state]).toContainEqual(final);
  });

  it('writes nothing when the change returns null, and returns the state as read', async () => {
    await writeCurrent(BASE);
    const past = new Date(Date.now() - 60_000);
    await fsp.utimes(releasesFile('current.json'), past, past);
    const before = (await fsp.stat(releasesFile('current.json'))).mtimeMs;
    let seen: CurrentState | undefined;
    const result = await updateCurrentState(dataDir, (s) => {
      seen = s;
      return null;
    });
    expect(seen).toEqual(BASE);
    expect(result).toEqual({ state: BASE, changed: false });
    expect((await fsp.stat(releasesFile('current.json'))).mtimeMs).toBe(before);
    expect(await exists(releasesFile('current.json.bak'))).toBe(false);
    expect(await exists(releasesFile('current.lock'))).toBe(false);
  });

  it("applies the change to the .bak's content when the main file is torn, and rewrites both files", async () => {
    const good: CurrentState = { ...BASE, previous: { version: '0.0.9', source: 'data' } };
    await writeCurrent(good, 'current.json.bak');
    await writeCurrent('{"schema":1,"act');
    const past = new Date(Date.now() - 60_000);
    await fsp.utimes(releasesFile('current.json.bak'), past, past);
    const bakBefore = (await fsp.stat(releasesFile('current.json.bak'))).mtimeMs;
    const result = await updateCurrentState(dataDir, (s) => ({ ...s, pinned: '0.2.0-test' }));
    expect(result).toEqual({ state: { ...good, pinned: '0.2.0-test' }, changed: true });
    expect(await readJson('current.json')).toEqual({ ...good, pinned: '0.2.0-test' });
    expect(await readJson('current.json.bak')).toEqual(good);
    expect((await fsp.stat(releasesFile('current.json.bak'))).mtimeMs).not.toBe(bakBefore);
  });

  it('a main file that is JSON but not a valid state is treated like a torn one: the .bak keeps the good state', async () => {
    const good: CurrentState = { ...BASE, previous: { version: '0.0.9', source: 'data' } };
    await writeCurrent(good, 'current.json.bak');
    await writeCurrent({ schema: 2, active: 'elsewhere' });
    const result = await updateCurrentState(dataDir, (s) => ({ ...s, pinned: '0.2.0-test' }));
    expect(result.state).toEqual({ ...good, pinned: '0.2.0-test' });
    expect(await readJson('current.json')).toEqual({ ...good, pinned: '0.2.0-test' });
    expect(await readJson('current.json.bak')).toEqual(good);
  });

  it('refuses a change that parseCurrentState refuses, and writes nothing', async () => {
    await writeCurrent(BASE);
    const text = await fsp.readFile(releasesFile('current.json'), 'utf8');
    await expect(
      updateCurrentState(dataDir, (s) => ({ ...s, pending: { version: '0.1.0-test', source: 'data' }, pendingSince: 1 })),
    ).rejects.toThrow(expect.objectContaining({ name: 'TypeError', message: expect.stringMatching(/pending/) }));
    await expect(updateCurrentState(dataDir, (s) => ({ ...s, pending: { version: '0.2.0-test', source: 'data' } }))).rejects.toThrow(
      /pendingSince/,
    );
    expect(await fsp.readFile(releasesFile('current.json'), 'utf8')).toBe(text);
    expect(await exists(releasesFile('current.json.bak'))).toBe(false);
    expect(await exists(releasesFile('current.lock'))).toBe(false);
  });

  it('writes only the known fields of the changed state: what the change adds is dropped', async () => {
    await writeCurrent(BASE);
    await updateCurrentState(dataDir, (s) => Object.assign({}, s, { extra: 'dropped' }));
    expect(await readJson('current.json')).toEqual(BASE);
  });

  it('keeps the fields a later release added to the file, and hands the change and returns the known ones (contract v1)', async () => {
    const later = { ...BASE, lastHealthyAt: 1767225600000, channel: { name: 'stable', since: 1 } };
    await writeCurrent(later);
    let seen: CurrentState | undefined;
    const result = await updateCurrentState(dataDir, (s) => {
      seen = s;
      return { ...s, pending: { version: '0.2.0-test', source: 'data' }, pendingSince: 1767225600000 };
    });
    const known: CurrentState = { ...BASE, pending: { version: '0.2.0-test', source: 'data' }, pendingSince: 1767225600000 };
    expect(seen).toEqual(BASE);
    expect(result).toEqual({ state: known, changed: true });
    expect(await readJson('current.json')).toEqual({ ...known, lastHealthyAt: 1767225600000, channel: { name: 'stable', since: 1 } });
    expect(await readJson('current.json.bak')).toEqual(later);
  });

  it("keeps the later release's fields of the .bak when the main file is torn, in both files", async () => {
    const later = { ...BASE, lastHealthyAt: 1767225600000 };
    await writeCurrent(later, 'current.json.bak');
    await writeCurrent('{"schema":1,"act');
    await updateCurrentState(dataDir, (s) => ({ ...s, pinned: '0.2.0-test' }));
    expect(await readJson('current.json')).toEqual({ ...later, pinned: '0.2.0-test' });
    expect(await readJson('current.json.bak')).toEqual(later);
  });

  it('a field named __proto__ in the file is kept as a plain field, never as the prototype', async () => {
    await writeCurrent(`{"schema":1,"active":{"version":"0.1.0-test","source":"data"},"previous":null,"pending":null,"pendingSince":null,"pinned":null,"__proto__":{"polluted":true}}`);
    const result = await updateCurrentState(dataDir, (s) => ({ ...s, pinned: '0.2.0-test' }));
    expect(result.state).toEqual({ ...BASE, pinned: '0.2.0-test' });
    const written = (await readJson('current.json')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(written)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(written, '__proto__')?.value).toEqual({ polluted: true });
    expect(written['pinned']).toBe('0.2.0-test');
  });

  it("lets the change's own error through and writes nothing", async () => {
    await writeCurrent(BASE);
    const boom = new Error('boom');
    await expect(
      updateCurrentState(dataDir, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await readJson('current.json')).toEqual(BASE);
    expect(await exists(releasesFile('current.lock'))).toBe(false);
  });

  it('throws STATE_CORRUPT {reason: state_missing} when there is no current.json to change (only readCurrentState creates it)', async () => {
    const error = await updateCurrentState(dataDir, (s) => s).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'STATE_CORRUPT', meta: { reason: 'state_missing' } });
    expect(await exists(releasesFile('current.json'))).toBe(false);
  });

  it('throws STATE_CORRUPT when neither the file nor its .bak is usable', async () => {
    await writeCurrent('{"schema":');
    await writeCurrent('[]', 'current.json.bak');
    await expect(updateCurrentState(dataDir, (s) => s)).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
  });
});
