import fsp from 'node:fs/promises';
import path from 'node:path';
import { configMtimeMs } from '@altis/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEnvOverrides, loadConfig, updateConfig, writeConfig, type Config } from '../src/config.js';
import { createConfigFence } from '../src/http/config-fence.js';
import { start } from '../src/index.js';
import { bootContext, closeTestServers, httpRequest, recordingLogger, sampleConfig, useDataDir } from './support.js';

// The config part of the §9.3 fence (decision D34): config.json's mtime is looked at no more than once per 2 s,
// and a changed file is loaded again; a file that does not load keeps the config in use (logged once per mtime).
// start() creates the fence after its first loadConfig, and a changed `port` asks the bootloader for a restart.

// loadConfig counted, and optionally held after it has read the file (the next call only); connect optionally failing
// once with DB_UNAVAILABLE. Both pass through otherwise.
const hooks = vi.hoisted(() => ({
  loads: 0,
  holdNextLoad: undefined as { reached: () => void; until: Promise<void> } | undefined,
  failNextConnect: false,
}));
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadConfig: async (...args: Parameters<typeof actual.loadConfig>) => {
      hooks.loads += 1;
      const hold = hooks.holdNextLoad;
      hooks.holdNextLoad = undefined;
      const config = await actual.loadConfig(...args);
      if (hold !== undefined) {
        hold.reached();
        await hold.until;
      }
      return config;
    },
  };
});
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  const { DomainError } = await import('@altis/shared');
  return {
    ...actual,
    connect: async (...args: Parameters<typeof actual.connect>) => {
      if (hooks.failNextConnect) {
        hooks.failNextConnect = false;
        throw new DomainError('DB_UNAVAILABLE', { meta: { reason: 'unreachable' } });
      }
      return actual.connect(...args);
    },
  };
});

const dirs = useDataDir();
const T0 = 1_800_000_000_000;

function configFile(dataDir: string): string {
  return path.join(dataDir, 'config.json');
}

/** Sets config.json's mtime to `seconds` after the epoch, so that every rewrite has a distinct one. */
async function stamp(dataDir: string, seconds: number): Promise<void> {
  await fsp.utimes(configFile(dataDir), seconds, seconds);
}

async function setup(o: { intervalMs?: number } = {}) {
  await writeConfig(dirs.dataDir, sampleConfig({ db: { dialect: 'sqlite' }, port: 3000 }));
  await stamp(dirs.dataDir, 1_000);
  const initial = (await loadConfig(dirs.dataDir, {}))!;
  let now = T0;
  const clock = { advance: (ms: number) => (now += ms) };
  const mtime = vi.fn(configMtimeMs);
  const onChange = vi.fn<(next: Config, prev: Config) => void>();
  const log = recordingLogger();
  const fence = createConfigFence({ dataDir: dirs.dataDir, env: {}, initial, clock: () => now, mtime, onChange, log, ...o });
  return { fence, clock, mtime, onChange, log, initial };
}

describe('configMtimeMs', () => {
  it('is the mtime of DATA_DIR/config.json in ms, or null when there is none', async () => {
    expect(await configMtimeMs(dirs.dataDir)).toBeNull();
    await writeConfig(dirs.dataDir, sampleConfig({ db: { dialect: 'sqlite' } }));
    await stamp(dirs.dataDir, 1_234);
    expect(await configMtimeMs(dirs.dataDir)).toBe(1_234_000);
  });
});

