import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, connect, runMigrations, verifyAuditChain, withTx, type DbHandle } from '@altis/db';
import { newId } from '@altis/shared';
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { ensureSystemRoles } from '../../src/authz/system-roles.js';
import { txCtx } from '../../src/context.js';
import { readDataEpoch, readMaintenance, readOpFile } from '../../src/ops/files.js';
import { readSettings, writeSettings } from '../../src/settings/service.js';
import {
  KEYRING,
  beginRestore,
  currentOp,
  loadedChecksums,
  manifestChecksums,
  restoreHarness,
  restoreParams,
  seedInstallation,
  serverBackup,
  stepUntil,
  type RestoreHarness,
} from '../fixtures/restore-support.js';

// A restore round trip (spec §9.10, A6 "hal yang dipertahankan"; decisions C16, C25; preflight B4, S2, S4; ruling
// R1c-3; plan Task 22) on the engine picked by ALTIS_TEST_DB: seed → server backup → change the data → restore. Every
// data and config table equals the backup's checksums again; the target keeps its audit rows (and the chain verifies),
// its license_state, install id, audit head and instance settings; sessions are gone, the data epoch moved once, one
// `backup.restore` entry and one restart request; the backup's history lands beside it as `imported-*.jsonl.gz`. The
// target's install id is read before anything is dropped, and the load runs on the op's dedicated connection, never on
// the process's own pool. Rows a booting process would write while the restore loads (its system roles, B4) cannot
// shadow the backup's.
//
// SQLite targets restore in place here (the test build's stand-in until Task 25's work file and swap).

const seen = vi.hoisted(() => ({ dropCalls: [] as { targetInstallId: unknown; state: string | null }[], dataDir: '' }));
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  return {
    ...actual,
    dropRegisteredTables: async (...args: Parameters<typeof actual.dropRegisteredTables>) => {
      // What op.json says at the moment of the drop (the restore's own call; the test's setup passes no op).
      let op: { params?: Record<string, unknown>; state?: string } | null;
      try {
        op = JSON.parse(await readFile(join(seen.dataDir, 'ops', 'op.json'), 'utf8')) as { params?: Record<string, unknown>; state?: string };
      } catch {
        op = null;
      }
      if (op !== null) seen.dropCalls.push({ targetInstallId: op.params?.['targetInstallId'], state: op.state ?? null });
      return actual.dropRegisteredTables(...args);
    },
  };
});
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const INSTALL_ID = newId();

/** Records the tables each Kysely instance inserts into, deletes from or drops. */
function recorder(into: string[]): KyselyPlugin {
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      const node = args.node as { kind: string; into?: { table: { identifier: { name: string } } }; from?: { froms: { table?: { identifier: { name: string } } }[] } };
      if (node.kind === 'InsertQueryNode' && node.into !== undefined) into.push(`insert:${node.into.table.identifier.name}`);
      if (node.kind === 'DeleteQueryNode') into.push(`delete:${node.from?.froms[0]?.table?.identifier.name ?? '?'}`);
      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      return args.result;
    },
  };
}

