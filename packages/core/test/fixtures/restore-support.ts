import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PHASE1_MIGRATIONS, connect, withTx, type AltisMigration, type DbConfig, type DbHandle, type TableName } from '@altis/db';
import { dataPath, uploadPath } from '@altis/platform';
import { newId } from '@altis/shared';
import { readAltisbakHeader } from '../../src/archive/altisbak.js';
import { ensureSystemRoles } from '../../src/authz/system-roles.js';
import { tableChecksumFromDb } from '../../src/backup/canonical.js';
import { auditHeadOf, insertBackupRow, schemaVersionOf } from '../../src/backup/create-job.js';
import { createExporter, type ExportCheckpoint } from '../../src/backup/exporter.js';
import { readManifest, type BackupManifest } from '../../src/backup/manifest.js';
import { backupPrepareDownloadJob, deriveDownloadKey, enqueuePrepareDownload, preparedDownloadPath } from '../../src/backup/prepare-download.js';
import { txCtx } from '../../src/context.js';
import { sealValue, secretAad, type KeyringEntry } from '../../src/crypto/secret-box.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { opFilePath, readOpFile, type OpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpStatus, type OpsMachine } from '../../src/ops/machine.js';
import { loadTables } from '../../src/restore/load.js';
import { restoreKind, type RestoreKindDeps, type RestoreParams } from '../../src/restore/kind.js';
import { SCHEDULES } from '../../src/scheduler/registry.js';
import { seedSchedules } from '../../src/scheduler/tick.js';
import { writeSettings } from '../../src/settings/service.js';

// What the restore tests (test/db/restore-*.test.ts) share: an installation's keys, a seeded database, a server backup
// of it, a restore machine and the checksums a restore is judged by.

export const SESSION_KEY = new Uint8Array(32).fill(31);
export const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: Buffer.alloc(32, 4).toString('base64url'), active: true }];
export const SYSTEM = { type: 'system', id: null } as const;
export const SCHEMA_VERSION = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
export const silent = { info() {}, warn() {}, error() {} };

/** The committed SQLite fixtures (scripts/gen-restore-fixtures.ts). */
export const FIXTURES = {
  'pad-space': '01K5Q8M2X0PADSPACE00000000',
  conflicts: '01K5Q8M2X0C0NF11CTS0000000',
} as const;

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

/** The TOTP secrets (base32 text) of the seeded users that have one, by user id. */
export interface Seeded {
  users: { id: string; username: string; totp: string | null }[];
  files: { id: string; content: Buffer }[];
  smtpPassword: string;
}

/**
 * Seeds `h` (already migrated) as an installation: system roles, schedules, settings (with the secret smtp.password),
 * branches, five staff users (two with TOTP sealed with `keyring`) and their roles, two uploads (rows and files under
 * `dataDir`), a few audit entries, a license row and `schema_meta.install_id`.
 */
