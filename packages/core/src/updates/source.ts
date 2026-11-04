import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { KeysetDoc, KeysetSource, TrustedKey } from '@altis/crypto';
import { floorHolds, verifyFeed, type FeedChannel, type FeedEntry, type VerifiedFeed } from '@altis/crypto/feed';
import {
  faultArmed,
  isReleaseStagingName,
  openAppend,
  openRead,
  readBytes,
  releaseStagingPath,
  removeFile,
  statOrNull,
  writeBytesAtomic,
  type DataPath,
  type Env,
} from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { errorFields, type CoreLogger } from '../context.js';
import { raiseFeedSeq, readFeedState } from './feed-state.js';
import { FETCH_MAX_BYTES, fetchRange, fetchText } from './https.js';

// The feed client: UpdateSource of spec §13.8 (§9.6; plan Task 20; decision D1d-29; preflight 1D-12, 1D-18).
//
// fetchFeed(channel) GETs `<feedBase>/<channel>/feed.json`, `feed.sig` and `freshness.json` over node:https (P18,
// https.ts) and verifies them with verifyFeed (@altis/crypto/feed) against the embedded roots and the root-signed
// keyset documents the installation holds (`sources()`), with the highest seq accepted on that channel
// (feed-state.json) as the floor. Only then does it act on what the feed says, in this order: the feed's keyset
// documents are persisted (the keyset store, Task 10: a revocation the feed brings keeps applying after the feed drops
// it, Review Focus 3), the channel's seq is raised, and the freshness `issuedAt` is reported as signed time when an
// `onSignedTime` is given (the edition's observeSignedTime: within tolerance it clears a clock anomaly, spec §10.4). A
// failure of either of the first two fails the fetch: the feed was good, but the installation could not keep what it
// learned. A failure of the last is logged.
//
// feedConfigured() says whether a feed base is set at all. Without one (a build without `--feed-url` and none set in
// config.json or the environment) online checks are off: fetchFeed refuses with `FEED_UNREACHABLE` `no_feed_url`, the
// update check stores nothing for it (check-job.ts), and updates come by upload.
//
// download(entry, dest, …) fetches a package into the update's staging folder, `releases/.tmp-<v>-<opId>/package.zip`
// (D1d-16), in slices (P9: `deadline`) that resume where the last one stopped (§9.6 "berpotongan dan bisa
// dilanjutkan"):
// - the sibling `download.json` names the package the partial file belongs to (`{url, sha256}`). It is written before
//   the first byte; a partial file under another name, or under none, is dropped and the download starts at 0. So a
//   process killed at any point (P7) leaves a partial file the next call either resumes or drops, never mixes;
// - a partial file is resumed with `Range: bytes=<size>-`; a server that answers 200 instead sends the whole file,
//   which is then written from byte 0 again;
// - the bytes are refused (`UPDATE_PACKAGE_INVALID` reason `size`, the file removed) as soon as they would pass
//   `entry.size`, or when the server announces another size, so a misbehaving mirror cannot keep filling DATA_DIR
//   (1D-18). A whole file of another SHA-256 is refused (`hash`, removed);
// - it stops at the deadline with `complete: false` (the bytes so far fsynced and kept). A connection cut short is
//   UPDATE_DOWNLOAD_FAILED `network` with the bytes so far kept, which the caller retries (Task 24: 5 tries);
// - one download per `dest` at a time: the update op steps under `ops/step.lock` (1c), the only caller.
// Test faults: `download-corrupt[:<byte offset>]` flips that byte (0 by default) on its way into the hash;
// `disk-full:releases:<n>` hits the data-files helpers (download.json, the package's open).

/** The three files of a channel (§9.6). */
const FEED_FILE = 'feed.json';
const SIG_FILE = 'feed.sig';
const FRESHNESS_FILE = 'freshness.json';
/**
 * fetchFeed's bound for its three requests, made side by side: the feed check runs in a job slice (P9: <= 20 s) and in
 * `POST updates/check` (a request), so it stays below either.
 */
