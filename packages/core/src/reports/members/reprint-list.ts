import { z } from 'zod';
import { normalizeBarcode } from '../../catalog/lib/barcode.js';
import { migBarcode } from '../../migration/slims/maps/barcode.js';
import { normalizeMemberNo } from '../../members/keys.js';
import { chunks, offsetPage, textParam } from '../collection/common.js';
import { reportColumn, reportIdField, reportParam } from '../params.js';
import type { ReportColumn, ReportCtx, ReportRow, TableReport } from '../types.js';

// What to print again after a migration from SLiMS: the members whose number changed on the way (two SLiMS numbers
// that became one after normalisation, the later ones told apart with `-2`, `-3`, …), and the migrated copies whose
// barcode changed (a code taken by another copy, told apart the same way, or a code that could not be a barcode and
// became `MIG<id>`). Each row maps the number or code in SLiMS to the one in ALTIS, with the name or the title, so the
// cards and labels can be printed again. Live members and copies only; filtered by kind and by the branch (home branch
// of a member, branch of a copy). By the ALTIS number or barcode.
//
// SLiMS 9 table/column names (interoperability facts, no SLiMS code): a migrated member keeps `slims:<member_id>` as
// its source; a migrated copy is mapped from `item_id` (entity `item`).

/** What the list holds. */
export const REPRINT_KINDS = Object.freeze(['members', 'items'] as const);

const SUFFIX = /^(.*)-(\d+)$/;

const MEMBER_COLUMNS: readonly ReportColumn[] = [
  reportColumn('source_no', 'text', { widthChars: 18 }),
  reportColumn('member_no', 'text', { widthChars: 18 }),
  reportColumn('name', 'text', { source: { table: 'members', column: 'name' }, widthChars: 30 }),
];

const ITEM_COLUMNS: readonly ReportColumn[] = [
  reportColumn('source_barcode', 'text', { widthChars: 24 }),
  reportColumn('barcode', 'text', { widthChars: 18 }),
  reportColumn('title', 'text', { widthChars: 40 }),
];

/** The migrated members whose number is not their SLiMS number. */
async function memberRows(ctx: ReportCtx): Promise<ReportRow[]> {
  let q = ctx.db
    .selectFrom('members as m')
    .select(['m.member_no_display', 'm.member_no_key', 'm.name', 'm.source'])
    .where('m.source', 'like', 'slims:%')
    .where('m.archived_at', 'is', null)
    .where('m.anonymized_at', 'is', null);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('m.home_branch_id', '=', branchId);
  const rows = await q.orderBy('m.member_no_key').execute();
  return rows
    .map((m) => ({ ...m, from: (m.source ?? '').slice('slims:'.length) }))
    .filter((m) => normalizeMemberNo(m.from) !== m.member_no_key)
    .map((m) => [m.from, m.member_no_display, m.name]);
}

/** The migrated copies whose barcode is not their SLiMS code: a `-n` suffix over a code another copy holds, or `MIG<id>`. */
async function itemRows(ctx: ReportCtx): Promise<ReportRow[]> {
  let q = ctx.db
    .selectFrom('items as i')
    .innerJoin('migration_map as mm', (j) => j.onRef('mm.target_id', '=', 'i.id').on('mm.entity', '=', 'item'))
    .leftJoin('records as r', 'r.id', 'i.record_id')
    .select(['i.barcode_display', 'i.barcode_key', 'i.status_note', 'mm.legacy_key', 'r.title'])
    .where('i.archived_at', 'is', null)
    .where((eb) => eb.or([eb('i.barcode_key', 'like', 'MIG%'), eb('i.barcode_key', 'like', '%-%')]));
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('i.branch_id', '=', branchId);
  const found = await q.orderBy('i.barcode_key').execute();
  const replaced = found.filter((i) => i.barcode_display === migBarcode(i.legacy_key));
  const suffixed = found.filter((i) => !replaced.includes(i) && SUFFIX.test(i.barcode_display));
  // A suffix counts only when the code without it is held by another copy (the collision that made it).
  const bases = [...new Set(suffixed.map((i) => normalizeBarcode(SUFFIX.exec(i.barcode_display)![1]!)))];
  const held = new Set<string>();
  for (const part of chunks(bases)) {
    if (part.length === 0) continue;
    const rows = await ctx.db.selectFrom('items').select('barcode_key').where('barcode_key', 'in', part).execute();
    for (const r of rows) held.add(r.barcode_key);
  }
  const out = found
    .filter((i) => replaced.includes(i) || (suffixed.includes(i) && held.has(normalizeBarcode(SUFFIX.exec(i.barcode_display)![1]!))))
    .map((i): ReportRow => {
      const from = replaced.includes(i) ? i.status_note : SUFFIX.exec(i.barcode_display)![1]!;
      return [from, i.barcode_display, i.title];
    });
  return out;
}

/** The numbers and barcodes to print again (see the top of this file). */
export const membersReprintListReport: TableReport = Object.freeze<TableReport>({
  id: 'members.reprint_list',
  module: 'members',
  kind: 'table',
  titleKey: 'report.members.reprint_list.title',
  permission: 'members.records.read',
  exportPermission: 'members.export.run',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [reportParam('kind', 'status', { options: REPRINT_KINDS }), reportParam('branchId', 'branch')],
  paramsSchema: z.strictObject({ kind: z.enum(REPRINT_KINDS).optional(), branchId: reportIdField.optional() }),
  columns: (params) => (params['kind'] === 'items' ? ITEM_COLUMNS : MEMBER_COLUMNS),
  /** The copies are catalogue data: listing them takes the catalogue's permission as well. */
  extraPermission: (params) => (params['kind'] === 'items' ? 'catalog.records.read' : null),
  async rows(ctx, cursor, limit) {
    return offsetPage(ctx.params['kind'] === 'items' ? await itemRows(ctx) : await memberRows(ctx), cursor, limit);
  },
});