export async function seedInstallation(
  h: DbHandle,
  o: { dataDir: string; installId: string; keyring?: readonly KeyringEntry[]; now?: number },
): Promise<Seeded> {
  const keyring = o.keyring ?? KEYRING;
  const now = o.now ?? Date.now();
  const seeded: Seeded = { users: [], files: [], smtpPassword: 'sandi-surel-rahasia' };
  await withTx(h, async (trx) => {
    await ensureSystemRoles(trx, now);
    await seedSchedules(trx, now, 'Asia/Jakarta', SCHEDULES);
    await writeSettings(
      trx,
      {
        'library.name': 'Perpustakaan Arsya',
        'smtp.host': 'mail.example.test',
        'smtp.username': 'surel',
        'smtp.password': seeded.smtpPassword,
        'system.ip_trust': 'ok',
      },
      { keyring, now, actorId: null },
    );
    for (let i = 0; i < 3; i += 1) {
      await trx
        .insertInto('branches')
        .values({
          id: newId(now),
          code_key: `CB${i}`,
          code_display: `CB${i}`,
          name: `Cabang ${i}`,
          address: i === 0 ? null : `Jalan ${i}`,
          timezone: 'Asia/Jakarta',
          is_default: i === 0 ? 1 : 0,
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    const admin = await trx.selectFrom('roles').select('id').where('key', '=', 'admin').executeTakeFirstOrThrow();
    for (let i = 0; i < 5; i += 1) {
      const id = newId(now);
      const totp = i < 2 ? `JBSWY3DPEHPK3PX${'ABCDE'[i]}` : null;
      seeded.users.push({ id, username: `staf_${i}`, totp });
      await trx
        .insertInto('staff_users')
        .values({
          id,
          username_key: `staf_${i}`,
          username_display: `staf_${i}`,
          name: `Staf ${i}`,
          password_hash: 'x',
          status: 'active',
          totp_secret_enc: totp === null ? null : sealValue(keyring, secretAad('staff_users', 'totp_secret_enc', id), totp),
          totp_enabled: totp === null ? 0 : 1,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await trx
        .insertInto('user_roles')
        .values({ id: newId(now), user_id: id, role_id: admin.id, branch_id: null, scope_key: 'global', created_at: now, created_by: null })
        .execute();
    }
    for (let i = 0; i < 2; i += 1) {
      const id = newId(now);
      const content = Buffer.from(`isi berkas unggahan ${i}\n`.repeat(i + 1));
      seeded.files.push({ id, content });
      await trx
        .insertInto('files')
        .values({
          id,
          original_name: `berkas-${i}.txt`,
          mime: 'text/plain',
          size: content.byteLength,
          sha256: sha256(content),
          context: 'test',
          access: 'staff',
          status: 'ok',
          created_at: now,
        })
        .execute();
    }
    await trx
      .insertInto('license_state')
      .values({ install_id: o.installId, license_raw: null, status_cache: 'trial', checked_at: now, grace_until: null, last_heartbeat_at: null, clock_high_water: now })
      .execute();
    await trx.updateTable('schema_meta').set({ install_id: o.installId }).where('id', '=', 1).execute();
    for (let i = 0; i < 3; i += 1) {
      await txCtx(trx, now, { type: 'system', id: null, ip: null }).audit({ action: 'audit.purge', entity: 'audit_log', entityId: null, meta: { seed: i } });
    }
  });
  for (const f of seeded.files) {
    const file = uploadPath(o.dataDir, f.id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, f.content);
  }
  return seeded;
}

/**
 * A server backup of `h` (frozen: the test writes nothing meanwhile) under `dataDir`: its folder with the manifest,
 * and its `backups` row `ok` with the manifest's SHA-256. `includeFiles` puts the uploads' blobs in
 * `backups/blobs/`.
 */
export async function serverBackup(
  h: DbHandle,
  o: { dataDir: string; installId: string; sessionKey?: Uint8Array; kids?: string[]; includeFiles?: boolean; now?: number },
): Promise<{ backupId: string; manifest: BackupManifest }> {
  const backupId = newId();
  const now = o.now ?? Date.now();
  const schemaVersion = await schemaVersionOf(h.db);
  await insertBackupRow(h, { id: backupId, kind: 'manual', consistency: 'frozen', dialect: h.dialect, schemaVersion, appVersion: '0.1.0', now });
  const exporter = createExporter({
    read: h.db,
    dialect: h.dialect,
    dataDir: o.dataDir,
    backupId,
    kind: 'manual',
    includeFiles: o.includeFiles ?? false,
    consistency: 'frozen',
    appVersion: '0.1.0',
    schemaVersion,
    installId: o.installId,
    sessionKey: o.sessionKey ?? SESSION_KEY,
    kids: o.kids ?? ['k1'],
    auditHead: await auditHeadOf(h.db),
    clock: () => now,
  });
  let cp: ExportCheckpoint | null = null;
  for (;;) {
    const r = await exporter.step(cp, { deadline: Date.now() + 60_000 });
    cp = r.checkpoint;
    if (r.done) break;
  }
  const bytes = await fsp.readFile(path.join(o.dataDir, 'backups', backupId, 'manifest.json'));
  await h.db.updateTable('backups').set({ status: 'ok', size: bytes.byteLength, sha256: sha256(bytes) }).where('id', '=', backupId).execute();
  return { backupId, manifest: (await readManifest(o.dataDir, backupId))! };
}

/** Copies the committed fixture `variant` into `backups/<id>/` of `dataDir` and gives it an `external` row. */
export async function installFixture(h: DbHandle, dataDir: string, variant: keyof typeof FIXTURES): Promise<{ backupId: string; manifest: BackupManifest }> {
  const backupId = FIXTURES[variant];
  const target = path.join(dataDir, 'backups', backupId);
  await fsp.cp(path.join(import.meta.dirname, 'sqlite-archive', variant), target, { recursive: true });
  const manifest = (await readManifest(dataDir, backupId))!;
  const bytes = await fsp.readFile(path.join(target, 'manifest.json'));
  await h.db
    .insertInto('backups')
    .values({
      id: backupId,
      kind: 'external',
      size: bytes.byteLength,
      sha256: sha256(bytes),
      schema_version: manifest.schemaVersion,
      app_version: manifest.appVersion,
      dialect: manifest.dialect,
      consistency: manifest.consistency,
      status: 'ok',
      created_at: Date.now(),
    })
    .execute();
  return { backupId, manifest };
}

/** The checksum of each loaded table of `manifest` in the database `h` (at the manifest's schema version). */
export async function loadedChecksums(h: DbHandle, manifest: BackupManifest, skip: readonly string[] = []): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of loadTables(manifest)) {
    if (skip.includes(table)) continue;
    out[table] = await tableChecksumFromDb(h.db, h.dialect, table, { schemaVersion: manifest.schemaVersion });
  }
  return out;
}

/** The manifest's checksums of the same tables. */
export function manifestChecksums(manifest: BackupManifest, skip: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of loadTables(manifest)) if (!skip.includes(table)) out[table] = manifest.tables[table]!.checksum;
  return out;
}

/** The checksum of every table of `tables` in `h` now (all columns of the registry). */
export async function liveChecksums(h: DbHandle, tables: readonly TableName[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = await tableChecksumFromDb(h.db, h.dialect, t);
  return out;
}

/** What a test restore machine was made with. */
export interface RestoreHarness {
  ops: OpsMachine;
  deps: RestoreKindDeps & { requestRestart: ReturnType<typeof makeRestart> };
  /** Moves the machine's clock (the freeze waits 3 s after the flag). */
  advance(ms: number): void;
  close(): Promise<void>;
}

function makeRestart() {
  const calls: string[] = [];
  const fn = async (reason: string): Promise<void> => {
    calls.push(reason);
  };
  return Object.assign(fn, { calls });
}

/**
 * A machine with the `restore` kind on DATA_DIR `dataDir` for the database `config` (opened again from `dbDataDir` for
 * the op's dedicated connection). `live` is the machine's own handle (the process's pool), or undefined (a process
 * waiting in `ops_wait`). `migrations` are the code's (default PHASE1_MIGRATIONS).
 */
export function restoreHarness(o: {
  dataDir: string;
  config: DbConfig;
  dbDataDir: string;
  live?: DbHandle;
  installId: string;
  keyring?: KeyringEntry[];
  sessionKey?: Uint8Array;
  connect?: () => Promise<DbHandle>;
  migrations?: Readonly<Record<string, AltisMigration>>;
}): RestoreHarness {
  let offset = 0;
  const keyring = o.keyring ?? KEYRING;
  const sessionKey = o.sessionKey ?? SESSION_KEY;
  const requestRestart = makeRestart();
  const deps = {
    dataDir: o.dataDir,
    appVersion: '0.1.0',
    migrations: o.migrations ?? PHASE1_MIGRATIONS,
    sessionKey: () => sessionKey,
    keyring: () => keyring,
    installId: o.installId,
    requestRestart,
    sqliteSwap: null,
  };
  const ops = createOpsMachine({
    dataDir: o.dataDir,
    kinds: [restoreKind(deps)],
    db: () => o.live,
    connect: o.connect ?? (() => connect(o.config, { runtime: 'standalone', purpose: 'cli', dataDir: o.dbDataDir })),
    keyring: () => keyring,
    clock: () => Date.now() + offset,
    log: silent,
    snapshotBackupRunning: async () => false,
  });
  return {
    ops,
    deps,
    advance(ms) {
      offset += ms;
    },
    close: () => ops.close(),
  };
}

/** The params of a restore of `backupId`. */
export function restoreParams(backupId: string, o: Partial<RestoreParams> = {}): RestoreParams {
  return { backupId, source: 'server', withoutFiles: false, confirmed: false, targetSchema: 'latest', ...o };
}

/** The op as op.json holds it now. */
export async function currentOp(dataDir: string): Promise<OpFile> {
  const op = await readOpFile(dataDir);
  if (op === null || op === 'corrupt') throw new Error('no readable op.json');
  return op;
}

/** Begins the restore and moves the clock past the freeze's settle time. */
export async function beginRestore(harness: RestoreHarness, params: RestoreParams, o: { secret?: Uint8Array } = {}): Promise<string> {
  const { opId } = await harness.ops.begin('restore', SYSTEM, params, o);
  harness.advance(4000);
  return opId;
}

/**
 * Steps the op (each call `budgetMs`) until `until(op)` holds for op.json, the op ends, or `calls` calls were made.
 * Returns the last status.
 */
export async function stepUntil(
  harness: RestoreHarness,
  dataDir: string,
  until: (op: OpFile) => boolean = () => false,
  o: { budgetMs?: number; calls?: number } = {},
): Promise<OpStatus | null> {
  let status: OpStatus | null = null;
  for (let i = 0; i < (o.calls ?? 5000); i += 1) {
    status = await harness.ops.step(o.budgetMs ?? 20_000);
    if (status === null || status.terminal || status.needsAttention) break;
    if (until(await currentOp(dataDir))) break;
  }
  return status;
}

/** A second handle of the test's own on the database (outside any machine). */
export function ownHandle(config: DbConfig, dbDataDir: string): Promise<DbHandle> {
  return connect(config, { runtime: 'standalone', purpose: 'cli', dataDir: dbDataDir });
}

/**
 * One step of the op (budget 1 ms) by a process that is SIGKILLed after its database commits and file writes but before
 * op.json is written (P7): op.json and its `.bak` are put back as they were before the step.
 */
export async function stepKilledAfterCommit(harness: RestoreHarness, dataDir: string): Promise<void> {
  const file = opFilePath(dataDir);
  const read = (p: string): Promise<Buffer | null> => fsp.readFile(p).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  const [op, bak] = [await read(file), await read(`${file}.bak`)];
  await harness.ops.step(1);
  for (const [p, bytes] of [[file, op], [`${file}.bak`, bak]] as const) {
    if (bytes === null) await fsp.rm(p, { force: true });
    else await fsp.writeFile(p, bytes);
  }
}

/**
 * The `.altisbak` of the server backup `backupId` of `h`, prepared by Task 21's job for the staff user `preparedBy`
 * (encrypted with `passphrase`, or not), copied to a new file in `into`.
 */
export async function preparedArchive(
  h: DbHandle,
  o: { dataDir: string; backupId: string; preparedBy: string; passphrase: string | null; into: string },
): Promise<string> {
  const reg = createJobRegistry([backupPrepareDownloadJob(() => ({ dataDir: o.dataDir, keyring: KEYRING, sessionKey: SESSION_KEY }))]);
  const key = o.passphrase === null ? null : await deriveDownloadKey(o.passphrase);
  const { jobId } = await withTx(h, (trx) =>
    enqueuePrepareDownload(trx, { backupId: o.backupId, preparedBy: o.preparedBy, superAdmin: true, key, now: Date.now(), keyring: KEYRING }),
  );
  for (let i = 0; i < 500; i += 1) {
    const job = await claimById(h, reg, jobId, { worker: 'w1', now: Date.now() });
    if (job === null) break;
    const r = await runSlice(h, reg, job, { mode: 'cron_cli', budgetMs: 20_000, keyring: KEYRING, log: silent, clock: () => Date.now(), env: process.env });
    if (r.outcome !== 'continued') break;
  }
  const archive = preparedDownloadPath(o.dataDir, o.backupId, o.preparedBy, 'archive.altisbak');
  await fsp.stat(archive);
  const copy = path.join(o.into, `${newId()}.altisbak`);
  await fsp.copyFile(archive, copy);
  return copy;
}

/** `archive` uploaded into `dataDir` as a new backup (`backups/<id>/archive.altisbak`, kind external, status uploaded). */
export async function uploadedArchive(h: DbHandle, dataDir: string, archive: string): Promise<string> {
  const backupId = newId();
  const target = path.join(dataDir, 'backups', backupId, 'archive.altisbak');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(archive, target);
  const header = await readAltisbakHeader(dataPath(dataDir, 'backups', backupId, 'archive.altisbak'));
  const bytes = await fsp.readFile(target);
  await h.db
    .insertInto('backups')
    .values({
      id: backupId,
      kind: 'external',
      size: bytes.byteLength,
      sha256: sha256(bytes),
      schema_version: header.schemaVersion,
      app_version: header.appVersion,
      dialect: header.dialect,
      consistency: header.consistency,
      status: 'uploaded',
      created_at: Date.now(),
    })
    .execute();
  return backupId;
}
