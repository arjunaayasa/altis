import type { DB } from '@altis/db';
import { newId } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import type { SlimsRow, SlimsTableInfo } from '../source/types.js';
import type { SlimsPipelineContext } from '../pipeline.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import {
  TEXT_MAX_BYTES,
  cutBytes,
  cutChars,
  inBatch,
  keyFits,
  keyOf,
  nextPhase,
  readCursor,
  sourceCursor,
  stageBBatch,
  tableOf,
  textOf,
  writeCursor,
  type Ledger,
  endOfStage,
} from './stage-b-kit.js';

// The archive (Phase 2 spec §11.3 step 9, §11.4 rows → `migration_archive`; preflight M12, S13; plan Task 38): the
// SLiMS tables Phase 2 has no home for are kept as raw rows, one JSON object per row (`table_name` = the SLiMS table,
// `legacy_key` = the row's primary key, composite keys joined with `|`, or `#<n>` for a table without one; `source` =
// the run's `sourceName`, S13), so a later phase (serials, stock taking) can still read them:
//
// - `serial`, `kardex`, `mst_frequency`, `stock_take`, `stock_take_item`, `mst_label`, `biblio_log`, `mst_item_status`:
//   every row, counted `archived` (the two stocktake tables only archived when the run has the stocktake stage, which
//   counts them: stocktake.ts);
// - `biblio.labels` and `biblio.frequency_id`: a row `{biblio_id, labels, frequency_id}` for each record that has one
//   of them (the rows of `biblio` are the records stage's to count);
// - `biblio_log` (M12, UU PDP): its IP address columns and `realname` are personal data with no Phase 2 purpose, so
//   they are dropped (only `user_id` stays of the staff identity), listed once in the report (`columns_dropped`).
//
// Text values go through the §11.5 clean-up (bytes that are no UTF-8 read as Windows-1252); numbers stay numbers. A
// row whose JSON passes 60 000 bytes (MySQL TEXT) has its longest values cut until it fits, the cut columns listed
// under `_truncated` (`archive_truncated`). A row already archived under the source by an earlier run is skipped
// `already_migrated`; one archived by this run (a slice that died after its commit) is counted again. Batches of 500,
// one transaction each; a dry run counts and reports alike, and writes nothing.

/** The archived tables, in their order. */
const TABLES = ['serial', 'kardex', 'mst_frequency', 'stock_take', 'stock_take_item', 'mst_label', 'biblio', 'biblio_log', 'mst_item_status'] as const;

/** The columns of `biblio` the archive keeps (with its key), and of `biblio_log` it drops (M12). */
const BIBLIO_KEPT = ['labels', 'frequency_id'] as const;
const PERSONAL = /^(?:ip|ip_address|client_ip|user_ip|realname)$/i;

type Db = Kysely<DB> | Transaction<DB>;

// ---- Komunitas K4 (stocktake) ----
const STOCKTAKE_TABLES: ReadonlySet<string> = new Set(['stock_take', 'stock_take_item']);

/** Whether the run's stage list has the stocktake stage (a framework context only; a bare call counts as without). */
function runHasStocktake(c: SlimsStageContext): boolean {
  return (c as Partial<SlimsPipelineContext>).pipeline?.stages.some((s) => s.name === 'stocktake') === true;
}

/** The archive rows of `keys` of `table` under the run's source: the run that wrote each, by key. */
async function archivedRuns(c: SlimsStageContext, db: Db, table: string, keys: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 500) {
    const rows = await db
      .selectFrom('migration_archive')
      .select(['legacy_key', 'run_id'])
      .where('source', '=', c.options.sourceName)
      .where('table_name', '=', table)
      .where('legacy_key', 'in', unique.slice(i, i + 500))
      .execute();
    for (const r of rows) out.set(r.legacy_key, r.run_id);
  }
  return out;
}

/** A value as the archive keeps it: a number as it is, text (or bytes, read as Windows-1252) cleaned, repairs counted. */
function valueOf(l: Ledger, table: string, column: string, v: SlimsRow[string] | undefined): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  return textOf(l, table, column, v);
}

/** `doc` within {@link TEXT_MAX_BYTES} of JSON: its longest text values cut (halved) until it fits; the cut columns. */
export function fitArchiveRow(doc: Record<string, unknown>): { json: string; cut: string[] } {
  const cut: string[] = [];
  let json = JSON.stringify(doc);
  while (Buffer.byteLength(json, 'utf8') > TEXT_MAX_BYTES) {
    let longest: string | null = null;
    for (const [k, v] of Object.entries(doc)) {
      if (typeof v === 'string' && v.length > 0 && (longest === null || v.length > (doc[longest] as string).length)) longest = k;
    }
    if (longest === null) throw new TypeError('an archived SLiMS row does not fit in 60 000 bytes even without its texts');
    const v = doc[longest] as string;
    doc[longest] = cutBytes(v, Math.floor(Buffer.byteLength(v, 'utf8') / 2));
    if (!cut.includes(longest)) cut.push(longest);
    doc['_truncated'] = [...cut];
    json = JSON.stringify(doc);
  }
  return { json, cut };
}

