import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPasswordHasher, createSession } from '@altis/core';
import { FULLTEXT_DIALECT_OBJECTS, PHASE1_MIGRATIONS, TABLE_CLASSES, columnsAt, listCatalogTables, withTx, type TableName } from '@altis/db';
import { detectRuntime, type Runtime } from '@altis/platform';
import { DomainError, isUlid, newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError, describeFailure, describeKey } from '../src/cli/common.js';
import { InstallInputSchema, createFirstSuperAdmin, defaultProxyHops, seedInstall } from '../src/cli/install.js';
import { runCli } from '../src/cli/index.js';
import { describeOutcome } from '../src/cli/migrate.js';
import { writeConfig } from '../src/config.js';
import { captureIo, openInstalled, runCliChild, writeInput, type CapturedIo } from './cli-support.js';
import { bootContext, sampleConfig, useDataDir } from './support.js';

// `node app.js install --config <file>` and `migrate` (Task 15) on SQLite in a temp DATA_DIR. The same flows run
// against MariaDB 10.6 and PostgreSQL 15 in test/db/cli-engine.test.ts.

// Each case migrates a whole SQLite database and hashes a password (3.5–9 s alone, more on a loaded machine), so the
// default 5 s test timeout is too tight.
vi.setConfig({ testTimeout: 30_000 });

const dirs = useDataDir();
let home: string;
let inputDir: string;

beforeEach(async () => {
  home = path.join(dirs.root, 'home');
  inputDir = path.join(dirs.root, 'input');
  await fsp.mkdir(home);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The first super admin of every install input (Task 24); the password passes the policy. */
const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };
const BASE_INPUT = { baseUrl: 'https://Perpus.Sekolah.sch.id/', db: { dialect: 'sqlite' }, admin: ADMIN };
// The last migration of the release, by name (Phase 1d and Phase 2 add theirs), and the schema version it leaves.
const LATEST_MIGRATION = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
const LATEST_SCHEMA = LATEST_MIGRATION.slice(0, 4);
// The tables of that schema: under the test profile the registry also names the release fixtures' test_fixture
// (decision D1d-26), which this database (PHASE1_MIGRATIONS) does not have. The installs below are on SQLite: its
// catalog also lists the FTS5 search table and its shadow tables (Phase 2, Task 1).
const PHASE1_TABLES = [
  ...(Object.keys(TABLE_CLASSES) as TableName[]).filter((t) => columnsAt(t, LATEST_MIGRATION).length > 0),
  ...FULLTEXT_DIALECT_OBJECTS.sqlite,
].sort();

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: home, ...extra };
}

interface Run {
  code: number;
  io: CapturedIo;
}

async function cli(
  argv: string[],
  o: { env?: Record<string, string>; runtime?: Runtime; dataDir?: string; nodeVersion?: string; panels?: string[] } = {},
): Promise<Run> {
  // The hosting-panel markers this "host" shows: none unless a test says otherwise (the real probe looks at fixed
  // paths of the machine running the tests).
  const panels = o.panels ?? [];
  const io = captureIo(o.env ?? env(), { ...(o.nodeVersion === undefined ? {} : { nodeVersion: o.nodeVersion }), hostPanels: () => panels });
  const code = await runCli(argv, bootContext(o.dataDir ?? dirs.dataDir, { runtime: o.runtime ?? 'standalone' }), io);
  return { code, io };
}

async function install(input: unknown = BASE_INPUT, o: Parameters<typeof cli>[1] & { json?: boolean; args?: readonly string[] } = {}): Promise<Run> {
  const file = await writeInput(inputDir, input);
  return cli(['install', '--config', file, ...(o.args ?? []), ...(o.json === true ? ['--json'] : [])], o);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
}

const configFile = () => path.join(dirs.dataDir, 'config.json');
const lockFile = () => path.join(dirs.dataDir, 'install.lock');

async function exists(file: string): Promise<boolean> {
  return fsp.stat(file).then(
    () => true,
    () => false,
  );
}

interface Config {
  install: { id: string; trialStartedAt: string; runtime?: string };
  installState: string;
  trustProxy: { hops: number };
  baseUrl: string;
  db: Record<string, unknown>;
}

async function config(): Promise<Config> {
  return (await readJson(configFile())) as unknown as Config;
}

/** What the seeds left in the database of DATA_DIR. */
async function seeded(dataDir = dirs.dataDir) {
  const h = await openInstalled(dataDir);
  try {
    return {
      tables: await listCatalogTables(h),
      branches: await h.db.selectFrom('branches').selectAll().execute(),
      settings: await h.db.selectFrom('settings').selectAll().orderBy('key').execute(),
      meta: await h.db.selectFrom('schema_meta').selectAll().execute(),
      license: await h.db.selectFrom('license_state').selectAll().execute(),
      users: await h.db.selectFrom('staff_users').selectAll().execute(),
      roles: await h.db.selectFrom('roles').select(['id', 'key', 'is_system']).orderBy('key').execute(),
      userRoles: await h.db.selectFrom('user_roles').selectAll().execute(),
      audit: await h.db.selectFrom('audit_log').select(['action', 'actor_type', 'actor_id', 'entity', 'entity_id', 'meta']).orderBy('seq').execute(),
    };
  } finally {
    await h.close();
  }
}

function todayInJakarta(): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

