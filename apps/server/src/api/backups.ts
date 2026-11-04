import type { FileHandle } from 'node:fs/promises';
import { decodeBase64Url } from '@altis/crypto';
import {
  deriveDownloadKey,
  deriveKek,
  enqueuePrepareDownload,
  listBackups,
  markDownloadCompleted,
  moveUploadedArchive,
  openAltisbak,
  preparedDownloadPath,
  readManifest,
  readPreparedDownload,
  readSettings,
  readUploadedHeader,
  registerUploadedBackup,
  startBackup,
  uploadOwner,
  uploadedArchivePath,
  uploadedArchiveSource,
  verifyManifestHmac,
  type BackupItem as CoreBackupItem,
  type DownloadKey,
  type RestoreParams,
} from '@altis/core';
import type { DbHandle } from '@altis/db';
import { openRead } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import {
  BackupCreateBody,
  BackupPrepareBody,
  BackupUploadBody,
  RestoreBody,
  type BackupCreateResponse,
  type BackupItem,
  type BackupListResponse,
  type BackupPrepareResponse,
  type BackupRestoreResponse,
  type BackupUploadResponse,
} from '@altis/shared/api/backups';
import { z } from 'zod';
import { csrfKey } from '../http/csrf.js';
import { issueOpsCookie } from '../http/ops-auth.js';
import { problemResponse } from '../http/problem.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';

// The backup routes of Task 20 (spec §9.9, §13.5 "Backup"; route catalog `backups.list`, `backups.create`; decisions
// C31, C41; preflight B5). Task 21 adds prepare-download, download and upload in its own block below, Task 29 the
// restore in the last block.
//
//   GET  backups   `system.backup.read`: every backup (rows joined with their manifests), newest first, and the next
//                  run of `backup.daily`
//   POST backups   `system.backup.create`, `mode: system` (a backup must work in read-only, §8.6), `tx: 'self'` (it
//                  talks to the ops machine and its files, R37/D3): the mode is chosen (snapshot while a worker or
//                  `jobs:run` ran within 10 minutes, unless passenger/litespeed and the estimate is over 10 minutes);
//                  `snapshot` → the `backup.create` job (`uniqueKey 'backup:manual'`: a second click joins the first
//                  job), `frozen` → the `backup` op and its `altis_ops` cookie (the page follows it on
//                  `/admin/_update`); audit `backup.create {consistency, includeFiles}`, once per create.

const BACKUPS = '/api/v1/backups';
const NO_STORE = { 'Cache-Control': 'no-store' };

// Core's BackupItem is what the shared view describes (a compile-time check that the two stay one shape).
const _itemIsView: (i: CoreBackupItem) => BackupItem = (i) => i;
void _itemIsView;

const list = route({
  id: 'backups.list',
  method: 'GET',
  path: BACKUPS,
  permission: 'system.backup.read',
  idempotency: 'none',
  audit: null,
  async handler(rc) {
    const db = rc.db.db;
    const items = await listBackups(db, rc.services.dataDir, csrfKey(rc.config));
    const daily = await db.selectFrom('schedules').select(['enabled', 'next_run_at']).where('name', '=', 'backup.daily').executeTakeFirst();
    const body: BackupListResponse = {
      items,
      nextScheduledAt: daily !== undefined && Number(daily.enabled) === 1 ? Number(daily.next_run_at) : null,
    };
    return { body, headers: NO_STORE };
  },
});