export const FEED_FETCH_TIMEOUT_MS = 15_000;
/** feed.sig and freshness.json are one small signed document each. */
const SMALL_FILE_MAX_BYTES = 64 * 1024;
/** download.json is `{url, sha256}`: a URL of at most 2048 characters (R1d-2) and a digest. */
const DOWNLOAD_STATE_MAX_BYTES = 16 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The feed client of spec §13.8 (§9.6). */
export interface UpdateSource {
  /**
   * The verified feed of `channel` (see the top of this file).
   *
   * @throws DomainError `FEED_UNREACHABLE` (`meta.reason` `no_feed_url` without a feed base, else as fetchText),
   *   `FEED_INVALID` (`meta.reason` as verifyFeed: `signature`, `hash`, `freshness`, `expired`, `seq`, `channel`,
   *   `shape`), `STATE_CORRUPT` (feed-state.json or the keyset store unusable, or their lock), `DISK_QUOTA`
   */
  fetchFeed(channel: FeedChannel): Promise<VerifiedFeed>;
  /**
   * Whether a feed base is set (see the top of this file): false for none or an empty one. A feed base that cannot be
   * read counts as set (fetchFeed then says why), so no caller fails here.
   */
  feedConfigured(): boolean;
  /**
   * Downloads `entry`'s package to `dest` (`releaseStagingPath(dataDir, v, opId, 'package.zip')`), resuming a partial
   * file, until it is whole or `o.deadline` (epoch ms on the source's clock) passes; `onProgress(bytes, entry.size)`
   * after each piece. Extends §13.8's `Promise<void>` additively (D1d-29): `complete` true once the file is whole and
   * verified (size and SHA-256), `bytes` its size now.
   *
   * @throws DomainError `UPDATE_PACKAGE_INVALID` (`meta.reason` `size` or `hash`; `dest` removed),
   *   `UPDATE_DOWNLOAD_FAILED` (`meta.reason` `network`, `timeout`, `status`, `insecure`; the bytes so far kept),
   *   `DISK_QUOTA`
   * @throws TypeError for a `dest` that is not this DATA_DIR's staging `package.zip`, or an entry without a whole
   *   `size` or a hex `sha256`
   */
  download(entry: FeedEntry, dest: DataPath, onProgress: (bytes: number, total: number) => void, o?: { deadline?: number }): Promise<DownloadResult>;
}

export interface DownloadResult {
  /** The file is whole and matches the entry's size and SHA-256. */
  complete: boolean;
  /** The size of the file now. */
  bytes: number;
}

