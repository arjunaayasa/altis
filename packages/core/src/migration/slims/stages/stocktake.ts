import { countGrouped, type DB } from '@altis/db';
import { ddcClassOf, newId } from '@altis/shared';
import type { Insertable, Kysely, Transaction } from 'kysely';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import { SLIMS_COLUMNS } from '../source/detect.js';
import type { SlimsRow, SlimsSource, SlimsTableInfo } from '../source/types.js';
import type { SlimsCounters, SlimsStage, SlimsStageContext } from '../stage.js';
import {
  altisItemsOf,
  dateCell,
  flagCell,
  intCell,
  localEpoch,
  mapped,
  personalText,
  runPeoplePhases,
  runTimeZone,
  sourceItemIds,
  timeCell,
  type PeoplePhase,
} from './people-kit.js';
import { cachedForRun, cutChars, keyOf, mappedRows, oneLine, scanAll, sourceKeys, stateOf, tableOf, textOf, type BatchIo, type Ledger } from './stage-b-kit.js';

// Stocktake (the SLiMS tables `stock_take` and `stock_take_item`). SLiMS 9 table/column names
// (interoperability facts, no SLiMS code).
//
// 1. `stock_take` → stocktake sessions of the run's branch (entity `stock_take`, `source = migrated`), with their name
//    and their start and end in the library's time zone. A session SLiMS has finished comes in `finished`; one still
//    active (`is_active`) comes in `cancelled`, since ALTIS does not go on with it, and the report names it
//    (`stocktake_active_cancelled`). A session without a valid start date is skipped `invalid_date`. A session keeps
//    the totals SLiMS kept for it (in the scope, found, on loan; the rest not found), except as step 3 says.
// 2. `stock_take_item` → the copies of the last session (the latest start, then the highest id; entity
//    `stock_take_item`, key `<stock_take_id>|<item_id>`): the copy through the item's legacy map, else through its item
//    code (a copy ALTIS lacks: skipped `item_missing`; a second row of one copy: `duplicate_item`); SLiMS's `e` is
//    found (scanned when the row was last updated, by the officer's name as SLiMS kept it), `l` on loan, `m` and any
//    other not found, and in a finished session `m` is marked missing; each with a snapshot of the copy's location,
//    status, class and collection type as ALTIS has them now. A row of another session is skipped `older_session`
//    (SLiMS keeps the rows of its latest session only). Each row is decided by its own legacy map, so a run after one
//    that ended within the rows brings the rows it had not into the session that run made.
// 3. the last session's counters are counted again from its rows, when it has any, unless SLiMS finished it and kept
//    its totals: those stand, since they also count the rows of copies ALTIS lacks (copies SLiMS removed, for one).
//
// A dry run writes nothing: a row whose copy the source's `item` table holds counts as the run would write it.
//
// The rows are read from the source. A source without `stock_take` whose rows an earlier run archived
// (`migration_archive` under the run's source name) is read from there instead, outside the reconciliation: those
// rows are no rows of this source, so they are reported but not counted. The archive stage still keeps both tables
// whole; with this stage in the run it leaves their counting to this one (archive.ts).

const TS = 'stock_take';
const TI = 'stock_take_item';

type Db = Kysely<DB> | Transaction<DB>;

/** A session's start (the run's local time, as epoch ms) and its sort key, or null without a valid start date. */
function startOf(tz: string, row: SlimsRow): { at: number; sort: string } | null {
  const date = dateCell(row['start_date'], { placeholder: true });
  if (date === null) return null;
  const time = timeCell(row['start_date']);
  return { at: localEpoch(tz, date, time), sort: `${date} ${time}` };
}

/** The legacy key of the last session of the source (the latest valid start, then the highest id), or null. */
function lastSession(c: SlimsStageContext): Promise<string | null> {
  return cachedForRun(c, 'stocktake:last', async () => {
    const tz = await runTimeZone(c);
    let best: { key: string; sort: string; id: number } | null = null;
    await scanAll(c, TS, (row) => {
      const key = keyOf(row['stock_take_id']);
      const start = startOf(tz, row);
      if (key === '' || start === null) return;
      const id = intCell(row['stock_take_id']) ?? 0;
      if (best === null || start.sort > best.sort || (start.sort === best.sort && id > best.id)) best = { key, sort: start.sort, id };
    });
    return (best as { key: string } | null)?.key ?? null;
  });
}

