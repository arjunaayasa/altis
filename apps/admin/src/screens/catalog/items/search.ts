import { ITEM_STATUSES, type ItemStatus } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';

/**
 * The filters of Eksemplar's list as its URL holds them (Phase 2 plan Task 25): the route's `validateSearch`
 * (routes/catalog/items.tsx) and the list screen read the URL through {@link itemsSearchOf}, so a link from elsewhere
 * (a record's items tab: `?recordId=`) and a filter change agree on one shape. Kept apart from the screen so that the
 * route file does not pull the screen's lazy chunk into the main bundle.
 */

/** The list's filters (every one optional; ids are ULIDs). */
export interface ItemsSearch {
  branchId?: string;
  locationId?: string;
  status?: ItemStatus;
  collectionTypeId?: string;
  recordId?: string;
}

/** The filter names, in the order the list's query string writes them. */
export const ITEMS_FILTER_KEYS = ['branchId', 'locationId', 'status', 'collectionTypeId', 'recordId'] as const;

/** True for a ULID (an id read from the URL is checked before it is sent anywhere). */
export const isUlid = (v: unknown): v is string => typeof v === 'string' && ulidField.safeParse(v).success;

/**
 * The valid filters of a URL's search: ids are ULIDs, the status one of ITEM_STATUSES, and a location needs its branch
 * (a location belongs to one branch). Anything else is dropped.
 */
export function itemsSearchOf(search: Record<string, unknown>): ItemsSearch {
  const out: ItemsSearch = {};
  if (isUlid(search['branchId'])) out.branchId = search['branchId'];
  if (out.branchId !== undefined && isUlid(search['locationId'])) out.locationId = search['locationId'];
  const status = search['status'];
  if (typeof status === 'string' && (ITEM_STATUSES as readonly string[]).includes(status)) out.status = status as ItemStatus;
  if (isUlid(search['collectionTypeId'])) out.collectionTypeId = search['collectionTypeId'];
  if (isUlid(search['recordId'])) out.recordId = search['recordId'];
  return out;
}
