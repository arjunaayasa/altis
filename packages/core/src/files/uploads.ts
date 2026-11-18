import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { claimLock, countRows, releaseLock, withTx, type DB, type DbHandle } from '@altis/db';
import {
  dataPath,
  ensureHeadroom,
  openRead,
  openReadWrite,
  readBytes,
  removeTree,
  statOrNull,
  writeBytesAtomic,
  type DataPath,
} from '@altis/platform';
import { DomainError, isDomainError, isUlid, newId } from '@altis/shared';
import type { UploadContextName } from '@altis/shared/api/files';
import type { Kysely, Transaction } from 'kysely';
import { lockStaffRow } from '../auth/staff.js';
import { readSettings } from '../settings/service.js';
import { CHUNK_DEFAULT_BYTES, CHUNK_MIN_BYTES, UPLOADS_PER_SUBJECT, UPLOAD_TTL_MS, uploadContext, type UploadContext } from './contexts.js';
import { reportingDiskLow } from './disk-quota.js';
import { MAGIC_HEAD_BYTES, detectType, type DetectedKind } from './magic.js';
import { localStorageDriver } from './serve.js';
import { IncrementalSha256, decodeSha256Midstate, encodeSha256Midstate } from './sha256-incremental.js';
import { stripImageMetadata, type StrippableImage } from './strip-metadata.js';
// ---- Komunitas (OPAC home page) ----
import { jpegInfo } from '../print/jpeg.js';
// ---- Site identity ----
import { SiteImageError, storedSiteIcon, storedSiteLogo } from './site-images.js';

// Chunked, resumable uploads (spec §7.5, P10, P21; decision C7; preflight M16, M36).
//
// - Declared first: context, size and SHA-256 (createUpload, in the route's transaction after its `prepare` proved
//   twice the size of disk room, S8). The server fixes the chunk size then; the session lives 24 h.
// - Chunk n covers bytes [n × chunk_size, ...). The staged file is `tmp/<id>/upload.bin`. A chunk below `received`
//   is stored already (an idempotent retry: nothing happens); a chunk at `received` truncates the file to `received`
//   and is written at its offset, never appended, so two sends of one chunk cannot double it (M16); one beyond is a
//   gap (409 order). `received` then moves with `WHERE received = :old` (fenced).
// - Every step that touches the staged file (chunk, complete, abort) holds the named lock `upload:<id>` (a `locks`
//   row, P6: every process sees it). Without it, a duplicate of chunk n that arrives late could truncate the file
//   after chunk n + 1 was stored, from a `received` it read before; under the lock the row is read again first.
//   The lock is renewed while it is held (a timer, and before every change), so a slow write or completion is never
//   run twice at once; a holder whose renewal failed, or came after its lease ran out, stops before its next change
//   (409 TX_CONFLICT `upload_busy`, as when the lock stays busy). Ruling R1c-4.
// - The SHA-256 grows with the chunks (ruling R1c-4, P9): each accepted chunk is fed to a pure-JS SHA-256 whose
//   midstate is saved under the lock as `tmp/<id>/upload.midstate`, after `received` moved (so the midstate never
//   covers bytes the row does not: one that does is not trusted). Node's Hash state cannot cross processes (M18).
//   A midstate that is behind (the process died between the two writes), missing or corrupt is caught up from the
//   stored bytes, which `received` vouches for: normally one chunk at most.
// - Completion checks `received = size`, the staged file's size, the digest (finalized from the midstate, O(1)) and
//   the magic bytes of the file's head against the context; it never reads the whole file. A `staged` context keeps
//   the file with a `.complete` marker for its consumer (takeStagedUpload); a `file` context stores it through the
//   local StorageDriver, inserts a `files` row and drops the session.
// - P21: `ENOSPC`/`EDQUOT` while a chunk is written is `DISK_QUOTA` (507), after the staged file and the session are
//   removed. Platform maps what its helpers do; the writes made here on the handle are mapped here. Every DISK_QUOTA
//   of prepareUpload, acceptChunk and completeUpload (the headroom refusal included) also sends
//   `notification.disk_low`, the warning Diagnostik and the dashboard show (files/disk-quota.ts).
// - File I/O never runs inside a re-runnable transaction (R37): the database writes here are short transactions of
//   their own, between the file steps. takeStagedUpload, which runs in the consumer's transaction, only reads the
//   marker (a read has no effect to repeat).
// - Phase 2 (its spec §8; plan Task 18): a context's `maxBytesSetting` (`catalog.attachment.maxMb`, in MiB) lowers its
//   static ceiling when the upload is declared, in `prepare` (before the disk is probed for twice the size) and again
//   in the declaring transaction. The images ALTIS publishes as uploaded (covers, floor plans, page images) lose their
//   metadata at completion (strip-metadata.ts): the stored bytes are the stripped ones, and the `files` row carries
//   their size and SHA-256 (the session's digest still vouches for the bytes that arrived). An image whose structure
//   does not hold is refused like a wrong type.

/** How an upload's named lock is held, renewed and waited for. */
export interface UploadLockTiming {
  /** One claim or renewal holds the lock this long. */
  ttlMs: number;
  /** The holder renews it this often (well under `ttlMs`). */
  renewMs: number;
  /** A request waits this long for a busy lock before giving up (409 TX_CONFLICT `upload_busy`). */
  waitMs: number;
}

/** The holder's side of an upload's lock (see {@link withUploadLock}). */
export interface UploadLease {
  /** Throws unless the lock has been held without a break so far (no database round trip: for loops). */
  check(): void;
  /** Renews the lock now, then checks as {@link check} does: before every change to the upload. */
  renew(): Promise<void>;
}

