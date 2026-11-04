import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { encodeBase64Url } from '@altis/crypto';
import { dataPath, extractedEntryPath, type DataPath } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PART_LINE_MAX_BYTES, openAltisbak, readAltisbakHeader, type AltisbakHeader, type AltisbakSource } from '../../src/archive/altisbak.js';
import { ARCHIVE_SALT_BYTES, deriveKek, wrapDek } from '../../src/archive/kdf.js';
import { openAltisbakWriter } from '../../src/archive/zip64-writer.js';
import { BACKUP_PATH_TABLES } from '../../src/backup/canonical.js';
import { manifestHmac, unknownManifestFields, verifyManifestHmac, type BackupManifest } from '../../src/backup/manifest.js';
import { openRestoreSource } from '../../src/restore/source.js';
import { rawZip } from '../helpers/raw-zip.js';

// The `.altisbak` source (spec §9.10 step "verifying", §7.5): the clear header, the passphrase, the manifest, parts as
// lines with the gunzip bound min(bytes × 1.1, headroom), blobs verified by their name, and a resumable extraction
// into tmp/<opId>/src/.

const PASSPHRASE = 'kata sandi arsip yang panjang';
const SALT = new Uint8Array(ARCHIVE_SALT_BYTES).fill(8);
const BACKUP_ID = '01JBQ7T1D1V6B3R6Z8Y2Q5W4XA';

let kek: Uint8Array;
let dataDir: string;
const opened: AltisbakSource[] = [];

beforeAll(async () => {
  kek = await deriveKek(PASSPHRASE, SALT);
});

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-altisbak-'));
});

