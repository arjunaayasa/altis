import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { parseStrictJson } from '@altis/crypto';
import { backupPartPath, extractedEntryPath, openRead, readBytes, statOrNull, type DataPath } from '@altis/platform';
import { DomainError, isDomainError, isUlid } from '@altis/shared';
import { altisbakHeaderSchema, openAltisbak, type AltisbakHeader } from '../archive/altisbak.js';
import { unwrapDek } from '../archive/kdf.js';
import { blobPath } from '../backup/blobs.js';
import { BACKUP_PATH_TABLES } from '../backup/canonical.js';
import { BACKUP_FORMAT, parseManifestJson, readManifest, type BackupManifest, type BackupPart } from '../backup/manifest.js';
import { uploadedArchivePath } from '../backup/upload.js';

// What a restore reads (spec §9.10 steps 1–3, §7.5; preflight S14; plan Task 22): the backup being restored, as a
// folder of plaintext files whatever it came from.
//
// - `server`: a backup of this DATA_DIR, `backups/<id>/` (manifest.json, tables/<t>/<nnnnn>.jsonl.gz) with its upload
//   blobs in the shared `backups/blobs/<sha256>`. `verify` hashes every part listed in the manifest against its
//   SHA-256, one part per unit of work.
// - `archive`: an uploaded `.altisbak`, `backups/<id>/archive.altisbak` (Task 21). `verify` extracts it entry by entry,
//   decrypted, into `tmp/<opId>/src/` through the guarded reader (Task 12's extractTo: the allowlist, the bounds, a
//   part checked against its manifest SHA-256, a blob against its name, each entry written whole or not at all). Once
//   extracted (`extracted: true`), the source reads only the extracted files: the clear header and the manifest from
//   `src/altisbak.json` and `src/manifest.json`, the DEK unwrapped again with the KEK the op keeps sealed.
//
// Every manifest is read by backup/manifest.ts's parseManifestJson (readManifest, the archive reader, the extracted
// file): a later release's fields are set aside under the whole-object HMAC form (ruling R1d-3), and the restore
// decides whether they may be dropped (restore/runner.ts).
//
// Either way the parts are read back as gzip files on disk: `partLines` gunzips one under the bound
// min(manifest bytes × 1.1, headroom) (spec §7.5) and yields its lines; `partFile` names the file (the history parts
// a restore keeps beside the backup, `imported-<table>.jsonl.gz`).

/** The longest line of a part, line feed excluded (as altisbak.ts's PART_LINE_MAX_BYTES). */
const PART_LINE_MAX_BYTES = 8 * 1024 * 1024;
/** Bytes per read of a file. */
const READ_CHUNK_BYTES = 256 * 1024;
/** The most bytes of an extracted header or manifest (as readManifest). */
const HEADER_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A backup to restore, as its files on disk. */
export interface RestoreSource {
  readonly source: 'server' | 'archive';
  readonly backupId: string;
  /** The archive's clear header; for a server backup the same fields taken from its manifest (`encryption: null`). */
  readonly header: AltisbakHeader;
  readonly manifest: BackupManifest;
  /** The archive's DEK (an encrypted archive, branch b), else null. */
  readonly dek: Uint8Array | null;
  /**
   * Makes the parts readable and proves them: a server backup's parts hashed against the manifest, an archive's
   * entries extracted (each checked as it is written). `checkpoint` counts what is done (parts, or entries); at least
   * one unit of work, then until `deadline`.
   *
   * @throws DomainError BACKUP_INVALID (`checksum` for a part that is missing or does not match, the extraction's
   *   refusals), DISK_QUOTA (P21)
   */
  verify(o: { deadline: number; checkpoint: number }): Promise<{ done: boolean; checkpoint: number }>;
  /** The gzip file of part `n` of `table` (once verified). */
  partFile(table: string, n: number): DataPath;
  /**
   * The lines (without their `\n`) of part `n` of `table`, gunzipped under min(manifest bytes × 1.1, headroom).
   *
   * @throws (while reading) DomainError BACKUP_INVALID: `bomb` past the bound, `format` (no such part, not gzip, not
   *   UTF-8, a line too long)
   */
  partLines(table: string, n: number): AsyncIterable<string>;
  /** The blob `sha256` (an upload's content), or null when the backup holds none. */
  blob(sha256: string): Promise<{ size: number; bytes(): AsyncIterable<Uint8Array> } | null>;
  close(): Promise<void>;
}

