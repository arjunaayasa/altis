import { createPrivateKey, type KeyObject } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { KEYSET_TYP, RELEASE_TYP, generateKeyPair, signDetached, type TrustedKey } from '@altis/crypto';
import { PHASE1_MIGRATIONS } from '@altis/db';
import { ensureHeadroom, type Runtime } from '@altis/platform';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DOCTOR_CHECKS } from '../src/cli/doctor.js';
import { runCli } from '../src/cli/index.js';
import { captureIo, devRootKeys, makeSignedRelease, openInstalled, writeInput, type CapturedIo } from './cli-support.js';
import { bootContext, useDataDir } from './support.js';

// `node app.js doctor [--smoke] [--json]` (Task 15) on SQLite in a temp DATA_DIR.

// 1c Task 23 (L51): the headroom probe's size, seen through a spy that still writes.
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: vi.fn(actual.ensureHeadroom) };
});

const DEV_KEYS = path.resolve(import.meta.dirname, '..', '..', '..', 'tools', 'keys', 'dev');
const dirs = useDataDir();
let home: string;
let listenSpy: MockInstance<http.Server['listen']>;

beforeEach(async () => {
  home = path.join(dirs.root, 'home');
  await fsp.mkdir(home);
  listenSpy = vi.spyOn(http.Server.prototype, 'listen');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Check {
  ok: boolean;
  detail: string;
}

interface DoctorJson {
  ok: boolean;
  command: 'doctor';
  checks: Record<string, Check>;
  smoke?: Check;
}

interface Run {
  code: number;
  io: CapturedIo;
}

async function cli(
  argv: string[],
  o: { env?: Record<string, string>; runtime?: Runtime; dataDir?: string; nodeVersion?: string; rootKeys?: TrustedKey[]; refuseDevKids?: boolean } = {},
): Promise<Run> {
  const io = captureIo(o.env ?? { HOME: home }, {
    ...(o.nodeVersion === undefined ? {} : { nodeVersion: o.nodeVersion }),
    ...(o.rootKeys === undefined ? {} : { rootKeys: o.rootKeys }),
    ...(o.refuseDevKids === undefined ? {} : { refuseDevKids: o.refuseDevKids }),
  });
  const code = await runCli(argv, bootContext(o.dataDir ?? dirs.dataDir, { runtime: o.runtime ?? 'standalone' }), io);
  return { code, io };
}

async function doctor(o: Parameters<typeof cli>[1] & { smoke?: boolean } = {}): Promise<{ code: number; report: DoctorJson; io: CapturedIo }> {
  const { code, io } = await cli(['doctor', '--json', ...(o.smoke === true ? ['--smoke'] : [])], o);
  expect(io.err).toBe('');
  return { code, report: JSON.parse(io.out) as DoctorJson, io };
}

async function installed(): Promise<void> {
  const file = await writeInput(path.join(dirs.root, 'input'), {
    baseUrl: 'https://perpus.example',
    db: { dialect: 'sqlite', password: 'pw-S3CRET' },
    admin: { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' },
  });
  const { code, io } = await cli(['install', '--config', file]);
  expect(io.err).toBe('');
  expect(code).toBe(0);
}

/** The release dir bootContext() names for DATA_DIR. */
function releaseDir(): string {
  return path.join(path.dirname(dirs.dataDir), 'app', 'release');
}

/** Every server the CLI started must be closed again. */
function expectServersClosed(): void {
  for (const server of listenSpy.mock.contexts as http.Server[]) expect(server.listening).toBe(false);
}

describe('doctor --json', () => {
  it('lists exactly the checks of the brief, each {ok, detail}', () => {
    // The community edition has no licence check.
    expect(DOCTOR_CHECKS).toEqual(['node', 'runtime', 'port', 'dataDir', 'docroot', 'config', 'db', 'migrations', 'release', 'headroom', 'wasm']);
  });

  it('after install: every check passes, exit 0', async () => {
    await installed();
    await makeSignedRelease(releaseDir(), '0.1.0');
    const { code, report } = await doctor({ rootKeys: await devRootKeys() });
    expect(Object.keys(report.checks)).toEqual(DOCTOR_CHECKS);
    for (const name of DOCTOR_CHECKS) {
      // D1d-2: the config check also names the unknown keys of config.json and where the update feed comes from.
      const extra = name === 'config' ? { unknownKeys: [], feedSource: null } : {};
      expect(report.checks[name], name).toEqual({ ok: true, detail: expect.any(String), ...extra });
      expect(report.checks[name]!.detail, name).not.toBe('');
    }
    expect(report).toMatchObject({ ok: true, command: 'doctor' });
    expect(report.smoke).toBeUndefined();
    expect(code).toBe(0);
    expect(report.checks['db']!.detail).toMatch(/sqlite/);
    // The schema is at the last migration (by name; Phase 1d and Phase 2 add theirs).
    expect(report.checks['migrations']!.detail).toContain((Object.keys(PHASE1_MIGRATIONS).sort().at(-1) ?? '').slice(0, 4));
    expect(report.checks['release']!.detail).toMatch(/0\.1\.0/);
    expect(report.checks['port']!.detail).toMatch(/3000/);
  });

  it('before install: config, db and migrations fail, exit 1', async () => {
    const { code, report } = await doctor();
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(Object.keys(report.checks)).toEqual(DOCTOR_CHECKS);
    for (const name of ['config', 'db', 'migrations']) expect(report.checks[name]!.ok, name).toBe(false);
    for (const name of ['node', 'runtime', 'port', 'docroot', 'wasm']) expect(report.checks[name]!.ok, name).toBe(true);
    expect(report.checks['dataDir']!.ok).toBe(false); // does not exist yet
  });

  it('never creates DATA_DIR', async () => {
    await doctor();
    await expect(fsp.stat(dirs.dataDir)).rejects.toThrow();
  });

  it('release: verified from the root keys when it has them, a tampered file fails', async () => {
    await installed();
    await makeSignedRelease(releaseDir(), '0.1.0');
    const roots = await devRootKeys();
    expect((await doctor({ rootKeys: roots })).report.checks['release']).toEqual({ ok: true, detail: expect.stringMatching(/0\.1\.0/) });

    await fsp.appendFile(path.join(releaseDir(), 'server.mjs'), '// changed\n');
    const tampered = await doctor({ rootKeys: roots });
    expect(tampered.code).toBe(1);
    expect(tampered.report.checks['release']).toEqual({ ok: false, detail: expect.stringMatching(/RELEASE_INVALID:hash:server\.mjs/) });

    await fsp.writeFile(path.join(releaseDir(), 'extra.txt'), 'x');
    expect((await doctor({ rootKeys: roots })).report.checks['release']!.detail).toMatch(/RELEASE_INVALID/);
  });

  it('release: without root keys it reports what app.js verified at start', async () => {
    await installed();
    const { report } = await doctor();
    expect(report.checks['release']).toEqual({ ok: true, detail: expect.stringMatching(/0\.1\.0.*app\.js/) });
  });

  describe('root keys embedded in server.mjs (__TRUSTED_KEYS__, rulings R62 and R65)', () => {
    /** A private dev key from tools/keys/dev. */
    async function devKey(kid: string): Promise<{ kid: string; privateKey: KeyObject }> {
      const key = JSON.parse(await fsp.readFile(path.join(DEV_KEYS, `${kid}.key.json`), 'utf8')) as { pkcs8: string };
      return { kid, privateKey: createPrivateKey({ key: Buffer.from(key.pkcs8, 'base64'), format: 'der', type: 'pkcs8' }) };
    }

    /** An altis-keyset/1 document over `payload`, signed by the dev key `kid` (dev-root-1 unless told otherwise). */
    async function keysetDoc(payload: unknown, kid = 'dev-root-1'): Promise<{ raw: string; env: unknown }> {
      const { privateKey } = await devKey(kid);
      return { raw: JSON.stringify(payload), env: signDetached(payload, { typ: KEYSET_TYP, kid, privateKey }) };
    }

    /** Re-signs the release's manifest.json with another release key. */
    async function resignWith(kid: string, privateKey?: KeyObject): Promise<void> {
      const key = privateKey ?? (await devKey(kid)).privateKey;
      const manifest = JSON.parse(await fsp.readFile(path.join(releaseDir(), 'manifest.json'), 'utf8')) as unknown;
      await fsp.writeFile(path.join(releaseDir(), 'manifest.sig'), JSON.stringify(signDetached(manifest, { typ: RELEASE_TYP, kid, privateKey: key })));
    }

    async function writeDataKeyset(text: string): Promise<void> {
      await fsp.mkdir(path.join(dirs.dataDir, 'releases'), { recursive: true });
      await fsp.writeFile(path.join(dirs.dataDir, 'releases', 'keyset.json'), text);
    }

    it("verifies every file of the release from the embedded root and the release's own keyset.json", async () => {
      await installed();
      await makeSignedRelease(releaseDir(), '0.1.0');
      vi.stubGlobal('__TRUSTED_KEYS__', await devRootKeys());
      expect((await doctor()).report.checks['release']).toEqual({ ok: true, detail: expect.stringMatching(/^0\.1\.0 \(bundled\): .*signature and every file match/) });

      await fsp.writeFile(path.join(releaseDir(), 'extra.txt'), 'x');
      expect((await doctor()).report.checks['release']).toEqual({ ok: false, detail: expect.stringMatching(/RELEASE_INVALID:extra:extra\.txt/) });
    });

    it('like app.js: a root-signed document in DATA_DIR/releases/keyset.json adds a release key, or revokes one', async () => {
      await installed();
      await makeSignedRelease(releaseDir(), '0.1.0');
      const extra = generateKeyPair();
      await resignWith('rel-extra-1', extra.privateKey);
      vi.stubGlobal('__TRUSTED_KEYS__', await devRootKeys());
      // The release's own keyset does not know rel-extra-1.
      expect((await doctor()).report.checks['release']).toEqual({ ok: false, detail: expect.stringMatching(/RELEASE_INVALID:signature/) });
      // A release key cannot add it.
      const payload = { seq: 2, keys: [{ kid: 'rel-extra-1', use: 'release', pub: extra.pub }], revokedKids: [] };
      await writeDataKeyset(JSON.stringify([await keysetDoc(payload, 'dev-rel-1')]));
      expect((await doctor()).report.checks['release']!.ok).toBe(false);
      // The root can.
      await writeDataKeyset(JSON.stringify([await keysetDoc(payload)]));
      expect((await doctor()).report.checks['release']).toEqual({ ok: true, detail: expect.stringMatching(/signature and every file match/) });
      // And it can revoke it again.
      await writeDataKeyset(JSON.stringify([await keysetDoc(payload), await keysetDoc({ seq: 1, keys: [], revokedKids: ['rel-extra-1'] })]));
      expect((await doctor()).report.checks['release']).toEqual({ ok: false, detail: expect.stringMatching(/RELEASE_INVALID:signature/) });
    });

    it('fails closed when DATA_DIR/releases/keyset.json is unreadable (a revoked key could come back)', async () => {
      await installed();
      await makeSignedRelease(releaseDir(), '0.1.0');
      vi.stubGlobal('__TRUSTED_KEYS__', await devRootKeys());
      await writeDataKeyset('{ not json');
      expect((await doctor()).report.checks['release']).toEqual({ ok: false, detail: expect.stringMatching(/^STATE_CORRUPT/) });
    });

    it('fails a release without its keyset.json: RELEASE_INVALID:keyset', async () => {
      await installed();
      await makeSignedRelease(releaseDir(), '0.1.0');
      await fsp.rm(path.join(releaseDir(), 'keyset.json'));
      vi.stubGlobal('__TRUSTED_KEYS__', await devRootKeys());
      expect((await doctor()).report.checks['release']).toEqual({ ok: false, detail: expect.stringMatching(/RELEASE_INVALID:keyset/) });
    });

    it('root keys handed to runCli (tests) take precedence over the embedded ones', async () => {
      await installed();
      await makeSignedRelease(releaseDir(), '0.1.0');
      vi.stubGlobal('__TRUSTED_KEYS__', [{ kid: 'root-other', use: 'root', pub: generateKeyPair().pub }]);
      expect((await doctor()).report.checks['release']!.ok).toBe(false);
      expect((await doctor({ rootKeys: await devRootKeys() })).report.checks['release']!.ok).toBe(true);
    });

    /** Writes `docs` as `<appRoot>/bundled-release/<version>/keyset.json` (bootContext's appRoot). */
    async function writeBundledKeyset(version: string, docs: unknown[]): Promise<void> {
      const dir = path.join(path.dirname(dirs.dataDir), 'app', 'bundled-release', version);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'keyset.json'), JSON.stringify(docs));
    }

    it('R65a, like app.js: a revocation counts from the DATA_DIR .bak, a bundled release or a release current.json names', async () => {
      await installed();
      await makeSignedRelease(releaseDir(), '0.1.0'); // signed by dev-rel-1
      vi.stubGlobal('__TRUSTED_KEYS__', await devRootKeys());
      const revoke = await keysetDoc({ seq: 2, keys: [], revokedKids: ['dev-rel-1'] });
      expect((await doctor()).report.checks['release']!.ok).toBe(true);

      await writeDataKeyset('[]');
      await fsp.writeFile(path.join(dirs.dataDir, 'releases', 'keyset.json.bak'), JSON.stringify([revoke]));
      expect((await doctor()).report.checks['release']).toEqual({ ok: false, detail: expect.stringMatching(/RELEASE_INVALID:signature/) });
      await fsp.rm(path.join(dirs.dataDir, 'releases', 'keyset.json.bak'));

      await writeBundledKeyset('9.9.9', [revoke]);
      expect((await doctor()).report.checks['release']).toEqual({ ok: false, detail: expect.stringMatching(/RELEASE_INVALID:signature/) });
      await fsp.rm(path.join(path.dirname(dirs.dataDir), 'app', 'bundled-release'), { recursive: true });

      const named = path.join(dirs.dataDir, 'releases', '0.0.5');
      await fsp.mkdir(named, { recursive: true });
      await fsp.writeFile(path.join(named, 'keyset.json'), JSON.stringify([revoke]));
      expect((await doctor()).report.checks['release']!.ok).toBe(true); // not named by current.json: not read
      const current = { schema: 1, active: { version: '0.1.0', source: 'bundled' }, previous: { version: '0.0.5', source: 'data' }, pending: null, pendingSince: null, pinned: null };
      await fsp.writeFile(path.join(dirs.dataDir, 'releases', 'current.json'), JSON.stringify(current));
      expect((await doctor()).report.checks['release']).toEqual({ ok: false, detail: expect.stringMatching(/RELEASE_INVALID:signature/) });
    });

    it('R65f: reports ignored keyset documents and conflicting kids (source, index, reason), in safe text', async () => {
      await installed();
      await makeSignedRelease(releaseDir(), '0.1.0');
      vi.stubGlobal('__TRUSTED_KEYS__', await devRootKeys());
      const forged = await keysetDoc({ seq: 9, keys: [], revokedKids: ['dev-rel-1'] }, 'dev-rel-2');
      const one = { kid: 'rel-x\u0007', use: 'release', pub: generateKeyPair().pub };
      const two = { ...one, pub: generateKeyPair().pub };
      await writeDataKeyset(JSON.stringify([forged, await keysetDoc({ seq: 3, keys: [one], revokedKids: [] }), await keysetDoc({ seq: 4, keys: [two], revokedKids: [] })]));
      const check = (await doctor()).report.checks['release']!;
      expect(check.ok).toBe(true);
      expect(check.detail).toMatch(/signature and every file match/);
      expect(check.detail).toContain('1 keyset document(s) ignored: DATA_DIR/releases/keyset.json#0 SIG_INVALID:kid');
      expect(check.detail).toContain('kid(s) bound to two keys, not trusted: "rel-x\\u0007"');
      expect(check.detail).not.toContain('\u0007');

      await writeBundledKeyset('9.9.9', 'not a list' as unknown as unknown[]);
      expect((await doctor()).report.checks['release']!.detail).toContain('keyset.json not usable: bundled-release/9.9.9/keyset.json');
    });

    it('R65b: with refuseDevKids (a production server.mjs), a document that adds a dev- key is ignored and reported', async () => {
      await installed();
      await makeSignedRelease(releaseDir(), '0.1.0');
      vi.stubGlobal('__TRUSTED_KEYS__', await devRootKeys());
      const devKeyDoc = await keysetDoc({ seq: 5, keys: [{ kid: 'dev-rel-7', use: 'release', pub: generateKeyPair().pub }], revokedKids: [] });
      await writeDataKeyset(JSON.stringify([devKeyDoc]));
      expect((await doctor()).report.checks['release']!.detail).not.toContain('ignored');
      const production = (await doctor({ refuseDevKids: true })).report.checks['release']!;
      expect(production.detail).toContain('DATA_DIR/releases/keyset.json#0 dev');
    });
  });

  it('node below 22.16 fails the node check', async () => {
    const { code, report } = await doctor({ nodeVersion: '20.11.0' });
    expect(code).toBe(1);
    expect(report.checks['node']).toEqual({ ok: false, detail: expect.stringMatching(/20\.11\.0.*22\.16/) });
  });

  it('an invalid ALTIS_PORT fails the port check', async () => {
    const { report } = await doctor({ env: { HOME: home, ALTIS_PORT: 'eighty' } });
    expect(report.checks['port']!.ok).toBe(false);
    expect(report.checks['port']!.detail).toMatch(/ALTIS_PORT/);
  });

  it('DATA_DIR under $HOME/public_html fails the docroot check', async () => {
    await fsp.mkdir(path.join(home, 'public_html'));
    const { report } = await doctor({ dataDir: path.join(home, 'public_html', 'altis-data') });
    expect(report.checks['docroot']).toEqual({ ok: false, detail: expect.stringMatching(/public_html/) });
  });

  it('SQLite on passenger fails the runtime check (and the db check; the smoke test is skipped)', async () => {
    await installed();
    const { code, report } = await doctor({ runtime: 'passenger', smoke: true });
    expect(code).toBe(1);
    expect(report.checks['runtime']).toEqual({ ok: false, detail: expect.stringMatching(/passenger/) });
    expect(report.checks['db']).toEqual({ ok: false, detail: expect.stringMatching(/SQLITE_NOT_ALLOWED/) });
    expect(report.smoke).toEqual({ ok: false, detail: expect.stringMatching(/database is not available/) });
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it('the runtime check also judges SQLite by the runtime the install was for (R66), and names it', async () => {
    await installed();
    const configFile = path.join(dirs.dataDir, 'config.json');
    const setInstallRuntime = async (runtime: string): Promise<void> => {
      const cfg = JSON.parse(await fsp.readFile(configFile, 'utf8')) as { install: Record<string, unknown> };
      cfg.install['runtime'] = runtime;
      await fsp.writeFile(configFile, JSON.stringify(cfg));
    };
    expect((await doctor()).report.checks['runtime']).toEqual({ ok: true, detail: 'standalone' });

    await setInstallRuntime('docker');
    expect((await doctor()).report.checks['runtime']).toEqual({ ok: true, detail: expect.stringMatching(/standalone.*docker/) });

    // This shell says standalone, but the server runs under Passenger: SQLite cannot work there.
    await setInstallRuntime('passenger');
    const { code, report } = await doctor();
    expect(code).toBe(1);
    expect(report.checks['runtime']).toEqual({ ok: false, detail: expect.stringMatching(/standalone.*passenger/) });
  });

  describe('config: unknown keys and the feed source (D1d-2, preflight M11)', () => {
    const configFile = (): string => path.join(dirs.dataDir, 'config.json');

    /** Adds what a newer release could have written to the installed config.json (a hand edit). */
    async function addFutureKeys(): Promise<void> {
      const cfg = JSON.parse(await fsp.readFile(configFile(), 'utf8')) as Record<string, unknown>;
      cfg['futureKey'] = { a: 1 };
      cfg['update'] = { feedUrl: 'https://f.example/altis', channelX: 1 };
      await fsp.writeFile(configFile(), JSON.stringify(cfg));
    }

    it('unknown keys keep the check ok, are listed in the JSON and named in a warning; ALTIS_UPDATE_FEED_URL → feedSource env', async () => {
      await installed();
      await addFutureKeys();
      const { code, report } = await doctor({ env: { HOME: home, ALTIS_UPDATE_FEED_URL: 'https://feed.example/altis' } });
      const config = report.checks['config'] as Check & { unknownKeys?: unknown; feedSource?: unknown };
      expect(config.ok).toBe(true);
      expect(config.unknownKeys).toEqual(['futureKey', 'update.channelX']);
      expect(config.feedSource).toBe('env');
      expect(config.detail).toMatch(/WARNING: .*futureKey, update\.channelX/);
      expect(config.detail).toMatch(/feed source: env/);
      expect(config.detail).not.toContain('feed.example');
      expect(code).toBe(0);
    });

    it('feedSource: config from config.json, build from __FEED_URL__, null when neither', async () => {
      await installed();
      expect((await doctor()).report.checks['config']).toMatchObject({ ok: true, unknownKeys: [], feedSource: null });
      vi.stubGlobal('__FEED_URL__', 'https://build.example/altis');
      expect((await doctor()).report.checks['config']).toMatchObject({ feedSource: 'build' });
      await addFutureKeys();
      expect((await doctor()).report.checks['config']).toMatchObject({ feedSource: 'config', detail: expect.stringMatching(/feed source: config\.json/) });
      vi.stubGlobal('__FEED_URL__', '');
      expect((await doctor()).report.checks['config']).toMatchObject({ feedSource: 'config' });
    });

    it('the warning line in the plain output names the unknown keys, in safe text', async () => {
      await installed();
      await addFutureKeys();
      const cfg = JSON.parse(await fsp.readFile(configFile(), 'utf8')) as Record<string, unknown>;
      cfg['bad\u001b[2Jkey'] = 1;
      await fsp.writeFile(configFile(), JSON.stringify(cfg));
      const { code, io } = await cli(['doctor']);
      expect(code).toBe(0);
      const line = io.out.split('\n').find((l) => /\bconfig\b/.test(l))!;
      expect(line).toMatch(/^ {2}OK/);
      // L51: a key that is not plain text is shown as <key>, never raw
      expect(line).toMatch(/PERINGATAN.*WARNING.*<key>, futureKey, update\.channelX/);
      expect(io.out).not.toContain('\u001b');
    });

    it('an invalid ALTIS_UPDATE_FEED_URL fails the config check, naming the variable', async () => {
      await installed();
      const { code, report } = await doctor({ env: { HOME: home, ALTIS_UPDATE_FEED_URL: 'ftp://x' } });
      expect(code).toBe(1);
      expect(report.checks['config']).toEqual({ ok: false, detail: expect.stringMatching(/^INVALID_CONFIG: .*ALTIS_UPDATE_FEED_URL/) });
    });
  });

  it('L51 (decision C23): the headroom check probes 4 MiB in DATA_DIR, not 32 MiB', async () => {
    await fsp.mkdir(dirs.dataDir);
    const spy = vi.mocked(ensureHeadroom);
    spy.mockClear();
    const { report } = await doctor();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(dirs.dataDir, 4 * 1024 * 1024);
    expect(report.checks['headroom']).toEqual({ ok: true, detail: expect.stringMatching(/^4 MB/) });
  });

  it('WASM that cannot allocate fails the wasm check with the NODE_OPTIONS hint (P19)', async () => {
    vi.stubGlobal('WebAssembly', {
      Memory: class {
        constructor() {
          throw new RangeError('WebAssembly.Memory(): could not allocate memory');
        }
      },
    });
    const { report } = await doctor();
    expect(report.checks['wasm']).toEqual({ ok: false, detail: expect.stringMatching(/--disable-wasm-trap-handler/) });
  });

  it('a schema that needs newer code fails the migrations check', async () => {
    await installed();
    const h = await openInstalled(dirs.dataDir);
    await h.db.updateTable('schema_meta').set({ min_code_version: '9.0.0' }).execute();
    await h.close();
    const { report } = await doctor();
    expect(report.checks['migrations']).toEqual({ ok: false, detail: expect.stringMatching(/9\.0\.0/) });
  });

  it('prints bilingual lines without --json, and never a secret', async () => {
    await installed();
    const { code, io } = await cli(['doctor', '--smoke']);
    expect(code).toBe(0);
    expect(io.err).toBe('');
    for (const name of DOCTOR_CHECKS) expect(io.out).toMatch(new RegExp(`\\b${name}\\b`));
    expect(io.out).toMatch(/smoke/);
    expect(io.out).toMatch(/ \/ /);
    const cfg = JSON.parse(await fsp.readFile(path.join(dirs.dataDir, 'config.json'), 'utf8')) as {
      secrets: Record<string, string>;
      install: { privateKey: string };
    };
    for (const secret of ['pw-S3CRET', cfg.secrets['sessionKey']!, cfg.secrets['cronToken']!, cfg.install.privateKey]) {
      expect(io.out).not.toContain(secret);
    }
  });
});

describe('doctor --smoke', () => {
  it('after install: starts the app on 127.0.0.1, gets /_health 200, closes everything; exit 0', async () => {
    await installed();
    const { code, report } = await doctor({ smoke: true });
    expect(report.smoke).toEqual({ ok: true, detail: expect.stringMatching(/_health 200/) });
    expect(code).toBe(0);
    expect(listenSpy).toHaveBeenCalledTimes(1);
    expect(listenSpy.mock.calls[0]).toEqual([0, '127.0.0.1', expect.any(Function)]);
    expectServersClosed();
  });

  it('before install: exit 1, no server started', async () => {
    const { code, report } = await doctor({ smoke: true });
    expect(code).toBe(1);
    expect(report.smoke).toEqual({ ok: false, detail: expect.any(String) });
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it('a schema that needs newer code: /_health 503, exit 1', async () => {
    await installed();
    const h = await openInstalled(dirs.dataDir);
    await h.db.updateTable('schema_meta').set({ min_code_version: '9.0.0' }).execute();
    await h.close();
    const { code, report } = await doctor({ smoke: true });
    expect(code).toBe(1);
    expect(report.smoke).toEqual({ ok: false, detail: expect.stringMatching(/503/) });
    expectServersClosed();
  });
});

// 1d Task 32 (L8, decision D1d-36): SQLite under PM2 cluster mode or with more than one instance fails the runtime
// check, naming the signals PM2 left in the environment (the boot refuses it the same way, start.test.ts).
describe('doctor: SQLite under a PM2 cluster', () => {
  it('runtime pm2 with instances=2: the runtime check fails naming that signal, exit 1', async () => {
    await installed();
    const { code, report } = await doctor({ runtime: 'pm2', env: { HOME: home, pm_id: '0', instances: '2', NODE_APP_INSTANCE: '0' } });
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.checks['runtime']).toEqual({ ok: false, detail: expect.stringMatching(/SQLite.*PM2.*instances=2/) });
    expect(report.checks['runtime']!.detail).not.toContain('NODE_APP_INSTANCE');
    // only the runtime check: SQLite itself is allowed on pm2, so the database still opens
    expect(report.checks['db']!.ok).toBe(true);
  });

  it('cluster mode on a second instance: both signals are named', async () => {
    await installed();
    const { report } = await doctor({ runtime: 'pm2', env: { HOME: home, exec_mode: 'cluster_mode', NODE_APP_INSTANCE: '1' } });
    expect(report.checks['runtime']).toEqual({ ok: false, detail: expect.stringMatching(/exec_mode=cluster_mode, NODE_APP_INSTANCE=1/) });
  });

  it('the shipped template (fork mode, one instance) passes; so does a PM2 cluster on another runtime or another database', async () => {
    await installed();
    const fork = { HOME: home, pm_id: '0', exec_mode: 'fork_mode', instances: '1', NODE_APP_INSTANCE: '0' };
    expect((await doctor({ runtime: 'pm2', env: fork })).report.checks['runtime']).toEqual({ ok: true, detail: expect.stringMatching(/^pm2/) });
    // the signals only count under runtime pm2 (P20: docker, service and standalone run one process per DATA_DIR)
    const cluster = { HOME: home, exec_mode: 'cluster_mode', instances: '4' };
    expect((await doctor({ runtime: 'standalone', env: cluster })).report.checks['runtime']).toEqual({ ok: true, detail: 'standalone' });

    const configFile = path.join(dirs.dataDir, 'config.json');
    const cfg = JSON.parse(await fsp.readFile(configFile, 'utf8')) as { db: Record<string, unknown> };
    cfg.db = { dialect: 'mariadb', host: '127.0.0.1', port: 1, user: 'altis', database: 'altis' };
    await fsp.writeFile(configFile, JSON.stringify(cfg));
    const other = (await doctor({ runtime: 'pm2', env: cluster })).report;
    expect(other.checks['config']!.ok).toBe(true);
    expect(other.checks['runtime']).toEqual({ ok: true, detail: expect.stringMatching(/^pm2/) });
  });
});

// ---- 1d Task 29: pending, pinned and the bundled release in the release check -------------------------------------
describe('doctor: the releases (1d Task 29)', () => {
  it('doctor --json has no licence check: an installed system passes without one, exit 0', async () => {
    await installed();
    const { code, report } = await doctor();
    expect(report.checks).not.toHaveProperty('license');
    expect(code).toBe(0);
  });

  async function writeCurrent(state: Record<string, unknown>): Promise<void> {
    await fsp.mkdir(path.join(dirs.dataDir, 'releases'), { recursive: true });
    const full = { schema: 1, previous: null, pending: null, pendingSince: null, pinned: null, ...state };
    await fsp.writeFile(path.join(dirs.dataDir, 'releases', 'current.json'), JSON.stringify(full));
  }

  it('the release check names pending, pinned and the bundled release with its relation; nothing more without current.json', async () => {
    await installed();
    await makeSignedRelease(releaseDir(), '0.1.0');
    const roots = await devRootKeys();
    expect((await doctor({ rootKeys: roots })).report.checks['release']!.detail).not.toMatch(/pending|pinned/);

    await writeCurrent({ active: { version: '0.1.0', source: 'bundled' }, pending: { version: '0.2.0', source: 'data' }, pendingSince: Date.now(), pinned: '0.0.9' });
    const appRoot = path.join(path.dirname(dirs.dataDir), 'app');
    await fsp.mkdir(path.join(appRoot, 'bundled-release', '0.1.5'), { recursive: true });
    const io = captureIo({ HOME: home }, { rootKeys: roots });
    const ctx = { ...bootContext(dirs.dataDir, { runtime: 'standalone' }), appJsVersion: '0.1.5' };
    expect(await runCli(['doctor', '--json'], ctx, io)).toBe(0);
    const check = (JSON.parse(io.out) as DoctorJson).checks['release']!;
    expect(check).toEqual({ ok: true, detail: expect.stringMatching(/^0\.1\.0 \(bundled\): .*signature and every file match/) });
    // The bundled 0.1.5 against `pending ?? active` (0.2.0), as app.js classifies it (§9.8).
    expect(check.detail).toContain('pending 0.2.0, pinned 0.0.9, terbundel / bundled 0.1.5 (older)');

    await writeCurrent({ active: { version: '0.1.0', source: 'bundled' } });
    const io2 = captureIo({ HOME: home }, { rootKeys: roots });
    await runCli(['doctor', '--json'], { ...ctx, appJsVersion: '0.1.5' }, io2);
    expect((JSON.parse(io2.out) as DoctorJson).checks['release']!.detail).toContain('pending -, pinned -, terbundel / bundled 0.1.5 (newer)');
  });
});
