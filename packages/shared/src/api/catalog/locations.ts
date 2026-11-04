/**
 * The locations API vocabulary (Phase 2 spec §2.2 `locations`, §3.6, §12.2, §12.3; plan Tasks 14, 27): a branch's rooms,
 * areas and shelves, their call-number ranges and the shelf map. Writes are branch-scoped (`branches/:branchId/…`,
 * `catalog.locations.manage` with `branchParam`); an object of another branch is 404.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/locations`.
 */
import { z } from 'zod';
import { LOCATION_KINDS, type LocationKind } from '../../catalog-vocab.js';
import { ulidField, versionField } from '../common.js';
import { codeField, shortText, sortOrderField, type StoreResponse } from './common.js';

const locationFields = {
  /** Null for a room; an area's parent is a room, a shelf's a room or an area (`invalid_parent` otherwise). */
  parentId: ulidField.nullable(),
  kind: z.enum(LOCATION_KINDS),
  code: codeField,
  name: shortText(191).min(1),
  /** The short text the OPAC (and any shelf-finding client) shows; empty → the name cut to 40 characters. */
  shelfHint: shortText(40).nullable().optional(),
  /** The call-number range of a shelf (`class_from ≤ class ≤ class_to`), for the shelf suggestion (§3.4). */
  classFrom: shortText(32).nullable().optional(),
  classTo: shortText(32).nullable().optional(),
  isPublic: z.boolean(),
  sortOrder: sortOrderField,
};

/** `POST branches/:branchId/locations`. */
export const LocationBody = z.strictObject(locationFields);

export type LocationBody = z.infer<typeof LocationBody>;

/** `PATCH branches/:branchId/locations/:id`: only the fields sent change. */
export const LocationPatchBody = z.strictObject({
  version: versionField,
  parentId: locationFields.parentId.optional(),
  kind: locationFields.kind.optional(),
  code: locationFields.code.optional(),
  name: locationFields.name.optional(),
  shelfHint: locationFields.shelfHint,
  classFrom: locationFields.classFrom,
  classTo: locationFields.classTo,
  isPublic: locationFields.isPublic.optional(),
  sortOrder: locationFields.sortOrder.optional(),
});

export type LocationPatchBody = z.infer<typeof LocationPatchBody>;

/**
 * The answer of `PATCH branches/:branchId/locations/:id`: the StoreResponse, and `boxesCleared` when the patch moved
 * the location to another room: the location and those below it whose shelf-map box was cleared, since it was drawn
 * on the old room's floor plan (Task 40). The screen asks for them to be drawn again on the new room's map. A location
 * that became a room is not named (its box is cleared too, but a room takes none), only the boxes below it.
 */
export interface LocationUpdateResponse extends StoreResponse {
  boxesCleared?: string[];
}

/** A permil coordinate or size on the parent room's floor plan (SMALLINT 0-1000). */
const permil = z.int().min(0).max(1000);

/** A box on the floor plan, in permil of the picture; it stays inside it (`x + w`, `y + h` ≤ 1000). */
export const MapBox = z
  .strictObject({ x: permil, y: permil, w: permil, h: permil })
  .check((ctx) => {
    const { x, y, w, h } = ctx.value;
    if (x + w > 1000) ctx.issues.push({ code: 'too_big', origin: 'number', maximum: 1000 - x, inclusive: true, path: ['w'], input: w });
    if (y + h > 1000) ctx.issues.push({ code: 'too_big', origin: 'number', maximum: 1000 - y, inclusive: true, path: ['h'], input: h });
  });

export type MapBox = z.infer<typeof MapBox>;

/**
 * `PUT branches/:branchId/locations/:id/map`: a room takes its floor plan (a `catalog.floor_plan` upload, or null to
 * remove it), an area or a shelf its box on the room's plan (or null).
 */
export const LocationMapBody = z.strictObject({
  floorPlanFileId: ulidField.nullable().optional(),
  box: MapBox.nullable().optional(),
  version: versionField,
});

export type LocationMapBody = z.infer<typeof LocationMapBody>;

/** `GET catalog/locations?branchId=`: one branch's tree, or every branch's. */
export const LocationListQuery = z.strictObject({ branchId: ulidField.optional(), includeArchived: z.stringbool().optional() });

export type LocationListQuery = z.infer<typeof LocationListQuery>;

/** One location; `itemCount` counts the live items placed directly on it. */
export interface LocationView {
  id: string;
  branchId: string;
  parentId: string | null;
  kind: LocationKind;
  code: string;
  name: string;
  shelfHint: string | null;
  classFrom: string | null;
  classTo: string | null;
  /** A room's floor plan (a public file). */
  mapFileId: string | null;
  box: MapBox | null;
  isPublic: boolean;
  sortOrder: number;
  itemCount: number;
  archived: boolean;
  version: number;
}

/** The answer of `GET catalog/locations`, in tree order (each room, then its areas and shelves). */
export interface LocationListResponse {
  items: LocationView[];
}
