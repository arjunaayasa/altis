import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { decodeBase64Url, parseStrictJson } from '@altis/crypto';
import type { Dialect } from '@altis/db';
import { ALTISBAK_ENTRY, ensureHeadroom, extractedEntryPath, writeStreamAtomic, type DataPath } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { z } from 'zod';
import { BACKUP_PATH_TABLES } from '../backup/canonical.js';
import { BACKUP_FORMAT, backupManifestSchema, parseManifestJson, type BackupManifest } from '../backup/manifest.js';
import { ARCHIVE_SALT_BYTES, ARCHIVE_SCRYPT, DEK_BYTES, deriveKek, unwrapDek } from './kdf.js';
import { STREAM_CHUNK, decryptStream, plainSizeOf } from './stream-cipher.js';
import { openArchive, type ArchiveEntry, type ArchiveReader } from './zip-reader.js';

// The `.altisbak` archive (spec §9.9 "Download", §9.10, decision C13): a ZIP64 file of stored entries
//
//   altisbak.json                      the clear header (always the first entry, never encrypted)
//   manifest.json                      the backup manifest (Task 11), re-made for the archive (Task 21)
//   tables/<table>/<nnnnn>.jsonl.gz    the parts, as the backup holds them (secret columns re-sealed or left out)
//   blobs/<sha256>                     the upload blobs
//
// written by zip64-writer.ts. With `encryption` set every entry but the header is STREAM-encrypted with the DEK
// (stream-cipher.ts), which the header carries wrapped by the passphrase's KEK (kdf.ts). The header's descriptive
// fields (`appVersion`, `schemaVersion`, `dialect`, `consistency`) are no secret: they let an uploaded encrypted
// archive get its `backups` row before anyone typed the passphrase (S15). The manifest repeats them, and reading it
// checks that both agree.
//
// openAltisbak reads an archive through the guarded reader (zip-reader.ts, allowlist ALTISBAK_ENTRY) and offers the
// manifest (read by backup/manifest.ts's parseManifestJson like every manifest: a later release's fields are left out,
// under the whole-object HMAC form, ruling R1d-3), the lines of a part (gunzipped under the bound min(bytes × 1.1, headroom), spec §7.5), a blob (checked
// against its name) and a resumable extraction into tmp/<opId>/src/ (S14).

/** The first entry of every archive. */
export const ALTISBAK_HEADER_ENTRY = 'altisbak.json';
/** The `encryption.alg` of format altis-backup/1. */
export const ALTISBAK_STREAM_ALG = 'aes-256-gcm-stream-1';

/** The most bytes a header may have (it is a few hundred). */
const HEADER_MAX_BYTES = 64 * 1024;
/** The most plaintext bytes a manifest may have (as readManifest allows). */
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const MANIFEST_ENTRY = 'manifest.json';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,59}$/;
const PART_MAX = 99_999;

/** The clear header `altisbak.json`. */
export interface AltisbakHeader {
  format: 'altis-backup/1';
  backupId: string;
  appVersion: string;
  schemaVersion: string;
  dialect: Dialect;
  consistency: 'snapshot' | 'frozen';
  secrets: 'keyring' | 'archive' | 'omitted';
  encryption: null | {
    alg: 'aes-256-gcm-stream-1';
    chunkBytes: 1048576;
    kdf: { alg: 'scrypt'; N: number; r: number; p: number; salt: string };
    /** The DEK wrapped with the KEK (kdf.ts wrapDek). */
    dek: { iv: string; ct: string };
  };
}

const base64UrlBytes = (bytes: number): z.ZodType<string> =>
  z
    .string()
    .max(256)
    .refine((s) => decodeBase64Url(s)?.byteLength === bytes, `must be ${bytes} bytes as unpadded base64url`);

const manifestFields = backupManifestSchema.shape;

/**
 * The shape of `altisbak.json` (strict). The KDF parameters must be exactly {@link ARCHIVE_SCRYPT}'s: a hostile
 * header could otherwise ask for an scrypt that takes minutes or gigabytes. `secrets: 'archive'` needs encryption
 * (the column key comes from the DEK).
 */