export interface OpenRestoreSourceOptions {
  dataDir: string;
  /** The `backups` row (and folder) restored. */
  backupId: string;
  source: 'server' | 'archive';
  /** The KEK of an encrypted archive (scrypt of the passphrase, kept sealed by the op), else null. */
  kek: Uint8Array | null;
  /** The op: an archive is extracted into `tmp/<opId>/src/`. */
  opId: string;
  /** The free space the restore may fill: the gunzip bound of a part is min(bytes × 1.1, headroomBytes). */
  headroomBytes: number;
  /** Archive only: the extraction is complete (`verify` said done), so only the extracted files are read. */
  extracted?: boolean;
  /** Epoch ms (the extraction's deadline is compared with it); default Date.now. */
  clock?: () => number;
}

function invalid(reason: 'format' | 'checksum' | 'bomb', why: string, cause?: unknown): DomainError {
  return new DomainError('BACKUP_INVALID', {
    detail: `Backup tidak dapat dipulihkan: ${why} / The backup cannot be restored: ${why}`,
    meta: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The bytes of the file `p` from its start (positioned reads; closed when the reader stops). */
async function* fileBytes(p: DataPath, hash?: { update(data: Uint8Array): unknown }): AsyncGenerator<Buffer, void, undefined> {
  const handle: FileHandle = await openRead(p);
  try {
    for (let position = 0; ; ) {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      hash?.update(chunk);
      yield chunk;
    }
  } finally {
    await handle.close();
  }
}

/** The plaintext bytes of the gzip `source`, refused (`bomb`) past `limit` bytes. */
async function* gunzipBounded(source: AsyncIterable<Uint8Array>, limit: number, name: string): AsyncGenerator<Buffer, void, undefined> {
  const input = Readable.from(source, { objectMode: false });
  const gunzip = createGunzip();
  input.on('error', (error) => gunzip.destroy(error));
  input.pipe(gunzip);
  let produced = 0;
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      produced += chunk.byteLength;
      if (produced > limit) throw invalid('bomb', `${name} mengembang melebihi ${limit} byte / ${name} inflates past ${limit} bytes`);
      yield chunk;
    }
  } catch (error) {
    if (isDomainError(error)) throw error;
    const code = errorCode(error);
    if (code === 'ENOENT') throw invalid('format', `${name} tidak ada / ${name} is missing`, error);
    if (code !== undefined && /^E[A-Z]+$/.test(code)) throw error; // a file system error
    throw invalid('format', `${name} bukan gzip yang sah / ${name} is not valid gzip`, error);
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

/** The `\n`-separated lines of `source` (UTF-8; a line longer than {@link PART_LINE_MAX_BYTES} is refused). */
async function* linesOf(source: AsyncIterable<Buffer>, name: string): AsyncGenerator<string, void, undefined> {
  let pieces: Buffer[] = [];
  let pending = 0;
  const take = (piece: Buffer): void => {
    pending += piece.byteLength;
    if (pending > PART_LINE_MAX_BYTES) {
      throw invalid('format', `${name} memuat baris terlalu panjang / ${name} holds a line that is too long`);
    }
    if (piece.byteLength > 0) pieces.push(piece);
  };
  const line = (): string => {
    const bytes = pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces, pending);
    pieces = [];
    pending = 0;
    try {
      return UTF8.decode(bytes);
    } catch (error) {
      throw invalid('format', `${name} bukan UTF-8 yang sah / ${name} is not valid UTF-8`, error);
    }
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

/** `tables/<table>/<n, 5 digits>.jsonl.gz`: a part's entry name in an archive. */
function partEntry(table: string, n: number): string {
  return `tables/${table}/${String(n).padStart(5, '0')}.jsonl.gz`;
}

/** The part `n` of `table` the manifest lists. @throws BACKUP_INVALID `format` when it lists none */
function listedPart(m: BackupManifest, table: string, n: number): BackupPart {
  const part = Object.hasOwn(m.tables, table) ? m.tables[table]!.parts.find((p) => p.n === n) : undefined;
  if (part === undefined) throw invalid('format', `bagian ${n} tabel ${table} tidak tercantum / part ${n} of ${table} is not listed`);
  return part;
}

/** Every part of the manifest, in its table order. */
function allParts(m: BackupManifest): { table: string; part: BackupPart }[] {
  const out: { table: string; part: BackupPart }[] = [];
  for (const [table, t] of Object.entries(m.tables)) for (const part of t.parts) out.push({ table, part });
  return out;
}

/** A JSON file parsed strictly (UTF-8, no duplicate keys), or BACKUP_INVALID `format`. */
function jsonOf(bytes: Uint8Array, what: string): unknown {
  try {
    return parseStrictJson(UTF8.decode(bytes));
  } catch (error) {
    throw invalid('format', `${what} bukan JSON yang sah / ${what} is not valid JSON`, error);
  }
}

/** Whether the manifest's descriptive fields are the header's (as altisbak.ts checks them). */
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

/** The header a server backup's manifest stands for. */
function headerOf(m: BackupManifest): AltisbakHeader {
  return {
    format: BACKUP_FORMAT,
    backupId: m.backupId,
    appVersion: m.appVersion,
    schemaVersion: m.schemaVersion,
    dialect: m.dialect,
    consistency: m.consistency,
    secrets: m.secrets,
    encryption: null,
  };
}

/** The SHA-256 (hex) of the file `p`; null when it does not exist. */
async function fileSha256(p: DataPath): Promise<string | null> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of fileBytes(p, hash)) void chunk;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  return hash.digest('hex');
}

/** A blob file on disk as {@link RestoreSource.blob} returns it, or null when it is not a regular file. */
async function blobAt(p: DataPath): Promise<{ size: number; bytes(): AsyncIterable<Uint8Array> } | null> {
  const info = await statOrNull(p);
  if (info === null || info.kind !== 'file') return null;
  return { size: info.size, bytes: () => fileBytes(p) };
}

function passphraseRequired(): DomainError {
  return new DomainError('BACKUP_PASSPHRASE_REQUIRED', {
    detail: 'Arsip ini terenkripsi; masukkan frasa sandinya / This archive is encrypted; enter its passphrase',
  });
}

/**
 * Opens the backup `backupId` for a restore (see the top of this file).
 *
 * @throws DomainError NOT_FOUND (no manifest for a server backup, no archive file), BACKUP_INVALID (`format`),
 *   BACKUP_PASSPHRASE_REQUIRED / BACKUP_PASSPHRASE_INVALID (an encrypted archive without the right KEK)
 * @throws TypeError for options that are not valid
 */
export async function openRestoreSource(o: OpenRestoreSourceOptions): Promise<RestoreSource> {
  if (typeof o?.backupId !== 'string' || !isUlid(o.backupId)) throw new TypeError('openRestoreSource: backupId must be a ULID');
  if (typeof o.opId !== 'string' || !isUlid(o.opId)) throw new TypeError('openRestoreSource: opId must be a ULID');
  if (!Number.isSafeInteger(o.headroomBytes) || o.headroomBytes < 0) {
    throw new TypeError('openRestoreSource: headroomBytes must be a non-negative safe integer');
  }
  const { dataDir, backupId, opId, headroomBytes } = o;
  const clock = o.clock ?? Date.now;
  const tables = BACKUP_PATH_TABLES;

  const partLinesOf = (m: BackupManifest, file: (table: string, n: number) => DataPath) => (table: string, n: number) => {
    const part = listedPart(m, table, n);
    const limit = Math.min(part.bytes + Math.floor(part.bytes / 10), headroomBytes);
    const name = partEntry(table, n);
    return (async function* () {
      yield* linesOf(gunzipBounded(fileBytes(file(table, n)), limit, name), name);
    })();
  };

  if (o.source === 'server') {
    const manifest = await readManifest(dataDir, backupId);
    if (manifest === null) {
      throw new DomainError('NOT_FOUND', { detail: `Backup ${backupId} tidak memiliki manifest / Backup ${backupId} has no manifest` });
    }
    const file = (table: string, n: number): DataPath => backupPartPath(dataDir, backupId, table, n, tables);
    const parts = allParts(manifest);
    return {
      source: 'server',
      backupId,
      header: headerOf(manifest),
      manifest,
      dek: null,
      async verify(s) {
        let i = s.checkpoint;
        if (!Number.isSafeInteger(i) || i < 0 || i > parts.length) throw new TypeError('verify: the checkpoint is outside the parts');
        do {
          const entry = parts[i];
          if (entry === undefined) break;
          const sha = await fileSha256(file(entry.table, entry.part.n));
          if (sha !== entry.part.sha256) {
            const name = partEntry(entry.table, entry.part.n);
            throw invalid(
              'checksum',
              sha === null ? `${name} tidak ada / ${name} is missing` : `SHA-256 ${name} tidak cocok / the SHA-256 of ${name} does not match`,
            );
          }
          i += 1;
        } while (i < parts.length && clock() < s.deadline);
        return { done: i >= parts.length, checkpoint: i };
      },
      partFile: file,
      partLines: partLinesOf(manifest, file),
      blob: (sha256) => (SHA256_HEX.test(sha256) ? blobAt(blobPath(dataDir, sha256)) : Promise.resolve(null)),
      close: async () => {},
    };
  }

  if (o.source !== 'archive') throw new TypeError('openRestoreSource: source must be server or archive');
  const extracted = (entry: string): DataPath => extractedEntryPath(dataDir, opId, entry, tables);
  const file = (table: string, n: number): DataPath => extracted(partEntry(table, n));
  const blob = (sha256: string) => (SHA256_HEX.test(sha256) ? blobAt(extracted(`blobs/${sha256}`)) : Promise.resolve(null));

  if (o.extracted === true) {
    const headerBytes = await readBytes(extracted('altisbak.json'), HEADER_MAX_BYTES);
    const manifestBytes = await readBytes(extracted('manifest.json'), MANIFEST_MAX_BYTES);
    if (headerBytes === null || manifestBytes === null) throw invalid('format', 'arsip terekstrak tidak lengkap / the extracted archive is incomplete');
    const header = altisbakHeaderSchema.safeParse(jsonOf(headerBytes, 'altisbak.json'));
    const parsed = parseManifestJson(jsonOf(manifestBytes, 'manifest.json'));
    if (!header.success || !parsed.ok || !agrees(parsed.manifest, header.data)) {
      throw invalid('format', 'altisbak.json atau manifest.json tidak sah / altisbak.json or manifest.json is not valid');
    }
    const manifest = parsed.manifest;
    let dek: Uint8Array | null = null;
    if (header.data.encryption !== null) {
      if (o.kek === null) throw passphraseRequired();
      dek = unwrapDek(o.kek, header.data.encryption.dek);
    }
    return {
      source: 'archive',
      backupId,
      header: header.data,
      manifest,
      dek,
      verify: async (s) => ({ done: true, checkpoint: s.checkpoint }),
      partFile: file,
      partLines: partLinesOf(manifest, file),
      blob,
      close: async () => {},
    };
  }

  const path = uploadedArchivePath(dataDir, backupId);
  if ((await statOrNull(path)) === null) {
    throw new DomainError('NOT_FOUND', { detail: `Arsip backup ${backupId} tidak ada / The archive of backup ${backupId} is gone` });
  }
  const archive = await openAltisbak(path, {
    ...(o.kek === null ? {} : { kek: o.kek }),
    headroomBytes,
    dataDir,
    tables,
    clock,
  });
  try {
    if (archive.header.encryption !== null && archive.dek === null) throw passphraseRequired();
    const manifest = await archive.manifest();
    return {
      source: 'archive',
      backupId,
      header: archive.header,
      manifest,
      dek: archive.dek,
      async verify(s) {
        const r = await archive.extractTo(opId, { deadline: s.deadline, checkpoint: { entry: s.checkpoint } });
        return { done: r.done, checkpoint: r.checkpoint.entry };
      },
      partFile: file,
      partLines: partLinesOf(manifest, file),
      blob,
      close: () => archive.close(),
    };
  } catch (error) {
    await archive.close();
    throw error;
  }
}

/** The op's KEK (`ctx.secret()`): 32 bytes, or null for an archive without encryption. */
export function kekOf(secret: Uint8Array | null): Uint8Array | null {
  if (secret === null) return null;
  if (secret.byteLength !== 32) throw new DomainError('STATE_CORRUPT', { meta: { reason: 'kek_malformed' } });
  return secret;
}
