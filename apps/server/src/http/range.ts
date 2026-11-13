import type { FileHandle } from 'node:fs/promises';

// The byte ranges of the download routes (RFC 9110 §14): the one range a request asks for, and the stream that serves
// it from an open file. Every route that serves a file by range (backups, catalogue exports, report runs, a snapshot's
// dossier) uses these two, so none keeps a copy of its own.

/** A file is read in pieces of this size, each only once the client took the previous one. */
const DOWNLOAD_CHUNK_BYTES = 256 * 1024;

/**
 * The one byte range `header` asks for in a file of `size` bytes: [first, last], null for the whole file (no `Range`,
 * an `If-Range` other than `etag`, several ranges, another unit, a malformed range: ignored, RFC 9110 §14.2), or
 * 'unsatisfiable' (a first byte past the end, an empty suffix).
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
 * the end, on an error, or when the client goes. `ended`, when given, runs once the client took the last of them,
 * before the stream closes.
 */
export function rangeStream(handle: FileHandle, first: number, last: number, ended?: () => Promise<void>): ReadableStream<Uint8Array> {
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
            if (ended !== undefined) await ended();
            controller.close();
            return;
          }
          const buffer = new Uint8Array(Math.min(DOWNLOAD_CHUNK_BYTES, left));
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
          if (bytesRead === 0) throw new Error('the file is shorter than its size');
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
