import type { DB } from '@altis/db';
import { AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX, type AuditFilters, type AuditItem, type AuditListQuery } from '@altis/shared/api/audit';
import type { Kysely } from 'kysely';

// Reading the audit log (spec §7.8, decision D8): the admin's audit viewer pages it newest first, and the CSV export
// reads it oldest first in batches. Both use keyset paging on `seq` (the chain's order, UNIQUE), never an offset: the
// log grows to hundreds of thousands of rows (200k in the perf seed), and `(action, seq)` (index 0008) answers the
// action filter without a sort.
//
// Each statement runs on its own: the reads hold no transaction, so a long export never keeps SQLite's one connection
// or a row lock for longer than one batch. The rows are fetched with a left join on staff_users for the actor's
// current name.

/** Rows per batch of {@link auditBatches} (the export's default). */
export const AUDIT_EXPORT_BATCH = 1000;

/** The one row of audit_head (migration 0004). */
const HEAD_ID = 1;

/** The audit_log rows matching `f`, with the actor's name. */
function filtered(db: Kysely<DB>, f: AuditFilters) {
  let q = db
    .selectFrom('audit_log')
    .leftJoin('staff_users', (join) =>
      join.onRef('staff_users.id', '=', 'audit_log.actor_id').on('audit_log.actor_type', '=', 'staff'),
    )
    .select([
      'audit_log.seq',
      'audit_log.at',
      'audit_log.actor_type',
      'audit_log.actor_id',
      'staff_users.name as actor_name',
      'audit_log.action',
      'audit_log.entity',
      'audit_log.entity_id',
      'audit_log.branch_id',
      'audit_log.ip',
      'audit_log.meta',
    ]);
  if (f.action !== undefined) q = q.where('audit_log.action', '=', f.action);
  if (f.actorId !== undefined) q = q.where('audit_log.actor_id', '=', f.actorId);
  if (f.entity !== undefined) q = q.where('audit_log.entity', '=', f.entity);
  if (f.entityId !== undefined) q = q.where('audit_log.entity_id', '=', f.entityId);
  if (f.from !== undefined) q = q.where('audit_log.at', '>=', f.from);
  if (f.to !== undefined) q = q.where('audit_log.at', '<=', f.to);
  return q;
}

type Row = Awaited<ReturnType<ReturnType<typeof filtered>['execute']>>[number];

/**
 * The stored meta as an object. A text that is not a JSON object (only a tampered or damaged row holds one) reads as
 * `{}` rather than failing the whole page or export; `GET audit/verify` reports that row.
 */
function metaObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // not JSON: falls through
  }
  return {};
}

function toItem(r: Row): AuditItem {
  return {
    seq: Number(r.seq),
    at: Number(r.at),
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorName: r.actor_name ?? null,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    branchId: r.branch_id,
    ip: r.ip,
    meta: metaObject(r.meta),
  };
}

/**
 * One page of the audit log matching the filters of `q`, newest first (`seq` descending): at most `q.limit` entries
 * (default 50, at most 200) with a `seq` below `q.before` when given. `nextBefore` is the `seq` of the last entry when
 * more entries follow (the `before` of the next page), otherwise null.
 *
 * @throws RangeError for a `limit` outside 1-200 or a `before` that is not a safe integer (the API's schema refuses
 *   both first)
 */
export async function listAudit(db: Kysely<DB>, q: AuditListQuery): Promise<{ items: AuditItem[]; nextBefore: number | null }> {
  const limit = q.limit ?? AUDIT_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUDIT_PAGE_MAX) {
    throw new RangeError(`limit must be an integer from 1 to ${AUDIT_PAGE_MAX}`);
  }
  if (q.before !== undefined && !Number.isSafeInteger(q.before)) throw new RangeError('before must be a safe integer');
  let query = filtered(db, q).orderBy('audit_log.seq', 'desc').limit(limit + 1);
  if (q.before !== undefined) query = query.where('audit_log.seq', '<', q.before);
  const rows = await query.execute();
  const items = rows.slice(0, limit).map(toItem);
  return { items, nextBefore: rows.length > limit ? items[items.length - 1]!.seq : null };
}

/**
 * The audit log matching the filters `q`, oldest first (`seq` ascending), in arrays of at most `batch` entries: one
 * statement per batch, keyset on `seq` (no cursor and no `.stream()`, deferred L31), so memory stays bounded however
 * long the log is. Nothing is read until the first `next()`.
 *
 * The export is a snapshot of the log as it stood when it started: rows up to audit_head's `last_seq` read first
 * (every row up to a committed head is committed), so entries appended while it runs are not part of it. An empty
 * result yields no batch.
 *
 * @throws RangeError (on the first `next()`) for a `batch` that is not a positive safe integer
 */
export async function* auditBatches(db: Kysely<DB>, q: AuditFilters, batch = AUDIT_EXPORT_BATCH): AsyncGenerator<AuditItem[]> {
  if (!Number.isSafeInteger(batch) || batch < 1) throw new RangeError('batch must be a positive integer');
  const head = await db.selectFrom('audit_head').select('last_seq').where('id', '=', HEAD_ID).executeTakeFirst();
  const upTo = head === undefined ? null : Number(head.last_seq);
  let after = 0;
  for (;;) {
    let query = filtered(db, q).where('audit_log.seq', '>', after).orderBy('audit_log.seq').limit(batch);
    if (upTo !== null) query = query.where('audit_log.seq', '<=', upTo);
    const rows = await query.execute();
    if (rows.length === 0) return;
    const items = rows.map(toItem);
    after = items[items.length - 1]!.seq;
    yield items;
    if (rows.length < batch) return;
  }
}