async function sessionsBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const tz = await runTimeZone(c);
  const maps = await mappedRows(c, io.db, TS, rows.map((r) => keyOf(r['stock_take_id'])));
  const toMap: LegacyMapping[] = [];
  for (const row of rows) {
    const key = keyOf(row['stock_take_id']);
    if (key === '') {
      l.skipped(TS, 'empty_key');
      continue;
    }
    const state = stateOf(c, maps.get(key));
    if (state === 'done') {
      l.skipped(TS, 'already_migrated');
      continue;
    }
    const start = startOf(tz, row);
    if (start === null) {
      l.skipped(TS, 'invalid_date');
      l.report(TS, key, 'invalid_date', cutChars(keyOf(row['start_date']), 40) || '-');
      continue;
    }
    const name = cutChars(oneLine(textOf(l, TS, 'stock_take_name', row['stock_take_name']) ?? ''), 191) || `SLiMS ${key}`;
    const active = flagCell(row['is_active']) === true;
    l.migrated(TS);
    if (active) l.report(TS, key, 'stocktake_active_cancelled', name);
    if (state === 'replay' || io.trx === null) continue;
    const endDate = dateCell(row['end_date'], { placeholder: true });
    const end = endDate === null ? null : localEpoch(tz, endDate, timeCell(row['end_date']));
    // A finished session whose end SLiMS did not keep finished, for ALTIS, the day it started.
    const finishedAt = end !== null && end >= start.at ? end : active ? null : start.at;
    const n = (column: string): number => Math.max(0, intCell(row[column]) ?? 0);
    const found = n('total_item_exists');
    const onLoan = n('total_item_loan');
    const total = Math.max(n('total_item_stock_taked'), found + onLoan + n('total_item_lost'));
    const id = newId(c.now);
    await io.trx
      .insertInto('stocktakes')
      .values({
        id,
        branch_id: c.options.branchId,
        name,
        scope: '{}',
        status: active ? 'cancelled' : 'finished',
        active_key: null,
        options: null,
        total,
        found,
        on_loan: onLoan,
        misplaced: 0,
        unexpected: 0,
        unknown_codes: 0,
        started_at: start.at,
        started_by: null,
        finished_at: finishedAt,
        finished_by: null,
        minutes_file_id: null,
        report_file_id: null,
        source: 'migrated',
        version: 0,
        created_at: c.now,
        created_by: null,
        updated_at: c.now,
        updated_by: null,
      })
      .execute();
    toMap.push({ source: c.options.sourceName, entity: TS, legacyKey: key, targetId: id, runId: c.runId });
  }
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

/** The ALTIS facts of `ids` a session row keeps: where, in what status, of what class and collection type. */
async function copyFacts(db: Db, ids: readonly string[]): Promise<Map<string, { location: string | null; status: string; type: string | null; ddc: string | null }>> {
  const out = new Map<string, { location: string | null; status: string; type: string | null; ddc: string | null }>();
  for (let i = 0; i < ids.length; i += 500) {
    for (const r of await db
      .selectFrom('items as i')
      .innerJoin('records as r', 'r.id', 'i.record_id')
      .select(['i.id', 'i.location_id', 'i.status', 'i.collection_type_id', 'i.call_number', 'r.classification', 'r.call_number as record_call_number'])
      .where('i.id', 'in', ids.slice(i, i + 500))
      .execute()) {
      const ddc = ddcClassOf(r.classification, r.call_number ?? r.record_call_number);
      out.set(r.id, { location: r.location_id, status: r.status, type: r.collection_type_id, ddc: ddc.main === 'NON' ? null : (ddc.division ?? ddc.main) });
    }
  }
  return out;
}

