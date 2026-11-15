import type { UploadChunkResponse, UploadCompleteResponse, UploadContextName, UploadCreateResponse } from '@altis/shared/api/files';
import type { MeClient } from '@altis/shared/api/auth';
import { ApiError, api, clientHints, type ApiOptions } from './api';
import { sha256Hex } from './sha256';

/**
 * The admin's chunked upload (1c Task 16; spec §5 P10, §7.5; decision C7): a backup archive to restore, an update
 * package. Shared hosts limit request bodies (ModSecurity, Imunify360, a proxy's `client_max_body_size`), so a file
 * goes up in chunks whose size adapts to what the host lets through:
 *
 * 1. the file's SHA-256 (lib/sha256.ts, 4 MiB slices: a backup may be 20 GiB);
 * 2. `POST files/uploads` {context, size, sha256, chunkBytes}: `chunkBytes` = the size that passed last time on this
 *    browser (`localStorage['altis.chunk-bytes']`), else `auth/me`'s `client.chunkBytes` (the largest chunk the
 *    browser test of Diagnostik saw pass), else 5 MiB; the server fixes the session's `chunkSize` (256 KiB-5 MiB).
 *    The size this browser learned is kept with the `probedAt` of the browser test it was learned under
 *    (`localStorage['altis.chunk-bytes-probed-at']`, absent for none) and yields to `client.chunkBytes` once a newer
 *    test has run: one WAF refusal of a chunk's content, or a host limit raised since, does not hold forever. Both
 *    times are the server's (`system.probe.at`), so the browser's clock plays no part;
 * 3. the chunks in order, `POST files/uploads/:id/chunks/:n` as multipart/form-data (field `chunk`). A 413, or a 403
 *    that is not the server's problem+json (a WAF's page), means the chunk was too large for the host: the session is
 *    deleted (`DELETE files/uploads/:id`; a host may hold three at most) and a new one starts with half the chunk,
 *    never below 256 KiB. The chunk size of a session whose first full chunk passed is kept in localStorage;
 * 4. `POST files/uploads/:id/complete`: the server compares the digest it built from the chunks (ruling R1c-4).
 *
 * Every call goes through lib/api.ts (CSRF token, reauth, method override for the DELETE behind a WAF). A network
 * failure (fetch's TypeError) is retried 3 times, after 1, 2 and 4 s; the declaration under the same
 * `Idempotency-Key`, so a lost answer never costs a second session. A chunk, a completion or a cancel that meets
 * 409 TX_CONFLICT `upload_busy` (another request of the same upload holds its lock, or a completion is still
 * running) is sent again after 1, 2, 4, 8 and 16 s. Sending a stored chunk again is harmless (C7: a no-op), and so
 * is completing a completed upload.
 *
 * When the upload fails or `signal` aborts it, its session is deleted on the way out (one try, errors ignored), so it
 * does not hold one of the three slots for 24 hours.
 */

/** The largest chunk (the server's maximum and default). */
export const CHUNK_MAX_BYTES = 5 * 1024 * 1024;
/** The smallest chunk a host's limit can push the client down to (P10: 256 KB). */
export const CHUNK_MIN_BYTES = 256 * 1024;
/** Where the chunk size that passed on this host is kept (per browser: the host's limits outlive a tab). */
export const CHUNK_BYTES_KEY = 'altis.chunk-bytes';
/** The `probedAt` of the browser test under which {@link CHUNK_BYTES_KEY} was learned (absent: none had run). */
export const CHUNK_PROBED_AT_KEY = 'altis.chunk-bytes-probed-at';

/** The waits before each retry of a network failure. */
const NETWORK_RETRY_MS: readonly number[] = [1000, 2000, 4000];
/** The waits before each retry of a busy upload (409 TX_CONFLICT `upload_busy`) or a declaration still in progress. */
const BUSY_RETRY_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];
/** `complete`'s `originalName`: 1-191 characters (the server's limit), else left out. */
const NAME_MAX = 191;

