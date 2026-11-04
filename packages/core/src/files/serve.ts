import { createHash } from 'node:crypto';
import { openRead, removeFile, statOrNull, uploadPath, writeStreamAtomic, type DataPath } from '@altis/platform';
import { DomainError } from '@altis/shared';

// Serving stored files (spec §7.5 "/files/:id") and where they are stored (§13.8 StorageDriver; S3 stays out of Phase
// 1, §13.10). A file uploaded by a user must never run as a page of the site: it is sent as an attachment (inline only
// for the raster images, PDF, audio and video a browser shows without running anything), in a CSP sandbox with no
// sources at all, readable by this origin alone, with sniffing off, under a name that cannot name a folder or break
// the header.
//
// Phase 2 (its spec §8; plan Task 18): audio and video are shown inline too (the OPAC viewer plays them from
// `/files/<id>` with Range), every file says it takes byte ranges, and a public file may stay a day in any cache with
// its SHA-256 as a strong ETag; a staff file stays `private, no-store`. The type is the one magic.ts gave the bytes
// (never the uploader's), so an inline audio or video type cannot carry a page: a QuickTime or 3GP file is typed
// `video/mp4` by its `ftyp` box, and is shown inline like any MP4 (a browser that cannot play it shows a player
// that does not start; it never renders the bytes as anything else). The `sha256` of a `files` row is that of the
// bytes stored (upload completion stores a stripped image's own size and digest).

/**
 * The types a browser may show inline: raster images, PDF, and audio/video (mp3, m4a/mp4, ogg, wav, webm). SVG is not
 * one of them (it is never given an image type, magic.ts), nor XML or text.
 */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  // ---- Phase 2 (catalog): Task 18 ----
  'audio/mpeg',
  'audio/mp4',
  'video/mp4',
  'audio/ogg',
  'audio/wav',
  'video/webm',
]);

/** How long a public file may stay in a cache (spec §8: a day). */
const PUBLIC_FILE_MAX_AGE_S = 86_400;