export const altisbakHeaderSchema = z
  .strictObject({
    format: z.literal(BACKUP_FORMAT),
    backupId: manifestFields.backupId,
    appVersion: manifestFields.appVersion,
    schemaVersion: manifestFields.schemaVersion,
    dialect: manifestFields.dialect,
    consistency: manifestFields.consistency,
    secrets: manifestFields.secrets,
    encryption: z
      .strictObject({
        alg: z.literal(ALTISBAK_STREAM_ALG),
        chunkBytes: z.literal(STREAM_CHUNK),
        kdf: z.strictObject({
          alg: z.literal('scrypt'),
          N: z.literal(ARCHIVE_SCRYPT.N),
          r: z.literal(ARCHIVE_SCRYPT.r),
          p: z.literal(ARCHIVE_SCRYPT.p),
          salt: base64UrlBytes(ARCHIVE_SALT_BYTES),
        }),
        dek: z.strictObject({ iv: base64UrlBytes(IV_BYTES), ct: base64UrlBytes(DEK_BYTES + TAG_BYTES) }),
      })
      .nullable(),
  })
  .refine((h) => h.secrets !== 'archive' || h.encryption !== null, 'secrets "archive" needs encryption') satisfies z.ZodType<AltisbakHeader>;

function invalid(reason: 'format' | 'entry' | 'checksum' | 'bomb', why: string, cause?: unknown): DomainError {
  return new DomainError('BACKUP_INVALID', {
    detail: `Arsip backup ditolak: ${why} / The backup archive is refused: ${why}`,
    meta: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The whole of `source`, refused (`format`) past `max` bytes. */
async function readAll(source: AsyncIterable<Uint8Array>, max: number, what: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > max) throw invalid('format', `${what} lebih dari ${max} byte / ${what} is larger than ${max} bytes`);
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts, total);
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** `bytes` as JSON (UTF-8, strict: no duplicate keys), or BACKUP_INVALID `format`. */
function jsonOf(bytes: Uint8Array, what: string): unknown {
  try {
    return parseStrictJson(UTF8.decode(bytes));
  } catch (error) {
    throw invalid('format', `${what} bukan JSON yang sah / ${what} is not valid JSON`, error);
  }
}

/** The first entry, `altisbak.json`, stored (every entry of an `.altisbak` is), parsed and checked. */
async function readHeader(reader: ArchiveReader): Promise<AltisbakHeader> {
  const entries = reader.entries();
  const first = entries[0];
  if (first === undefined || first.name !== ALTISBAK_HEADER_ENTRY) {
    throw invalid('format', `entri pertama bukan ${ALTISBAK_HEADER_ENTRY} / the first entry is not ${ALTISBAK_HEADER_ENTRY}`);
  }
  for (const e of entries) {
    if (e.method !== 0) throw invalid('format', `entri ${e.name} terkompresi / the entry ${e.name} is compressed`);
  }
  const parsed = altisbakHeaderSchema.safeParse(jsonOf(await readAll(reader.read(first), HEADER_MAX_BYTES, ALTISBAK_HEADER_ENTRY), ALTISBAK_HEADER_ENTRY));
  if (!parsed.success) throw invalid('format', `${ALTISBAK_HEADER_ENTRY} tidak sesuai format / ${ALTISBAK_HEADER_ENTRY} does not fit the format`);
  return parsed.data;
}

/**
 * The clear header of the archive `path`, without any passphrase (S15: an uploaded archive gets its `backups` row
 * from it).
 *
 * @throws DomainError BACKUP_INVALID (`format` for a missing or malformed header, or any refusal of the guarded
 *   reader)
 */
export async function readAltisbakHeader(path: DataPath): Promise<AltisbakHeader> {
  const reader = await openArchive(path, { allow: ALTISBAK_ENTRY });
  try {
    return await readHeader(reader);
  } finally {
    await reader.close();
  }
}

export interface OpenAltisbakOptions {
  /** The passphrase of an encrypted archive (ignored for a plain one). */
  passphrase?: string;
  /** Instead of the passphrase: the KEK derived from it earlier (a restore keeps the KEK, never the passphrase). */
  kek?: Uint8Array;
  /** The free space the caller may fill: the gunzip bound of a part is min(bytes × 1.1, headroomBytes). */
  headroomBytes: number;
  /** DATA_DIR, for extractTo. */
  dataDir?: string;
  /** The code's table registry (default BACKUP_PATH_TABLES), for extractTo's paths. */
  tables?: ReadonlySet<string>;
  /** The clock extractTo's deadline is compared with (epoch ms; default Date.now). */
  clock?: () => number;
  /** The guarded reader's bound on the number of entries. */
  maxEntries?: number;
}

/** What extractTo has done so far: the entries before index `entry` are extracted. */
export interface ExtractCheckpoint {
  entry: number;
}

export interface AltisbakSource {
  readonly header: AltisbakHeader;
  /** The archive's DEK (null for a plain archive): `columnKey(dek)` opens its archive-sealed secrets (branch b). */
  readonly dek: Uint8Array | null;
  /** The entry names, in archive order (the header first). */
  entryNames(): readonly string[];
  /**
   * The manifest, read by parseManifestJson (the fields this release knows, checked against the backup manifest
   * schema; a later release's fields set aside under the whole-object HMAC form, ruling R1d-3) and checked against the
   * header's descriptive fields.
   *
   * @throws DomainError BACKUP_INVALID `format`
   */
  manifest(): Promise<BackupManifest>;
  /**
   * The lines (without their `\n`) of part `n` of `table`, decrypted and gunzipped under the bound
   * min(declaredBytes × 1.1, headroomBytes).
   *
   * @throws TypeError at once for a table name or part number that cannot name a part, or a negative size
   * @throws (while reading) DomainError BACKUP_INVALID `bomb` past the bound, `format` (no such part, not gzip, not
   *   UTF-8), `checksum` (a STREAM tag, the CRC-32)
   */
  partLines(table: string, n: number, declaredBytes: number): AsyncIterable<string>;
  /**
   * The bytes of the blob `sha256`, decrypted; their SHA-256 is checked against the name after the last byte.
   *
   * @throws TypeError at once for a name that is not 64 lower-case hex digits
   * @throws (while reading) DomainError BACKUP_INVALID `format` (no such blob), `checksum`
   */
  blob(sha256: string): AsyncIterable<Uint8Array>;
  /**
   * Extracts the entries, decrypted, one by one to `extractedEntryPath(dataDir, opId, entry, tables)` through
   * writeStreamAtomic (S14: an entry is there whole or not at all), starting at `checkpoint.entry`. A part must match
   * its manifest SHA-256 and a blob its name, or nothing of it is kept. Always extracts at least one entry, then
   * stops once `clock() ≥ deadline`. `ensureHeadroom(dataDir, the bytes still to extract)` comes first.
   *
   * @throws TypeError without `dataDir`, or for a checkpoint outside the archive
   * @throws DomainError BACKUP_INVALID (`checksum`, `entry` for a part or blob the manifest does not list or a table
   *   the code does not know), DISK_QUOTA (P21), INVALID_PATH_SEGMENT for an `opId` that is not a ULID
   */
  extractTo(opId: string, o: { deadline: number; checkpoint: ExtractCheckpoint | null }): Promise<{ done: boolean; checkpoint: ExtractCheckpoint }>;
  /** Closes the archive file. */
  close(): Promise<void>;
}

function passphraseRequired(): DomainError {
  return new DomainError('BACKUP_PASSPHRASE_REQUIRED', {
    detail: 'Arsip ini terenkripsi; masukkan frasa sandinya / This archive is encrypted; enter its passphrase',
  });
}

/** `tables/<table>/<n, 5 digits>.jsonl.gz`. @throws TypeError when it cannot name a part */
function partEntryName(table: string, n: number): string {
  if (typeof table !== 'string' || !TABLE_NAME.test(table)) throw new TypeError(`partLines: ${JSON.stringify(table)} is not a table name`);
  if (!Number.isInteger(n) || n < 0 || n > PART_MAX) throw new TypeError(`partLines: part ${String(n)} is not a part number`);
  return `tables/${table}/${String(n).padStart(5, '0')}.jsonl.gz`;
}

/** The plaintext bytes of `source`, gunzipped, refused (`bomb`) past `limit` bytes. */
async function* gunzipBounded(source: AsyncIterable<Uint8Array>, limit: number, name: string): AsyncGenerator<Buffer, void, undefined> {
  const input = Readable.from(source, { objectMode: false });
  const gunzip = createGunzip();
  input.on('error', (error) => gunzip.destroy(error));
  input.pipe(gunzip);
  let produced = 0;
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      produced += chunk.byteLength;
      if (produced > limit) {
        throw invalid('bomb', `${name} mengembang melebihi ${limit} byte / ${name} inflates past ${limit} bytes`);
      }
      yield chunk;
    }
  } catch (error) {
    if (isDomainError(error)) throw error;
    const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) throw error; // a file system error
    throw invalid('format', `${name} bukan gzip yang sah / ${name} is not valid gzip`, error);
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

/**
 * The longest line of a part, line feed excluded: far above any canonical row (a row's TEXT columns hold at most
 * 64 KiB each on MySQL/MariaDB, a few times that once JSON-escaped), so that a hostile part cannot make a reader hold
 * an unbounded line in memory.
 */
export const PART_LINE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The `\n`-separated lines of `source` (UTF-8, refused `format` when it is not, or when a line is longer than
 * {@link PART_LINE_MAX_BYTES}). The pieces of a line are kept as they come and joined once, when it ends.
 */
async function* linesOf(source: AsyncIterable<Buffer>, name: string): AsyncGenerator<string, void, undefined> {
  let pieces: Buffer[] = [];
  let pending = 0;
  const decode = (bytes: Buffer): string => {
    try {
      return UTF8.decode(bytes);
    } catch (error) {
      throw invalid('format', `${name} bukan UTF-8 yang sah / ${name} is not valid UTF-8`, error);
    }
  };
  const take = (piece: Buffer): void => {
    pending += piece.byteLength;
    if (pending > PART_LINE_MAX_BYTES) {
      throw invalid(
        'format',
        `${name} memuat baris lebih panjang dari ${PART_LINE_MAX_BYTES} byte / ${name} holds a line longer than ${PART_LINE_MAX_BYTES} bytes`,
      );
    }
    if (piece.byteLength > 0) pieces.push(piece);
  };
  const line = (): string => {
    const bytes = pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces, pending);
    pieces = [];
    pending = 0;
    return decode(bytes);
  };
  for await (const chunk of source) {
    let start = 0;
    for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, start)) {
      take(chunk.subarray(start, at));
      yield line();
      start = at + 1;
    }
    if (start < chunk.byteLength) take(chunk.subarray(start));
  }
  if (pending > 0) yield line();
}

