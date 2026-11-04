import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  backupPrepareDownloadJob,
  claimById,
  createJobRegistry,
  deriveDownloadKey,
  enqueuePrepareDownload,
  preparedDownloadPath,
  readManifest,
  runSlice,
} from '@altis/core';
import { withTx, type DbHandle } from '@altis/db';
import { copyOperatorFile, dataPath, ensureHeadroom } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadedChecksums, manifestChecksums, sha256 } from '../../../packages/core/test/fixtures/restore-support.js';
import { runCli } from '../src/cli/index.js';
import { loadConfig } from '../src/config.js';
import { csrfKey } from '../src/http/csrf.js';
import { captureIo, openInstalled, writeInput } from './cli-support.js';
import { bootContext } from './support.js';

// `node app.js backup:restore <file|backupId> [--without-files] [--yes-external <library name>] [--json]` (spec §9.10,
// §9.9 "frasa sandi", §13.6; plan Task 29) on SQLite, in temp DATA_DIRs installed with the CLI:
//
// - installation B makes a backup (`backup:create`) and Task 21's job prepares it as an `.altisbak` encrypted
//   with PASSPHRASE: an archive of another installation, as an operator would copy it onto installation A;
// - on A, the file is copied into `backups/<newId>/archive.altisbak` and registered (kind external, status uploaded),
//   the passphrase is read from ALTIS_BACKUP_PASSPHRASE (or the prompt), the library name typed with --yes-external
//   confirms the external archive, and the `restore` op (actor cli) is stepped until it ends, through the SQLite work
//   file and its swap (Task 25);
// - a backup id restores a backup of A itself (no confirmation).
//
// copyOperatorFile (platform): a regular file only, `ensureHeadroom(DATA_DIR, 2 × size)` first.

// A real probe writes 64 MiB; the calls are recorded for the copy's headroom. The module itself is mocked, so the
// platform's own callers (copyOperatorFile) get the stand-in too.
vi.mock('../../../packages/platform/src/headroom.js', () => ({ ensureHeadroom: vi.fn(async () => {}) }));

const PASSPHRASE = 'frasa sandi arsip lain 2026';
const LIBRARY_A = 'Perpustakaan Tujuan';
const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let root: string;
let home: string;
let dataDirA: string;
let dataDirB: string;
/** B's backup, and its archive prepared with PASSPHRASE (a file outside both DATA_DIRs). */
let backupB: string;
let archiveB: string;

async function installAt(dataDir: string, library: string): Promise<void> {
  const input = await writeInput(path.join(root, `input-${path.basename(dataDir)}`), {
    baseUrl: 'https://perpus.example.sch.id',
    db: { dialect: 'sqlite' },
    admin: ADMIN,
    library: { name: library },
  });
  const io = captureIo({ HOME: home }, { hostPanels: () => [] });
  const code = await runCli(['install', '--config', input], bootContext(dataDir), io);
  if (code !== 0) throw new Error(`install failed: ${io.err}`);
}

async function cli(argv: string[], o: { dataDir?: string; env?: Record<string, string>; prompt?: string | null } = {}) {
  const io = captureIo({ HOME: home, ...o.env });
  const promptSecret = vi.fn(async () => (o.prompt === undefined ? null : o.prompt));
  const code = await runCli(argv, bootContext(o.dataDir ?? dataDirA), { ...io, promptSecret });
  return { code, io, promptSecret };
}