/** The longest file name sent, in code points (the extension is kept). */
const NAME_MAX = 150;
/** An extension kept when a long name is cut: a dot and at most 15 more characters, none of them a dot. */
const EXTENSION = /\.[^.]{1,15}$/u;
/** C0 controls, DEL and C1 controls: dropped. */
const CONTROLS = /\p{Cc}/gu;
/** Characters no file system or header takes in a name: replaced with `_`. */
const RESERVED = /[\\/:*?"<>|]/gu;
/**
 * Unicode format and separator characters that can disguise a name: zero-width characters and bidi marks (U+200B-200F),
 * line/paragraph separators and bidi embeddings/overrides (U+2028-202E), word joiner and invisible operators
 * (U+2060-2064), the bidi isolates LRI/RLI/FSI/PDI (U+2066-2069), and the BOM.
 */
const INVISIBLE = /[\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/**
 * `name` as a safe download name: only its last path component (after the last `/` or `\`), controls and invisible
 * format characters dropped, `\ / : * ? " < > |` turned into `_`, spaces and dots trimmed at both ends, at most 150
 * code points (the extension kept); `file` when nothing is left.
 */
export function safeFileName(name: string): string {
  const last = name.split(/[\\/]/u).pop() ?? '';
  let clean = last.replace(CONTROLS, '').replace(INVISIBLE, '').replace(RESERVED, '_').replace(/^[\s.]+|[\s.]+$/gu, '');
  const points = [...clean];
  if (points.length > NAME_MAX) {
    const ext = EXTENSION.exec(clean)?.[0] ?? '';
    const extLength = [...ext].length;
    clean = points.slice(0, NAME_MAX - extLength).join('') + ext;
  }
  return clean === '' ? 'file' : clean;
}

/** RFC 5987 `attr-char`s stay; everything else is percent-encoded from its UTF-8 bytes. */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/gu, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `Content-Disposition` for `name`: `<disposition>; filename="<ASCII fallback>"; filename*=UTF-8''<encoded>`, the name
 * passed through {@link safeFileName}; the fallback replaces every non-ASCII character with `_` (it holds no quote or
 * backslash, which the sanitizing removed).
 */
export function contentDisposition(disposition: 'inline' | 'attachment', name: string): string {
  const safe = safeFileName(name);
  const fallback = safe.replace(/[^ -~]/gu, '_');
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${rfc5987(safe)}`;
}

/**
 * The headers of a stored file's response: its type and length, `Content-Disposition` (`inline` only for PNG, JPEG,
 * GIF, WebP, PDF, audio and video; `attachment` otherwise) with a sanitized name, `Content-Security-Policy:
 * default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff` and
 * `Accept-Ranges: bytes`; then the caching: with `public` (a file anyone may read), `Cache-Control: public,
 * max-age=86400` and `ETag: "<sha256>"`; otherwise `Cache-Control: private, no-store` (a staff file must not stay in a
 * shared cache) and no ETag.
 */
export function fileResponseHeaders(f: { originalName: string; mime: string; size: number; public?: { sha256: string } }): Record<string, string> {
  return {
    'Content-Type': f.mime,
    'Content-Length': String(f.size),
    'Content-Disposition': contentDisposition(INLINE_TYPES.has(f.mime) ? 'inline' : 'attachment', f.originalName),
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    ...(f.public === undefined
      ? { 'Cache-Control': 'private, no-store' }
      : { 'Cache-Control': `public, max-age=${PUBLIC_FILE_MAX_AGE_S}`, ETag: `"${f.public.sha256}"` }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Storage

/** Where file contents live (spec §13.8), keyed by file id. Phase 1 has the local driver only (§13.10: no S3). */
export interface StorageDriver {
  /**
   * Stores `data` under `key`, replacing what is there, after checking that it is `meta.size` bytes with SHA-256
   * `meta.sha256` (DomainError `UPLOAD_MISMATCH` with `reason` `size` or `sha256` otherwise, and nothing is stored).
   */
  put(key: string, data: Uint8Array | AsyncIterable<Uint8Array>, meta: { size: number; sha256: string }): Promise<void>;
  /** The content of `key` (bytes `start` to `end`, both included, with a range), or null when there is none. */
  get(key: string, range?: { start: number; end: number }): Promise<AsyncIterable<Uint8Array> | null>;
  stat(key: string): Promise<{ size: number } | null>;
  /** Removes `key`; nothing happens when it is gone already. */
  delete(key: string): Promise<void>;
}

/** How much one read of a stored file takes. */
const READ_CHUNK_BYTES = 64 * 1024;

async function* bytesOf(data: Uint8Array | AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  if (data instanceof Uint8Array) yield data;
  else yield* data;
}

function mismatch(reason: 'size' | 'sha256', key: string): DomainError {
  return new DomainError('UPLOAD_MISMATCH', {
    detail:
      reason === 'size'
        ? `Ukuran berkas ${key} tidak sama dengan yang dinyatakan / The size of file ${key} is not the declared one`
        : `SHA-256 berkas ${key} tidak sama dengan yang dinyatakan / The SHA-256 of file ${key} is not the declared one`,
    meta: { reason },
  });
}

/** `source`, passed through while its length and SHA-256 are checked; the end of the stream throws on a mismatch. */
async function* verified(source: AsyncIterable<Uint8Array>, key: string, meta: { size: number; sha256: string }): AsyncIterable<Uint8Array> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const part of source) {
    size += part.byteLength;
    if (size > meta.size) throw mismatch('size', key);
    hash.update(part);
    yield part;
  }
  if (size !== meta.size) throw mismatch('size', key);
  if (hash.digest('hex') !== meta.sha256) throw mismatch('sha256', key);
}

/** Reads `[start, end]` of the regular file `p`, opened when the first chunk is asked for and closed when done. */
async function* readRange(p: DataPath, start: number, end: number): AsyncIterable<Uint8Array> {
  const handle = await openRead(p);
  try {
    for (let at = start; at <= end; ) {
      const want = Math.min(READ_CHUNK_BYTES, end - at + 1);
      const buffer = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(buffer, 0, want, at);
      if (bytesRead === 0) break; // the file shrank meanwhile
      at += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

/**
 * The local StorageDriver: `key` is a file id (a ULID), stored at `uploadPath(dataDir, key)`
 * (`uploads/<yyyy>/<mm>/<id>`). `put` writes through a hidden temporary sibling and renames it into place
 * (writeStreamAtomic), so a reader sees the old file or the complete new one, and a failed or refused write leaves
 * nothing (P21: `DISK_QUOTA` after cleanup). `get` stats the file first and opens it only when its content is read,
 * so a response that is never read (a HEAD) holds no file handle.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` from every method for a key that is not a ULID
 */
export function localStorageDriver(dataDir: string): StorageDriver {
  return {
    async put(key, data, meta) {
      await writeStreamAtomic(uploadPath(dataDir, key), verified(bytesOf(data), key, meta));
    },
    async get(key, range) {
      const p = uploadPath(dataDir, key);
      const info = await statOrNull(p);
      if (info === null || info.kind !== 'file') return null;
      const start = range?.start ?? 0;
      const end = Math.min(range?.end ?? info.size - 1, info.size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0) {
        throw new RangeError(`localStorageDriver.get: invalid range ${String(start)}-${String(end)}`);
      }
      return readRange(p, start, end);
    },
    async stat(key) {
      const info = await statOrNull(uploadPath(dataDir, key));
      return info === null || info.kind !== 'file' ? null : { size: info.size };
    },
    async delete(key) {
      await removeFile(uploadPath(dataDir, key));
    },
  };
}
