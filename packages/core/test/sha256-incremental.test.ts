import { createHash, randomBytes, randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IncrementalSha256, decodeSha256Midstate, encodeSha256Midstate, type Sha256Midstate } from '../src/files/sha256-incremental.js';

// The pure-JS SHA-256 behind ruling R1c-4: an upload's digest grows one chunk at a time, and its midstate (8 words,
// at most 63 pending bytes, the length) is saved beside the staged file after each chunk, so that the next chunk can
// arrive at another process (Node's Hash state cannot be exported, M18). It must equal node:crypto for every input
// length, the padding boundaries above all (55/56/63/64 bytes modulo 64), wherever the input is cut.

const reference = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** `data` cut at the sorted cut points `cuts` (each within 0..length; repeats give empty pieces). */
function pieces(data: Uint8Array, cuts: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (const cut of [...cuts, data.byteLength]) {
    out.push(data.subarray(at, cut));
    at = cut;
  }
  return out;
}

/** Up to `max` random cut points of a `length`-byte input, sorted. */
function randomCuts(length: number, max: number): number[] {
  const cuts: number[] = [];
  const count = randomInt(0, max + 1);
  for (let i = 0; i < count; i += 1) cuts.push(randomInt(0, length + 1));
  return cuts.sort((a, b) => a - b);
}

/** Hashes `parts` one by one, saving the midstate after each and going on from the decoded copy (another process). */
function acrossProcesses(parts: Uint8Array[]): string {
  let saved = encodeSha256Midstate(new IncrementalSha256().midstate());
  for (const part of parts) {
    const restored = decodeSha256Midstate(saved);
    if (restored === null) throw new Error(`midstate did not decode: ${saved}`);
    saved = encodeSha256Midstate(IncrementalSha256.fromMidstate(restored).update(part).midstate());
  }
  return IncrementalSha256.fromMidstate(decodeSha256Midstate(saved)!).digestHex();
}

describe('IncrementalSha256', () => {
  it('gives the FIPS 180-4 test vectors', () => {
    const hex = (text: string) => new IncrementalSha256().update(Buffer.from(text, 'latin1')).digestHex();
    expect(hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    const million = new IncrementalSha256();
    const block = Buffer.alloc(1000, 'a');
    for (let i = 0; i < 1000; i += 1) million.update(block);
    expect(million.digestHex()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('equals node:crypto for every length from 0 to 320 bytes, in one piece and byte by byte', () => {
    const data = new Uint8Array(randomBytes(320));
    for (let length = 0; length <= 320; length += 1) {
      const input = data.subarray(0, length);
      expect(new IncrementalSha256().update(input).digestHex(), `length ${length}`).toBe(reference(input));
      const bytewise = new IncrementalSha256();
      for (let i = 0; i < length; i += 1) bytewise.update(input.subarray(i, i + 1));
      expect(bytewise.digestHex(), `length ${length}, byte by byte`).toBe(reference(input));
    }
  });

  it.each([55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 183, 184, 191, 192])(
    'pads a %i-byte input right, wherever it is cut and resumed from a saved midstate',
    (length) => {
      const data = new Uint8Array(randomBytes(length));
      for (let cut = 0; cut <= length; cut += 1) {
        expect(acrossProcesses(pieces(data, [cut])), `cut at ${cut}`).toBe(reference(data));
      }
    },
  );

  it('equals node:crypto on random inputs cut at random chunk boundaries, resumed from a saved midstate each time (property)', () => {
    for (let run = 0; run < 300; run += 1) {
      const length = run < 250 ? randomInt(0, 1100) : randomInt(0, 3 * 1024 * 1024);
      const data = new Uint8Array(randomBytes(length));
      const cuts = randomCuts(length, run < 250 ? 12 : 40);
      expect(acrossProcesses(pieces(data, cuts)), `run ${run}: length ${length}, cuts ${cuts.join(',')}`).toBe(reference(data));
    }
  });

  it('digestHex leaves the state as it was: the hash goes on after a digest', () => {
    const data = new Uint8Array(randomBytes(300));
    const hash = new IncrementalSha256().update(data.subarray(0, 100));
    expect(hash.digestHex()).toBe(reference(data.subarray(0, 100)));
    expect(hash.digestHex()).toBe(reference(data.subarray(0, 100)));
    expect(hash.update(data.subarray(100)).digestHex()).toBe(reference(data));
    expect(hash.length).toBe(300);
  });

  it('copies what it is given and what it hands out: a midstate never shares memory with the hash', () => {
    const data = new Uint8Array(randomBytes(70));
    const expected = reference(data);
    const hash = new IncrementalSha256().update(data);
    const m = hash.midstate();
    expect(m.length).toBe(70);
    expect(m.pending).toEqual(data.subarray(64));
    expect(m.h).toHaveLength(8);
    for (const word of m.h) expect(Number.isInteger(word) && word >= 0 && word < 2 ** 32).toBe(true);
    const restored = IncrementalSha256.fromMidstate(m);
    data.fill(0); // the caller reuses its buffer
    m.pending.fill(0); // and the midstate's
    expect(hash.digestHex()).toBe(expected);
    expect(restored.digestHex()).toBe(expected);
  });
});

describe('encodeSha256Midstate / decodeSha256Midstate', () => {
  it('round-trips a midstate as a small JSON text', () => {
    const m = new IncrementalSha256().update(new Uint8Array(randomBytes(130))).midstate();
    const text = encodeSha256Midstate(m);
    expect(text.length).toBeLessThan(400);
    expect(JSON.parse(text)).toEqual({ v: 1, length: 130, h: expect.stringMatching(/^[0-9a-f]{64}$/), pending: expect.stringMatching(/^[0-9a-f]{4}$/) });
    expect(decodeSha256Midstate(text)).toEqual(m);
  });

  const good = JSON.parse(encodeSha256Midstate(new IncrementalSha256().update(new Uint8Array(70)).midstate())) as Record<string, unknown>;

  it.each<[string, string]>([
    ['not JSON', '{"v":1,'],
    ['an array', '[]'],
    ['null', 'null'],
    ['another version', JSON.stringify({ ...good, v: 2 })],
    ['a fractional length', JSON.stringify({ ...good, length: 70.5 })],
    ['a negative length', JSON.stringify({ ...good, length: -1 })],
    ['an unsafe length', JSON.stringify({ ...good, length: 2 ** 53 })],
    ['a short chaining value', JSON.stringify({ ...good, h: 'ab'.repeat(31) })],
    ['upper-case hex', JSON.stringify({ ...good, h: String(good['h']).toUpperCase() })],
    ['pending bytes that do not match the length', JSON.stringify({ ...good, pending: '00'.repeat(7) })],
    ['odd pending hex', JSON.stringify({ ...good, pending: '000' })],
    ['an extra key', JSON.stringify({ ...good, extra: 1 })],
    ['a missing key', JSON.stringify({ v: 1, length: 70, h: good['h'] })],
  ])('refuses %s (null: the caller rebuilds the digest from the staged bytes)', (_what, text) => {
    expect(decodeSha256Midstate(text)).toBeNull();
  });

  it('fromMidstate refuses a midstate that is not consistent', () => {
    const m = new IncrementalSha256().update(new Uint8Array(70)).midstate();
    const bad: Sha256Midstate[] = [
      { ...m, h: m.h.slice(0, 7) },
      { ...m, h: [...m.h.slice(0, 7), 2 ** 32] },
      { ...m, pending: new Uint8Array(5) },
      { ...m, length: -6 },
    ];
    for (const midstate of bad) expect(() => IncrementalSha256.fromMidstate(midstate)).toThrow(TypeError);
  });
});
