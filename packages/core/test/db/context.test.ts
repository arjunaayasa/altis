import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, verifyAuditChain, withTx } from '@altis/db';
import { newId, type AuditAction } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { runnerFor, securityAudit, txCtx, type Actor } from '../../src/context.js';

// The actor and audit context of core services (spec §7.8): txCtx(...).audit appends inside the action's
// transaction, with the actor's fields; securityAudit records a security event in a transaction of its own, so it
// stays when the action's transaction rolls back (a failed login, a denial); runnerFor opens one transaction per
// call for the CLI and the tests. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const GENESIS = '0'.repeat(64);
/** A fixed `now` in the past: audit `at` must not be ahead of the clock. */
const NOW = 1_767_225_600_000;

describe.skipIf(!ctx.available)(`txCtx / securityAudit / runnerFor [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-context-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('audit_log').execute();
    await h.db.updateTable('audit_head').set({ last_seq: 0, last_hash: GENESIS }).where('id', '=', 1).execute();
  });

  const rows = () => h.db.selectFrom('audit_log').selectAll().orderBy('seq').execute();

  const staff = (): Actor => ({ type: 'staff', id: newId(), ip: '203.0.113.9' });

  it('txCtx(...).audit inside withTx appends one row with the actor fields, at `now`', async () => {
    const actor = staff();
    const branchId = newId();
    const entityId = newId();
    await withTx(h, async (trx) => {
      const tx = txCtx(trx, NOW, actor);
      expect(tx.trx).toBe(trx);
      expect(tx.now).toBe(NOW);
      expect(tx.actor).toEqual(actor);
      await tx.audit({ action: 'users.update', entity: 'staff_users', entityId, branchId, meta: { fields: ['email'] } });
    });
    const written = await rows();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      seq: 1,
      at: NOW,
      actor_type: 'staff',
      actor_id: actor.id,
      ip: '203.0.113.9',
      action: 'users.update',
      entity: 'staff_users',
      entity_id: entityId,
      branch_id: branchId,
      meta: '{"fields":["email"]}',
    });
    expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 1 });
  });

  it('defaults branchId to null and meta to {}; an actor without id or ip is written as null', async () => {
    await withTx(h, (trx) =>
      txCtx(trx, NOW, { type: 'system', id: null, ip: null }).audit({ action: 'settings.update', entity: 'settings', entityId: null }),
    );
    expect(await rows()).toMatchObject([
      { actor_type: 'system', actor_id: null, ip: null, action: 'settings.update', entity: 'settings', entity_id: null, branch_id: null, meta: '{}' },
    ]);
  });

  it('an entry written with txCtx rolls back with its transaction', async () => {
    await expect(
      withTx(h, async (trx) => {
        await txCtx(trx, NOW, staff()).audit({ action: 'users.update', entity: 'staff_users', entityId: newId() });
        throw new Error('the action failed');
      }),
    ).rejects.toThrow('the action failed');
    expect(await rows()).toEqual([]);
  });

  it('securityAudit after a rolled-back withTx still leaves its own row', async () => {
    const anonymous: Actor = { type: 'anonymous', id: null, ip: '198.51.100.4' };
    await expect(
      withTx(h, async (trx) => {
        await txCtx(trx, NOW, anonymous).audit({ action: 'auth.login.success', entity: 'staff_users', entityId: newId() });
        throw new Error('wrong password');
      }),
    ).rejects.toThrow('wrong password');
    await securityAudit(h, NOW, anonymous, { action: 'auth.login.failed', entity: null, entityId: null, meta: { stage: 'password' } });
    expect(await rows()).toMatchObject([
      { seq: 1, at: NOW, actor_type: 'anonymous', actor_id: null, ip: '198.51.100.4', action: 'auth.login.failed', meta: '{"stage":"password"}' },
    ]);
    expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 1 });
  });

  it('securityAudit inside a withTx callback is refused (R49: it opens its own transaction)', async () => {
    await expect(
      withTx(h, () => securityAudit(h, NOW, staff(), { action: 'authz.denied', entity: null, entityId: null })),
    ).rejects.toThrow(TypeError);
    expect(await rows()).toEqual([]);
  });

  it('runnerFor runs each call in its own transaction with the actor, which o.actor replaces', async () => {
    const actor = staff();
    const cli: Actor = { type: 'cli', id: null, ip: null };
    const run = runnerFor(h, NOW, actor);
    const seen = await run(async (tx) => {
      await tx.audit({ action: 'users.create', entity: 'staff_users', entityId: newId() });
      return { now: tx.now, actor: tx.actor, inTx: tx.trx.isTransaction };
    });
    expect(seen).toEqual({ now: NOW, actor, inTx: true });
    await run((tx) => tx.audit({ action: 'users.password.reset', entity: 'staff_users', entityId: newId() }), { actor: cli });
    await expect(
      run(async (tx) => {
        await tx.audit({ action: 'users.disable', entity: 'staff_users', entityId: newId() });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect((await rows()).map((r) => [r.action, r.actor_type, r.actor_id])).toEqual([
      ['users.create', 'staff', actor.id],
      ['users.password.reset', 'cli', null],
    ]);
  });

  it('audit refuses an action outside the AUDIT_ACTIONS registry before writing anything', async () => {
    await expect(
      withTx(h, (trx) =>
        txCtx(trx, NOW, staff()).audit({ action: 'users.explode' as AuditAction, entity: null, entityId: null }),
      ),
    ).rejects.toThrow(TypeError);
    expect(await rows()).toEqual([]);
  });
});
