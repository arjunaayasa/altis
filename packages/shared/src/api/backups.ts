/**
 * The backups API vocabulary shared by the server and the admin (spec §9.9, §13.5 "Backup"; plan Task 20). No Node
 * built-ins here: the browser bundles this module. Import it as `@altis/shared/api/backups`.
 *
 * - `GET backups` (`system.backup.read`) → 200 {@link BackupListResponse}: every backup, newest first (history rows
 *   are kept: a removed one shows `deleted`), and the next daily backup's time (null while `backup.daily` is off).
 * - `POST backups` {@link BackupCreateBody} (`system.backup.create`, works in read-only) → 202
 *   {@link BackupCreateResponse}: the server chooses how (§9.9 "Konsistensi"). `snapshot`: a job (`jobId`, followed on
 *   `jobs.<id>` and `system.backup`); `frozen`: an op under maintenance (`opId`), with the `altis_ops` cookie, and
 *   the page moves to `/admin/_update`, whose drive and `/_cron` finish it. 409 `OPS_IN_PROGRESS` while another op
 *   runs, `OPS_BLOCKED_BY_BACKUP` when a frozen backup would begin while a snapshot backup runs.
 */
import { z } from 'zod';
import { ulidField } from './common.js';

/** `POST backups`: with the uploads' blobs (`includeFiles`, default false: DB only). */
export const BackupCreateBody = z.strictObject({ includeFiles: z.boolean().optional() });
export type BackupCreateBody = z.infer<typeof BackupCreateBody>;

/** What `POST backups` began. */
export type BackupCreateResponse = { consistency: 'snapshot'; jobId: string } | { consistency: 'frozen'; opId: string };

/** One backup as the list shows it (the server's BackupItem). */
export interface BackupItem {
  id: string;
  kind: 'manual' | 'scheduled' | 'pre_update' | 'pre_restore' | 'external';
  status: 'running' | 'ok' | 'failed' | 'deleted' | 'uploaded';
  /** Bytes on disk once `ok` (an uploaded archive's size); null before. */
  size: number | null;
  createdAt: number;
  consistency: 'snapshot' | 'frozen';
  includesFiles: boolean;
  /** An archive uploaded from elsewhere. */
  external: boolean;
  /** Its manifest carries this installation's HMAC. */
  sameInstall: boolean;
  schemaVersion: string;
  appVersion: string;
  dialect: 'sqlite' | 'mysql' | 'mariadb' | 'postgres';
}

/** `GET backups`. */
export interface BackupListResponse {
  items: BackupItem[];
  /** The next run of `backup.daily` (epoch ms), or null while it is disabled. */
  nextScheduledAt: number | null;
}

// ---- 1c Task 21: prepare a download, download it (Range), upload an archive (spec §9.9 "Download", §9.10, S15).
//
// - `POST backups/:id/prepare-download` {@link BackupPrepareBody} (`system.backup.download`, reauth) → 202
//   {@link BackupPrepareResponse}: the job `backup.prepare_download` builds the subject's own `.altisbak` of the `ok`
//   backup `:id`, encrypted with the passphrase (default) or, opt-in, unencrypted. A super admin's encrypted archive
//   carries the secrets re-sealed with the archive key; an unencrypted one keeps them sealed with this installation's
//   keyring; anyone else's archive leaves the TOTP secrets and secret settings out. 404 for an unknown backup, 409
//   `BACKUP_NOT_READY` for one that is not `ok`. While the subject's preparation of `:id` is still live, an unencrypted
//   request with the same secrets gets that job again; any other request (another choice, or any passphrase) → 409
//   `BACKUP_PREPARE_IN_PROGRESS`, whose detail names the live job (cancel it or wait, then prepare again).
// - `GET backups/:id/download` (`system.backup.download`): the subject's prepared archive (`application/octet-stream`,
//   `Accept-Ranges: bytes`, `ETag: "<jobId>-<size>"`); one `Range: bytes=a-b` → 206, an unsatisfiable one → 416
//   `RANGE_NOT_SATISFIABLE`; none prepared (or not ready, or prepared by someone else) → 409 `BACKUP_NOT_READY`.
// - `POST backups/upload` {@link BackupUploadBody} (`system.backup.restore`, reauth) → 200 {@link BackupItem}: the
//   completed staged upload (context `backup`) becomes the backup `kind: 'external'`, `status: 'uploaded'`; Task 29's
//   `POST backups/:id/restore` (below) restores it.

