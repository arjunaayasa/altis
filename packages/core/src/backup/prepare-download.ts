import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { decodeBase64Url, encodeBase64Url } from '@altis/crypto';
import { SECRET_COLUMNS, type DB } from '@altis/db';
import {
  backupPartPath,
  dataPath,
  ensureHeadroom,
  listNames,
  openRead,
  readBytes,
  removeFile,
  removeTree,
  statOrNull,
  writeBytesAtomic,
  writeBytesInFolder,
  writeStreamAtomic,
  type DataPath,
} from '@altis/platform';
import { DomainError, isDomainError, isUlid } from '@altis/shared';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { ALTISBAK_STREAM_ALG, type AltisbakHeader } from '../archive/altisbak.js';
import { ARCHIVE_SALT_BYTES, ARCHIVE_SCRYPT, DEK_BYTES, columnKey, deriveKek, newArchiveSalt, newDek, sealArchiveValue, unwrapDek, wrapDek } from '../archive/kdf.js';
import { STREAM_CHUNK } from '../archive/stream-cipher.js';
import { altisbakCheckpointSchema, openAltisbakWriter, type AltisbakCheckpoint, type AltisbakWriter } from '../archive/zip64-writer.js';
import { errorFields, type CoreLogger } from '../context.js';
import { openValue, secretAad, type KeyringEntry } from '../crypto/secret-box.js';
import { isDiskQuota, notifyDiskLow } from '../files/disk-quota.js';
import { enqueue } from '../jobs/enqueue.js';
import { createJobRegistry } from '../jobs/registry.js';
import type { JobContext, JobHandler, JobOutcome } from '../jobs/types.js';
import { fileSha256 } from './blobs.js';
import { backupPathTablesOf, canonicalLine } from './canonical.js';
import {
  BACKUP_FORMAT,
  manifestHmac,
  readManifest,
  signedManifestObject,
  unknownManifestFields,
  unverifiedManifestFields,
  verifyManifestHmac,
  type BackupManifest,
  type BackupManifestTable,
  type BackupPart,
} from './manifest.js';

// The download preparation (spec §9.9 "Download"; decisions C13, C14, C15; ruling R1c-6; plan Task 21): the job
// `backup.prepare_download` turns the `ok` backup `backups/<id>/` into its preparer's own `.altisbak`,
//
//   backups/<id>/downloads/<preparedBy>/archive.altisbak       the archive (zip64-writer.ts), then
//   backups/<id>/downloads/<preparedBy>/prepared.json          {jobId, readyAt, size, encrypted, secrets,
//                                                               completedAt: null}
//
// The folder is named after the preparer (C15): the download route builds the path from its own subject, so nobody
// else can ever reach the archive. `secrets` lets the route check the archive against the subject's grants of the
// moment: one that carries secrets (`archive`, `keyring`) is served only while its preparer is still a super admin.
// housekeeping.files removes the folder 5 minutes after `completedAt` (the last byte was served) or 1 hour after
// `readyAt`.
//
// The entries, after the clear header `altisbak.json`, in this order: every part of every table (the manifest's table
// order, parts by number), every blob (the manifest's order), and last `manifest.json`. A blob is hashed before its
// entry begins: one that is gone, of another size or no longer of its SHA-256 (damage in place reaches it through the
// upload's hard link, blobs.ts) is left out with a warning, so a restore marks that file `missing` (spec §9.10)
// instead of refusing the whole archive; the manifest keeps listing it. The parts of the tables with
// registered secret columns (SECRET_COLUMNS: `staff_users.totp_secret_enc`, `settings.value` where `is_secret = 1`)
// are rewritten unless the secrets stay sealed with the keyring:
//
//   secrets 'archive'  (a super admin, encrypted)    each secret opened with the keyring and sealed with
//                                                     columnKey(DEK), same AAD (`table.column.rowId`): `v1:archive:`
//   secrets 'keyring'  (a super admin, unencrypted)  the parts as the backup holds them (useless without this
//                                                     installation's config.json)
//   secrets 'omitted'  (anyone else)                 the secret columns NULL
//
// sealArchiveValue draws random IVs, so a rewritten part is written to a file first (`.work/<t>-<n>`: the table's
// index in the manifest and the part number) and never rewritten once it is there: a resumed entry must get the same
// bytes again (ruling R1c-6). The archive's manifest is the backup's with the rewritten parts' SHA-256 and `bytes`
// (rows, keys and the per-table checksums stay: the checksums leave the secret columns out), `secrets`, and a new HMAC
// with this installation's key. Every entry is STREAM-encrypted when `encrypted`.
//
// A backup a later release wrote may carry manifest fields this release does not know (ruling R1d-3, decision
// D1d-44). They go into the archive's manifest as they are, under its new HMAC, so the backup loses nothing on its way
// through this release; that is done only when this installation's HMAC covers them in the backup's own manifest, and a
// backup whose unknown fields it does not cover is refused (BACKUP_INVALID `signature`): re-signing them would vouch
// for fields nobody vouched for.
//
// Keys: the route draws the KDF salt and derives the KEK (scrypt, outside any transaction, S18); the KEK travels
// sealed in the job's `secret_param` (cleared when the job ends), the passphrase never reaches the job. The first
// slice draws the DEK and wraps it with the KEK into `dekWrap` (public data, as the archive's header carries it); every
// later slice unwraps it again.
//
// Slices (P7, P9): the payload carries the writer's fixed-size checkpoint, `entry`, the number of entries after the
// header that are finished, and `skipped`, the blobs among them left out (always `entry = checkpoint.entry - 1 +
// skipped`). A slice writes until its deadline: the writer pauses
// between the 1 MiB chunks of a part or blob, the slice between entries. A slice that finds no archive behind its
// checkpoint (removed after a full disk, or by the cleanup) starts over with a new DEK; so does one whose checkpoint
// lies inside a rewritten part whose file is gone (it could not get the same bytes again). A full disk (P21) removes
// the folder, notifies `disk_low` and fails the slice with `DISK_QUOTA`.