describe('install --config: success', () => {
  it('installs: config.json complete (mode 600), install.lock, every Phase 1 table, the seeds', async () => {
    const { code, io } = await install();
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out).toMatch(/Instalasi selesai \/ Install complete/);

    const cfg = await config();
    expect(cfg.installState).toBe('complete');
    expect(cfg.trustProxy).toEqual({ hops: 0 }); // standalone
    expect(cfg.baseUrl).toBe('https://perpus.sekolah.sch.id');
    expect(cfg.db).toEqual({ dialect: 'sqlite' });
    expect(isUlid(cfg.install.id)).toBe(true);
    expect(cfg.install.trialStartedAt).toBe(todayInJakarta());
    if (process.platform !== 'win32') expect((await fsp.stat(configFile())).mode & 0o777).toBe(0o600);

    const lock = await readJson(lockFile());
    expect(lock).toEqual({ installId: cfg.install.id, at: expect.any(String) });
    expect(Number.isNaN(Date.parse(lock['at'] as string))).toBe(false);

    const db = await seeded();
    expect(db.tables).toEqual(PHASE1_TABLES);
    expect(db.branches).toEqual([
      expect.objectContaining({ code_key: 'PUSAT', code_display: 'PUSAT', is_default: 1, name: 'Perpustakaan', timezone: 'Asia/Jakarta' }),
    ]);
    expect(isUlid(db.branches[0]!.id)).toBe(true);
    expect(db.settings.map((s) => [s.key, s.value, s.scope, s.is_secret])).toEqual([
      ['library.locale', '"id"', 'data', 0],
      ['library.name', '"Perpustakaan"', 'data', 0],
      ['library.timezone', '"Asia/Jakarta"', 'data', 0],
    ]);
    // The community edition records no licence or trial: no releases/clock.json, no license_state row.
    expect(await exists(path.join(dirs.dataDir, 'releases', 'clock.json'))).toBe(false);
    expect(db.meta).toEqual([expect.objectContaining({ id: 1, install_id: cfg.install.id, schema_version: LATEST_SCHEMA })]);
    expect(db.license).toEqual([]);
  });

  it('writes the install marker {installId, DATA_DIR real path} after install.lock, as the wizard does (§7.7, R1c-5); not under docker or service', async () => {
    expect((await install()).code).toBe(0);
    const markerOf = (dataDir: string) => path.join(path.dirname(dataDir), 'app', '.altis', 'installed.json');
    expect(await readJson(markerOf(dirs.dataDir))).toEqual({ installId: (await config()).install.id, dataDir: await fsp.realpath(dirs.dataDir) });
    for (const runtime of ['docker', 'service'] as const) {
      const dataDir = path.join(dirs.root, runtime, 'altis-data');
      const run = await install(BASE_INPUT, { runtime, dataDir });
      expect(run.code, run.io.err).toBe(0);
      expect(await exists(path.join(dataDir, 'install.lock'))).toBe(true);
      expect(await exists(markerOf(dataDir))).toBe(false);
    }
  });

  it('takes the library profile and trustProxy from the input (name trimmed, time zone canonical)', async () => {
    const input = {
      ...BASE_INPUT,
      library: { name: '  Perpustakaan SMA 1  ', timezone: 'asia/makassar', locale: 'en' },
      trustProxy: { hops: 2 },
    };
    expect((await install(input)).code).toBe(0);
    expect((await config()).trustProxy).toEqual({ hops: 2 });
    const db = await seeded();
    expect(db.branches[0]).toMatchObject({ name: 'Perpustakaan SMA 1', timezone: 'Asia/Makassar' });
    expect(db.settings.map((s) => s.value)).toEqual(['"en"', '"Perpustakaan SMA 1"', '"Asia/Makassar"']);
  });

  it('defaults trustProxy.hops from the runtime: passenger, litespeed and pm2 1, the others 0', async () => {
    expect(Object.fromEntries((['passenger', 'litespeed', 'pm2', 'docker', 'service', 'standalone'] as const).map((r) => [r, defaultProxyHops(r)]))).toEqual({
      passenger: 1,
      litespeed: 1,
      pm2: 1,
      docker: 0,
      service: 0,
      standalone: 0,
    });
    expect((await install(BASE_INPUT, { runtime: 'pm2' })).code).toBe(0);
    expect((await config()).trustProxy).toEqual({ hops: 1 });
  });

  it('--json prints one JSON line, naming the input file to delete (it holds the first super admin\'s password)', async () => {
    const { code, io } = await install(BASE_INPUT, { json: true });
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toEqual({ ok: true, command: 'install', resumed: false, deleteInput: path.join(inputDir, 'input.json') });
    expect(io.out.trim().split('\n')).toHaveLength(1);
  });

  it('reminds the operator, in both languages, to delete the input file: it holds the first super admin\'s password', async () => {
    const { code, io } = await install();
    expect(code).toBe(0);
    const file = path.join(inputDir, 'input.json');
    expect(io.out).toContain(`Hapus berkas ${file} sekarang: isinya memuat sandi super admin pertama.`);
    expect(io.out).toContain(`Delete ${file} now: it holds the first super admin's password.`);
    expect(io.out).not.toContain(ADMIN.password);
    expect(io.err).toBe('');
  });

  it('a second run exits 2 with ALREADY_INSTALLED and changes nothing', async () => {
    expect((await install()).code).toBe(0);
    const before = await fsp.readFile(configFile(), 'utf8');
    const second = await install({ ...BASE_INPUT, baseUrl: 'https://lain.example' });
    expect(second.code).toBe(2);
    expect(second.io.err).toMatch(/ALREADY_INSTALLED/);
    expect(await fsp.readFile(configFile(), 'utf8')).toBe(before);
    const json = await install(BASE_INPUT, { json: true });
    expect(json.code).toBe(2);
    expect(JSON.parse(json.io.out)).toMatchObject({ ok: false, command: 'install', code: 'ALREADY_INSTALLED' });
  });

  it('install.lock alone counts as installed (exit 2)', async () => {
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    await fsp.writeFile(lockFile(), 'not even json');
    const { code, io } = await install();
    expect(code).toBe(2);
    expect(io.err).toMatch(/ALREADY_INSTALLED/);
    expect(await exists(configFile())).toBe(false);
  });

  it('two installs at once: one installs, the other waits and reports ALREADY_INSTALLED', async () => {
    const file = await writeInput(inputDir, BASE_INPUT);
    const runs = await Promise.all([1, 2].map(() => cli(['install', '--config', file])));
    expect(runs.map((r) => r.code).sort()).toEqual([0, 2]);
    const cfg = await config();
    expect((await readJson(lockFile()))['installId']).toBe(cfg.install.id);
    expect((await seeded()).meta[0]!.install_id).toBe(cfg.install.id);
  });
});

