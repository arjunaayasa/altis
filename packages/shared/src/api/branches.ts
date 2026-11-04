/**
 * The branches API vocabulary shared by the server and the admin SPA (spec §6.5, §7.2, decision D6). No Node
 * built-ins here: the browser bundles this module. Import it as `@altis/shared/api/branches`.
 */
import { z } from 'zod';
import { branchCodeField, personNameField, timezoneField, versionField } from './common.js';

/** The street address, free text: at most 1000 characters (the column is TEXT, so the limit is the API's own). */
const branchAddressField = z.string().max(1000);

/**
 * `GET branches`. A query string is text (M5): `z.stringbool()` reads `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`.
 * Archived branches are left out unless `includeArchived` is true.
 */
export const BranchListQuery = z.strictObject({ includeArchived: z.stringbool().optional() });

export type BranchListQuery = z.infer<typeof BranchListQuery>;

/** `POST branches`. The code is unique on its normalized key (`CAB-1` and `cab-1 ` are one code). */
export const BranchCreateBody = z.strictObject({
  code: branchCodeField,
  name: personNameField,
  address: branchAddressField.nullable().optional(),
  timezone: timezoneField,
});

export type BranchCreateBody = z.infer<typeof BranchCreateBody>;

/** `PATCH branches/:id`: only the fields sent change; `address: null` clears it. `version` is the row's current one. */
export const BranchPatchBody = z.strictObject({
  version: versionField,
  code: branchCodeField.optional(),
  name: personNameField.optional(),
  address: branchAddressField.nullable().optional(),
  timezone: timezoneField.optional(),
});

export type BranchPatchBody = z.infer<typeof BranchPatchBody>;

/** One branch as the API shows it. `code` is the code as typed (`code_display`). */
export interface BranchItem {
  id: string;
  code: string;
  name: string;
  address: string | null;
  timezone: string;
  isDefault: boolean;
  /** Epoch ms, or null while the branch is active. */
  archivedAt: number | null;
  version: number;
}

/**
 * One branch as `GET branches` shows it. `active` is false when this edition does not let staff write to the branch;
 * community: `archivedAt === null`.
 */
export interface BranchView extends BranchItem {
  active: boolean;
}

/** The answer of `GET branches`: the default branch first, then by code. */
export interface BranchListResponse {
  items: BranchView[];
}
