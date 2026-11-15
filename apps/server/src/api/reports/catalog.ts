import { can, loadAccredSettings, previewReport, readSettings, reportBranchOf, reportById, reportCatalogEntry, visibleReports, type ReportDefinition } from '@altis/core';
import { DomainError, resolveLocale, type Locale, type Permission } from '@altis/shared';
import { ReportPreviewBody, reportOutputLocale, type ReportCatalogResponse, type ReportPreviewResponse } from '@altis/shared/api/reports';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';

// The report catalogue and the paged preview (spec §4.15, §5.2):
//
//   GET  reports/catalog              any signed-in staff member: the definitions whose permission they hold, each with
//                                     its parameters, its columns (null when the parameters shape them) and whether
//                                     they may export it (`canExport`: the export permission, and a table report)
//   POST reports/:reportId/preview    any signed-in staff member, who must hold the definition's permission (checked
//                                     here, before anything is read: the declaration cannot name a per-definition
//                                     permission); a read-only POST (`mode: read`, no audit) that runs outside a
//                                     transaction (`tx: 'self'`), so no transaction stays open while the report reads.
//                                     One keyset page; an unknown report 404, a document 422 `not_previewable`, a
//                                     report that scans the stock of a large library 422 `export_only`. The rows
//                                     are written in the language the definition's output is in (outputLocaleOf):
//                                     an accreditation annex in Indonesian, whatever the user reads, as its export.
//
// A definition whose permission is a branch permission (a stocktake report) is listed to whoever holds it at any
// branch, and checked at the branch its parameters address (ReportDefinition.branchOf), so a role granted at one
// branch only may preview and export it there.

const ReportParams = z.strictObject({ reportId: z.string().min(1).max(64) });

/** What the request's user holds, as a predicate over permissions (a session is required on these routes). */
export function holdsOf(rc: RouteContext<unknown, unknown, unknown>): (p: Permission) => boolean {
  const auth = rc.auth;
  if (auth === null) throw new DomainError('AUTH_REQUIRED');
  return (p) => can(auth.grants, p);
}

// ---- Komunitas K4 (stocktake) ----
/** What the request's user holds anywhere: globally, or at one branch at least (a branch permission). */
export function holdsAnywhereOf(rc: RouteContext<unknown, unknown, unknown>): (p: Permission) => boolean {
  const auth = rc.auth;
  if (auth === null) throw new DomainError('AUTH_REQUIRED');
  return (p) => can(auth.grants, p) || [...auth.grants.branches.values()].some((held) => held.has(p));
}

/** Whether the request's user holds `permission` for `def` with `params`: at the branch they address, if any. */
export async function holdsForReport(rc: RouteContext<unknown, unknown, unknown>, def: ReportDefinition, params: Readonly<Record<string, unknown>>, permission: Permission): Promise<boolean> {
  const auth = rc.auth;
  if (auth === null) throw new DomainError('AUTH_REQUIRED');
  return can(auth.grants, permission, await reportBranchOf(rc.db.db, def, params));
}

/** The definition `id` names. @throws DomainError `NOT_FOUND` */
export function definitionOf(id: string): ReportDefinition {
  const def = reportById(id);
  if (def === null) throw new DomainError('NOT_FOUND', { detail: 'Laporan tidak ditemukan / The report was not found' });
  return def;
}

/** The UI language of the request's user: their own, else the library's. */
export async function uiLocaleOf(rc: RouteContext<unknown, unknown, unknown>): Promise<Locale> {
  const library = (await readSettings(rc.db.db, ['library.locale'], []))['library.locale'] as string;
  return resolveLocale(rc.auth?.user.locale ?? null, library);
}

/**
 * The language a definition's output is written in, in a preview as in an export: an accreditation definition (an
 * annex or a document) always in Indonesian, whatever the requester reads, since that is the language of the files
 * handed to the assessors; any other in the requester's UI language. The rule is the shared one the admin screen
 * also labels and prints a preview by (`reportOutputLocale`).
 */
export async function outputLocaleOf(rc: RouteContext<unknown, unknown, unknown>, def: ReportDefinition): Promise<Locale> {
  return reportOutputLocale(def.module, await uiLocaleOf(rc));
}

const reportsCatalog = route({
  id: 'reports.catalog',
  method: 'GET',
  path: '/api/v1/reports/catalog',
  public: true,
  session: 'required',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const holds = holdsAnywhereOf(rc);
    const body: ReportCatalogResponse = { reports: visibleReports(holds).map((def) => reportCatalogEntry(def, holds)) };
    return { body };
  },
});

const reportsPreview = route({
  id: 'reports.preview',
  method: 'POST',
  path: '/api/v1/reports/:reportId/preview',
  public: true,
  session: 'required',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  params: ReportParams,
  body: ReportPreviewBody,
  handler: async (rc) => {
    const def = definitionOf(rc.params.reportId);
    if (!(await holdsForReport(rc, def, rc.body.params, def.permission))) throw await rc.authzDenied(def.permission);
    // ---- Komunitas (member, visit and circulation reports) ----
    const extra = def.extraPermission?.(rc.body.params) ?? null;
    if (extra !== null && !holdsOf(rc)(extra)) throw await rc.authzDenied(extra);
    const db = rc.db.db;
    const tz = (await readSettings(db, ['library.timezone'], []))['library.timezone'] as string;
    const body: ReportPreviewResponse = await previewReport(db, def, rc.body, {
      locale: await outputLocaleOf(rc, def),
      tz,
      now: rc.now,
      settings: await loadAccredSettings(db),
    });
    return { body };
  },
});

export const REPORT_CATALOG_ROUTES: RouteDecl[] = [reportsCatalog, reportsPreview];