export interface UploadOptions {
  /** What the file is for: an archive to restore (`backup`), an update package (`update`), or a catalog context. */
  context: UploadContextName;
  /** After each chunk the server accepted: the bytes sent so far and the file's size. */
  onProgress?(sent: number, total: number): void;
  /** While the file is hashed (before anything is sent): the bytes hashed so far and the file's size. */
  onHashProgress?(hashed: number, total: number): void;
  /** Stops the upload (hashing, waiting or sending); it rejects with the signal's reason. */
  signal?: AbortSignal;
  /** The branch the file is for, when the context's permission is a branch permission (a stocktake code list). */
  branchId?: string;
}

/** A stored chunk size, and a stored `probedAt` (epoch ms). */
const STORED_BYTES = /^[1-9]\d{0,9}$/;
const STORED_MS = /^[1-9]\d{0,15}$/;

/**
 * The chunk size kept for this host and the `probedAt` it was learned under (null: none), or null (none, unreadable,
 * or storage blocked).
 */
function storedChunkBytes(): { bytes: number; probedAt: number | null } | null {
  try {
    const bytes = localStorage.getItem(CHUNK_BYTES_KEY);
    if (bytes === null || !STORED_BYTES.test(bytes)) return null;
    const probedAt = localStorage.getItem(CHUNK_PROBED_AT_KEY);
    return { bytes: Number(bytes), probedAt: probedAt !== null && STORED_MS.test(probedAt) ? Number(probedAt) : null };
  } catch {
    return null;
  }
}

function storeChunkBytes(bytes: number, probedAt: number | null): void {
  try {
    localStorage.setItem(CHUNK_BYTES_KEY, String(bytes));
    if (probedAt === null) localStorage.removeItem(CHUNK_PROBED_AT_KEY);
    else localStorage.setItem(CHUNK_PROBED_AT_KEY, String(probedAt));
  } catch {
    // Storage blocked: the next upload starts from auth/me's hint again.
  }
}

const clampChunk = (bytes: number): number => Math.min(CHUNK_MAX_BYTES, Math.max(CHUNK_MIN_BYTES, Math.floor(bytes)));

/**
 * The chunk size an upload starts with: the one this browser learned, unless `auth/me` reports a browser test newer
 * than the one it was learned under; else the test's `chunkBytes`; else 5 MiB.
 */
function startChunkBytes(hints: Pick<MeClient, 'chunkBytes' | 'probedAt'> | null): number {
  const stored = storedChunkBytes();
  const probedAt = hints?.probedAt ?? null;
  if (stored !== null) {
    const newerTest = probedAt !== null && (stored.probedAt === null || probedAt > stored.probedAt);
    if (!newerTest) return clampChunk(stored.bytes);
  }
  return clampChunk(hints?.chunkBytes ?? CHUNK_MAX_BYTES);
}