/** 60 s per claim, renewed every 15 s; a request waits 10 s for a busy upload (the client retries the 409). */
const LOCK_TIMING: UploadLockTiming = Object.freeze({ ttlMs: 60_000, renewMs: 15_000, waitMs: 10_000 });
/** The staged file is read in pieces of this size (catching a midstate up, copying, the head). */
const READ_CHUNK_BYTES = 1024 * 1024;
/** A setting in MB counts mebibytes (as `catalog.attachment.maxMb` everywhere: SLiMS blobs, the files zip). */
const MIB = 1024 * 1024;
/** The contexts whose images are stored without their metadata (spec §8, D2-18). */
const STRIPPED_CONTEXTS: ReadonlySet<UploadContextName> = new Set<UploadContextName>([
  'catalog.cover',
  'catalog.floor_plan',
  'opac.page_image',
  // ---- Komunitas (OPAC home page) ----
  'opac.home_photo',
]);
/** The kinds {@link stripImageMetadata} handles (a GIF page image is stored as it came). */
const STRIPPABLE: ReadonlySet<string> = new Set<StrippableImage>(['jpeg', 'png', 'webp']);
/** `.complete` is a small JSON file. */
const MARKER_MAX_BYTES = 64 * 1024;
/** `upload.midstate` is a JSON text of about 230 bytes. */
const MIDSTATE_MAX_BYTES = 4 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const OWNER = /^staff:([0-9A-HJKMNP-TV-Z]{26})$/;

/** The default name of a stored file whose upload did not give one, by detected kind. */
const DEFAULT_NAMES: Readonly<Record<DetectedKind, string>> = {
  zip: 'file.zip',
  pdf: 'file.pdf',
  png: 'file.png',
  jpeg: 'file.jpg',
  gif: 'file.gif',
  webp: 'file.webp',
  svg: 'file.svg',
  unknown: 'file.bin',
  // ---- Phase 2 (catalog): Task 2 ----
  mp3: 'file.mp3',
  mp4: 'file.mp4',
  ogg: 'file.ogg',
  wav: 'file.wav',
  webm: 'file.webm',
  gzip: 'file.gz',
  xml: 'file.xml',
  iso2709: 'file.mrc',
  text: 'file.txt',
};

type Db = Kysely<DB> | Transaction<DB>;

/** An upload session as read from its row. */
interface Session {
  id: string;
  owner: string;
  context: string;
  size: number;
  sha256: string;
  chunkSize: number;
  received: number;
  expiresAt: number;
}

/** What `.complete` holds: the verified upload (`sha256`: the digest of the bytes received, R1c-4). */
interface CompleteMarker {
  size: number;
  sha256: string;
  mime: string;
  originalName: string | null;
  completedAt: number;
}

/** The answer of completeUpload for a staged context. */
export interface StagedUpload {
  uploadId: string;
  size: number;
  sha256: string;
  mime: string;
}

/** `staff:<id>`: the `upload_sessions.owner` of a staff user's uploads. @throws TypeError unless `staffId` is a ULID */
export function uploadOwner(staffId: string): string {
  if (!isUlid(staffId)) throw new TypeError(`uploadOwner: ${JSON.stringify(staffId)} is not a staff user id`);
  return `staff:${staffId}`;
}

/** The staff id of `owner`. @throws TypeError for anything but `staff:<ULID>` */
function ownerStaffId(owner: string): string {
  const match = OWNER.exec(owner);
  if (match === null) throw new TypeError(`upload owner ${JSON.stringify(owner)} is not staff:<id>`);
  return match[1]!;
}

/** `tmp/<id>`: the staging folder of upload `id`. */
function stagingDir(dataDir: string, id: string): DataPath {
  return dataPath(dataDir, 'tmp', id);
}

/** `tmp/<id>/upload.bin`: the staged bytes of upload `id`. */
function stagedFile(dataDir: string, id: string): DataPath {
  return dataPath(dataDir, 'tmp', id, 'upload.bin');
}

/** `tmp/<id>/.complete`: written when a staged upload was verified. */
function markerFile(dataDir: string, id: string): DataPath {
  return dataPath(dataDir, 'tmp', id, '.complete');
}

/** `tmp/<id>/upload.midstate`: the SHA-256 midstate of the bytes of upload `id` received so far (R1c-4). */
function midstateFile(dataDir: string, id: string): DataPath {
  return dataPath(dataDir, 'tmp', id, 'upload.midstate');
}

function notFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Sesi unggah tidak ditemukan / Upload session not found' });
}

function expired(): DomainError {
  return new DomainError('UPLOAD_EXPIRED', {
    detail: 'Sesi unggah sudah kedaluwarsa (24 jam); mulai ulang unggahan / The upload session expired (24 h); start the upload again',
  });
}

function chunkInvalid(reason: 'order' | 'size', detail: string): DomainError {
  return new DomainError('UPLOAD_CHUNK_INVALID', { detail, meta: { reason } });
}

function mismatch(reason: 'size' | 'sha256'): DomainError {
  return new DomainError('UPLOAD_MISMATCH', {
    detail:
      reason === 'size'
        ? 'Ukuran berkas yang diterima tidak sama dengan yang dinyatakan / The received file does not have the declared size'
        : 'SHA-256 berkas yang diterima tidak sama dengan yang dinyatakan / The SHA-256 of the received file is not the declared one',
    meta: { reason },
  });
}

/** `DISK_QUOTA` for `ENOSPC`/`EDQUOT` (P21), a `DISK_QUOTA` DomainError as it is; null for anything else. */
function quotaError(error: unknown): DomainError | null {
  if (isDomainError(error)) return error.code === 'DISK_QUOTA' ? error : null;
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  if (code !== 'ENOSPC' && code !== 'EDQUOT') return null;
  return new DomainError('DISK_QUOTA', {
    detail:
      `Ruang disk atau kuota hosting habis saat menulis unggahan (${code}); unggahan dibatalkan / ` +
      `The disk is full or the hosting quota is used up while writing the upload (${code}); the upload was cancelled`,
    meta: { code },
    cause: error,
  });
}

