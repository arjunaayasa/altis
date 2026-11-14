import type { FixtureData, FixtureRow } from './generate.js';

// The changes a SLiMS library makes to its catalogue after a first migration, applied to the plain fixture's data before
// the dump is written (index.ts), so a second run with the catalogue re-sync (`catalogMode = sync`) finds them. SLiMS 9
// table/column names (interoperability facts, no SLiMS code). Written by hand (clean-room).
//
// The library, in SLiMS:
// - adds two item statuses of its own: `W` "Disiangi" (weeding) and `HL` "Hilang" (a copy declared lost);
// - weeds two copies (status `W`): items 72 and 160;
// - moves item 73 from the reference room (`REF`) to the second floor (`lt2`), on the same shelf text, so the copy goes
//   to the shelf the first run made there for that text;
// - declares item 76 lost (status `HL`; it was `MIS`, missing, which may become lost);
// - empties the receiving date of item 78 (its entry date stays);
// - adds item 601 to title 90, and lends it at once (an open `loan` row);
// - deletes title 150 together with both its copies (items 150 and 447), and its author and subject links;
// - deletes title 160 while its copy 457 stays (its other copy, 160, is the weeded one): in SLiMS that copy now points to
//   a title that is gone, which a fresh migration would put under a placeholder record;
// - lends item 13, whose code the first run could not use as a barcode (it gave `MIG13`), by its SLiMS code (an open
//   `loan` row a later circulation migration must resolve through the legacy map, not by the barcode).
//
// What a re-sync must find (`catalogChanges`): the new copy (1), the copies changed (weeded 2, moved, lost, received date:
// 5), the mapped rows whose source row is gone (title 150 and its two copies, title 160: 4) = 10. A copy whose title is
// gone does not change (the legacy map still leads to that title); the loans are not catalogue rows.

/** What the re-sync must find, and the rows the changes touch (SLiMS ids). */
export interface CatalogMutationExpected {
  /** The source records and copies that are new, changed or gone. */
  catalogChanges: number;
  /** Copies weeded in SLiMS (their status maps to `withdrawn`). */
  weeded: number[];
  /** A copy moved to another room: its item id, the room it left and the room it went to. */
  moved: { itemId: number; from: string; to: string };
  /** A copy declared lost in SLiMS (it was missing). */
  lost: number;
  /** A copy whose receiving date was emptied (its entry date stays). */
  receivedEmptied: number;
  /** The copy added after the first run, its title, and its barcode. */
  added: { itemId: number; biblioId: number; barcode: string };
  /** The title deleted with its copies. */
  deletedRecord: { biblioId: number; items: number[] };
  /** The title deleted while one of its copies stays. */
  keptRecord: { biblioId: number; remainingItemId: number };
  /** The open loans added (their `loan_id`, and the SLiMS item code each names). */
  loans: { loanId: number; itemCode: string }[];
  /** The tables the changes touch. */
  tables: string[];
}

const WEEDED = [72, 160];
const MOVED = { itemId: 73, from: 'REF', to: 'lt2' };
const LOST = 76;
const RECEIVED_EMPTIED = 78;
const ADDED = { itemId: 601, biblioId: 90, barcode: 'B00601' };
const DELETED_RECORD = { biblioId: 150, items: [150, 447] };
const KEPT_RECORD = { biblioId: 160, remainingItemId: 457 };
const LOANS = [
  { loanId: 5, itemCode: ADDED.barcode },
  { loanId: 6, itemCode: 'B–0013' },
];
const TABLES = ['mst_item_status', 'item', 'biblio', 'biblio_author', 'biblio_topic', 'loan'];

/** The SLiMS status codes the library adds. */
const STATUS_WEEDED = 'W';
const STATUS_LOST = 'HL';
const CHANGED_AT = '2026-01-06 09:00:00';

/** The rows of `table` (a copy of the list). */
function rowsOf(data: FixtureData, table: string): FixtureRow[] {
  return [...(data.rows.get(table) ?? [])];
}

/** The row of `rows` whose `column` is `id`. @throws Error when there is none */
function rowOf(rows: readonly FixtureRow[], column: string, id: number): FixtureRow {
  const row = rows.find((r) => r[column] === id);
  if (row === undefined) throw new Error(`the SLiMS fixture has no row ${column}=${id}`);
  return row;
}

