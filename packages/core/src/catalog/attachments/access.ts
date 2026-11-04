import type { DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';

// Who `/files/:id` serves a catalog file to (Phase 2 spec §8, §10; preflight S18; plan Task 18). `files.access` says
// what the file is by itself; a cover or an attachment is published only while its record is:
//
//   never        a run report (`owner_type 'catalog_runs'` or context `catalog.report`): never served by `/files/:id`,
//                to anyone, a super admin included. A report holds legacy rows, titles and source host names, and
//                streams only through `GET catalog/runs/:id/report` (Task 19), which applies `catalog.records.read`
//                and hides migration runs from whoever lacks `catalog.migration.run` (P2-27).
//   staff        `files.access` is not `public`: staff only.
//   unpublished  a public cover (`owner_type 'records'`) or attachment file whose record is hidden from the OPAC,
//                archived or merged, or whose attachment is archived or `staff` (or gone): served as a staff file;
//                to anyone else it no longer exists.
//   public       every other public file (a page image, a floor plan, a published cover or attachment).

type Db = Kysely<DB> | Transaction<DB>;

/** How `/files/:id` may serve a file (see the top of this file). */
export type CatalogFileAccess = 'public' | 'staff' | 'unpublished' | 'never';

/** Whether record `id` is shown on the OPAC: it exists, is visible, and is neither archived nor merged. */
async function recordPublished(db: Db, id: string | null): Promise<boolean> {
  if (id === null) return false;
  const r = await db.selectFrom('records').select(['opac_visible', 'archived_at', 'merged_into']).where('id', '=', id).executeTakeFirst();
  return r !== undefined && Number(r.opac_visible) === 1 && r.archived_at === null && r.merged_into === null;
}

/** How `/files/:id` may serve the file `f` (a `files` row's context, owner and access; see the top of this file). */
export async function catalogFileAccess(
  db: Db,
  f: { context: string; owner_type: string | null; owner_id: string | null; access: string },
): Promise<CatalogFileAccess> {
  if (f.owner_type === 'catalog_runs' || f.context === 'catalog.report') return 'never';
  if (f.access !== 'public') return 'staff';
  if (f.owner_type === 'records') return (await recordPublished(db, f.owner_id)) ? 'public' : 'unpublished';
  if (f.owner_type === 'attachments') {
    if (f.owner_id === null) return 'unpublished';
    const a = await db.selectFrom('attachments').select(['record_id', 'access', 'archived_at']).where('id', '=', f.owner_id).executeTakeFirst();
    if (a === undefined || a.archived_at !== null || a.access !== 'public') return 'unpublished';
    return (await recordPublished(db, a.record_id)) ? 'public' : 'unpublished';
  }
  return 'public';
}