/** Runs `fn` with a handle on `dataDir`'s database, closed afterwards (a restore swaps the file: no handle may stay). */
async function withDb<T>(dataDir: string, fn: (h: DbHandle) => Promise<T>): Promise<T> {
  const h = await openInstalled(dataDir);
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

/** The `.altisbak` of B's backup, prepared by Task 21's job for B's admin, copied to a file of its own. */
async function prepareArchive(backupId: string): Promise<string> {
  const config = (await loadConfig(dataDirB, {}))!;
  return withDb(dataDirB, async (h) => {
    const admin = await h.db.selectFrom('staff_users').select('id').executeTakeFirstOrThrow();
    const deps = { dataDir: dataDirB, keyring: config.keyring, sessionKey: csrfKey(config) };
    const reg = createJobRegistry([backupPrepareDownloadJob(() => deps)]);
    const key = await deriveDownloadKey(PASSPHRASE);
    const { jobId } = await withTx(h, (trx) =>
      enqueuePrepareDownload(trx, { backupId, preparedBy: admin.id, superAdmin: true, key, now: Date.now(), keyring: config.keyring }),
    );
    const log = { info() {}, warn() {}, error() {} };
    for (let i = 0; i < 500; i += 1) {
      const job = await claimById(h, reg, jobId, { worker: 'w1', now: Date.now() });
      if (job === null) break;
      const r = await runSlice(h, reg, job, { mode: 'cron_cli', budgetMs: 20_000, keyring: config.keyring, log, clock: () => Date.now(), env: {} });
      if (r.outcome !== 'continued') break;
    }
    const copy = path.join(root, 'arsip-lain.altisbak');
    await fsp.copyFile(preparedDownloadPath(dataDirB, backupId, admin.id, 'archive.altisbak'), copy);
    return copy;
  });
}

const backupRows = (dataDir: string) =>
  withDb(dataDir, (h) => h.db.selectFrom('backups').select(['id', 'kind', 'status', 'sha256']).orderBy('id').execute());
/** The `backup.upload` audit entries (1d T29-CLI-REGISTER-AUDIT: the archives the command registered). */
const uploadEntries = (dataDir: string) =>
  withDb(dataDir, (h) =>
    h.db.selectFrom('audit_log').select(['actor_type', 'actor_id', 'entity', 'entity_id', 'meta']).where('action', '=', 'backup.upload').orderBy('seq').execute(),
  );

beforeAll(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-cli-restore-')));
  home = path.join(root, 'home');
  await fsp.mkdir(home);
  dataDirA = path.join(root, 'data-a');
  dataDirB = path.join(root, 'data-b');
  await installAt(dataDirA, LIBRARY_A);
  await installAt(dataDirB, 'Perpustakaan Sumber');
  // B's own data: a branch A does not have.
  await withDb(dataDirB, async (h) => {
    const now = Date.now();
    await h.db
      .insertInto('branches')
      .values({ id: '01JBRANCHSUMBER00000000000', code_key: 'sumber', code_display: 'SUMBER', name: 'Cabang Sumber', address: null, timezone: 'Asia/Jakarta', is_default: 0, version: 1, created_at: now, updated_at: now })
      .execute();
  });
  const made = await cli(['backup:create', '--json'], { dataDir: dataDirB });
  if (made.code !== 0) throw new Error(`backup:create failed: ${made.io.out}${made.io.err}`);
  backupB = (JSON.parse(made.io.out) as { backupId: string }).backupId;
  archiveB = await prepareArchive(backupB);
}, 120_000);

afterAll(async () => {
  if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(ensureHeadroom).mockClear();
});

