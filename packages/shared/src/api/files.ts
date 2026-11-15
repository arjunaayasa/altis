/**
 * The uploads API vocabulary shared by the server and the admin SPA (spec §7.5, P10; decision C7). No Node built-ins
 * here: the browser bundles this module. Import it as `@altis/shared/api/files`.
 *
 * An upload is declared first (context, size, SHA-256), then sent in chunks of the size the server fixed
 * (`POST files/uploads/:id/chunks/:n` as multipart/form-data, field `chunk`), then completed. A client that meets
 * 413 (or a WAF's 403) deletes the session, halves the chunk size (never below 256 KiB) and starts again.
 */
import { z } from 'zod';
import { ulidField } from './common.js';

/**
 * The contexts an upload can be declared for; `test` exists only in the test build profile (the server refuses it
 * otherwise). Phase 2 (its spec §8) adds the catalog's: covers, attachments, floor plans and page images are stored as
 * files; imports, SQL dumps and the SLiMS files archive stay staged for the job that reads them.
 */
export const UPLOAD_CONTEXT_NAMES = [
  'backup',
  'update',
  'test',
  // ---- Phase 2 (catalog): Task 2 ----
  'catalog.cover',
  'catalog.attachment',
  'catalog.floor_plan',
  'opac.page_image',
  'catalog.import',
  'slims.dump',
  'slims.files',
  // ---- Komunitas K1 (uploads) ----
  // Accreditation evidence (PDF or JPEG, also the register attachments) is stored as a file; the SLiMS dump of the
  // usage statistics import stays staged for its job.
  'accreditation.evidence',
  'accreditation.slims_dump',
  // ---- Komunitas (members and circulation) ----
  // The CSV file of a member import stays staged for the import.
  'members.import',
  // ---- Komunitas K2 (members extended) ----
  'members.photo',
  'members.card_asset',
  // ---- Komunitas K4 (stocktake) ----
  // A list of scanned codes stays staged for the session's code job.
  'stocktake.codes',
  // ---- Komunitas (OPAC home page) ----
  // The photos of the OPAC home page (the hero, the "about" photo, the facility photos), stored as public files.
  'opac.home_photo',
] as const;

export type UploadContextName = (typeof UPLOAD_CONTEXT_NAMES)[number];

/** A SHA-256 digest in lower-case hex. */
export const sha256Field = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * `POST files/uploads`. `size` in bytes (the context's maximum is the server's to check: 413 UPLOAD_TOO_LARGE);
 * `chunkBytes` is a wish, which the server clamps to 256 KiB-5 MiB (default: the largest chunk the browser test saw
 * pass, else 5 MiB).
 */
export const UploadCreateBody = z.strictObject({
  context: z.enum(UPLOAD_CONTEXT_NAMES),
  size: z.int().min(1),
  sha256: sha256Field,
  chunkBytes: z.int().min(1).max(2_147_483_647).optional(),
  // ---- Komunitas K4 (stocktake) ----
  /**
   * The branch the file is for, when the context's permission is a branch permission (a stocktake code list): the
   * permission is checked at that branch. Without it such a permission must be held globally.
   */
  branchId: ulidField.optional(),
});

export type UploadCreateBody = z.infer<typeof UploadCreateBody>;

/** The answer of `POST files/uploads` (201). */
export interface UploadCreateResponse {
  id: string;
  /** The size of every chunk but the last, in bytes. */
  chunkSize: number;
  /** How many chunks make the file (`ceil(size / chunkSize)`). */
  chunks: number;
  /** Epoch ms: the session and its staged bytes are gone after this (24 h). */
  expiresAt: number;
}

/** The answer of `POST files/uploads/:id/chunks/:n`: the bytes stored so far, and whether that is all of them. */
export interface UploadChunkResponse {
  received: number;
  complete: boolean;
}

/** `POST files/uploads/:id/complete`. The original file name arrives here (decision C7); it is sanitized when served. */
export const UploadCompleteBody = z.strictObject({
  originalName: z.string().min(1).max(191).optional(),
});

export type UploadCompleteBody = z.infer<typeof UploadCompleteBody>;

/**
 * The answer of `complete`: for a staged context (`backup`, `update`; Phase 2's `catalog.import`, `slims.dump`,
 * `slims.files`) the verified upload, which the consuming route takes by `uploadId`; for a file context the stored
 * file's id (`GET /files/:id`).
 */
export type UploadCompleteResponse = { uploadId: string; size: number; sha256: string; mime: string } | { fileId: string };
