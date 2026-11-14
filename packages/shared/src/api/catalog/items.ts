/**
 * The items API vocabulary (Phase 2 spec §2.2 `items`, §2.5, §3.2, §3.4, §12.2; plan Tasks 17, 25).
 * Writes are branch-scoped (`branches/:branchId/items…`, `catalog.items.manage` with `branchParam`); an item of
 * another branch is 404.
 *
 * - A barcode travels as typed; the server normalises it (spec §3.4: normalizeBarcode), checks it (3-64 of 0x20-0x7E, not an ISBN-13:
 *   `isbn_not_barcode`) and keeps it unique across branches (`taken`).
 * - A status change follows `ITEM_TRANSITIONS` (409 `ITEM_STATUS_TRANSITION` otherwise).
 * - A price is a decimal string; the server stores minor units in the item's currency (default `catalog.currency`).
 * - The `store` routes answer `StoreResponse` (S15); batch and bulk answer their summaries.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/items`.
 */
import { z } from 'zod';
import { ACQ_SOURCES, ITEM_STATUSES, type AcqSource, type ItemEventType, type ItemStatus } from '../../catalog-vocab.js';
import { ulidField, versionField } from '../common.js';
import { currencyField, cursorQuery, customValuesField, dateField, longText, priceField, settingIdField, shortText, type Paged } from './common.js';

/** A barcode as typed or scanned, before normalisation (the lookup and the bodies bound it at 200 characters). */
export const rawBarcodeField = z.string().min(1).max(200);

/** The fields of an item besides its record and barcode, all optional (a create fills the defaults below). */
const itemFields = {
  inventoryNo: shortText(64).nullable().optional(),
  /** Null: the item follows its record's call number. */
  callNumber: shortText(64).nullable().optional(),
  /** Null: no location (§2.6: items may have none); it must belong to the item's branch (`invalid`). */
  locationId: ulidField.nullable().optional(),
  statusNote: shortText(191).nullable().optional(),
  acqSource: z.enum(ACQ_SOURCES).nullable().optional(),
  orderNo: shortText(64).nullable().optional(),
  orderDate: dateField.nullable().optional(),
  receivedDate: dateField.nullable().optional(),
  invoiceDate: dateField.nullable().optional(),
  supplierId: ulidField.nullable().optional(),
  invoiceNo: shortText(64).nullable().optional(),
  price: priceField.nullable().optional(),
  currency: currencyField.nullable().optional(),
  note: longText.nullable().optional(),
  custom: customValuesField.optional(),
};

/** What a new item takes besides its record and barcode; a batch's `template` is exactly this. */
const itemTemplateShape = {
  collectionTypeId: ulidField,
  /** A new item is `available` unless said otherwise (decision P2-31). */
  status: z.enum(ITEM_STATUSES).default('available'),
  /** Volumes or parts the item is made of. */
  partsTotal: z.int().min(1).max(99).default(1),
  ...itemFields,
};

/** `POST branches/:branchId/items`. */
export const ItemCreateBody = z.strictObject({ recordId: ulidField, barcode: rawBarcodeField, ...itemTemplateShape });

export type ItemCreateBody = z.infer<typeof ItemCreateBody>;

/** `PATCH branches/:branchId/items/:id`: only the fields sent change (no defaults here); the record never changes. */
export const ItemPatchBody = z.strictObject({
  version: versionField,
  barcode: rawBarcodeField.optional(),
  collectionTypeId: ulidField.optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  partsTotal: z.int().min(1).max(99).optional(),
  ...itemFields,
});

export type ItemPatchBody = z.infer<typeof ItemPatchBody>;

/** The most items one batch creates. */
export const ITEM_BATCH_MAX = 100;

/**
 * `POST branches/:branchId/items/batch` (§3.4): `count` items of `recordId`, numbered by the barcode pattern
 * `patternId` (`catalog.barcode.patterns`) **or** given as `barcodes`, exactly one of the two (both: `{path:
 * 'barcodes', code: 'exclusive'}`; neither: `{path: 'patternId', code: 'required'}`). With `barcodes`, `count` is
 * their number (`count_mismatch`).
 */
export const ItemBatchBody = z
  .strictObject({
    recordId: ulidField,
    count: z.int().min(1).max(ITEM_BATCH_MAX),
    patternId: settingIdField.optional(),
    barcodes: z.array(rawBarcodeField).min(1).max(ITEM_BATCH_MAX).optional(),
    template: z.strictObject(itemTemplateShape),
  })
  .check((ctx) => {
    const { patternId, barcodes, count } = ctx.value;
    if (patternId !== undefined && barcodes !== undefined) {
      ctx.issues.push({ code: 'custom', path: ['barcodes'], params: { code: 'exclusive' }, message: 'exclusive', input: barcodes });
    } else if (patternId === undefined && barcodes === undefined) {
      ctx.issues.push({ code: 'custom', path: ['patternId'], params: { code: 'required' }, message: 'required', input: patternId });
    } else if (barcodes !== undefined && barcodes.length !== count) {
      ctx.issues.push({ code: 'custom', path: ['barcodes'], params: { code: 'count_mismatch' }, message: 'count_mismatch', input: barcodes });
    }
  });

export type ItemBatchBody = z.infer<typeof ItemBatchBody>;

/** The answer of a batch: the items made, and the barcodes found taken at insert (B4). */
export interface ItemBatchResponse {
  created: { id: string; barcode: string }[];
  skipped: { barcode: string; reason: 'taken' }[];
}

