import { createCipheriv, createDecipheriv } from 'node:crypto';
import { DomainError } from '@altis/shared';

// STREAM encryption of `.altisbak` entries (spec §9.9, decision C13): an online AEAD in the STREAM construction of
// Hoang, Reyhanitabar, Rogaway and Vizár, with AES-256-GCM under the archive's DEK.
//
//   entry   = prefix (7 random bytes, one per entry) ‖ chunk_0 ‖ ... ‖ chunk_{n-1}
//   chunk_k = AES-256-GCM(key, IV = prefix ‖ uint32BE(k) ‖ last, AAD = entry name, plain_k) ‖ 16-byte tag
//
// Every chunk but the last holds exactly STREAM_CHUNK (1 MiB) plaintext bytes; the last holds the rest (1 byte to
// 1 MiB, or 0 for an empty entry, which still has one chunk: its tag). `last` is 0x01 on the final chunk and 0x00
// on every other one. The chunk index in the IV makes swapped or repeated chunks fail, the last-chunk byte makes a
// truncated entry fail (its new final chunk was sealed as "not last"), the AAD makes an entry renamed or moved fail.
// Each chunk is checked before its plaintext is released, so a reader never acts on unauthenticated bytes.
//
// A failed tag is DomainError BACKUP_INVALID reason `checksum`; an entry whose length cannot be a STREAM entry
// (shorter than a prefix and one tag) is reason `format`.

/** Plaintext bytes per chunk. */
export const STREAM_CHUNK = 1_048_576;
/** Random bytes per entry at the start of every chunk's IV. */
export const NONCE_PREFIX_BYTES = 7;
/** The GCM tag after every chunk's ciphertext. */
export const STREAM_TAG_BYTES = 16;

const KEY_BYTES = 32;
/** The stored size of a full chunk. */
const SEALED_CHUNK = STREAM_CHUNK + STREAM_TAG_BYTES;
/** The highest chunk index (a 32-bit counter). */
const MAX_INDEX = 0xffff_ffff;

function checkKey(key: Uint8Array, caller: string): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new TypeError(`${caller}: the key must be ${KEY_BYTES} bytes`);
  }
}

function iv(prefix: Uint8Array, index: number, last: boolean, caller: string): Buffer {
  if (!(prefix instanceof Uint8Array) || prefix.byteLength !== NONCE_PREFIX_BYTES) {
    throw new TypeError(`${caller}: the nonce prefix must be ${NONCE_PREFIX_BYTES} bytes`);
  }
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new RangeError(`${caller}: the chunk index must be an integer from 0 to 2^32 − 1, got ${String(index)}`);
  }
  const out = Buffer.alloc(NONCE_PREFIX_BYTES + 5);
  out.set(prefix, 0);
  out.writeUInt32BE(index, NONCE_PREFIX_BYTES);
  out[NONCE_PREFIX_BYTES + 4] = last ? 0x01 : 0x00;
  return out;
}

function invalid(reason: 'checksum' | 'format', aad: string): DomainError {
  const why =
    reason === 'checksum'
      ? 'isinya rusak, diubah, atau kuncinya salah / its content is damaged, was changed, or the key is wrong'
      : 'panjangnya tidak mungkin untuk entri terenkripsi / its length is impossible for an encrypted entry';
  return new DomainError('BACKUP_INVALID', {
    detail: `Entri arsip ${JSON.stringify(aad.slice(0, 120))}: ${why}`,
    meta: { reason },
  });
}

/** The number of chunks of an entry of `plain` bytes: max(1, ⌈plain / 1 MiB⌉). */
export function streamChunkCount(plain: number): number {
  if (!Number.isSafeInteger(plain) || plain < 0) {
    throw new RangeError(`streamChunkCount: the size must be a non-negative safe integer, got ${String(plain)}`);
  }
  return Math.max(1, Math.ceil(plain / STREAM_CHUNK));
}

/**
 * The stored size of an encrypted entry of `plain` bytes: 7 + plain + 16 × max(1, ⌈plain / 1 MiB⌉).
 *
 * @throws RangeError unless `plain` is a non-negative safe integer
 */
export function encryptedSize(plain: number): number {
  return NONCE_PREFIX_BYTES + plain + STREAM_TAG_BYTES * streamChunkCount(plain);
}

/**
 * The plaintext size of an encrypted entry stored in `stored` bytes, or null when no plaintext size encrypts to it.
 */
export function plainSizeOf(stored: number): number | null {
  if (!Number.isSafeInteger(stored) || stored < NONCE_PREFIX_BYTES + STREAM_TAG_BYTES) return null;
  const body = stored - NONCE_PREFIX_BYTES;
  const chunks = Math.max(1, Math.ceil(body / SEALED_CHUNK));
  const plain = body - STREAM_TAG_BYTES * chunks;
  return plain >= 0 && encryptedSize(plain) === stored ? plain : null;
}

