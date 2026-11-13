import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeBase64Url } from '@altis/crypto';
import { PHASE1_MIGRATIONS, dropRegisteredTables, runMigrations } from '@altis/db';
import { dataPath, uploadPath } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { readAltisbakHeader } from '../../src/archive/altisbak.js';
import { deriveKek } from '../../src/archive/kdf.js';
import { base32Decode, hotp, matchTotp, totpStep } from '../../src/auth/totp.js';
import { openValue, secretAad, type KeyringEntry } from '../../src/crypto/secret-box.js';
import { readRestoreReport } from '../../src/restore/prepass.js';
import { readSecret } from '../../src/settings/service.js';
import {
  KEYRING,
  beginRestore,
  currentOp,
  loadedChecksums,
  manifestChecksums,
  preparedArchive,
  restoreHarness,
  restoreParams,
  seedInstallation,
  serverBackup,
  sha256,
  stepKilledAfterCommit,
  stepUntil,
  uploadedArchive,
  type RestoreHarness,
  type Seeded,
} from '../fixtures/restore-support.js';

// The secrets and files of a restore (spec §9.10 "rahasia" and "berkas", A6; decisions C13, C14, C18; plan Task 22) on
// the engine picked by ALTIS_TEST_DB:
//
//   a  a server backup of this installation: TOTP codes of the restored users verify, smtp.password reads back;
//   b  a passphrase `.altisbak` made by Task 21's job (B3), restored into a second installation (its own DATA_DIR,
//      keyring and session key; the same test database emptied and set up again): TOTP and the SMTP password work with
//      the second installation's keyring;
//   c  an unencrypted `.altisbak` of another installation: every secret NULL, `totp_reenroll = 1` for the users who had
//      TOTP, the checklist names them and smtp.password, the audit entry says `secretsBranch: 'c'`.
//
// Files: blobs restored with their SHA-256, an upload without a blob `missing` and in the report; `withoutFiles` makes
// every file `missing`. SQLite targets restore in place here (the test build's stand-in until Task 25).

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const PASSPHRASE = 'kuda lumping 2026 ✓';
const INSTALL_A = newId();
const INSTALL_B = newId();
const KEYRING_B: KeyringEntry[] = [{ kid: 'kb', key: Buffer.alloc(32, 9).toString('base64url'), active: true }];
const SESSION_KEY_B = new Uint8Array(32).fill(77);

/** Whether the TOTP of `userId` (sealed in `h`) opens with `keyring` and its code of now matches `plain`. */
async function totpWorks(h: TestDbHandle, keyring: readonly KeyringEntry[], userId: string, plain: string): Promise<boolean> {
  const row = await h.db.selectFrom('staff_users').select(['totp_secret_enc', 'totp_last_step']).where('id', '=', userId).executeTakeFirstOrThrow();
  if (row.totp_secret_enc === null) return false;
  const text = openValue(keyring, secretAad('staff_users', 'totp_secret_enc', userId), row.totp_secret_enc);
  if (text !== plain) return false;
  const secret = base32Decode(text);
  const now = Date.now();
  return matchTotp(secret, hotp(secret, totpStep(now), 6), now, Number(row.totp_last_step)) !== null;
}

