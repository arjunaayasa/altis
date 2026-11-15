import { createHash } from 'node:crypto';
import { withTx, type DbHandle } from '@altis/db';
import { DDC_MAINS, localDate, newId, t, type Locale, type MessageKey } from '@altis/shared';
import { formatPrice } from '../catalog/items/service.js';
import type { StorageDriver } from '../files/serve.js';
import { PdfLayout } from '../print/layout.js';
import { localDateTime } from '../reports/circulation/common.js';
import { dateInWords } from '../reports/export/describe.js';
import { readSettings } from '../settings/service.js';
import { lockSession, sessionNotFound, type Db } from './common.js';
import { stocktakeOfficers } from './lists.js';
import { getStocktake } from './sessions.js';

// The minutes of a stocktake session (berita acara inventarisasi), a PDF in the library's language: the session (name,
// branch, start and end, status, scope, the finish's options), its counts, the officers with what each scanned, the
// counts per DDC main class and per collection type, the missing or lost copies found and restored (with the lost
// charge the finish cancelled for each, and their total), and the signature blocks of the head of the library and the
// stocktake officer.
//
// The finish stores the minutes as a file (`stocktakes.minutes_file_id`; a `files` row of the session, staff only, that
// `/files/:id` never serves: the branch-checked minutes route is its only way out), in the transaction that marks the
// session finished, so a finished session's minutes never change afterwards. A session finished before the minutes
// were stored, cancelled, or still running has its minutes built when they are asked for.

/** The DDC main class of a stored class key (`000`–`990`, `2X`), or null. */
function mainOf(key: string | null): string | null {
  if (key === null) return null;
  if (key === '2X') return '2X';
  return /^\d/.test(key) ? `${key[0]}00` : null;
}

interface Tally {
  expected: number;
  found: number;
  misplaced: number;
  onLoan: number;
  pending: number;
}

function tally(): Tally {
  return { expected: 0, found: 0, misplaced: 0, onLoan: 0, pending: 0 };
}

/** The restored copies the minutes list by name (the count of the rest is said). */
const RESTORED_LISTED = 1000;

/**
 * The lost charges the finish of the session `id` cancelled, per restored copy of the session (minor units): the
 * `cancel` adjustments, with the stocktake's reason (in either language), of the `lost` charges of the copy's loans,
 * made between the session's start and its end.
 */
async function cancelledLostCharges(db: Db, id: string, startedAt: number, finishedAt: number | null): Promise<Map<string, number>> {
  let q = db
    .selectFrom('charge_adjustments as a')
    .innerJoin('charges as c', 'c.id', 'a.charge_id')
    .innerJoin('loans as l', 'l.id', 'c.loan_id')
    .innerJoin('stocktake_items as s', (j) => j.onRef('s.item_id', '=', 'l.item_id').on('s.stocktake_id', '=', id).on('s.result', '=', 'restored'))
    .select('s.item_id')
    .select((eb) => eb.fn.sum<number | string>('a.amount_minor').as('amount'))
    .where('a.kind', '=', 'cancel')
    .where('c.kind', '=', 'lost')
    .where('a.reason_text', 'in', [t('id', 'charge.text.stocktake_found'), t('en', 'charge.text.stocktake_found')])
    .where('a.at', '>=', startedAt);
  if (finishedAt !== null) q = q.where('a.at', '<=', finishedAt);
  const out = new Map<string, number>();
  for (const r of await q.groupBy('s.item_id').execute()) out.set(r.item_id, Number(r.amount));
  return out;
}

/** The context and owner type of a stored minutes file. */
export const STOCKTAKE_MINUTES_CONTEXT = 'stocktake.minutes';
export const STOCKTAKE_MINUTES_OWNER = 'stocktakes';

/**
 * The minutes PDF of the session `id` of `branchId`, built now; `as` shows the session as its finish is about to leave
 * it (finished at that time).
 *
 * @throws DomainError NOT_FOUND
 */