/** `source` passed through, its SHA-256 compared with `expected` after the last byte (`checksum`). */
async function* hashChecked(source: AsyncIterable<Uint8Array>, expected: string, name: string): AsyncGenerator<Uint8Array, void, undefined> {
  const hash = createHash('sha256');
  for await (const chunk of source) {
    hash.update(chunk);
    yield chunk;
  }
  if (hash.digest('hex') !== expected) {
    throw invalid('checksum', `SHA-256 ${name} tidak cocok / the SHA-256 of ${name} does not match`);
  }
}

/** Whether the manifest's descriptive fields are the header's. */
function agrees(m: BackupManifest, h: AltisbakHeader): boolean {
  return (
    m.backupId === h.backupId &&
    m.appVersion === h.appVersion &&
    m.schemaVersion === h.schemaVersion &&
    m.dialect === h.dialect &&
    m.consistency === h.consistency &&
    m.secrets === h.secrets
  );
}

/**
 * Opens the `.altisbak` archive `path`: the guarded reader (allowlist ALTISBAK_ENTRY), the header (first entry,
 * every entry stored), and for an encrypted archive the DEK, unwrapped with `kek` or with the KEK derived from
 * `passphrase` (scrypt: call this outside any transaction).
 *
 * @throws DomainError BACKUP_PASSPHRASE_REQUIRED (encrypted, neither passphrase nor KEK), BACKUP_PASSPHRASE_INVALID,
 *   VALIDATION_FAILED (a passphrase too short), BACKUP_INVALID (`format`: no or a malformed header, a compressed
 *   entry, an entry too short to be encrypted; and the reader's refusals)
 * @throws TypeError for options that are not valid (both `passphrase` and `kek`, a negative `headroomBytes`, ...)
 */