/** audit_log.meta as an object (SQLite and MySQL hand back the JSON text). */
function metaOf(row: { meta: unknown }): Record<string, unknown> {
  return (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta) as Record<string, unknown>;
}

describe('install --config: the first super admin (Task 24, D33)', () => {
  it('creates the admin: a PHC hash, no forced change, a global super_admin assignment, both system roles, one users.create', async () => {
    const { code, io } = await install();
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out + io.err).not.toContain(ADMIN.password);

    const db = await seeded();
    expect(db.users).toHaveLength(1);
    const user = db.users[0]!;
    expect(user).toMatchObject({
      username_key: 'ADMIN',
      username_display: 'admin',
      name: 'Admin',
      email_key: null,
      email_display: null,
      status: 'active',
      must_change_password: 0,
      mfa_required: 0,
      totp_enabled: 0,
      created_by: null,
    });
    expect(isUlid(user.id)).toBe(true);
    expect(user.password_hash).toMatch(/^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    const hasher = createPasswordHasher();
    expect(await hasher.verify(ADMIN.password, user.password_hash)).toBe(true);
    expect(await hasher.verify('kuda-lumping-merah', user.password_hash)).toBe(false);

    expect(db.roles.map((r) => [r.key, r.is_system])).toEqual([
      ['admin', 1],
      ['super_admin', 1],
    ]);
    const superAdmin = db.roles.find((r) => r.key === 'super_admin')!;
    expect(db.userRoles).toEqual([
      expect.objectContaining({ user_id: user.id, role_id: superAdmin.id, branch_id: null, scope_key: '', created_by: null }),
    ]);

    expect(db.audit.map((a) => [a.action, a.actor_type, a.actor_id, a.entity, a.entity_id])).toEqual([
      ['users.create', 'system', null, 'staff_users', user.id],
    ]);
    expect(metaOf(db.audit[0]!)).toEqual({ username: 'admin' });
    expect(JSON.stringify(db.audit)).not.toContain(ADMIN.password);
  });

  it('stores the username as typed after NFKC and trim (full-width, spaces) with its normalized key; the e-mail too', async () => {
    const admin = { username: '  Ａｄｍｉｎ.Perpus ', name: ' Kepala Perpustakaan ', password: ADMIN.password, email: 'Kepala@Sekolah.sch.id' };
    expect((await install({ ...BASE_INPUT, admin })).code).toBe(0);
    const [user] = (await seeded()).users;
    expect(user).toMatchObject({
      username_display: 'Admin.Perpus',
      username_key: 'ADMIN.PERPUS',
      name: 'Kepala Perpustakaan',
      email_display: 'Kepala@Sekolah.sch.id',
      email_key: 'KEPALA@SEKOLAH.SCH.ID',
    });
  });

  it('PASSWORD_TOO_WEAK (exit 1) for a common password, before anything is written (no DATA_DIR, no config.json)', async () => {
    const { code, io } = await install({ ...BASE_INPUT, admin: { ...ADMIN, password: 'qwertyuiop' } });
    expect(code).toBe(1);
    expect(io.err).toMatch(/PASSWORD_TOO_WEAK/);
    expect(io.err).not.toContain('qwertyuiop');
    expect(await exists(configFile())).toBe(false);
    expect(await exists(dirs.dataDir)).toBe(false);

    const short = await install({ ...BASE_INPUT, admin: { ...ADMIN, password: 'pendek-1' } }, { json: true });
    expect(short.code).toBe(1);
    expect(JSON.parse(short.io.out)).toMatchObject({ ok: false, command: 'install', code: 'PASSWORD_TOO_WEAK' });
    expect(await exists(configFile())).toBe(false);
  });

  it('VALIDATION_FAILED (exit 1) for a username whose normalized key exceeds 191 code points, before anything is written', async () => {
    // 64 × U+0390 passes usernameField (64 letters); upper-casing makes 3 code points of each: a key of 192.
    const { code, io } = await install({ ...BASE_INPUT, admin: { ...ADMIN, username: 'ΐ'.repeat(64) } });
    expect(code).toBe(1);
    expect(io.err).toMatch(/VALIDATION_FAILED/);
    expect(io.err).toMatch(/admin\.username/);
    expect(await exists(dirs.dataDir)).toBe(false);
  });

  it('createFirstSuperAdmin is an idempotent upsert by username_key: a second call updates, revokes the sessions, audits nothing', async () => {
    expect((await install()).code).toBe(0);
    const hasher = createPasswordHasher();
    const newHash = await hasher.hash('kuda-lumping-hijau');
    const h = await openInstalled(dirs.dataDir);
    try {
      const before = (await seeded()).users[0]!;
      const now = Date.now();
      await withTx(h, (trx) =>
        createSession(trx, { subjectId: before.id, mfaPassed: true, authzVersion: 1, ip: null, userAgent: null, now, idleMs: 60_000 }),
      );
      const again = await withTx(h, (trx) =>
        createFirstSuperAdmin(trx, { admin: { username: ' ADMIN ', name: 'Admin Baru' }, passwordHash: newHash, now: now + 1 }),
      );
      expect(again).toEqual({ userId: before.id, created: false });
      expect(await h.db.selectFrom('sessions').selectAll().execute()).toEqual([]);
      const users = await h.db.selectFrom('staff_users').selectAll().execute();
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ id: before.id, name: 'Admin Baru', password_hash: newHash, must_change_password: 0, status: 'active' });
      expect(await h.db.selectFrom('user_roles').selectAll().execute()).toHaveLength(1);
      expect((await h.db.selectFrom('audit_log').select('action').execute()).map((a) => a.action)).toEqual(['users.create']);

      // A key longer than its column is refused before any write, as the users service refuses it.
      await expect(
        withTx(h, (trx) =>
          createFirstSuperAdmin(trx, { admin: { username: 'ΐ'.repeat(64), name: 'X' }, passwordHash: newHash, now }),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', meta: { errors: [{ path: 'username', code: 'too_big' }] } });
    } finally {
      await h.close();
    }
  });
});