const create = route<BackupCreateBody>({
  id: 'backups.create',
  method: 'POST',
  path: BACKUPS,
  permission: 'system.backup.create',
  mode: 'system',
  idempotency: 'none',
  audit: 'backup.create',
  tx: 'self',
  body: BackupCreateBody,
  async handler(rc) {
    const auth = rc.auth;
    // Unreachable: a permission route runs with a session.
    if (auth === null) throw new DomainError('AUTH_REQUIRED');
    const includeFiles = rc.body.includeFiles ?? false;
    const started = await startBackup({
      h: rc.db,
      dataDir: rc.services.dataDir,
      runtime: rc.services.runtime,
      ops: rc.services.ops,
      now: rc.now,
      kind: 'manual',
      includeFiles,
      actor: { type: 'staff', id: auth.subjectId },
      createdBy: auth.subjectId,
      uniqueKey: 'backup:manual',
    });
    let body: BackupCreateResponse;
    if ('skipped' in started) throw new TypeError('backups.create: a manual backup is never skipped');
    if (started.consistency === 'frozen') {
      issueOpsCookie(rc.c, { opId: started.opId, opsToken: started.opsToken });
      body = { consistency: 'frozen', opId: started.opId };
    } else {
      rc.services.jobs?.kick();
      body = { consistency: 'snapshot', jobId: started.jobId };
    }
    const entityId = body.consistency === 'frozen' ? body.opId : body.jobId;
    await rc.audit({ entity: body.consistency === 'frozen' ? 'op' : 'job', entityId, meta: { consistency: body.consistency, includeFiles } });
    return { status: 202, body, headers: NO_STORE };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// 1c Task 21: prepare a download, download it, upload an archive (spec §9.9 "Download", §9.10; route catalog
// `backups.prepare_download|download|upload`; decisions C14, C15; preflight M4, M18, S15, S18).
//
//   POST backups/:id/prepare-download   `system.backup.download`, reauth, `mode: system`: `prepare` derives the KEK
//                                       from the passphrase (scrypt, outside the transaction, S18); the handler
//                                       queues `backup.prepare_download` for the subject (one live job per backup and
//                                       subject: an unencrypted request with the same secrets joins it, any other one
//                                       is 409 BACKUP_PREPARE_IN_PROGRESS) → 202 {jobId}; audit `backup.download
//                                       {backupId, encrypted, secrets}`
//   GET  backups/:id/download           `system.backup.download`, `mode: system`, a side-effect GET (HEAD 404, no
//                                       cross-site request: the last byte served starts the archive's removal): the
//                                       subject's own prepared archive, its path built from the subject (C15), never
//                                       anyone else's, and one with secrets only while the subject is a super admin
//                                       (C14); one `Range: bytes=a-b` (or `a-`, `-n`) → 206, past the end → 416
//                                       RANGE_NOT_SATISFIABLE (M4); several ranges or a malformed one are ignored
//                                       (RFC 9110 §14.2); `ETag "<jobId>-<size>"` (no whole-archive hash, M18). Once a
//                                       response holding the last byte was read to its end, `completedAt` is set
//   POST backups/upload                 `system.backup.restore`, reauth, `mode: system`, `tx: 'self'`: the clear header
//                                       of the subject's completed upload is read first (outside any transaction), the
//                                       transaction takes the upload and adds the `external` backup, the file moves
//                                       after COMMIT (S15) → BackupItem; audit `backup.upload`

const BackupIdParams = z.strictObject({ id: ulidField });
/** A download is read in pieces of this size. */
const DOWNLOAD_CHUNK_BYTES = 256 * 1024;

/** The request's staff user; a permission route runs with a session, so there is one. */
function subjectOf(rc: RouteContext<unknown, unknown, unknown>): { id: string; superAdmin: boolean } {
  if (rc.auth === null) throw new DomainError('AUTH_REQUIRED');
  return { id: rc.auth.subjectId, superAdmin: rc.auth.grants.superAdmin };
}

function notReady(): DomainError {
  return new DomainError('BACKUP_NOT_READY', {
    detail: 'Belum ada arsip unduhan yang siap untuk Anda / No download archive is ready for you',
  });
}

const prepareDownload = route<BackupPrepareBody, unknown, z.infer<typeof BackupIdParams>>({
  id: 'backups.prepare_download',
  method: 'POST',
  path: `${BACKUPS}/:id/prepare-download`,
  permission: 'system.backup.download',
  reauth: true,
  mode: 'system',
  idempotency: 'none',
  audit: 'backup.download',
  params: BackupIdParams,
  body: BackupPrepareBody,
  // S18: scrypt never runs inside the transaction.
  prepare: async (rc) => (rc.body.passphrase === undefined ? null : deriveDownloadKey(rc.body.passphrase)),
  async handler(rc) {
    const subject = subjectOf(rc);
    const backupId = rc.params.id;
    const queued = await enqueuePrepareDownload(rc.tx().trx, {
      backupId,
      preparedBy: subject.id,
      superAdmin: subject.superAdmin,
      key: rc.prepared as DownloadKey | null,
      now: rc.now,
      keyring: rc.config.keyring,
    });
    await rc.audit({ entity: 'backups', entityId: backupId, meta: { backupId, encrypted: queued.encrypted, secrets: queued.secrets } });
    rc.afterCommit(() => rc.services.jobs?.kick());
    const body: BackupPrepareResponse = { jobId: queued.jobId };
    return { status: 202, body, headers: NO_STORE };
  },
});

/**
 * The one byte range `header` asks for in an archive of `size` bytes: [first, last], null for the whole archive (no
 * `Range`, an `If-Range` other than `etag`, several ranges, another unit, a malformed range: ignored, RFC 9110 §14.2),
 * or 'unsatisfiable' (a first byte past the end, an empty suffix).
 */
export function byteRange(header: string | undefined, ifRange: string | undefined, etag: string, size: number): [number, number] | null | 'unsatisfiable' {
  if (header === undefined) return null;
  if (ifRange !== undefined && ifRange.trim() !== etag) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (m === null || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    return suffix > 0 ? [Math.max(0, size - suffix), size - 1] : 'unsatisfiable';
  }
  const first = Number(m[1]);
  if (!Number.isSafeInteger(first) || first >= size) return 'unsatisfiable';
  if (m[2] === '') return [first, size - 1];
  const last = Number(m[2]);
  return last < first ? null : [first, Math.min(last, size - 1)];
}

/**
 * Bytes `first` to `last` of `handle`, read only as the client takes them (highWaterMark 0); the handle is closed at
 * the end or when the client goes. `ended` runs once the client took the last of them, before the stream closes.
 */
function rangeStream(handle: FileHandle, first: number, last: number, ended: () => Promise<void>): ReadableStream<Uint8Array> {
  let position = first;
  let open = true;
  const close = async (): Promise<void> => {
    if (!open) return;
    open = false;
    await handle.close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const left = last + 1 - position;
          if (left <= 0) {
            await close();
            await ended();
            controller.close();
            return;
          }
          const buffer = new Uint8Array(Math.min(DOWNLOAD_CHUNK_BYTES, left));
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
          if (bytesRead === 0) throw new Error('the prepared archive is shorter than its size');
          position += bytesRead;
          controller.enqueue(buffer.subarray(0, bytesRead));
        } catch (error) {
          await close();
          controller.error(error);
        }
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
}

const download = route<unknown, unknown, z.infer<typeof BackupIdParams>>({
  id: 'backups.download',
  method: 'GET',
  path: `${BACKUPS}/:id/download`,
  permission: 'system.backup.download',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  sideEffects: true,
  params: BackupIdParams,
  async handler(rc) {
    const subject = subjectOf(rc);
    const backupId = rc.params.id;
    const dataDir = rc.services.dataDir;
    const prepared = await readPreparedDownload(dataDir, backupId, subject.id);
    if (prepared === null) throw notReady();
    // Decision C14 at the moment of the download: an archive that carries the secrets (re-sealed with the archive key,
    // or still sealed with the keyring) goes to a super admin only, so a preparer demoted since gets none of them.
    if (prepared.secrets !== 'omitted' && !subject.superAdmin) {
      throw new DomainError('BACKUP_NOT_READY', {
        detail:
          'Arsip ini memuat rahasia yang hanya boleh diunduh super admin; siapkan unduhannya lagi / ' +
          'This archive holds secrets only a super admin may download; prepare the download again',
      });
    }
    let handle: FileHandle;
    try {
      handle = await openRead(preparedDownloadPath(dataDir, backupId, subject.id, 'archive.altisbak'));
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notReady();
      throw error;
    }
    let size: number;
    try {
      size = (await handle.stat()).size;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    if (size !== prepared.size || size === 0) {
      await handle.close().catch(() => undefined);
      throw notReady();
    }
    const etag = `"${prepared.jobId}-${size}"`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="altis-${backupId}.altisbak"`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ETag: etag,
    };
    const range = byteRange(rc.c.req.header('range'), rc.c.req.header('if-range'), etag, size);
    if (range === 'unsatisfiable') {
      await handle.close().catch(() => undefined);
      const refused = problemResponse(
        new DomainError('RANGE_NOT_SATISFIABLE', {
          detail: `Rentang di luar arsip ${size} byte / The range lies outside the ${size}-byte archive`,
        }),
        rc.requestId,
      );
      refused.headers.set('Content-Range', `bytes */${size}`);
      refused.headers.set('Cache-Control', 'no-store');
      return refused;
    }
    const [first, last] = range ?? [0, size - 1];
    const ended = async (): Promise<void> => {
      if (last !== size - 1) return;
      try {
        await markDownloadCompleted(dataDir, backupId, subject.id, { jobId: prepared.jobId, at: rc.services.clock() });
      } catch (error) {
        rc.log.warn('backups: recording a completed download failed', { backupId, code: (error as { code?: unknown } | null)?.code });
      }
    };
    headers['Content-Length'] = String(last - first + 1);
    if (range !== null) headers['Content-Range'] = `bytes ${first}-${last}/${size}`;
    return new Response(rangeStream(handle, first, last, ended), { status: range === null ? 200 : 206, headers });
  },
});

const upload = route<BackupUploadBody>({
  id: 'backups.upload',
  method: 'POST',
  path: `${BACKUPS}/upload`,
  permission: 'system.backup.restore',
  reauth: true,
  mode: 'system',
  idempotency: 'none',
  audit: 'backup.upload',
  tx: 'self',
  body: BackupUploadBody,
  async handler(rc) {
    const subject = subjectOf(rc);
    const dataDir = rc.services.dataDir;
    const owner = uploadOwner(subject.id);
    const { uploadId } = rc.body;
    // S15: the clear header first, outside any transaction (no passphrase needed).
    const header = await readUploadedHeader(await uploadedArchiveSource(rc.db.db, dataDir, { uploadId, owner }));
    const item = await rc.withTx(async (tx) => {
      // A request the uploader repeats after its COMMIT (P7): their entry of then stands for this one. Anyone else's
      // request for that backup is NOT_FOUND (registerUploadedBackup).
      const repeated = await rc.auditedBefore({ entity: 'backups', entityId: uploadId });
      const registered = await registerUploadedBackup(tx, { uploadId, owner, dataDir, now: rc.now, header });
      if (!repeated) {
        await rc.audit({
          entity: 'backups',
          entityId: registered.id,
          meta: {
            backupId: registered.id,
            size: registered.size,
            dialect: registered.dialect,
            schemaVersion: registered.schemaVersion,
            appVersion: registered.appVersion,
          },
        });
      }
      // R37, D3: the file moves after COMMIT, never inside a transaction that may run again.
      rc.afterCommit(() => moveUploadedArchive(dataDir, uploadId));
      return registered;
    });
    // A hook's failure is only logged: a move it could not make is made here, or its error answers the request (the
    // client sends it again, and the repeated request finds the row and finishes the move).
    await moveUploadedArchive(dataDir, uploadId);
    const body: BackupUploadResponse = item;
    return { body, headers: NO_STORE };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// 1c Task 29: restore a backup (spec §9.10, §7.3 "konfirmasi tegas"; route catalog `backups.restore`; preflight S6,
// S18; decision C25). The CLI's `backup:restore` begins its op through the same two checks (cli/backup.ts).
//
//   POST backups/:id/restore   `system.backup.restore`, reauth, `mode: system`, `tx: 'self'` (the ops machine and its
//                              files, R37/D3): `prepare` (no transaction, S18) finds the backup (`ok`: a server backup,
//                              `uploaded`: an archive), derives an encrypted archive's KEK (scrypt) and opens its
//                              header, DEK and manifest; a manifest without this installation's HMAC needs
//                              `confirmLibraryName`; then `ops.begin('restore', …, {secret: kek})` and the `altis_ops`
//                              cookie → 202 {opId}. No audit entry here: the op writes `backup.restore` (C25)

/** What a restore of a backup begins with: where its data is read from, the KEK of an encrypted archive, its HMAC. */
export interface RestoreStart {
  source: RestoreParams['source'];
  /** scrypt of the passphrase with the archive's salt (32 bytes); null for a backup that is not encrypted. */
  kek: Uint8Array | null;
  /** The manifest carries this installation's HMAC (its own backup): no confirmation is needed. */
  hmacValid: boolean;
}

/** A gunzip bound that never binds: the route reads only the manifest, whose own bound applies. */
const MANIFEST_ONLY_HEADROOM = Number.MAX_SAFE_INTEGER;

function passphraseRequired(): DomainError {
  return new DomainError('BACKUP_PASSPHRASE_REQUIRED', {
    detail: 'Arsip ini terenkripsi; masukkan frasa sandinya / This archive is encrypted; enter its passphrase',
  });
}

/**
 * The checks a restore of backup `backupId` passes before its op begins (spec §9.10 steps 1–2, S18): the backup is
 * `ok` (a server backup, `backups/<id>/manifest.json`) or `uploaded` (an archive, `backups/<id>/archive.altisbak`); an
 * encrypted archive opens with the KEK derived from `passphrase()` (asked only then); the manifest's HMAC is checked
 * with `sessionKey`. Slow (scrypt): call it outside any transaction.
 *
 * @throws DomainError NOT_FOUND (no such backup, or its files are gone), BACKUP_NOT_READY (another status),
 *   BACKUP_PASSPHRASE_REQUIRED, BACKUP_PASSPHRASE_INVALID (a wrong passphrase, or one too short to be any archive's),
 *   BACKUP_INVALID
 */
export async function prepareRestore(o: {
  db: DbHandle['db'];
  dataDir: string;
  sessionKey: Uint8Array;
  backupId: string;
  passphrase(): Promise<string | undefined>;
}): Promise<RestoreStart> {
  const row = await o.db.selectFrom('backups').select(['status']).where('id', '=', o.backupId).executeTakeFirst();
  if (row === undefined) throw new DomainError('NOT_FOUND', { detail: `Backup ${o.backupId} tidak ada / Backup ${o.backupId} does not exist` });
  if (row.status === 'ok') {
    const manifest = await readManifest(o.dataDir, o.backupId);
    if (manifest === null) {
      throw new DomainError('NOT_FOUND', { detail: `Berkas backup ${o.backupId} tidak ada / The files of backup ${o.backupId} are gone` });
    }
    return { source: 'server', kek: null, hmacValid: verifyManifestHmac(o.sessionKey, manifest) };
  }
  if (row.status !== 'uploaded') {
    throw new DomainError('BACKUP_NOT_READY', {
      detail: `Backup ini tidak dapat dipulihkan (status ${row.status}) / This backup cannot be restored (status ${row.status})`,
    });
  }
  const file = uploadedArchivePath(o.dataDir, o.backupId);
  const header = await readUploadedHeader(file);
  let kek: Uint8Array | null = null;
  if (header.encryption !== null) {
    const passphrase = await o.passphrase();
    if (passphrase === undefined || passphrase === '') throw passphraseRequired();
    try {
      kek = await deriveKek(passphrase, decodeBase64Url(header.encryption.kdf.salt)!);
    } catch (error) {
      // Shorter than the KDF's minimum: no archive was ever encrypted with it (prepare-download refuses it), so it is
      // a wrong passphrase, as the restore dialog says, not a validation error of the request.
      if (!isDomainError(error) || error.code !== 'VALIDATION_FAILED') throw error;
      throw new DomainError('BACKUP_PASSPHRASE_INVALID', {
        detail: 'Frasa sandi tidak membuka arsip ini / The passphrase does not open this archive',
        cause: error,
      });
    }
  }
  // A wrong KEK fails here (BACKUP_PASSPHRASE_INVALID), before anything begins.
  const archive = await openAltisbak(file, { ...(kek === null ? {} : { kek }), headroomBytes: MANIFEST_ONLY_HEADROOM });
  try {
    if (archive.header.encryption !== null && archive.dek === null) throw passphraseRequired();
    return { source: 'archive', kek, hmacValid: verifyManifestHmac(o.sessionKey, await archive.manifest()) };
  } finally {
    await archive.close();
  }
}

/** NFKC, then trimmed: how a typed library name is compared. */
function comparableName(name: string): string {
  return name.normalize('NFKC').trim();
}

/**
 * The explicit confirmation another installation's backup needs (spec §7.3 "konfirmasi tegas", §9.10 "eksternal"):
 * `typed` equal to this library's name (`library.name`) after NFKC and trimming.
 *
 * @throws DomainError BACKUP_CONFIRM_REQUIRED when it is missing, blank or different
 */
export async function confirmExternalRestore(db: DbHandle['db'], typed: string | undefined): Promise<void> {
  const name = String((await readSettings(db, ['library.name'], []))['library.name']);
  const given = typed === undefined ? '' : comparableName(typed);
  if (given === '' || given !== comparableName(name)) {
    throw new DomainError('BACKUP_CONFIRM_REQUIRED', {
      detail:
        'Backup ini berasal dari instalasi lain dan akan menggantikan seluruh data di sini; ketik nama perpustakaan ini ' +
        'untuk mengonfirmasi / This backup comes from another installation and replaces all of the data here; type this ' +
        "library's name to confirm",
    });
  }
}

const restore = route<RestoreBody, unknown, z.infer<typeof BackupIdParams>>({
  id: 'backups.restore',
  method: 'POST',
  path: `${BACKUPS}/:id/restore`,
  permission: 'system.backup.restore',
  reauth: true,
  mode: 'system',
  idempotency: 'none',
  // C25: the op writes `backup.restore` when it ends, on the restored database.
  audit: null,
  tx: 'self',
  params: BackupIdParams,
  body: RestoreBody,
  // S18: scrypt never runs inside a transaction.
  prepare: (rc) =>
    prepareRestore({
      db: rc.db.db,
      dataDir: rc.services.dataDir,
      sessionKey: csrfKey(rc.config),
      backupId: rc.params.id,
      passphrase: async () => rc.body.passphrase,
    }),
  async handler(rc) {
    const subject = subjectOf(rc);
    const start = rc.prepared as RestoreStart;
    if (!start.hmacValid) await confirmExternalRestore(rc.db.db, rc.body.confirmLibraryName);
    const params: RestoreParams = {
      backupId: rc.params.id,
      source: start.source,
      withoutFiles: rc.body.withoutFiles ?? false,
      // The admin confirmed another installation's backup (verifying refuses one that was not, Task 22).
      confirmed: !start.hmacValid,
      targetSchema: 'latest',
    };
    const handle = await rc.services.ops.begin('restore', { type: 'staff', id: subject.id }, params, start.kek === null ? {} : { secret: start.kek });
    issueOpsCookie(rc.c, handle);
    rc.services.jobs?.kick(); // a worker loop steps the op at once
    const body: BackupRestoreResponse = { opId: handle.opId };
    return { status: 202, body, headers: NO_STORE };
  },
});

/** The backup routes (route catalog `backups.*`). */
export const BACKUP_ROUTES: RouteDecl[] = [list, create, prepareDownload, download, upload, restore];