async function itemsBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const tz = await runTimeZone(c);
  const last = await lastSession(c);
  const session = last === null ? undefined : (await mappedRows(c, io.db, TS, [last])).get(last);
  const status = session === undefined ? null : ((await io.db.selectFrom('stocktakes').select('status').where('id', '=', session.targetId).executeTakeFirst())?.status ?? null);
  const keyOfRow = (r: SlimsRow): string => `${keyOf(r['stock_take_id'])}|${keyOf(r['item_id'])}`;
  const maps = await mappedRows(c, io.db, TI, rows.map(keyOfRow));
  const ofSession = rows.filter((r) => last !== null && keyOf(r['stock_take_id']) === last);
  const byId = await mapped(c, io.db, 'item', ofSession.map((r) => keyOf(r['item_id'])));
  const byCode = await altisItemsOf(c, io.db, ofSession.map((r) => keyOf(r['item_code'])));
  const targets = new Map<SlimsRow, string>();
  for (const r of ofSession) {
    const target = byId.get(keyOf(r['item_id'])) ?? byCode.get(keyOf(r['item_code']));
    if (target !== undefined) targets.set(r, target);
  }
  const facts = await copyFacts(io.db, [...new Set(targets.values())]);
  // A dry run: the copies the source's `item` table holds (by id, or by code) are the ones a real run would find.
  const sourceIds = io.trx === null ? await sourceKeys(c, 'item', 'item_id') : new Set<string>();
  const sourceCodes = io.trx === null ? await sourceItemIds(c) : new Map<string, string>();
  const identity = (r: SlimsRow): string | null => {
    const target = targets.get(r);
    if (target !== undefined) return target;
    if (io.trx !== null) return null;
    const id = keyOf(r['item_id']);
    if (sourceIds.has(id)) return `slims:${id}`;
    const byCodeId = sourceCodes.get(keyOf(r['item_code']));
    return byCodeId === undefined ? null : `slims:${byCodeId}`;
  };
  const present = new Set<string>();
  if (session !== undefined && targets.size > 0) {
    const ids = [...new Set(targets.values())];
    for (let i = 0; i < ids.length; i += 500) {
      for (const r of await io.db.selectFrom('stocktake_items').select('item_id').where('stocktake_id', '=', session.targetId).where('item_id', 'in', ids.slice(i, i + 500)).execute()) present.add(r.item_id);
    }
  }
  const values: Insertable<DB['stocktake_items']>[] = [];
  const toMap: LegacyMapping[] = [];
  for (const row of rows) {
    const stKey = keyOf(row['stock_take_id']);
    const itemKey = keyOf(row['item_id']);
    const key = `${stKey}|${itemKey}`;
    if (stKey === '' || itemKey === '') {
      l.skipped(TI, 'empty_key');
      continue;
    }
    if (stKey !== last) {
      l.skipped(TI, 'older_session');
      continue;
    }
    if (io.trx !== null && session === undefined) {
      l.skipped(TI, 'session_missing');
      continue;
    }
    const state = stateOf(c, maps.get(key));
    if (state === 'done') {
      l.skipped(TI, 'already_migrated');
      continue;
    }
    if (state === 'replay') {
      l.migrated(TI);
      continue;
    }
    const target = identity(row);
    if (target === null) {
      l.skipped(TI, 'item_missing');
      l.report(TI, key, 'item_missing', cutChars(keyOf(row['item_code']), 40) || '-');
      continue;
    }
    if (present.has(target)) {
      l.skipped(TI, 'duplicate_item');
      l.report(TI, key, 'duplicate_item', cutChars(keyOf(row['item_code']), 40) || '-');
      continue;
    }
    present.add(target);
    l.migrated(TI);
    const code = keyOf(row['status']).toLowerCase();
    if (code !== 'e' && code !== 'm' && code !== 'l' && code !== 'u') l.report(TI, key, 'status_unknown', cutChars(code, 8) || '-');
    const officer = cutChars(oneLine(personalText(l, TI, 'checked_by', row['checked_by']) ?? ''), 191);
    if (io.trx === null) continue;
    const finished = status === 'finished';
    const scanDate = dateCell(row['last_update'], { placeholder: true });
    const f = facts.get(target);
    values.push({
      stocktake_id: session!.targetId,
      item_id: target,
      expected: 1,
      state: code === 'e' ? 'found' : code === 'l' ? 'on_loan' : 'pending',
      expected_location_id: f?.location ?? null,
      expected_status: f?.status ?? null,
      stat_ddc: f?.ddc ?? null,
      collection_type_id: f?.type ?? null,
      scanned_at: code === 'e' && scanDate !== null ? localEpoch(tz, scanDate, timeCell(row['last_update'])) : null,
      scanned_by: null,
      scanned_by_name: code === 'e' && officer !== '' ? officer : null,
      scanned_location_id: null,
      result: finished ? (code === 'm' ? 'marked_missing' : 'none') : null,
    });
    toMap.push({ source: c.options.sourceName, entity: TI, legacyKey: key, targetId: target, runId: c.runId });
  }
  if (io.trx === null) return;
  for (let i = 0; i < values.length; i += 250) await io.trx.insertInto('stocktake_items').values(values.slice(i, i + 250)).execute();
  await mapLegacy(io.trx, toMap);
}

/** The last session's counters, counted again from its rows (see the top of this file). */
async function recountOnce(c: SlimsStageContext, _rows: readonly SlimsRow[], io: BatchIo): Promise<void> {
  if (io.trx === null) return;
  const last = await lastSession(c);
  const session = last === null ? undefined : (await mappedRows(c, io.trx, TS, [last])).get(last);
  if (session === undefined) return;
  const header = await io.trx.selectFrom('stocktakes').select(['status', 'total']).where('id', '=', session.targetId).executeTakeFirst();
  if (header === undefined || (header.status === 'finished' && Number(header.total) > 0)) return;
  const counts = await countGrouped(io.trx.selectFrom('stocktake_items').where('stocktake_id', '=', session.targetId).where('expected', '=', 1), { state: 'state' });
  const n = (state: string): number => counts.find((r) => r.state === state)?.count ?? 0;
  const total = counts.reduce((sum, r) => sum + r.count, 0);
  if (total === 0) return;
  await io.trx
    .updateTable('stocktakes')
    .set({ total, found: n('found') + n('misplaced'), misplaced: n('misplaced'), on_loan: n('on_loan') })
    .where('id', '=', session.targetId)
    .execute();
}