export const BACKUP_PREPARE_DOWNLOAD_JOB = 'backup.prepare_download';

/** How an archive holds the secret columns (see the top of this file). */
export type DownloadSecrets = 'archive' | 'keyring' | 'omitted';

/** The job's payload (its checkpoint between slices). */
export type BackupPrepareDownloadPayload = {
  backupId: string;
  /** The staff user who asked: the folder and the only subject who may download. */
  preparedBy: string;
  encrypted: boolean;
  secrets: DownloadSecrets;
  /** The KDF salt (16 bytes, base64url) the route derived the KEK with; null when not encrypted. */
  kdfSalt: string | null;
  /** The DEK wrapped with the KEK (wrapDek), drawn by the first slice; null before it and when not encrypted. */
  dekWrap: { iv: string; ct: string } | null;
  /** The writer's checkpoint; null before the first slice wrote the header. */
  checkpoint: AltisbakCheckpoint | null;
  /** The entries after the header that are finished: `checkpoint.entry - 1 + skipped` (0 before the first slice). */
  entry: number;
  /** The blobs among them left out of the archive (gone, or no longer of their SHA-256); absent: none. */
  skipped?: number;
};

const ulid = z.string().refine(isUlid, 'not a ULID');
const base64UrlBytes = (bytes: number) =>
  z
    .string()
    .max(256)
    .refine((s) => decodeBase64Url(s)?.byteLength === bytes, `must be ${bytes} bytes as unpadded base64url`);

