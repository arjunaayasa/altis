/**
 * The audit API vocabulary shared by the server and the admin SPA (spec §7.8, §13.5 "Audit"): the query strings of
 * `GET audit` and `GET audit/export`, and the answers of `GET audit` and `GET audit/verify`. No Node built-ins here:
 * the browser bundles this module. Import it as `@altis/shared/api/audit`.
 *
 * Query strings are text, so the numbers go through `z.coerce.number().int()` (M5); every object is strict (§7.4).
 */
import { z } from 'zod';
import { AUDIT_ACTIONS } from '../audit-actions.js';
import { ulidField } from './common.js';

/** 9999-12-31T23:59:59.999Z: the last instant an ISO 8601 date (and a `YYYYMMDD` file name) can show plainly. */
export const AUDIT_MAX_TIME = 253_402_300_799_999;

/** An epoch-ms bound of the time filter, from a query string. */
const timeBound = z.coerce.number().int().min(0).max(AUDIT_MAX_TIME);

/**
 * The filters of the audit log: one action, one actor (a staff user's id), the entity kind (`audit_log.entity`, at
 * most 64 characters) and its identifier (`entity_id`, at most 191), and a time range in epoch ms where both bounds
 * are included (`from` ≤ `at` ≤ `to`).
 */
const filterShape = {
  action: z.enum(AUDIT_ACTIONS).optional(),
  actorId: ulidField.optional(),
  entity: z.string().min(1).max(64).optional(),
  entityId: z.string().min(1).max(191).optional(),
  from: timeBound.optional(),
  to: timeBound.optional(),
};

/** `from` after `to` matches nothing: refused at `to`. */
function rangeOk(q: { from?: number | undefined; to?: number | undefined }): boolean {
  return q.from === undefined || q.to === undefined || q.from <= q.to;
}

/** The default page size of `GET audit`. */
export const AUDIT_PAGE_DEFAULT = 50;
/** The largest page size of `GET audit`. */
export const AUDIT_PAGE_MAX = 200;

/**
 * `GET audit`: the filters, plus keyset paging on `seq` (decision D8): `before` is the `nextBefore` of the previous
 * page (only entries with a lower `seq`), `limit` the page size (1-200, default 50).
 */
export const AuditListQuery = z
  .strictObject({
    ...filterShape,
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).optional(),
  })
  .refine(rangeOk, { path: ['to'] });

export type AuditListQuery = z.infer<typeof AuditListQuery>;

/** The filters alone (what `GET audit/export` writes into the meta of its `audit.export` entry). */
export type AuditFilters = Pick<AuditListQuery, 'action' | 'actorId' | 'entity' | 'entityId' | 'from' | 'to'>;

/** The names of {@link AuditFilters}, in a fixed order. */
export const AUDIT_FILTER_KEYS = Object.freeze(['action', 'actorId', 'entity', 'entityId', 'from', 'to'] as const);

/**
 * `GET audit/export`: the filters, plus the delimiter of the CSV file (`comma`, the default, or `semicolon`, which
 * Excel on Indonesian Windows expects: decision D28).
 */
export const AuditExportQuery = z
  .strictObject({
    ...filterShape,
    delimiter: z.enum(['comma', 'semicolon']).optional(),
  })
  .refine(rangeOk, { path: ['to'] });

export type AuditExportQuery = z.infer<typeof AuditExportQuery>;

/**
 * One audit entry as the API shows it. `at` is epoch ms; `actorName` is the current name of the staff user who acted
 * (null for another actor type, or when the user no longer exists); `action` is the stored text (an action of a later
 * release stays readable); `meta` is the entry's JSON object (`{}` if the stored text is not one: `GET audit/verify`
 * then reports the row).
 */
export interface AuditItem {
  seq: number;
  at: number;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  branchId: string | null;
  ip: string | null;
  meta: Record<string, unknown>;
}

/** The answer of `GET audit`: newest first; `nextBefore` is the `before` of the next page, null on the last one. */
export interface AuditListResponse {
  items: AuditItem[];
  nextBefore: number | null;
}

/**
 * The answer of `GET audit/verify` (spec §7.8): the chain verifies up to `head` (the last `seq`; 0 for an empty
 * log), or it breaks at `brokenAt`, the first `seq` that does not verify.
 */
export type AuditVerifyResponse = { ok: true; head: number } | { ok: false; brokenAt: number };
