import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { captureIo, openInstalled, writeInput, type CapturedIo } from './cli-support.js';
import { bootContext, useDataDir } from './support.js';

// `node app.js config:set <key> <value>` (Task 24, spec §13.6): baseUrl, trustProxy.hops, allowedOrigins, update.feedUrl
// and port, written through updateConfig (ruling R58), then audited as system.config.update by the cli. When the
// database cannot be reached the change stays and a bilingual warning is printed (exit 0).

const dirs = useDataDir();
const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };

let env: Record<string, string>;

beforeEach(async () => {
  const home = path.join(dirs.root, 'home');
  await fsp.mkdir(home);
  env = { HOME: home };
});

async function cli(argv: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; io: CapturedIo }> {
  const io = captureIo({ ...env, ...extraEnv }, { hostPanels: () => [] });
  const code = await runCli(argv, bootContext(dirs.dataDir), io);
  return { code, io };
}

async function installed(): Promise<void> {
  const file = await writeInput(path.join(dirs.root, 'input'), {
    baseUrl: 'https://perpus.example',
    db: { dialect: 'sqlite' },
    admin: ADMIN,
  });
  const { code, io } = await cli(['install', '--config', file]);
  expect(io.err).toBe('');
  expect(code).toBe(0);
}

const configFile = () => path.join(dirs.dataDir, 'config.json');

async function config(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(configFile(), 'utf8')) as Record<string, unknown>;
}

/** The system.config.update entries of the audit log. */
async function configAudits() {
  const h = await openInstalled(dirs.dataDir);
  try {
    const rows = await h.db
      .selectFrom('audit_log')
      .select(['action', 'actor_type', 'actor_id', 'entity', 'entity_id', 'meta'])
      .where('action', '=', 'system.config.update')
      .orderBy('seq')
      .execute();
    return rows.map((r) => ({ ...r, meta: (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta) as unknown }));
  } finally {
    await h.close();
  }
}