/** A fresh `Idempotency-Key` for one declaration (and its retries). */
function idempotencyKey(): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return `upload-${Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Another request holds the upload (or the declaration under this key) right now: worth sending again shortly. */
const isBusy = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status === 409 &&
  ((error.code === 'TX_CONFLICT' && error.reason === 'upload_busy') || error.code === 'IDEMPOTENCY_IN_PROGRESS');

/** The host refused the chunk for its size: 413, or a 403 page that is not the server's own answer (a WAF). */
const isTooLarge = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 413 || (error.status === 403 && !error.problemJson));

/** `send()` with the retries of a network failure and, with `busy`, of a busy upload (see the top of this file). */
async function retrying<T>(send: () => Promise<T>, signal: AbortSignal | undefined, o: { busy: boolean }): Promise<T> {
  let network = 0;
  let busy = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await send();
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      if (error instanceof TypeError && network < NETWORK_RETRY_MS.length) {
        await wait(NETWORK_RETRY_MS[network++]!, signal);
      } else if (o.busy && isBusy(error) && busy < BUSY_RETRY_MS.length) {
        await wait(BUSY_RETRY_MS[busy++]!, signal);
      } else {
        throw error;
      }
    }
  }
}

/** Deletes the session `id` before starting again with smaller chunks; a session already gone is fine. */
async function cancel(id: string, signal: AbortSignal | undefined): Promise<void> {
  try {
    await retrying(() => api<void>('DELETE', `files/uploads/${id}`, undefined, signal === undefined ? {} : { signal }), signal, { busy: true });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 410)) return;
    throw error;
  }
}

/** Deletes the session `id` of a failed or aborted upload: one try, whatever the signal, errors ignored. */
async function dropQuietly(id: string): Promise<void> {
  try {
    await api<void>('DELETE', `files/uploads/${id}`);
  } catch {
    // It expires on its own after 24 hours.
  }
}

/** Sends every chunk of `session` in order (see the top of this file); `probedAt` goes with a chunk size that passed. */
async function sendChunks(
  file: Blob,
  session: UploadCreateResponse,
  o: UploadOptions,
  request: ApiOptions,
  probedAt: number | null,
): Promise<void> {
  for (let n = 0; n < session.chunks; n += 1) {
    o.signal?.throwIfAborted();
    const start = n * session.chunkSize;
    const end = Math.min(start + session.chunkSize, file.size);
    const form = new FormData();
    form.append('chunk', file.slice(start, end), 'chunk');
    await retrying(() => api<UploadChunkResponse>('POST', `files/uploads/${session.id}/chunks/${n}`, form, request), o.signal, { busy: true });
    // A whole chunk of this size passed the host: the next upload starts here. (A file smaller than one chunk proves
    // nothing about the chunk size.)
    if (n === 0 && end - start === session.chunkSize) storeChunkBytes(session.chunkSize, probedAt);
    o.onProgress?.(end, file.size);
  }
}

/**
 * Uploads `file` for `o.context` and resolves to the upload's id, which the consuming route takes (`backups/upload`,
 * the update routes). See the top of this file for the steps, the chunk size and the retries.
 *
 * @throws ApiError the server's (or a host's) answer that no retry got past: a 413 at 256 KiB, UPLOAD_LIMIT, ...
 * @throws TypeError a network failure that outlasted its retries
 * @throws the signal's reason once it aborts
 */
export async function uploadFile(file: Blob, o: UploadOptions): Promise<{ uploadId: string }> {
  const { signal } = o;
  const request: ApiOptions = signal === undefined ? {} : { signal };
  const size = file.size;
  const sha256 = await sha256Hex(file, o.onHashProgress, signal);
  const name = typeof File !== 'undefined' && file instanceof File ? file.name : '';
  const complete = name.length >= 1 && name.length <= NAME_MAX ? { originalName: name } : {};
  const hints = clientHints();
  let chunkBytes = startChunkBytes(hints);

  for (;;) {
    const key = idempotencyKey();
    const declared = { context: o.context, size, sha256, chunkBytes, ...(o.branchId === undefined ? {} : { branchId: o.branchId }) };
    const session = await retrying(
      () => api<UploadCreateResponse>('POST', 'files/uploads', declared, { ...request, idempotencyKey: key }),
      signal,
      { busy: true },
    );
    try {
      await sendChunks(file, session, o, request, hints?.probedAt ?? null);
    } catch (error) {
      const half = Math.max(CHUNK_MIN_BYTES, Math.floor(session.chunkSize / 2));
      if (isTooLarge(error) && half < session.chunkSize && signal?.aborted !== true) {
        await cancel(session.id, signal);
        chunkBytes = half;
        continue;
      }
      await dropQuietly(session.id);
      throw error;
    }
    try {
      const done = await retrying(
        () => api<UploadCompleteResponse>('POST', `files/uploads/${session.id}/complete`, complete, request),
        signal,
        { busy: true },
      );
      return { uploadId: 'uploadId' in done ? done.uploadId : session.id };
    } catch (error) {
      await dropQuietly(session.id);
      throw error;
    }
  }
}