export const backupPrepareDownloadPayload = z
  .strictObject({
    backupId: ulid,
    preparedBy: ulid,
    encrypted: z.boolean(),
    secrets: z.enum(['archive', 'keyring', 'omitted']),
    kdfSalt: base64UrlBytes(ARCHIVE_SALT_BYTES).nullable(),
    dekWrap: z.strictObject({ iv: base64UrlBytes(12), ct: base64UrlBytes(DEK_BYTES + 16) }).nullable(),
    checkpoint: altisbakCheckpointSchema.nullable(),
    entry: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    skipped: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine(
    (p) =>
      p.encrypted === (p.kdfSalt !== null) &&
      (p.encrypted || p.dekWrap === null) &&
      (!p.encrypted || p.checkpoint === null || p.dekWrap !== null) &&
      (p.secrets !== 'archive' || p.encrypted) &&
      (p.secrets !== 'keyring' || !p.encrypted),
    'encrypted, kdfSalt, dekWrap and secrets do not fit together',
  ) satisfies z.ZodType<BackupPrepareDownloadPayload>;

/** What the job needs from the installation (read at every slice: the config of the moment). */
export interface PrepareDownloadDeps {
  dataDir: string;
  /** config.json's keyring: opens the secrets a super admin's encrypted archive re-seals, and the KEK's seal. */
  keyring: readonly KeyringEntry[];
  /** config.json's session key: the archive manifest's HMAC (decision C13). */
  sessionKey: Uint8Array;
}

/** What the route derives from the passphrase before its transaction (S18). */
export interface DownloadKey {
  /** The KDF salt, 16 bytes as unpadded base64url (the archive header's `encryption.kdf.salt`). */
  kdfSalt: string;
  /** scrypt(passphrase, salt): the job's `secret_param`. */
  kek: Uint8Array;
}

/** `prepared.json` of a prepared download. */
export interface PreparedDownload {
  jobId: string;
  readyAt: number;
  size: number;
  encrypted: boolean;
  /** How the archive holds the secret columns: the download serves `archive` and `keyring` to a super admin only. */
  secrets: DownloadSecrets;
  /** When the last byte of a response that held it was served; null before. */
  completedAt: number | null;
}

const epochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const preparedSchema = z.strictObject({
  jobId: ulid,
  readyAt: epochMs,
  size: epochMs,
  encrypted: z.boolean(),
  secrets: z.enum(['archive', 'keyring', 'omitted']),
  completedAt: epochMs.nullable(),
}) satisfies z.ZodType<PreparedDownload>;

/** A slice's writing ends this long before its budget: the result and the heartbeat follow. */
const SLICE_MARGIN_MS = 1000;
/** Positioned reads of a source file. */
const READ_BYTES = STREAM_CHUNK;
/** `prepared.json` is a small JSON file. */
const PREPARED_MAX_BYTES = 64 * 1024;
/** Headroom beyond the files copied: headers, data descriptors, the central directory, the STREAM tags. */
const HEADROOM_MARGIN_BYTES = 1024 * 1024;
const MANIFEST_ENTRY = 'manifest.json';

/** The secret columns of a table (SECRET_COLUMNS), by table name. */
const SECRETS_BY_TABLE: ReadonlyMap<string, readonly { column: string; idColumn: string; onlyWhere: 'is_secret' | undefined }[]> = (() => {
  const map = new Map<string, { column: string; idColumn: string; onlyWhere: 'is_secret' | undefined }[]>();
  for (const s of SECRET_COLUMNS) {
    const list = map.get(s.table) ?? [];
    list.push({ column: s.column, idColumn: s.idColumn, onlyWhere: s.onlyWhere });
    map.set(s.table, list);
  }
  return map;
})();

// ---------------------------------------------------------------------------------------------------------------
// The route's side

/** The archive's secrets for a preparer (decision C14): a super admin's encrypted archive `archive`, unencrypted `keyring`. */
export function downloadSecrets(o: { encrypted: boolean; superAdmin: boolean }): DownloadSecrets {
  if (!o.superAdmin) return 'omitted';
  return o.encrypted ? 'archive' : 'keyring';
}

/**
 * The KDF salt and the KEK of a passphrase: scrypt ({@link ARCHIVE_SCRYPT}), slow on purpose. Call it outside any
 * transaction (the route's `prepare`, S18).
 *
 * @throws DomainError VALIDATION_FAILED (`passphrase`: fewer than 10 characters after NFKC, a lone surrogate)
 */
export async function deriveDownloadKey(passphrase: string): Promise<DownloadKey> {
  const salt = newArchiveSalt();
  return { kdfSalt: encodeBase64Url(salt), kek: await deriveKek(passphrase, salt) };
}

/** A registry that knows the job's payload, for enqueue (its handler never runs from it). */
const enqueueRegistry = createJobRegistry([
  backupPrepareDownloadJob(() => {
    throw new TypeError('backup.prepare_download of the enqueue registry never runs');
  }),
]);

/**
 * Enqueues, in `trx`, the preparation of the `ok` backup `backupId` for the staff user `preparedBy`: encrypted with
 * `key` (its KEK sealed into `secret_param` with `keyring`), or unencrypted when `key` is null; the secrets by
 * {@link downloadSecrets}. One live job per backup and preparer (`uniqueKey 'backup.prepare_download:<id>:<subject>'`):
 * while one runs, an unencrypted request with the same secrets gets it (`existing`); any other request is refused.
 *
 * @throws DomainError NOT_FOUND (no such backup), BACKUP_NOT_READY (not `ok`), BACKUP_PREPARE_IN_PROGRESS (a live job
 *   prepares something else, or the request has a passphrase; `meta.jobId`); enqueue's TX_CONFLICT (withTx retries)
 */
export async function enqueuePrepareDownload(
  trx: Transaction<DB>,
  o: { backupId: string; preparedBy: string; superAdmin: boolean; key: DownloadKey | null; now: number; keyring: readonly KeyringEntry[] },
): Promise<{ jobId: string; existing: boolean; encrypted: boolean; secrets: DownloadSecrets }> {
  if (!isUlid(o.backupId)) throw new DomainError('NOT_FOUND');
  const row = await trx.selectFrom('backups').select('status').where('id', '=', o.backupId).executeTakeFirst();
  if (row === undefined) throw new DomainError('NOT_FOUND');
  if (row.status !== 'ok') throw notReady();
  const encrypted = o.key !== null;
  const payload: BackupPrepareDownloadPayload = {
    backupId: o.backupId,
    preparedBy: o.preparedBy,
    encrypted,
    secrets: downloadSecrets({ encrypted, superAdmin: o.superAdmin }),
    kdfSalt: o.key?.kdfSalt ?? null,
    dekWrap: null,
    checkpoint: null,
    entry: 0,
  };
  const { id, existing } = await enqueue(
    trx,
    enqueueRegistry,
    {
      type: BACKUP_PREPARE_DOWNLOAD_JOB,
      payload,
      uniqueKey: `${BACKUP_PREPARE_DOWNLOAD_JOB}:${o.backupId}:${o.preparedBy}`,
      createdBy: o.preparedBy,
      ...(o.key === null ? {} : { secret: o.key.kek }),
    },
    { now: o.now, keyring: o.keyring },
  );
  if (!existing) return { jobId: id, existing, encrypted, secrets: payload.secrets };
  // The live job prepares what it was asked for first. It answers this request only when the two cannot be told
  // apart: both unencrypted, with the same secrets. A passphrase never matches (each request draws its own salt, so
  // its KEK differs), and an archive other than the one asked for must never be handed out as if it were.
  const held = await trx.selectFrom('jobs').select('payload').where('id', '=', id).executeTakeFirst();
  const parsed = held === undefined ? null : backupPrepareDownloadPayload.safeParse(jsonOrNull(held.payload));
  const live = parsed?.success === true ? parsed.data : null;
  if (live !== null && !live.encrypted && !encrypted && live.secrets === payload.secrets) {
    return { jobId: id, existing, encrypted: false, secrets: live.secrets };
  }
  throw new DomainError('BACKUP_PREPARE_IN_PROGRESS', {
    detail:
      `Unduhan backup ini masih disiapkan dengan pilihan lain (tugas ${id}); tunggu sampai selesai atau batalkan, lalu siapkan lagi / ` +
      `A download of this backup is still being prepared with other choices (job ${id}); wait for it or cancel it, then prepare again`,
    meta: { jobId: id },
  });
}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The prepared files

/**
 * `backups/<backupId>/downloads/<preparedBy>/<file>`: the prepared archive or its `prepared.json`.
 *
 * @throws DomainError INVALID_PATH_SEGMENT when an id is not a ULID
 */
export function preparedDownloadPath(dataDir: string, backupId: string, preparedBy: string, file: 'archive.altisbak' | 'prepared.json'): DataPath {
  return dataPath(dataDir, 'backups', backupId, 'downloads', preparedBy, file);
}

/** The folder of a prepared download, or one of the files in it. */
function downloadDir(dataDir: string, backupId: string, preparedBy: string, ...segments: string[]): DataPath {
  return dataPath(dataDir, 'backups', backupId, 'downloads', preparedBy, ...segments);
}

/**
 * The `prepared.json` of `preparedBy`'s download of backup `backupId`; null when there is none, or when it cannot be
 * read as one (an archive is ready only once it is written whole; one written before `secrets` was recorded is not
 * served either).
 */
export async function readPreparedDownload(dataDir: string, backupId: string, preparedBy: string): Promise<PreparedDownload | null> {
  if (!isUlid(backupId) || !isUlid(preparedBy)) return null;
  let bytes: Buffer | null;
  try {
    bytes = await readBytes(preparedDownloadPath(dataDir, backupId, preparedBy, 'prepared.json'), PREPARED_MAX_BYTES);
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null;
    throw error;
  }
  if (bytes === null) return null;
  const parsed = preparedSchema.safeParse(jsonOrNull(bytes.toString('utf8')));
  return parsed.success ? parsed.data : null;
}

/** A prepared download stays this long after its last byte was served (C15: a download manager may still ask). */
export const DOWNLOAD_DONE_KEEP_MS = 5 * 60_000;
/** A prepared download stays this long after it was ready, while nothing of it was served whole. */
export const DOWNLOAD_READY_KEEP_MS = 60 * 60_000;

/**
 * Whether a download of backup `backupId` that some preparer has ready may still be fetched at `now`: within
 * {@link DOWNLOAD_READY_KEEP_MS} of `readyAt`, or within {@link DOWNLOAD_DONE_KEEP_MS} of `completedAt` once served
 * (the times housekeeping.files keeps it for). The retention leaves such a backup for a later run.
 */
export async function preparedDownloadLive(dataDir: string, backupId: string, now: number): Promise<boolean> {
  if (!isUlid(backupId)) return false;
  for (const preparer of (await listNames(dataPath(dataDir, 'backups', backupId, 'downloads'))).filter(isUlid)) {
    const prepared = await readPreparedDownload(dataDir, backupId, preparer);
    if (prepared === null) continue;
    const live = prepared.completedAt !== null ? now - prepared.completedAt <= DOWNLOAD_DONE_KEEP_MS : now - prepared.readyAt <= DOWNLOAD_READY_KEEP_MS;
    if (live) return true;
  }
  return false;
}

/**
 * Records that a response holding the last byte of the archive job `jobId` prepared was served whole at `at`:
 * `completedAt` becomes `at` (or stays later). Nothing happens when that archive is no longer the prepared one.
 *
 * Other processes may empty the folder meanwhile (housekeeping.files, a new preparation's first slice, which then
 * begins a new archive in it), so the record is written only beside an archive of the size it records, never into a
 * folder that is gone (writeBytesInFolder), and taken back when a new archive took the old one's place before it
 * landed: a new preparation's folder never keeps the old archive's record.
 *
 * @returns whether `prepared.json` was written (and stays)
 */
export async function markDownloadCompleted(dataDir: string, backupId: string, preparedBy: string, o: { jobId: string; at: number }): Promise<boolean> {
  const prepared = await readPreparedDownload(dataDir, backupId, preparedBy);
  if (prepared === null || prepared.jobId !== o.jobId) return false;
  const archive = preparedDownloadPath(dataDir, backupId, preparedBy, 'archive.altisbak');
  const record = preparedDownloadPath(dataDir, backupId, preparedBy, 'prepared.json');
  const archiveThere = async (): Promise<boolean> => {
    const info = await statOrNull(archive);
    return info !== null && info.kind === 'file' && info.size === prepared.size;
  };
  if (!(await archiveThere())) return false;
  const next: PreparedDownload = { ...prepared, completedAt: Math.max(prepared.completedAt ?? 0, o.at) };
  if (!(await writeBytesInFolder(record, JSON.stringify(next)))) return false;
  if (await archiveThere()) return true;
  // A new preparation emptied the folder and began its archive between the check and the write.
  if ((await readPreparedDownload(dataDir, backupId, preparedBy))?.jobId === o.jobId) await removeFile(record);
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// The job

function notReady(): DomainError {
  return new DomainError('BACKUP_NOT_READY', {
    detail: 'Backup ini belum selesai atau tidak lagi tersedia / This backup is not finished or no longer available',
  });
}

function corrupt(reason: string, why: string): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail: `Persiapan unduhan tidak dapat dilanjutkan: ${why} / The download preparation cannot go on: ${why}`,
    meta: { reason },
  });
}