afterEach(async () => {
  for (const source of opened.splice(0)) await source.close();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const LINES_1 = ['{"code":"PUSAT","id":1}', '{"code":"CABANG","id":2}'];
const LINES_2 = ['{"code":"DESA","id":3}'];
const PLAIN_1 = Buffer.from(LINES_1.map((l) => `${l}\n`).join(''));
const PLAIN_2 = Buffer.from(LINES_2.map((l) => `${l}\n`).join(''));
const PART_1 = gzipSync(PLAIN_1);
const PART_2 = gzipSync(PLAIN_2);
const BLOB = randomBytes(1_500_000);
const BLOB_SHA = sha256(BLOB);

function manifestFor(secrets: AltisbakHeader['secrets']): BackupManifest {
  return {
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
    secrets,
    tables: {
      branches: {
        class: 'data',
        columns: ['id', 'code'],
        rows: 3,
        checksum: 'c'.repeat(64),
        parts: [
          { n: 1, rows: 2, firstPk: [1], lastPk: [2], sha256: sha256(PART_1), bytes: PLAIN_1.byteLength },
          { n: 2, rows: 1, firstPk: [3], lastPk: [3], sha256: sha256(PART_2), bytes: PLAIN_2.byteLength },
        ],
      },
    },
    blobs: [{ sha256: BLOB_SHA, size: BLOB.byteLength }],
    hmac: 'not-checked-here',
  };
}

function headerFor(dek: Uint8Array | null): AltisbakHeader {
  return {
    format: 'altis-backup/1',
    backupId: BACKUP_ID,
    appVersion: '0.1.0',
    schemaVersion: '0009_ops_jobs',
    dialect: 'sqlite',
    consistency: 'snapshot',
    secrets: dek === null ? 'keyring' : 'archive',
    encryption:
      dek === null
        ? null
        : {
            alg: 'aes-256-gcm-stream-1',
            chunkBytes: 1048576,
            kdf: { alg: 'scrypt', N: 65536, r: 8, p: 1, salt: encodeBase64Url(SALT) },
            dek: wrapDek(kek, dek),
          },
  };
}

function bytesSource(bytes: Uint8Array): (from: number) => AsyncIterable<Uint8Array> {
  return async function* (from: number) {
    for (let i = from; i < bytes.byteLength; i += 65_536) yield bytes.subarray(i, Math.min(i + 65_536, bytes.byteLength));
  };
}

interface Built {
  path: DataPath;
  dek: Uint8Array | null;
}

/** An archive of header, manifest, two `branches` parts and one blob; entries can be replaced. */
async function build(o: { encrypted: boolean; replace?: Record<string, Uint8Array>; manifest?: BackupManifest; backupId?: string }): Promise<Built> {
  const dek = o.encrypted ? randomBytes(32) : null;
  const p = dataPath(dataDir, 'backups', o.backupId ?? newId(), 'archive.altisbak');
  const manifest = o.manifest ?? manifestFor(o.encrypted ? 'archive' : 'keyring');
  const entries: [string, Uint8Array][] = [
    ['manifest.json', Buffer.from(JSON.stringify(manifest))],
    ['tables/branches/00001.jsonl.gz', PART_1],
    ['tables/branches/00002.jsonl.gz', PART_2],
    [`blobs/${BLOB_SHA}`, BLOB],
  ];
  const w = await openAltisbakWriter(p, { header: headerFor(dek), dek, checkpoint: null });
  for (const [name, original] of entries) {
    const bytes = o.replace?.[name] ?? original;
    await w.writeEntry(name, bytes.byteLength, bytesSource(bytes), { deadline: Number.POSITIVE_INFINITY });
  }
  await w.finish();
  return { path: p, dek };
}

async function source(p: DataPath, o: Partial<Parameters<typeof openAltisbak>[1]> = {}): Promise<AltisbakSource> {
  const s = await openAltisbak(p, { headroomBytes: 1024 * 1024 * 1024, dataDir, ...o });
  opened.push(s);
  return s;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function lines(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of it) out.push(line);
  return out;
}

async function bytesOf(it: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of it) out.push(Buffer.from(chunk));
  return Buffer.concat(out);
}

function codeOf(error: unknown): string {
  if (!isDomainError(error)) throw error;
  return error.code;
}

function reasonOf(error: unknown): unknown {
  if (!isDomainError(error) || error.code !== 'BACKUP_INVALID') throw error;
  return error.meta?.['reason'];
}

describe('openAltisbak: passphrase', () => {
  it('refuses an encrypted archive without a passphrase with BACKUP_PASSPHRASE_REQUIRED', async () => {
    const { path: p } = await build({ encrypted: true });
    expect(codeOf(await rejection(openAltisbak(p, { headroomBytes: 1 << 30 })))).toBe('BACKUP_PASSPHRASE_REQUIRED');
  });

  it('refuses the wrong passphrase with BACKUP_PASSPHRASE_INVALID', async () => {
    const { path: p } = await build({ encrypted: true });
    const error = await rejection(openAltisbak(p, { headroomBytes: 1 << 30, passphrase: 'bukan kata sandinya' }));
    expect(codeOf(error)).toBe('BACKUP_PASSPHRASE_INVALID');
  }, 30_000);

  it('reads the clear header of an encrypted archive without the passphrase (an upload gets its row first, S15)', async () => {
    const { path: p } = await build({ encrypted: true });
    const h = await readAltisbakHeader(p);
    expect(h.backupId).toBe(BACKUP_ID);
    expect(h.dialect).toBe('sqlite');
    expect(h.schemaVersion).toBe('0009_ops_jobs');
    expect(h.encryption?.kdf.N).toBe(65536);
  });

  for (const how of ['passphrase', 'kek'] as const) {
    it(`opens an encrypted archive with its ${how}: header, manifest, part lines and blob`, async () => {
      const built = await build({ encrypted: true });
      const s = await source(built.path, how === 'passphrase' ? { passphrase: PASSPHRASE } : { kek });
      expect(s.header.encryption?.alg).toBe('aes-256-gcm-stream-1');
      expect(Buffer.from(s.dek!).equals(Buffer.from(built.dek!))).toBe(true);
      expect(await s.manifest()).toEqual(manifestFor('archive'));
      expect(await lines(s.partLines('branches', 1, PLAIN_1.byteLength))).toEqual(LINES_1);
      expect(await lines(s.partLines('branches', 2, PLAIN_2.byteLength))).toEqual(LINES_2);
      expect((await bytesOf(s.blob(BLOB_SHA))).equals(BLOB)).toBe(true);
      expect(s.entryNames()).toEqual([
        'altisbak.json',
        'manifest.json',
        'tables/branches/00001.jsonl.gz',
        'tables/branches/00002.jsonl.gz',
        `blobs/${BLOB_SHA}`,
      ]);
    }, 30_000);
  }

  it('opens a plain archive without a passphrase', async () => {
    const { path: p } = await build({ encrypted: false });
    const s = await source(p);
    expect(s.dek).toBeNull();
    expect((await s.manifest()).secrets).toBe('keyring');
    expect(await lines(s.partLines('branches', 1, PLAIN_1.byteLength))).toEqual(LINES_1);
  });
});

describe('openAltisbak: refusals', () => {
  it('stops a part that inflates past min(bytes × 1.1, headroom) after at most 1100 bytes (bomb)', async () => {
    const huge = gzipSync(Buffer.from(`${'x'.repeat(99)}\n`.repeat(100_000))); // 10 MB of lines
    expect(huge.byteLength).toBeLessThan(100_000);
    const { path: p } = await build({ encrypted: false, replace: { 'tables/branches/00001.jsonl.gz': huge } });
    const s = await source(p);
    let produced = 0;
    let error: unknown;
    try {
      for await (const line of s.partLines('branches', 1, 1000)) produced += Buffer.byteLength(line) + 1;
    } catch (e) {
      error = e;
    }
    expect(reasonOf(error)).toBe('bomb');
    expect(produced).toBeLessThanOrEqual(1100);
    // the headroom bound applies too
    const tight = await source(p, { headroomBytes: 500 });
    expect(reasonOf(await rejection(lines(tight.partLines('branches', 1, 1_000_000_000))))).toBe('bomb');
  });

  it(`refuses a part line longer than ${PART_LINE_MAX_BYTES} bytes (format), and joins a long legal line from many pieces`, async () => {
    const long = `{"id":1,"note":"${'n'.repeat(3 * 1024 * 1024)}"}`; // gunzip yields it in 16 KiB pieces
    const endless = 'x'.repeat(PART_LINE_MAX_BYTES + 1); // one line, no line feed at all
    const parts = { 'tables/branches/00001.jsonl.gz': gzipSync(Buffer.from(`${long}\n{"id":2}\n`)), 'tables/branches/00002.jsonl.gz': gzipSync(endless) };
    const { path: p } = await build({ encrypted: false, replace: parts });
    const s = await source(p);
    expect(await lines(s.partLines('branches', 1, long.length + 20))).toEqual([long, '{"id":2}']);
    expect(reasonOf(await rejection(lines(s.partLines('branches', 2, 2 * PART_LINE_MAX_BYTES))))).toBe('format');
    const withFeed = await build({ encrypted: false, replace: { 'tables/branches/00002.jsonl.gz': gzipSync(`${endless}\n`) } });
    const t = await source(withFeed.path);
    expect(reasonOf(await rejection(lines(t.partLines('branches', 2, 2 * PART_LINE_MAX_BYTES))))).toBe('format');
  });

  it('refuses a blob whose bytes do not match its name, at the end of the read (checksum)', async () => {
    const { path: p } = await build({ encrypted: false, replace: { [`blobs/${BLOB_SHA}`]: randomBytes(10) } });
    const s = await source(p);
    expect(reasonOf(await rejection(bytesOf(s.blob(BLOB_SHA))))).toBe('checksum');
  });

  it('refuses an archive whose first entry is not altisbak.json, or whose header is not valid', async () => {
    const write = async (bytes: Buffer): Promise<DataPath> => {
      const p = dataPath(dataDir, 'backups', newId(), 'archive.altisbak');
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, bytes);
      return p;
    };
    const header = Buffer.from(JSON.stringify(headerFor(null)));
    const noHeaderFirst = await write(rawZip([{ name: 'manifest.json', data: Buffer.from('{}') }, { name: 'altisbak.json', data: header }]));
    expect(reasonOf(await rejection(openAltisbak(noHeaderFirst, { headroomBytes: 1 << 30 })))).toBe('format');
    const badHeader = await write(rawZip([{ name: 'altisbak.json', data: Buffer.from('{"format":"altis-backup/2"}') }]));
    expect(reasonOf(await rejection(openAltisbak(badHeader, { headroomBytes: 1 << 30 })))).toBe('format');
    expect(reasonOf(await rejection(readAltisbakHeader(badHeader)))).toBe('format');
    const weakKdf = JSON.parse(JSON.stringify(headerFor(randomBytes(32)))) as AltisbakHeader;
    weakKdf.encryption!.kdf.p = 64; // a hostile header asking for an expensive scrypt
    const hostile = await write(rawZip([{ name: 'altisbak.json', data: Buffer.from(JSON.stringify(weakKdf)) }]));
    expect(reasonOf(await rejection(openAltisbak(hostile, { headroomBytes: 1 << 30, passphrase: PASSPHRASE })))).toBe('format');
    const deflated = await write(rawZip([{ name: 'altisbak.json', data: header, method: 8 }]));
    expect(reasonOf(await rejection(openAltisbak(deflated, { headroomBytes: 1 << 30 })))).toBe('format');
  });

  it('refuses a manifest that disagrees with the clear header (format)', async () => {
    const other = { ...manifestFor('keyring'), dialect: 'mariadb' as const };
    const { path: p } = await build({ encrypted: false, manifest: other });
    const s = await source(p);
    expect(reasonOf(await rejection(s.manifest()))).toBe('format');
  });

  it('refuses a damaged encrypted entry (checksum)', async () => {
    const built = await build({ encrypted: true });
    const bytes = await fsp.readFile(built.path);
    const at = bytes.indexOf(Buffer.from('tables/branches/00001.jsonl.gz')) + 30 + 20 + 10; // inside the first part's data
    bytes[at] = bytes[at]! ^ 0xff;
    await fsp.writeFile(built.path, bytes);
    const s = await source(built.path, { kek });
    expect(reasonOf(await rejection(lines(s.partLines('branches', 1, PLAIN_1.byteLength))))).toBe('checksum');
  });
});

