import fsp from 'node:fs/promises';
import path from 'node:path';
import { createOpsMachine, readMaintenance, readOpFile, resetKind } from '@altis/core';
import { FULLTEXT_DIALECT_OBJECTS, PHASE1_MIGRATIONS, TABLE_CLASSES, columnsAt, connect, listCatalogTables, type DbHandle, type TableName } from '@altis/db';
import { describe, beforeEach, expect, it } from 'vitest';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import { runCli } from '../../src/cli/index.js';
import { captureIo, runCliChild, writeInput, type CapturedIo } from '../cli-support.js';
import { bootContext, recordingLogger, useDataDir } from '../support.js';

// The headless install, migrate and doctor --smoke (Task 15) against the engine picked by ALTIS_TEST_DB (the `db`
// Vitest project): SQLite, and in CI MariaDB 10.6 and PostgreSQL 15. Every test starts from an empty database.

const engine = testDbContext();
const dirs = useDataDir();
// The tables of the Phase 1 schema: under the test profile the registry also names the release fixtures' test_fixture
// (decision D1d-26), which this database (PHASE1_MIGRATIONS) does not have.
const PHASE1_SCHEMA = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
const PHASE1_TABLES: string[] = (Object.keys(TABLE_CLASSES) as TableName[]).filter((t) => columnsAt(t, PHASE1_SCHEMA).length > 0).sort();

beforeEach(async () => {
  if (engine.available) await (await testDb()).close(); // empties the worker's database
  await fsp.mkdir(path.join(dirs.root, 'home'));
});

const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };
const input = (admin: Record<string, unknown> = ADMIN) => ({ baseUrl: 'https://perpus.example', db: testDbConfig(), library: { name: 'Pustaka Engine' }, admin });
const env = () => ({ HOME: path.join(dirs.root, 'home') });

async function cli(argv: string[], dataDir = dirs.dataDir): Promise<{ code: number; io: CapturedIo }> {
  const io = captureIo(env());
  const code = await runCli(argv, bootContext(dataDir), io);
  return { code, io };
}

async function install(dataDir = dirs.dataDir, admin: Record<string, unknown> = ADMIN): Promise<{ code: number; io: CapturedIo }> {
  return cli(['install', '--config', await writeInput(path.join(dirs.root, 'input'), input(admin))], dataDir);
}

/** The first super admin as the seeds left it (Task 24): users, system roles, assignments, users.create entries. */
async function adminState(h: DbHandle) {
  return {
    users: await h.db.selectFrom('staff_users').select(['id', 'username_key', 'password_hash', 'must_change_password', 'status']).execute(),
    roles: await h.db.selectFrom('roles').select(['id', 'key', 'is_system']).orderBy('key').execute(),
    userRoles: await h.db.selectFrom('user_roles').select(['user_id', 'role_id', 'branch_id', 'scope_key']).execute(),
    creates: await h.db.selectFrom('audit_log').select(['actor_type', 'entity_id']).where('action', '=', 'users.create').execute(),
  };
}

function expectOneSuperAdmin(state: Awaited<ReturnType<typeof adminState>>): void {
  expect(state.users).toEqual([
    { id: expect.any(String), username_key: 'ADMIN', password_hash: expect.stringMatching(/^\$scrypt\$ln=15,r=8,p=1\$/), must_change_password: 0, status: 'active' },
  ]);
  expect(state.roles.map((r) => [r.key, r.is_system])).toEqual([
    ['admin', 1],
    ['super_admin', 1],
  ]);
  const superAdmin = state.roles.find((r) => r.key === 'super_admin')!;
  expect(state.userRoles).toEqual([{ user_id: state.users[0]!.id, role_id: superAdmin.id, branch_id: null, scope_key: '' }]);
  expect(state.creates).toEqual([{ actor_type: 'system', entity_id: state.users[0]!.id }]);
}

/** The installed database, as the CLI reaches it (SQLite: the file in DATA_DIR). */
function open(dataDir = dirs.dataDir): Promise<DbHandle> {
  return connect(testDbConfig(), { runtime: 'standalone', purpose: 'cli', dataDir });
}

async function installId(dataDir = dirs.dataDir): Promise<string> {
  return (JSON.parse(await fsp.readFile(path.join(dataDir, 'config.json'), 'utf8')) as { install: { id: string } }).install.id;
}

