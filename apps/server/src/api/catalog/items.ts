import {
  archiveItem,
  batchCreateItems,
  bulkUpdateItems,
  createItem,
  ensureBarcodeLockRow,
  getItem,
  itemByBarcode,
  listItems,
  readSettings,
  updateItem,
} from '@altis/core';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import {
  ItemBatchBody,
  ItemBulkBody,
  ItemByBarcodeQuery,
  ItemCreateBody,
  ItemListQuery,
  ItemPatchBody,
  type ItemBatchResponse,
  type ItemBulkResponse,
  type ItemDetail,
  type ItemListResponse,
} from '@altis/shared/api/catalog/items';
import { ulidField, versionField } from '@altis/shared/api/common';
import type { BarcodePattern } from '@altis/shared/api/settings';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// The catalog API routes of items (Phase 2 spec §2.5, §3.4, §12.2, §12.3; plan Task 17, route catalog): list, get, by
// barcode, and the branch-scoped writes (create, batch, bulk, update, archive).
//
// - Reads need `catalog.records.read` (global). Writes need `catalog.items.manage` at the branch of the path
//   (`branchParam: 'branchId'`, D2-02); the service answers 404 for an item of another branch.
// - `GET catalog/items/by-barcode?barcode=` (M2): a query, because a barcode may hold `/`, which Apache with
//   `AllowEncodedSlashes Off` refuses in a path before Node sees it. It is declared before `catalog/items/:id`. The
//   service normalises and checks the raw text before it queries.
// - The writes are `store` routes and answer `StoreResponse` (`{id, version}`, S15); a create answers 201. Batch (201)
//   and bulk answer their own small summaries. Archive takes the item's `version` in its body (`{version}`), as the
//   records' archive does.
// - The batch's `prepare` makes sure the pattern's lock row exists (`ensureBarcodeLockRow`, M8: in a short transaction
//   of its own, outside the handler's, on every request, so a row a restore or a purge removed comes back) when the
//   pattern is one of `catalog.barcode.patterns`; an unknown pattern makes no row and the handler refuses it.

const ITEMS = '/api/v1/catalog/items';
const BRANCH_ITEMS = '/api/v1/branches/:branchId/items';
const ItemParams = z.strictObject({ id: ulidField });
const BranchParams = z.strictObject({ branchId: ulidField });
const BranchItemParams = z.strictObject({ branchId: ulidField, id: ulidField });
/** The body of archive: the item's version. */
const VersionBody = z.strictObject({ version: versionField });

const itemsList = route({
  id: 'catalog.items.list',
  method: 'GET',
  path: ITEMS,
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  query: ItemListQuery,
  handler: async (rc) => {
    const body: ItemListResponse = await listItems(rc.db.db, rc.query);
    return { body };
  },
});

const itemsByBarcode = route({
  id: 'catalog.items.by_barcode',
  method: 'GET',
  path: `${ITEMS}/by-barcode`,
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  query: ItemByBarcodeQuery,
  handler: async (rc) => {
    const body: ItemDetail = await itemByBarcode(rc.db.db, rc.query.barcode);
    return { body };
  },
});

const itemsGet = route({
  id: 'catalog.items.get',
  method: 'GET',
  path: `${ITEMS}/:id`,
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  params: ItemParams,
  handler: async (rc) => {
    const body: ItemDetail = await getItem(rc.db.db, rc.params.id);
    return { body };
  },
});

const itemsCreate = route({
  id: 'catalog.items.create',
  method: 'POST',
  path: BRANCH_ITEMS,
  permission: 'catalog.items.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'catalog.item.create',
  params: BranchParams,
  body: ItemCreateBody,
  handler: async (rc) => {
    const r = await createItem(rc.tx(), rc.params.branchId, rc.body);
    const body: StoreResponse = { id: r.id, version: r.version };
    return { status: 201, body };
  },
});

const itemsBatch = route({
  id: 'catalog.items.batch',
  method: 'POST',
  path: `${BRANCH_ITEMS}/batch`,
  permission: 'catalog.items.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'catalog.item.batch_create',
  params: BranchParams,
  body: ItemBatchBody,
  prepare: async (rc) => {
    const patternId = rc.body.patternId;
    if (patternId === undefined) return;
    const settings = await readSettings(rc.db.db, ['catalog.barcode.patterns'], rc.config.keyring);
    const patterns = settings['catalog.barcode.patterns'] as BarcodePattern[];
    if (patterns.some((p) => p.id === patternId)) await ensureBarcodeLockRow(rc.db, patternId);
  },
  handler: async (rc) => {
    const body: ItemBatchResponse = await batchCreateItems(rc.tx(), rc.params.branchId, rc.body);
    return { status: 201, body };
  },
});

const itemsBulk = route({
  id: 'catalog.items.bulk',
  method: 'POST',
  path: `${BRANCH_ITEMS}/bulk`,
  permission: 'catalog.items.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'catalog.item.bulk_update',
  params: BranchParams,
  body: ItemBulkBody,
  handler: async (rc) => {
    const body: ItemBulkResponse = await bulkUpdateItems(rc.tx(), rc.params.branchId, rc.body);
    return { body };
  },
});

const itemsUpdate = route({
  id: 'catalog.items.update',
  method: 'PATCH',
  path: `${BRANCH_ITEMS}/:id`,
  permission: 'catalog.items.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'catalog.item.update',
  params: BranchItemParams,
  body: ItemPatchBody,
  handler: async (rc) => {
    const r = await updateItem(rc.tx(), rc.params.branchId, rc.params.id, rc.body);
    const body: StoreResponse = { id: r.id, version: r.version };
    return { body };
  },
});

const itemsArchive = route({
  id: 'catalog.items.archive',
  method: 'DELETE',
  path: `${BRANCH_ITEMS}/:id`,
  permission: 'catalog.items.manage',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'catalog.item.archive',
  params: BranchItemParams,
  body: VersionBody,
  handler: async (rc) => {
    const r = await archiveItem(rc.tx(), rc.params.branchId, rc.params.id, rc.body.version);
    const body: StoreResponse = { id: r.id, version: r.version };
    return { body };
  },
});

export const ITEMS_ROUTES: RouteDecl[] = [itemsList, itemsByBarcode, itemsGet, itemsCreate, itemsBatch, itemsBulk, itemsUpdate, itemsArchive];
