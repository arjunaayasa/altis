/**
 * The stocktake API (inventarisasi): sessions of a branch, scanning, the lists of a session, the finish and the
 * minutes. Every route is under `branches/:branchId/stocktakes` and needs `stocktake.scan.use` at that branch, except
 * creating, finishing and cancelling a session and undoing another officer's scan (`stocktake.sessions.manage`).
 *
 * - One session per branch may be preparing, active or finishing (409 STOCKTAKE_ACTIVE). Preparing lists the copies of
 *   the scope (a job); scanning is open while the session is `active`; finishing applies the finish (a job).
 * - An action in the wrong status is 409 STOCKTAKE_STATE `{reason: <status>}`; a finish while a code list is still
 *   being applied is 409 STOCKTAKE_STATE `{reason: 'pending_uploads'}`.
 * - A scan answers what it found in its body (never an error): found, misplaced, already_found, on_loan, unexpected,
 *   unknown.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/stocktake`.
 */
import { z } from 'zod';
import type { StocktakeResult, StocktakeScanOutcome, StocktakeSource, StocktakeState, StocktakeStatus } from '../stocktake-vocab.js';
import { STOCKTAKE_STATES } from '../stocktake-vocab.js';
import { cursorQuery, shortText, type Paged } from './catalog/common.js';
import { rawBarcodeField } from './catalog/items.js';
import { ulidField } from './common.js';

/** The most lines a code list may have. */
export const STOCKTAKE_UPLOAD_MAX_LINES = 200_000;

/** A class prefix of a scope: digits, letters and dots, optionally ending in `*`. */
export const stocktakeClassPrefixField = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[0-9A-Za-z.]+\*?$/);

/** What a session takes in; an empty list or a missing one does not filter. */
export const StocktakeScope = z.strictObject({
  locationIds: z.array(ulidField).max(200).optional(),
  collectionTypeIds: z.array(ulidField).max(50).optional(),
  materialTypeIds: z.array(ulidField).max(50).optional(),
  classPrefixes: z.array(stocktakeClassPrefixField).max(50).optional(),
});

export type StocktakeScope = z.infer<typeof StocktakeScope>;

/** `POST branches/:branchId/stocktakes` → 201 {@link StocktakeCreateResponse} (`stocktake.sessions.manage`). */
export const StocktakeCreateBody = z.strictObject({
  name: shortText(191).min(1),
  scope: StocktakeScope,
});

export type StocktakeCreateBody = z.infer<typeof StocktakeCreateBody>;

export interface StocktakeCreateResponse {
  id: string;
  version: number;
  /** The preparation job. */
  jobId: string;
}

/** The running counts of a session. `found` counts the misplaced copies too; `pending` = total − found − onLoan. */
export interface StocktakeCounts {
  total: number;
  found: number;
  misplaced: number;
  onLoan: number;
  pending: number;
  unexpected: number;
  unknownCodes: number;
}

/** A person named on a session (staff). */
export interface StocktakePersonRef {
  id: string;
  name: string;
}

/** One session as the list and the session screen show it. */
export interface StocktakeView {
  id: string;
  version: number;
  branch: { id: string; code: string; name: string };
  name: string;
  scope: StocktakeScope;
  /** The scope's names, for display (locations, collection types, material types). */
  scopeNames: { locations: string[]; collectionTypes: string[]; materialTypes: string[] };
  status: StocktakeStatus;
  source: StocktakeSource;
  counts: StocktakeCounts;
  startedAt: number;
  startedBy: StocktakePersonRef | null;
  finishedAt: number | null;
  finishedBy: StocktakePersonRef | null;
  /** What the finish was asked to do, once it was. */
  options: { markMissing: boolean; restoreFound: boolean } | null;
  /** The live preparation or finish job, else null. */
  jobId: string | null;
  /** The code lists still being applied. */
  pendingUploads: number;
}

export interface StocktakeListResponse {
  items: StocktakeView[];
}

