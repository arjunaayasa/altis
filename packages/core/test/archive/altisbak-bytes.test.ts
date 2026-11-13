import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeBase64Url } from '@altis/crypto';
import { dataPath, type DataPath } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AltisbakHeader } from '../../src/archive/altisbak.js';
import { openAltisbakWriter, type AltisbakCheckpoint } from '../../src/archive/zip64-writer.js';

// The `.altisbak` writer is built on the shared resumable ZIP writer. Its bytes must not change: an archive written by
// an older version and one written now are the same file for the same input. The SHA-256 values below were recorded
// with the writer as it was before it moved onto the shared writer, for a fixed input shaped like the one of
// altisbak.test.ts (header, manifest, two table parts, one blob of more than one chunk), plain and encrypted, written
// in one go and with a pause after every chunk.

const BACKUP_ID = '01JBQ7T1D1V6B3R6Z8Y2Q5W4XA';
const DEK = new Uint8Array(32).fill(4);

/** Recorded before the change (see the comment above). */
const EXPECTED = {
  plain: '39d592b562a50c8e1e43982b2f0579b2c26e1083c55eb7a3b7d92d502e8046f7',
  encrypted: '3132b36cef153356a4f9935ca109cde9c631f821db7081f4d25806fb752d2eb3',
} as const;

let dataDir: string;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-altisbak-bytes-'));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

/** `n` bytes that only depend on `seed`: SHA-256 of a counter, end to end. */
function fixedBytes(seed: string, n: number): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0, have = 0; have < n; i += 1, have += 32) parts.push(createHash('sha256').update(`${seed}-${i}`).digest());
  return Buffer.concat(parts).subarray(0, n);
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const PART_1 = Buffer.from('{"code":"PUSAT","id":1}\n{"code":"CABANG","id":2}\n');
const PART_2 = Buffer.from('{"code":"DESA","id":3}\n');
const BLOB = fixedBytes('blob', 1_500_000);

function headerFor(encrypted: boolean): AltisbakHeader {
  return {
    format: 'altis-backup/1',
    backupId: BACKUP_ID,
    appVersion: '0.1.0',
    schemaVersion: '0009_ops_jobs',
    dialect: 'sqlite',
    consistency: 'snapshot',
    secrets: encrypted ? 'archive' : 'keyring',
    encryption: encrypted
      ? {
          alg: 'aes-256-gcm-stream-1',
          chunkBytes: 1048576,
          kdf: { alg: 'scrypt', N: 65536, r: 8, p: 1, salt: encodeBase64Url(new Uint8Array(16).fill(8)) },
          dek: { iv: encodeBase64Url(new Uint8Array(12).fill(3)), ct: encodeBase64Url(new Uint8Array(48).fill(5)) },
        }
      : null,
  };
}

function manifestFor(encrypted: boolean): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: 'altis-backup/1',
      backupId: BACKUP_ID,
      kind: 'manual',
      appVersion: '0.1.0',
      schemaVersion: '0009_ops_jobs',
      dialect: 'sqlite',
      createdAt: 1_800_000_000_000,
      consistency: 'snapshot',
      kids: ['k1'],
      installId: 'install-a',
      auditHead: { seq: 0, hash: '0'.repeat(64) },
      includesFiles: true,
      secrets: encrypted ? 'archive' : 'keyring',
      tables: {
        branches: {
          class: 'data',
          columns: ['id', 'code'],
          rows: 3,
          checksum: 'c'.repeat(64),
          parts: [
            { n: 1, rows: 2, firstPk: [1], lastPk: [2], sha256: sha256(PART_1), bytes: PART_1.byteLength },
            { n: 2, rows: 1, firstPk: [3], lastPk: [3], sha256: sha256(PART_2), bytes: PART_2.byteLength },
          ],
        },
      },
      blobs: [{ sha256: sha256(BLOB), size: BLOB.byteLength }],
      hmac: 'not-checked-here',
    }),
  );
}

/** A deterministic nonce-prefix source: SHA-256 of a counter. */
function counterRandom(): (n: number) => Uint8Array {
  let calls = 0;
  return (n) => {
    calls += 1;
    return createHash('sha256').update(`prefix-${calls}`).digest().subarray(0, n);
  };
}

function bytesSource(bytes: Uint8Array): (from: number) => AsyncIterable<Uint8Array> {
  return async function* (from: number) {
    for (let i = from; i < bytes.byteLength; i += 65_536) yield bytes.subarray(i, Math.min(i + 65_536, bytes.byteLength));
  };
}

/** The archive's bytes, written in one go or with a pause (and a new writer) after every chunk of a part or blob. */
async function build(encrypted: boolean, pauses: boolean): Promise<Buffer> {
  const p: DataPath = dataPath(dataDir, 'backups', newId(), 'archive.altisbak');
  const header = headerFor(encrypted);
  const dek = encrypted ? DEK : null;
  const random = counterRandom();
  const clock = (): number => 1000;
  const entries: [string, Buffer][] = [
    ['manifest.json', manifestFor(encrypted)],
    ['tables/branches/00001.jsonl.gz', PART_1],
    ['tables/branches/00002.jsonl.gz', PART_2],
    [`blobs/${sha256(BLOB)}`, BLOB],
  ];
  let w = await openAltisbakWriter(p, { header, dek, checkpoint: null, random, clock });
  let paused = 0;
  for (const [name, bytes] of entries) {
    for (;;) {
      const outcome = await w.writeEntry(name, bytes.byteLength, bytesSource(bytes), { deadline: pauses ? 0 : Number.POSITIVE_INFINITY });
      if (outcome === 'done') break;
      paused += 1;
      const cp = JSON.parse(JSON.stringify(w.checkpoint())) as AltisbakCheckpoint;
      w = await openAltisbakWriter(p, { header, dek, checkpoint: cp, random, clock });
    }
  }
  expect(paused).toBe(pauses ? 1 : 0); // the blob has two chunks
  const { size } = await w.finish();
  const bytes = await fsp.readFile(p);
  expect(size).toBe(bytes.byteLength);
  return bytes;
}

describe('openAltisbakWriter: the bytes of an archive do not change', () => {
  for (const encrypted of [false, true]) {
    const variant = encrypted ? 'encrypted' : 'plain';
    it(`writes the recorded archive for the fixed input (${variant}), in one go and with pauses`, async () => {
      expect(sha256(await build(encrypted, false))).toBe(EXPECTED[variant]);
      expect(sha256(await build(encrypted, true))).toBe(EXPECTED[variant]);
    });
  }
});