async function archiveBatch(
  c: SlimsStageContext,
  info: SlimsTableInfo,
  rows: readonly SlimsRow[],
  position: number,
  first: boolean,
  l: Ledger,
  trx: Transaction<DB> | null,
  db: Db,
): Promise<void> {
  const table = info.name;
  const keyColumns = info.primaryKey.length > 0 ? info.primaryKey : table === 'biblio' ? ['biblio_id'] : [];
  const dropped = table === 'biblio_log' ? info.columns.filter((column) => PERSONAL.test(column)).sort() : [];
  if (first && dropped.length > 0) l.report(table, null, 'columns_dropped', dropped.join(', '));
  // `biblio`'s rows are the records stage's to count, the stocktake tables' the stocktake stage's (when the run has it):
  // here they are only archived.
  const counted = table !== 'biblio' && !(STOCKTAKE_TABLES.has(table) && runHasStocktake(c));
  const filled = (v: SlimsRow[string] | undefined): boolean => keyOf(v) !== '' && keyOf(v) !== '0';
  const candidates: { key: string; row: SlimsRow; columns: readonly string[] }[] = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    if (table === 'biblio' && !BIBLIO_KEPT.some((column) => filled(row[column]))) return;
    const parts = keyColumns.map((column) => keyOf(row[column]));
    const key = keyColumns.length === 0 ? `#${position + i + 1}` : parts.join('|');
    if (parts.some((p) => p === '') || !keyFits(key)) {
      if (counted) l.skipped(table, 'empty_key');
      l.report(table, null, 'empty_key', `${keyColumns.join('|')} kosong / empty`);
      return;
    }
    if (seen.has(key)) {
      if (counted) l.skipped(table, 'duplicate_key');
      l.report(table, key, 'duplicate_key', `${keyColumns.join('|')} ganda / repeated`);
      return;
    }
    seen.add(key);
    const columns = table === 'biblio' ? [...keyColumns, ...BIBLIO_KEPT.filter((column) => filled(row[column]))] : info.columns.filter((column) => !dropped.includes(column));
    candidates.push({ key, row, columns });
  });
  const runs = await archivedRuns(c, db, table, candidates.map((d) => d.key));
  const values: { id: string; run_id: string; source: string; table_name: string; legacy_key: string; row_json: string; created_at: number }[] = [];
  for (const { key, row, columns } of candidates) {
    const run = runs.get(key);
    if (run !== undefined && run !== c.runId) {
      if (counted) l.skipped(table, 'already_migrated');
      continue;
    }
    // Built as entries: a SLiMS column called `__proto__` stays a key.
    const fitted = fitArchiveRow(Object.fromEntries(columns.map((column): [string, unknown] => [column, valueOf(l, table, column, row[column])])));
    if (fitted.cut.length > 0) l.report(table, key, 'archive_truncated', cutChars(fitted.cut.join(', '), 200));
    if (counted) l.archived(table);
    if (run === undefined) {
      values.push({ id: newId(c.now), run_id: c.runId, source: c.options.sourceName, table_name: table, legacy_key: key, row_json: fitted.json, created_at: c.now });
    }
  }
  if (trx === null) return;
  for (let i = 0; i < values.length; i += 100) await trx.insertInto('migration_archive').values(values.slice(i, i + 100)).execute();
}

/** The archive (§11.3 step 9, §11.4): see the top of this file. */
export const archiveStage: SlimsStage = Object.freeze({
  name: 'archive' as const,
  reads: Object.freeze([...TABLES]) as readonly string[],
  async run(c: SlimsStageContext, cursor: string | null): Promise<{ done: boolean; cursor: string | null }> {
    let at = readCursor('archive', cursor);
    let batches = 0;
    while (at.p < TABLES.length) {
      if (batches > 0 && c.budgetLeftMs() <= 0) return { done: false, cursor: writeCursor(at) };
      const table = TABLES[at.p]!;
      const info = await tableOf(c, table);
      if (info === null) {
        at = nextPhase(at);
        continue;
      }
      const batch = await c.source.rows(table, at.c, stageBBatch());
      batches += 1;
      const next = sourceCursor('archive', batch.rows.length === 0 ? null : batch.next);
      const first = at.c === null;
      const { ledger } = await inBatch(c, at, (io, l) => archiveBatch(c, info, batch.rows, at.n, first, l, io.trx, io.db));
      ledger.apply(c);
      const carried = ledger.state();
      at = next === null ? nextPhase({ ...at, ...carried }) : { ...at, ...carried, c: next, i: 0, n: at.n + batch.rows.length };
    }
    return endOfStage(c, 'archive', at);
  },
});
