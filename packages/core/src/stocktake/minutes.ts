import { DDC_MAINS, localDate, t, type Locale, type MessageKey } from '@altis/shared';
import { PdfLayout } from '../print/layout.js';
import { localDateTime } from '../reports/circulation/common.js';
import { dateInWords } from '../reports/export/describe.js';
import { readSettings } from '../settings/service.js';
import type { Db } from './common.js';
import { stocktakeOfficers } from './lists.js';
import { getStocktake } from './sessions.js';

// The minutes of a stocktake session (berita acara inventarisasi), a PDF built when it is asked for, in the library's
// language: the session (name, branch, start and end, status, scope, the finish's options), its counts, the officers
// with what each scanned, the counts per DDC main class and per collection type, the missing or lost copies found and
// restored, and the signature blocks of the head of the library and the stocktake officer.

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

/** The minutes PDF of the session `id` of `branchId`. @throws DomainError NOT_FOUND */
export async function stocktakeMinutesPdf(db: Db, branchId: string, id: string): Promise<{ bytes: Uint8Array; name: string }> {
  const view = await getStocktake(db, branchId, id);
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
    .select(['i.barcode_display', 'r.title', 's.expected_status'])
    .where('s.stocktake_id', '=', id)
    .where('s.result', '=', 'restored')
    .orderBy('i.barcode_key')
    .limit(1000)
    .execute();
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
      [{ header: tr('report.column.barcode') }, { header: tr('report.column.title'), weight: 3 }, { header: tr('report.column.status') }],
      restored.map((r) => [r.barcode_display, r.title, r.expected_status === null ? '' : t(locale, `vocab.item_status.${r.expected_status}` as MessageKey)]),
    );
  }

  pdf.paragraph(tr('stocktake.minutes.closing'));
  const day = localDate(tz, view.finishedAt ?? view.startedAt);
  pdf.signatureBlocks([
    { date: dateInWords(locale, day), role: tr('stocktake.minutes.sign_officer'), ...(view.finishedBy === null ? {} : { name: view.finishedBy.name }) },
    { role: tr('stocktake.minutes.sign_head'), stamp: true },
  ]);
  return { bytes: pdf.toBytes(), name: `berita-acara-inventarisasi-${day}.pdf` };
}