const PHASES: readonly PeoplePhase[] = Object.freeze([
  { table: TS, run: (c, rows, io, l) => sessionsBatch(c, rows, io, l) },
  { table: TI, run: (c, rows, io, l) => itemsBatch(c, rows, io, l) },
  { table: null, run: (c, rows, io) => recountOnce(c, rows, io) },
] satisfies PeoplePhase[]);

// ---- the archive as the source -----------------------------------------------------------------------------------

/** Whether an earlier run archived `stock_take` rows under the run's source name. */
async function archivedSessions(c: SlimsStageContext): Promise<boolean> {
  const row = await c.h.db
    .selectFrom('migration_archive')
    .select('id')
    .where('source', '=', c.options.sourceName)
    .where('table_name', '=', TS)
    .where('run_id', '<>', c.runId)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** `source` with the archived rows of the two stocktake tables in place of its own (it has none). */
function archiveSource(c: SlimsStageContext, source: SlimsSource): SlimsSource {
  const info = (name: string, primaryKey: string[]): SlimsTableInfo => ({ name, columns: [...(SLIMS_COLUMNS[name] ?? [])], primaryKey, rows: null });
  return {
    kind: source.kind,
    async tables() {
      const own = (await source.tables()).filter((t) => t.name !== TS && t.name !== TI);
      return [...own, info(TS, ['stock_take_id']), info(TI, ['stock_take_id', 'item_id'])];
    },
    async rows(table, after, limit) {
      if (table !== TS && table !== TI) return source.rows(table, after, limit);
      let q = c.h.db
        .selectFrom('migration_archive')
        .select(['id', 'row_json'])
        .where('source', '=', c.options.sourceName)
        .where('table_name', '=', table)
        .where('run_id', '<>', c.runId);
      if (after !== null) q = q.where('id', '>', after);
      const found = await q.orderBy('id').limit(limit).execute();
      const rows = found.map((r) => {
        try {
          return JSON.parse(r.row_json) as SlimsRow;
        } catch {
          return {} as SlimsRow;
        }
      });
      return { rows, next: found.length < limit ? null : found[found.length - 1]!.id };
    },
    close: () => source.close(),
  };
}

/** Counters that leave the two stocktake tables out (their rows read from the archive are no rows of the source). */
function withoutStocktakeCounts(counters: SlimsCounters): SlimsCounters {
  const pass = (table: string): boolean => table !== TS && table !== TI;
  return {
    source: (t, n) => (pass(t) ? counters.source(t, n) : undefined),
    migrated: (t, n) => (pass(t) ? counters.migrated(t, n) : undefined),
    merged: (t, n) => (pass(t) ? counters.merged(t, n) : undefined),
    archived: (t, n) => (pass(t) ? counters.archived(t, n) : undefined),
    unread: (t, n) => (pass(t) ? counters.unread(t, n) : undefined),
    skipped: (t, reason, n) => (pass(t) ? counters.skipped(t, reason, n) : undefined),
    fix: (column, kind, n) => counters.fix(column, kind, n),
    sample: (column, before, after) => counters.sample(column, before, after),
    vanished: (t, n) => (pass(t) ? counters.vanished(t, n) : undefined),
    changed: (t, n) => (pass(t) ? counters.changed(t, n) : undefined),
  };
}

/** The stage's context: the run's own, or, for a source without `stock_take` and an archive with it, the archive's. */
async function contextOf(c: SlimsStageContext): Promise<SlimsStageContext> {
  const fromArchive = await cachedForRun(c, 'stocktake:from-archive', async () => (await tableOf(c, TS)) === null && (await archivedSessions(c)));
  if (!fromArchive) return c;
  return { ...c, source: archiveSource(c, c.source), counters: withoutStocktakeCounts(c.counters) };
}

/** The stocktake stage (see the top of this file). */
export const stocktakeStage: SlimsStage = Object.freeze({
  name: 'stocktake' as const,
  reads: Object.freeze([TS, TI]) as readonly string[],
  // The last session is found before any batch's transaction: read from the archive, it is a read of ALTIS's own
  // database, which on SQLite would wait for ever behind the batch's transaction.
  run: async (c: SlimsStageContext, cursor: string | null) => runPeoplePhases(await contextOf(c), 'stocktake', PHASES, cursor, (x) => lastSession(x)),
});
