import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_LOOK_MS, createApp, type AppState } from '../src/app.js';
import { writeConfig } from '../src/config.js';
import { recordingLogger, sampleConfig, useDataDir } from './support.js';

// The `not_installed` look (plan Task 27, S12, L45): a process that started before config.json existed has no config
// fence, so its phase gate looks at install.lock and config.json itself, at most every 2 s on the services clock and
// only when requests arrive, and calls services.installDone() (start()'s new boot attempt) when either appeared or
// changed. A gate that finds the install complete starts the boot at once, and the request is answered as starting.

const dirs = useDataDir();
let now: number;
let installDone: ReturnType<typeof vi.fn<() => void>>;

beforeEach(async () => {
  await fsp.mkdir(dirs.dataDir);
  now = 1_767_225_600_000;
  installDone = vi.fn<() => void>();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function app() {
  const state: AppState = { phase: 'not_installed' };
  return createApp({
    state,
    version: '0.1.0',
    buildId: '0.1.0',
    log: recordingLogger(),
    dataDir: dirs.dataDir,
    appRoot: path.join(dirs.root, 'app'),
    env: {},
    clock: () => now,
    services: { installDone },
  });
}

const peer = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

describe('the not_installed look (S12)', () => {
  it('starts a boot attempt when config.json appears or changes, looking at most every 2 s', async () => {
    const a = app();
    expect((await a.request('/', {}, peer)).status).toBe(302);
    expect(installDone).not.toHaveBeenCalled(); // nothing there yet

    await writeConfig(dirs.dataDir, sampleConfig({ installState: 'migrate' }));
    now += INSTALL_LOOK_MS - 1;
    expect((await a.request('/', {}, peer)).headers.get('location')).toBe('/install');
    expect(installDone).not.toHaveBeenCalled(); // looked less than 2 s ago

    now += 1;
    expect((await a.request('/', {}, peer)).status).toBe(302);
    expect(installDone).toHaveBeenCalledTimes(1); // config.json appeared

    now += INSTALL_LOOK_MS;
    expect((await a.request('/', {}, peer)).status).toBe(302);
    expect(installDone).toHaveBeenCalledTimes(1); // unchanged since

    // A changed config.json (another process moved installState on): a newer mtime.
    const file = path.join(dirs.dataDir, 'config.json');
    const later = new Date(Date.now() + 60_000);
    await fsp.utimes(file, later, later);
    now += INSTALL_LOOK_MS;
    await a.request('/', {}, peer);
    expect(installDone).toHaveBeenCalledTimes(2);
  });

  it('a gate that finds install.lock starts the boot at once (no 2 s wait) and answers 503 as starting', async () => {
    const a = app();
    expect((await a.request('/', {}, peer)).status).toBe(302);
    await fsp.writeFile(path.join(dirs.dataDir, 'install.lock'), JSON.stringify({ installId: 'x', at: 'now' }));
    // The same instant: the look is not due, the gate's own stat sees the install.
    const res = await a.request('/', {}, peer);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('DB_UNAVAILABLE');
    expect(installDone).toHaveBeenCalledTimes(1);
    // The wizard answers 404 meanwhile, as in every installed process.
    expect((await a.request('/install', {}, peer)).status).toBe(404);
  });
});
