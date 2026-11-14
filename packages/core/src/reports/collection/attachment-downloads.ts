import { countRows, sumGrouped } from '@altis/db';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { allOf, decodeCursor, encodeCursor, instantRange, label, rangeParam, textParam, titleCell } from './common.js';

// How often each attachment of the catalogue was opened (spec §9.1): the count kept on the attachment itself, counts a
// SLiMS migration carried over included. It never says who opened it or when (the library keeps no such record).
// Filtered by when the record was created, its material type and the attachment's access; by title, then attachment.

/** Who may open an attachment. */
export const ATTACHMENT_REPORT_ACCESS = Object.freeze(['public', 'staff'] as const);

/** The attachments of the report: not archived, of a record that is not archived, filtered. */
function attachmentWhere(ctx: ReportCtx): RawBuilder<SqlBool> {
  const parts: RawBuilder<SqlBool>[] = [sql<SqlBool>`${sql.ref('a.archived_at')} is null`, sql<SqlBool>`${sql.ref('r.archived_at')} is null`];
  const created = instantRange(ctx.tz, rangeParam(ctx, 'created'));
  if (created.from !== null) parts.push(sql<SqlBool>`${sql.ref('r.created_at')} >= ${created.from}`);
  if (created.to !== null) parts.push(sql<SqlBool>`${sql.ref('r.created_at')} < ${created.to}`);
  const materialTypeId = textParam(ctx, 'materialTypeId');
  if (materialTypeId !== null) parts.push(sql<SqlBool>`${sql.ref('r.material_type_id')} = ${materialTypeId}`);
  const access = textParam(ctx, 'access');
  if (access !== null) parts.push(sql<SqlBool>`${sql.ref('a.access')} = ${access}`);
  return allOf(parts);
}

function base(ctx: ReportCtx) {
  return ctx.db.selectFrom('attachments as a').innerJoin('records as r', 'r.id', 'a.record_id').where(attachmentWhere(ctx));
}

const keyset = z.tuple([z.string().max(400), z.string().min(1).max(26), z.string().min(1).max(26)]);

/** How often each attachment was opened (counts only, never who). */
export const collectionAttachmentDownloadsReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.attachment_downloads',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.attachment_downloads.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [reportParam('created', 'dateRange'), reportParam('materialTypeId', 'materialType'), reportParam('access', 'status', { options: ATTACHMENT_REPORT_ACCESS })],
  paramsSchema: z.strictObject({
    created: reportDateRangeField.optional(),
    materialTypeId: reportIdField.optional(),
    access: z.enum(ATTACHMENT_REPORT_ACCESS).optional(),
  }),
  columns: [reportColumn('title', 'text'), reportColumn('attachment', 'text'), reportColumn('mime', 'text'), reportColumn('downloads', 'int')],
  async rows(ctx, cursor, limit) {
    let q = base(ctx)
      .leftJoin('files as f', 'f.id', 'a.file_id')
      .select(['a.id', 'a.record_id', 'r.title_key', 'r.title', 'r.subtitle', 'a.title as attachment', 'f.mime', 'a.read_count'])
      .orderBy('r.title_key')
      .orderBy('a.record_id')
      .orderBy('a.id')
      .limit(limit + 1);
    if (cursor !== null) {
      const [titleKey, recordId, id] = decodeCursor(cursor, keyset);
      q = q.where((eb) =>
        eb.or([
          eb('r.title_key', '>', titleKey),
          eb.and([eb('r.title_key', '=', titleKey), eb.or([eb('a.record_id', '>', recordId), eb.and([eb('a.record_id', '=', recordId), eb('a.id', '>', id)])])]),
        ]),
      );
    }
    const found = await q.execute();
    const page = found.slice(0, limit);
    const last = page[page.length - 1];
    return {
      rows: page.map((d): ReportRow => [titleCell(d), d.attachment, d.mime ?? null, Number(d.read_count)]),
      nextCursor: found.length > limit && last !== undefined ? encodeCursor([last.title_key, last.record_id, last.id]) : null,
    };
  },
  /** The sum of the counts. */
  async totals(ctx) {
    const [sum] = await sumGrouped(base(ctx), {}, 'a.read_count');
    return [label(ctx, 'report.row.total'), null, null, sum?.sum ?? 0];
  },
  async count(ctx) {
    return countRows(base(ctx));
  },
});