/**
 * The job `backup.prepare_download` (see the top of this file): `system.backup.download`, `origin-only` (only the
 * route that holds the passphrase's KEK may start it), `interactive` (its page may drive it). `deps` is read at every
 * slice.
 */
export function backupPrepareDownloadJob(deps: () => PrepareDownloadDeps): JobHandler<BackupPrepareDownloadPayload> {
  return {
    type: BACKUP_PREPARE_DOWNLOAD_JOB,
    permission: 'system.backup.download',
    retryable: 'origin-only',
    interactive: true,
    payload: backupPrepareDownloadPayload,
    run: (ctx, payload) => prepareSlice(deps(), ctx, payload),
  };
}

/** One entry of the archive after its header. */
type Entry =
  | { kind: 'part'; name: string; table: string; tableIndex: number; part: BackupPart; rewrite: boolean }
  | { kind: 'blob'; name: string; sha256: string; size: number }
  | { kind: 'manifest'; name: string };

/** The archive entry of part `n` of `table`. */
function partEntryName(table: string, n: number): string {
  return `tables/${table}/${String(n).padStart(5, '0')}.jsonl.gz`;
}

/** The entries after the header, in archive order (see the top of this file). */
function entriesOf(m: BackupManifest, secrets: DownloadSecrets): Entry[] {
  const out: Entry[] = [];
  Object.entries(m.tables).forEach(([table, t], tableIndex) => {
    const rewrite = secrets !== 'keyring' && SECRETS_BY_TABLE.has(table);
    for (const part of t.parts) {
      out.push({ kind: 'part', name: partEntryName(table, part.n), table, tableIndex, part, rewrite });
    }
  });
  for (const b of m.blobs) out.push({ kind: 'blob', name: `blobs/${b.sha256}`, sha256: b.sha256, size: b.size });
  out.push({ kind: 'manifest', name: MANIFEST_ENTRY });
  return out;
}

