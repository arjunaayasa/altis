/**
 * Bounded reads of the small signed files of a release and of DATA_DIR (manifest.json, manifest.sig, keyset.json).
 *
 * One descriptor per file: opened without following a symbolic link and without blocking (ruling R65c: a FIFO or a
 * device in place of the file must never hang the boot; the open returns at once and fstat refuses it), checked to be
 * a regular file with fstat, and read in chunks up to a limit, so that nothing swapped in between is read.
 *
 * Bundled into the ES2017 bootloader: keep the syntax plain; node built-ins only.
 */
import { Buffer } from 'node:buffer';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { TextDecoder } from 'node:util';

/** Open flags of every read of a release or state file: never through a symbolic link, never blocking. */
export const OPEN_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0);

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * The UTF-8 text of `file`, at most `maxBytes` bytes. The open's own error is thrown as it is (ENOENT, EACCES, ELOOP
 * for a symbolic link, ...); `Error('not a regular file: <name>')`, `Error('too large: <name>')`, or the decoder's
 * error for bytes that are not UTF-8.
 */
export async function readBoundedText(file: string, maxBytes: number): Promise<string> {
  const name = nodePath.basename(file);
  const handle = await fsp.open(file, OPEN_READ_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a regular file: ' + name);
    if (info.size > maxBytes) throw new Error('too large: ' + name);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error('too large: ' + name);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await handle.close();
  }
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}
