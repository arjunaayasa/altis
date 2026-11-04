import { hkdfSync } from 'node:crypto';
import { canonicalize } from '@altis/crypto';
import { DIALECTS, type Dialect, type PkValue } from '@altis/db';
import { dataPath, readBytes, writeBytesAtomic } from '@altis/platform';
import { DomainError, isUlid } from '@altis/shared';
import { z } from 'zod';
import { hmacB64u, safeEqual } from '../crypto/tokens.js';

// The backup manifest (spec §9.9): `backups/<id>/manifest.json`, written atomically and last, so a backup directory
// without one is unfinished. It records the app version, the schema version (the last migration's name), the
// dialect, the time, the `consistency` mode, the keyring's `kid` list, the source `installId`, the audit chain head
// and, per table, its class, columns, row count, checksum (secret columns left out) and parts (rows, first and last
// key, SHA-256 of the file, uncompressed `bytes`), plus the content-addressed upload blobs it refers to.
//
// The installation's HMAC (decision C13): HMAC-SHA256 over the RFC 8785 canonical JSON of the manifest without its
// `hmac` field, keyed with HKDF-SHA256(sessionKey, empty salt, info 'altis backup manifest v1', 32 bytes), base64url.
// A restore treats an archive whose HMAC does not verify with this installation's session key as `external`.
//
// Fields of a later release (1d, preflight 1D-08, decision D1d-44, ruling R1d-3): recovering from a failed update (§9.8
// row 3) means this release restores a backup the next one wrote, so every reader of a manifest tolerates fields it
// does not know, at every level, through one parser (parseManifestJson): `readManifest` (a server backup), the
// `.altisbak` reader (archive/altisbak.ts) and an extracted archive (restore/source.ts). It returns the fields it
// knows, strictly checked, and keeps the canonical form of the whole object it parsed out of sight: verifyManifestHmac
// covers that form, unknown fields included, so they are dropped only under a valid HMAC (or, for an encrypted
// archive, under its passphrase: restore/runner.ts); a restore refuses a manifest whose unknown fields neither covers,
// and so does a download preparation (backup/prepare-download.ts), which carries them into the archive's manifest when
// the HMAC covers them (signedManifestObject). What this release writes otherwise stays strictly shaped: a copy of a
// read manifest (spread, JSON) carries only the known fields.

/** The format of a backup (manifest, parts) and of an `.altisbak` archive's header. */
export const BACKUP_FORMAT = 'altis-backup/1';

/** HKDF info of the manifest HMAC key (decision C13). */
const MANIFEST_HMAC_INFO = 'altis backup manifest v1';

/** The most bytes `readManifest` reads: a manifest lists a few hundred parts and at most one entry per upload. */
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;

export type BackupKind = 'manual' | 'scheduled' | 'pre_update' | 'pre_restore' | 'external';

/** One part file of a table: `tables/<table>/<n, 5 digits>.jsonl.gz`. */
export interface BackupPart {
  /** The part number, from 1. */
  n: number;
  rows: number;
  /** The primary key of the part's first and last row; null for the empty part of an empty table. */
  firstPk: PkValue[] | null;
  lastPk: PkValue[] | null;
  /** SHA-256 (hex) of the file as written (gzip). */
  sha256: string;
  /** The uncompressed size: the bytes of its JSONL lines. */
  bytes: number;
}

export interface BackupManifestTable {
  class: 'data' | 'config' | 'history';
  /** The columns of each row, in registry order (columnsAt the manifest's schemaVersion). */
  columns: string[];
  rows: number;
  /** SHA-256 (hex) of the table's checksum lines in primary-key order (spec §9.9). */
  checksum: string;
  parts: BackupPart[];
}

export interface BackupManifest {
  format: 'altis-backup/1';
  backupId: string;
  kind: BackupKind;
  appVersion: string;
  /** The last migration's name (`0009_ops_jobs`). */
  schemaVersion: string;
  dialect: Dialect;
  createdAt: number;
  consistency: 'snapshot' | 'frozen';
  /** The keyring's key ids, so that a restore can tell whether every sealed value can be opened (branch a). */
  kids: string[];
  installId: string;
  auditHead: { seq: number; hash: string };
  includesFiles: boolean;
  /** How the secret columns are held: sealed with the keyring, re-sealed with an archive key, or left out. */
  secrets: 'keyring' | 'archive' | 'omitted';
  /**
   * Where the tables and columns came from: the code's column registry (absent: the default, `registry`), or the
   * database's catalog (`catalog`: the generic exporter of a `schemaHold` `pre_update` backup, spec §9.8 row 3).
   */
  columnsFrom?: 'registry' | 'catalog';
  /** Per table, in load order (parents first). */
  tables: Record<string, BackupManifestTable>;
  /** The upload blobs (`backups/blobs/<sha256>`) the backup refers to, by SHA-256. */
  blobs: { sha256: string; size: number }[];
  /** {@link manifestHmac}. */
  hmac: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,59}$/;