/** The archive's clear header (the descriptive fields of the backup's manifest). */
function headerOf(m: BackupManifest, p: BackupPrepareDownloadPayload): AltisbakHeader {
  const encryption: AltisbakHeader['encryption'] =
    p.encrypted && p.kdfSalt !== null && p.dekWrap !== null
      ? {
          alg: ALTISBAK_STREAM_ALG,
          chunkBytes: STREAM_CHUNK,
          kdf: { alg: 'scrypt', N: ARCHIVE_SCRYPT.N, r: ARCHIVE_SCRYPT.r, p: ARCHIVE_SCRYPT.p, salt: p.kdfSalt },
          dek: p.dekWrap,
        }
      : null;
  return {
    format: BACKUP_FORMAT,
    backupId: m.backupId,
    appVersion: m.appVersion,
    schemaVersion: m.schemaVersion,
    dialect: m.dialect,
    consistency: m.consistency,
    secrets: p.secrets,
    encryption,
  };
}

/** The bytes of the file `p` from byte `from` on (positioned reads; closed when the reader stops). */
function fileBytes(p: DataPath): (from: number) => AsyncIterable<Uint8Array> {
  return (from) =>
    (async function* () {
      const handle: FileHandle = await openRead(p);
      try {
        for (let position = from; ; ) {
          const buffer = Buffer.allocUnsafe(READ_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
          if (bytesRead === 0) return;
          position += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
    })();
}

/** `source` gzip-compressed (errors of either side come out of the iteration). */
async function* gzipped(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  const gz = createGzip();
  const feeding = pipeline(Readable.from(source), gz).then(
    () => null,
    (error: unknown) => error,
  );
  for await (const chunk of gz as AsyncIterable<Buffer>) yield chunk;
  const failure = await feeding;
  if (failure !== null) throw failure;
}

/** `source` gunzipped. */
async function* gunzipped(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  const gunzip = createGunzip();
  const feeding = pipeline(Readable.from(source), gunzip).then(
    () => null,
    (error: unknown) => error,
  );
  for await (const chunk of gunzip as AsyncIterable<Buffer>) yield chunk;
  const failure = await feeding;
  if (failure !== null) throw failure;
}

/** The `\n`-terminated lines of `source`, without their line feeds. */
async function* linesOf(source: AsyncIterable<Buffer>): AsyncGenerator<string> {
  let pieces: Buffer[] = [];
  for await (const chunk of source) {
    let start = 0;
    for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, start)) {
      pieces.push(chunk.subarray(start, at));
      yield Buffer.concat(pieces).toString('utf8');
      pieces = [];
      start = at + 1;
    }
    if (start < chunk.byteLength) pieces.push(chunk.subarray(start));
  }
  if (pieces.length > 0) yield Buffer.concat(pieces).toString('utf8');
}

/** What a part rewrite needs. */
interface RewriteContext {
  secrets: DownloadSecrets;
  keyring: readonly KeyringEntry[];
  /** columnKey(DEK) for `archive`; null otherwise. */
  key: Uint8Array | null;
  log: CoreLogger;
  jobId: string;
}

/** The canonical row `row` of `table` with its secret columns re-sealed (`archive`) or cleared (`omitted`). */
function rewriteRow(table: string, row: Record<string, unknown>, c: RewriteContext): Record<string, unknown> {
  for (const s of SECRETS_BY_TABLE.get(table) ?? []) {
    if (!Object.hasOwn(row, s.column)) continue;
    if (s.onlyWhere !== undefined && row[s.onlyWhere] !== 1) continue;
    const value = row[s.column];
    if (value === null) continue;
    if (c.secrets === 'omitted' || c.key === null) {
      row[s.column] = null;
      continue;
    }
    const id = row[s.idColumn];
    if (typeof value !== 'string' || (typeof id !== 'string' && typeof id !== 'number')) {
      throw new TypeError(`prepare-download: ${table}.${s.column} is not a sealed value`);
    }
    const aad = secretAad(table, s.column, String(id));
    try {
      row[s.column] = sealArchiveValue(c.key, aad, openValue(c.keyring, aad, value));
    } catch (error) {
      // A value this installation cannot open (a key that is gone) is of no use elsewhere either: a restore of the
      // archive treats it as missing (spec §9.10 branch c).
      if (!(isDomainError(error) && error.code === 'SECRET_UNREADABLE')) throw error;
      c.log.warn('backup: a secret the keyring cannot open is left out of the download', { jobId: c.jobId, table, column: s.column });
      row[s.column] = null;
    }
  }
  return row;
}

/** Writes the part `from` with its secret columns rewritten to `to` (atomically: whole or absent). */
async function rewritePart(table: string, from: DataPath, to: DataPath, c: RewriteContext): Promise<void> {
  async function* lines(): AsyncGenerator<Buffer> {
    for await (const line of linesOf(gunzipped(fileBytes(from)(0)))) {
      if (line === '') continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      yield Buffer.from(canonicalLine(rewriteRow(table, row, c)), 'utf8');
    }
  }
  await writeStreamAtomic(to, gzipped(lines()));
}

/** The SHA-256 of the part file `p` (gzip) and its uncompressed size: its manifest record. */
async function partDigest(p: DataPath): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  async function* hashed(): AsyncGenerator<Uint8Array> {
    for await (const chunk of fileBytes(p)(0)) {
      hash.update(chunk);
      yield chunk;
    }
  }
  let bytes = 0;
  for await (const chunk of gunzipped(hashed())) bytes += chunk.byteLength;
  return { sha256: hash.digest('hex'), bytes };
}