describe.skipIf(!ctx.available)(`restore round trip [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let harness: RestoreHarness;
  const liveWrites: string[] = [];
  const dedicatedWrites: string[] = [];

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-restore-basic-')));
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    seen.dataDir = dataDir;
    seen.dropCalls.length = 0;
    liveWrites.length = 0;
    dedicatedWrites.length = 0;
    const { dropRegisteredTables } = await import('@altis/db');
    await dropRegisteredTables(h.db, h.dialect);
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await seedInstallation(h, { dataDir, installId: INSTALL_ID });
    const live: DbHandle = { ...h, db: h.db.withPlugin(recorder(liveWrites)) };
    harness = restoreHarness({
      dataDir,
      config: h.config,
      dbDataDir: h.dataDir,
      live,
      installId: INSTALL_ID,
      connect: async () => {
        const d = await connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir });
        return { ...d, db: d.db.withPlugin(recorder(dedicatedWrites)) };
      },
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  const auditNow = (n: number) =>
    withTx(h, async (trx) => {
      for (let i = 0; i < n; i += 1) {
        await txCtx(trx, Date.now(), { type: 'system', id: null, ip: null }).audit({ action: 'audit.purge', entity: 'audit_log', entityId: null, meta: { after: i } });
      }
    });

  it('round trip: checksums back to the backup, the target keeps install and history rows, one audit entry, one restart', async () => {
    const { backupId, manifest } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    // Changes after the backup: a new user, the library name, 50 audit entries, an instance setting, a session, the
    // license row, and the events floor and clock confirmation (R1c-3).
    const now = Date.now();
    await h.db
      .insertInto('staff_users')
      .values({ id: newId(), username_key: 'baru', username_display: 'baru', name: 'Baru', password_hash: 'x', status: 'active', created_at: now, updated_at: now })
      .execute();
    await withTx(h, (trx) =>
      writeSettings(
        trx,
        { 'library.name': 'Nama Baru', 'system.ip_trust': 'collapsed', 'system.events_floor': 7, 'system.clock_confirmed': { at: now, auditSeq: 3 } },
        { keyring: KEYRING, now, actorId: null },
      ),
    );
    await auditNow(50);
    await h.db
      .insertInto('sessions')
      .values({ id: 'a'.repeat(64), subject_type: 'staff', subject_id: newId(), created_at: now, last_seen_at: now, expires_at: now + 60_000, mfa_passed: 0, authz_version: 1 })
      .execute();
    await h.db.updateTable('license_state').set({ status_cache: 'active', clock_high_water: now + 1 }).execute();
    const license = await h.db.selectFrom('license_state').selectAll().execute();
    const head = await h.db.selectFrom('audit_head').selectAll().execute();
    const auditIds = (await h.db.selectFrom('audit_log').select('id').execute()).map((r) => r.id).sort();
    const epoch = await readDataEpoch(dataDir);

    const opId = await beginRestore(harness, restoreParams(backupId));
    const status = await stepUntil(harness, dataDir);
    expect(status).toMatchObject({ opId, kind: 'restore', state: 'done', terminal: true, error: null, progress: 100, backupId: opId });
    expect(await readMaintenance(dataDir)).toBeNull();

    // Data back to the backup (notifications: the archive's plus the restore's own).
    expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
    const notes = await h.db.selectFrom('notifications').select('type').execute();
    expect(notes.map((n) => n.type)).toEqual(['restore.done']);
    expect((await readSettings(h.db, ['library.name'], []))['library.name']).toBe('Perpustakaan Arsya');
    expect(await h.db.selectFrom('staff_users').select('id').where('username_key', '=', 'baru').execute()).toEqual([]);

    // Kept: install rows, history, instance settings; R1c-3 resets.
    expect(await h.db.selectFrom('license_state').selectAll().execute()).toEqual(license);
    const meta = await h.db.selectFrom('schema_meta').select('install_id').execute();
    expect(meta).toEqual([{ install_id: INSTALL_ID }]);
    const restoredIds = (await h.db.selectFrom('audit_log').select('id').execute()).map((r) => r.id);
    expect(restoredIds.filter((id) => auditIds.includes(id)).sort()).toEqual(auditIds);
    expect(restoredIds).toHaveLength(auditIds.length + 1);
    const newHead = await h.db.selectFrom('audit_head').selectAll().execute();
    expect(Number(newHead[0]!.last_seq)).toBe(Number(head[0]!.last_seq) + 1);
    expect((await verifyAuditChain(h)).ok).toBe(true);
    const instance = await readSettings(h.db, ['system.ip_trust', 'system.events_floor', 'system.clock_confirmed'], []);
    expect(instance).toEqual({ 'system.ip_trust': 'collapsed', 'system.events_floor': 0, 'system.clock_confirmed': null });
    expect(await h.db.selectFrom('sessions').select('id').execute()).toEqual([]);
    expect(await readDataEpoch(dataDir)).toBe(epoch + 1);

    // One audit entry of the restore, one restart, the history kept beside the backup.
    const entries = await h.db.selectFrom('audit_log').select(['meta', 'entity', 'entity_id']).where('action', '=', 'backup.restore').execute();
    expect(entries).toHaveLength(1);
    const backupRow = await h.db.selectFrom('backups').select('sha256').where('id', '=', backupId).executeTakeFirstOrThrow();
    expect(JSON.parse(entries[0]!.meta)).toEqual({
      opId,
      archiveSha256: backupRow.sha256,
      archiveAuditHead: manifest.auditHead,
      sourceInstallId: INSTALL_ID,
      secretsBranch: 'a',
      outcome: 'done',
    });
    expect(harness.deps.requestRestart.calls).toEqual(['restore']);
    await expect(fsp.stat(path.join(dataDir, 'backups', backupId, 'imported-audit_log.jsonl.gz'))).resolves.toBeTruthy();
    // The pre_restore backup (the op's own id) is ok and kept in the target's `backups`.
    expect(await h.db.selectFrom('backups').select(['kind', 'status']).where('id', '=', opId).execute()).toEqual([{ kind: 'pre_restore', status: 'ok' }]);

    // C16: the install id was read before the drop; S4: the load wrote through the dedicated connection only.
    expect(seen.dropCalls).toEqual([{ targetInstallId: INSTALL_ID, state: 'loading' }]);
    for (const table of ['branches', 'staff_users', 'roles', 'settings', 'audit_log', 'license_state']) {
      expect(liveWrites).not.toContain(`insert:${table}`);
      expect(dedicatedWrites).toContain(`insert:${table}`);
    }
    expect(liveWrites.filter((w) => !w.endsWith(':events'))).toEqual([]);
    expect((await readOpFile(dataDir)) as { secretParam?: unknown }).not.toHaveProperty('secretParam');
  });

  it('B4: roles written into the target while it loads (a booting process) do not survive; the roles are the archive’s', async () => {
    const { backupId } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    const archived = await h.db.selectFrom('roles').selectAll().orderBy('id').execute();
    // The target's roles now carry other ids (made by another ensureSystemRoles).
    await h.db.deleteFrom('user_roles').execute();
    await h.db.deleteFrom('roles').execute();
    await withTx(h, (trx) => ensureSystemRoles(trx, Date.now()));
    const targetRoles = await h.db.selectFrom('roles').select('id').execute();
    expect(targetRoles.map((r) => r.id).some((id) => archived.some((a) => a.id === id))).toBe(false);

    await beginRestore(harness, restoreParams(backupId));
    await stepUntil(harness, dataDir, (op) => (op.params['load'] as { migrated?: boolean } | undefined)?.migrated === true, { budgetMs: 1 });
    expect((await currentOp(dataDir)).params['load']).toMatchObject({ migrated: true, table: 0 });
    // A booting process's ensureSystemRoles on the freshly migrated, still empty tables.
    await withTx(h, (trx) => ensureSystemRoles(trx, Date.now()));
    expect((await h.db.selectFrom('roles').select('id').execute()).length).toBeGreaterThan(0);

    const status = await stepUntil(harness, dataDir);
    expect(status).toMatchObject({ state: 'done' });
    expect(await h.db.selectFrom('roles').selectAll().orderBy('id').execute()).toEqual(archived);
    await withTx(h, (trx) => ensureSystemRoles(trx, Date.now()));
    expect(await h.db.selectFrom('roles').selectAll().orderBy('id').execute()).toEqual(archived);
  });
});