/** A TCP port on 127.0.0.1 that nothing listens on (taken from the OS a moment ago). */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('config:set: success', () => {
  it('baseUrl: the canonical value in config.json (mode 600) and one system.config.update by the cli', async () => {
    await installed();
    const { code, io } = await cli(['config:set', 'baseUrl', 'HTTPS://Perpus.X.sch.id/']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out).toMatch(/config\.json/);
    expect(io.out).toMatch(/baseUrl/);
    expect((await config())['baseUrl']).toBe('https://perpus.x.sch.id');
    if (process.platform !== 'win32') expect((await fsp.stat(configFile())).mode & 0o777).toBe(0o600);
    expect(await configAudits()).toEqual([
      { action: 'system.config.update', actor_type: 'cli', actor_id: null, entity: null, entity_id: null, meta: { fields: ['baseUrl'] } },
    ]);
  });

  it('port: set to 8080, then removed by an empty value; --json says what was set', async () => {
    await installed();
    const set = await cli(['config:set', 'port', '8080', '--json']);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.io.out)).toEqual({ ok: true, command: 'config:set', key: 'port', audited: true });
    expect((await config())['port']).toBe(8080);

    const removed = await cli(['config:set', 'port', '']);
    expect(removed.code).toBe(0);
    expect('port' in (await config())).toBe(false);
    expect((await configAudits()).map((a) => a.meta)).toEqual([{ fields: ['port'] }, { fields: ['port'] }]);
  });

  it('trustProxy.hops: an integer from 0 to 10', async () => {
    await installed();
    expect((await cli(['config:set', 'trustProxy.hops', '2'])).code).toBe(0);
    expect((await config())['trustProxy']).toEqual({ hops: 2 });
  });

  it('allowedOrigins: comma-separated, canonical; an empty value means none', async () => {
    await installed();
    expect((await cli(['config:set', 'allowedOrigins', 'https://WWW.Sekolah.sch.id/, http://192.168.1.10:8080'])).code).toBe(0);
    expect((await config())['allowedOrigins']).toEqual(['https://www.sekolah.sch.id', 'http://192.168.1.10:8080']);
    expect((await cli(['config:set', 'allowedOrigins', ''])).code).toBe(0);
    expect((await config())['allowedOrigins']).toEqual([]);
  });

  it('update.feedUrl: set, then removed by an empty value', async () => {
    await installed();
    expect((await cli(['config:set', 'update.feedUrl', 'https://updates.example/altis/feed.json'])).code).toBe(0);
    expect((await config())['update']).toEqual({ feedUrl: 'https://updates.example/altis/feed.json' });
    expect((await cli(['config:set', 'update.feedUrl', ''])).code).toBe(0);
    expect('update' in (await config())).toBe(false);
  });

  it('a key an environment variable overrides: written all the same, with a bilingual note naming the variable', async () => {
    await installed();
    const port = await cli(['config:set', 'port', '8080'], { PORT: '9000' });
    expect(port.code).toBe(0);
    expect((await config())['port']).toBe(8080);
    expect(port.io.err).toContain('CATATAN: PORT di lingkungan menimpa port');
    expect(port.io.err).toContain('NOTE: PORT in the environment overrides port');
    expect(port.io.err).not.toContain('9000');

    const json = await cli(['config:set', 'port', '8081', '--json'], { ALTIS_PORT: '7000', PORT: '9000' });
    expect(JSON.parse(json.io.out)).toEqual({ ok: true, command: 'config:set', key: 'port', audited: true, shadowedBy: ['ALTIS_PORT', 'PORT'] });

    const base = await cli(['config:set', 'baseUrl', 'https://perpus.example'], { ALTIS_BASE_URL: 'https://env.example' });
    expect(base.io.err).toContain('ALTIS_BASE_URL');
    const hops = await cli(['config:set', 'trustProxy.hops', '1'], { ALTIS_TRUST_PROXY_HOPS: '2' });
    expect(hops.io.err).toContain('ALTIS_TRUST_PROXY_HOPS');
    const feed = await cli(['config:set', 'update.feedUrl', 'https://f.example/altis', '--json'], { ALTIS_UPDATE_FEED_URL: 'https://env.example/altis' });
    expect(JSON.parse(feed.io.out)).toMatchObject({ ok: true, key: 'update.feedUrl', shadowedBy: ['ALTIS_UPDATE_FEED_URL'] });
    // A blank variable is not set; a variable of another key shadows nothing.
    const none = await cli(['config:set', 'port', '8082', '--json'], { PORT: ' ', ALTIS_BASE_URL: 'https://env.example' });
    expect(JSON.parse(none.io.out)).toEqual({ ok: true, command: 'config:set', key: 'port', audited: true });
    expect(none.io.err).toBe('');
  });

  it('keeps everything else of config.json as it was (identity, secrets), and never persists an environment override', async () => {
    await installed();
    const before = await config();
    expect((await cli(['config:set', 'port', '8080'], { ALTIS_DB_PASSWORD: 'env-S3CRET', ALTIS_BASE_URL: 'https://env.example' })).code).toBe(0);
    const after = await config();
    expect(after).toEqual({ ...before, port: 8080 });
    expect(JSON.stringify(after)).not.toContain('env-S3CRET');
  });
});