describe('createConfigFence', () => {
  it('current() is the initial config until a check sees a changed file', async () => {
    const { fence, initial } = await setup();
    expect(fence.current()).toBe(initial);
    expect(fence.current().trustProxy.hops).toBe(1);
  });

  it('a rewrite with hops 2: no stat at +1 s, hops 2 at +2 s', async () => {
    const { fence, clock, mtime, onChange } = await setup();
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.trustProxy.hops = 2;
    });
    await stamp(dirs.dataDir, 2_000);

    clock.advance(1_000);
    await fence.check();
    expect(mtime).not.toHaveBeenCalled();
    expect(fence.current().trustProxy.hops).toBe(1);

    clock.advance(1_000);
    await fence.check();
    expect(mtime).toHaveBeenCalledTimes(1);
    expect(fence.current().trustProxy.hops).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].trustProxy.hops).toBe(2);
    expect(onChange.mock.calls[0]![1].trustProxy.hops).toBe(1);
  });

  it('stats at most once per interval, also for checks running at once', async () => {
    const { fence, clock, mtime } = await setup();
    clock.advance(2_000);
    await Promise.all([fence.check(), fence.check(), fence.check()]);
    expect(mtime).toHaveBeenCalledTimes(1);
    clock.advance(1_999);
    await fence.check();
    expect(mtime).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await fence.check();
    expect(mtime).toHaveBeenCalledTimes(2);
  });

  it('an invalid rewrite keeps hops 2 and logs one error (once per mtime)', async () => {
    const { fence, clock, log } = await setup();
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.trustProxy.hops = 2;
    });
    await stamp(dirs.dataDir, 2_000);
    clock.advance(2_000);
    await fence.check();
    expect(fence.current().trustProxy.hops).toBe(2);

    const raw = JSON.parse(await fsp.readFile(configFile(dirs.dataDir), 'utf8')) as Record<string, unknown>;
    await fsp.writeFile(configFile(dirs.dataDir), JSON.stringify({ ...raw, trustProxy: { hops: -1 } }));
    await stamp(dirs.dataDir, 3_000);
    for (let i = 0; i < 3; i += 1) {
      clock.advance(2_000);
      await fence.check();
    }
    expect(fence.current().trustProxy.hops).toBe(2);
    const errors = log.lines.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.fields['code']).toBe('INVALID_CONFIG');
    expect(JSON.stringify(errors)).not.toContain(sampleConfig().db.password);

    // Fixed again: loaded, and a later failure (another mtime) is logged again.
    await fsp.writeFile(configFile(dirs.dataDir), JSON.stringify({ ...raw, trustProxy: { hops: 3 } }));
    await stamp(dirs.dataDir, 4_000);
    clock.advance(2_000);
    await fence.check();
    expect(fence.current().trustProxy.hops).toBe(3);
    // Not JSON, and no .bak to fall back on (loadConfig would serve a valid .bak, as at boot).
    await fsp.rm(`${configFile(dirs.dataDir)}.bak`, { force: true });
    await fsp.writeFile(configFile(dirs.dataDir), '{"version":');
    await stamp(dirs.dataDir, 5_000);
    clock.advance(2_000);
    await fence.check();
    expect(fence.current().trustProxy.hops).toBe(3);
    expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(2);
  });

  it('a load that failed is tried again on the next look, also when the mtime did not change (still logged once)', async () => {
    const { fence, clock, log, onChange } = await setup();
    const raw = JSON.parse(await fsp.readFile(configFile(dirs.dataDir), 'utf8')) as Record<string, unknown>;
    await fsp.writeFile(configFile(dirs.dataDir), JSON.stringify({ ...raw, trustProxy: { hops: -1 } }));
    await stamp(dirs.dataDir, 2_000);
    clock.advance(2_000);
    await fence.check();
    expect(fence.current().trustProxy.hops).toBe(1);
    clock.advance(2_000);
    await fence.check();

    // Corrected in place with the same mtime (a coarse file system, or a partial write read mid-way).
    await fsp.writeFile(configFile(dirs.dataDir), JSON.stringify({ ...raw, trustProxy: { hops: 2 } }));
    await stamp(dirs.dataDir, 2_000);
    clock.advance(2_000);
    await fence.check();
    expect(fence.current().trustProxy.hops).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(1);

    // Once loaded, the same mtime is not loaded again.
    const loads = hooks.loads;
    clock.advance(2_000);
    await fence.check();
    expect(fence.current().trustProxy.hops).toBe(2);
    expect(hooks.loads).toBe(loads);
  });

  it('a removed config.json keeps the config in use (logged once)', async () => {
    const { fence, clock, log } = await setup();
    await fsp.rm(configFile(dirs.dataDir));
    await fsp.rm(`${configFile(dirs.dataDir)}.bak`, { force: true });
    clock.advance(2_000);
    await fence.check();
    clock.advance(2_000);
    await fence.check();
    expect(fence.current().trustProxy.hops).toBe(1);
    expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(1);
  });

  it('a stat that fails keeps the config in use, logged once until a stat works again', async () => {
    const { fence, clock, mtime, log } = await setup();
    mtime.mockRejectedValue(Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' }));
    for (let i = 0; i < 3; i += 1) {
      clock.advance(2_000);
      await expect(fence.check()).resolves.toBeUndefined();
    }
    expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(1);
    mtime.mockImplementation(configMtimeMs);
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.trustProxy.hops = 2;
    });
    clock.advance(2_000);
    await fence.check();
    expect(fence.current().trustProxy.hops).toBe(2);
  });

  it('a port change calls onChange with both configs (different ports)', async () => {
    const { fence, clock, onChange } = await setup();
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.port = 8080;
    });
    await stamp(dirs.dataDir, 2_000);
    clock.advance(2_000);
    await fence.check();
    expect(onChange).toHaveBeenCalledTimes(1);
    const [next, prev] = onChange.mock.calls[0]!;
    expect(next.port).toBe(8080);
    expect(prev.port).toBe(3000);
  });

  it('a touched but unchanged file reloads without calling onChange', async () => {
    const { fence, clock, onChange, mtime } = await setup();
    await stamp(dirs.dataDir, 2_000);
    clock.advance(2_000);
    await fence.check();
    expect(mtime).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an onChange that throws is logged; the new config stays current', async () => {
    const { fence, clock, onChange, log } = await setup();
    onChange.mockImplementation(() => {
      throw new Error('boom');
    });
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.trustProxy.hops = 2;
    });
    await stamp(dirs.dataDir, 2_000);
    clock.advance(2_000);
    await expect(fence.check()).resolves.toBeUndefined();
    expect(fence.current().trustProxy.hops).toBe(2);
    expect(log.lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('reset(config): what this process wrote and applied itself is current at once, and its file brings no onChange', async () => {
    const { fence, clock, onChange } = await setup();
    const written = await updateConfig(dirs.dataDir, (cfg) => {
      cfg.trustProxy.hops = 2;
    });
    await stamp(dirs.dataDir, 2_000);
    const applied = applyEnvOverrides(written, {});
    fence.reset(applied);
    expect(fence.current()).toBe(applied);

    clock.advance(2_000);
    await fence.check();
    expect(fence.current().trustProxy.hops).toBe(2);
    expect(onChange).not.toHaveBeenCalled();

    // A later change by another writer is still seen.
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.trustProxy.hops = 3;
    });
    await stamp(dirs.dataDir, 3_000);
    clock.advance(2_000);
    await fence.check();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].trustProxy.hops).toBe(3);
    expect(onChange.mock.calls[0]![1].trustProxy.hops).toBe(2);
  });

  it('reset(config) discards a look that began before it: an older file read then never replaces the applied config', async () => {
    const { fence, clock, onChange } = await setup();
    // Another process writes hops 2, and a look starts loading it...
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.trustProxy.hops = 2;
    });
    await stamp(dirs.dataDir, 2_000);
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => (reached = resolve));
    hooks.holdNextLoad = { reached, until: new Promise<void>((resolve) => (release = resolve)) };
    clock.advance(2_000);
    const looking = fence.check();
    await held;

    // ...while this process writes hops 3 and applies it.
    const written = await updateConfig(dirs.dataDir, (cfg) => {
      cfg.trustProxy.hops = 3;
    });
    await stamp(dirs.dataDir, 3_000);
    fence.reset(applyEnvOverrides(written, {}));
    release();
    await looking;
    expect(fence.current().trustProxy.hops).toBe(3);
    expect(onChange).not.toHaveBeenCalled();

    // The next look loads the file again (hops 3): nothing to report.
    clock.advance(2_000);
    await fence.check();
    expect(fence.current().trustProxy.hops).toBe(3);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('start() and the fence', () => {
  afterEach(async () => {
    hooks.holdNextLoad = undefined;
    hooks.failNextConnect = false;
    await closeTestServers();
    vi.useRealTimers();
  });

  it('puts the config in the state, and a changed port asks once for a restart (config:port)', async () => {
    await writeConfig(dirs.dataDir, sampleConfig({ db: { dialect: 'sqlite' }, port: 3000 }));
    const ctx = bootContext(dirs.dataDir);
    await start(ctx);
    const served = await ctx.served();
    expect((await httpRequest(served.port, '/_health')).status).toBe(200);

    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.port = 8080;
    });
    await stamp(dirs.dataDir, Math.floor(Date.now() / 1000) + 60);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_000 });
    await httpRequest(served.port, '/_health');
    expect(ctx.requestRestart).toHaveBeenCalledTimes(1);
    expect(ctx.requestRestart).toHaveBeenCalledWith('config:port');

    vi.setSystemTime(Date.now() + 3_000);
    await httpRequest(served.port, '/_health');
    expect(ctx.requestRestart).toHaveBeenCalledTimes(1);
  });

  it('the fence is the single writer of state.config: a retry before ready never puts back an older config', async () => {
    // Date only (the retry pause stays real): the fence looks only when the test moves the clock.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await writeConfig(dirs.dataDir, sampleConfig({ db: { dialect: 'sqlite' }, baseUrl: 'http://perpus.sekolah.sch.id' }));
    hooks.failNextConnect = true;
    const ctx = bootContext(dirs.dataDir);
    const started = start(ctx);
    const served = await ctx.served();
    await vi.waitFor(async () => expect(JSON.parse((await httpRequest(served.port, '/_health')).body)).toMatchObject({ status: 'db_unavailable' }));

    // The retry (1 s later) may read config.json itself: hold that load after it has read the file.
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<'held'>((resolve) => (reached = () => resolve('held')));
    hooks.holdNextLoad = { reached, until: new Promise<void>((resolve) => (release = resolve)) };
    const first = await Promise.race([held, started.then(() => 'ready' as const)]);
    hooks.holdNextLoad = undefined;

    // Meanwhile another process switches baseUrl to https, and the fence (step 4 of a request) serves it.
    const changed = async (): Promise<void> => {
      await updateConfig(dirs.dataDir, (cfg) => {
        cfg.baseUrl = 'https://perpus.sekolah.sch.id';
      });
      await stamp(dirs.dataDir, Math.floor(Date.now() / 1000) + 60);
      vi.setSystemTime(Date.now() + 3_000);
      await httpRequest(served.port, '/_health');
    };
    await changed();
    release();
    await started;
    expect(first === 'held' || first === 'ready').toBe(true);

    const reply = await httpRequest(served.port, '/_health');
    expect(reply.status).toBe(200);
    expect(reply.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
    expect(ctx.requestRestart).not.toHaveBeenCalled();
  });
});
