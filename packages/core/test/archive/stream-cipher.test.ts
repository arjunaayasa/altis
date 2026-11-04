import { randomBytes } from 'node:crypto';
import { isDomainError } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import {
  NONCE_PREFIX_BYTES,
  STREAM_CHUNK,
  STREAM_TAG_BYTES,
  decryptChunk,
  decryptStream,
  encryptChunk,
  encryptedSize,
  streamChunkCount,
} from '../../src/archive/stream-cipher.js';

// STREAM (decision C13): AES-256-GCM per 1 MiB chunk, IV = 7-byte prefix ‖ uint32BE(index) ‖ last-chunk byte,
// AAD = entry name, each chunk ciphertext ‖ 16-byte tag; an encrypted entry is the prefix followed by its chunks.

const KEY = new Uint8Array(32).fill(9);
const AAD = 'tables/branches/00001.jsonl.gz';

/** The stored bytes of an encrypted entry, as the writer lays them out. */
function seal(plain: Uint8Array, prefix: Uint8Array, aad = AAD): Buffer[] {
  const n = streamChunkCount(plain.byteLength);
  const pieces: Buffer[] = [Buffer.from(prefix)];
  for (let k = 0; k < n; k += 1) {
    const part = plain.subarray(k * STREAM_CHUNK, Math.min((k + 1) * STREAM_CHUNK, plain.byteLength));
    pieces.push(Buffer.from(encryptChunk(KEY, prefix, k, k === n - 1, aad, part)));
  }
  return pieces;
}

/** `bytes` cut into pieces of `size` bytes: a source that does not respect chunk boundaries. */
async function* sliced(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.byteLength; i += size) yield bytes.subarray(i, Math.min(i + size, bytes.byteLength));
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of source) out.push(Buffer.from(chunk));
  return Buffer.concat(out);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function expectInvalid(error: unknown, reason: string): void {
  expect(isDomainError(error) && error.code).toBe('BACKUP_INVALID');
  expect(isDomainError(error) && error.meta?.['reason']).toBe(reason);
}

describe('STREAM sizes', () => {
  it('has the constants of decision C13', () => {
    expect(STREAM_CHUNK).toBe(1_048_576);
    expect(NONCE_PREFIX_BYTES).toBe(7);
    expect(STREAM_TAG_BYTES).toBe(16);
  });

  it('computes encryptedSize = 7 + plain + 16 × max(1, ⌈plain / 1 MiB⌉)', () => {
    expect(encryptedSize(0)).toBe(23);
    expect(encryptedSize(1)).toBe(24);
    expect(encryptedSize(1048576)).toBe(1048599);
    expect(encryptedSize(1048577)).toBe(7 + 1048577 + 32);
    expect(encryptedSize(3.5 * 1048576)).toBe(7 + 3.5 * 1048576 + 64);
    expect(() => encryptedSize(-1)).toThrow(RangeError);
    expect(() => encryptedSize(1.5)).toThrow(RangeError);
  });
});

describe('STREAM round trips', () => {
  for (const size of [0, 1, STREAM_CHUNK, STREAM_CHUNK + 1, 3.5 * STREAM_CHUNK]) {
    it(`round-trips ${size} bytes, whatever the source's piece sizes`, async () => {
      const plain = randomBytes(size);
      const prefix = randomBytes(NONCE_PREFIX_BYTES);
      const stored = Buffer.concat(seal(plain, prefix));
      expect(stored.byteLength).toBe(encryptedSize(size));
      // 1-byte pieces only where they stay cheap; a piece of the stored length is the whole entry at once.
      const pieces = size <= 1 ? [1, 4093, 65_536, 1_048_599, stored.byteLength] : [4093, 65_536, 1_048_599, stored.byteLength];
      for (const piece of pieces) {
        const back = await collect(decryptStream(KEY, AAD, sliced(stored, piece)));
        expect(back.equals(plain)).toBe(true);
      }
    });
  }

  it('decrypts one chunk with decryptChunk', () => {
    const prefix = randomBytes(NONCE_PREFIX_BYTES);
    const sealed = encryptChunk(KEY, prefix, 5, true, AAD, Buffer.from('halo'));
    expect(Buffer.from(decryptChunk(KEY, prefix, 5, true, AAD, sealed)).toString()).toBe('halo');
  });
});

