import { CSV_BOM, auditBatches, csvRow, listAudit, readSettings } from '@altis/core';
import { verifyAuditChain } from '@altis/db';
import {
  AUDIT_FILTER_KEYS,
  AuditExportQuery,
  AuditListQuery,
  type AuditFilters,
  type AuditItem,
  type AuditListResponse,
  type AuditVerifyResponse,
} from '@altis/shared/api/audit';
import { route, type RouteDecl } from '../http/route.js';
import { loggableError } from '../safe-error.js';

// The audit routes of Task 23 (spec §7.4, §7.8, §13.5 "Audit"; route catalog):
//
// - `audit.list` (GET audit): one page of the log, newest first, keyset on `seq` (core's listAudit, decision D8).
// - `audit.verify` (GET audit/verify): verifyAuditChain over the whole log, outside any transaction; from 1c (Task 18,
//   §7.8, L39) it starts at the retention anchor `audit.anchor` when a purge has set one, so it keeps verifying after
//   the oldest entries were deleted.
// - `audit.export` (GET audit/export, `mode: system`, so it keeps working in read-only, §8.6): a re-authentication
//   within 5 minutes first (401 AUTH_REAUTH_REQUIRED without one), since the file holds personal data: each actor's
//   staff name (a registered personal column) and each entry's IP address, and exporting personal data always asks
//   for the password again (§7.3). Then the `audit.export`
//   entry (meta = the filters given) is committed in its own `rc.withTx` before anything is streamed, so every export
//   that sends a byte is in the log. The CSV then streams through the one exporter (core's csvRow, §7.4): a UTF-8 BOM
//   and the header row first, then one chunk per batch of auditBatches (at most 1000 rows, read only when the client
//   has taken the previous chunk: memory stays bounded, M16). No transaction is held while streaming. The response is
//   built through the context (`rc.c.body`), so step 7's rotated session cookie and `X-CSRF-Token` go out with it
//   (ruling R1b-1). A database failure in mid-stream is logged and ends the stream with an error (the client sees a
//   truncated download, never a partial file presented as complete). A download the client cancels (a closed tab, a
//   dropped connection) is logged at info level: the batch being read when it went is dropped, never reported as a
//   failure of the export.

const AUDIT = '/api/v1/audit';

/** The CSV columns, in order. */
const EXPORT_COLUMNS = ['seq', 'at', 'actorType', 'actorId', 'actorName', 'action', 'entity', 'entityId', 'branchId', 'ip', 'meta'];

/** `at` as ISO 8601 (UTC); a value no Date can hold (only a tampered row has one) as its number. */
function isoTime(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
}

/** One CSV record of `item`, in {@link EXPORT_COLUMNS} order; every cell goes through csvCell (csvRow). */
function exportValues(item: AuditItem): unknown[] {
  return [
    item.seq,
    isoTime(item.at),
    item.actorType,
    item.actorId,
    item.actorName,
    item.action,
    item.entity,
    item.entityId,
    item.branchId,
    item.ip,
    item.meta,
  ];
}

/** `YYYYMMDD` (UTC) of an epoch-ms bound; the schema keeps it within years 0000-9999. */
function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** `audit-<from>-<to>.csv`: each bound as `YYYYMMDD` (UTC), or `all` / `now` without one (M33). */
export function exportFilename(f: Pick<AuditFilters, 'from' | 'to'>): string {
  return `audit-${f.from === undefined ? 'all' : ymd(f.from)}-${f.to === undefined ? 'now' : ymd(f.to)}.csv`;
}

/** The filters given in `q`, without the keys left out (they are the meta of the `audit.export` entry). */
function givenFilters(q: AuditFilters): AuditFilters {
  const out: Record<string, unknown> = {};
  for (const key of AUDIT_FILTER_KEYS) if (q[key] !== undefined) out[key] = q[key];
  return out as AuditFilters;
}

/** GET audit. */
const auditList = route({
  id: 'audit.list',
  method: 'GET',
  path: AUDIT,
  permission: 'system.audit.read',
  idempotency: 'none',
  audit: null,
  query: AuditListQuery,
  handler: async (rc) => {
    const body: AuditListResponse = await listAudit(rc.db.db, rc.query);
    return { body, headers: { 'Cache-Control': 'no-store' } };
  },
});

/** GET audit/verify. */
const auditVerify = route({
  id: 'audit.verify',
  method: 'GET',
  path: `${AUDIT}/verify`,
  permission: 'system.audit.read',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    // 1c Task 18 (§7.8, L39): read afresh, never through the settings cache, since a purge moves it.
    const anchor = (await readSettings(rc.db.db, ['audit.anchor'], []))['audit.anchor'] as { seq: number; hash: string } | null;
    const body: AuditVerifyResponse = await verifyAuditChain(rc.db, anchor === null ? {} : { anchor });
    return { body, headers: { 'Cache-Control': 'no-store' } };
  },
});

/** GET audit/export. */
const auditExport = route({
  id: 'audit.export',
  method: 'GET',
  path: `${AUDIT}/export`,
  permission: 'system.audit.export',
  reauth: true,
  mode: 'system',
  idempotency: 'none',
  audit: 'audit.export',
  query: AuditExportQuery,
  handler: async (rc) => {
    const filters = givenFilters(rc.query);
    const delimiter = rc.query.delimiter === 'semicolon' ? ';' : ',';
    const db = rc.db.db;
    // Committed before the first byte: an export that sends anything is always in the log.
    await rc.withTx(() => rc.audit({ entity: 'audit_log', entityId: null, meta: { ...filters } }));

    const log = rc.log;
    const batches = auditBatches(db, filters);
    const encoder = new TextEncoder();
    /** Set once the client cancelled: a batch that arrives afterwards has nowhere to go. */
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(CSV_BOM + csvRow(EXPORT_COLUMNS, delimiter)));
      },
      // Called for the next chunk only once the client has taken the previous one (high-water mark 1).
      async pull(controller) {
        try {
          const next = await batches.next();
          if (cancelled) return;
          if (next.done === true) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(next.value.map((item) => csvRow(exportValues(item), delimiter)).join('')));
        } catch (error) {
          if (cancelled) return;
          log.error('audit export failed', { route: 'audit.export', err: loggableError(error) });
          controller.error(error);
        }
      },
      async cancel() {
        cancelled = true;
        log.info('audit export cancelled', { route: 'audit.export' });
        try {
          await batches.return(undefined);
        } catch {
          // the client has gone: nothing is left to answer
        }
      },
    });
    return rc.c.body(stream, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(filters)}"`,
      'Cache-Control': 'no-store',
    });
  },
});

/** The routes of this file, in the order of the route catalog. */
export const AUDIT_ROUTES: RouteDecl[] = [auditList, auditVerify, auditExport];