/** `rows` with the row whose `column` is `id` replaced by `change(row)`. */
function changed(rows: readonly FixtureRow[], column: string, id: number, change: (row: FixtureRow) => FixtureRow): FixtureRow[] {
  const row = rowOf(rows, column, id);
  return rows.map((r) => (r === row ? change({ ...r }) : r));
}

/** `data` after the library's later changes to its catalogue (see the top of this file), and what the re-sync must find. */
export function mutateCatalogAfterFirstRun(data: FixtureData): { data: FixtureData; expected: CatalogMutationExpected } {
  const rows = new Map(data.rows);

  const stamp = { input_date: '2026-01-05 08:00:00', last_update: '2026-01-05 08:00:00' };
  rows.set('mst_item_status', [
    ...rowsOf(data, 'mst_item_status'),
    { item_status_id: STATUS_WEEDED, item_status_name: 'Disiangi', rules: null, no_loan: 1, skip_stock_take: 1, ...stamp },
    { item_status_id: STATUS_LOST, item_status_name: 'Hilang', rules: null, no_loan: 1, skip_stock_take: 1, ...stamp },
  ]);

  const plain = rowsOf(data, 'item');
  let items = plain;
  for (const id of WEEDED) items = changed(items, 'item_id', id, (r) => ({ ...r, item_status_id: STATUS_WEEDED, last_update: CHANGED_AT }));
  items = changed(items, 'item_id', MOVED.itemId, (r) => {
    if (r['location_id'] !== MOVED.from) throw new Error(`item ${MOVED.itemId} is not in ${MOVED.from}`);
    return { ...r, location_id: MOVED.to, last_update: CHANGED_AT };
  });
  items = changed(items, 'item_id', LOST, (r) => {
    if (r['item_status_id'] !== 'MIS') throw new Error(`item ${LOST} is not missing`);
    return { ...r, item_status_id: STATUS_LOST, last_update: CHANGED_AT };
  });
  items = changed(items, 'item_id', RECEIVED_EMPTIED, (r) => {
    if (r['received_date'] === null || r['input_date'] === null) throw new Error(`item ${RECEIVED_EMPTIED} has no dates to keep`);
    return { ...r, received_date: null, last_update: CHANGED_AT };
  });
  for (const id of DELETED_RECORD.items) {
    if (rowOf(plain, 'item_id', id)['biblio_id'] !== DELETED_RECORD.biblioId) throw new Error(`item ${id} is not of title ${DELETED_RECORD.biblioId}`);
  }
  for (const id of [KEPT_RECORD.remainingItemId, WEEDED[1]!]) {
    if (rowOf(plain, 'item_id', id)['biblio_id'] !== KEPT_RECORD.biblioId) throw new Error(`item ${id} is not of title ${KEPT_RECORD.biblioId}`);
  }
  items = items.filter((r) => !DELETED_RECORD.items.includes(r['item_id'] as number));
  items.push({
    ...rowOf(plain, 'item_id', ADDED.biblioId),
    item_id: ADDED.itemId,
    biblio_id: ADDED.biblioId,
    item_code: ADDED.barcode,
    inventory_code: `INV/${ADDED.itemId}`,
    location_id: 'SL',
    site: null,
    item_status_id: '',
    received_date: '2026-01-10',
    input_date: '2026-01-10 09:00:00',
    last_update: '2026-01-10 09:00:00',
  });
  rows.set('item', items);

  const gone = new Set([DELETED_RECORD.biblioId, KEPT_RECORD.biblioId]);
  for (const id of gone) rowOf(rowsOf(data, 'biblio'), 'biblio_id', id);
  for (const table of ['biblio', 'biblio_author', 'biblio_topic']) rows.set(table, rowsOf(data, table).filter((r) => !gone.has(r['biblio_id'] as number)));

  rows.set('loan', [
    ...rowsOf(data, 'loan'),
    ...LOANS.map((l) => ({ loan_id: l.loanId, item_code: l.itemCode, member_id: 'M0001', loan_date: '2026-01-12', due_date: '2026-01-19', is_lent: 1, is_return: 0 })),
  ]);

  return {
    data: { ...data, rows },
    expected: {
      catalogChanges: 10,
      weeded: [...WEEDED],
      moved: { ...MOVED },
      lost: LOST,
      receivedEmptied: RECEIVED_EMPTIED,
      added: { ...ADDED },
      deletedRecord: { biblioId: DELETED_RECORD.biblioId, items: [...DELETED_RECORD.items] },
      keptRecord: { ...KEPT_RECORD },
      loans: LOANS.map((l) => ({ ...l })),
      tables: [...TABLES],
    },
  };
}