export async function stocktakeMinutesPdf(db: Db, branchId: string, id: string, as?: { finishedAt: number }): Promise<{ bytes: Uint8Array; name: string }> {
  const read = await getStocktake(db, branchId, id);
  const view = as === undefined ? read : { ...read, status: 'finished' as const, finishedAt: as.finishedAt };
  const settings = await readSettings(db, ['library.name', 'library.locale', 'library.timezone'], []);
  const locale = (settings['library.locale'] === 'en' ? 'en' : 'id') as Locale;
  const tz = String(settings['library.timezone']);
  const tr = (key: MessageKey, params?: Record<string, string | number>): string => t(locale, key, params);

  const rows = await db.selectFrom('stocktake_items').select(['state', 'stat_ddc', 'collection_type_id', 'result', 'item_id']).where('stocktake_id', '=', id).where('expected', '=', 1).execute();
  const byClass = new Map<string, Tally>();
  const byType = new Map<string, Tally>();
  for (const r of rows) {
    const cls = mainOf(r.stat_ddc) ?? 'NON';
    const type = r.collection_type_id ?? '';
    for (const [map, key] of [
      [byClass, cls],
      [byType, type],
    ] as const) {
      const x = map.get(key) ?? tally();
      x.expected += 1;
      if (r.state === 'found' || r.state === 'misplaced') x.found += 1;
      if (r.state === 'misplaced') x.misplaced += 1;
      if (r.state === 'on_loan') x.onLoan += 1;
      if (r.state === 'pending') x.pending += 1;
      map.set(key, x);
    }
  }
  const typeIds = [...byType.keys()].filter((k) => k !== '');
  const typeNames = new Map(
    typeIds.length === 0 ? [] : (await db.selectFrom('collection_types').select(['id', 'name_id', 'name_en']).where('id', 'in', typeIds).execute()).map((c) => [c.id, locale === 'en' ? (c.name_en ?? c.name_id) : c.name_id]),
  );
  const restored = await db
    .selectFrom('stocktake_items as s')
    .innerJoin('items as i', 'i.id', 's.item_id')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .select(['i.id', 'i.barcode_display', 'r.title', 's.expected_status'])
    .where('s.stocktake_id', '=', id)
    .where('s.result', '=', 'restored')
    .orderBy('i.barcode_key')
    .limit(RESTORED_LISTED)
    .execute();
  const restoredCount =
    restored.length < RESTORED_LISTED
      ? restored.length
      : Number(
          (await db.selectFrom('stocktake_items').select((eb) => eb.fn.countAll<number | string>().as('n')).where('stocktake_id', '=', id).where('result', '=', 'restored').executeTakeFirstOrThrow()).n,
        );
  const cancelled = restored.length === 0 ? new Map<string, number>() : await cancelledLostCharges(db, id, view.startedAt, view.finishedAt);
  const officers = await stocktakeOfficers(db, id);

  const pdf = new PdfLayout({
    paper: 'A4',
    orientation: 'portrait',
    title: tr('stocktake.minutes.title'),
    header: { left: String(settings['library.name']), right: tr('stocktake.minutes.title') },
    footer: (page, pages) => tr('stocktake.minutes.page', { page, pages }),
    nonLatinNote: tr('stocktake.minutes.non_latin'),
  });
  pdf.paragraph(String(settings['library.name']), { bold: true, align: 'center', size: 14 });
  pdf.paragraph(tr('stocktake.minutes.title'), { bold: true, align: 'center', size: 13 });
  pdf.paragraph(tr('stocktake.minutes.opening'));
  const scope: string[] = [];
  if (view.scopeNames.locations.length > 0) scope.push(tr('stocktake.minutes.scope_locations', { names: view.scopeNames.locations.join(', ') }));
  if (view.scopeNames.collectionTypes.length > 0) scope.push(tr('stocktake.minutes.scope_collection_types', { names: view.scopeNames.collectionTypes.join(', ') }));
  if (view.scopeNames.materialTypes.length > 0) scope.push(tr('stocktake.minutes.scope_material_types', { names: view.scopeNames.materialTypes.join(', ') }));
  if ((view.scope.classPrefixes ?? []).length > 0) scope.push(tr('stocktake.minutes.scope_classes', { names: (view.scope.classPrefixes ?? []).join(', ') }));
  const kv: [string, string][] = [
    [tr('stocktake.minutes.session'), view.name],
    [tr('stocktake.minutes.branch'), `${view.branch.name} (${view.branch.code})`],
    [tr('stocktake.minutes.started'), localDateTime(tz, view.startedAt)],
    [tr('stocktake.minutes.finished'), view.finishedAt === null ? '-' : localDateTime(tz, view.finishedAt)],
    [tr('stocktake.minutes.status'), t(locale, `vocab.stocktake_status.${view.status}`)],
    [tr('stocktake.minutes.scope'), scope.length === 0 ? tr('stocktake.minutes.scope_all') : scope.join('; ')],
  ];
  if (view.options !== null) {
    const yn = (b: boolean): string => tr(b ? 'stocktake.minutes.yes' : 'stocktake.minutes.no');
    kv.push([tr('stocktake.minutes.options'), tr('stocktake.minutes.options_value', { markMissing: yn(view.options.markMissing), restoreFound: yn(view.options.restoreFound) })]);
  }
  pdf.keyValues(kv);

  pdf.heading(tr('stocktake.minutes.counts'), 2);
  const c = view.counts;
  pdf.table(
    [
      { header: tr('report.column.expected'), align: 'right' },
      { header: tr('report.column.found'), align: 'right' },
      { header: tr('report.column.misplaced'), align: 'right' },
      { header: tr('report.column.on_loan'), align: 'right' },
      { header: tr('report.column.pending'), align: 'right' },
      { header: tr('report.column.unexpected'), align: 'right' },
      { header: tr('report.column.unknown_codes'), align: 'right' },
    ],
    [[c.total, c.found, c.misplaced, c.onLoan, c.pending, c.unexpected, c.unknownCodes]],
  );

  pdf.heading(tr('stocktake.minutes.officers'), 2);
  pdf.table(
    [
      { header: tr('report.column.officer'), weight: 3 },
      { header: tr('report.column.found'), align: 'right' },
      { header: tr('report.column.misplaced'), align: 'right' },
      { header: tr('report.column.unexpected'), align: 'right' },
    ],
    officers.items.map((o) => [o.name, o.found, o.misplaced, o.unexpected]),
  );

  const tallyColumns = (first: string) => [
    { header: first, weight: 3 },
    { header: tr('report.column.expected'), align: 'right' as const },
    { header: tr('report.column.found'), align: 'right' as const },
    { header: tr('report.column.misplaced'), align: 'right' as const },
    { header: tr('report.column.on_loan'), align: 'right' as const },
    { header: tr('report.column.pending'), align: 'right' as const },
  ];
  const tallyRow = (label: string, x: Tally) => [label, x.expected, x.found, x.misplaced, x.onLoan, x.pending];
  pdf.heading(tr('stocktake.minutes.by_class'), 2);
  const classOrder = [...DDC_MAINS.filter((m) => m !== 'NON'), 'NON'];
  pdf.table(
    tallyColumns(tr('report.column.class')),
    classOrder.filter((k) => byClass.has(k)).map((k) => tallyRow(k === 'NON' ? tr('report.row.stocktake.no_class') : k, byClass.get(k)!)),
  );
  pdf.heading(tr('stocktake.minutes.by_collection_type'), 2);
  pdf.table(
    tallyColumns(tr('report.column.collection_type')),
    [...byType.entries()]
      .map(([k, x]) => [k === '' ? tr('report.row.stocktake.no_collection_type') : (typeNames.get(k) ?? '?'), x] as const)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, x]) => tallyRow(label, x)),
  );

  pdf.heading(tr('stocktake.minutes.restored'), 2);
  if (restored.length === 0) pdf.paragraph(tr('stocktake.minutes.restored_none'));
  else {
    pdf.table(
      [
        { header: tr('report.column.barcode') },
        { header: tr('report.column.title'), weight: 3 },
        { header: tr('report.column.status') },
        { header: tr('stocktake.minutes.cancelled_charge'), align: 'right' },
      ],
      restored.map((r) => {
        const amount = cancelled.get(r.id);
        return [r.barcode_display, r.title, r.expected_status === null ? '' : t(locale, `vocab.item_status.${r.expected_status}` as MessageKey), amount === undefined ? '-' : formatPrice(amount)];
      }),
    );
    if (restoredCount > restored.length) pdf.paragraph(tr('stocktake.minutes.restored_cut', { shown: restored.length, total: restoredCount }));
    const total = [...cancelled.values()].reduce((sum, x) => sum + x, 0);
    if (total > 0) pdf.paragraph(tr('stocktake.minutes.cancelled_total', { count: cancelled.size, amount: formatPrice(total) }), { bold: true });
  }

  pdf.paragraph(tr('stocktake.minutes.closing'));
  const day = localDate(tz, view.finishedAt ?? view.startedAt);
  pdf.signatureBlocks([
    { date: dateInWords(locale, day), role: tr('stocktake.minutes.sign_officer'), ...(view.finishedBy === null ? {} : { name: view.finishedBy.name }) },
    { role: tr('stocktake.minutes.sign_head'), stamp: true },
  ]);
  return { bytes: pdf.toBytes(), name: `berita-acara-inventarisasi-${day}.pdf` };
}

