import type { Permission } from '@altis/shared';
import type { UploadContextName } from '@altis/shared/api/files';
import { OPAC_HOME_PHOTO_MAX_BYTES, OPAC_HOME_PHOTO_SIDES } from '@altis/shared/api/opac-home';
import type { SettingKey } from '../settings/registry.js';
import type { MagicKind } from './magic.js';

// What an upload may be for (spec §7.5, decision C7). The context is declared with the size and the SHA-256 before
// any byte arrives, and decides who may upload, how large the file may be, which magic bytes it must start with,
// and what completion does with it:
// - `staged`: the verified file stays in `tmp/<id>/upload.bin` (with a `.complete` marker) until the consuming route
//   takes it (`takeStagedUpload`): `POST backups/upload` for `backup`, 1d's update upload for `update`, Phase 2's
//   import and migration jobs for `catalog.import`, `slims.dump` and `slims.files`;
// - `file`: completion stores it under `uploads/` (the local StorageDriver) and inserts a `files` row.
//
// Phase 2 (its spec §8; plan Task 2) adds the catalog's contexts. `magic` became a set of kinds (magic.ts detects
// them; S1), so a context names exactly the types it takes. `maxBytesSetting` names a setting in MB that lowers the
// static ceiling when the upload is declared (the setting is the real limit; the ceiling only bounds it).
// Reports and accreditation add the evidence files and the staged SLiMS dump of the usage import; the files whose
// owner never claims them are swept by the housekeeping job ORPHAN_UPLOAD_CONTEXTS (orphan-contexts.ts) names.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface UploadContext {
  name: UploadContextName;
  /** The permission the uploader needs; null: any signed-in staff user (or a route that claims the file is the gate). */
  permission: Permission | null;
  /** The largest declared size accepted (UPLOAD_TOO_LARGE above it). */
  maxBytes: number;
  /** The kinds the first bytes may be (UPLOAD_TYPE_REFUSED otherwise); `any` accepts every type. */
  magic: 'any' | readonly MagicKind[];
  kind: 'staged' | 'file';
  /** A setting (in MB) that lowers `maxBytes` when the upload is declared; Task 18 enforces it. */
  maxBytesSetting?: SettingKey;
  // ---- Komunitas (OPAC home page) ----
  /**
   * The smallest and largest width and height in pixels, read from the image itself at completion (a JPEG's frame
   * header); an image outside them, or whose size cannot be read, is refused like a wrong type. Only for a stripped JPEG
   * context.
   */
  imageSides?: { min: number; max: number };
}

/** The chunk size the server fixes when nothing smaller is asked for or known to pass (P10: "default 5 MB"). */
export const CHUNK_DEFAULT_BYTES = 5 * MIB;
/** The smallest chunk size (P10: "mengecil sampai 256 KB"). */
export const CHUNK_MIN_BYTES = 256 * 1024;
/** Live upload sessions per subject (spec §7.5: "maksimal 3 sesi unggah per subjek"). */
export const UPLOADS_PER_SUBJECT = 3;
/** A session, and its staged bytes, live this long (spec §7.5: "staging dibersihkan setelah 24 jam"). */
export const UPLOAD_TTL_MS = 86_400_000;

/** A frozen context with a frozen set of kinds. */
function context(c: UploadContext): UploadContext {
  return Object.freeze({ ...c, magic: c.magic === 'any' ? 'any' : Object.freeze([...c.magic]) });
}

/** The raster images a cover, a floor plan or a page image may be (never SVG: magic.ts gives it no image type). */
const IMAGES: readonly MagicKind[] = ['jpeg', 'png', 'webp'];

/**
 * The contexts of this build. `test` (16 MiB, any type, a `files` row, any signed-in staff user) exists only when
 * `__BUILD_PROFILE__ === 'test'` (test hooks never reach a production build): a production build has `backup` and
 * `update`, Phase 2's seven and the two of accreditation.
 */