describe('install --config: refusals', () => {
  it('DB_NOT_EMPTY (exit 1) when the database already holds a table (staff_users of another install)', async () => {
    const h = await openInstalled(dirs.dataDir);
    await h.db.schema.createTable('staff_users').addColumn('id', 'text').execute();
    await h.close();
    const { code, io } = await install();
    expect(code).toBe(1);
    expect(io.err).toMatch(/DB_NOT_EMPTY/);
    expect(await exists(configFile())).toBe(false);
    expect(await exists(lockFile())).toBe(false);
  });

  it('INVALID_BASE_URL for a baseUrl with a path, before anything is created', async () => {
    const { code, io } = await install({ ...BASE_INPUT, baseUrl: 'https://x/perpus' });
    expect(code).toBe(1);
    expect(io.err).toMatch(/INVALID_BASE_URL/);
    expect(await exists(dirs.dataDir)).toBe(false);
  });

  it('DOCROOT_EXPOSED when DATA_DIR lies under $HOME/public_html, before anything is created', async () => {
    await fsp.mkdir(path.join(home, 'public_html'));
    const dataDir = path.join(home, 'public_html', 'altis-data');
    const { code, io } = await install(BASE_INPUT, { dataDir });
    expect(code).toBe(1);
    expect(io.err).toMatch(/DOCROOT_EXPOSED/);
    expect(await exists(dataDir)).toBe(false);
  });

  it('SQLITE_NOT_ALLOWED with ALTIS_RUNTIME=passenger, before anything is created', async () => {
    const runtime = detectRuntime({ ALTIS_RUNTIME: 'passenger' }, {});
    const { code, io } = await install(BASE_INPUT, { runtime, env: env({ ALTIS_RUNTIME: 'passenger' }) });
    expect(code).toBe(1);
    expect(io.err).toMatch(/SQLITE_NOT_ALLOWED/);
    expect(await exists(dirs.dataDir)).toBe(false);
  });

  it('SQLITE_NOT_ALLOWED also when ALTIS_DB_DIALECT turns the input into SQLite', async () => {
    const input = { ...BASE_INPUT, db: { dialect: 'mariadb', host: 'db', user: 'u', database: 'd' } };
    const { code, io } = await install(input, { runtime: 'litespeed', env: env({ ALTIS_DB_DIALECT: 'sqlite' }) });
    expect(code).toBe(1);
    expect(io.err).toMatch(/SQLITE_NOT_ALLOWED/);
  });

  it('NODE_TOO_OLD below Node 22.16', async () => {
    const { code, io } = await install(BASE_INPUT, { nodeVersion: '20.11.0' });
    expect(code).toBe(1);
    expect(io.err).toMatch(/NODE_TOO_OLD/);
    expect(io.err).toMatch(/22\.16/);
    expect(await exists(dirs.dataDir)).toBe(false);
  });

  it.each([
    ['an unknown key', { ...BASE_INPUT, superuser: { username: 'x' } }, /superuser/],
    ['a missing admin', { baseUrl: BASE_INPUT.baseUrl, db: BASE_INPUT.db }, /admin/],
    ['an unknown admin key', { ...BASE_INPUT, admin: { ...ADMIN, role: 'super_admin' } }, /admin\.role/],
    ['a username with a space inside', { ...BASE_INPUT, admin: { ...ADMIN, username: 'ad min' } }, /admin\.username/],
    ['a blank admin name', { ...BASE_INPUT, admin: { ...ADMIN, name: '  ' } }, /admin\.name/],
    ['an admin e-mail that is not one', { ...BASE_INPUT, admin: { ...ADMIN, email: 'not-an-address' } }, /admin\.email/],
    ['an unknown db key', { ...BASE_INPUT, db: { dialect: 'sqlite', pasword: 'S3CRET-VALUE' } }, /db\.pasword/],
    ['a missing baseUrl', { db: BASE_INPUT.db }, /baseUrl/],
    ['an unknown time zone', { ...BASE_INPUT, library: { timezone: 'Mars/Olympus' } }, /library\.timezone/],
    ['an unknown locale', { ...BASE_INPUT, library: { locale: 'fr' } }, /library\.locale/],
    ['a blank library name', { ...BASE_INPUT, library: { name: '   ' } }, /library\.name/],
    ['a control character in the library name', { ...BASE_INPUT, library: { name: 'Pustaka\u0007' } }, /library\.name/],
    ['too many proxy hops', { ...BASE_INPUT, trustProxy: { hops: 11 } }, /trustProxy\.hops/],
    ['an array', [BASE_INPUT], /\(root\)/],
  ])('INVALID_CONFIG for %s, naming the field and never a value', async (_what, input, where) => {
    const { code, io } = await install(input);
    expect(code).toBe(1);
    expect(io.err).toMatch(/INVALID_CONFIG/);
    expect(io.err).toMatch(where);
    expect(io.err + io.out).not.toContain('S3CRET-VALUE');
    expect(await exists(dirs.dataDir)).toBe(false);
  });

  it('INVALID_CONFIG for a file that is not JSON or has a duplicate key, never echoing it', async () => {
    for (const text of ['{"baseUrl": "https://x", "db": {"password": "S3CRET-VALUE"', '{"baseUrl":"a","baseUrl":"S3CRET-VALUE"}']) {
      const file = await writeInput(inputDir, text);
      const { code, io } = await cli(['install', '--config', file]);
      expect(code).toBe(1);
      expect(io.err).toMatch(/INVALID_CONFIG/);
      expect(io.err).not.toContain('S3CRET-VALUE');
    }
  });

  it('INVALID_CONFIG for a missing input file or a folder', async () => {
    for (const file of [path.join(inputDir, 'missing.json'), dirs.root]) {
      const { code, io } = await cli(['install', '--config', file]);
      expect(code).toBe(1);
      expect(io.err).toMatch(/INVALID_CONFIG/);
    }
  });

  it('usage errors: no --config, an unknown option, an unknown command', async () => {
    for (const argv of [['install'], ['install', '--config'], ['install', '--config', 'x', '--force'], ['frobnicate'], []]) {
      const { code, io } = await cli(argv);
      expect(code).toBe(1);
      expect(io.err).toMatch(/USAGE/);
      expect(io.err).toMatch(/install --config/);
    }
    const help = await cli(['help']);
    expect(help.code).toBe(0);
    expect(help.io.out).toMatch(/doctor \[--smoke\]/);
  });
});