/** A file of the backup that is gone or no longer what its manifest says. */
function sourceChanged(what: string): DomainError {
  return new DomainError('BACKUP_INVALID', {
    detail: `Berkas backup ${what} hilang atau berubah / The backup's file ${what} is missing or changed`,
    meta: { reason: 'checksum' },
  });
}

async function prepareSlice(d: PrepareDownloadDeps, ctx: JobContext, given: BackupPrepareDownloadPayload): Promise<JobOutcome<BackupPrepareDownloadPayload>> {
  let p = given;
  const { backupId, preparedBy } = p;
  const dir = (...segments: string[]): DataPath => downloadDir(d.dataDir, backupId, preparedBy, ...segments);
  const archive = preparedDownloadPath(d.dataDir, backupId, preparedBy, 'archive.altisbak');
  const work = (e: Extract<Entry, { kind: 'part' }>): DataPath => dir('.work', `${e.tableIndex}-${e.part.n}`);

  // A slice whose result was lost after the archive was ready (P7).
  if ((await readPreparedDownload(d.dataDir, backupId, preparedBy))?.jobId === ctx.jobId) return { done: true };
  if (ctx.cancelled()) {
    await removeTree(dir());
    return { continueWith: p, progress: 0 }; // a cancel request pending: the queue ends the job cancelled
  }

  try {
    const source = await readManifest(d.dataDir, backupId);
    if (source === null) throw notReady();
    // The part paths accept the backup's own tables (a catalog backup's may be unknown to the registry, review C13).
    const pathTables = backupPathTablesOf(source);
    const partPath = (e: Extract<Entry, { kind: 'part' }>): DataPath => backupPartPath(d.dataDir, backupId, e.table, e.part.n, pathTables);
    const unknown = unknownManifestFields(source);
    if (unknown.length > 0 && !verifyManifestHmac(d.sessionKey, source)) throw unverifiedManifestFields(unknown);
    const entries = entriesOf(source, p.secrets);
    let kek: Uint8Array | null = null;
    if (p.encrypted) {
      kek = await ctx.secretParam();
      if (kek === null || kek.byteLength !== 32) throw corrupt('kek_missing', 'kunci frasa sandi tidak ada / the passphrase key is gone');
    }
    const clock = (): number => ctx.now();

    /** From the start: the folder emptied, the headroom proved, a new DEK, the header written. */
    const begin = async (): Promise<{ writer: AltisbakWriter; dek: Uint8Array | null }> => {
      await removeTree(dir());
      let bytes = HEADROOM_MARGIN_BYTES;
      for (const e of entries) {
        if (e.kind === 'blob') bytes += e.size;
        if (e.kind !== 'part') continue;
        const info = await statOrNull(partPath(e));
        if (info === null || info.kind !== 'file') throw sourceChanged(e.name);
        bytes += info.size;
      }
      await ensureHeadroom(d.dataDir, bytes);
      const dek = kek === null ? null : newDek();
      p = { ...p, dekWrap: kek === null || dek === null ? null : wrapDek(kek, dek), checkpoint: null, entry: 0, skipped: 0 };
      const writer = await openAltisbakWriter(archive, { header: headerOf(source, p), dek, checkpoint: null, clock });
      p = { ...p, checkpoint: writer.checkpoint() };
      return { writer, dek };
    };

    /** Where the payload's checkpoint stands, or a fresh start when it cannot be continued. */
    const resume = async (): Promise<{ writer: AltisbakWriter; dek: Uint8Array | null; fresh: boolean }> => {
      const cp = p.checkpoint;
      if (cp === null || (await statOrNull(archive)) === null) return { ...(await begin()), fresh: true };
      if (p.entry !== cp.entry - 1 + (p.skipped ?? 0) || p.entry >= entries.length) throw corrupt('entry_mismatch', `entri ${p.entry} / entry ${p.entry}`);
      const inside = entries[p.entry]!;
      // A rewritten part is the same bytes again only from its file: without it, the entry cannot be continued.
      if (cp.chunk > 0 && inside.kind === 'part' && inside.rewrite && (await statOrNull(work(inside))) === null) {
        return { ...(await begin()), fresh: true };
      }
      const dek = kek === null ? null : unwrapDek(kek, p.dekWrap!);
      try {
        return { writer: await openAltisbakWriter(archive, { header: headerOf(source, p), dek, checkpoint: cp, clock }), dek, fresh: false };
      } catch (error) {
        const reason = isDomainError(error) && error.code === 'STATE_CORRUPT' ? error.meta?.['reason'] : undefined;
        if (reason !== 'archive_short' && reason !== 'central_short') throw error;
        return { ...(await begin()), fresh: true };
      }
    };

    const { writer, dek, fresh } = await resume();
    const deadline = ctx.now() + Math.max(0, ctx.budgetLeftMs() - SLICE_MARGIN_MS);
    const rewriting: RewriteContext = {
      secrets: p.secrets,
      keyring: d.keyring,
      key: p.secrets === 'archive' && dek !== null ? columnKey(dek) : null,
      log: ctx.log,
      jobId: ctx.jobId,
    };
    const progressAt = (entry: number): number => Math.min(99, Math.floor((entry * 100) / entries.length));

    let wrote = fresh; // the header counts as this slice's work
    while (p.entry < entries.length) {
      if (wrote && ctx.now() >= deadline) break;
      if (ctx.cancelled()) {
        await removeTree(dir());
        return { continueWith: p, progress: progressAt(p.entry) };
      }
      const e = entries[p.entry]!;
      let result: 'done' | 'paused';
      if (e.kind === 'manifest') {
        const parts = new Map<string, Extract<Entry, { kind: 'part' }>>();
        for (const x of entries) if (x.kind === 'part' && x.rewrite) parts.set(x.name, x);
        const bytes = await archiveManifest(source, p.secrets, d.sessionKey, (name) => {
          const part = parts.get(name);
          return part === undefined ? null : work(part);
        });
        result = await writer.writeEntry(e.name, bytes.byteLength, async function* (from) {
          yield bytes.subarray(from);
        }, { deadline });
      } else {
        let file: DataPath;
        let size: number;
        if (e.kind === 'part') {
          file = partPath(e);
          if (e.rewrite) {
            const to = work(e);
            if ((await statOrNull(to)) === null) await rewritePart(e.table, file, to, rewriting);
            file = to;
          }
          const info = await statOrNull(file);
          if (info === null || info.kind !== 'file') throw sourceChanged(e.name);
          size = info.size;
        } else {
          file = dataPath(d.dataDir, 'backups', 'blobs', e.sha256);
          const info = await statOrNull(file);
          const intact = info !== null && info.kind === 'file' && info.size === e.size;
          if (writer.checkpoint().chunk === 0 && (!intact || (await fileSha256(file)) !== e.sha256)) {
            // Not begun yet: left out (see the top of this file).
            ctx.log.warn('backup: a blob is gone or no longer has its SHA-256; it is left out of the download', {
              jobId: ctx.jobId,
              backupId,
              sha256: e.sha256,
            });
            wrote = true;
            p = { ...p, entry: p.entry + 1, skipped: (p.skipped ?? 0) + 1 };
            continue;
          }
          if (!intact) throw sourceChanged(e.name); // changed inside its entry: the bytes written cannot be finished
          size = e.size;
        }
        result = await writer.writeEntry(e.name, size, fileBytes(file), { deadline });
      }
      wrote = true;
      p = { ...p, checkpoint: writer.checkpoint(), entry: result === 'done' ? p.entry + 1 : p.entry };
      if (result === 'paused') break;
      await ctx.heartbeat({ progress: progressAt(p.entry) });
    }
    if (p.entry < entries.length) return { continueWith: p, progress: progressAt(p.entry) };

    const { size } = await writer.finish();
    const prepared: PreparedDownload = { jobId: ctx.jobId, readyAt: ctx.now(), size, encrypted: p.encrypted, secrets: p.secrets, completedAt: null };
    await writeBytesAtomic(preparedDownloadPath(d.dataDir, backupId, preparedBy, 'prepared.json'), JSON.stringify(prepared));
    // The sidecar and the rewritten parts have served their purpose; whatever stays goes with the folder.
    try {
      await removeTree(dir('.work'));
      await removeFile(dir('archive.central'));
    } catch (error) {
      ctx.log.warn('backup: removing the work files of a prepared download failed', { jobId: ctx.jobId, ...errorFields(error) });
    }
    return { done: true };
  } catch (error) {
    if (!isDiskQuota(error)) throw error;
    // P21: the partial archive goes, the holders of Diagnostik hear of it, and the next attempt starts over.
    ctx.log.error('backup: the disk filled up while a download was prepared', { jobId: ctx.jobId, backupId });
    try {
      await removeTree(dir());
    } catch (cleanup) {
      ctx.log.warn('backup: removing a partial download failed', { jobId: ctx.jobId, ...errorFields(cleanup) });
    }
    await notifyDiskLow(ctx.handle, ctx.now(), ctx.log);
    // `last_error` = the bare code (no path in it).
    throw new DomainError('DISK_QUOTA', { cause: error });
  }
}