describe('copyOperatorFile', () => {
  it('copies a regular file of any size after ensureHeadroom(DATA_DIR, 2 × size); a folder or a missing file is refused', async () => {
    const src = path.join(root, 'operator.bin');
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    await fsp.writeFile(src, bytes);
    const folder = newId();
    const dest = dataPath(dataDirA, 'tmp', folder, 'archive.altisbak');
    expect(await copyOperatorFile(src, dest)).toEqual({ size: bytes.byteLength, sha256: sha256(bytes) });
    expect((await fsp.readFile(dest)).equals(bytes)).toBe(true);
    expect(vi.mocked(ensureHeadroom)).toHaveBeenCalledWith(dataDirA, 2 * bytes.byteLength);
    await expect(copyOperatorFile(root, dataPath(dataDirA, 'tmp', folder, 'upload.bin'))).rejects.toMatchObject({
      code: 'STATE_CORRUPT',
      meta: { reason: 'not_a_file' },
    });
    await expect(copyOperatorFile(path.join(root, 'tidak-ada.altisbak'), dataPath(dataDirA, 'tmp', folder, 'upload.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // Neither refusal left a file.
    expect(await fsp.readdir(path.join(dataDirA, 'tmp', folder))).toEqual(['archive.altisbak']);
    await fsp.rm(path.join(dataDirA, 'tmp', folder), { recursive: true, force: true });
  });
});

describe('backup:restore', () => {
  it('refusals before anything begins: usage, a missing file, no passphrase, a wrong one, no confirmation; the copy is not kept', async () => {
    const before = await backupRows(dataDirA);
    const usage = await cli(['backup:restore']);
    expect([usage.code, usage.io.err]).toEqual([1, expect.stringMatching(/USAGE/)]);
    const missing = await cli(['backup:restore', path.join(root, 'tidak-ada.altisbak'), '--json']);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.io.out)).toMatchObject({ ok: false, command: 'backup:restore', code: 'NOT_FOUND' });

    // No ALTIS_BACKUP_PASSPHRASE and no terminal to ask at.
    const none = await cli(['backup:restore', archiveB, '--yes-external', LIBRARY_A, '--json']);
    expect(none.code).toBe(1);
    expect(JSON.parse(none.io.out)).toMatchObject({ ok: false, code: 'BACKUP_PASSPHRASE_REQUIRED' });
    expect(none.promptSecret).toHaveBeenCalledTimes(1);
    // A wrong one, typed at the prompt.
    const prompted = await cli(['backup:restore', archiveB, '--yes-external', LIBRARY_A], { prompt: 'frasa sandi yang keliru' });
    expect(prompted.code).toBe(1);
    expect(prompted.io.err).toMatch(/BACKUP_PASSPHRASE_INVALID/);
    // A wrong one from the environment: the prompt is not asked.
    const wrong = await cli(['backup:restore', archiveB, '--yes-external', LIBRARY_A, '--json'], { env: { ALTIS_BACKUP_PASSPHRASE: 'frasa sandi yang keliru' } });
    expect(wrong.code).toBe(1);
    expect(JSON.parse(wrong.io.out)).toMatchObject({ ok: false, command: 'backup:restore', code: 'BACKUP_PASSPHRASE_INVALID' });
    expect(wrong.promptSecret).not.toHaveBeenCalled();
    // The right passphrase, but another installation's archive without the library name (or with another one).
    for (const extra of [[], ['--yes-external', 'Perpustakaan Sumber']]) {
      const unconfirmed = await cli(['backup:restore', archiveB, ...extra, '--json'], { env: { ALTIS_BACKUP_PASSPHRASE: PASSPHRASE } });
      expect(unconfirmed.code).toBe(1);
      expect(JSON.parse(unconfirmed.io.out)).toMatchObject({ ok: false, code: 'BACKUP_CONFIRM_REQUIRED' });
    }
    // Nothing was registered, copied, audited or begun.
    expect(await backupRows(dataDirA)).toEqual(before);
    expect(await uploadEntries(dataDirA)).toEqual([]);
    expect((await fsp.readdir(path.join(dataDirA, 'backups')).catch(() => [])).filter((n) => ULID.test(n))).toEqual(before.map((r) => r.id));
    await expect(fsp.stat(path.join(dataDirA, 'ops', 'op.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('<file> --yes-external "<library name>" with ALTIS_BACKUP_PASSPHRASE → exit 0, state lines, the data of B restored on A', async () => {
    const before = new Set((await backupRows(dataDirA)).map((r) => r.id));
    const installA = (await loadConfig(dataDirA, {}))!.install.id;
    const { code, io } = await cli(['backup:restore', archiveB, '--yes-external', ` ${LIBRARY_A} `], { env: { ALTIS_BACKUP_PASSPHRASE: PASSPHRASE } });
    expect(io.err).toBe('');
    expect(code).toBe(0);
    const lines = io.out.trim().split('\n');
    expect(lines[0]).toMatch(/^backup:restore: [0-9A-HJKMNP-TV-Z]{26} verifying \d+%$/);
    // One line per step whose state or progress moved (a small restore runs several states in one step).
    for (const l of lines.slice(0, -1)) expect(l).toMatch(/^backup:restore: [0-9A-HJKMNP-TV-Z]{26} [a-z_]+ \d+%$/);
    expect(lines.at(-2)).toMatch(/ done 100%$/);
    expect(lines.at(-1)).toMatch(/^backup:restore: [0-9A-HJKMNP-TV-Z]{26} dipulihkan \/ restored \(op [0-9A-HJKMNP-TV-Z]{26}\)$/);

    // The copy was registered as an external, uploaded backup with the archive's SHA-256: the row of the upload
    // route's insertExternalBackupRow (the clear header's versions, dialect and consistency, the file's size).
    const added = (await backupRows(dataDirA)).filter((r) => !before.has(r.id) && r.kind === 'external');
    expect(added).toEqual([{ id: expect.stringMatching(ULID), kind: 'external', status: 'uploaded', sha256: sha256(await fsp.readFile(archiveB)) }]);
    const size = (await fsp.stat(archiveB)).size;
    const row = await withDb(dataDirA, (h) => h.db.selectFrom('backups').selectAll().where('id', '=', added[0]!.id).executeTakeFirstOrThrow());
    const source = (await readManifest(dataDirB, backupB))!;
    expect(row).toMatchObject({ size, schema_version: source.schemaVersion, app_version: source.appVersion, dialect: 'sqlite', consistency: source.consistency });
    // ... and audited once, as the route audits an upload, by the CLI actor (T29-CLI-REGISTER-AUDIT); the restore
    // keeps A's audit log.
    const uploads = await uploadEntries(dataDirA);
    expect(uploads).toEqual([{ actor_type: 'cli', actor_id: null, entity: 'backups', entity_id: added[0]!.id, meta: expect.any(String) }]);
    expect(JSON.parse(uploads[0]!.meta)).toEqual({
      backupId: added[0]!.id,
      size,
      dialect: 'sqlite',
      schemaVersion: source.schemaVersion,
      appVersion: source.appVersion,
    });
    expect((await fsp.readFile(path.join(dataDirA, 'backups', added[0]!.id, 'archive.altisbak'))).equals(await fsp.readFile(archiveB))).toBe(true);

    const manifest = (await readManifest(dataDirB, backupB))!;
    // B never ran a server, so its backup holds no schedules; the restore seeds the code's definitions (Task 22), and
    // its notification of the restore is new.
    const skip = ['notifications', 'schedules'];
    await withDb(dataDirA, async (h) => {
      expect(await loadedChecksums(h, manifest, skip)).toEqual(manifestChecksums(manifest, skip));
      expect(manifest.tables['schedules']!.rows).toBe(0);
      expect((await h.db.selectFrom('schedules').select('name').execute()).length).toBeGreaterThan(0);
      expect(await h.db.selectFrom('branches').select('code_display').where('code_key', '=', 'sumber').execute()).toEqual([{ code_display: 'SUMBER' }]);
      // A keeps its own installation id; the audit entry names the archive and the actor cli.
      expect(await h.db.selectFrom('schema_meta').select('install_id').execute()).toEqual([{ install_id: installA }]);
      const audit = await h.db.selectFrom('audit_log').select(['actor_type', 'entity_id', 'meta']).where('action', '=', 'backup.restore').execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_type: 'cli', entity_id: added[0]!.id });
      expect(JSON.parse(audit[0]!.meta)).toMatchObject({ archiveSha256: added[0]!.sha256, secretsBranch: 'b', outcome: 'done' });
    });
    // The op ended; maintenance is off.
    expect(JSON.parse(await fsp.readFile(path.join(dataDirA, 'ops', 'op.json'), 'utf8'))).toMatchObject({ kind: 'restore', state: 'done', actor: { type: 'cli' } });
    await expect(fsp.stat(path.join(dataDirA, 'ops', 'maintenance.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('<backupId> of this installation (backup:create) --without-files --json → exit 0, one final line; no confirmation', async () => {
    const made = await cli(['backup:create', '--json']);
    expect(made.code).toBe(0);
    const { backupId } = JSON.parse(made.io.out) as { backupId: string };
    const { code, io } = await cli(['backup:restore', backupId, '--without-files', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(io.out)).toEqual({ ok: true, command: 'backup:restore', backupId, opId: expect.stringMatching(ULID), state: 'done' });
    const manifest = (await readManifest(dataDirA, backupId))!;
    await withDb(dataDirA, async (h) => {
      expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
      const audit = await h.db.selectFrom('audit_log').select(['entity_id', 'meta']).where('action', '=', 'backup.restore').orderBy('seq', 'desc').executeTakeFirstOrThrow();
      expect(audit.entity_id).toBe(backupId);
      expect(JSON.parse(audit.meta)).toMatchObject({ secretsBranch: 'a', outcome: 'done' });
    });
  }, 60_000);
});