export const UPLOAD_CONTEXTS: Readonly<Partial<Record<UploadContextName, UploadContext>>> = Object.freeze({
  backup: context({ name: 'backup', permission: 'system.backup.restore', maxBytes: 20 * GIB, magic: ['zip'], kind: 'staged' }),
  update: context({ name: 'update', permission: 'system.update.run', maxBytes: GIB, magic: ['zip'], kind: 'staged' }),
  // The condition stays inline, so a production build drops the entry.
  ...(typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test'
    ? { test: context({ name: 'test', permission: null, maxBytes: 16 * MIB, magic: 'any', kind: 'file' }) }
    : {}),

  // ---- Phase 2 (catalog): Task 2 ----
  // Covers are shrunk in the browser before they are sent (§8); Task 18 strips their metadata.
  'catalog.cover': context({ name: 'catalog.cover', permission: 'catalog.records.manage', maxBytes: 2 * MIB, magic: IMAGES, kind: 'file' }),
  // Any type (an unknown one is served as a download); the static ceiling is 2 GiB, the setting the real limit.
  'catalog.attachment': context({
    name: 'catalog.attachment',
    permission: 'catalog.records.manage',
    maxBytes: 2 * GIB,
    magic: 'any',
    kind: 'file',
    maxBytesSetting: 'catalog.attachment.maxMb',
  }),
  // No permission here: the branch-scoped map route that claims the file is the gate; an upload context
  // cannot name a branch, and an unclaimed file is removed after 24 h.
  'catalog.floor_plan': context({ name: 'catalog.floor_plan', permission: null, maxBytes: 5 * MIB, magic: IMAGES, kind: 'file' }),
  'opac.page_image': context({
    name: 'opac.page_image',
    permission: 'opac.pages.manage',
    maxBytes: 2 * MIB,
    magic: [...IMAGES, 'gif'],
    kind: 'file',
  }),
  // UTF-8 or cp1252 CSV and MARC text are `text`, MARCXML `xml`, MARC 21 transmission files `iso2709`.
  'catalog.import': context({
    name: 'catalog.import',
    permission: 'catalog.import.run',
    maxBytes: 512 * MIB,
    magic: ['text', 'xml', 'iso2709'],
    kind: 'staged',
  }),
  // A SLiMS SQL dump, plain or gzipped.
  'slims.dump': context({ name: 'slims.dump', permission: 'catalog.migration.run', maxBytes: 4 * GIB, magic: ['text', 'gzip'], kind: 'staged' }),
  // The SLiMS files folder as a ZIP (`ensureHeadroom` 2×, as every upload).
  'slims.files': context({ name: 'slims.files', permission: 'catalog.migration.run', maxBytes: 10 * GIB, magic: ['zip'], kind: 'staged' }),

  // ---- Komunitas K1 (uploads) ----
  // Accreditation evidence and register attachments: PDF, or JPEG (the browser converts other images first). The
  // static ceiling is 100 MiB, `accreditation.evidence.maxMb` the real limit. The claiming row (an evidence row, a
  // training certificate, a partnership or a document) is its owner.
  'accreditation.evidence': context({
    name: 'accreditation.evidence',
    permission: 'accreditation.workspace.manage',
    maxBytes: 100 * MIB,
    magic: ['pdf', 'jpeg'],
    kind: 'file',
    maxBytesSetting: 'accreditation.evidence.maxMb',
  }),
  // A SLiMS SQL dump, plain or gzipped, for the read-only import of usage statistics.
  'accreditation.slims_dump': context({
    name: 'accreditation.slims_dump',
    permission: 'accreditation.workspace.manage',
    maxBytes: 4 * GIB,
    magic: ['text', 'gzip'],
    kind: 'staged',
  }),

  // ---- Komunitas (members and circulation) ----
  // The CSV file of a member import (UTF-8 or cp1252 text), staged until `POST members/imports` takes it.
  'members.import': context({ name: 'members.import', permission: 'members.import.run', maxBytes: 50 * MIB, magic: ['text'], kind: 'staged' }),

  // ---- Komunitas K2 (members extended) ----
  // A member's photo, cropped in the browser to 300 × 400 JPEG; claimed by `PUT members/:id/photo`, staff only.
  'members.photo': context({ name: 'members.photo', permission: 'members.records.manage', maxBytes: 500 * 1024, magic: ['jpeg'], kind: 'file' }),
  // The card's logo, signature and stamp (JPEG, converted in the browser), claimed when the card profile is saved.
  'members.card_asset': context({ name: 'members.card_asset', permission: 'system.settings.manage', maxBytes: 500 * 1024, magic: ['jpeg'], kind: 'file' }),

  // ---- Komunitas K4 (stocktake) ----
  // A list of scanned codes (text or CSV, one code per line), staged until `POST …/stocktakes/:id/uploads` takes it.
  // Scanning is a branch permission: the declaration names the session's branch and is checked there (files.ts), and
  // the route that takes the file checks it at the session's branch again.
  'stocktake.codes': context({ name: 'stocktake.codes', permission: 'stocktake.scan.use', maxBytes: 10 * MIB, magic: ['text'], kind: 'staged' }),

  // ---- Komunitas (OPAC home page) ----
  // A photo of the OPAC home page (the hero, the "about" photo, a facility photo): a JPEG the browser cropped (the hero
  // to 1600 × 900, the others to 1200 × 900), at most 500 KB, 240-2400 px a side, stored without its metadata; claimed
  // as a public file when the home page is saved.
  'opac.home_photo': context({
    name: 'opac.home_photo',
    permission: 'opac.pages.manage',
    maxBytes: OPAC_HOME_PHOTO_MAX_BYTES,
    magic: ['jpeg'],
    kind: 'file',
    imageSides: { min: OPAC_HOME_PHOTO_SIDES.min, max: OPAC_HOME_PHOTO_SIDES.max },
  }),
});

/** The context `name` of this build, or null (an unknown name, or `test` outside the test profile). */
export function uploadContext(name: string): UploadContext | null {
  return Object.hasOwn(UPLOAD_CONTEXTS, name) ? (UPLOAD_CONTEXTS[name as UploadContextName] ?? null) : null;
}