/** `POST …/stocktakes/:id/scans` (`idempotency: store`): a scanned code and, optionally, the shelf being checked. */
export const StocktakeScanBody = z.strictObject({
  barcode: rawBarcodeField,
  locationId: ulidField.optional(),
});

export type StocktakeScanBody = z.infer<typeof StocktakeScanBody>;

/** The copy a scan named. */
export interface StocktakeScanItem {
  id: string;
  barcode: string;
  title: string;
  callNumber: string | null;
  /** Where the copy belongs (the session's snapshot, else its current location). */
  location: { id: string; name: string } | null;
}

export interface StocktakeScanResponse {
  outcome: StocktakeScanOutcome;
  /** The code as scanned (trimmed). */
  code: string;
  item: StocktakeScanItem | null;
  counts: StocktakeCounts;
}

/** `DELETE …/stocktakes/:id/scans/:itemId`: the scan undone (false when the copy was not scanned in the session). */
export interface StocktakeUndoResponse {
  undone: boolean;
  counts: StocktakeCounts;
}

/** `POST …/stocktakes/:id/uploads` → 202 {@link StocktakeJobResponse}: a staged code list (`stocktake.codes`). */
export const StocktakeUploadBody = z.strictObject({
  uploadId: ulidField,
  locationId: ulidField.optional(),
});

export type StocktakeUploadBody = z.infer<typeof StocktakeUploadBody>;

export interface StocktakeJobResponse {
  id: string;
  jobId: string;
}

/**
 * `POST …/stocktakes/:id/finish` → 202 {@link StocktakeJobResponse} (a fresh re-authentication): `confirmName` must be
 * the session's name exactly (`{path: 'confirmName', code: 'mismatch'}`).
 */
export const StocktakeFinishBody = z.strictObject({
  confirmName: z.string().max(191),
  markMissing: z.boolean(),
  restoreFound: z.boolean(),
});

export type StocktakeFinishBody = z.infer<typeof StocktakeFinishBody>;

/** `POST …/stocktakes/:id/cancel` → {@link StocktakeActionResponse}. */
export interface StocktakeActionResponse {
  id: string;
  version: number;
  status: StocktakeStatus;
}

/** `GET …/stocktakes/:id/items?state=&scannedBy=&cursor=&limit=`: the copies of a session, by item id. */
export const StocktakeItemsQuery = z.strictObject({
  state: z.enum(STOCKTAKE_STATES).optional(),
  scannedBy: ulidField.optional(),
  ...cursorQuery,
});

export type StocktakeItemsQuery = z.infer<typeof StocktakeItemsQuery>;

export interface StocktakeItemView {
  itemId: string;
  barcode: string;
  title: string;
  callNumber: string | null;
  expected: boolean;
  state: StocktakeState;
  expectedLocation: { id: string; name: string } | null;
  scannedLocation: { id: string; name: string } | null;
  /** The copy's status when the session was prepared, and now. */
  expectedStatus: string | null;
  currentStatus: string;
  statDdc: string | null;
  collectionType: { id: string; name: string } | null;
  scannedAt: number | null;
  scannedBy: StocktakePersonRef | null;
  result: StocktakeResult | null;
}

export type StocktakeItemsResponse = Paged<StocktakeItemView>;

/** `GET …/stocktakes/:id/unknown-codes?cursor=&limit=`. */
export const StocktakeUnknownQuery = z.strictObject({ ...cursorQuery });

export type StocktakeUnknownQuery = z.infer<typeof StocktakeUnknownQuery>;

export interface StocktakeUnknownCodeView {
  code: string;
  firstAt: number;
  lastAt: number;
  seen: number;
  scannedBy: StocktakePersonRef | null;
}

export type StocktakeUnknownResponse = Paged<StocktakeUnknownCodeView>;

/** `GET …/stocktakes/:id/officers`: what each officer scanned. */
export interface StocktakeOfficerView {
  /** null: scans of a migrated session, or of a staff user since deleted. */
  id: string | null;
  name: string;
  found: number;
  misplaced: number;
  unexpected: number;
}

export interface StocktakeOfficersResponse {
  items: StocktakeOfficerView[];
}