export async function openAltisbak(path: DataPath, o: OpenAltisbakOptions): Promise<AltisbakSource> {
  if (!Number.isSafeInteger(o?.headroomBytes) || o.headroomBytes < 0) {
    throw new TypeError('openAltisbak: headroomBytes must be a non-negative safe integer');
  }
  if (o.passphrase !== undefined && o.kek !== undefined) throw new TypeError('openAltisbak: pass a passphrase or a KEK, not both');
  if (o.clock !== undefined && typeof o.clock !== 'function') throw new TypeError('openAltisbak: clock must be a function');
  const headroom = o.headroomBytes;
  const clock = o.clock ?? Date.now;
  const tables = o.tables ?? BACKUP_PATH_TABLES;

  const reader = await openArchive(path, { allow: ALTISBAK_ENTRY, ...(o.maxEntries === undefined ? {} : { maxEntries: o.maxEntries }) });
  let header: AltisbakHeader;
  let dek: Uint8Array | null = null;
  const plainSizes = new Map<string, number>();
  try {
    header = await readHeader(reader);
    for (const e of reader.entries()) {
      const plain = header.encryption === null || e.name === ALTISBAK_HEADER_ENTRY ? e.size : plainSizeOf(e.size);
      if (plain === null) throw invalid('format', `entri ${e.name} terlalu pendek untuk dienkripsi / the entry ${e.name} is too short to be encrypted`);
      plainSizes.set(e.name, plain);
    }
    if (header.encryption !== null) {
      let kek = o.kek;
      if (kek === undefined) {
        if (o.passphrase === undefined) throw passphraseRequired();
        kek = await deriveKek(o.passphrase, decodeBase64Url(header.encryption.kdf.salt)!);
      }
      dek = unwrapDek(kek, header.encryption.dek);
    }
  } catch (error) {
    await reader.close();
    throw error;
  }

  const entries = reader.entries();
  const byName = new Map<string, ArchiveEntry>(entries.map((e) => [e.name, e]));
  const key = dek;
  const sourceHeader = header;

  /** The plaintext of entry `e`: decrypted with the DEK, except the header. */
  const plain = (e: ArchiveEntry): AsyncIterable<Uint8Array> =>
    key === null || e.name === ALTISBAK_HEADER_ENTRY ? reader.read(e) : decryptStream(key, e.name, reader.read(e));

  const entryOrFail = (name: string): ArchiveEntry => {
    const e = byName.get(name);
    if (e === undefined) throw invalid('format', `${name} tidak ada di arsip / ${name} is missing from the archive`);
    return e;
  };

  let manifestPromise: Promise<BackupManifest> | null = null;
  const manifest = (): Promise<BackupManifest> => {
    manifestPromise ??= (async () => {
      const e = entryOrFail(MANIFEST_ENTRY);
      const json = jsonOf(await readAll(plain(e), MANIFEST_MAX_BYTES, MANIFEST_ENTRY), MANIFEST_ENTRY);
      const parsed = parseManifestJson(json);
      if (!parsed.ok) throw invalid('format', `${MANIFEST_ENTRY} tidak sesuai format / ${MANIFEST_ENTRY} does not fit the format`);
      if (!agrees(parsed.manifest, sourceHeader)) {
        throw invalid('format', `${MANIFEST_ENTRY} tidak sesuai dengan ${ALTISBAK_HEADER_ENTRY} / ${MANIFEST_ENTRY} disagrees with ${ALTISBAK_HEADER_ENTRY}`);
      }
      return parsed.manifest;
    })();
    return manifestPromise;
  };

  /** The SHA-256 an extracted part or blob must have; `entry` when the manifest does not list it. */
  const expectedSha = (name: string, m: BackupManifest): string | null => {
    const part = /^tables\/([a-z][a-z0-9_]{0,59})\/(\d{5})\.jsonl\.gz$/.exec(name);
    if (part !== null) {
      const listed = Object.hasOwn(m.tables, part[1]!) ? m.tables[part[1]!]!.parts.find((p) => p.n === Number(part[2])) : undefined;
      if (listed === undefined) throw invalid('entry', `${name} tidak tercantum di manifest / ${name} is not in the manifest`);
      return listed.sha256;
    }
    if (name.startsWith('blobs/')) {
      const sha = name.slice('blobs/'.length);
      if (!m.blobs.some((b) => b.sha256 === sha)) throw invalid('entry', `${name} tidak tercantum di manifest / ${name} is not in the manifest`);
      return sha;
    }
    return null; // the header and the manifest
  };

  return {
    header: sourceHeader,
    dek: key,
    entryNames: () => entries.map((e) => e.name),
    manifest,
    partLines(table, n, declaredBytes) {
      const name = partEntryName(table, n);
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
        throw new TypeError('partLines: declaredBytes must be a non-negative safe integer');
      }
      const limit = Math.min(declaredBytes + Math.floor(declaredBytes / 10), headroom);
      return (async function* () {
        yield* linesOf(gunzipBounded(plain(entryOrFail(name)), limit, name), name);
      })();
    },
    blob(sha256) {
      if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) throw new TypeError('blob: the name must be 64 lower-case hex digits');
      const name = `blobs/${sha256}`;
      return (async function* () {
        yield* hashChecked(plain(entryOrFail(name)), sha256, name);
      })();
    },
    async extractTo(opId, s) {
      if (typeof o.dataDir !== 'string') throw new TypeError('extractTo: openAltisbak needs dataDir');
      const dataDir = o.dataDir;
      if (typeof s?.deadline !== 'number' || Number.isNaN(s.deadline)) throw new TypeError('extractTo: deadline must be a number');
      const start = s.checkpoint === null ? 0 : s.checkpoint?.entry;
      if (!Number.isSafeInteger(start) || start < 0 || start > entries.length) {
        throw new TypeError(`extractTo: the checkpoint must name an entry from 0 to ${entries.length}`);
      }
      if (start === entries.length) return { done: true, checkpoint: { entry: start } };
      const rest = entries.slice(start);
      const m = rest.some((e) => expectsHash(e.name)) ? await manifest() : null;
      let bytes = 0;
      for (const e of rest) bytes += plainSizes.get(e.name)!;
      await ensureHeadroom(dataDir, bytes);
      for (let i = start; i < entries.length; i += 1) {
        const e = entries[i]!;
        const table = /^tables\/([^/]+)\//.exec(e.name)?.[1];
        if (table !== undefined && !tables.has(table)) {
          throw invalid('entry', `tabel ${table} tidak dikenal / the table ${table} is unknown`);
        }
        const expected = m === null ? null : expectedSha(e.name, m);
        const content = expected === null ? plain(e) : hashChecked(plain(e), expected, e.name);
        await writeStreamAtomic(extractedEntryPath(dataDir, opId, e.name, tables), content);
        if (i + 1 < entries.length && clock() >= s.deadline) return { done: false, checkpoint: { entry: i + 1 } };
      }
      return { done: true, checkpoint: { entry: entries.length } };
    },
    close: () => reader.close(),
  };
}

/** Whether an extracted entry is checked against a SHA-256 (a part or a blob). */
function expectsHash(name: string): boolean {
  return name.startsWith('tables/') || name.startsWith('blobs/');
}