describe('STREAM refusals', () => {
  it('refuses two swapped chunks', async () => {
    const prefix = randomBytes(NONCE_PREFIX_BYTES);
    const pieces = seal(randomBytes(3 * STREAM_CHUNK), prefix);
    const swapped = Buffer.concat([pieces[0]!, pieces[2]!, pieces[1]!, pieces[3]!]);
    expectInvalid(await rejection(collect(decryptStream(KEY, AAD, sliced(swapped, 65_536)))), 'checksum');
  });

  it('refuses an entry whose final chunk was dropped (no chunk carries the last flag)', async () => {
    const prefix = randomBytes(NONCE_PREFIX_BYTES);
    const pieces = seal(randomBytes(2 * STREAM_CHUNK + 10), prefix);
    const truncated = Buffer.concat(pieces.slice(0, -1));
    expectInvalid(await rejection(collect(decryptStream(KEY, AAD, sliced(truncated, 65_536)))), 'checksum');
  });

  it('refuses another AAD (an entry renamed)', async () => {
    const prefix = randomBytes(NONCE_PREFIX_BYTES);
    const stored = Buffer.concat(seal(randomBytes(100), prefix));
    expectInvalid(await rejection(collect(decryptStream(KEY, 'tables/branches/00002.jsonl.gz', sliced(stored, 7)))), 'checksum');
  });

  it('refuses a flipped byte, another key and a failed tag in decryptChunk', async () => {
    const prefix = randomBytes(NONCE_PREFIX_BYTES);
    const stored = Buffer.concat(seal(randomBytes(100), prefix));
    stored[20] = stored[20]! ^ 1;
    expectInvalid(await rejection(collect(decryptStream(KEY, AAD, sliced(stored, 50)))), 'checksum');
    const good = Buffer.concat(seal(randomBytes(100), prefix));
    expectInvalid(await rejection(collect(decryptStream(new Uint8Array(32).fill(1), AAD, sliced(good, 50)))), 'checksum');
    const sealed = encryptChunk(KEY, prefix, 0, false, AAD, Buffer.from('x'));
    let error: unknown;
    try {
      decryptChunk(KEY, prefix, 0, true, AAD, sealed);
    } catch (e) {
      error = e;
    }
    expectInvalid(error, 'checksum');
  });

  it('refuses entries too short to hold a prefix and a tag', async () => {
    expectInvalid(await rejection(collect(decryptStream(KEY, AAD, sliced(Buffer.alloc(5), 5)))), 'format');
    expectInvalid(await rejection(collect(decryptStream(KEY, AAD, sliced(Buffer.alloc(7 + 15), 4)))), 'format');
    expectInvalid(await rejection(collect(decryptStream(KEY, AAD, sliced(Buffer.alloc(0), 1)))), 'format');
  });

  it('refuses bad arguments with a TypeError or RangeError', () => {
    const prefix = randomBytes(NONCE_PREFIX_BYTES);
    expect(() => encryptChunk(new Uint8Array(16), prefix, 0, true, AAD, Buffer.alloc(1))).toThrow(TypeError);
    expect(() => encryptChunk(KEY, new Uint8Array(6), 0, true, AAD, Buffer.alloc(1))).toThrow(TypeError);
    expect(() => encryptChunk(KEY, prefix, -1, true, AAD, Buffer.alloc(1))).toThrow(RangeError);
    expect(() => encryptChunk(KEY, prefix, 2 ** 32, true, AAD, Buffer.alloc(1))).toThrow(RangeError);
    expect(() => encryptChunk(KEY, prefix, 0, true, AAD, Buffer.alloc(STREAM_CHUNK + 1))).toThrow(RangeError);
  });
});