/**
 * The minutes of the session `id` of `branchId` as it is served: the stored file of a finished session, else (none
 * stored, or its blob gone) built now.
 *
 * @throws DomainError NOT_FOUND
 */
export async function stocktakeMinutes(db: Db, storage: StorageDriver, branchId: string, id: string): Promise<{ bytes: Uint8Array; name: string }> {
  const row = await db
    .selectFrom('stocktakes as s')
    .leftJoin('files as f', (j) => j.onRef('f.id', '=', 's.minutes_file_id').on('f.owner_type', '=', STOCKTAKE_MINUTES_OWNER).on('f.status', '=', 'ok'))
    .select(['s.id', 'f.id as file_id', 'f.original_name', 'f.size'])
    .where('s.id', '=', id)
    .where('s.branch_id', '=', branchId)
    .executeTakeFirst();
  if (row === undefined) throw sessionNotFound();
  if (row.file_id !== null) {
    const stream = await storage.get(row.file_id);
    if (stream !== null) {
      const parts: Uint8Array[] = [];
      for await (const part of stream) parts.push(part);
      return { bytes: new Uint8Array(Buffer.concat(parts)), name: row.original_name ?? 'berita-acara-inventarisasi.pdf' };
    }
  }
  return stocktakeMinutesPdf(db, branchId, id);
}