/**
 * The archive's `manifest.json`: the backup's, with the rewritten parts' SHA-256 and `bytes` (read from their files,
 * `rewritten(entryName)`), `secrets`, and the HMAC of this installation (decision C13). A later release's fields
 * (signedManifestObject: the caller checked that the backup's HMAC covers them) stay where they were, at every level,
 * under the new HMAC (ruling R1d-3).
 */
async function archiveManifest(
  source: BackupManifest,
  secrets: DownloadSecrets,
  sessionKey: Uint8Array,
  rewritten: (entryName: string) => DataPath | null,
): Promise<Buffer> {
  const tables: Record<string, BackupManifestTable> = {};
  for (const [table, t] of Object.entries(source.tables)) {
    if (secrets === 'keyring' || !SECRETS_BY_TABLE.has(table)) {
      tables[table] = t;
      continue;
    }
    const parts: BackupPart[] = [];
    for (const part of t.parts) {
      const file = rewritten(partEntryName(table, part.n));
      if (file === null || (await statOrNull(file)) === null) throw corrupt('part_missing', `${table} ${part.n}`);
      parts.push({ ...part, ...(await partDigest(file)) });
    }
    tables[table] = { ...t, parts };
  }
  const whole = signedManifestObject(source);
  if (whole === null) {
    const unsigned = { ...source, secrets, tables };
    const m: BackupManifest = { ...unsigned, hmac: manifestHmac(sessionKey, unsigned) };
    return Buffer.from(`${JSON.stringify(m)}\n`, 'utf8');
  }
  // The whole object the backup's manifest was parsed from: its known fields are `source`'s (verifyManifestHmac checked
  // both together), and its tables and parts are in the same order, so the known values changed above go in place.
  const wholeTables = whole['tables'] as Record<string, Record<string, unknown> & { parts: Record<string, unknown>[] }>;
  for (const [table, t] of Object.entries(tables)) {
    t.parts.forEach((part, i) => Object.assign(wholeTables[table]!.parts[i]!, { sha256: part.sha256, bytes: part.bytes }));
  }
  whole['secrets'] = secrets;
  const unsigned = whole as unknown as Omit<BackupManifest, 'hmac'>;
  return Buffer.from(`${JSON.stringify({ ...unsigned, hmac: manifestHmac(sessionKey, unsigned) })}\n`, 'utf8');
}
