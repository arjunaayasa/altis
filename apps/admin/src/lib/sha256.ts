/**
 * The SHA-256 of a file the admin uploads (1c Task 16; spec §5 P10, §7.5: the size and the digest are declared before
 * the first chunk). WebCrypto has no streaming digest and a backup archive may be 20 GiB, so the Blob is read in
 * 4 MiB slices and fed to an incremental SHA-256 (FIPS 180-4) written here: memory stays at one slice, whatever the
 * file's size. The server keeps its own incremental digest of what arrives (ruling R1c-4) and compares the two at
 * `complete`.
 */

/** The Blob is read this much at a time. */
export const SHA256_SLICE_BYTES = 4 * 1024 * 1024;

/** The round constants. */
const K = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The initial chaining value. */
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** The message schedule; the block function runs to completion before anything else can use it. */
const W = new Int32Array(64);

/** Compresses the 64-byte block of `bytes` at `offset` into `state` (32-bit integer arithmetic throughout). */
function compress(state: Int32Array, bytes: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i += 1) {
    const at = offset + 4 * i;
    W[i] = (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
  }
  for (let i = 16; i < 64; i += 1) {
    const w15 = W[i - 15]!;
    const w2 = W[i - 2]!;
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
    W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
  }
  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;
  let e = state[4]!;
  let f = state[5]!;
  let g = state[6]!;
  let h = state[7]!;
  for (let i = 0; i < 64; i += 1) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + s1 + ch + K[i]! + W[i]!) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] = (state[0]! + a) | 0;
  state[1] = (state[1]! + b) | 0;
  state[2] = (state[2]! + c) | 0;
  state[3] = (state[3]! + d) | 0;
  state[4] = (state[4]! + e) | 0;
  state[5] = (state[5]! + f) | 0;
  state[6] = (state[6]! + g) | 0;
  state[7] = (state[7]! + h) | 0;
}

/** A SHA-256 fed piece by piece. */
class Sha256 {
  readonly #state = Int32Array.from(H0);
  /** The bytes after the last whole block (the first `#pendingBytes` of these 64). */
  readonly #pending = new Uint8Array(64);
  #pendingBytes = 0;
  #length = 0;

  update(data: Uint8Array): void {
    let at = 0;
    if (this.#pendingBytes > 0) {
      const take = Math.min(64 - this.#pendingBytes, data.byteLength);
      this.#pending.set(data.subarray(0, take), this.#pendingBytes);
      this.#pendingBytes += take;
      at = take;
      if (this.#pendingBytes === 64) {
        compress(this.#state, this.#pending, 0);
        this.#pendingBytes = 0;
      }
    }
    for (; at + 64 <= data.byteLength; at += 64) compress(this.#state, data, at);
    if (at < data.byteLength) {
      this.#pending.set(data.subarray(at), 0);
      this.#pendingBytes = data.byteLength - at;
    }
    this.#length += data.byteLength;
  }

  digestHex(): string {
    // The padding: 0x80, zeros up to 56 bytes modulo 64, then the length in bits as a 64-bit big-endian integer.
    const tail = new Uint8Array(this.#pendingBytes < 56 ? 64 : 128);
    tail.set(this.#pending.subarray(0, this.#pendingBytes));
    tail[this.#pendingBytes] = 0x80;
    // length × 8 split into two 32-bit halves without leaving the safe integers: high = ⌊length / 2^29⌋.
    const high = Math.floor(this.#length / 0x20000000);
    const low = (this.#length % 0x20000000) * 8;
    const end = tail.byteLength;
    tail[end - 8] = high >>> 24;
    tail[end - 7] = (high >>> 16) & 0xff;
    tail[end - 6] = (high >>> 8) & 0xff;
    tail[end - 5] = high & 0xff;
    tail[end - 4] = low >>> 24;
    tail[end - 3] = (low >>> 16) & 0xff;
    tail[end - 2] = (low >>> 8) & 0xff;
    tail[end - 1] = low & 0xff;
    for (let at = 0; at < end; at += 64) compress(this.#state, tail, at);
    let hex = '';
    for (const word of this.#state) hex += (word >>> 0).toString(16).padStart(8, '0');
    return hex;
  }
}

/**
 * The SHA-256 of `blob` in lower-case hex, read {@link SHA256_SLICE_BYTES} at a time. `onProgress(hashed, total)` is
 * called after each slice. Each slice is a read the browser does asynchronously, so the page stays responsive.
 *
 * @throws the signal's reason (an `AbortError` DOMException by default) once `signal` is aborted, checked before each
 *   slice
 */
export async function sha256Hex(
  blob: Blob,
  onProgress?: (hashed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const hash = new Sha256();
  const total = blob.size;
  for (let at = 0; at < total; at += SHA256_SLICE_BYTES) {
    signal?.throwIfAborted();
    const end = Math.min(at + SHA256_SLICE_BYTES, total);
    hash.update(new Uint8Array(await blob.slice(at, end).arrayBuffer()));
    onProgress?.(end, total);
  }
  signal?.throwIfAborted();
  return hash.digestHex();
}