describe.skipIf(!ctx.available)(`restore secrets and files [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let harness: RestoreHarness | undefined;
  let seeded: Seeded;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-restore-secrets-')));
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  /** A fresh installation in a new DATA_DIR on the (emptied) test database. */
  async function install(o: { installId: string; keyring: KeyringEntry[] }): Promise<{ dataDir: string; seeded: Seeded }> {
    const dir = await fsp.mkdtemp(path.join(root, 'data-'));
    await dropRegisteredTables(h.db, h.dialect);
    await runMigrations(h, { appVersion: '0.1.0', dataDir: dir, migrations: PHASE1_MIGRATIONS });
    return { dataDir: dir, seeded: await seedInstallation(h, { dataDir: dir, installId: o.installId, keyring: o.keyring }) };
  }

  beforeEach(async () => {
    ({ dataDir, seeded } = await install({ installId: INSTALL_A, keyring: KEYRING }));
    harness = undefined;
  });

  afterEach(async () => {
    await harness?.close();
  });

  /** The `.altisbak` of a backup of installation A, prepared by Task 21's job (`encrypted` with PASSPHRASE or not). */
  function archiveOf(backupId: string, encrypted: boolean): Promise<string> {
    return preparedArchive(h, { dataDir, backupId, preparedBy: seeded.users[0]!.id, passphrase: encrypted ? PASSPHRASE : null, into: root });
  }

  /** Installation B with `archive` uploaded as backup `<id>` (kind external, status uploaded). */
  async function installB(archive: string): Promise<{ backupId: string; seededB: Seeded }> {
    const b = await install({ installId: INSTALL_B, keyring: KEYRING_B });
    dataDir = b.dataDir;
    return { backupId: await uploadedArchive(h, dataDir, archive), seededB: b.seeded };
  }

  it('branch a: a backup of this installation; TOTP verifies and smtp.password reads back', async () => {
    const { backupId, manifest } = await serverBackup(h, { dataDir, installId: INSTALL_A });
    harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_A });
    await beginRestore(harness, restoreParams(backupId));
    expect(await stepUntil(harness, dataDir)).toMatchObject({ state: 'done' });
    for (const u of seeded.users.filter((x) => x.totp !== null)) expect(await totpWorks(h, KEYRING, u.id, u.totp!)).toBe(true);
    expect(await readSecret(h.db, 'smtp.password', KEYRING)).toBe(seeded.smtpPassword);
    expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
    const audit = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').executeTakeFirstOrThrow();
    expect(JSON.parse(audit.meta)).toMatchObject({ secretsBranch: 'a', outcome: 'done' });
  });

  it('branch b: a passphrase archive into a second installation; TOTP and the SMTP password work with its keyring', async () => {
    const { backupId: sourceId, manifest } = await serverBackup(h, { dataDir, installId: INSTALL_A, includeFiles: true });
    const archive = await archiveOf(sourceId, true);
    const users = seeded.users;
    const { backupId } = await installB(archive);
    harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_B, keyring: KEYRING_B, sessionKey: SESSION_KEY_B });
    const header = await readAltisbakHeader(dataPath(dataDir, 'backups', backupId, 'archive.altisbak'));
    const kek = await deriveKek(PASSPHRASE, decodeBase64Url(header.encryption!.kdf.salt)!);
    const opId = await beginRestore(harness, restoreParams(backupId, { source: 'archive', confirmed: true }), { secret: kek });
    expect(await stepUntil(harness, dataDir)).toMatchObject({ state: 'done' });
    for (const u of users.filter((x) => x.totp !== null)) expect(await totpWorks(h, KEYRING_B, u.id, u.totp!)).toBe(true);
    expect(await readSecret(h.db, 'smtp.password', KEYRING_B)).toBe(seeded.smtpPassword);
    expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
    // The second installation keeps its own install id; the extracted archive is gone.
    expect(await h.db.selectFrom('schema_meta').select('install_id').execute()).toEqual([{ install_id: INSTALL_B }]);
    await expect(fsp.stat(path.join(dataDir, 'tmp', opId))).rejects.toMatchObject({ code: 'ENOENT' });
    // The files came back from the archive's blobs into the second installation's uploads.
    for (const f of seeded.files) expect(sha256(await fsp.readFile(uploadPath(dataDir, f.id)))).toBe(sha256(f.content));
    const audit = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').executeTakeFirstOrThrow();
    expect(JSON.parse(audit.meta)).toMatchObject({ secretsBranch: 'b', sourceInstallId: INSTALL_A });
  });

  it('branch c: an unencrypted archive of another installation; secrets NULL, totp_reenroll, the checklist, audited', async () => {
    const { backupId: sourceId } = await serverBackup(h, { dataDir, installId: INSTALL_A });
    const archive = await archiveOf(sourceId, false);
    const users = seeded.users;
    const { backupId } = await installB(archive);
    harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_B, keyring: KEYRING_B, sessionKey: SESSION_KEY_B });
    // An external archive without blobs while it holds files rows: refused before PONR unless asked to go without files.
    const refused = await beginRestore(harness, restoreParams(backupId, { source: 'archive', confirmed: true }));
    expect(await stepUntil(harness, dataDir)).toMatchObject({ state: 'failed', error: { code: 'RESTORE_CONFLICTS' } });
    expect((await readRestoreReport(dataDir, refused))?.conflicts).toEqual([{ table: 'files', kind: 'files_missing', columns: [], pk: null }]);
    const opId = await beginRestore(harness, restoreParams(backupId, { source: 'archive', confirmed: true, withoutFiles: true }));
    expect(await stepUntil(harness, dataDir)).toMatchObject({ state: 'done' });
    const rows = await h.db.selectFrom('staff_users').select(['id', 'totp_secret_enc', 'totp_reenroll']).execute();
    expect(rows.every((r) => r.totp_secret_enc === null)).toBe(true);
    const reenroll = rows.filter((r) => Number(r.totp_reenroll) === 1).map((r) => r.id).sort();
    expect(reenroll).toEqual(users.filter((u) => u.totp !== null).map((u) => u.id).sort());
    expect(await readSecret(h.db, 'smtp.password', KEYRING_B)).toBeNull();
    const report = await readRestoreReport(dataDir, opId);
    expect(report).toMatchObject({ ok: true, checklist: { secrets: ['smtp.password'], reenroll: ['staf_0', 'staf_1'] } });
    // Both attempts are in the kept audit log: the refused one (outcome failed) and this one.
    const audit = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').orderBy('seq').execute();
    expect(audit.map((a) => JSON.parse(a.meta) as Record<string, unknown>)).toMatchObject([
      { opId: refused, outcome: 'failed', error: 'RESTORE_CONFLICTS' },
      { opId, secretsBranch: 'c', outcome: 'done', sourceInstallId: INSTALL_A },
    ]);
  });

  it('branch c, every loading and files step killed once after its commits: the report still names every secret, user and file', async () => {
    // A backup whose HMAC this installation cannot verify (another session key): branch c, confirmed; it carries no
    // blobs, so the restore goes without files and every upload ends `missing`. One row per part: a killed step's
    // part is never the first of its table (which the next step would empty and load again).
    vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', '1');
    const { backupId } = await serverBackup(h, { dataDir, installId: INSTALL_B, sessionKey: new Uint8Array(32).fill(5) });
    vi.unstubAllEnvs();
    harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_A });
    const opId = await beginRestore(harness, restoreParams(backupId, { confirmed: true, withoutFiles: true }));
    let killed = 0;
    for (let i = 0; i < 5000; i += 1) {
      const op = await currentOp(dataDir);
      const final = op.params['final'] as { step?: string } | undefined;
      // The rows (or `files` statuses) a killed step committed are skipped when the op resumes from op.json.
      if (op.state === 'loading' || (op.state === 'finalizing' && final?.step === 'files')) {
        await stepKilledAfterCommit(harness, dataDir);
        killed += 1;
      }
      const status = await harness.ops.step(1);
      if (status === null || status.terminal || status.needsAttention) break;
    }
    expect(killed).toBeGreaterThan(2);
    expect(await currentOp(dataDir)).toMatchObject({ opId, state: 'done' });
    expect(await readRestoreReport(dataDir, opId)).toMatchObject({
      ok: true,
      checklist: { secrets: ['smtp.password'], reenroll: ['staf_0', 'staf_1'] },
      files: { missing: seeded.files.map((f) => f.id).sort() },
    });
  }, 120_000);

  it('files: blobs restored with their SHA-256; an upload without a blob is missing and listed; withoutFiles → all missing', async () => {
    // A third file whose upload is gone before the backup: the backup holds no blob of it.
    const lost = { id: newId(), content: Buffer.from('tidak pernah ada\n') };
    await h.db
      .insertInto('files')
      .values({ id: lost.id, original_name: 'hilang.txt', mime: 'text/plain', size: lost.content.byteLength, sha256: sha256(lost.content), context: 'test', access: 'staff', status: 'ok', created_at: Date.now() })
      .execute();
    const { backupId } = await serverBackup(h, { dataDir, installId: INSTALL_A, includeFiles: true });
    // The target lost its uploads since.
    for (const f of seeded.files) await fsp.rm(uploadPath(dataDir, f.id));
    harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_A });
    const opId = await beginRestore(harness, restoreParams(backupId));
    expect(await stepUntil(harness, dataDir)).toMatchObject({ state: 'done' });
    for (const f of seeded.files) expect(sha256(await fsp.readFile(uploadPath(dataDir, f.id)))).toBe(sha256(f.content));
    const status = Object.fromEntries((await h.db.selectFrom('files').select(['id', 'status']).execute()).map((r) => [r.id, r.status]));
    expect(status).toEqual({ [seeded.files[0]!.id]: 'ok', [seeded.files[1]!.id]: 'ok', [lost.id]: 'missing' });
    expect(await readRestoreReport(dataDir, opId)).toMatchObject({ ok: true, files: { missing: [lost.id] } });

    await harness.close();
    harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_A });
    const again = await beginRestore(harness, restoreParams(backupId, { withoutFiles: true }));
    expect(await stepUntil(harness, dataDir)).toMatchObject({ opId: again, state: 'done' });
    const statuses = (await h.db.selectFrom('files').select('status').execute()).map((r) => r.status);
    expect(statuses).toEqual(['missing', 'missing', 'missing']);
  }, 120_000);
});