describe('a later release’s manifest fields (ruling R1d-3: one tolerant reader for every manifest)', () => {
  const KEY = new Uint8Array(32).fill(31);

  /** manifestFor(secrets) with a later release's fields at three levels, signed over the whole object with KEY. */
  function laterManifest(secrets: AltisbakHeader['secrets']): { known: BackupManifest; whole: Record<string, unknown> } {
    const { hmac: _unsigned, ...known } = manifestFor(secrets);
    void _unsigned;
    const whole: Record<string, unknown> = {
      ...structuredClone(known),
      futureField: { nested: [1, 2] },
      auditHead: { ...known.auditHead, chain: 'v2' },
    };
    const tables = whole['tables'] as Record<string, { parts: Record<string, unknown>[] }>;
    tables['branches']!.parts[1]!['codec'] = 'gzip';
    const hmac = manifestHmac(KEY, whole as unknown as BackupManifest);
    return { known: { ...known, hmac }, whole: { ...whole, hmac } };
  }

  for (const encrypted of [false, true]) {
    it(`openAltisbak (${encrypted ? 'encrypted' : 'plain'}): the known fields, the others named and covered by the HMAC`, async () => {
      const { known, whole } = laterManifest(encrypted ? 'archive' : 'keyring');
      const { path: p } = await build({ encrypted, manifest: whole as unknown as BackupManifest });
      const m = await (await source(p, encrypted ? { kek } : {})).manifest();
      expect(m).toEqual(known);
      expect(JSON.stringify(m)).not.toMatch(/futureField|chain|codec/);
      expect([...unknownManifestFields(m)].sort()).toEqual(['auditHead.chain', 'futureField', 'tables.branches.parts.1.codec']);
      expect(verifyManifestHmac(KEY, m)).toBe(true);
      expect(verifyManifestHmac(new Uint8Array(32).fill(1), m)).toBe(false);
    });
  }

  it('openAltisbak: an unknown field changed after signing fails the HMAC; a known field outside the schema is refused (format)', async () => {
    const { whole } = laterManifest('keyring');
    const { path: changed } = await build({ encrypted: false, manifest: { ...whole, futureField: 2 } as unknown as BackupManifest });
    const m = await (await source(changed)).manifest();
    expect(unknownManifestFields(m)).toContain('futureField');
    expect(verifyManifestHmac(KEY, m)).toBe(false);
    const { path: bad } = await build({ encrypted: false, manifest: { ...whole, kind: 'nightly' } as unknown as BackupManifest });
    expect(reasonOf(await rejection((await source(bad)).manifest()))).toBe('format');
  });

  it('openRestoreSource: the archive, then its extracted manifest.json, read the same way', async () => {
    const { known, whole } = laterManifest('archive');
    const backupId = newId();
    await build({ encrypted: true, manifest: whole as unknown as BackupManifest, backupId });
    const opId = newId();
    const base = { dataDir, backupId, source: 'archive' as const, kek, opId, headroomBytes: 1 << 30 };
    const first = await openRestoreSource(base);
    try {
      expect(first.manifest).toEqual(known);
      expect(verifyManifestHmac(KEY, first.manifest)).toBe(true);
      expect(await first.verify({ deadline: Number.POSITIVE_INFINITY, checkpoint: 0 })).toEqual({ done: true, checkpoint: 5 });
    } finally {
      await first.close();
    }
    const extracted = await openRestoreSource({ ...base, extracted: true });
    expect(extracted.manifest).toEqual(known);
    expect([...unknownManifestFields(extracted.manifest)].sort()).toEqual(['auditHead.chain', 'futureField', 'tables.branches.parts.1.codec']);
    expect(verifyManifestHmac(KEY, extracted.manifest)).toBe(true);
    await extracted.close();
  }, 30_000);
});

