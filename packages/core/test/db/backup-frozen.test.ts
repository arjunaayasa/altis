import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx } from '@altis/db';
import { resetTestFaults } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { backupTables } from '../../src/backup/canonical.js';
import type { BackupDeps } from '../../src/backup/create-job.js';
import { backupKind } from '../../src/backup/frozen-op.js';
import { readManifest, verifyManifestHmac } from '../../src/backup/manifest.js';
import { snapshotBackupRunning } from '../../src/backup/mode.js';
import { txCtx } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { readMaintenance, readOpFile, type OpFile } from '../../src/ops/files.js';
import { FREEZE_SETTLE_MS } from '../../src/ops/freeze.js';
import { OPS_STALL_MS, createOpsMachine, type OpStatus, type OpsMachine } from '../../src/ops/machine.js';

// The frozen backup: the `backup` op kind (spec §9.4, §9.9 "frozen"; decisions C9, C12; preflight S24; P21) on the
// engine picked by ALTIS_TEST_DB. Maintenance `backup`, the freeze, `frozen` → `exporting` (one exporter step per op
// step, the checkpoint in op.params) → `done` with the row ok and the flag lowered; a lease alive through the freeze
// aborts it; a full disk aborts it with its folder removed; a cancel too.

const hooks = vi.hoisted(() => ({
  /** Folders whose removal fails with EBUSY (a file in them held open, as Windows refuses it). */
  busy: new Set<string>(),
}));
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  const removeTree: typeof actual.removeTree = async (p) => {
    if (hooks.busy.has(p)) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${p}'`), { code: 'EBUSY' });
    return actual.removeTree(p);
  };
  // A real probe writes 64 MiB per new DATA_DIR; the snapshot job's test checks the size asked for.
  return { ...actual, ensureHeadroom: async () => {}, removeTree };
});

const ctx = testDbContext();
const KEY = new Uint8Array(32).fill(31);
const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: Buffer.alloc(32, 4).toString('base64url'), active: true }];
const INSTALL_ID = newId();
const SYSTEM = { type: 'system', id: null } as const;
const silent = { info() {}, warn() {}, error() {} };