describe('install --config: secrets (ruling R58, output rules)', () => {
  it('persists the input password, never ALTIS_DB_PASSWORD from the environment', async () => {
    const input = { ...BASE_INPUT, db: { dialect: 'sqlite', password: 'input-pass-1' } };
    const { code, io } = await install(input, { env: env({ ALTIS_DB_PASSWORD: 'env-pass-2' }) });
    expect(code).toBe(0);
    const text = await fsp.readFile(configFile(), 'utf8');
    expect((JSON.parse(text) as Config).db['password']).toBe('input-pass-1');
    expect(text).not.toContain('env-pass-2');
    expect(io.out + io.err).not.toMatch(/input-pass-1|env-pass-2/);
  });

  it('never persists ALTIS_DB_PASSWORD when the input has none', async () => {
    expect((await install(BASE_INPUT, { env: env({ ALTIS_DB_PASSWORD: 'env-pass-3', ALTIS_DB_USER: 'env-user' }) })).code).toBe(0);
    const text = await fsp.readFile(configFile(), 'utf8');
    expect(text).not.toContain('env-pass-3');
    expect(text).not.toContain('env-user');
    expect((JSON.parse(text) as Config).db).toEqual({ dialect: 'sqlite' });
  });

  it('prints no secret of config.json', async () => {
    const { io } = await install(BASE_INPUT, { json: true });
    const cfg = (await readJson(configFile())) as { secrets: Record<string, string>; keyring: { key: string }[]; install: { privateKey: string } };
    for (const secret of [cfg.secrets['sessionKey']!, cfg.secrets['cronToken']!, cfg.keyring[0]!.key, cfg.install.privateKey]) {
      expect(io.out + io.err).not.toContain(secret);
    }
  });
});