describe.skipIf(!engine.available)(`CLI against the database [${engineLabel()}]`, () => {
  it('install: exit 0, every Phase 1 table and the seeds; a second run exits 2', async () => {
    const { code, io } = await install();
    expect(io.err).toBe('');
    expect(code).toBe(0);
    const id = await installId();
    const h = await open();
    try {
      // PostgreSQL also lists the identity sequences of events.seq and search_doc.doc_no (sequences count for the empty
      // check, R55); SQLite the FTS5 search table and its shadow tables (Phase 2, Task 1).
      const listed = await listCatalogTables(h);
      expect(listed.filter((name) => PHASE1_TABLES.includes(name))).toEqual(PHASE1_TABLES);
      const extra = engine.engine.startsWith('pg')
        ? ['events_seq_seq', 'search_doc_doc_no_seq']
        : engine.engine === 'sqlite'
          ? [...FULLTEXT_DIALECT_OBJECTS.sqlite].sort()
          : [];
      expect(listed.filter((name) => !PHASE1_TABLES.includes(name))).toEqual(extra);
      expect(await h.db.selectFrom('branches').selectAll().execute()).toEqual([
        expect.objectContaining({ code_key: 'PUSAT', code_display: 'PUSAT', is_default: 1, name: 'Pustaka Engine', timezone: 'Asia/Jakarta' }),
      ]);
      const settings = await h.db.selectFrom('settings').select(['key', 'value', 'scope', 'is_secret']).orderBy('key').execute();
      expect(settings).toEqual([
        { key: 'library.locale', value: '"id"', scope: 'data', is_secret: 0 },
        { key: 'library.name', value: '"Pustaka Engine"', scope: 'data', is_secret: 0 },
        { key: 'library.timezone', value: '"Asia/Jakarta"', scope: 'data', is_secret: 0 },
      ]);
      expect((await h.db.selectFrom('schema_meta').select('install_id').executeTakeFirstOrThrow()).install_id).toBe(id);
      // The community edition records no licence or trial.
      expect(await h.db.selectFrom('license_state').selectAll().execute()).toEqual([]);
      expectOneSuperAdmin(await adminState(h));
    } finally {
      await h.close();
    }
    expect(JSON.parse(await fsp.readFile(path.join(dirs.dataDir, 'install.lock'), 'utf8'))).toMatchObject({ installId: id });

    const again = await install();
    expect(again.code).toBe(2);
    expect(again.io.err).toMatch(/ALREADY_INSTALLED/);
  }, 60_000);

  it('DB_NOT_EMPTY: the database holds staff_users of another install', async () => {
    if (engine.engine === 'sqlite') {
      // The SQLite database lives in DATA_DIR: plant the table there.
      const h = await open();
      await h.db.schema.createTable('staff_users').addColumn('id', 'text').execute();
      await h.close();
    } else {
      // Another DATA_DIR installed into this database first.
      expect((await install(path.join(dirs.root, 'other-data'))).code).toBe(0);
    }
    const { code, io } = await install();
    expect(code).toBe(1);
    expect(io.err).toMatch(/DB_NOT_EMPTY/);
    await expect(fsp.stat(path.join(dirs.dataDir, 'config.json'))).rejects.toThrow();
  }, 60_000);

  it('PASSWORD_TOO_WEAK: a common admin password is refused before config.json or the database is touched', async () => {
    const { code, io } = await install(dirs.dataDir, { ...ADMIN, password: 'qwertyuiop' });
    expect(code).toBe(1);
    expect(io.err).toMatch(/PASSWORD_TOO_WEAK/);
    await expect(fsp.stat(path.join(dirs.dataDir, 'config.json'))).rejects.toThrow();
    if (engine.engine !== 'sqlite') {
      const h = await open();
      try {
        expect(await listCatalogTables(h)).toEqual([]);
      } finally {
        await h.close();
      }
    }
  }, 60_000);

  it.each(['after-config', 'after-migrate', 'after-seed'])('an install killed %s resumes with the same install.id', async (fault) => {
    const file = await writeInput(path.join(dirs.root, 'input'), input());
    const child = await runCliChild({
      argv: ['install', '--config', file],
      dataDir: dirs.dataDir,
      appRoot: path.join(dirs.root, 'app'),
      env: { ...env(), ALTIS_TEST_FAULT: fault },
    });
    expect(child.signal, child.stderr).toBe('SIGKILL');
    const id = await installId();

    const { code, io } = await cli(['install', '--config', file, '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toEqual({ ok: true, command: 'install', resumed: true, deleteInput: file });
    expect(await installId()).toBe(id);
    const h = await open();
    try {
      expect((await h.db.selectFrom('schema_meta').select('install_id').executeTakeFirstOrThrow()).install_id).toBe(id);
      expect(await h.db.selectFrom('branches').select('code_key').execute()).toEqual([{ code_key: 'PUSAT' }]);
      expectOneSuperAdmin(await adminState(h)); // still one user and one users.create after the rerun
    } finally {
      await h.close();
    }
  }, 60_000);

  it('user:reset-password, user:disable-2fa and config:set, audited by the cli', async () => {
    expect((await install()).code).toBe(0);
    const reset = await cli(['user:reset-password', 'admin', '--json']);
    expect(reset.io.err).toBe('');
    expect(reset.code).toBe(0);
    expect(JSON.parse(reset.io.out)).toEqual({ ok: true, command: 'user:reset-password', temporaryPassword: expect.stringMatching(/^[0-9a-z]{4}(-[0-9a-z]{4}){3}$/) });
    expect((await cli(['user:disable-2fa', 'admin'])).code).toBe(0);
    expect((await cli(['user:reset-password', 'nobody'])).io.err).toMatch(/NOT_FOUND/);
    const set = await cli(['config:set', 'baseUrl', 'https://perpus.x.sch.id', '--json']);
    expect(JSON.parse(set.io.out)).toEqual({ ok: true, command: 'config:set', key: 'baseUrl', audited: true });

    const h = await open();
    try {
      const user = await h.db.selectFrom('staff_users').select(['id', 'must_change_password', 'totp_enabled']).executeTakeFirstOrThrow();
      expect(user).toMatchObject({ must_change_password: 1, totp_enabled: 0 });
      const audit = await h.db.selectFrom('audit_log').select(['action', 'actor_type', 'entity_id']).where('actor_type', '=', 'cli').orderBy('seq').execute();
      expect(audit).toEqual([
        { action: 'users.password.reset', actor_type: 'cli', entity_id: user.id },
        { action: 'users.2fa.reset', actor_type: 'cli', entity_id: user.id },
        { action: 'system.config.update', actor_type: 'cli', entity_id: null },
      ]);
    } finally {
      await h.close();
    }
  }, 60_000);

  it('migrate prints up-to-date; doctor --smoke passes', async () => {
    expect((await install()).code).toBe(0);
    const migrate = await cli(['migrate']);
    expect(migrate.code).toBe(0);
    expect(migrate.io.out).toMatch(/up-to-date/);

    const doctor = await cli(['doctor', '--smoke', '--json']);
    const report = JSON.parse(doctor.io.out) as { ok: boolean; checks: Record<string, { ok: boolean; detail: string }>; smoke: { ok: boolean } };
    expect(report.checks['db']).toEqual({ ok: true, detail: expect.stringMatching(engine.engine.startsWith('pg') ? /postgres/ : engine.engine === 'sqlite' ? /sqlite/ : /mariadb|mysql/) });
    expect(report.checks['migrations']!.ok).toBe(true);
    expect(report.smoke.ok).toBe(true);
    expect(report.ok).toBe(true);
    expect(doctor.code).toBe(0);
  }, 60_000);

  it('1c Task 24: migrate runs under the ops lock: with an op in progress → exit 1 OPS_IN_PROGRESS; otherwise the op ends done', async () => {
    expect((await install()).code).toBe(0);
    // An op another process began and has not finished.
    const other = createOpsMachine({
      dataDir: dirs.dataDir,
      kinds: [resetKind()],
      db: () => undefined,
      connect: () => Promise.reject(new Error('no database here')),
      keyring: () => [],
      clock: () => Date.now(),
      log: recordingLogger(),
      snapshotBackupRunning: async () => false,
    });
    const busy = await other.begin('reset', { type: 'cli', id: null }, {});
    const refused = await cli(['migrate']);
    expect(refused.code).toBe(1);
    expect(refused.io.err).toMatch(/OPS_IN_PROGRESS/);
    expect(await readOpFile(dirs.dataDir)).toMatchObject({ opId: busy.opId, kind: 'reset', state: 'running' });
    await other.cancel({ type: 'cli', id: null });
    await other.close();

    const { code, io } = await cli(['migrate', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    // The schema version of the last migration (by name; Phase 1d and Phase 2 add theirs).
    const latest = (Object.keys(PHASE1_MIGRATIONS).sort().at(-1) ?? '').slice(0, 4);
    // A community install ships no migration of the other lane: `edition` says so, without that lane's table being read.
    expect(JSON.parse(io.out)).toEqual({
      ok: true,
      command: 'migrate',
      mode: 'up-to-date',
      applied: [],
      schemaVersion: latest,
      minCodeVersion: '0.0.0',
      edition: { mode: 'empty', applied: [] },
    });
    expect(await readOpFile(dirs.dataDir)).toMatchObject({ kind: 'migrate', state: 'done', actor: { type: 'cli', id: null }, error: null });
    expect(await readMaintenance(dirs.dataDir)).toBeNull();
  }, 60_000);
});
