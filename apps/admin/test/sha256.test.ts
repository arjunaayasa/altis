import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SHA256_SLICE_BYTES, sha256Hex } from '@/lib/sha256';

// The browser's SHA-256 of a file to upload (Task 16, P10): WebCrypto has no streaming digest and a backup may be
// 20 GiB, so the admin hashes the Blob in 4 MiB slices with its own incremental SHA-256. Checked against Node's.

const MIB = 1024 * 1024;

const node = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** `length` bytes of a fixed pseudo-random sequence (xorshift32), so a failure is reproducible. */
function bytes(length: number, seed = 0x9e3779b9): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

describe('sha256Hex', () => {
  it('"abc" → the FIPS 180-4 example digest; the empty blob → the empty digest', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex(new Blob([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('the padding boundaries (55, 56, 63, 64, 65, 119, 120, 128 bytes) equal Node', async () => {
    for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const data = bytes(length, length);
      expect(await sha256Hex(new Blob([data])), String(length)).toBe(node(data));
    }
  });

  it('a 9 MiB blob (three slices, the last one partial) equals Node, reporting each slice', async () => {
    expect(SHA256_SLICE_BYTES).toBe(4 * MIB);
    const data = bytes(9 * MIB);
    const progress: [number, number][] = [];
    const digest = await sha256Hex(new Blob([data]), (hashed, total) => progress.push([hashed, total]));
    expect(digest).toBe(node(data));
    expect(progress).toEqual([
      [4 * MIB, 9 * MIB],
      [8 * MIB, 9 * MIB],
      [9 * MIB, 9 * MIB],
    ]);
  });

  it('a slice boundary inside a block (4 MiB + 3 bytes) equals Node', async () => {
    const data = bytes(4 * MIB + 3, 7);
    expect(await sha256Hex(new Blob([data]))).toBe(node(data));
  });

  it('an aborted signal rejects with its reason before the next slice', async () => {
    const controller = new AbortController();
    const data = bytes(9 * MIB, 3);
    const seen: number[] = [];
    const run = sha256Hex(
      new Blob([data]),
      (hashed) => {
        seen.push(hashed);
        controller.abort(new DOMException('stopped', 'AbortError'));
      },
      controller.signal,
    );
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual([4 * MIB]);
  });
});
