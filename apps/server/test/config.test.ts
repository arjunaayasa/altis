import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DIALECTS } from '@altis/db';
import { dataPath } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigSchema,
  feedBaseOf,
  feedSourceOf,
  inspectConfig,
  loadConfig,
  parseConfig,
  updateConfig,
  updateConfigIfChanged,
  validateBaseUrl,
  writeConfig,
  type Config,
} from '../src/config.js';
import { sampleConfig, useDataDir } from './support.js';

const dirs = useDataDir();

afterEach(() => {
  vi.unstubAllGlobals();
});

function configFile(): string {
  return path.join(dirs.dataDir, 'config.json');
}

/** Writes `value` as config.json exactly as given (a hand edit), creating DATA_DIR. */
async function writeRaw(value: unknown): Promise<void> {
  await fsp.mkdir(dirs.dataDir, { recursive: true });
  await fsp.writeFile(configFile(), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

/** `config` without the top-level key `key`. */
function omit(config: Config, key: keyof Config): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...config };
  delete copy[key];
  return copy;
}

/** The DomainError `fn` rejects with. */
async function failure(fn: () => Promise<unknown>): Promise<{ code: string; status: number; meta?: Record<string, unknown>; message: string }> {
  try {
    await fn();
  } catch (error) {
    if (!isDomainError(error)) throw error;
    return error;
  }
  throw new Error('expected a DomainError, but nothing was thrown');
}