export interface UpdateSourceOptions {
  /** The feed base (`feedBaseOf`: ALTIS_UPDATE_FEED_URL, config.json `update.feedUrl`, the build's), or null for none. */
  feedBase(): string | null;
  dataDir: string;
  /** The embedded root keys (`__TRUSTED_KEYS__`). */
  roots: readonly TrustedKey[];
  /** The root-signed keyset documents the installation holds (DATA_DIR/releases/keyset.json, its releases'). */
  sources(): Promise<KeysetSource[]>;
  /** Production builds: documents that trust a `dev-` kid count for nothing (R65b). */
  refuseDevKids: boolean;
  /** Test builds: plain http to 127.0.0.1, ::1 and localhost (feed-dev); ignored by a production build (https.ts). */
  allowLoopbackHttp: boolean;
  /** Epoch ms: freshness expiry, feed-state's `at`, download deadlines. */
  clock(): number;
  log: CoreLogger;
  /** Stores the feed's keyset documents (the keyset store's persistKeysetDocs, Task 10). */
  persistKeysets(docs: readonly KeysetDoc[]): Promise<void>;
  /** A signed time: the freshness document's `issuedAt` (EditionService.observeSignedTime); not reported without one. */
  onSignedTime?(t: { at: number; source: 'feed' }): Promise<void>;
  /** The environment the test faults are read from (`ALTIS_TEST_FAULT`, test builds only). */
  env: Env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkChannel(channel: unknown): asserts channel is FeedChannel {
  if (channel !== 'stable' && channel !== 'beta') throw new TypeError('fetchFeed: channel must be stable or beta');
}

function feedInvalid(reason: string, cause?: unknown): DomainError {
  return new DomainError('FEED_INVALID', {
    detail: `Feed pembaruan ditolak (${reason}) / The update feed was refused (${reason})`,
    meta: { reason },
    cause,
  });
}

/** verifyFeed's `Error('FEED_INVALID:<reason>')` as the DomainError; any other error as it is. */
function feedInvalidOf(error: unknown): unknown {
  if (!(error instanceof Error) || !error.message.startsWith('FEED_INVALID:')) return error;
  return feedInvalid(error.message.slice('FEED_INVALID:'.length), error);
}

function packageInvalid(reason: 'size' | 'hash', detail: string): DomainError {
  return new DomainError('UPDATE_PACKAGE_INVALID', { detail, meta: { reason } });
}

function sizeRefused(entry: FeedEntry): DomainError {
  return packageInvalid(
    'size',
    `Paket ${entry.version} tidak berukuran ${entry.size} byte seperti kata feed; berkasnya dihapus / ` +
      `The ${entry.version} package is not the ${entry.size} bytes the feed names; the file was removed`,
  );
}

/** ENOSPC/EDQUOT of a write to the package: DISK_QUOTA (P21); any other error as it is. */
function quotaOf(error: unknown): unknown {
  const code = isRecord(error) ? error['code'] : undefined;
  if (code !== 'ENOSPC' && code !== 'EDQUOT') return error;
  return new DomainError('DISK_QUOTA', {
    detail: `Ruang disk atau kuota hosting habis saat mengunduh paket (${code}) / The disk or hosting quota is full while downloading the package (${code})`,
    meta: { code },
    cause: error,
  });
}

/**
 * The resume state of `dest`: `download.json` beside it. `dest` must be `releases/.tmp-<v>-<opId>/package.zip` of
 * `dataDir` (releaseStagingPath), so the state's path comes from the same typed builder.
 */
function downloadStatePath(dataDir: string, dest: DataPath): DataPath {
  const text = typeof dest === 'string' ? dest : '';
  const parts = text.split(/[\\/]/);
  const staging = parts.length >= 2 && parts[parts.length - 1] === 'package.zip' ? isReleaseStagingName(parts[parts.length - 2] as string) : null;
  if (staging === null || releaseStagingPath(dataDir, staging.version, staging.opId, 'package.zip') !== text) {
    throw new TypeError('download: dest must be releases/.tmp-<version>-<opId>/package.zip of this DATA_DIR (releaseStagingPath)');
  }
  return releaseStagingPath(dataDir, staging.version, staging.opId, 'download.json');
}

/** The `{url, sha256}` download.json holds, or null when it is missing or not that. */
async function readDownloadState(p: DataPath): Promise<{ url: string; sha256: string } | null> {
  let bytes: Buffer | null;
  try {
    bytes = await readBytes(p, DOWNLOAD_STATE_MAX_BYTES);
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null; // too large, or not a file: not ours
    throw error;
  }
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (isRecord(value) && typeof value['url'] === 'string' && typeof value['sha256'] === 'string') return { url: value['url'], sha256: value['sha256'] };
  } catch {
    // a torn or foreign file: the partial package is not trusted
  }
  return null;
}

/** The byte `download-corrupt[:<offset>]` flips on its way into the hash (test builds), or null. */
function corruptOffset(env: Env, size: number): number | null {
  const arg = faultArmed(env, 'download-corrupt');
  if (arg === null || size === 0) return null;
  const offset = /^\d{1,15}$/.test(arg) ? Number(arg) : 0;
  return Math.min(offset, size - 1);
}

/** The SHA-256 (hex) of `p`'s bytes, with the byte at `flip` inverted when it is not null; and how many bytes it read. */
async function hashFile(p: DataPath, flip: number | null): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  const handle = await openRead(p);
  try {
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const piece = buffer.subarray(0, bytesRead);
      if (flip !== null && flip >= position && flip < position + bytesRead) {
        const index = flip - position;
        piece[index] = (piece[index] as number) ^ 0xff;
      }
      hash.update(piece);
      position += bytesRead;
    }
    return { sha256: hash.digest('hex'), bytes: position };
  } finally {
    await handle.close();
  }
}

/** Writes all of `bytes` at the end of the append-mode `handle`. */
async function appendAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    offset += bytesWritten;
  }
}