describe('config:set: refusals', () => {
  it.each([
    ['trustProxy.hops', '11', 'INVALID_CONFIG'],
    ['trustProxy.hops', '-1', 'INVALID_CONFIG'],
    ['trustProxy.hops', 'dua', 'INVALID_CONFIG'],
    ['trustProxy.hops', '', 'INVALID_CONFIG'],
    ['port', '0', 'INVALID_CONFIG'],
    ['port', '65536', 'INVALID_CONFIG'],
    ['port', '80.5', 'INVALID_CONFIG'],
    ['baseUrl', 'https://perpus.example/opac', 'INVALID_BASE_URL'],
    ['baseUrl', '', 'INVALID_BASE_URL'],
    ['allowedOrigins', 'https://a.example, ftp://b.example', 'INVALID_BASE_URL'],
    ['update.feedUrl', 'ftp://updates.example/feed', 'INVALID_CONFIG'],
  ])('%s %j: exit 1, %s, config.json unchanged, nothing audited', async (key, value, error) => {
    await installed();
    const before = await fsp.readFile(configFile(), 'utf8');
    const { code, io } = await cli(['config:set', key, value]);
    expect(code).toBe(1);
    expect(io.err).toMatch(new RegExp(error));
    expect(io.err).toContain(key);
    expect(await fsp.readFile(configFile(), 'utf8')).toBe(before);
    expect(await configAudits()).toEqual([]);
  });

  it('an unknown key: exit 1, USAGE, listing the keys', async () => {
    await installed();
    const { code, io } = await cli(['config:set', 'nope', 'x']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/USAGE/);
    expect(io.err).toMatch(/baseUrl, trustProxy\.hops, allowedOrigins, update\.feedUrl, port/);
    const json = await cli(['config:set', 'db.password', 'x', '--json']);
    expect(JSON.parse(json.io.out)).toMatchObject({ ok: false, command: 'config:set', code: 'USAGE' });
  });

  it('usage: a key and a value, nothing more', async () => {
    for (const argv of [['config:set'], ['config:set', 'port'], ['config:set', 'port', '1', '2'], ['config:set', 'port', '1', '--force']]) {
      const { code, io } = await cli(argv);
      expect(code).toBe(1);
      expect(io.err).toMatch(/USAGE/);
      expect(io.err).toMatch(/config:set <key> <value>/);
    }
  });

  it('before install: exit 1, NOT_INSTALLED, no config.json created', async () => {
    const { code, io } = await cli(['config:set', 'port', '8080']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/NOT_INSTALLED/);
    await expect(fsp.stat(configFile())).rejects.toThrow();
  });
});

describe('config:set: the database cannot be reached', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'SQLite file made unreadable: exit 0, a bilingual warning, the change stays',
    async () => {
      await installed();
      const file = path.join(dirs.dataDir, 'db', 'altis.sqlite');
      await fsp.chmod(file, 0o000);
      try {
        const { code, io } = await cli(['config:set', 'port', '8081']);
        expect(code).toBe(0);
        expect(io.err).toMatch(/PERINGATAN/);
        expect(io.err).toMatch(/WARNING/);
        expect((await config())['port']).toBe(8081);

        const json = await cli(['config:set', 'port', '8082', '--json']);
        expect(json.code).toBe(0);
        expect(json.io.out.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(json.io.out)).toEqual({
          ok: true,
          command: 'config:set',
          key: 'port',
          audited: false,
          warning: expect.stringMatching(/PERINGATAN.*WARNING/s),
        });
        expect((await config())['port']).toBe(8082);
      } finally {
        await fsp.chmod(file, 0o600);
      }
      expect(await configAudits()).toEqual([]);
    },
  );

  it('an audit that fails for another reason (a bad ALTIS_DB_* override): the warning names the code and points to doctor', async () => {
    await installed();
    const { code, io } = await cli(['config:set', 'trustProxy.hops', '3'], { ALTIS_DB_DIALECT: 'oracle' });
    expect(code).toBe(0);
    expect((await config())['trustProxy']).toEqual({ hops: 3 });
    expect(io.err).toContain('INVALID_CONFIG');
    expect(io.err).toMatch(/PERINGATAN.*doctor.*WARNING.*doctor/s);
    expect(io.err).not.toMatch(/tidak dapat dihubungi|could not be reached/);
    expect(await configAudits()).toEqual([]);
  });

  it('a database server that is down (environment override to a closed port): exit 0, a warning, the change stays', async () => {
    await installed();
    const down = { ALTIS_DB_DIALECT: 'mariadb', ALTIS_DB_HOST: '127.0.0.1', ALTIS_DB_PORT: String(await closedPort()), ALTIS_DB_USER: 'u', ALTIS_DB_NAME: 'd' };
    const { code, io } = await cli(['config:set', 'trustProxy.hops', '1'], down);
    expect(code).toBe(0);
    expect(io.err).toMatch(/PERINGATAN/);
    expect(io.err).toMatch(/DB_UNAVAILABLE/);
    expect(io.err).toMatch(/could not be reached/);
    expect((await config())['trustProxy']).toEqual({ hops: 1 });
    expect(await configAudits()).toEqual([]);
  });
});