/** A migration name or a schema version (`0009_ops_jobs`, `0009`). */
const SCHEMA_VERSION = /^\d{4}(?:_[a-z0-9_]+)?$/;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A primary key value: a string, or a safe integer. */
export const pkValueSchema = z.union([z.string().max(1000), z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)]);
const pk = z.array(pkValueSchema).min(1).max(8).nullable();
const sha256 = z.string().regex(SHA256_HEX);

/** A table name as the registry spells it. */
export const backupTableNameSchema = z.string().regex(TABLE_NAME);

/** One part of a table, as the manifest and the exporter's checkpoint record it. */
export const backupPartSchema = z.strictObject({
  n: z.number().int().min(1).max(99_999),
  rows: count,
  firstPk: pk,
  lastPk: pk,
  sha256,
  bytes: count,
});

const tableSchema = z.strictObject({
  class: z.enum(['data', 'config', 'history']),
  columns: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).min(1).max(200),
  rows: count,
  checksum: sha256,
  parts: z.array(backupPartSchema).min(1).max(99_999),
});

const auditHeadSchema = z.strictObject({ seq: count, hash: sha256 });
const blobSchema = z.strictObject({ sha256, size: count });

/**
 * The shape of `manifest.json` as this release writes it (strict: an unknown field is refused). `readManifest` checks
 * the fields it knows against it after setting a later release's aside.
 */
export const backupManifestSchema = z.strictObject({
  format: z.literal(BACKUP_FORMAT),
  backupId: z.string().refine(isUlid, 'not a ULID'),
  kind: z.enum(['manual', 'scheduled', 'pre_update', 'pre_restore', 'external']),
  appVersion: z.string().min(1).max(64),
  schemaVersion: z.string().max(191).regex(SCHEMA_VERSION),
  dialect: z.enum(DIALECTS),
  createdAt: count,
  consistency: z.enum(['snapshot', 'frozen']),
  kids: z.array(z.string().min(1).max(64)).max(1000),
  installId: z.string().min(1).max(64),
  auditHead: auditHeadSchema,
  includesFiles: z.boolean(),
  secrets: z.enum(['keyring', 'archive', 'omitted']),
  columnsFrom: z.enum(['registry', 'catalog']).optional(),
  tables: z.record(backupTableNameSchema, tableSchema),
  blobs: z.array(blobSchema),
  hmac: z.string().min(1).max(128),
}) satisfies z.ZodType<BackupManifest>;

/** The field names this release knows at each level of a manifest (from the schemas above, so they cannot drift). */
const KNOWN = {
  manifest: Object.keys(backupManifestSchema.shape),
  auditHead: Object.keys(auditHeadSchema.shape),
  blob: Object.keys(blobSchema.shape),
  table: Object.keys(tableSchema.shape),
  part: Object.keys(backupPartSchema.shape),
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `value` with only the fields `keys` when it is an object (anything else as it is, for the schema to judge); the
 * path of every other field goes to `unknown`. Objects are rebuilt with Object.fromEntries, so a `__proto__` field
 * stays a plain field (and is dropped as unknown).
 */
function pick(value: unknown, keys: readonly string[], where: string, unknown: string[]): unknown {
  if (!isRecord(value)) return value;
  const kept: [string, unknown][] = [];
  for (const [key, v] of Object.entries(value)) {
    if (keys.includes(key)) kept.push([key, v]);
    else unknown.push(where === '' ? key : `${where}.${key}`);
  }
  return Object.fromEntries(kept);
}

/** The parsed manifest `raw` with only the fields this release knows, at every level; their paths go to `unknown`. */
function knownFields(raw: unknown, unknown: string[]): unknown {
  const out = pick(raw, KNOWN.manifest, '', unknown); // a new object: its fields are replaced below
  if (!isRecord(out)) return out;
  if (Object.hasOwn(out, 'auditHead')) out['auditHead'] = pick(out['auditHead'], KNOWN.auditHead, 'auditHead', unknown);
  const blobs = out['blobs'];
  if (Array.isArray(blobs)) out['blobs'] = blobs.map((b: unknown, i) => pick(b, KNOWN.blob, `blobs.${i}`, unknown));
  const tables = out['tables'];
  if (isRecord(tables)) {
    out['tables'] = Object.fromEntries(
      Object.entries(tables).map(([name, t]) => {
        const table = pick(t, KNOWN.table, `tables.${name}`, unknown);
        const parts = isRecord(table) ? table['parts'] : undefined;
        if (!isRecord(table) || !Array.isArray(parts)) return [name, table];
        return [name, { ...table, parts: parts.map((p: unknown, i) => pick(p, KNOWN.part, `tables.${name}.parts.${i}`, unknown)) }];
      }),
    );
  }
  return out;
}

/**
 * What `readManifest` keeps of a manifest that carries fields this release does not know: the canonical JSON of the
 * whole parsed object without `hmac` (what the HMAC covers), the canonical JSON of the known fields it returned (so a
 * manifest changed in place afterwards is judged as it is now), and the unknown fields' paths.
 */
interface SignedForm {
  readonly canonical: string;
  readonly known: string;
  readonly unknown: readonly string[];
}

const SIGNED_FORM: unique symbol = Symbol('altis.backupManifest.signedForm');

function signedFormOf(m: BackupManifest): SignedForm | null {
  const form = (m as BackupManifest & { [SIGNED_FORM]?: SignedForm })[SIGNED_FORM];
  return form === undefined ? null : form;
}

/** `m` without its `hmac` field (a shallow copy). */
function withoutHmac(m: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(m).filter(([key]) => key !== 'hmac'));
}