describe('install --config: an interrupted install resumes (P7, ruling R55)', () => {
  const appRoot = () => path.join(dirs.root, 'app');

  async function killedAt(fault: string, input: unknown = BASE_INPUT): Promise<void> {
    const file = await writeInput(inputDir, input);
    const child = await runCliChild({ argv: ['install', '--config', file], dataDir: dirs.dataDir, appRoot: appRoot(), env: env({ ALTIS_TEST_FAULT: fault }) });
    expect(child.signal, child.stderr).toBe('SIGKILL');
  }

  it('killed after the config write (ALTIS_TEST_FAULT=after-config): the rerun resumes with the same install.id', async () => {
    await killedAt('after-config');
    const half = await config();
    expect(half.installState).toBe('migrate');
    expect(await exists(lockFile())).toBe(false);

    // The operator corrects the input and runs again: same identity, the new settings.
    const { code, io } = await install({ ...BASE_INPUT, baseUrl: 'https://baru.example', library: { name: 'Pustaka' } }, { json: true });
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toEqual({ ok: true, command: 'install', resumed: true, deleteInput: path.join(inputDir, 'input.json') });
    const cfg = await config();
    expect(cfg.install).toEqual(half.install);
    expect(cfg).toMatchObject({ installState: 'complete', baseUrl: 'https://baru.example' });
    const db = await seeded();
    expect(db.meta[0]!.install_id).toBe(cfg.install.id);
    expect(db.branches).toHaveLength(1);
    expect(db.branches[0]!.name).toBe('Pustaka');
  });

  it.each(['after-migrate', 'after-seed'])('killed %s: tables exist, the rerun resumes (schema_meta.install_id null or equal)', async (fault) => {
    await killedAt(fault);
    const half = await config();
    const before = await seeded();
    expect(before.tables).toEqual(PHASE1_TABLES);
    expect(before.meta[0]!.install_id).toBe(fault === 'after-seed' ? half.install.id : null);

    const { code, io } = await install();
    expect(io.err).toBe('');
    expect(code).toBe(0);
    const cfg = await config();
    expect(cfg.install.id).toBe(half.install.id);
    const db = await seeded();
    expect(db.branches).toHaveLength(1);
    expect(db.settings.map((s) => s.key)).toEqual(['library.locale', 'library.name', 'library.timezone']);
    expect(db.license).toEqual([]);
    // Still one admin, one super_admin assignment and one users.create (the seeds' upserts, D33).
    expect(db.users).toHaveLength(1);
    expect(db.userRoles).toHaveLength(1);
    expect(db.roles.map((r) => r.key)).toEqual(['admin', 'super_admin']);
    expect(db.audit.filter((a) => a.action === 'users.create')).toEqual([expect.objectContaining({ entity_id: db.users[0]!.id })]);
    if (fault === 'after-seed') {
      expect(db.branches[0]!.id).toBe(before.branches[0]!.id); // created once
      expect(before.users).toHaveLength(1);
      expect(db.users[0]!.id).toBe(before.users[0]!.id);
    } else {
      expect(before.users).toEqual([]);
    }
  });

  it('killed after installState complete: the rerun reports ALREADY_INSTALLED and writes the missing install.lock', async () => {
    await killedAt('after-complete');
    expect(await exists(lockFile())).toBe(false);
    const { code } = await install();
    expect(code).toBe(2);
    expect((await readJson(lockFile()))['installId']).toBe((await config()).install.id);
  });

  it('a resume refuses a database whose schema_meta.install_id belongs to another install (DB_NOT_EMPTY)', async () => {
    await killedAt('after-migrate');
    const h = await openInstalled(dirs.dataDir);
    await h.db.updateTable('schema_meta').set({ install_id: newId() }).execute();
    await h.close();
    const { code, io } = await install();
    expect(code).toBe(1);
    expect(io.err).toMatch(/DB_NOT_EMPTY/);
    expect((await config()).installState).toBe('migrate');
  });

  it('without config.json, a database holding ALTIS tables is not empty (DB_NOT_EMPTY)', async () => {
    await killedAt('after-migrate');
    await fsp.rm(configFile());
    await fsp.rm(`${configFile()}.bak`, { force: true });
    const { code, io } = await install();
    expect(code).toBe(1);
    expect(io.err).toMatch(/DB_NOT_EMPTY/);
  });

  it('the seeds refuse a schema_meta that belongs to another install (STATE_CORRUPT) and write nothing', async () => {
    await killedAt('after-migrate');
    const h = await openInstalled(dirs.dataDir);
    try {
      const other = newId();
      await h.db.updateTable('schema_meta').set({ install_id: other }).execute();
      const library = { name: 'Perpustakaan', timezone: 'Asia/Jakarta', locale: 'id' } as const;
      const admin = { username: 'admin', name: 'Admin', passwordHash: await createPasswordHasher().hash(ADMIN.password) };
      await expect(seedInstall(h, { id: newId() }, library, admin)).rejects.toMatchObject({
        code: 'STATE_CORRUPT',
        meta: { reason: 'schema_meta_install_id' },
      });
      expect(await h.db.selectFrom('branches').selectAll().execute()).toEqual([]);
      expect(await h.db.selectFrom('staff_users').selectAll().execute()).toEqual([]);
      expect(await h.db.selectFrom('roles').selectAll().execute()).toEqual([]);
      expect(await h.db.selectFrom('settings').selectAll().execute()).toEqual([]);
      await seedInstall(h, { id: other }, library, admin); // the owner itself may (re)seed
      expect(await h.db.selectFrom('branches').selectAll().execute()).toHaveLength(1);
      expect(await h.db.selectFrom('staff_users').selectAll().execute()).toHaveLength(1);

      // Without an admin (the 1c wizard creates it in a later step) the seeds still make the system roles.
      await h.db.deleteFrom('user_roles').execute();
      await h.db.deleteFrom('roles').execute();
      await seedInstall(h, { id: other }, library);
      expect((await h.db.selectFrom('roles').select('key').orderBy('key').execute()).map((r) => r.key)).toEqual(['admin', 'super_admin']);
    } finally {
      await h.close();
    }
  });

  it('the fault hook is honoured in the test profile only', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('simulated kill');
    });
    const killed = await install(BASE_INPUT, { env: env({ ALTIS_TEST_FAULT: 'after-config' }) });
    expect(killed.code).toBe(1);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');

    kill.mockClear();
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    const { code } = await install(BASE_INPUT, { env: env({ ALTIS_TEST_FAULT: 'after-config' }) });
    expect(code).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('install --config: the runtime (ruling R66)', () => {
  const CPANEL = '/usr/local/cpanel';

  it('records the runtime it installed for in config.json (install.runtime)', async () => {
    expect((await install()).code).toBe(0);
    expect((await config()).install.runtime).toBe('standalone');
  });

  it('--runtime decides P20 (SQLite) for the runtime given, not the shell: passenger refuses SQLite, nothing created', async () => {
    const { code, io } = await install(BASE_INPUT, { args: ['--runtime', 'passenger'] });
    expect(code).toBe(1);
    expect(io.err).toMatch(/SQLITE_NOT_ALLOWED/);
    expect(io.err).toMatch(/passenger/);
    expect(await exists(dirs.dataDir)).toBe(false);
  });

  it('input.runtime does the same: litespeed refuses SQLite', async () => {
    const { code, io } = await install({ ...BASE_INPUT, runtime: 'litespeed' });
    expect(code).toBe(1);
    expect(io.err).toMatch(/SQLITE_NOT_ALLOWED/);
    expect(await exists(dirs.dataDir)).toBe(false);
  });

  it.each([
    ['--runtime pm2', { args: ['--runtime', 'pm2'] }, BASE_INPUT, 'pm2', 1],
    ['--runtime=docker', { args: ['--runtime=docker'] }, BASE_INPUT, 'docker', 0],
    ['input.runtime service', {}, { ...BASE_INPUT, runtime: 'service' }, 'service', 0],
  ] as const)('%s decides P15 (default hops) and is recorded', async (_name, o, input, runtime, hops) => {
    expect((await install(input, { ...o, panels: [CPANEL] })).code).toBe(0);
    const cfg = await config();
    expect(cfg.install.runtime).toBe(runtime);
    expect(cfg.trustProxy).toEqual({ hops });
  });

  it('a hosting panel on this host and only "standalone" detected from the shell: refused, asking for --runtime', async () => {
    const { code, io } = await install(BASE_INPUT, { panels: [CPANEL] });
    expect(code).toBe(1);
    expect(io.err).toMatch(/RUNTIME_REQUIRED/);
    expect(io.err).toContain('--runtime');
    expect(io.err).toContain(CPANEL);
    expect(io.err).toMatch(/passenger/);
    expect(io.err).toMatch(/Jalankan ulang/); // bilingual: Indonesian first
    expect(io.err).toMatch(/Run again/);
    expect(await exists(dirs.dataDir)).toBe(false);
    const json = await install(BASE_INPUT, { panels: [CPANEL], json: true });
    expect(JSON.parse(json.io.out)).toMatchObject({ ok: false, command: 'install', code: 'RUNTIME_REQUIRED' });
  });

  it.each([
    ['ALTIS_RUNTIME is set in the shell', { env: env({ ALTIS_RUNTIME: 'standalone' }) }],
    ['--runtime standalone', { args: ['--runtime', 'standalone'] }],
    ['the shell detected another runtime (pm2)', { runtime: 'pm2' as const }],
  ])('a hosting panel is no reason to refuse when %s', async (_name, o) => {
    expect((await install(BASE_INPUT, { ...o, panels: [CPANEL] })).code).toBe(0);
  });

  it('--runtime and input.runtime that disagree: refused (USAGE), nothing created', async () => {
    const { code, io } = await install({ ...BASE_INPUT, runtime: 'docker' }, { args: ['--runtime', 'service'] });
    expect(code).toBe(1);
    expect(io.err).toMatch(/USAGE/);
    expect(await exists(dirs.dataDir)).toBe(false);
  });

  it('an unknown runtime: USAGE for --runtime, INVALID_CONFIG for input.runtime', async () => {
    const flag = await install(BASE_INPUT, { args: ['--runtime', 'cpanel'] });
    expect(flag.code).toBe(1);
    expect(flag.io.err).toMatch(/USAGE/);
    expect(flag.io.err).toMatch(/passenger, litespeed, pm2, docker, service, standalone/);
    const input = await install({ ...BASE_INPUT, runtime: 'cpanel' });
    expect(input.code).toBe(1);
    expect(input.io.err).toMatch(/INVALID_CONFIG/);
    expect(input.io.err).toMatch(/runtime/);
    expect((await cli(['install', '--config', 'x.json', '--runtime'])).io.err).toMatch(/USAGE/);
  });

  it('only install takes --runtime', async () => {
    const { code, io } = await cli(['migrate', '--runtime', 'pm2']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/USAGE/);
  });

  it('a resumed install records the runtime of the run that completes it', async () => {
    const file = await writeInput(inputDir, BASE_INPUT);
    const child = await runCliChild({
      argv: ['install', '--config', file, '--runtime', 'docker'],
      dataDir: dirs.dataDir,
      appRoot: path.join(dirs.root, 'app'),
      env: env({ ALTIS_TEST_FAULT: 'after-config' }),
    });
    expect(child.signal, child.stderr).toBe('SIGKILL');
    expect((await config()).install.runtime).toBe('docker');
    expect((await install(BASE_INPUT, { args: ['--runtime', 'pm2'] })).code).toBe(0);
    const cfg = await config();
    expect(cfg.install.runtime).toBe('pm2');
    expect(cfg.trustProxy).toEqual({ hops: 1 });
  });
});

describe('install --config: parity with the wizard (1c Task 27, L51)', () => {
  it('prints the wizard\'s WASM and RAM warnings, and still installs', async () => {
    vi.stubGlobal('WebAssembly', {
      Memory: class {
        constructor() {
          throw new RangeError('WebAssembly.Memory(): could not allocate memory');
        }
      },
    });
    vi.spyOn(os, 'totalmem').mockReturnValue(256 * 1024 * 1024);
    const { code, io } = await install();
    expect(code).toBe(0);
    expect(io.out).toMatch(/Instalasi selesai \/ Install complete/);
    const warnings = io.err.split('\n').filter((line) => line.startsWith('PERINGATAN / WARNING: '));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('NODE_OPTIONS=--disable-wasm-trap-handler');
    expect(warnings[1]).toContain('256 MiB');
    expect((await config()).installState).toBe('complete');

    // --json carries them in its one line.
    const again = await install(BASE_INPUT, { json: true, dataDir: path.join(dirs.root, 'second') });
    expect(again.code).toBe(0);
    expect(JSON.parse(again.io.out)).toMatchObject({ ok: true, warnings: [expect.stringContaining('NODE_OPTIONS'), expect.stringContaining('256 MiB')] });
    expect(again.io.out.trim().split('\n')).toHaveLength(1);
  });

  it('an unknown input key is named only when it is a plain short name; any other is reported as <key>', async () => {
    const escape = await install({ ...BASE_INPUT, admin: { ...ADMIN, '\u001b[31mx': 1 } });
    expect(escape.code).toBe(1);
    expect(escape.io.err).toMatch(/INVALID_CONFIG/);
    expect(escape.io.err).toContain('admin.<key>');
    expect(escape.io.err).not.toContain('\u001b');
    expect(escape.io.err).not.toContain('[31mx');

    const long = await install({ ...BASE_INPUT, ['k'.repeat(65)]: 1 });
    expect(long.io.err).toContain('<key>');
    expect(long.io.err).not.toContain('k'.repeat(65));

    const plain = await install({ ...BASE_INPUT, library: { name: 'x', 'extra_key-1.v': 1 } });
    expect(plain.io.err).toContain('library.extra_key-1.v');
    expect(await exists(dirs.dataDir)).toBe(false);
  });

  it('describeFailure never shows a control character, whatever a detail holds', () => {
    expect(describeKey('ok_name-1.2')).toBe('ok_name-1.2');
    expect(describeKey('')).toBe('<key>');
    expect(describeKey('a b')).toBe('<key>');
    expect(describeKey('\u001b[2J')).toBe('<key>');
    const failure = describeFailure(new DomainError('INVALID_CONFIG', { detail: 'bad \u001b[31mred\u001b[0m\u2028line\r\n' }));
    expect(failure.detail).toBe('bad \ufffd[31mred\ufffd[0m\ufffdline\ufffd\ufffd');
    expect(describeFailure(new CliError('USAGE', 'x\u0007')).detail).toBe('x\ufffd');
  });
});

describe('InstallInputSchema', () => {
  it('is strict at every level', () => {
    expect(InstallInputSchema.safeParse({ ...BASE_INPUT, extra: 1 }).success).toBe(false);
    expect(InstallInputSchema.safeParse({ ...BASE_INPUT, library: { name: 'x', extra: 1 } }).success).toBe(false);
    expect(InstallInputSchema.safeParse({ ...BASE_INPUT, trustProxy: { hops: 1, extra: 1 } }).success).toBe(false);
    expect(InstallInputSchema.safeParse({ ...BASE_INPUT, admin: { ...ADMIN, extra: 1 } }).success).toBe(false);
    // config.json's db accepts unknown keys (D1d-2); the install input's does not (a typo is refused, not dropped).
    expect(InstallInputSchema.safeParse({ ...BASE_INPUT, db: { ...BASE_INPUT.db, pasword: 'x' } }).success).toBe(false);
    expect(InstallInputSchema.safeParse({ baseUrl: BASE_INPUT.baseUrl, db: BASE_INPUT.db }).success).toBe(false);
    expect(InstallInputSchema.safeParse(BASE_INPUT).success).toBe(true);
    expect(InstallInputSchema.safeParse({ ...BASE_INPUT, runtime: 'pm2' }).success).toBe(true);
    expect(InstallInputSchema.safeParse({ ...BASE_INPUT, runtime: 'cpanel' }).success).toBe(false);
  });
});

describe('migrate', () => {
  it('on an installed DATA_DIR: exit 0, prints up-to-date', async () => {
    expect((await install()).code).toBe(0);
    const { code, io } = await cli(['migrate']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out).toMatch(/up-to-date/);
    const json = await cli(['migrate', '--json']);
    expect(JSON.parse(json.io.out)).toEqual({
      ok: true,
      command: 'migrate',
      mode: 'up-to-date',
      applied: [],
      schemaVersion: LATEST_SCHEMA,
      minCodeVersion: '0.0.0',
      edition: { mode: 'empty', applied: [] },
    });
  });

  it('applies what is pending (migrated)', async () => {
    await writeConfig(dirs.dataDir, sampleConfig({ db: { dialect: 'sqlite' } }));
    const { code, io } = await cli(['migrate', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ ok: true, mode: 'migrated', applied: Object.keys(PHASE1_MIGRATIONS) });
    expect((await cli(['migrate'])).io.out).toMatch(/up-to-date/);
  });

  it('the human line names the migrations of another lane only when a run applied some', () => {
    const outcome = { mode: 'up-to-date' as const, applied: [], schemaVersion: '0029', minCodeVersion: '0.0.0' };
    const line = 'up-to-date: skema 0029 sudah terbaru / schema 0029 is up to date';
    expect(describeOutcome({ ...outcome, edition: { mode: 'empty', applied: [] } })).toBe(line);
    expect(describeOutcome({ ...outcome, edition: { mode: 'migrated', applied: ['e0001_x'] } })).toBe(
      `${line} (+1 migrasi jalur lain / 1 migration(s) of another lane)`,
    );
  });

  it('a database ahead of this release: exit 0 with a note (schema-ahead)', async () => {
    expect((await install()).code).toBe(0);
    const h = await openInstalled(dirs.dataDir);
    await h.db.insertInto('schema_migrations').values({ name: '9001_from_the_future', timestamp: new Date().toISOString() }).execute();
    await h.close();
    const { code, io } = await cli(['migrate']);
    expect(code).toBe(0);
    expect(io.out).toMatch(/schema-ahead/);
  });

  it('a database that needs newer code: exit 3, SCHEMA_TOO_NEW', async () => {
    expect((await install()).code).toBe(0);
    const h = await openInstalled(dirs.dataDir);
    await h.db.updateTable('schema_meta').set({ min_code_version: '9.0.0' }).execute();
    await h.close();
    const { code, io } = await cli(['migrate']);
    expect(code).toBe(3);
    expect(io.err).toMatch(/SCHEMA_TOO_NEW/);
  });

  it('before install: exit 1, NOT_INSTALLED', async () => {
    const { code, io } = await cli(['migrate']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/NOT_INSTALLED/);
  });
});