/**
 * `POST backups/:id/prepare-download`: exactly one of `passphrase` (the archive is encrypted with it: at least 10
 * characters after NFKC, checked by the server) and `unencrypted: true` (opt-in, audited).
 */
export const BackupPrepareBody = z
  .strictObject({
    passphrase: z.string().min(1).max(512).optional(),
    unencrypted: z.literal(true).optional(),
  })
  .refine((b) => (b.passphrase === undefined) !== (b.unencrypted === undefined), {
    message: 'Isi tepat satu: frasa sandi atau unencrypted / Give exactly one of passphrase and unencrypted',
    path: ['passphrase'],
  });
export type BackupPrepareBody = z.infer<typeof BackupPrepareBody>;

/** What `POST backups/:id/prepare-download` began: the job that prepares the archive (followed on `jobs.<id>`). */
export interface BackupPrepareResponse {
  jobId: string;
}

/** `POST backups/upload`: the completed upload (context `backup`) of an `.altisbak` archive. */
export const BackupUploadBody = z.strictObject({ uploadId: ulidField });
export type BackupUploadBody = z.infer<typeof BackupUploadBody>;

/** `POST backups/upload`: the new backup (`kind: 'external'`, `status: 'uploaded'`). */
export type BackupUploadResponse = BackupItem;

// ---- 1c Task 29: restore a backup (spec §9.10, §7.3 "konfirmasi tegas"; preflight S6, S18; decision C25).
//
// - `POST backups/:id/restore` {@link RestoreBody} (`system.backup.restore`, reauth, works in read-only) → 202
//   {@link BackupRestoreResponse} and the `altis_ops` cookie: the `restore` op begins under maintenance and the page
//   moves to `/admin/_update`, whose drive (and `/_cron`, the worker) finish it. The backup must be `ok` (a backup made
//   by this server) or `uploaded` (an archive, Task 21); 404 for an unknown one, 409 `BACKUP_NOT_READY` for any other
//   status. An encrypted archive needs its `passphrase`: none → 422 `BACKUP_PASSPHRASE_REQUIRED`, a wrong one → 422
//   `BACKUP_PASSPHRASE_INVALID`. A backup without this installation's HMAC (another installation's) replaces this data
//   only with `confirmLibraryName` equal to this library's name (`library.name`, compared after NFKC and trimming):
//   missing or different → 409 `BACKUP_CONFIRM_REQUIRED`. Another op in progress → 409 `OPS_IN_PROGRESS`; a snapshot
//   backup running → 409 `OPS_BLOCKED_BY_BACKUP`. The route writes no audit entry: the op writes `backup.restore` when
//   it ends (C25). There is no `targetSchema` in 1c (S6): every restore ends at this release's schema.

/** `POST backups/:id/restore`. */
export const RestoreBody = z.strictObject({
  /** The passphrase of an encrypted archive (not used for a backup that is not encrypted). */
  passphrase: z.string().max(512).optional(),
  /** Restore the database only: every uploaded file ends `missing` (default false). */
  withoutFiles: z.boolean().optional(),
  /** This library's name, typed by the admin: the explicit confirmation another installation's backup needs. */
  confirmLibraryName: z.string().max(191).optional(),
});
export type RestoreBody = z.infer<typeof RestoreBody>;

/** What `POST backups/:id/restore` began: the op (followed on `/admin/_update` with the `altis_ops` cookie). */
export interface BackupRestoreResponse {
  opId: string;
}