/**
 * The paths of the fields of `m` this release does not know (`futureField`, `tables.branches.parts.0.extra`), as
 * `readManifest` found them; [] for a manifest without any (or one this release built).
 */
export function unknownManifestFields(m: BackupManifest): readonly string[] {
  return signedFormOf(m)?.unknown ?? [];
}

/** HKDF-SHA256(sessionKey, empty salt, 'altis backup manifest v1', 32 bytes). */
function manifestKey(sessionKey: Uint8Array): Uint8Array {
  if (!(sessionKey instanceof Uint8Array) || sessionKey.byteLength < 16) {
    throw new TypeError('manifestHmac(): the session key must be at least 16 bytes');
  }
  return new Uint8Array(hkdfSync('sha256', sessionKey, new Uint8Array(0), MANIFEST_HMAC_INFO, 32));
}

/**
 * The installation's HMAC of manifest `m` (decision C13): HMAC-SHA256 over `canonicalize(m)` (UTF-8), keyed with
 * HKDF-SHA256(sessionKey, empty salt, info `'altis backup manifest v1'`), as unpadded base64url. An `hmac` field in
 * `m` is not covered (it is left out first).
 *
 * @throws TypeError for a session key shorter than 16 bytes, or a manifest outside the JSON data model
 */
export function manifestHmac(sessionKey: Uint8Array, m: Omit<BackupManifest, 'hmac'>): string {
  const covered: Record<string, unknown> = { ...m };
  delete covered['hmac'];
  return hmacB64u(manifestKey(sessionKey), canonicalize(covered));
}

/**
 * Whether `m.hmac` is this installation's HMAC of `m` (constant-time comparison); false for anything malformed. For a
 * manifest `readManifest` read with fields this release does not know, the HMAC is checked over the whole object it
 * parsed, those fields included, as long as the known fields are still the ones it returned.
 */
export function verifyManifestHmac(sessionKey: Uint8Array, m: BackupManifest): boolean {
  if (typeof m !== 'object' || m === null || typeof m.hmac !== 'string') return false;
  let expected: string;
  try {
    const signed = signedFormOf(m);
    expected =
      signed !== null && signed.known === canonicalize(withoutHmac(m))
        ? hmacB64u(manifestKey(sessionKey), signed.canonical)
        : manifestHmac(sessionKey, m);
  } catch {
    return false;
  }
  return safeEqual(m.hmac, expected);
}

/**
 * The whole object a manifest with fields this release does not know was parsed from, without its `hmac` (a deep copy:
 * the caller may change it), as verifyManifestHmac covers it; null for a manifest without unknown fields (or one this
 * release built). A download preparation starts the archive's manifest from it, so that a later release's fields go
 * with the backup (ruling R1d-3).
 */
export function signedManifestObject(m: BackupManifest): Record<string, unknown> | null {
  const form = signedFormOf(m);
  return form === null ? null : (JSON.parse(form.canonical) as Record<string, unknown>);
}

/** How many unknown field paths an error names, and how many characters of each (ruling R1d-3). */
const NAMED_FIELDS_MAX = 5;
const FIELD_PATH_MAX = 64;

/** `text` cut to at most `max` UTF-16 code units (an ellipsis after a cut), never inside a surrogate pair. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)}…`;
}

/** `text` with its C0 and C1 control characters as `?` (a field name is shown in an error detail and in logs). */
function printable(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? '?' : ch;
  }
  return out;
}