describe('writeConfig and loadConfig', () => {
  it('round-trips: what was written is what is loaded', async () => {
    const config = sampleConfig({ port: 8080, update: { feedUrl: 'https://updates.example.com/feed.json' } });
    await writeConfig(dirs.dataDir, config);
    expect(await loadConfig(dirs.dataDir, {})).toEqual(config);
  });

  it('round-trips a config without the optional keys, which stay absent in the file', async () => {
    const config = sampleConfig();
    await writeConfig(dirs.dataDir, config);
    expect(await loadConfig(dirs.dataDir, {})).toEqual(config);
    const onDisk = JSON.parse(await fsp.readFile(configFile(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk)).toEqual([
      'version',
      'baseUrl',
      'trustProxy',
      'allowedOrigins',
      'db',
      'secrets',
      'keyring',
      'install',
      'installState',
      'log',
    ]);
  });

  it.skipIf(process.platform === 'win32')('writes config.json (and its .bak) with mode 600', async () => {
    await writeConfig(dirs.dataDir, sampleConfig());
    await writeConfig(dirs.dataDir, sampleConfig({ installState: 'migrate' }));
    expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${configFile()}.bak`).mode & 0o777).toBe(0o600);
  });

  it('creates DATA_DIR when it does not exist yet, and leaves no lock or temporary file behind', async () => {
    await writeConfig(dirs.dataDir, sampleConfig());
    expect(fs.readdirSync(dirs.dataDir)).toEqual(['config.json']);
  });

  it('keeps the previous config as config.json.bak', async () => {
    await writeConfig(dirs.dataDir, sampleConfig({ installState: 'migrate' }));
    await writeConfig(dirs.dataDir, sampleConfig({ installState: 'complete' }));
    const bak = JSON.parse(await fsp.readFile(`${configFile()}.bak`, 'utf8')) as Config;
    expect(bak.installState).toBe('migrate');
  });

  it('serialises concurrent writers on config.lock: every write completes and the file is whole', async () => {
    const states = ['migrate', 'profile', 'admin', 'cron', 'complete'] as const;
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    await Promise.all(states.map((installState) => writeConfig(dirs.dataDir, sampleConfig({ installState }))));
    const loaded = await loadConfig(dirs.dataDir, {});
    expect(states).toContain(loaded!.installState);
    expect(fs.readdirSync(dirs.dataDir).sort()).toEqual(['config.json', 'config.json.bak']);
  });

  it('writes to DATA_DIR/config.json (area root of dataPath)', async () => {
    await writeConfig(dirs.dataDir, sampleConfig());
    expect(dataPath(dirs.dataDir, 'root', 'config.json')).toBe(configFile());
    expect(fs.existsSync(configFile())).toBe(true);
  });

  it('writes the normalised baseUrl', async () => {
    await writeConfig(dirs.dataDir, sampleConfig({ baseUrl: 'HTTPS://Perpus.Sekolah.SCH.id/' }));
    expect((await loadConfig(dirs.dataDir, {}))!.baseUrl).toBe('https://perpus.sekolah.sch.id');
  });

  it('refuses to write an invalid config, and leaves the existing file alone', async () => {
    await writeConfig(dirs.dataDir, sampleConfig());
    const before = await fsp.readFile(configFile(), 'utf8');
    const bad = { ...sampleConfig(), extra: 1 } as unknown as Config;
    expect(await failure(() => writeConfig(dirs.dataDir, bad))).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(await failure(() => writeConfig(dirs.dataDir, sampleConfig({ baseUrl: 'https://x/perpus' })))).toMatchObject({
      code: 'INVALID_BASE_URL',
    });
    expect(await fsp.readFile(configFile(), 'utf8')).toBe(before);
  });
});

describe('loadConfig: not installed, damaged files', () => {
  it('returns null when config.json does not exist (also when DATA_DIR does not), whatever the environment says', async () => {
    expect(await loadConfig(dirs.dataDir, {})).toBeNull();
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    expect(await loadConfig(dirs.dataDir, { ALTIS_DB_HOST: 'db.example.com' })).toBeNull();
  });

  it('recovers from config.json.bak when config.json is truncated', async () => {
    const config = sampleConfig();
    await writeConfig(dirs.dataDir, config);
    await writeConfig(dirs.dataDir, config); // now there is a .bak
    await fsp.writeFile(configFile(), '{"version": 1, "baseUr');
    expect(await loadConfig(dirs.dataDir, {})).toEqual(config);
  });

  it('treats a JSON value that is not an object as damaged, and uses the .bak', async () => {
    const config = sampleConfig();
    await writeConfig(dirs.dataDir, config);
    await writeConfig(dirs.dataDir, config);
    await fsp.writeFile(configFile(), 'null');
    expect(await loadConfig(dirs.dataDir, {})).toEqual(config);
    await fsp.writeFile(configFile(), '[]');
    expect(await loadConfig(dirs.dataDir, {})).toEqual(config);
  });

  it('fails with STATE_CORRUPT when config.json and its .bak are both unusable', async () => {
    await writeRaw('not json at all');
    await fsp.writeFile(`${configFile()}.bak`, '{');
    expect(await failure(() => loadConfig(dirs.dataDir, {}))).toMatchObject({ code: 'STATE_CORRUPT' });
  });

  it('does not fall back to the .bak for a config that parses but is invalid: the operator must see the error', async () => {
    const config = sampleConfig();
    await writeConfig(dirs.dataDir, config);
    await writeConfig(dirs.dataDir, config);
    await writeRaw({ ...config, installState: 'nonsense' });
    expect(await failure(() => loadConfig(dirs.dataDir, {}))).toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('accepts a config.json that starts with a UTF-8 byte-order mark (Notepad)', async () => {
    const config = sampleConfig();
    await writeRaw(`${String.fromCharCode(0xfeff)}${JSON.stringify(config)}`);
    expect(await loadConfig(dirs.dataDir, {})).toEqual(config);
  });
});

describe('loadConfig: known keys strictly, unknown keys accepted (D1d-2)', () => {
  // Same secrets in every case, so that only the one change under test differs.
  const base = sampleConfig();

  it('accepts a top-level unknown key, names it, and never hands it to the code', async () => {
    const raw = { ...base, surprise: 'TOP-SECRET-VALUE' };
    await writeRaw(raw);
    expect(await loadConfig(dirs.dataDir, {})).toEqual(base);
    expect(await inspectConfig(dirs.dataDir, {})).toEqual({ config: base, unknownKeys: ['surprise'] });
    expect(parseConfig(raw)).toEqual({ config: base, unknownKeys: ['surprise'] });
  });

  it.each([
    ['db', { ...base.db, extra: 1 }, 'db.extra'],
    ['secrets', { ...base.secrets, extra: 1 }, 'secrets.extra'],
    ['trustProxy', { hops: 1, extra: 1 }, 'trustProxy.extra'],
    ['install', { ...base.install, extra: 1 }, 'install.extra'],
    ['log', { level: 'info', extra: 1 }, 'log.extra'],
    ['keyring', [{ ...base.keyring[0], extra: 1 }], 'keyring.0.extra'],
    ['update', { feedUrl: 'https://u.example.com/f.json', extra: 1 }, 'update.extra'],
  ])('accepts an unknown key inside %s and names it by its dotted path', async (key, value, keyPath) => {
    await writeRaw({ ...base, [key]: value });
    const inspected = await inspectConfig(dirs.dataDir, {});
    expect(inspected!.unknownKeys).toEqual([keyPath]);
    expect(JSON.stringify(inspected!.config)).not.toContain('extra');
    expect(JSON.stringify(await loadConfig(dirs.dataDir, {}))).not.toContain('extra');
  });

  it('the brief case: futureKey and update.channelX load, and are named sorted', async () => {
    const raw = { ...base, futureKey: { a: 1 }, update: { feedUrl: 'https://f.example/altis', channelX: 1 } };
    await writeRaw(raw);
    expect(await loadConfig(dirs.dataDir, {})).toEqual({ ...base, update: { feedUrl: 'https://f.example/altis' } });
    expect(parseConfig(raw).unknownKeys).toEqual(['futureKey', 'update.channelX']);
    expect((await inspectConfig(dirs.dataDir, {}))!.unknownKeys).toEqual(['futureKey', 'update.channelX']);
  });

  it('lists unknown keys at several levels in sorted order, and none for a config without any', () => {
    const raw = {
      zeta: 1,
      ...base,
      alpha: { nested: true },
      db: { ...base.db, ssl: { ca: 'x' } },
      keyring: [{ ...base.keyring[0], createdAt: '2027-01-01' }],
    };
    expect(parseConfig(raw).unknownKeys).toEqual(['alpha', 'db.ssl', 'keyring.0.createdAt', 'zeta']);
    expect(parseConfig(base).unknownKeys).toEqual([]);
  });

  it('a key named like an Object.prototype member is unknown, not known (no prototype lookup), and __proto__ is kept as data', async () => {
    const text = JSON.stringify({ ...base, toString: 1, constructor: { x: 1 } }).replace(/^\{/, '{"__proto__":{"installState":"migrate"},');
    await writeRaw(text);
    const inspected = await inspectConfig(dirs.dataDir, {});
    expect(inspected!.unknownKeys).toEqual(['__proto__', 'constructor', 'toString']);
    expect(inspected!.config).toEqual(base);
    expect(Object.getPrototypeOf(inspected!.config)).toBe(Object.prototype);
  });

  it('still refuses a known key of the wrong type, and a version other than 1, with unknown keys present', async () => {
    await writeRaw({ ...base, futureKey: 1, trustProxy: { hops: 'x' } });
    const error = await failure(() => loadConfig(dirs.dataDir, {}));
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.meta).toEqual({ issues: [{ path: 'trustProxy.hops', code: 'invalid_type' }] });
    await writeRaw({ ...base, futureKey: 1, version: 2 });
    expect(await failure(() => loadConfig(dirs.dataDir, {}))).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(() => parseConfig({ ...base, version: 2 })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('never puts the value of an unknown key in an error about a known one', async () => {
    await writeRaw({ ...base, futureSecret: 'TOP-SECRET-VALUE', log: { level: 'trace' } });
    const error = await failure(() => loadConfig(dirs.dataDir, {}));
    expect(error.code).toBe('INVALID_CONFIG');
    expect(JSON.stringify([error.message, error.meta])).not.toContain('TOP-SECRET-VALUE');
  });

  it('never puts a secret in the error, whichever field is wrong', async () => {
    await writeRaw({ ...base, db: { ...base.db, port: 'not-a-port' }, secrets: { ...base.secrets, cronToken: 'short' } });
    const error = await failure(() => loadConfig(dirs.dataDir, {}));
    expect(error.code).toBe('INVALID_CONFIG');
    expect((error.meta!['issues'] as { path: string }[]).map((i) => i.path).sort()).toEqual(['db.port', 'secrets.cronToken']);
    const text = JSON.stringify([error.message, error.meta]);
    for (const secret of ['not-a-port', 'short', base.secrets.sessionKey, base.db.password!, base.keyring[0]!.key, base.install.privateKey]) {
      expect(text).not.toContain(secret);
    }
  });

  const SECRET = base.secrets.sessionKey;
  it.each<[string, (c: Config) => unknown, string]>([
    ['a version other than 1', (c) => ({ ...c, version: 2 }), 'version'],
    ['a missing version', (c) => omit(c, 'version'), 'version'],
    ['a missing baseUrl', (c) => omit(c, 'baseUrl'), 'baseUrl'],
    ['a baseUrl that is not text', (c) => ({ ...c, baseUrl: 5 }), 'baseUrl'],
    ['a port of 0', (c) => ({ ...c, port: 0 }), 'port'],
    ['a port above 65535', (c) => ({ ...c, port: 65536 }), 'port'],
    ['a fractional port', (c) => ({ ...c, port: 80.5 }), 'port'],
    ['a port given as text', (c) => ({ ...c, port: '80' }), 'port'],
    ['negative trustProxy hops', (c) => ({ ...c, trustProxy: { hops: -1 } }), 'trustProxy.hops'],
    ['too many trustProxy hops', (c) => ({ ...c, trustProxy: { hops: 11 } }), 'trustProxy.hops'],
    ['fractional trustProxy hops', (c) => ({ ...c, trustProxy: { hops: 1.5 } }), 'trustProxy.hops'],
    ['allowedOrigins that is not a list', (c) => ({ ...c, allowedOrigins: 'https://a.example' }), 'allowedOrigins'],
    ['an allowed origin with a path', (c) => ({ ...c, allowedOrigins: ['https://a.example/x'] }), 'allowedOrigins.0'],
    ['an allowed origin that is not a URL', (c) => ({ ...c, allowedOrigins: ['*'] }), 'allowedOrigins.0'],
    ['an unknown database dialect', (c) => ({ ...c, db: { ...c.db, dialect: 'oracle' } }), 'db.dialect'],
    ['a database port of 0', (c) => ({ ...c, db: { ...c.db, port: 0 } }), 'db.port'],
    ['a database port as text', (c) => ({ ...c, db: { ...c.db, port: '3306' } }), 'db.port'],
    ['a missing db', (c) => omit(c, 'db'), 'db'],
    ['a sessionKey that is not 32 bytes', (c) => ({ ...c, secrets: { ...c.secrets, sessionKey: 'AAAA' } }), 'secrets.sessionKey'],
    ['a cronToken that is not base64url', (c) => ({ ...c, secrets: { ...c.secrets, cronToken: `${'+'.repeat(43)}` } }), 'secrets.cronToken'],
    ['an empty keyring', (c) => ({ ...c, keyring: [] }), 'keyring'],
    ['a keyring without an active key', (c) => ({ ...c, keyring: [{ ...c.keyring[0], active: false }] }), 'keyring'],
    [
      'a keyring with two active keys',
      (c) => ({ ...c, keyring: [c.keyring[0], { kid: 'OTHERKID', key: c.keyring[0]!.key, active: true }] }),
      'keyring',
    ],
    [
      'a keyring with a repeated kid',
      (c) => ({ ...c, keyring: [c.keyring[0], { ...c.keyring[0], active: false }] }),
      'keyring',
    ],
    ['a kid with a colon', (c) => ({ ...c, keyring: [{ ...c.keyring[0], kid: 'a:b' }] }), 'keyring.0.kid'],
    ['a keyring key that is not 32 bytes', (c) => ({ ...c, keyring: [{ ...c.keyring[0], key: SECRET.slice(2) }] }), 'keyring.0.key'],
    ['an install id that is not a ULID', (c) => ({ ...c, install: { ...c.install, id: 'install-1' } }), 'install.id'],
    ['a public key that is not 32 bytes', (c) => ({ ...c, install: { ...c.install, publicKey: 'AAAA' } }), 'install.publicKey'],
    ['a private key that is not a key', (c) => ({ ...c, install: { ...c.install, privateKey: 'AAAA' } }), 'install.privateKey'],
    [
      'a private key that does not belong to the public key',
      (c) => ({ ...c, install: { ...c.install, publicKey: sampleConfig().install.publicKey } }),
      'install.publicKey',
    ],
    ['an install date that is not a date', (c) => ({ ...c, install: { ...c.install, trialStartedAt: '2026-02-30' } }), 'install.trialStartedAt'],
    ['an install date with a time', (c) => ({ ...c, install: { ...c.install, trialStartedAt: '2026-02-03T00:00:00Z' } }), 'install.trialStartedAt'],
    ['an install runtime that is not a runtime', (c) => ({ ...c, install: { ...c.install, runtime: 'cpanel' } }), 'install.runtime'],
    ['an unknown installState', (c) => ({ ...c, installState: 'half' }), 'installState'],
    // The community wizard has no licence step (ruling R8): a config left at it does not parse.
    ['the installState of a licence step', (c) => ({ ...c, installState: 'license' }), 'installState'],
    ['a missing installState', (c) => omit(c, 'installState'), 'installState'],
    ['an update feed that is not an http(s) URL', (c) => ({ ...c, update: { feedUrl: 'ftp://x/feed' } }), 'update.feedUrl'],
    ['an unknown log level', (c) => ({ ...c, log: { level: 'trace' } }), 'log.level'],
    ['a missing log', (c) => omit(c, 'log'), 'log'],
  ])('rejects %s', async (_name, change, issuePath) => {
    await writeRaw(change(sampleConfig()));
    const error = await failure(() => loadConfig(dirs.dataDir, {}));
    expect(error.code).toBe('INVALID_CONFIG');
    const paths = (error.meta!['issues'] as { path: string }[]).map((i) => i.path);
    expect(paths).toContain(issuePath);
  });

  it('accepts every dialect the db package supports, and every install state and log level', async () => {
    for (const dialect of DIALECTS) {
      expect(ConfigSchema.safeParse(sampleConfig({ db: { dialect } })).success).toBe(true);
    }
    for (const installState of ['complete', 'migrate', 'profile', 'admin', 'cron'] as const) {
      expect(ConfigSchema.safeParse(sampleConfig({ installState })).success).toBe(true);
    }
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      expect(ConfigSchema.safeParse(sampleConfig({ log: { level } })).success).toBe(true);
    }
  });

  it('install.runtime (ruling R66): any of the six runtimes, or absent (a config written before it was recorded)', () => {
    const base = sampleConfig();
    for (const runtime of ['passenger', 'litespeed', 'pm2', 'docker', 'service', 'standalone'] as const) {
      expect(ConfigSchema.safeParse({ ...base, install: { ...base.install, runtime } }).success).toBe(true);
    }
    expect(ConfigSchema.safeParse(base).success).toBe(true);
  });

  it('reports a bad baseUrl as INVALID_BASE_URL', async () => {
    await writeRaw({ ...sampleConfig(), baseUrl: 'https://perpus.example.com/perpus' });
    expect(await failure(() => loadConfig(dirs.dataDir, {}))).toMatchObject({
      code: 'INVALID_BASE_URL',
      meta: { reason: 'path' },
    });
  });

  it('normalises the baseUrl and the allowed origins it loads', async () => {
    await writeRaw({ ...sampleConfig(), baseUrl: 'HTTPS://Perpus.Example.COM/', allowedOrigins: ['HTTP://LAN.local:3000'] });
    const loaded = await loadConfig(dirs.dataDir, {});
    expect(loaded!.baseUrl).toBe('https://perpus.example.com');
    expect(loaded!.allowedOrigins).toEqual(['http://lan.local:3000']);
  });
});

describe('loadConfig: environment overrides', () => {
  async function installed(config = sampleConfig()): Promise<Config> {
    await writeConfig(dirs.dataDir, config);
    return config;
  }

  it('ALTIS_DB_HOST overrides the file value', async () => {
    const config = await installed();
    const loaded = await loadConfig(dirs.dataDir, { ALTIS_DB_HOST: 'mysql.docker' });
    expect(loaded).toEqual({ ...config, db: { ...config.db, host: 'mysql.docker' } });
  });

  it.each([
    ['ALTIS_BASE_URL', 'HTTP://Lan.Example:8080', (c: Config) => ({ ...c, baseUrl: 'http://lan.example:8080' })],
    ['ALTIS_DB_DIALECT', 'POSTGRES', (c: Config) => ({ ...c, db: { ...c.db, dialect: 'postgres' as const } })],
    ['ALTIS_DB_HOST', 'pg.internal', (c: Config) => ({ ...c, db: { ...c.db, host: 'pg.internal' } })],
    ['ALTIS_DB_PORT', '5432', (c: Config) => ({ ...c, db: { ...c.db, port: 5432 } })],
    ['ALTIS_DB_USER', 'svc', (c: Config) => ({ ...c, db: { ...c.db, user: 'svc' } })],
    ['ALTIS_DB_PASSWORD', ' s3cr3t with spaces ', (c: Config) => ({ ...c, db: { ...c.db, password: ' s3cr3t with spaces ' } })],
    ['ALTIS_DB_NAME', 'perpus', (c: Config) => ({ ...c, db: { ...c.db, database: 'perpus' } })],
    ['ALTIS_TRUST_PROXY_HOPS', '2', (c: Config) => ({ ...c, trustProxy: { hops: 2 } })],
    ['ALTIS_LOG_LEVEL', 'DEBUG', (c: Config) => ({ ...c, log: { level: 'debug' as const } })],
    ['ALTIS_UPDATE_FEED_URL', ' https://feed.example/altis ', (c: Config) => ({ ...c, update: { feedUrl: 'https://feed.example/altis' } })],
  ])('%s overrides the file value', async (name, value, expected) => {
    const config = await installed();
    expect(await loadConfig(dirs.dataDir, { [name]: value })).toEqual(expected(config));
  });

  it('applies several overrides together', async () => {
    const config = await installed();
    const loaded = await loadConfig(dirs.dataDir, { ALTIS_DB_HOST: 'h', ALTIS_DB_PORT: '3307', ALTIS_LOG_LEVEL: 'warn' });
    expect(loaded).toEqual({ ...config, db: { ...config.db, host: 'h', port: 3307 }, log: { level: 'warn' } });
  });

  it.each(['', '   ', '\t'])('treats a blank variable (%j) as not set', async (blank) => {
    const config = await installed();
    const env = {
      ALTIS_BASE_URL: blank,
      ALTIS_DB_DIALECT: blank,
      ALTIS_DB_HOST: blank,
      ALTIS_DB_PORT: blank,
      ALTIS_DB_USER: blank,
      ALTIS_DB_PASSWORD: blank,
      ALTIS_DB_NAME: blank,
      ALTIS_TRUST_PROXY_HOPS: blank,
      ALTIS_LOG_LEVEL: blank,
      ALTIS_UPDATE_FEED_URL: blank,
    };
    expect(await loadConfig(dirs.dataDir, env)).toEqual(config);
  });

  it('ignores variables that are not on the list, and an undefined value', async () => {
    const config = await installed();
    expect(await loadConfig(dirs.dataDir, { ALTIS_PORT: '9999', PORT: '1', ALTIS_DB_HOST: undefined })).toEqual(config);
  });

  it('can switch the dialect to sqlite and keep the file value of the other fields', async () => {
    const config = await installed();
    const loaded = await loadConfig(dirs.dataDir, { ALTIS_DB_DIALECT: 'sqlite' });
    expect(loaded!.db).toEqual({ ...config.db, dialect: 'sqlite' });
  });

  it('never writes an override back: the file is unchanged, and a later load without the variable sees the old value', async () => {
    const config = await installed();
    const before = await fsp.readFile(configFile(), 'utf8');
    await loadConfig(dirs.dataDir, { ALTIS_DB_HOST: 'override', ALTIS_DB_PASSWORD: 'override-pw' });
    expect(await fsp.readFile(configFile(), 'utf8')).toBe(before);
    expect(await loadConfig(dirs.dataDir, {})).toEqual(config);
  });

  it.each([
    ['ALTIS_DB_PORT', 'abc'],
    ['ALTIS_DB_PORT', '0'],
    ['ALTIS_DB_PORT', '65536'],
    ['ALTIS_DB_PORT', '33.06'],
    ['ALTIS_DB_PORT', '-1'],
    ['ALTIS_DB_PORT', '0x10'],
    ['ALTIS_DB_PORT', '1e3'],
    ['ALTIS_TRUST_PROXY_HOPS', 'abc'],
    ['ALTIS_TRUST_PROXY_HOPS', '-1'],
    ['ALTIS_TRUST_PROXY_HOPS', '11'],
    ['ALTIS_TRUST_PROXY_HOPS', '1.5'],
    ['ALTIS_DB_DIALECT', 'oracle'],
    ['ALTIS_LOG_LEVEL', 'verbose'],
    ['ALTIS_UPDATE_FEED_URL', 'ftp://x'],
    ['ALTIS_UPDATE_FEED_URL', 'feed.example/altis'],
    ['ALTIS_UPDATE_FEED_URL', 'https://user:hunter2@feed.example/altis'],
    ['ALTIS_UPDATE_FEED_URL', 'https://feed.example/al tis'],
    ['ALTIS_UPDATE_FEED_URL', 'https://feed.example/\naltis'],
  ])('rejects %s=%s with INVALID_CONFIG naming the variable, not the value', async (name, value) => {
    await installed();
    const error = await failure(() => loadConfig(dirs.dataDir, { [name]: value }));
    expect(error).toMatchObject({ code: 'INVALID_CONFIG', status: 422, meta: { env: name } });
    expect(JSON.stringify([error.message, error.meta])).not.toContain(`"${value}"`);
    expect(error.message).toContain(name);
  });

  it('rejects an invalid ALTIS_BASE_URL with INVALID_BASE_URL, naming the variable and keeping credentials out', async () => {
    await installed();
    const error = await failure(() => loadConfig(dirs.dataDir, { ALTIS_BASE_URL: 'https://admin:hunter2@x.example/perpus' }));
    expect(error).toMatchObject({ code: 'INVALID_BASE_URL', meta: { env: 'ALTIS_BASE_URL' } });
    expect(JSON.stringify([error.message, error.meta])).not.toContain('hunter2');
  });

  it('validates the file on its own: an override does not repair an invalid file', async () => {
    await writeRaw({ ...sampleConfig(), log: { level: 'trace' } });
    expect(await failure(() => loadConfig(dirs.dataDir, { ALTIS_LOG_LEVEL: 'debug' }))).toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('never repeats the credentials of a refused ALTIS_UPDATE_FEED_URL', async () => {
    await installed();
    const error = await failure(() => loadConfig(dirs.dataDir, { ALTIS_UPDATE_FEED_URL: 'https://user:hunter2@feed.example/altis' }));
    expect(error).toMatchObject({ code: 'INVALID_CONFIG', meta: { env: 'ALTIS_UPDATE_FEED_URL' } });
    expect(JSON.stringify([error.message, error.meta])).not.toContain('hunter2');
  });
});

describe('feed URL sources: feedBaseOf and feedSourceOf (§9.6)', () => {
  const withFeed = sampleConfig({ update: { feedUrl: 'https://f.example/altis' } });
  const without = sampleConfig();

  /** What feedBaseOf throws, or undefined. */
  function thrown(fn: () => unknown): unknown {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('ALTIS_UPDATE_FEED_URL wins over config.update.feedUrl and over the build', () => {
    vi.stubGlobal('__FEED_URL__', 'https://build.example/altis');
    const env = { ALTIS_UPDATE_FEED_URL: 'https://feed.example/altis' };
    expect(feedBaseOf(withFeed, env)).toBe('https://feed.example/altis');
    expect(feedSourceOf(withFeed, env)).toBe('env');
    expect(feedBaseOf(without, { ALTIS_UPDATE_FEED_URL: ' https://feed.example/altis\n' })).toBe('https://feed.example/altis');
  });

  it('config.update.feedUrl wins over the build', () => {
    vi.stubGlobal('__FEED_URL__', 'https://build.example/altis');
    expect(feedBaseOf(withFeed, {})).toBe('https://f.example/altis');
    expect(feedSourceOf(withFeed, {})).toBe('config');
  });

  it("the build's embedded __FEED_URL__ when neither is set", () => {
    vi.stubGlobal('__FEED_URL__', 'https://build.example/altis');
    expect(feedBaseOf(without, {})).toBe('https://build.example/altis');
    expect(feedSourceOf(without, { ALTIS_UPDATE_FEED_URL: '  ' })).toBe('build');
  });

  it("none: the '' an unconfigured build embeds counts as none", () => {
    vi.stubGlobal('__FEED_URL__', '');
    expect(feedBaseOf(without, {})).toBeNull();
    expect(feedBaseOf(without, { ALTIS_UPDATE_FEED_URL: '' })).toBeNull();
    expect(feedSourceOf(without, {})).toBeNull();
  });

  it.each(['ftp://x', 'not a url', 'https://user:pw@feed.example/altis'])('ALTIS_UPDATE_FEED_URL=%s → INVALID_CONFIG naming the variable', (value) => {
    const error = thrown(() => feedBaseOf(withFeed, { ALTIS_UPDATE_FEED_URL: value }));
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'INVALID_CONFIG', status: 422, meta: { env: 'ALTIS_UPDATE_FEED_URL' } });
    expect(thrown(() => feedSourceOf(withFeed, { ALTIS_UPDATE_FEED_URL: value }))).toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('a config loaded with ALTIS_UPDATE_FEED_URL carries it, and its source is still the environment', async () => {
    await writeConfig(dirs.dataDir, withFeed);
    const env = { ALTIS_UPDATE_FEED_URL: 'https://feed.example/altis' };
    const loaded = (await loadConfig(dirs.dataDir, env))!;
    expect(loaded.update).toEqual({ feedUrl: 'https://feed.example/altis' });
    expect(feedBaseOf(loaded, env)).toBe('https://feed.example/altis');
    expect(feedSourceOf(loaded, env)).toBe('env');
    // never written back
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.installState = 'complete';
    });
    expect(JSON.parse(await fsp.readFile(configFile(), 'utf8'))).toMatchObject({ update: { feedUrl: 'https://f.example/altis' } });
  });
});

describe('validateBaseUrl', () => {
  it('accepts https://perpus.sekolah.sch.id and returns it unchanged', () => {
    expect(validateBaseUrl('https://perpus.sekolah.sch.id')).toBe('https://perpus.sekolah.sch.id');
  });

  it.each([
    ['https://perpus.sekolah.sch.id/', 'https://perpus.sekolah.sch.id'],
    ['HTTPS://Perpus.Sekolah.SCH.ID', 'https://perpus.sekolah.sch.id'],
    ['  https://perpus.sekolah.sch.id/  ', 'https://perpus.sekolah.sch.id'],
    ['http://perpus.local', 'http://perpus.local'],
    ['http://192.168.1.10:3000', 'http://192.168.1.10:3000'],
    ['http://localhost:3000/', 'http://localhost:3000'],
    ['https://perpus.example.com:8443', 'https://perpus.example.com:8443'],
    ['https://perpus.example.com:443', 'https://perpus.example.com'], // the default port is dropped
    ['http://[::1]:3000', 'http://[::1]:3000'],
    // WHATWG URL: a Unicode host comes back in punycode
    ['https://perpustakaan.bücher.example', 'https://perpustakaan.xn--bcher-kva.example'],
  ])('accepts %s as %s: an origin, lower-cased, without a trailing slash', (input, expected) => {
    expect(validateBaseUrl(input)).toBe(expected);
  });

  it.each([
    ['https://x/perpus', 'path'],
    ['https://x/perpus/', 'path'],
    ['https://x//', 'path'],
    ['https://x\\perpus', 'path'],
    ['https://x?a=1', 'query'],
    ['https://x/?a=1', 'query'],
    ['https://x?', 'query'],
    ['https://x/perpus?a=1', 'path'],
    ['https://x#top', 'fragment'],
    ['https://x/#', 'fragment'],
    ['https://user@x.example', 'userinfo'],
    ['https://user:pw@x.example', 'userinfo'],
    ['ftp://x.example', 'scheme'],
    ['ws://x.example', 'scheme'],
    ['perpus.sekolah.sch.id', 'not_a_url'],
    ['//perpus.sekolah.sch.id', 'not_a_url'],
    ['javascript:alert(1)', 'not_a_url'],
    ['https:/x.example', 'not_a_url'],
    ['https:x.example', 'not_a_url'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['https://', 'invalid_host'],
    ['https://exa mple.com', 'invalid_characters'],
    ['https://exa\nmple.com', 'invalid_characters'],
    ['https://x.example:0', 'port'],
    ['https://x.example:99999', 'invalid_host'],
  ])('rejects %j with INVALID_BASE_URL (reason %s)', (input, reason) => {
    let thrown: unknown;
    try {
      validateBaseUrl(input);
    } catch (error) {
      thrown = error;
    }
    expect(isDomainError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: 'INVALID_BASE_URL', status: 422, meta: { reason } });
  });

  it('trims surrounding whitespace, including a trailing newline from a pasted value', () => {
    expect(validateBaseUrl('https://example.com\n')).toBe('https://example.com');
  });

  it('rejects a value that is not a string', () => {
    expect(() => validateBaseUrl(undefined as unknown as string)).toThrow(expect.objectContaining({ code: 'INVALID_BASE_URL' }));
  });

  it('never repeats the rejected value (it may carry credentials), only the reason', () => {
    try {
      validateBaseUrl('https://admin:hunter2@x.example/perpus');
    } catch (error) {
      expect(JSON.stringify([(error as Error).message, (error as { meta: unknown }).meta])).not.toContain('hunter2');
      return;
    }
    throw new Error('expected a rejection');
  });
});

describe('updateConfig (R58)', () => {
  async function installed(config = sampleConfig()): Promise<Config> {
    await writeConfig(dirs.dataDir, config);
    return config;
  }

  /** The config.json on disk, as written (no schema, no overrides). */
  async function onDisk(): Promise<Config> {
    return JSON.parse(await fsp.readFile(configFile(), 'utf8')) as Config;
  }

  it('applies a change made in place and returns the config it wrote', async () => {
    const config = await installed(sampleConfig({ installState: 'migrate' }));
    const written = await updateConfig(dirs.dataDir, (cfg) => {
      cfg.installState = 'complete';
    });
    expect(written).toEqual({ ...config, installState: 'complete' });
    expect(await onDisk()).toEqual(written);
  });

  it('applies a replacement config returned by mutate', async () => {
    const config = await installed();
    const written = await updateConfig(dirs.dataDir, (cfg) => ({ ...cfg, log: { level: 'debug' as const } }));
    expect(written).toEqual({ ...config, log: { level: 'debug' } });
    expect(await onDisk()).toEqual(written);
  });

  it('never persists environment overrides: db.host and db.password stay as in the file', async () => {
    const config = await installed();
    const env = { ALTIS_DB_PASSWORD: 'from-the-environment', ALTIS_DB_HOST: 'env-host', ALTIS_LOG_LEVEL: 'debug' };
    // what a careless caller would do: load (with overrides) in order to change, then write it all back
    expect((await loadConfig(dirs.dataDir, env))!.db).toMatchObject({ host: 'env-host', password: 'from-the-environment' });

    const written = await updateConfig(dirs.dataDir, (cfg) => {
      cfg.installState = 'profile';
    });
    expect(written.db).toEqual(config.db);
    expect(written.log).toEqual(config.log);
    const file = await onDisk();
    expect(file).toEqual({ ...config, installState: 'profile' });
    expect(JSON.stringify(file)).not.toMatch(/from-the-environment|env-host/);
    // the overrides still apply when the file is read for use
    expect((await loadConfig(dirs.dataDir, env))!.db).toMatchObject({ host: 'env-host', password: 'from-the-environment' });
  });

  it('hands mutate a copy: a mutation that is then rejected changes nothing', async () => {
    await installed();
    const before = await fsp.readFile(configFile(), 'utf8');
    const error = await failure(() =>
      updateConfig(dirs.dataDir, (cfg) => {
        cfg.trustProxy.hops = 99; // not valid
      }),
    );
    expect(error).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(await fsp.readFile(configFile(), 'utf8')).toBe(before);
  });

  it('refuses a result with an unknown key or a bad baseUrl, and leaves the file alone', async () => {
    await installed();
    const before = await fsp.readFile(configFile(), 'utf8');
    expect(
      await failure(() => updateConfig(dirs.dataDir, (cfg) => ({ ...cfg, extra: true }) as unknown as Config)),
    ).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(
      await failure(() => updateConfig(dirs.dataDir, (cfg) => ({ ...cfg, baseUrl: 'https://x.example/perpus' }))),
    ).toMatchObject({ code: 'INVALID_BASE_URL' });
    expect(await fsp.readFile(configFile(), 'utf8')).toBe(before);
  });

  it('propagates an error thrown by mutate, releases the lock and keeps the file', async () => {
    await installed();
    const before = await fsp.readFile(configFile(), 'utf8');
    await expect(
      updateConfig(dirs.dataDir, () => {
        throw new Error('mutate failed');
      }),
    ).rejects.toThrow('mutate failed');
    expect(await fsp.readFile(configFile(), 'utf8')).toBe(before);
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.installState = 'admin';
    }); // the lock was released
    expect((await onDisk()).installState).toBe('admin');
  });

  it('fails with NOT_INSTALLED when there is no config, and does not create one', async () => {
    expect(await failure(() => updateConfig(dirs.dataDir, () => undefined))).toMatchObject({ code: 'NOT_INSTALLED' });
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('fails with INVALID_CONFIG when the file on disk is invalid (the .bak is not consulted)', async () => {
    const config = await installed();
    await writeConfig(dirs.dataDir, config); // so that a .bak exists
    await writeRaw({ ...config, installState: 'nonsense' });
    expect(await failure(() => updateConfig(dirs.dataDir, () => undefined))).toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('reads a damaged config.json from its .bak, like loadConfig', async () => {
    const config = await installed();
    await writeConfig(dirs.dataDir, config);
    await fsp.writeFile(configFile(), '{"version": 1, "baseUr');
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.installState = 'cron';
    });
    expect(await onDisk()).toEqual({ ...config, installState: 'cron' });
  });

  it('keeps mode 600 and leaves no lock or temporary file', async () => {
    await installed();
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.installState = 'cron';
    });
    if (process.platform !== 'win32') expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dirs.dataDir).sort()).toEqual(['config.json', 'config.json.bak']);
  });

  describe('a newer release wrote keys this one does not know (D1d-2): they are carried over unchanged', () => {
    const base = sampleConfig();

    it('the brief case: baseUrl changed, futureKey and update.channelX kept with equal values', async () => {
      await writeRaw({ ...base, futureKey: { a: 1 }, update: { feedUrl: 'https://f.example/altis', channelX: 1 } });
      const written = await updateConfig(dirs.dataDir, (cfg) => {
        cfg.baseUrl = 'https://new.example';
      });
      expect(written).toEqual({ ...base, baseUrl: 'https://new.example', update: { feedUrl: 'https://f.example/altis' } });
      const file = (await onDisk()) as unknown as Record<string, unknown>;
      expect(file['baseUrl']).toBe('https://new.example');
      expect(file['futureKey']).toEqual({ a: 1 });
      expect(file['update']).toEqual({ feedUrl: 'https://f.example/altis', channelX: 1 });
      expect(parseConfig(file).unknownKeys).toEqual(['futureKey', 'update.channelX']);
    });

    it('keeps them at every level, also when mutate replaces the object that holds them (the install resume does)', async () => {
      const raw = {
        ...base,
        futureKey: [1, { b: 2 }],
        trustProxy: { hops: 1, mode: 'x' },
        db: { ...base.db, ssl: { ca: 'pem' } },
        secrets: { ...base.secrets, pepper: 'p' },
        install: { ...base.install, edition: 'pro' },
        log: { level: 'info', format: 'json' },
      };
      await writeRaw(raw);
      await updateConfig(dirs.dataDir, (cfg) => ({
        ...cfg,
        trustProxy: { hops: 2 },
        db: { dialect: 'postgres', host: 'pg', user: 'u', database: 'd' },
        log: { level: 'warn' },
      }));
      const file = (await onDisk()) as unknown as Record<string, Record<string, unknown>>;
      expect(file['futureKey']).toEqual([1, { b: 2 }]);
      expect(file['trustProxy']).toEqual({ hops: 2, mode: 'x' });
      expect(file['db']).toEqual({ dialect: 'postgres', host: 'pg', user: 'u', database: 'd', ssl: { ca: 'pem' } });
      expect(file['secrets']!['pepper']).toBe('p');
      expect(file['install']!['edition']).toBe('pro');
      expect(file['log']).toEqual({ level: 'warn', format: 'json' });
    });

    it('a keyring entry keeps its unknown keys by kid, whatever mutate does to the order (secrets:rotate)', async () => {
      const old = { ...base.keyring[0]!, active: false, kid: 'kold', createdAt: 'old' };
      const current = { ...base.keyring[0]!, kid: 'kcur', createdAt: 'cur' };
      await writeRaw({ ...base, keyring: [old, current] });
      await updateConfig(dirs.dataDir, (cfg) => {
        const [, cur] = cfg.keyring;
        cfg.keyring = [{ kid: 'knew', key: base.keyring[0]!.key, active: true }, { ...cur!, active: false }];
      });
      const file = await onDisk();
      expect(file.keyring).toEqual([
        { kid: 'knew', key: base.keyring[0]!.key, active: true },
        { kid: 'kcur', key: base.keyring[0]!.key, active: false, createdAt: 'cur' },
      ]);
    });

    it('an object mutate removed keeps the unknown keys it held, when the object is valid with them alone', async () => {
      await writeRaw({ ...base, update: { feedUrl: 'https://f.example/altis', channelX: 1 } });
      await updateConfig(dirs.dataDir, (cfg) => {
        delete cfg.update; // config:set update.feedUrl '' removes an update left empty
      });
      expect(((await onDisk()) as unknown as Record<string, unknown>)['update']).toEqual({ channelX: 1 });
      await updateConfig(dirs.dataDir, (cfg) => ({ ...cfg, update: undefined }));
      expect(((await onDisk()) as unknown as Record<string, unknown>)['update']).toEqual({ channelX: 1 });
    });

    it('keeps __proto__ and keys named like Object.prototype members as data', async () => {
      const text = JSON.stringify({ ...base, toString: 1 }).replace(/^\{/, '{"__proto__":{"x":1},');
      await writeRaw(text);
      await updateConfig(dirs.dataDir, (cfg) => {
        cfg.installState = 'cron';
      });
      const file = JSON.parse(await fsp.readFile(configFile(), 'utf8')) as Record<string, unknown>;
      expect(Object.hasOwn(file, '__proto__')).toBe(true);
      expect(Object.getOwnPropertyDescriptor(file, '__proto__')!.value).toEqual({ x: 1 });
      expect(file['toString']).toBe(1);
      expect(file['installState']).toBe('cron');
    });

    it('updateConfigIfChanged: no change to a known key writes nothing, unknown keys and all', async () => {
      await writeRaw({ ...base, futureKey: 1 });
      const before = await fsp.readFile(configFile(), 'utf8');
      const result = await updateConfigIfChanged(dirs.dataDir, (cfg) => {
        cfg.installState = base.installState;
      });
      expect(result).toEqual({ config: base, changed: false });
      expect(await fsp.readFile(configFile(), 'utf8')).toBe(before);
    });

    it('a key this release does not know, added by mutate (a bug in this code), is still refused', async () => {
      await writeRaw({ ...base, futureKey: 1 });
      const before = await fsp.readFile(configFile(), 'utf8');
      const error = await failure(() => updateConfig(dirs.dataDir, (cfg) => ({ ...cfg, log: { level: 'info', extra: 1 } }) as unknown as Config));
      expect(error).toMatchObject({ code: 'INVALID_CONFIG', meta: { issues: [{ path: 'log.extra', code: 'unrecognized_keys' }] } });
      expect(await fsp.readFile(configFile(), 'utf8')).toBe(before);
    });
  });

  it('loses no update when several calls run at once: each one sees the result of the one before', async () => {
    await installed(sampleConfig({ trustProxy: { hops: 0 } }));
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        updateConfig(dirs.dataDir, (cfg) => {
          cfg.trustProxy.hops += 1;
          cfg.allowedOrigins.push(`https://o${i}.example`);
        }),
      ),
    );
    const file = await onDisk();
    expect(file.trustProxy.hops).toBe(8);
    const added = Array.from({ length: 8 }, (_, i) => `https://o${i}.example`);
    expect(file.allowedOrigins.slice().sort()).toEqual([...sampleConfig().allowedOrigins, ...added].sort());
  });

  describe('two processes', () => {
    const repo = path.resolve(import.meta.dirname, '../../..');
    const fixture = path.join(import.meta.dirname, 'fixtures', 'config-child.mjs');
    const children: ChildProcess[] = [];

    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL');
    });

    function start(id: string, count: number) {
      // tsx lets the child import the TypeScript sources directly, on every supported Node version.
      const child = fork(fixture, [dirs.dataDir, id, String(count)], {
        cwd: repo,
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, ALTIS_DB_PASSWORD: 'child-env-password', ALTIS_DB_HOST: 'child-env-host' },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', (m) => (m === 'ready' ? resolve() : reject(new Error(`unexpected message ${String(m)}`))));
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child ${id} exited with ${String(code)} before it was ready`)));
      });
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      return { child, ready, exited };
    }

    it('both processes apply every one of their updates (no lost update), and no environment override reaches the file', async () => {
      const config = await installed();
      const a = start('a', 6);
      const b = start('b', 6);
      await Promise.all([a.ready, b.ready]);
      a.child.send('go');
      b.child.send('go');
      expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);

      const file = await onDisk();
      const added = file.allowedOrigins.filter((origin) => !config.allowedOrigins.includes(origin));
      const expected = ['a', 'b'].flatMap((id) => Array.from({ length: 6 }, (_, n) => `https://${id}-${n}.example`));
      expect(added.slice().sort()).toEqual(expected.sort());
      expect(file.db).toEqual(config.db);
      expect(await fsp.readFile(configFile(), 'utf8')).not.toMatch(/child-env-password|child-env-host/);
      expect(fs.readdirSync(dirs.dataDir)).not.toContain('config.lock');
    }, 60_000);
  });
});