describe('AltisbakSource.extractTo', () => {
  it('extracts each entry (decrypted) through writeStreamAtomic, pausing after entry 2 and resuming at entry 3', async () => {
    const built = await build({ encrypted: true });
    let ticks = 0;
    const s = await source(built.path, { kek, clock: () => ++ticks });
    const opId = newId();
    const at = (entry: string): DataPath => extractedEntryPath(dataDir, opId, entry, BACKUP_PATH_TABLES);

    const first = await s.extractTo(opId, { deadline: 2, checkpoint: null });
    expect(first).toEqual({ done: false, checkpoint: { entry: 2 } });
    expect(JSON.parse((await fsp.readFile(at('altisbak.json'))).toString())).toEqual(s.header);
    expect(JSON.parse((await fsp.readFile(at('manifest.json'))).toString())).toEqual(manifestFor('archive'));
    await expect(fsp.stat(at('tables/branches/00001.jsonl.gz'))).rejects.toThrow();

    // Entries 1 and 2 are not extracted again: remove them and resume.
    await fsp.rm(at('altisbak.json'));
    await fsp.rm(at('manifest.json'));
    const second = await s.extractTo(opId, { deadline: Number.POSITIVE_INFINITY, checkpoint: JSON.parse(JSON.stringify(first.checkpoint)) });
    expect(second).toEqual({ done: true, checkpoint: { entry: 5 } });
    await expect(fsp.stat(at('altisbak.json'))).rejects.toThrow();
    expect((await fsp.readFile(at('tables/branches/00001.jsonl.gz'))).equals(PART_1)).toBe(true);
    expect((await fsp.readFile(at('tables/branches/00002.jsonl.gz'))).equals(PART_2)).toBe(true);
    expect((await fsp.readFile(at(`blobs/${BLOB_SHA}`))).equals(BLOB)).toBe(true);
    // nothing else (no temporary file) in the folder
    expect((await fsp.readdir(path.dirname(at('tables/branches/00001.jsonl.gz')))).sort()).toEqual(['00001.jsonl.gz', '00002.jsonl.gz']);

    // done is done
    expect(await s.extractTo(opId, { deadline: 0, checkpoint: second.checkpoint })).toEqual({ done: true, checkpoint: { entry: 5 } });
  }, 30_000);

  it('refuses a part whose bytes do not match the manifest, leaving no file (checksum)', async () => {
    const { path: p } = await build({ encrypted: false, replace: { 'tables/branches/00002.jsonl.gz': gzipSync(Buffer.from('{"id":9}\n')) } });
    const s = await source(p);
    const opId = newId();
    expect(reasonOf(await rejection(s.extractTo(opId, { deadline: Number.POSITIVE_INFINITY, checkpoint: null })))).toBe('checksum');
    await expect(fsp.stat(extractedEntryPath(dataDir, opId, 'tables/branches/00002.jsonl.gz', BACKUP_PATH_TABLES))).rejects.toThrow();
    expect((await fsp.readdir(path.dirname(extractedEntryPath(dataDir, opId, 'tables/branches/00001.jsonl.gz', BACKUP_PATH_TABLES))))).toEqual([
      '00001.jsonl.gz',
    ]);
  });

  it('needs dataDir', async () => {
    const { path: p } = await build({ encrypted: false });
    const s = await openAltisbak(p, { headroomBytes: 1 << 30 });
    opened.push(s);
    await expect(s.extractTo(newId(), { deadline: 0, checkpoint: null })).rejects.toThrow(TypeError);
  });
});