/**
 * Chunk `index` of an entry: AES-256-GCM of `plain` (at most 1 MiB) under `key`, with IV = prefix ‖ uint32BE(index)
 * ‖ (last ? 0x01 : 0x00) and the UTF-8 bytes of `aad` (the entry name). Returns ciphertext ‖ 16-byte tag.
 *
 * @throws TypeError for a key that is not 32 bytes or a prefix that is not 7 bytes
 * @throws RangeError for an index outside 0 … 2^32 − 1 or more than 1 MiB of plaintext
 */
export function encryptChunk(key: Uint8Array, prefix: Uint8Array, index: number, last: boolean, aad: string, plain: Uint8Array): Uint8Array {
  checkKey(key, 'encryptChunk');
  const nonce = iv(prefix, index, last, 'encryptChunk');
  if (!(plain instanceof Uint8Array) || plain.byteLength > STREAM_CHUNK) {
    throw new RangeError(`encryptChunk: a chunk holds at most ${STREAM_CHUNK} bytes`);
  }
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: STREAM_TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/**
 * The plaintext of chunk `index` sealed by {@link encryptChunk} with the same key, prefix, index, last flag and AAD.
 *
 * @throws DomainError BACKUP_INVALID reason `checksum` when the tag does not verify (anything differs), `format`
 *   when `sealed` is shorter than a tag or longer than a full chunk
 * @throws TypeError / RangeError as {@link encryptChunk}
 */
export function decryptChunk(key: Uint8Array, prefix: Uint8Array, index: number, last: boolean, aad: string, sealed: Uint8Array): Uint8Array {
  checkKey(key, 'decryptChunk');
  const nonce = iv(prefix, index, last, 'decryptChunk');
  if (!(sealed instanceof Uint8Array) || sealed.byteLength < STREAM_TAG_BYTES || sealed.byteLength > SEALED_CHUNK) {
    throw invalid('format', aad);
  }
  const body = sealed.byteLength - STREAM_TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: STREAM_TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.subarray(body));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, body)), decipher.final()]);
  } catch {
    throw invalid('checksum', aad);
  }
}

/** Collects pieces of a byte stream and hands out exact-size slices. For this folder (the writer uses it too). */
export class ByteQueue {
  private readonly pieces: Buffer[] = [];
  length = 0;

  push(piece: Uint8Array): void {
    if (piece.byteLength === 0) return;
    this.pieces.push(Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength));
    this.length += piece.byteLength;
  }

  /** The first `n` bytes (n ≤ length), removed from the queue. */
  take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.pieces[0]!;
      const want = n - filled;
      if (head.byteLength <= want) {
        head.copy(out, filled);
        filled += head.byteLength;
        this.pieces.shift();
      } else {
        head.copy(out, filled, 0, want);
        this.pieces[0] = head.subarray(want);
        filled += want;
      }
    }
    this.length -= n;
    return out;
  }
}

/**
 * Decrypts the stored bytes of one encrypted entry (`source`, cut anywhere) and yields its plaintext chunk by chunk,
 * each only after its tag verified. A chunk is known to be the last when the source ends behind it, so a full-size
 * chunk is held back until more bytes arrive.
 *
 * @throws DomainError BACKUP_INVALID reason `checksum` (a tag fails: damage, reordering, truncation at a chunk
 *   boundary, another AAD or key) or `format` (too short for a prefix and one tag, a final chunk shorter than a tag);
 *   any error of `source` as it is
 */
export async function* decryptStream(key: Uint8Array, aad: string, source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array, void, undefined> {
  checkKey(key, 'decryptStream');
  const queue = new ByteQueue();
  let prefix: Buffer | null = null;
  let index = 0;
  for await (const piece of source) {
    queue.push(piece);
    if (prefix === null) {
      if (queue.length < NONCE_PREFIX_BYTES) continue;
      prefix = queue.take(NONCE_PREFIX_BYTES);
    }
    // Strictly more than one sealed chunk queued: the first one is not the last.
    while (queue.length > SEALED_CHUNK) {
      if (index >= MAX_INDEX) throw invalid('format', aad);
      yield decryptChunk(key, prefix, index, false, aad, queue.take(SEALED_CHUNK));
      index += 1;
    }
  }
  if (prefix === null || queue.length < STREAM_TAG_BYTES) throw invalid('format', aad);
  yield decryptChunk(key, prefix, index, true, aad, queue.take(queue.length));
}