describe('updateConfigIfChanged', () => {
  const bakFile = (): string => `${configFile()}.bak`;

  it('writes nothing when mutate leaves the file as it is: config.json.bak keeps the real previous copy', async () => {
    const first = sampleConfig({ installState: 'migrate' });
    await writeConfig(dirs.dataDir, first);
    await updateConfig(dirs.dataDir, (cfg) => {
      cfg.installState = 'complete';
    });
    const file = await fsp.readFile(configFile(), 'utf8');
    const bak = await fsp.readFile(bakFile(), 'utf8');
    const mtime = fs.statSync(configFile()).mtimeMs;
    expect(JSON.parse(bak)).toMatchObject({ installState: 'migrate' });

    // The same values set again, and an object replaced by an equal one with its keys in another order.
    const result = await updateConfigIfChanged(dirs.dataDir, (cfg) => {
      cfg.installState = 'complete';
      cfg.trustProxy = { ...cfg.trustProxy };
      cfg.allowedOrigins = [...cfg.allowedOrigins];
      return { ...cfg, baseUrl: `${cfg.baseUrl}/` }; // canonical form: the same baseUrl
    });
    expect(result.changed).toBe(false);
    expect(result.config).toEqual({ ...first, installState: 'complete' });
    expect(await fsp.readFile(configFile(), 'utf8')).toBe(file);
    expect(await fsp.readFile(bakFile(), 'utf8')).toBe(bak);
    expect(fs.statSync(configFile()).mtimeMs).toBe(mtime);
    expect(fs.readdirSync(dirs.dataDir)).not.toContain('config.lock');
  });

  it('writes a real change as updateConfig does, and says so', async () => {
    const config = sampleConfig();
    await writeConfig(dirs.dataDir, config);
    const result = await updateConfigIfChanged(dirs.dataDir, (cfg) => {
      cfg.trustProxy.hops = 3;
    });
    expect(result).toEqual({ config: { ...config, trustProxy: { hops: 3 } }, changed: true });
    expect(JSON.parse(await fsp.readFile(configFile(), 'utf8'))).toEqual(result.config);
    expect(JSON.parse(await fsp.readFile(bakFile(), 'utf8'))).toEqual(config);
  });

  it('refuses an invalid result and a missing config like updateConfig', async () => {
    await expect(updateConfigIfChanged(dirs.dataDir, () => undefined)).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
    await writeConfig(dirs.dataDir, sampleConfig());
    const before = await fsp.readFile(configFile(), 'utf8');
    await expect(
      updateConfigIfChanged(dirs.dataDir, (cfg) => {
        cfg.trustProxy.hops = 99;
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(await fsp.readFile(configFile(), 'utf8')).toBe(before);
  });
});