/**
 * The end of a finish: the minutes built as the finished session's (outside any transaction), stored through
 * `storage`, then, in one transaction that still finds the session `finishing`, the session marked finished at `now`
 * with its branch free again, the file's row written and named as its minutes. Without `storage` the session is only
 * marked finished (its minutes are built when asked for). A transaction that finds the session no longer finishing
 * removes the stored blob again.
 */
export async function closeStocktakeFinish(h: DbHandle, storage: StorageDriver | null, branchId: string, id: string, now: number): Promise<void> {
  let file: { id: string; name: string; size: number; sha256: string } | null = null;
  if (storage !== null) {
    const pdf = await stocktakeMinutesPdf(h.db, branchId, id, { finishedAt: now });
    const sha256 = createHash('sha256').update(pdf.bytes).digest('hex');
    file = { id: newId(now), name: pdf.name, size: pdf.bytes.byteLength, sha256 };
    await storage.put(file.id, pdf.bytes, { size: file.size, sha256 });
  }
  try {
    await withTx(h, async (trx) => {
      await lockSession(trx, branchId, id, 'finishing');
      if (file !== null) {
        await trx
          .insertInto('files')
          .values({
            id: file.id,
            original_name: file.name,
            mime: 'application/pdf',
            size: file.size,
            sha256: file.sha256,
            context: STOCKTAKE_MINUTES_CONTEXT,
            owner_type: STOCKTAKE_MINUTES_OWNER,
            owner_id: id,
            access: 'staff',
            status: 'ok',
            created_at: now,
            created_by: null,
          })
          .execute();
      }
      await trx
        .updateTable('stocktakes')
        .set((eb) => ({ status: 'finished', active_key: null, finished_at: now, minutes_file_id: file?.id ?? null, updated_at: now, version: eb('version', '+', 1) }))
        .where('id', '=', id)
        .execute();
    });
  } catch (error) {
    if (file !== null) await storage!.delete(file.id).catch(() => undefined);
    throw error;
  }
}