/** The staged bytes of an upload vanished (removed from outside, or by the 24 h cleanup): the upload is gone. */
function cleanedUp(): DomainError {
  return new DomainError('UPLOAD_EXPIRED', {
    detail: 'Berkas sementara unggahan ini sudah dibersihkan; mulai ulang unggahan / The staged bytes of this upload were cleaned up; start again',
  });
}

function busy(lost: boolean): DomainError {
  return new DomainError('TX_CONFLICT', {
    detail: lost
      ? 'Kunci unggahan ini lepas saat permintaan berjalan; kirim ulang / This request lost the lock of its upload; send it again'
      : 'Unggahan ini sedang ditulis oleh permintaan lain; kirim ulang sebentar lagi / Another request is writing this upload; send it again shortly',
    meta: { reason: 'upload_busy' },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` while holding the named lock `upload:<id>` (see the top of this file), waiting up to `timing.waitMs`
 * (10 s) for it. While `fn` runs the lock is renewed every `timing.renewMs` (15 s; a timer of this request, like
 * withFileLock's heartbeat, cleared before returning) and whenever `fn` calls `lease.renew()`. The lock counts as
 * held without a break only while each renewal ends before the previous claim runs out (a renewal after that could
 * re-take a lock that another request held and let go meanwhile), so a renewal that fails or comes late marks it lost
 * and the next `lease.check()` or `lease.renew()` throws. `timing` is for tests.
 *
 * @throws DomainError `TX_CONFLICT` (409, `reason: 'upload_busy'`) when another request kept the lock that long, or
 *   from `lease` when it was lost
 */
export async function withUploadLock<T>(
  h: DbHandle,
  id: string,
  fn: (lease: UploadLease) => Promise<T>,
  timing: UploadLockTiming = LOCK_TIMING,
): Promise<T> {
  const name = `upload:${id}`;
  const owner = newId();
  const deadline = performance.now() + timing.waitMs;
  let heldUntil: number;
  for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
    const started = Date.now();
    if (await claimLock(h, name, owner, timing.ttlMs)) {
      heldUntil = started + timing.ttlMs;
      break;
    }
    if (performance.now() >= deadline) throw busy(false);
    await sleep(delay);
  }

  let lost = false;
  let closed = false;
  const renewOnce = async (): Promise<void> => {
    if (lost || closed) return;
    const started = Date.now();
    let held: boolean;
    try {
      held = await claimLock(h, name, owner, timing.ttlMs);
    } catch {
      held = false;
    }
    if (!held || Date.now() >= heldUntil) {
      lost = true;
      return;
    }
    heldUntil = Math.max(heldUntil, started + timing.ttlMs);
  };
  // Renewals run one after another (renewOnce never rejects), and the last one is awaited before the release.
  let renewals: Promise<void> = Promise.resolve();
  const renew = (): Promise<void> => (renewals = renewals.then(renewOnce));
  const timer = setInterval(() => void renew(), timing.renewMs);
  timer.unref();
  const lease: UploadLease = {
    check() {
      if (!lost && Date.now() >= heldUntil) lost = true;
      if (lost) throw busy(true);
    },
    async renew() {
      await renew();
      lease.check();
    },
  };
  try {
    return await fn(lease);
  } finally {
    closed = true;
    clearInterval(timer);
    await renewals;
    // Only our own claim is deleted (a lock taken over stays with its new holder). A release that fails (the
    // database went away) leaves the lock to expire after `ttlMs`.
    await releaseLock(h, name, owner).catch(() => undefined);
  }
}

async function readSession(db: Db, id: string, owner: string): Promise<Session | null> {
  const row = await db
    .selectFrom('upload_sessions')
    .select(['id', 'owner', 'context', 'size', 'sha256', 'chunk_size', 'received', 'expires_at'])
    .where('id', '=', id)
    .where('owner', '=', owner)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    id: row.id,
    owner: row.owner,
    context: row.context,
    size: Number(row.size),
    sha256: row.sha256,
    chunkSize: Number(row.chunk_size),
    received: Number(row.received),
    expiresAt: Number(row.expires_at),
  };
}

/** Session `id` of `owner`, not expired. @throws DomainError `NOT_FOUND`, `UPLOAD_EXPIRED` */
async function liveSession(db: Db, id: string, owner: string, now: number): Promise<Session> {
  const s = await readSession(db, id, owner);
  if (s === null) throw notFound();
  if (now >= s.expiresAt) throw expired();
  return s;
}

/** Removes upload `id` entirely: its session row and its staging folder. Best effort: the caller is failing already. */
async function discard(h: DbHandle, id: string, dataDir: string): Promise<void> {
  await withTx(h, (trx) => trx.deleteFrom('upload_sessions').where('id', '=', id).execute()).catch(() => undefined);
  await removeTree(stagingDir(dataDir, id)).catch(() => undefined);
}

/** Refuses `size` over `maxBytes` (the context's static ceiling unless a setting lowered it). */
function checkSize(context: UploadContext, size: number, maxBytes: number = context.maxBytes): void {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError(`upload size must be a positive integer, got ${String(size)}`);
  if (size > maxBytes) {
    throw new DomainError('UPLOAD_TOO_LARGE', {
      detail:
        `Berkas ${size} byte melebihi batas ${maxBytes} byte untuk unggahan ${context.name} / ` +
        `A file of ${size} bytes is over the ${maxBytes} byte limit of ${context.name} uploads`,
      meta: { maxBytes },
    });
  }
}

/**
 * The largest size `context` takes now: its static ceiling, lowered by its `maxBytesSetting` (in MiB) when it names
 * one (P2-22). Read afresh, not from the settings cache: a limit an admin just lowered applies to the next upload.
 */
async function maxBytesOf(db: Db, context: UploadContext): Promise<number> {
  const key = context.maxBytesSetting;
  if (key === undefined) return context.maxBytes;
  const mb = (await readSettings(db, [key], []))[key];
  return typeof mb === 'number' && Number.isSafeInteger(mb) && mb > 0 ? Math.min(context.maxBytes, mb * MIB) : context.maxBytes;
}

/**
 * The route's `prepare` step, outside any transaction (R37): refuses a size over the context's maximum, or over the
 * limit its `maxBytesSetting` sets (UPLOAD_TOO_LARGE), then proves room for twice the size with
 * `ensureHeadroom(dataDir, 2 × size)` (spec §7.5; the first argument is DATA_DIR, S8: the probe writes under `tmp/`
 * itself). `o.ensureHeadroom` replaces the probe (tests). A refusal sends `notification.disk_low` through `h` (P21).
 *
 * @throws DomainError `UPLOAD_TOO_LARGE`, `DISK_QUOTA`
 */
export async function prepareUpload(
  h: DbHandle,
  o: {
    context: UploadContext;
    size: number;
    dataDir: string;
    now: number;
    ensureHeadroom?: (dataDir: string, bytes: number) => Promise<void>;
  },
): Promise<void> {
  checkSize(o.context, o.size);
  checkSize(o.context, o.size, await maxBytesOf(h.db, o.context));
  await reportingDiskLow(h, o.now, () => (o.ensureHeadroom ?? ensureHeadroom)(o.dataDir, 2 * o.size));
}

/** The largest chunk the browser test of Diagnostik saw pass (`system.probe.chunkBytes`), or null. */
async function probedChunkBytes(trx: Transaction<DB>): Promise<number | null> {
  const { 'system.probe': probe } = await readSettings(trx, ['system.probe'], []);
  const bytes = (probe as { chunkBytes?: unknown } | null)?.chunkBytes;
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * Declares an upload in `trx` (the route's transaction, after {@link prepareUpload}). The owner's `staff_users` row is
 * locked first, so that two concurrent declarations cannot both pass the count (M36); the context's
 * `maxBytesSetting` is read after that lock (it may have changed since `prepare`). The chunk size is
 * `clamp(chunkBytes ?? system.probe.chunkBytes ?? 5 MiB, 256 KiB, 5 MiB)`. No file is written yet (the first chunk
 * creates the staging folder under `dataDir`).
 *
 * @throws DomainError `UPLOAD_TOO_LARGE` (413), `UPLOAD_LIMIT` (429, a 4th live session of the owner;
 *   `meta.retryAfterS` until the oldest one expires)
 * @throws TypeError for an owner that is not `staff:<id>`, or a malformed SHA-256
 */
export async function createUpload(
  trx: Transaction<DB>,
  o: { owner: string; context: UploadContext; size: number; sha256: string; chunkBytes?: number; now: number; dataDir: string },
): Promise<{ id: string; chunkSize: number; chunks: number; expiresAt: number }> {
  checkSize(o.context, o.size);
  if (!SHA256_HEX.test(o.sha256)) throw new TypeError('createUpload: sha256 must be 64 lower-case hex digits');
  await lockStaffRow(trx, ownerStaffId(o.owner)); // first statement (M36)
  checkSize(o.context, o.size, await maxBytesOf(trx, o.context));

  const live = trx.selectFrom('upload_sessions').where('owner', '=', o.owner).where('expires_at', '>', o.now);
  if ((await countRows(live)) >= UPLOADS_PER_SUBJECT) {
    const oldest = await live.select('expires_at').orderBy('expires_at').limit(1).executeTakeFirst();
    const retryAfterS = oldest === undefined ? 0 : Math.max(0, Math.ceil((Number(oldest.expires_at) - o.now) / 1000));
    throw new DomainError('UPLOAD_LIMIT', {
      detail:
        `Paling banyak ${UPLOADS_PER_SUBJECT} unggahan berjalan sekaligus; selesaikan atau batalkan salah satunya / ` +
        `At most ${UPLOADS_PER_SUBJECT} uploads may be open at once; finish or cancel one of them`,
      meta: { retryAfterS },
    });
  }

  const wanted = o.chunkBytes ?? (await probedChunkBytes(trx)) ?? CHUNK_DEFAULT_BYTES;
  const chunkSize = Math.min(CHUNK_DEFAULT_BYTES, Math.max(CHUNK_MIN_BYTES, Math.trunc(wanted)));
  const id = newId(o.now);
  const expiresAt = o.now + UPLOAD_TTL_MS;
  await trx
    .insertInto('upload_sessions')
    .values({ id, owner: o.owner, context: o.context.name, size: o.size, sha256: o.sha256, chunk_size: chunkSize, received: 0, expires_at: expiresAt })
    .execute();
  return { id, chunkSize, chunks: Math.ceil(o.size / chunkSize), expiresAt };
}

/** Writes all of `data` at `position` of `handle`. */
async function writeAt(handle: FileHandle, data: Uint8Array, position: number): Promise<void> {
  for (let done = 0; done < data.byteLength; ) {
    const { bytesWritten } = await handle.write(data, done, data.byteLength - done, position + done);
    if (!(bytesWritten > 0)) throw new Error('chunk write made no progress');
    done += bytesWritten;
  }
}

/**
 * Stores `data` at `start` of the staged file: opened (created with its folder when missing), cut to `start`, written
 * there, fsynced. A staged file shorter than `start` lost its bytes (removed from outside): the upload is gone.
 *
 * @throws DomainError `DISK_QUOTA` (P21) or `UPLOAD_EXPIRED`, after the upload was discarded
 */
async function writeChunk(h: DbHandle, s: Session, start: number, data: Uint8Array, dataDir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await openReadWrite(stagedFile(dataDir, s.id));
    if ((await handle.stat()).size < start) {
      await handle.close().catch(() => undefined);
      handle = undefined;
      await discard(h, s.id, dataDir);
      throw cleanedUp();
    }
    await handle.truncate(start);
    await writeAt(handle, data, start);
    await handle.sync();
    const done = handle;
    handle = undefined;
    await done.close(); // NFS reports a quota overrun here at the latest
  } catch (error) {
    await handle?.close().catch(() => undefined);
    const quota = quotaError(error);
    if (quota === null) throw error;
    await discard(h, s.id, dataDir);
    throw quota;
  }
}

/** The midstate saved for upload `id` as a hash that can go on, or null when it is missing, unreadable or corrupt. */
async function loadDigest(dataDir: string, id: string): Promise<IncrementalSha256 | null> {
  let raw: Buffer | null;
  try {
    raw = await readBytes(midstateFile(dataDir, id), MIDSTATE_MAX_BYTES);
  } catch {
    return null; // not a regular file, or too large: rebuilt like a missing one
  }
  const m = raw === null ? null : decodeSha256Midstate(raw.toString('utf8'));
  return m === null ? null : IncrementalSha256.fromMidstate(m);
}

/**
 * The SHA-256 of the first `upTo` bytes of upload `s` (bytes `received` vouches for), in progress: the saved midstate
 * when it covers exactly that; else one that is behind (or a fresh one, when it is missing, corrupt or ahead of
 * `upTo`) caught up from the staged file, checking the lease after every piece read.
 *
 * @throws DomainError `UPLOAD_EXPIRED` after discarding the upload when the staged file holds fewer bytes; the
 *   lease's `TX_CONFLICT`
 */
async function digestAt(h: DbHandle, lease: UploadLease, s: Session, upTo: number, dataDir: string): Promise<IncrementalSha256> {
  const saved = await loadDigest(dataDir, s.id);
  const digest = saved !== null && saved.length <= upTo ? saved : new IncrementalSha256();
  if (digest.length === upTo) return digest;
  let handle: FileHandle;
  try {
    handle = await openRead(stagedFile(dataDir, s.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    await discard(h, s.id, dataDir);
    throw cleanedUp();
  }
  let short = false;
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (digest.length < upTo) {
      lease.check();
      const want = Math.min(READ_CHUNK_BYTES, upTo - digest.length);
      const { bytesRead } = await handle.read(buffer, 0, want, digest.length);
      if (bytesRead === 0) {
        short = true;
        break;
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (short) {
    await discard(h, s.id, dataDir);
    throw cleanedUp();
  }
  return digest;
}

/**
 * Saves the midstate of `digest` for upload `s` (atomically: a reader sees the old one or the new one).
 *
 * @throws DomainError `DISK_QUOTA` (P21) after discarding the upload
 */
async function saveDigest(h: DbHandle, s: Session, digest: IncrementalSha256, dataDir: string): Promise<void> {
  try {
    await writeBytesAtomic(midstateFile(dataDir, s.id), encodeSha256Midstate(digest.midstate()));
  } catch (error) {
    const quota = quotaError(error);
    if (quota === null) throw error;
    await discard(h, s.id, dataDir);
    throw quota;
  }
}

/**
 * Stores chunk `n` of upload `id` (see the top of this file), under the upload's lock, outside any transaction.
 *
 * @returns the bytes stored so far, and whether they are all of them
 * @throws DomainError `NOT_FOUND` (no such session of `owner`), `UPLOAD_EXPIRED` (410), `UPLOAD_CHUNK_INVALID` (409:
 *   `order` for a gap, `size` for a chunk of the wrong length or past the end), `DISK_QUOTA` (507: the upload is
 *   discarded), `TX_CONFLICT` (`upload_busy`: the upload's lock stayed busy, or was lost)
 */
export async function acceptChunk(
  h: DbHandle,
  o: { id: string; owner: string; n: number; data: Uint8Array; now: number; dataDir: string },
): Promise<{ received: number; complete: boolean }> {
  if (!Number.isSafeInteger(o.n) || o.n < 0) throw new RangeError(`acceptChunk: n must be an integer of at least 0, got ${String(o.n)}`);
  if (!isUlid(o.id)) throw notFound();
  return reportingDiskLow(h, o.now, () => acceptChunkLocked(h, o));
}

async function acceptChunkLocked(
  h: DbHandle,
  o: { id: string; owner: string; n: number; data: Uint8Array; now: number; dataDir: string },
): Promise<{ received: number; complete: boolean }> {
  return withUploadLock(h, o.id, async (lease) => {
    const s = await liveSession(h.db, o.id, o.owner, o.now);
    const start = o.n * s.chunkSize;
    if (start >= s.size) {
      throw chunkInvalid('size', `Potongan ${o.n} melewati akhir berkas / Chunk ${o.n} lies past the end of the file`);
    }
    if (start < s.received) return { received: s.received, complete: s.received === s.size }; // stored already
    if (start > s.received) {
      throw chunkInvalid(
        'order',
        `Potongan ${o.n} datang sebelum potongan sebelumnya; kirim mulai dari byte ${s.received} / ` +
          `Chunk ${o.n} came before the ones it follows; continue from byte ${s.received}`,
      );
    }
    const expected = Math.min(s.chunkSize, s.size - start);
    if (o.data.byteLength !== expected) {
      throw chunkInvalid(
        'size',
        `Potongan ${o.n} harus ${expected} byte, diterima ${o.data.byteLength} / Chunk ${o.n} must be ${expected} bytes, got ${o.data.byteLength}`,
      );
    }
    const digest = await digestAt(h, lease, s, start, o.dataDir);
    digest.update(o.data);
    await lease.renew(); // a holder that lost the lock never cuts the file
    await writeChunk(h, s, start, o.data, o.dataDir);
    await lease.renew();
    const received = start + expected;
    const moved = await withTx(h, (trx) =>
      trx.updateTable('upload_sessions').set({ received }).where('id', '=', s.id).where('received', '=', start).executeTakeFirst(),
    );
    if (Number(moved.numUpdatedRows) === 0) {
      // Moved meanwhile (by a request that took the lock over): report what the row says now.
      const now = await readSession(h.db, s.id, o.owner);
      if (now === null) throw notFound();
      return { received: now.received, complete: now.received === now.size };
    }
    // Saved only now that `received` covers it; dying before this leaves a midstate one chunk behind (caught up).
    lease.check();
    await saveDigest(h, s, digest, o.dataDir);
    return { received, complete: received === s.size };
  });
}

/** The first bytes of the staged file of upload `id` (at most MAGIC_HEAD_BYTES), for the magic-byte check. */
async function stagedHead(dataDir: string, id: string): Promise<Uint8Array> {
  const handle = await openRead(stagedFile(dataDir, id));
  try {
    const head = Buffer.alloc(MAGIC_HEAD_BYTES);
    let headBytes = 0;
    while (headBytes < MAGIC_HEAD_BYTES) {
      const { bytesRead } = await handle.read(head, headBytes, MAGIC_HEAD_BYTES - headBytes, headBytes);
      if (bytesRead === 0) break;
      headBytes += bytesRead;
    }
    return head.subarray(0, headBytes);
  } finally {
    await handle.close();
  }
}

/**
 * The staged file of upload `id`, read in pieces (each a fresh buffer: the consumer may keep them), checking the
 * lease before each.
 */
async function* stagedContent(dataDir: string, id: string, lease: UploadLease): AsyncIterable<Uint8Array> {
  const handle = await openRead(stagedFile(dataDir, id));
  try {
    for (let at = 0; ; ) {
      lease.check();
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, at);
      if (bytesRead === 0) return;
      at += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

/**
 * The staged image of upload `s` without its metadata (strip-metadata.ts), with its size and SHA-256.
 *
 * @throws DomainError `UPLOAD_TYPE_REFUSED` after discarding the upload when the image's structure does not hold;
 *   `UPLOAD_EXPIRED` when its staged bytes are gone; the lease's `TX_CONFLICT`
 */
async function strippedImage(
  h: DbHandle,
  lease: UploadLease,
  s: Session,
  context: UploadContext,
  kind: StrippableImage,
  dataDir: string,
): Promise<{ content: Uint8Array; size: number; sha256: string }> {
  lease.check();
  const raw = await readBytes(stagedFile(dataDir, s.id), s.size);
  if (raw === null) {
    await discard(h, s.id, dataDir);
    throw cleanedUp();
  }
  let content: Uint8Array;
  try {
    content = stripImageMetadata(raw, kind);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    await discard(h, s.id, dataDir);
    const allowed = context.magic === 'any' ? [] : [...context.magic];
    throw new DomainError('UPLOAD_TYPE_REFUSED', {
      detail:
        `Berkas ${kind} ini rusak atau tidak lengkap; simpan ulang gambarnya lalu unggah lagi / ` +
        `This ${kind} file is damaged or incomplete; save the image again and upload it once more`,
      meta: { kind, allowed },
      cause: error,
    });
  }
  return { content, size: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') };
}

// ---- Site identity ----
/**
 * The staged PNG of upload `s` as the server stores it for a `reencode` context: decoded and encoded again
 * (site-images.ts), with its size and SHA-256.
 *
 * @throws DomainError `UPLOAD_TYPE_REFUSED` after discarding the upload, with `meta.reason` `damaged` (not a PNG this
 *   server can decode), `interlaced`, `dimensions` (a side above `meta.maxSide`) or `too_small` (a side below
 *   `meta.minSide`); `UPLOAD_EXPIRED` when its staged bytes are gone; the lease's `TX_CONFLICT`
 */
async function reencodedImage(
  h: DbHandle,
  lease: UploadLease,
  s: Session,
  context: UploadContext,
  as: 'logo' | 'icon',
  dataDir: string,
): Promise<{ content: Uint8Array; size: number; sha256: string }> {
  lease.check();
  const raw = await readBytes(stagedFile(dataDir, s.id), s.size);
  if (raw === null) {
    await discard(h, s.id, dataDir);
    throw cleanedUp();
  }
  let content: Uint8Array;
  try {
    content = as === 'logo' ? storedSiteLogo(raw) : storedSiteIcon(raw);
  } catch (error) {
    if (!(error instanceof SiteImageError)) throw error;
    await discard(h, s.id, dataDir);
    const { min, max } = error.sides;
    const detail =
      error.reason === 'dimensions'
        ? `Gambar terlalu besar: paling banyak ${max} piksel per sisi / The image is too large: at most ${max} pixels a side`
        : error.reason === 'too_small'
          ? `Gambar terlalu kecil: paling sedikit ${min} piksel per sisi / The image is too small: at least ${min} pixels a side`
          : 'Berkas PNG ini rusak atau tidak dapat dibaca; simpan ulang sebagai PNG lalu unggah lagi / ' +
            'This PNG file is damaged or cannot be read; save it as PNG again and upload it once more';
    throw new DomainError('UPLOAD_TYPE_REFUSED', {
      detail,
      meta: { kind: 'png', allowed: context.magic === 'any' ? [] : [...context.magic], reason: error.reason, minSide: min, maxSide: max },
      cause: error,
    });
  }
  return { content, size: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') };
}

// ---- Komunitas (OPAC home page) ----
/**
 * The width and height of a JPEG `content`, read by the PDF pictures' header reader (the whole marker structure walked,
 * an RGB or grey 8-bit frame); null for another kind or a file that reader refuses.
 */
function jpegSize(content: Uint8Array | AsyncIterable<Uint8Array>, kind: string): { width: number; height: number } | null {
  if (kind !== 'jpeg' || !(content instanceof Uint8Array)) return null;
  try {
    const info = jpegInfo(content);
    return { width: info.width, height: info.height };
  } catch {
    return null;
  }
}

/**
 * Refuses (after discarding the upload) an image of `context` whose width or height lies outside its `imageSides`, or
 * whose size cannot be read from `content` (a JPEG only).
 *
 * @throws DomainError `UPLOAD_TYPE_REFUSED` with `meta.reason` `dimensions`
 */
async function checkImageSides(
  h: DbHandle,
  id: string,
  context: UploadContext,
  kind: string,
  content: Uint8Array | AsyncIterable<Uint8Array>,
  dataDir: string,
): Promise<void> {
  const sides = context.imageSides;
  if (sides === undefined) return;
  const size = jpegSize(content, kind);
  if (size !== null && Math.min(size.width, size.height) >= sides.min && Math.max(size.width, size.height) <= sides.max) return;
  await discard(h, id, dataDir);
  throw new DomainError('UPLOAD_TYPE_REFUSED', {
    detail:
      `Ukuran gambar harus ${sides.min}-${sides.max} piksel per sisi / ` + `The image must be ${sides.min}-${sides.max} pixels a side`,
    meta: { kind, allowed: context.magic === 'any' ? [] : [...context.magic], reason: 'dimensions' },
  });
}

/** The `.complete` marker of upload `id`, or null when it is missing or unreadable. */
async function readMarker(dataDir: string, id: string): Promise<CompleteMarker | null> {
  let raw: Buffer | null;
  try {
    raw = await readBytes(markerFile(dataDir, id), MARKER_MAX_BYTES);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const m = JSON.parse(raw.toString('utf8')) as Partial<CompleteMarker>;
    if (typeof m.size !== 'number' || typeof m.sha256 !== 'string' || typeof m.mime !== 'string') return null;
    return {
      size: m.size,
      sha256: m.sha256,
      mime: m.mime,
      originalName: typeof m.originalName === 'string' ? m.originalName : null,
      completedAt: typeof m.completedAt === 'number' ? m.completedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Completes upload `id` (decision C7), under the upload's lock, outside any transaction: every byte must have arrived,
 * the staged file must have the declared size and the bytes received the declared SHA-256 (else the upload is
 * discarded: UPLOAD_MISMATCH), and its magic bytes must suit the context (else discarded: UPLOAD_TYPE_REFUSED). The
 * digest is the one kept while the chunks arrived (R1c-4): only the file's size and head are read here. Then:
 * - `staged` context: a `.complete` marker is written next to the file, which stays for its consumer; completing
 *   again answers from the marker;
 * - `file` context: the file is stored through the local StorageDriver under the upload's id (`uploadPath(id)`), a
 *   `files` row (`status 'ok'`, `access 'staff'`) is inserted and the session deleted in one transaction, and the
 *   staging folder removed. Completing again (the answer was lost) finds the `files` row the owner made from it.
 *
 * `originalName` (at most 191 characters) is kept as given; it is sanitized when the file is served.
 *
 * @throws DomainError `NOT_FOUND`, `UPLOAD_EXPIRED`, `UPLOAD_INCOMPLETE` (409), `UPLOAD_MISMATCH` (422, `size` or
 *   `sha256`), `UPLOAD_TYPE_REFUSED` (415), `DISK_QUOTA`, `TX_CONFLICT`
 */
export async function completeUpload(
  h: DbHandle,
  o: { id: string; owner: string; originalName?: string; now: number; dataDir: string },
): Promise<StagedUpload | { fileId: string }> {
  if (!isUlid(o.id)) throw notFound();
  return reportingDiskLow(h, o.now, () => completeUploadLocked(h, o));
}

async function completeUploadLocked(
  h: DbHandle,
  o: { id: string; owner: string; originalName?: string; now: number; dataDir: string },
): Promise<StagedUpload | { fileId: string }> {
  const staffId = ownerStaffId(o.owner);
  return withUploadLock(h, o.id, async (lease) => {
    const s = await readSession(h.db, o.id, o.owner);
    if (s === null) {
      const made = await h.db.selectFrom('files').select('id').where('id', '=', o.id).where('created_by', '=', staffId).executeTakeFirst();
      if (made !== undefined) return { fileId: made.id };
      throw notFound();
    }
    if (o.now >= s.expiresAt) throw expired();
    const context = uploadContext(s.context);
    if (context === null) throw notFound(); // a context of another build profile
    if (s.received !== s.size) {
      throw new DomainError('UPLOAD_INCOMPLETE', {
        detail: `Baru ${s.received} dari ${s.size} byte yang diterima / Only ${s.received} of ${s.size} bytes have arrived`,
      });
    }
    if (context.kind === 'staged') {
      const marker = await readMarker(o.dataDir, s.id);
      if (marker !== null && marker.size === s.size && marker.sha256 === s.sha256) {
        return { uploadId: s.id, size: s.size, sha256: s.sha256, mime: marker.mime };
      }
    }

    const staged = await statOrNull(stagedFile(o.dataDir, s.id));
    if (staged === null || staged.kind !== 'file' || staged.size !== s.size) {
      await discard(h, s.id, o.dataDir);
      throw mismatch('size');
    }
    if ((await digestAt(h, lease, s, s.size, o.dataDir)).digestHex() !== s.sha256) {
      await discard(h, s.id, o.dataDir);
      throw mismatch('sha256');
    }
    const type = detectType(await stagedHead(o.dataDir, s.id));
    // Phase 2 (Task 2): the context names the set of kinds it takes.
    if (context.magic !== 'any' && !context.magic.includes(type.kind)) {
      await discard(h, s.id, o.dataDir);
      const allowed = context.magic.join(', ');
      throw new DomainError('UPLOAD_TYPE_REFUSED', {
        detail:
          `Unggahan ${context.name} harus berupa berkas ${allowed}, bukan ${type.kind} / ` +
          `A ${context.name} upload must be ${allowed}, not ${type.kind}`,
        meta: { kind: type.kind, allowed: [...context.magic] },
      });
    }

    if (context.kind === 'staged') {
      const marker: CompleteMarker = { size: s.size, sha256: s.sha256, mime: type.mime, originalName: o.originalName ?? null, completedAt: o.now };
      await lease.renew();
      await writeBytesAtomic(markerFile(o.dataDir, s.id), JSON.stringify(marker));
      return { uploadId: s.id, size: s.size, sha256: s.sha256, mime: type.mime };
    }

    // The driver copies the bytes as they are read and checks their hash once more; an image published as uploaded is
    // stripped of its metadata first (small: 5 MiB at most), and stored with the size and digest of what is left.
    // Site identity: a logo or icon is not stripped but decoded and stored again as the server's own PNG.
    const stored = context.reencode !== undefined
      ? await reencodedImage(h, lease, s, context, context.reencode, o.dataDir)
      : STRIPPED_CONTEXTS.has(context.name) && STRIPPABLE.has(type.kind)
        ? await strippedImage(h, lease, s, context, type.kind as StrippableImage, o.dataDir)
        : { content: stagedContent(o.dataDir, s.id, lease), size: s.size, sha256: s.sha256 };
    // ---- Komunitas (OPAC home page) ----
    // A context that bounds its images' dimensions reads them from the stripped bytes (held in memory).
    if (context.imageSides !== undefined) await checkImageSides(h, s.id, context, type.kind, stored.content, o.dataDir);
    await localStorageDriver(o.dataDir).put(s.id, stored.content, { size: stored.size, sha256: stored.sha256 });
    await lease.renew();
    await withTx(h, async (trx) => {
      await trx
        .insertInto('files')
        .values({
          id: s.id,
          original_name: o.originalName ?? DEFAULT_NAMES[type.kind],
          mime: type.mime,
          size: stored.size,
          sha256: stored.sha256,
          context: context.name,
          owner_type: null,
          owner_id: null,
          access: 'staff',
          status: 'ok',
          created_at: o.now,
          created_by: staffId,
        })
        .execute();
      await trx.deleteFrom('upload_sessions').where('id', '=', s.id).execute();
    });
    await removeTree(stagingDir(o.dataDir, s.id)).catch(() => undefined); // left over: the 24 h staging cleanup
    return { fileId: s.id };
  });
}

/**
 * 1d (preflight B5): the checks of {@link takeStagedUpload} without taking the upload: the completed staged upload
 * `uploadId` of `owner` in `context`, its session row left in place. `POST updates/upload` reads the package's manifest
 * through it (its dry run, and the real call that begins the op), and only the update op's `checking` step takes the
 * upload, so a dry run followed by the real call with the same upload works. `db` may be a transaction or the handle's
 * database: it only reads.
 *
 * @returns the staged file (where it is: nothing is moved), its size and the SHA-256 of the bytes received
 * @throws DomainError `NOT_FOUND` (no such session of `owner` in `context`, or taken already), `UPLOAD_INCOMPLETE`
 *   (not completed)
 */
export async function stagedUploadFile(
  db: Db,
  o: { uploadId: string; owner: string; context: UploadContextName; dataDir: string },
): Promise<{ path: DataPath; size: number; sha256: string }> {
  if (!isUlid(o.uploadId)) throw notFound();
  const s = await readSession(db, o.uploadId, o.owner);
  if (s === null || s.context !== o.context) throw notFound();
  const marker = await readMarker(o.dataDir, s.id);
  if (marker === null || marker.size !== s.size || marker.sha256 !== s.sha256) {
    throw new DomainError('UPLOAD_INCOMPLETE', {
      detail: 'Unggahan belum diselesaikan (complete) / The upload has not been completed',
    });
  }
  return { path: stagedFile(o.dataDir, s.id), size: s.size, sha256: s.sha256 };
}

/**
 * The consumer's step (`POST backups/upload`, 1d's update upload), in the consumer's transaction `trx`: takes the
 * completed staged upload `uploadId` of `owner` in `context`, deleting its session row in `trx`, and hands over its
 * file, which stays where it is for the consumer to move (after COMMIT). It only reads the `.complete` marker.
 *
 * @returns the staged file, its size and the SHA-256 of the bytes received, as completion verified them (R1c-4: the
 *   digest of the chunks as they arrived, not of the file as stored; a consumer that needs that hashes it as it reads)
 * @throws DomainError `NOT_FOUND` (no such session of `owner` in `context`, or taken already), `UPLOAD_INCOMPLETE`
 *   (not completed)
 */
export async function takeStagedUpload(
  trx: Transaction<DB>,
  o: { uploadId: string; owner: string; context: UploadContextName; dataDir: string },
): Promise<{ path: DataPath; size: number; sha256: string }> {
  const staged = await stagedUploadFile(trx, o);
  const taken = await trx.deleteFrom('upload_sessions').where('id', '=', o.uploadId).where('owner', '=', o.owner).executeTakeFirst();
  if (Number(taken.numDeletedRows) === 0) throw notFound(); // taken by a concurrent request
  return staged;
}

/**
 * Cancels upload `id` of `owner`: its session row and its staging folder are deleted (under the upload's lock, so no
 * chunk in progress recreates the folder afterwards).
 *
 * @throws DomainError `NOT_FOUND`, `TX_CONFLICT`
 */
export async function abortUpload(h: DbHandle, o: { id: string; owner: string; dataDir: string }): Promise<void> {
  if (!isUlid(o.id)) throw notFound();
  await withUploadLock(h, o.id, async () => {
    const gone = await withTx(h, (trx) =>
      trx.deleteFrom('upload_sessions').where('id', '=', o.id).where('owner', '=', o.owner).executeTakeFirst(),
    );
    if (Number(gone.numDeletedRows) === 0) throw notFound();
    await removeTree(stagingDir(o.dataDir, o.id));
  });
}
