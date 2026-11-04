import { fork, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, countRows, runMigrations, withTx, type DB } from '@altis/db';
import { isDomainError, newId } from '@altis/shared';
import { UpdateQueryNode, type OperationNode, type Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { guardSuperAdmins } from '../../src/authz/super-admin-guard.js';
import { ensureSystemRoles } from '../../src/authz/system-roles.js';

// Rule 6 of spec §7.2 ("minimal 1 super admin aktif", checked in the same transaction) with the lock order of
// controller ruling B4 / decision D14: the guard-row UPDATE is the first statement, then the caller's reads and
// writes, then the count. On every engine; the concurrent case runs in two child processes (B5), SQLite included.

const ctx = testDbContext();
const NOW = 1_767_225_600_000;
const ROOT = path.resolve(import.meta.dirname, '../../../..');

interface ChildReport {
  outcome: 'committed' | 'refused';
  code: string | null;
  attempts: number;
  startedAt: number;
  endedAt: number;
}

/**
 * Starts one guard-child.mjs per entry of `options`, waits until every child is ready, sends 'go' to all and resolves
 * with their exit codes and reports once all have exited. Children still running after 25 s (before the db
 * project's 30 s test timeout) are killed.
 */
async function runChildren(options: object[]): Promise<{ codes: (number | null)[]; reports: (ChildReport | undefined)[] }> {
  const children: ChildProcess[] = [];
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 25_000);
  try {
    const runs = options.map((o) => {
      const child = fork(path.join(import.meta.dirname, '../fixtures/guard-child.mjs'), [JSON.stringify(o)], {
        cwd: ROOT,
        env: process.env,
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      let report: ChildReport | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else report = message as ChildReport;
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before it was ready`)));
      });
      // 'close' comes after every IPC message has been delivered.
      const exited = new Promise<{ code: number | null; report: ChildReport | undefined }>((resolve) =>
        child.once('close', (code) => resolve({ code, report })),
      );
      return { child, ready, exited };
    });
    await Promise.all(runs.map((r) => r.ready));
    for (const r of runs) r.child.send('go');
    const done = await Promise.all(runs.map((r) => r.exited));
    return { codes: done.map((d) => d.code), reports: done.map((d) => d.report) };
  } finally {
    clearTimeout(timer);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

describe.skipIf(!ctx.available)(`guardSuperAdmins (rule 6) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let superAdminRole: string;
  let adminRole: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-guard-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await withTx(h, (trx) => ensureSystemRoles(trx, NOW));
    const roles = await h.db.selectFrom('roles').select(['id', 'key']).execute();
    superAdminRole = roles.find((r) => r.key === 'super_admin')!.id;
    adminRole = roles.find((r) => r.key === 'admin')!.id;
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('user_roles').execute();
    await h.db.deleteFrom('staff_users').execute();
  });

  async function seedUser(o: { status?: string; role?: 'super_admin' | 'admin'; branchId?: string } = {}): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('staff_users')
      .values({
        id,
        username_key: `U${id}`,
        username_display: `u${id}`,
        name: 'Staf Uji',
        password_hash: '$scrypt$test',
        status: o.status ?? 'active',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    const roleId = o.role === 'admin' ? adminRole : superAdminRole;
    const branchId = o.branchId ?? null;
    await h.db
      .insertInto('user_roles')
      .values({ id: newId(), user_id: id, role_id: roleId, branch_id: branchId, scope_key: branchId ?? '', created_at: NOW })
      .execute();
    return id;
  }

  const disable = (trx: Transaction<DB>, id: string) =>
    trx.updateTable('staff_users').set({ status: 'disabled', updated_at: NOW }).where('id', '=', id).execute();

  const statusOf = async (id: string) =>
    (await h.db.selectFrom('staff_users').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;

  const activeSuperAdmins = () =>
    countRows(
      h.db
        .selectFrom('staff_users as u')
        .innerJoin('user_roles as ur', 'ur.user_id', 'u.id')
        .where('ur.role_id', '=', superAdminRole)
        .where('ur.scope_key', '=', '')
        .where('u.status', '=', 'active'),
    );

  async function refusalOf(p: Promise<unknown>): Promise<string | null> {
    try {
      await p;
      return null;
    } catch (error) {
      if (isDomainError(error)) return error.code;
      throw error;
    }
  }

  it('with one active super admin, disabling him -> LAST_SUPER_ADMIN (409), nothing committed', async () => {
    const s = await seedUser();
    let thrown: unknown;
    try {
      await withTx(h, (trx) => guardSuperAdmins(trx, () => disable(trx, s)));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'LAST_SUPER_ADMIN', status: 409 });
    expect(await statusOf(s)).toBe('active');
  });

  it('with two active super admins, disabling one commits and returns what fn returned', async () => {
    const [s1, s2] = [await seedUser(), await seedUser()];
    const result = await withTx(h, (trx) =>
      guardSuperAdmins(trx, async () => {
        await disable(trx, s1);
        return 'done';
      }),
    );
    expect(result).toBe('done');
    expect([await statusOf(s1), await statusOf(s2)]).toEqual(['disabled', 'active']);
    expect(await activeSuperAdmins()).toBe(1);
  });

  it('counts only active users with a global super_admin assignment', async () => {
    const s = await seedUser();
    await seedUser({ status: 'disabled' });
    await seedUser({ status: 'locked' });
    await seedUser({ role: 'admin' });
    // A super_admin assignment at a branch (never written by the services: ROLE_SCOPE_INVALID) is not a super admin.
    await seedUser({ branchId: newId() });
    expect(await refusalOf(withTx(h, (trx) => guardSuperAdmins(trx, () => disable(trx, s))))).toBe('LAST_SUPER_ADMIN');
    expect(await statusOf(s)).toBe('active');
  });

  it('removing the last super_admin assignment is refused too', async () => {
    const s = await seedUser();
    const removal = withTx(h, (trx) =>
      guardSuperAdmins(trx, () => trx.deleteFrom('user_roles').where('user_id', '=', s).where('role_id', '=', superAdminRole).execute()),
    );
    expect(await refusalOf(removal)).toBe('LAST_SUPER_ADMIN');
    expect(await activeSuperAdmins()).toBe(1);
  });

  it('a failure of fn is rethrown as it is, and the count is not run', async () => {
    await seedUser();
    const failure = new Error('fn failed');
    await expect(withTx(h, (trx) => guardSuperAdmins(trx, () => Promise.reject(failure)))).rejects.toBe(failure);
  });

  it('the guard-row UPDATE is the first statement, before any statement of fn', async () => {
    await seedUser();
    await seedUser();
    const statements: OperationNode[] = [];
    await withTx(h, async (trx) => {
      const recorded = trx.withPlugin({
        transformQuery({ node }) {
          statements.push(node);
          return node;
        },
        transformResult: ({ result }) => Promise.resolve(result),
      });
      await guardSuperAdmins(recorded, async () => {
        await recorded.selectFrom('staff_users').select('id').execute();
      });
    });
    const compile = (node: OperationNode) => h.db.getExecutor().compileQuery(node as never, { queryId: 'q' } as never);
    const [first, second] = statements as [OperationNode, OperationNode];
    expect(UpdateQueryNode.is(first)).toBe(true);
    expect(compile(first).sql).toMatch(/^update ["`]roles["`] set ["`]updated_at["`] = ["`]updated_at["`] where ["`]key["`] = /);
    expect(compile(first).parameters).toEqual(['super_admin']);
    // fn's SELECT comes right after the guard; the count comes last.
    expect(compile(second).sql).toMatch(/^select ["`]id["`] from ["`]staff_users["`]$/);
    expect(compile(statements.at(-1)!).sql).toMatch(/^select count\(\*\) as ["`]n["`] from ["`]staff_users["`] as ["`]u["`]/);
  });

  it('refuses a handle that is not a transaction', async () => {
    await expect(guardSuperAdmins(h.db as unknown as Transaction<DB>, () => Promise.resolve())).rejects.toThrow(TypeError);
  });

  it('two concurrent disables (B4): exactly one commits, the other gets LAST_SUPER_ADMIN, one super admin stays active', async () => {
    const s1 = await seedUser();
    const s2 = await seedUser();
    const base = { config: h.config, dataDir: h.dataDir, pauseMs: 200 };
    const { codes, reports } = await runChildren([
      { ...base, disable: s1 },
      { ...base, disable: s2 },
    ]);
    expect(codes).toEqual([0, 0]);
    const [a, b] = reports as [ChildReport, ChildReport];
    expect([a.outcome, b.outcome].sort()).toEqual(['committed', 'refused']);
    const refused = a.outcome === 'refused' ? a : b;
    expect(refused.code).toBe('LAST_SUPER_ADMIN');
    // The two transactions overlapped in time: the second started before the first had finished.
    expect(Math.max(a.startedAt, b.startedAt)).toBeLessThan(Math.min(a.endedAt, b.endedAt));

    expect(await activeSuperAdmins()).toBe(1);
    const [st1, st2] = [await statusOf(s1), await statusOf(s2)];
    expect(a.outcome === 'committed' ? [st1, st2] : [st2, st1]).toEqual(['disabled', 'active']);
  });
});
