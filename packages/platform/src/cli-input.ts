import { constants as fsConstants } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '@altis/shared';

// Reading a file an operator names on the command line (`node app.js install --config <file>`, ruling R1).
// apps/** may not call fs with a path that is not a literal (spec §7.5), so the CLI reads its input here.
//
// The file is the operator's own and may hold the database password: an error says what is wrong with the file
// (its path and a reason), never anything that was read from it.

/** The largest input accepted by default: 1 MiB, far above any install file. */
export const CLI_INPUT_MAX_BYTES = 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;

export interface ReadCliInputOptions {
  /** Refuse a file larger than this many bytes. Default {@link CLI_INPUT_MAX_BYTES}. */
  maxBytes?: number;
}

type Reason = 'path' | 'not_found' | 'unreadable' | 'not_a_file' | 'too_large' | 'not_utf8';

const WHY: Readonly<Record<Reason, string>> = {
  path: 'path berkas kosong atau tidak valid / the file path is empty or not valid',
  not_found: 'berkas tidak ditemukan / the file does not exist',
  unreadable: 'berkas tidak dapat dibaca (izin?) / the file cannot be read (permissions?)',
  not_a_file: 'bukan berkas biasa (folder, FIFO, atau perangkat) / not a regular file (a folder, a FIFO or a device)',
  too_large: 'berkas terlalu besar / the file is too large',
  not_utf8: 'berkas bukan teks UTF-8; simpan ulang sebagai UTF-8 / the file is not UTF-8 text; save it again as UTF-8',
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** A path an operator typed, quoted and cut short for a message. */
function shown(file: string): string {
  return JSON.stringify(file.length > 200 ? `${file.slice(0, 200)}…` : file);
}

function refused(file: string, reason: Reason, extra: Record<string, unknown> = {}): DomainError {
  return new DomainError('INVALID_CONFIG', {
    detail: `${shown(file)}: ${WHY[reason]}`,
    meta: { reason, ...extra },
  });
}

function openFailure(file: string, error: unknown): DomainError {
  const code = errorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') return refused(file, 'not_found', { code });
  if (code === 'EISDIR') return refused(file, 'not_a_file', { code }); // Windows opens no folder
  return refused(file, 'unreadable', code === undefined ? {} : { code });
}

/**
 * Reads the UTF-8 text file `file` that an operator passed to the CLI (for example `install --config input.json`).
 * A relative path is taken relative to the working directory; a symbolic link is followed.
 *
 * Only a regular file is read. The file is opened with `O_NONBLOCK` (where the platform has it) and checked with
 * `fstat` on the same descriptor before anything is read, so a FIFO is refused at once instead of waiting forever
 * for a writer, and a device such as `/dev/zero` is never read. At most `maxBytes` bytes are accepted, whatever
 * `fstat` said (the file may grow while it is read). A UTF-8 byte-order mark is dropped; any other byte sequence
 * that is not UTF-8 is refused (UTF-16 included).
 *
 * @throws DomainError `INVALID_CONFIG` with `meta.reason`: `path` (empty, not a string, or holding NUL),
 *   `not_found`, `unreadable` (permissions or another I/O error, `meta.code`), `not_a_file`, `too_large`,
 *   `not_utf8`. The detail names the path and the reason in Indonesian and English, never the file's content.
 * @throws RangeError when `maxBytes` is not a positive integer
 */
export async function readCliInputFile(file: string, o: ReadCliInputOptions = {}): Promise<string> {
  const maxBytes = o.maxBytes ?? CLI_INPUT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`readCliInputFile: maxBytes must be a positive integer, got ${String(maxBytes)}`);
  }
  if (typeof file !== 'string' || file.trim() === '' || file.includes('\u0000')) {
    throw refused(typeof file === 'string' ? file.split('\u0000').join('\\0') : '', 'path');
  }

  let handle: FileHandle;
  try {
    // O_NONBLOCK: opening a FIFO for reading returns at once instead of blocking until a writer opens it. It does
    // not change reads from a regular file. Windows has no such flag (and no FIFOs in the file system).
    handle = await fsp.open(path.resolve(file), fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0));
  } catch (error) {
    throw openFailure(file, error);
  }
  try {
    let size: number;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw refused(file, 'not_a_file');
      size = info.size;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw openFailure(file, error);
    }
    if (size > maxBytes) throw refused(file, 'too_large', { maxBytes });

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      // One byte more than allowed is enough to know the file is too large.
      const want = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total);
      const chunk = Buffer.allocUnsafe(want);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(chunk, 0, want, total));
      } catch (error) {
        throw openFailure(file, error);
      }
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw refused(file, 'too_large', { maxBytes });
      chunks.push(chunk.subarray(0, bytesRead));
    }

    try {
      // ignoreBOM false (the default): a leading UTF-8 byte-order mark is consumed, not returned.
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw refused(file, 'not_utf8');
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}