describe.skipIf(!ctx.available)(`backup op (frozen) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let ops: OpsMachine;
  /** Added to the real clock: the freeze waits at least 3 s after the flag went up. */
  let offset: number;
  const clock = (): number => Date.now() + offset;

  const deps = (): BackupDeps => ({ dataDir, installId: INSTALL_ID, appVersion: '0.1.0', sessionKey: KEY, kids: ['k1'] });

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backup-frozen-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'backups', 'events', 'notifications'] as const) await h.db.deleteFrom(table).execute();
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    offset = 0;
    hooks.busy.clear();
    ops = createOpsMachine({
      dataDir,
      kinds: [backupKind(deps)],
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => KEYRING,
      clock,
      log: silent,
      snapshotBackupRunning: () => snapshotBackupRunning(h, Date.now()),
    });
    vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', '5');
    resetTestFaults();
  });

  afterEach(async () => {
    await ops.close();
    vi.unstubAllEnvs();
    resetTestFaults();
  });

  /** Steps the op (each call ≤ `budgetMs`) until it ends or `calls` calls were made. */
  async function stepUntilEnd(calls = 200, budgetMs = 2500): Promise<OpStatus | null> {
    let status: OpStatus | null = null;
    for (let i = 0; i < calls; i += 1) {
      status = await ops.step(budgetMs);
      if (status === null || status.terminal) break;
    }
    return status;
  }

  const rows = () => h.db.selectFrom('backups').selectAll().execute();
  const exists = (p: string) =>
    fsp.stat(p).then(
      () => true,
      () => false,
    );

  it('begin → maintenance backup; after the freeze frozen → exporting → done: row ok (frozen), manifest, flag gone', async () => {
    const { opId } = await ops.begin('backup', SYSTEM, { kind: 'manual', includeFiles: false });
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'backup', opId });
    // Within the settle time nothing moves.
    expect(await ops.step(2000)).toMatchObject({ state: 'frozen' });
    expect(await rows()).toEqual([]);
    offset = 4000;
    // A budget under the exporter's 2 s margin: each step does one unit of work (a part, a checksum, the manifest),
    // so the export takes several steps (each with its progress hint) however fast this machine writes.
    const status = await stepUntilEnd(2000, 1000);
    expect(status).toMatchObject({ opId, kind: 'backup', state: 'done', terminal: true, backupId: opId, progress: 100 });
    expect(await readMaintenance(dataDir)).toBeNull();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: opId, kind: 'manual', consistency: 'frozen', status: 'ok', dialect: h.dialect });
    const manifest = await readManifest(dataDir, opId);
    expect(manifest).toMatchObject({ consistency: 'frozen', kind: 'manual', installId: INSTALL_ID });
    expect(verifyManifestHmac(KEY, manifest!)).toBe(true);
    const events = await h.db.selectFrom('events').select(['type', 'payload']).where('channel', '=', 'system.backup').orderBy('seq').execute();
    expect(events.filter((e) => e.type === 'op.progress').length).toBeGreaterThan(1);
    // R1c-13: each exporting step also publishes `backup.progress {backupId, progress}`, as a snapshot backup's slice does.
    const progress = events.filter((e) => e.type === 'backup.progress').map((e) => JSON.parse(e.payload!) as { backupId: string; progress: number });
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.length).toBe(events.filter((e) => e.type === 'op.progress').length);
    for (const p of progress) expect(Object.keys(p).sort()).toEqual(['backupId', 'progress']);
    expect(progress.every((p) => p.backupId === opId && Number.isInteger(p.progress) && p.progress >= 0 && p.progress <= 100)).toBe(true);
    expect(progress.map((p) => p.progress)).toEqual([...progress.map((p) => p.progress)].sort((a, b) => a - b));
    expect(events.filter((e) => e.type === 'backup.done')).toEqual([{ type: 'backup.done', payload: JSON.stringify({ backupId: opId }) }]);
    expect(await h.db.selectFrom('notifications').select('type').execute()).toEqual([{ type: 'backup.done' }]);
  });

  it('the manifest holds the audit head of the freeze, and the archived audit_log ends there (sign-ins come after)', async () => {
    const audit = () =>
      withTx(h, (trx) => txCtx(trx, Date.now(), { type: 'system', id: null, ip: null }).audit({ action: 'audit.purge', entity: 'audit_log', entityId: null, meta: {} }));
    const headNow = async () => {
      const row = await h.db.selectFrom('audit_head').select(['last_seq', 'last_hash']).where('id', '=', 1).executeTakeFirstOrThrow();
      return { seq: Number(row.last_seq), hash: row.last_hash };
    };
    await audit();
    const { opId } = await ops.begin('backup', SYSTEM, { kind: 'manual', includeFiles: false });
    offset = 4000;
    const state = async () => {
      const op = await readOpFile(dataDir);
      return op === null || op === 'corrupt' ? null : op.state;
    };
    for (let i = 0; i < 10 && (await state()) !== 'exporting'; i += 1) await ops.step(10);
    expect(await state()).toBe('exporting');
    const frozenHead = await headNow();
    // Normal maintenance allows signing in (and its audit entry) while the export goes on.
    await audit();
    expect((await headNow()).seq).toBe(frozenHead.seq + 1);
    const status = await stepUntilEnd(2000, 1000);
    expect(status).toMatchObject({ opId, state: 'done' });
    const manifest = await readManifest(dataDir, opId);
    expect(manifest!.auditHead).toEqual(frozenHead);
    const dir = path.join(dataDir, 'backups', opId, 'tables', 'audit_log');
    const archived: { seq: number; hash: string }[] = [];
    for (const name of (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl.gz')).sort()) {
      for (const line of gunzipSync(await fsp.readFile(path.join(dir, name))).toString('utf8').split('\n')) {
        if (line !== '') archived.push(JSON.parse(line) as { seq: number; hash: string });
      }
    }
    expect(archived.at(-1)).toMatchObject(frozenHead);
    expect(manifest!.tables['audit_log']!.rows).toBe(archived.length);
  });

  it('a job lease alive for 61 s → aborted with OPS_FREEZE_TIMEOUT, maintenance cleared, no backup row', async () => {
    const t = Date.now();
    await h.db
      .insertInto('jobs')
      .values({ id: newId(), type: 'x.y', payload: '{}', status: 'running', run_at: t, max_attempts: 5, lock_token: 'tok', locked_by: 'w', locked_until: t + 3_600_000, created_at: t, updated_at: t })
      .execute();
    await ops.begin('backup', SYSTEM, { kind: 'scheduled', includeFiles: false });
    offset = 30_000;
    expect(await ops.step(1000)).toMatchObject({ state: 'frozen' });
    offset = 61_000;
    const status = await ops.step(1000);
    expect(status).toMatchObject({ state: 'aborted', terminal: true, error: { code: 'OPS_FREEZE_TIMEOUT' } });
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await rows()).toEqual([]);
  });

  it('a full disk (disk-full:backups:3) → aborted: folder removed, row failed, disk_low once, maintenance cleared', async () => {
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:backups:3');
    resetTestFaults();
    const { opId } = await ops.begin('backup', SYSTEM, { kind: 'manual', includeFiles: false });
    offset = 4000;
    const status = await stepUntilEnd(200, 20_000);
    expect(status).toMatchObject({ state: 'aborted', terminal: true, error: { code: 'DISK_QUOTA' } });
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await rows()).toMatchObject([{ id: opId, status: 'failed' }]);
    expect(await exists(path.join(dataDir, 'backups', opId))).toBe(false);
    const notes = await h.db.selectFrom('notifications').select('type').orderBy('type').execute();
    expect(notes).toEqual([{ type: 'backup.failed' }, { type: 'disk.low' }]);
  });

  it('a failure after the row is ok (the retention cannot remove an old folder) → done, the backup kept, no backup_failed', async () => {
    // Ten manual backups: the eleventh makes the oldest go, whose folder cannot be removed (EBUSY on Windows).
    const old: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const at = Date.now() - (30 - i) * 86_400_000;
      const id = newId(at);
      await h.db
        .insertInto('backups')
        .values({ id, kind: 'manual', size: 10, sha256: null, schema_version: '0009_ops_jobs', app_version: '0.1.0', dialect: h.dialect, consistency: 'frozen', status: 'ok', created_at: at })
        .execute();
      await fsp.mkdir(path.join(dataDir, 'backups', id, 'tables'), { recursive: true });
      old.push(id);
    }
    hooks.busy.add(path.join(dataDir, 'backups', old[0]!));
    const { opId } = await ops.begin('backup', SYSTEM, { kind: 'manual', includeFiles: false });
    offset = 4000;
    const status = await stepUntilEnd(200, 20_000);
    expect(status).toMatchObject({ opId, state: 'done', terminal: true, backupId: opId });
    expect(await readMaintenance(dataDir)).toBeNull();
    expect((await rows()).find((r) => r.id === opId)).toMatchObject({ status: 'ok' });
    expect(await readManifest(dataDir, opId)).not.toBeNull();
    expect((await rows()).find((r) => r.id === old[0])).toMatchObject({ status: 'deleted' });
    const notes = await h.db.selectFrom('notifications').select('type').execute();
    expect(notes).toEqual([{ type: 'backup.done' }]);
  });

  it('cancel while exporting → aborted, folder removed, row failed, maintenance cleared', async () => {
    const { opId } = await ops.begin('backup', SYSTEM, { kind: 'manual', includeFiles: false });
    offset = 4000;
    for (let i = 0; i < 4; i += 1) await ops.step(10);
    expect(await readOpFile(dataDir)).toMatchObject({ state: 'exporting', backupId: opId });
    expect(await exists(path.join(dataDir, 'backups', opId))).toBe(true);
    const status = await ops.cancel({ type: 'cli', id: null });
    expect(status).toMatchObject({ state: 'aborted', terminal: true });
    expect(await rows()).toMatchObject([{ id: opId, status: 'failed' }]);
    expect(await exists(path.join(dataDir, 'backups', opId))).toBe(false);
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('refrozen, then a job lease alive past the freeze wait → aborted with OPS_FREEZE_TIMEOUT, its row failed and folder removed (R1c-15)', async () => {
    const { opId } = await ops.begin('backup', SYSTEM, { kind: 'manual', includeFiles: false });
    offset = 4000;
    for (let i = 0; i < 4; i += 1) await ops.step(10);
    expect(await readOpFile(dataDir)).toMatchObject({ state: 'exporting', backupId: opId });
    expect(await exists(path.join(dataDir, 'backups', opId))).toBe(true);
    offset += OPS_STALL_MS + 1000;
    expect(await ops.step(10)).toMatchObject({ state: 'needs_attention' });
    await fsp.rm(path.join(dataDir, 'ops', 'maintenance.json')); // maintenance:off --force
    // A job taken while the site served, whose lease outlives the freeze wait.
    const t = clock();
    await h.db
      .insertInto('jobs')
      .values({ id: newId(), type: 'x.y', payload: '{}', status: 'running', run_at: t, max_attempts: 5, lock_token: 'tok', locked_by: 'w', locked_until: t + 3_600_000, created_at: t, updated_at: t })
      .execute();

    expect(await ops.resume()).toMatchObject({ opId, state: 'frozen', backupId: opId });
    offset += 30_000;
    expect(await ops.step(1000)).toMatchObject({ state: 'frozen' });
    offset += 31_000;
    const status = await ops.step(1000);
    expect(status).toMatchObject({ opId, state: 'aborted', terminal: true, error: { code: 'OPS_FREEZE_TIMEOUT' } });
    expect(await rows()).toMatchObject([{ id: opId, status: 'failed' }]);
    expect(await exists(path.join(dataDir, 'backups', opId))).toBe(false);
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('needs attention while exporting, maintenance forced off, rows written meanwhile: resume freezes again and the export starts over (final review G2)', async () => {
    const readOp = async (): Promise<OpFile> => {
      const op = await readOpFile(dataDir);
      if (op === null || op === 'corrupt') throw new Error('no readable op.json');
      return op;
    };
    const branch = async (): Promise<string> => {
      const id = newId();
      const t = Date.now();
      await h.db
        .insertInto('branches')
        .values({ id, code_key: id, code_display: id, name: 'Cabang', address: null, timezone: 'Asia/Jakarta', archived_at: null, created_at: t, created_by: null, updated_at: t, updated_by: null })
        .execute();
      return id;
    };
    const role = async (): Promise<string> => {
      const id = newId();
      const t = Date.now();
      await h.db.insertInto('roles').values({ id, key: `r_${id.toLowerCase()}`, name: 'Peran', description: null, created_at: t, created_by: null, updated_at: t, updated_by: null }).execute();
      return id;
    };
    /** The ids the finished backup archived for `table`, from its part files. */
    const archived = async (opId: string, table: string): Promise<string[]> => {
      const dir = path.join(dataDir, 'backups', opId, 'tables', table);
      const ids: string[] = [];
      for (const name of (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl.gz')).sort()) {
        for (const line of gunzipSync(await fsp.readFile(path.join(dir, name))).toString('utf8').split('\n')) {
          if (line !== '') ids.push((JSON.parse(line) as { id: string }).id);
        }
      }
      return ids;
    };
    const seeded: string[] = [];
    for (let i = 0; i < 7; i += 1) seeded.push(await branch());
    const order = backupTables().map((t) => t.table);
    const { opId } = await ops.begin('backup', SYSTEM, { kind: 'manual', includeFiles: false });
    offset = 4000;
    // One unit of export per step: on until `branches` is written whole and `roles` not begun.
    const tableAt = async (): Promise<number> => {
      const cp = (await readOp()).params['checkpoint'] as { phase: string; table: number } | null | undefined;
      return cp?.phase === 'tables' ? cp.table : -1;
    };
    for (let i = 0; i < 100 && (await tableAt()) <= order.indexOf('branches'); i += 1) await ops.step(10);
    expect(await tableAt()).toBeGreaterThan(order.indexOf('branches'));
    expect(await tableAt()).toBeLessThan(order.indexOf('roles'));

    // The database stops answering for 15 minutes: the op needs attention, and the operator brings the site back.
    offset += OPS_STALL_MS + 1000;
    expect(await ops.step(10)).toMatchObject({ state: 'needs_attention' });
    await fsp.rm(path.join(dataDir, 'ops', 'maintenance.json')); // maintenance:off --force
    expect(await ops.step(10)).toMatchObject({ state: 'needs_attention' });
    expect(await readMaintenance(dataDir)).toBeNull();
    // The site serves for an hour: a branch (its table archived already) and a role (not yet) are written.
    const lateBranch = await branch();
    const lateRole = await role();
    offset += 3_600_000;
    const firstFreeze = (await rows())[0]!.created_at;
    const resumedAt = clock();

    expect(await ops.resume()).toMatchObject({ opId, needsAttention: false });
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'backup', opId });
    // The next step waits for the freeze again (the flag was raised just now), it does not go on exporting.
    expect(await ops.step(1000)).toMatchObject({ opId, terminal: false });
    expect((await readOp()).params).not.toHaveProperty('frozenAt');
    offset += FREEZE_SETTLE_MS + 1000;
    const status = await stepUntilEnd(2000, 1000);
    expect(status).toMatchObject({ opId, state: 'done', terminal: true });
    expect(await rows()).toMatchObject([{ id: opId, status: 'ok' }]);

    // Neither write is missed, so the backup is not torn: each table as the database holds it now.
    const manifest = await readManifest(dataDir, opId);
    expect(verifyManifestHmac(KEY, manifest!)).toBe(true);
    const branchIds = (await h.db.selectFrom('branches').select('id').execute()).map((r) => r.id);
    const roleIds = (await h.db.selectFrom('roles').select('id').execute()).map((r) => r.id);
    expect(await archived(opId, 'branches')).toContain(lateBranch);
    expect(await archived(opId, 'roles')).toContain(lateRole);
    expect((await archived(opId, 'branches')).sort()).toEqual(branchIds.sort());
    expect((await archived(opId, 'roles')).sort()).toEqual(roleIds.sort());
    expect(manifest!.tables['branches']!.rows).toBe(branchIds.length);
    // The backup dates from the freeze it was made under, as its manifest does, not from the first one.
    const createdAt = (await rows())[0]!.created_at;
    expect(firstFreeze).toBeLessThan(resumedAt - 3_600_000);
    expect(createdAt).toBeGreaterThanOrEqual(resumedAt);
    expect(manifest!.createdAt).toBeGreaterThanOrEqual(createdAt);
    expect(manifest!.createdAt - createdAt).toBeLessThan(60_000);
    await h.db.deleteFrom('roles').where('id', '=', lateRole).execute();
    await h.db.deleteFrom('branches').where('id', 'in', [...seeded, lateBranch]).execute();
  });
});