/** The UpdateSource of spec §13.8 over `o` (see the top of this file). */
export function createUpdateSource(o: UpdateSourceOptions): UpdateSource {
  async function fetchFeed(channel: FeedChannel): Promise<VerifiedFeed> {
    checkChannel(channel);
    const base = o.feedBase();
    if (base === null || base === '') {
      throw new DomainError('FEED_UNREACHABLE', {
        detail: 'Alamat feed pembaruan belum diatur / No update feed URL is set',
        meta: { reason: 'no_feed_url' },
      });
    }
    const root = base.replace(/\/+$/, '');
    const get = (name: string, maxBytes: number): Promise<string> =>
      fetchText(`${root}/${channel}/${name}`, { timeoutMs: FEED_FETCH_TIMEOUT_MS, maxBytes, allowLoopbackHttp: o.allowLoopbackHttp });
    // Side by side, each within the same bound; every request settles before the first failure is thrown.
    const settled = await Promise.allSettled([get(FEED_FILE, FETCH_MAX_BYTES), get(SIG_FILE, SMALL_FILE_MAX_BYTES), get(FRESHNESS_FILE, SMALL_FILE_MAX_BYTES)]);
    const texts: string[] = [];
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason;
      texts.push(result.value);
    }
    const [feedText, sigText, freshnessText] = texts as [string, string, string];

    const seen = await readFeedState(o.dataDir, channel);
    const sources = await o.sources();
    const now = o.clock();
    let feed: VerifiedFeed;
    try {
      feed = verifyFeed({
        feedText,
        sigText,
        freshnessText,
        channel,
        roots: o.roots,
        sources,
        refuseDevKids: o.refuseDevKids,
        now,
        minSeq: seen === null ? 0 : seen.seq,
        minSeqKid: seen?.kid ?? null,
      });
    } catch (error) {
      throw feedInvalidOf(error);
    }

    if (feed.keyset.length > 0) await o.persistKeysets(feed.keyset);
    // The floor records the timestamp key that set it: one a root-signed document has since revoked holds no more (1d
    // review C02).
    const holds = (kid: string | undefined): boolean => floorHolds(feed.trusted, kid);
    await raiseFeedSeq(o.dataDir, channel, feed.seq, now, { kid: feed.timestampKid, trusted: holds });
    // Another process may have accepted a later feed of this channel while this one was fetched and verified (P6):
    // this feed is then older than one already seen, and refused like any lower seq. A seq is never lowered, so the
    // file read after the raise settles it.
    const kept = await readFeedState(o.dataDir, channel);
    if (kept !== null && kept.seq > feed.seq && holds(kept.kid)) throw feedInvalid('seq');
    if (o.onSignedTime !== undefined) {
      try {
        await o.onSignedTime({ at: feed.issuedAt, source: 'feed' });
      } catch (error) {
        o.log.warn('the feed freshness time could not be recorded', { channel, ...errorFields(error) });
      }
    }
    o.log.info('update feed fetched', { channel, seq: feed.seq, entries: feed.entries.length });
    return feed;
  }

  async function download(
    entry: FeedEntry,
    dest: DataPath,
    onProgress: (bytes: number, total: number) => void,
    opts: { deadline?: number } = {},
  ): Promise<DownloadResult> {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) {
      throw new TypeError('download: entry needs a whole size and a hex sha256');
    }
    if (typeof entry.url !== 'string') throw new TypeError('download: entry needs a url');
    if (typeof onProgress !== 'function') throw new TypeError('download: onProgress must be a function');
    if (opts.deadline !== undefined && (typeof opts.deadline !== 'number' || Number.isNaN(opts.deadline))) {
      throw new TypeError('download: deadline must be epoch ms');
    }
    const statePath = downloadStatePath(o.dataDir, dest);
    // The time left, taken on the source's clock and handed to fetchRange as wall-clock epoch ms.
    const remaining = opts.deadline === undefined ? Number.POSITIVE_INFINITY : opts.deadline - o.clock();

    // 1. The partial file belongs to this package, or it goes: the state is written before any byte of it.
    const state = await readDownloadState(statePath);
    if (state === null || state.url !== entry.url || state.sha256 !== entry.sha256) {
      await removeFile(dest);
      await writeBytesAtomic(statePath, `${JSON.stringify({ url: entry.url, sha256: entry.sha256 })}\n`);
    }
    const found = await statOrNull(dest);
    if (found !== null && found.kind !== 'file') throw new TypeError('download: dest exists and is not a file');
    let size = found === null ? 0 : found.size;
    if (size > entry.size) {
      await removeFile(dest);
      throw sizeRefused(entry);
    }

    // 2. The missing bytes (a missing file even for an empty package), until the deadline.
    if (size < entry.size || found === null) {
      if (!(remaining > 0)) return { complete: false, bytes: size };
      onProgress(size, entry.size);
      const before = size;
      /** The size refusal thrown from inside the transfer: the file goes with it. */
      const refusal: { error: DomainError | null } = { error: null };
      const refuse = (): DomainError => {
        refusal.error = sizeRefused(entry);
        return refusal.error;
      };
      let handle: FileHandle | undefined;
      /** The package file, open for appending (the 200 restart below opens a new one). */
      const open = (): FileHandle => {
        if (handle === undefined) throw new Error('download: the package file is not open');
        return handle;
      };
      let result: Awaited<ReturnType<typeof fetchRange>>;
      try {
        handle = await openAppend(dest);
        result = await fetchRange(entry.url, {
          start: size,
          deadline: Date.now() + remaining,
          allowLoopbackHttp: o.allowLoopbackHttp,
          async onResponse(r) {
            if (r.total !== null && r.total !== entry.size) throw refuse();
            if (r.status === 200 && size > 0) {
              // The server ignored the range: its body starts at byte 0, so the partial file is begun again. It is
              // closed, removed and opened anew, never truncated: Windows refuses ftruncate on an append-mode handle.
              // A kill in between leaves no file, under the same download.json: the next call starts at 0.
              await open().close();
              handle = undefined;
              await removeFile(dest);
              size = 0;
              handle = await openAppend(dest);
            }
          },
          async onChunk(bytes) {
            if (size + bytes.length > entry.size) throw refuse();
            try {
              await appendAll(open(), bytes);
            } catch (error) {
              throw quotaOf(error);
            }
            size += bytes.length;
            onProgress(size, entry.size);
          },
        });
        try {
          await open().sync();
        } catch (error) {
          throw quotaOf(error);
        }
      } catch (error) {
        if (handle !== undefined) {
          await handle.sync().catch(() => undefined); // the bytes so far stay for the next call
          await handle.close().catch(() => undefined);
          handle = undefined;
        }
        if (refusal.error !== null && error === refusal.error) await removeFile(dest);
        throw error;
      } finally {
        await handle?.close();
      }

      if (size < entry.size) {
        if (!result.ended) return { complete: false, bytes: size };
        // The answer ended short of the entry's size: a 200 or a 206 to the file's end had nothing more to give.
        if (result.status === 200 || (result.total !== null && size >= result.total)) {
          await removeFile(dest);
          throw sizeRefused(entry);
        }
        if (size === before) {
          throw new DomainError('UPDATE_DOWNLOAD_FAILED', {
            detail: 'Server pembaruan tidak mengirim byte apa pun / The update server sent no bytes',
            meta: { reason: 'status', status: result.status },
          });
        }
        return { complete: false, bytes: size }; // a range shorter than asked: the next call goes on
      }
    }

    // 3. Whole: size and SHA-256.
    const hashed = await hashFile(dest, corruptOffset(o.env, entry.size));
    if (hashed.bytes !== entry.size) {
      await removeFile(dest);
      throw sizeRefused(entry);
    }
    if (hashed.sha256 !== entry.sha256) {
      await removeFile(dest);
      throw packageInvalid(
        'hash',
        `SHA-256 paket ${entry.version} tidak cocok dengan feed; berkasnya dihapus / ` +
          `The SHA-256 of the ${entry.version} package does not match the feed; the file was removed`,
      );
    }
    return { complete: true, bytes: entry.size };
  }

  function feedConfigured(): boolean {
    try {
      const base = o.feedBase();
      return base !== null && base !== '';
    } catch {
      return true;
    }
  }

  return { fetchFeed, feedConfigured, download };
}