/** The most items one bulk change touches. */
export const ITEM_BULK_MAX = 500;

/**
 * `POST branches/:branchId/items/bulk` (§3.4): move, change the status (each item's transition is checked) or the
 * collection type of up to 500 items; at least one change (`{path: 'set', code: 'required'}`).
 */
export const ItemBulkBody = z.strictObject({
  ids: z.array(ulidField).min(1).max(ITEM_BULK_MAX),
  set: z
    .strictObject({
      locationId: ulidField.nullable().optional(),
      status: z.enum(ITEM_STATUSES).optional(),
      collectionTypeId: ulidField.optional(),
      // ---- Komunitas K1 (receiving date) ----
      receivedDate: dateField.optional(),
    })
    .check((ctx) => {
      if (Object.keys(ctx.value).length === 0) ctx.issues.push({ code: 'custom', params: { code: 'required' }, message: 'required', input: ctx.value });
    }),
  // ---- Komunitas K1 (receiving date) ----
  /**
   * How `set.receivedDate` is applied: `fill_empty` (when absent) sets it only on copies that have none, and refuses
   * the others with `received_date_set`; `overwrite` sets it on every copy.
   */
  receivedDateMode: z.enum(['fill_empty', 'overwrite']).optional(),
});

export type ItemBulkBody = z.infer<typeof ItemBulkBody>;

/**
 * The answer of a bulk change: the refused items with their reason; the others were changed. An item leaving
 * `withdrawn` is refused `record_archived` when its record is archived, `archived_reference` when the collection type,
 * location or supplier it keeps is archived.
 */
export interface ItemBulkResponse {
  updated: number;
  refused: {
    id: string;
    code: 'invalid_transition' | 'not_found' | 'invalid_location' | 'record_archived' | 'archived_reference' | 'received_date_set';
  }[];
}

/** `GET catalog/items`: filters, then a keyset page. */
export const ItemListQuery = z.strictObject({
  branchId: ulidField.optional(),
  locationId: ulidField.optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  collectionTypeId: ulidField.optional(),
  recordId: ulidField.optional(),
  barcodePrefix: shortText(64).min(1).optional(),
  ...cursorQuery,
});

export type ItemListQuery = z.infer<typeof ItemListQuery>;

/**
 * `GET catalog/items/by-barcode?barcode=` (M2): a query, because a barcode may hold `/` (Apache refuses `%2F` in a path
 * before Node sees it). The handler normalises it like a stored one.
 */
export const ItemByBarcodeQuery = z.strictObject({ barcode: rawBarcodeField });

export type ItemByBarcodeQuery = z.infer<typeof ItemByBarcodeQuery>;

/** Where an item stands, for display (`Ruang › Area › Rak`). */
export interface ItemLocationPath {
  roomId: string;
  roomName: string;
  areaName: string | null;
  shelfName: string | null;
  shelfHint: string | null;
}

/**
 * Where an item is in circulation, read from its open loan: being lent is never an item status (the item stays
 * `available`). `on_loan` with the due date (`YYYY-MM-DD`) and the loan's id; null when the item is not out.
 */
export interface ItemCirculation {
  state: 'on_loan' | null;
  dueOn?: string;
  loanId?: string;
}

/** One item as the admin sees it. Dates are `YYYY-MM-DD`; `price` is a decimal string in `currency`. */
export interface ItemView {
  id: string;
  record: { id: string; title: string };
  branch: { id: string; code: string; name: string };
  barcode: string;
  inventoryNo: string | null;
  callNumber: string | null;
  locationId: string | null;
  locationPath: ItemLocationPath | null;
  /** For an item without a location: the shelf whose call-number range holds its class (§3.4), not stored. */
  suggestedLocation: { id: string; name: string; shelfHint: string | null } | null;
  collectionTypeId: string;
  status: ItemStatus;
  statusNote: string | null;
  partsTotal: number;
  acqSource: AcqSource | null;
  orderNo: string | null;
  orderDate: string | null;
  receivedDate: string | null;
  invoiceDate: string | null;
  supplierId: string | null;
  invoiceNo: string | null;
  price: string | null;
  currency: string | null;
  note: string | null;
  custom: Record<string, unknown>;
  /** §2.5: `available` and its collection type is loanable; self-service when also `self_service`. */
  loanable: boolean;
  selfService: boolean;
  circulation: ItemCirculation;
  archived: boolean;
  createdAt: number;
  updatedAt: number | null;
  version: number;
}

/** One row of an item's history (`item_events`); `fields` names what changed, never the values. */
export interface ItemEventView {
  id: string;
  at: number;
  type: ItemEventType;
  fromStatus: ItemStatus | null;
  toStatus: ItemStatus | null;
  fromLocationId: string | null;
  toLocationId: string | null;
  actorType: string;
  actorId: string | null;
  fields: string[];
}

/** `GET catalog/items/:id`: the item with its history, newest first. */
export interface ItemDetail extends ItemView {
  history: ItemEventView[];
}

/** One row of the items list. */
export interface ItemListItem {
  id: string;
  barcode: string;
  record: { id: string; title: string };
  branch: { id: string; code: string };
  locationPath: ItemLocationPath | null;
  callNumber: string | null;
  collectionTypeId: string;
  status: ItemStatus;
  circulation: ItemCirculation;
  archived: boolean;
  version: number;
}

/** `GET catalog/items`. */
export type ItemListResponse = Paged<ItemListItem>;