/**
 * BACKUP_INVALID (`signature`) for a manifest whose fields `fields` (paths, as unknownManifestFields names them) this
 * release does not know and neither this installation's HMAC nor an archive passphrase covers: they could be dropped
 * unread only under one of them (preflight 1D-08, ruling R1d-3). The detail is bounded whatever the manifest holds (at
 * most {@link NAMED_FIELDS_MAX} paths of at most {@link FIELD_PATH_MAX} characters, well under op.json's 2000), and
 * `meta.unknownFields` counts them all.
 */
export function unverifiedManifestFields(fields: readonly string[]): DomainError {
  const named =
    fields
      .slice(0, NAMED_FIELDS_MAX)
      .map((f) => printable(cutText(f, FIELD_PATH_MAX)))
      .join(', ') + (fields.length > NAMED_FIELDS_MAX ? ', …' : '');
  return new DomainError('BACKUP_INVALID', {
    detail:
      `manifest.json memuat ${fields.length} bidang yang tidak dikenal versi ini tanpa HMAC instalasi ini yang sah (${named}) / ` +
      `The manifest.json has ${fields.length} fields this version does not know, without a valid HMAC of this installation (${named})`,
    meta: { reason: 'signature', unknownFields: fields.length },
  });
}

function invalidManifest(backupId: string, why: string): DomainError {
  return new DomainError('BACKUP_INVALID', {
    detail: `manifest.json backup ${backupId} rusak (${why}) / The manifest.json of backup ${backupId} is damaged (${why})`,
    meta: { reason: 'format' },
  });
}

/**
 * A manifest as this release reads it, from the parsed JSON `json` of a `manifest.json` (every reader goes through
 * here, ruling R1d-3): the fields it knows, checked against {@link backupManifestSchema}; fields of a later release (at
 * any level) are left out of the manifest returned, and the canonical form of the whole object stays with it, out of
 * sight, for verifyManifestHmac ({@link unknownManifestFields} names them, {@link signedManifestObject} gives the
 * object back). `why` says what is wrong otherwise: `schema` (the known fields do not fit), `not canonical JSON` (with
 * unknown fields, outside the JSON data model).
 */
export function parseManifestJson(json: unknown): { ok: true; manifest: BackupManifest } | { ok: false; why: 'schema' | 'not canonical JSON' } {
  const unknown: string[] = [];
  const parsed = backupManifestSchema.safeParse(knownFields(json, unknown));
  if (!parsed.success) return { ok: false, why: 'schema' };
  if (unknown.length === 0) return { ok: true, manifest: parsed.data };
  let form: SignedForm;
  try {
    form = Object.freeze({
      canonical: canonicalize(withoutHmac(json as object)),
      known: canonicalize(withoutHmac(parsed.data)),
      unknown: Object.freeze(unknown),
    });
  } catch {
    return { ok: false, why: 'not canonical JSON' };
  }
  Object.defineProperty(parsed.data, SIGNED_FORM, { value: form, enumerable: false });
  return { ok: true, manifest: parsed.data };
}

/**
 * The manifest of the backup `backupId` of DATA_DIR (`backups/<id>/manifest.json`), read by
 * {@link parseManifestJson}; null when the backup has none (unfinished, an uploaded archive, or gone). The HMAC is
 * not checked here ({@link verifyManifestHmac}).
 *
 * @throws DomainError `BACKUP_INVALID` (`reason: 'format'`) for a manifest that is not JSON (or, with unknown fields,
 *   outside the JSON data model), whose known fields do not fit the schema, or that names another backup;
 *   `INVALID_PATH_SEGMENT` for a `backupId` that is not a ULID
 */
export async function readManifest(dataDir: string, backupId: string): Promise<BackupManifest | null> {
  const bytes = await readBytes(dataPath(dataDir, 'backups', backupId, 'manifest.json'), MANIFEST_MAX_BYTES);
  if (bytes === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalidManifest(backupId, 'not JSON');
  }
  const parsed = parseManifestJson(json);
  if (!parsed.ok) throw invalidManifest(backupId, parsed.why);
  if (parsed.manifest.backupId !== backupId) throw invalidManifest(backupId, 'backupId');
  return parsed.manifest;
}

/**
 * Writes `m` as `backups/<m.backupId>/manifest.json`, atomically (a reader sees no manifest or the whole one).
 *
 * @throws DomainError `DISK_QUOTA` (P21)
 */
export async function writeManifest(dataDir: string, m: BackupManifest): Promise<void> {
  await writeBytesAtomic(dataPath(dataDir, 'backups', m.backupId, 'manifest.json'), `${JSON.stringify(m)}\n`);
}
