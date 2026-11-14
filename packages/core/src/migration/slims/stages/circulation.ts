import { countGrouped, datePrefix, type DB } from '@altis/db';
import { addDays, addMonths, ddcClassOf, diffDays, localDate, newId } from '@altis/shared';
import type { MigrationMatchRow } from '@altis/shared/api/catalog/migration';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { codeKey } from '../../../catalog/data/keys.js';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import { chargeStatusOf } from '../../../circulation/charges.js';
import { pickPolicy, policyScopeKey } from '../../../circulation/policies.js';
import { indexRecords } from '../../../search/index-records.js';
import { readSettings, writeSettings } from '../../../settings/service.js';
import type { SettingKey } from '../../../settings/registry.js';
import { SlimsRunFailure, pipelineOf } from '../pipeline.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import { archiveRows, sourceMemberKeys, sourceMemberTypes } from './members.js';
import {
  altisItemsOf,
  dateCell,
  decimalCell,
  flagCell,
  intCell,
  localEpoch,
  mapped,
  runPeoplePhases,
  runTimeZone,
  settingFlag,
  settingScalar,
  slimsSettings,
  sourceItemIds,
  type PeoplePhase,
} from './people-kit.js';
import { againOnRace, cachedForRun, cutChars, keyOf, mappedRows, oneLine, rowKey, scanAll, stateOf, tableOf, textOf, type BatchIo, type Ledger } from './stage-b-kit.js';
import { visitsCutoff } from './visits.js';

// Circulation (spec K3: the SLiMS tables `mst_loan_rules`, `holiday`, `loan`, `loan_history`, `fines`, `reserve`,
// `read_counter`, the loan values of `mst_member_type` and the circulation keys of `setting`). SLiMS 9 table/column
// names (interoperability facts, no SLiMS code). Phases:
//
// 0. `circulationMode = replace` (the cut-over, a real run): the migrated loans, holds, charges, payments and reads in
//    place, and their legacy map and archive rows, are removed first, then imported again from the source. Refused
//    when ALTIS lends, takes holds or charges on its own (MIGRATION_CIRCULATION_LIVE at the start, `circulation_live`
//    here should it begin meanwhile).
// 1. one fallback rule per member type (`<type>/*/*/*`, entity `mst_member_type_rule`): the type's loan days, renewals,
//    fine per day and grace days (read the ALTIS way: "within N days is free"), and the SLiMS type's loan limit as the
//    rule's limit (0 stays 0: SLiMS applies a type's limit only when no rule matches).
// 2. `mst_loan_rules` → rules: a 0 dimension is "every"; the member type, collection type and GMD through their maps
//    (one gone: skipped `type_missing`, `coll_type_missing`, `gmd_missing`); the grace the larger of the rule's and the
//    type's (`grace_raised`); a tuple two rules share: the smallest id (`duplicate_rule`); a `(type, 0, 0)` rule meets
//    the type's fallback rule, which wins: it is made and archived (`slims_all_rule_unused`, its values reported).
// 3. `holiday` → the library calendar: a row without a date is a weekly closed day; consecutive dates with the same
//    description one range; the six sample rows of June 2009 skipped `slims_seed_holiday`.
// 4. the circulation keys of `setting`: those SLiMS never wrote keep SLiMS's own default (reported).
// 5. `loan` → loans: open is `is_lent = 1 AND is_return = 0` (a renewal fills `return_date` without closing the loan);
//    the copy through the source's `item` and the legacy map, the member through the map (an open loan missing either
//    is skipped `open_loan_unresolved`); two open loans of one copy: the latest stays open, the other is closed
//    `closed_migration` (`double_open_loan`); the rule the SLiMS rule maps to (an archived `(type, 0, 0)` one: the
//    type's fallback rule), else the rule ALTIS resolves, its terms copied; `uid` through the staff map (none, or
//    `staffUsers` off: no one); the statistics from ALTIS's copy, record and member, else from `loan_history`.
// 6. `loan_history` rows whose loan `loan` no longer has → closed loans (the copy may be gone: no copy).
// 7. `fines` → charges, and their credit → payments (`other`, the day unknown, no receipt number) with allocations:
//    `overdue` with the loan when the description names a copy of a loan of that member due before the fine's day,
//    else `migrated`; a credit above the debit cut (`credit_cut`); a fine of at least `fineOutlierMajor` listed
//    (`fine_outlier`); a member gone: skipped `member_missing`.
// 8. `reserve` → holds `waiting` on the title, only for a copy on a migrated open loan and a member who exists, in the
//    order of `reserve_date`; the rest is archived with its reason (`item_not_on_loan`, `member_missing`,
//    `item_missing`, `duplicate`).
// 9. `read_counter` → items read in place (`migrated`).
// 10. a real run: "Cocokkan dengan SLiMS", each number of the source against ALTIS (the summary's `matches`).

const TLR = 'mst_loan_rules';
const THO = 'holiday';
const TL = 'loan';
const TH = 'loan_history';
const TF = 'fines';
const TRS = 'reserve';
const TRC = 'read_counter';
/** The rule entity of a member type's fallback rule. */
const TYPE_RULE = 'mst_member_type_rule';
/** The six sample holidays a fresh SLiMS installs. */
const SEED_HOLIDAYS = new Set(['2009-06-01', '2009-06-02', '2009-06-03', '2009-06-04', '2009-06-05', '2009-06-06']);

type Db = Kysely<DB> | Transaction<DB>;
type PolicyRow = Selectable<DB['policies']>;

// ---- shared values --------------------------------------------------------------------------------------------------

/** A SLiMS money cell in minor units per `fineMode` (major: whole rupiah ×100), never below 0. */
function fineMinor(c: SlimsStageContext, v: SlimsRow[string] | undefined): number {
  const n = decimalCell(v);
  if (n === null || n <= 0) return 0;
  if (c.options.people.fineMode === 'skip') return 0;
  return Math.round(c.options.people.fineMode === 'major' ? n * 100 : n);
}

/** The library's currency, once per run in a process. */
function currency(c: SlimsStageContext): Promise<string> {
  return cachedForRun(c, 'circ:currency', async () => String((await readSettings(c.h.db, ['catalog.currency'], []))['catalog.currency']));
}

/** Today in the library's time zone. */
async function today(c: SlimsStageContext): Promise<string> {
  return localDate(await runTimeZone(c), c.now);
}

const clamp = (n: number | null, lo: number, hi: number, fallback: number): number => (n === null ? fallback : Math.max(lo, Math.min(hi, n)));

/** The ALTIS rows ALTIS records itself (not migrated): a `replace` run is refused while any is there. */
export async function liveCirculationCount(db: Db): Promise<number> {
  let n = 0;
  for (const table of ['loans', 'holds', 'charges', 'payments', 'item_uses'] as const) {
    const row = await db
      .selectFrom(table as 'loans')
      .select((eb) => eb.fn.countAll<number | string>().as('n'))
      .where('source', '<>', 'migrated')
      .executeTakeFirstOrThrow();
    n += Number(row.n);
  }
  return n;
}

// ---- 0. replace -----------------------------------------------------------------------------------------------------

async function replaceOnce(c: SlimsStageContext, _rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  if (c.options.people.circulationMode !== 'replace' || io.trx === null) return;
  const trx = io.trx;
  const live = await liveCirculationCount(trx);
  if (live > 0) {
    throw new SlimsRunFailure('circulation_live', `ALTIS sudah mencatat ${live} baris sirkulasi sendiri / ALTIS already holds ${live} circulation rows of its own`);
  }
  const records = (await trx.selectFrom('loans').select('record_id').where('source', '=', 'migrated').where('open_item_id', 'is not', null).execute())
    .map((r) => r.record_id)
    .filter((id): id is string => id !== null);
  const payments = (await trx.selectFrom('payments').select('id').where('source', '=', 'migrated').execute()).map((r) => r.id);
  for (let i = 0; i < payments.length; i += 500) await trx.deleteFrom('payment_allocations').where('payment_id', 'in', payments.slice(i, i + 500)).execute();
  const counts: Record<string, number> = {};
  for (const table of ['payments', 'charges', 'holds', 'item_uses', 'loans'] as const) {
    const r = await trx.deleteFrom(table as 'loans').where('source', '=', 'migrated').executeTakeFirst();
    counts[table] = Number(r.numDeletedRows);
  }
  await trx.deleteFrom('migration_map').where('source', '=', c.options.sourceName).where('entity', 'in', [TL, TH, TF, TRS, TRC]).execute();
  await trx.deleteFrom('migration_archive').where('source', '=', c.options.sourceName).where('table_name', 'in', [TF, TRS]).execute();
  const unique = [...new Set(records)];
  for (let i = 0; i < unique.length; i += 200) await indexRecords(trx, unique.slice(i, i + 200), c.now);
  l.report('', null, 'circulation_replaced', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('; '));
}

/** Whether a row an earlier run mapped is to be imported again (a dry run of a `replace` run: the real run removes it). */
function replacing(c: SlimsStageContext): boolean {
  return c.options.people.circulationMode === 'replace';
}

/** fresh, replay or done, with the rows a `replace` dry run would import again counted as fresh. */
function circState(c: SlimsStageContext, m: { targetId: string; runId: string } | undefined): 'fresh' | 'replay' | 'done' {
  const s = stateOf(c, m);
  return s === 'done' && replacing(c) && c.dryRun ? 'fresh' : s;
}

// ---- 1. fallback rules, 2. loan rules -------------------------------------------------------------------------------

interface RuleValues {
  loan_days: number;
  loan_limit: number | null;
  renew_limit: number;
  fine_per_day_minor: number;
  grace_days: number;
}

function typeRuleValues(c: SlimsStageContext, row: SlimsRow): RuleValues {
  return {
    loan_days: clamp(intCell(row['loan_periode']), 0, 365, 7),
    loan_limit: clamp(intCell(row['loan_limit']), 0, 32_767, 0),
    renew_limit: clamp(intCell(row['reborrow_limit']), 0, 32_767, 0),
    fine_per_day_minor: fineMinor(c, row['fine_each_day']),
    grace_days: clamp(intCell(row['grace_periode']), 0, 365, 0),
  };
}

async function insertPolicy(
  c: SlimsStageContext,
  trx: Transaction<DB>,
  o: { code: string; name: string; memberTypeId: string | null; collectionTypeId: string | null; materialTypeId: string | null; values: RuleValues; archived: boolean },
): Promise<string> {
  const id = newId(c.now);
  let code = cutChars(o.code, 32);
  if ((await trx.selectFrom('policies').select('id').where('code_key', '=', codeKey(code)).executeTakeFirst()) !== undefined) code = cutChars(`${cutChars(code, 25)}-${id.slice(-6)}`, 32);
  const scope = policyScopeKey({ memberTypeId: o.memberTypeId, collectionTypeId: o.collectionTypeId, materialTypeId: o.materialTypeId, branchId: null });
  await againOnRace(() =>
    trx
      .insertInto('policies')
      .values({
        id,
        code_display: code,
        code_key: codeKey(code),
        name: cutChars(o.name, 191),
        member_type_id: o.memberTypeId,
        collection_type_id: o.collectionTypeId,
        material_type_id: o.materialTypeId,
        branch_id: null,
        scope_key: o.archived ? `~${id}` : scope,
        loanable: 1,
        loan_days: o.values.loan_days,
        loan_limit: o.values.loan_limit,
        renew_limit: o.values.renew_limit,
        fine_per_day_minor: o.values.fine_per_day_minor,
        fine_cap_minor: null,
        grace_days: o.values.grace_days,
        currency: 'IDR',
        archived_at: o.archived ? c.now : null,
        version: 0,
        created_at: c.now,
        created_by: null,
        updated_at: c.now,
        updated_by: null,
      })
      .execute(),
  );
  await trx.updateTable('policies').set({ currency: await currency(c) }).where('id', '=', id).execute();
  return id;
}

async function typeRulesOnce(c: SlimsStageContext, _rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const types = await sourceMemberTypes(c);
  if (types.size === 0) return;
  l.report('mst_member_type', null, 'type_rule_note', 'Batas tipe SLiMS menjadi batas aturan cadangan tipe: aturan ini menghitung pinjaman yang teresolusi ke aturan itu, SLiMS tanpa aturan cocok menghitung semua pinjaman terbuka; tenggang dibaca cara ALTIS ("dalam N hari gratis", SLiMS membebaskan N - 1) / The SLiMS type limit becomes the limit of the type\'s fallback rule, which counts the loans made under it, while SLiMS without a matching rule counts every open loan; grace is read the ALTIS way ("within N days is free", SLiMS frees N - 1)');
  const altisTypes = await mapped(c, io.db, 'mst_member_type', [...types.keys()]);
  const held = await mappedRows(c, io.db, TYPE_RULE, [...types.keys()]);
  const toMap: LegacyMapping[] = [];
  for (const [key, row] of types) {
    const typeId = altisTypes.get(key);
    if (typeId === undefined || held.has(key) || io.trx === null) continue;
    const scope = policyScopeKey({ memberTypeId: typeId, collectionTypeId: null, materialTypeId: null, branchId: null });
    const existing = await io.db.selectFrom('policies').select('id').where('scope_key', '=', scope).executeTakeFirst();
    if (existing !== undefined) {
      l.report('mst_member_type', key, 'type_rule_exists', 'Aturan tipe sudah ada di ALTIS / The type already has a rule in ALTIS');
      toMap.push({ source: c.options.sourceName, entity: TYPE_RULE, legacyKey: key, targetId: existing.id, runId: c.runId });
      continue;
    }
    const name = oneLine(keyOf(row['member_type_name'])) || key;
    const id = await insertPolicy(c, io.trx, {
      code: `SLIMS-T${key}`,
      name: `Aturan tipe ${name}`,
      memberTypeId: typeId,
      collectionTypeId: null,
      materialTypeId: null,
      values: typeRuleValues(c, row),
      archived: false,
    });
    toMap.push({ source: c.options.sourceName, entity: TYPE_RULE, legacyKey: key, targetId: id, runId: c.runId });
  }
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

/** The tuple of a SLiMS rule (`type|coll|gmd`, 0 for every) and the smallest rule id per tuple (cached for the run). */
function ruleTuples(c: SlimsStageContext): Promise<ReadonlyMap<string, string>> {
  return cachedForRun(c, 'circ:rules', async () => {
    const first = new Map<string, string>();
    await scanAll(c, TLR, (row) => {
      const id = keyOf(row['loan_rules_id']);
      const t = tupleOfRule(row);
      const held = first.get(t);
      if (id !== '' && (held === undefined || Number(id) < Number(held))) first.set(t, id);
    });
    return first;
  });
}

function tupleOfRule(row: SlimsRow): string {
  return ['member_type_id', 'coll_type_id', 'gmd_id'].map((k) => String(intCell(row[k]) ?? 0)).join('|');
}

async function rulesBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const maps = await mappedRows(c, io.db, TLR, rows.map((r) => keyOf(r['loan_rules_id'])));
  const tuples = await ruleTuples(c);
  const types = await sourceMemberTypes(c);
  const altisTypes = await mapped(c, io.db, 'mst_member_type', rows.map((r) => String(intCell(r['member_type_id']) ?? '')));
  const colls = await mapped(c, io.db, 'mst_coll_type', rows.map((r) => String(intCell(r['coll_type_id']) ?? '')));
  const gmds = await mapped(c, io.db, 'mst_gmd', rows.map((r) => String(intCell(r['gmd_id']) ?? '')));
  const toMap: LegacyMapping[] = [];
  for (const row of rows) {
    const key = keyOf(row['loan_rules_id']);
    if (key === '') {
      l.skipped(TLR, 'empty_key');
      continue;
    }
    const state = stateOf(c, maps.get(key));
    if (state === 'done') {
      l.skipped(TLR, 'already_migrated');
      continue;
    }
    const [mt, ct, gm] = tupleOfRule(row).split('|') as [string, string, string];
    if (tuples.get(tupleOfRule(row)) !== key) {
      l.skipped(TLR, 'duplicate_rule');
      l.report(TLR, key, 'duplicate_rule', `rule ${tuples.get(tupleOfRule(row))} dipakai / is used`);
      continue;
    }
    const dry = io.trx === null;
    const typeId = mt === '0' ? null : (altisTypes.get(mt) ?? (dry && types.has(mt) ? `~${mt}` : undefined));
    const collId = ct === '0' ? null : colls.get(ct);
    const gmdId = gm === '0' ? null : gmds.get(gm);
    const missing = typeId === undefined ? 'type_missing' : collId === undefined ? 'coll_type_missing' : gmdId === undefined ? 'gmd_missing' : null;
    if (missing !== null) {
      l.skipped(TLR, missing);
      l.report(TLR, key, missing, `tuple=${mt}|${ct}|${gm}`);
      continue;
    }
    const values: RuleValues = {
      loan_days: clamp(intCell(row['loan_periode']), 0, 365, 7),
      loan_limit: clamp(intCell(row['loan_limit']), 0, 32_767, 0),
      renew_limit: clamp(intCell(row['reborrow_limit']), 0, 32_767, 0),
      fine_per_day_minor: fineMinor(c, row['fine_each_day']),
      grace_days: clamp(intCell(row['grace_periode']), 0, 365, 0),
    };
    for (const col of ['loan_periode', 'loan_limit', 'reborrow_limit', 'grace_periode']) {
      if (keyOf(row[col]) !== '' && intCell(row[col]) === null) l.report(TLR, key, 'invalid_value', `${col}=${cutChars(keyOf(row[col]), 20)} -> 0`);
    }
    const typeGrace = mt === '0' ? 0 : clamp(intCell(types.get(mt)?.['grace_periode']), 0, 365, 0);
    if (typeGrace > values.grace_days) {
      l.report(TLR, key, 'grace_raised', `${values.grace_days} -> ${typeGrace}`);
      values.grace_days = typeGrace;
    }
    const allRule = mt !== '0' && ct === '0' && gm === '0';
    if (allRule) {
      l.report(TLR, key, 'slims_all_rule_unused', `loan_days=${values.loan_days}; loan_limit=${values.loan_limit}; renew=${values.renew_limit}; fine=${values.fine_per_day_minor}; grace=${values.grace_days}`);
      l.archived(TLR);
    } else {
      l.migrated(TLR);
    }
    if (state === 'replay' || io.trx === null) continue;
    const id = await insertPolicy(c, io.trx, {
      code: `SLIMS-R${key}`,
      name: `Aturan SLiMS ${key}`,
      memberTypeId: typeId ?? null,
      collectionTypeId: collId ?? null,
      materialTypeId: gmdId ?? null,
      values,
      archived: allRule,
    });
    toMap.push({ source: c.options.sourceName, entity: TLR, legacyKey: key, targetId: id, runId: c.runId });
  }
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

// ---- 3. holidays ----------------------------------------------------------------------------------------------------

const WEEKDAYS: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, "jum'at": 5, sabtu: 6, minggu: 7, ahad: 7 };

/** The weekday of a SLiMS `holiday_dayname` (1 Monday … 7 Sunday), or null. */
export function weekdayOf(name: string): number | null {
  const s = name.trim().toLowerCase();
  if (/^[1-7]$/.test(s)) return Number(s);
  return WEEKDAYS[s] ?? WEEKDAYS[s.slice(0, 3)] ?? null;
}

/** Per dated holiday id, the first id of its range (consecutive days, one description) and the range's end. */
function holidayRanges(c: SlimsStageContext): Promise<ReadonlyMap<string, { leader: string; from: string; to: string }>> {
  return cachedForRun(c, 'circ:holidays', async () => {
    const dated: { id: string; date: string; text: string }[] = [];
    await scanAll(c, THO, (row) => {
      const date = dateCell(row['holiday_date']);
      if (date !== null) dated.push({ id: keyOf(row['holiday_id']), date, text: oneLine(keyOf(row['description'])) });
    });
    dated.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : Number(a.id) - Number(b.id)));
    const out = new Map<string, { leader: string; from: string; to: string }>();
    let run: { leader: string; from: string; to: string; text: string; ids: string[] } | null = null;
    const close = (): void => {
      if (run !== null) for (const id of run.ids) out.set(id, { leader: run.leader, from: run.from, to: run.to });
    };
    for (const h of dated) {
      if (run !== null && (h.date === run.to || h.date === addDays(run.to, 1)) && h.text === run.text) {
        run.to = h.date;
        run.ids.push(h.id);
        continue;
      }
      close();
      run = { leader: h.id, from: h.date, to: h.date, text: h.text, ids: [h.id] };
    }
    close();
    return out;
  });
}

async function holidaysBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const maps = await mappedRows(c, io.db, THO, rows.map((r) => keyOf(r['holiday_id'])));
  const ranges = await holidayRanges(c);
  const leaders = await mapped(c, io.db, THO, [...new Set([...ranges.values()].map((r) => r.leader))]);
  const toMap: LegacyMapping[] = [];
  for (const row of rows) {
    const key = keyOf(row['holiday_id']);
    if (key === '') {
      l.skipped(THO, 'empty_key');
      continue;
    }
    const state = stateOf(c, maps.get(key));
    if (state === 'done') {
      l.skipped(THO, 'already_migrated');
      continue;
    }
    const date = dateCell(row['holiday_date']);
    const name = cutChars(oneLine(textOf(l, THO, 'description', row['description']) ?? ''), 191) || 'Libur';
    if (date !== null && SEED_HOLIDAYS.has(date)) {
      l.skipped(THO, 'slims_seed_holiday');
      continue;
    }
    if (date === null) {
      const weekday = weekdayOf(keyOf(row['holiday_dayname']));
      if (weekday === null) {
        l.skipped(THO, 'invalid_value');
        l.report(THO, key, 'invalid_value', `holiday_dayname=${cutChars(keyOf(row['holiday_dayname']), 20)}`);
        continue;
      }
      const held = io.trx === null ? undefined : await io.trx.selectFrom('calendars').select('id').where('kind', '=', 'weekly').where('weekday', '=', weekday).where('archived_at', 'is', null).executeTakeFirst();
      if (state === 'replay' || held !== undefined) {
        if (state === 'replay') l.migrated(THO);
        else {
          l.merged(THO);
          toMap.push({ source: c.options.sourceName, entity: THO, legacyKey: key, targetId: held!.id, runId: c.runId });
        }
        continue;
      }
      l.migrated(THO);
      if (io.trx === null) continue;
      const id = newId(c.now);
      await io.trx
        .insertInto('calendars')
        .values({ id, branch_id: null, kind: 'weekly', weekday, date_from: null, date_to: null, month_day_from: null, month_day_to: null, name, archived_at: null, version: 0, created_at: c.now, created_by: null, updated_at: c.now, updated_by: null })
        .execute();
      toMap.push({ source: c.options.sourceName, entity: THO, legacyKey: key, targetId: id, runId: c.runId });
      continue;
    }
    const range = ranges.get(key)!;
    if (range.leader !== key) {
      l.merged(THO);
      const target = leaders.get(range.leader);
      if (target !== undefined && state !== 'replay') toMap.push({ source: c.options.sourceName, entity: THO, legacyKey: key, targetId: target, runId: c.runId });
      continue;
    }
    l.migrated(THO);
    if (state === 'replay' || io.trx === null) continue;
    const id = newId(c.now);
    await io.trx
      .insertInto('calendars')
      .values({ id, branch_id: null, kind: 'dates', weekday: null, date_from: range.from, date_to: range.to, month_day_from: null, month_day_to: null, name, archived_at: null, version: 0, created_at: c.now, created_by: null, updated_at: c.now, updated_by: null })
      .execute();
    leaders.set(key, id);
    toMap.push({ source: c.options.sourceName, entity: THO, legacyKey: key, targetId: id, runId: c.runId });
  }
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

// ---- 4. settings ----------------------------------------------------------------------------------------------------

async function settingsOnce(c: SlimsStageContext, _rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const s = await slimsSettings(c);
  const patch: Partial<Record<SettingKey, unknown>> = {};
  const flag = (name: string): boolean | null => (s.has(name) ? settingFlag(settingScalar(s.get(name)!)) : null);
  const ignore = flag('ignore_holidays_fine_calc');
  patch['circulation.fines.skipClosedDays'] = ignore === true;
  if (!s.has('ignore_holidays_fine_calc')) l.report('setting', 'ignore_holidays_fine_calc', 'setting_missing', 'Tidak ada di SLiMS: memakai perilaku bawaan SLiMS (hari libur ikut dihitung denda) / Not in SLiMS: SLiMS\'s own default is kept (closed days count for fines)');
  const reserveOnLoan = flag('reserve_on_loan_only');
  patch['circulation.holds.onlyWhenNoneAvailable'] = reserveOnLoan === true;
  if (!s.has('reserve_on_loan_only')) {
    l.report('setting', 'reserve_on_loan_only', 'setting_missing', 'Tidak ada di SLiMS: memakai perilaku bawaan SLiMS (false); default ALTIS untuk instalasi baru adalah true / Not in SLiMS: SLiMS\'s own default (false) is kept; the ALTIS default of a new installation is true');
  }
  if (flag('allow_loan_date_change') === true) l.report('setting', 'allow_loan_date_change', 'setting_advice', 'Berikan izin circulation.desk.override kepada staf yang mencatat pinjaman bertanggal mundur / Give circulation.desk.override to the staff who record back-dated loans');
  if (flag('loan_limit_override') === true) l.report('setting', 'loan_limit_override', 'setting_advice', 'Berikan izin circulation.desk.override kepada staf yang boleh memaksa batas pinjam / Give circulation.desk.override to the staff who may force the loan limit');
  for (const name of ['circulation_receipt', 'quick_return']) if (s.has(name)) l.report('setting', name, 'setting_reported', 'Dilaporkan saja / Reported only');
  if (io.trx !== null) await writeSettings(io.trx, patch, { keyring: [], now: c.now, actorId: null });
}

// ---- 5. loans -------------------------------------------------------------------------------------------------------

interface SourceLoan {
  id: string;
  itemCode: string;
  member: string;
  loanDate: string | null;
  dueDate: string | null;
  open: boolean;
}

/** The source's loans (cached for the run): the open ones per copy, and the winner of each copy's open loans. */
function sourceLoans(c: SlimsStageContext): Promise<{ all: SourceLoan[]; openWinner: Map<string, string> }> {
  return cachedForRun(c, 'circ:loans', async () => {
    const all: SourceLoan[] = [];
    await scanAll(c, TL, (row) => {
      all.push({
        id: keyOf(row['loan_id']),
        itemCode: keyOf(row['item_code']),
        member: keyOf(row['member_id']),
        loanDate: dateCell(row['loan_date']),
        dueDate: dateCell(row['due_date']),
        open: flagCell(row['is_lent']) === true && flagCell(row['is_return']) !== true,
      });
    });
    const openWinner = new Map<string, string>();
    const better = (a: SourceLoan, b: SourceLoan): boolean => (a.loanDate ?? '') > (b.loanDate ?? '') || ((a.loanDate ?? '') === (b.loanDate ?? '') && Number(a.id) > Number(b.id));
    const byCode = new Map<string, SourceLoan>();
    for (const loan of all) {
      if (!loan.open || loan.itemCode === '') continue;
      const held = byCode.get(loan.itemCode);
      if (held === undefined || better(loan, held)) byCode.set(loan.itemCode, loan);
    }
    for (const [code, loan] of byCode) openWinner.set(code, loan.id);
    return { all, openWinner };
  });
}

/** `loan_history` classification and member type name per loan id (cached for the run). */
function historyFacts(c: SlimsStageContext): Promise<ReadonlyMap<string, { classification: string }>> {
  return cachedForRun(c, 'circ:history', async () => {
    const out = new Map<string, { classification: string }>();
    await scanAll(c, TH, (row) => out.set(keyOf(row['loan_id']), { classification: keyOf(row['classification']) }));
    return out;
  });
}

interface ItemFacts {
  id: string;
  record_id: string;
  branch_id: string;
  collection_type_id: string;
  location_id: string | null;
  call_number: string | null;
  material_type_id: string | null;
  classification: string | null;
  record_call_number: string | null;
}

async function itemFacts(db: Db, ids: readonly string[]): Promise<Map<string, ItemFacts>> {
  const out = new Map<string, ItemFacts>();
  const wanted = [...new Set(ids)];
  for (let i = 0; i < wanted.length; i += 500) {
    for (const r of await db
      .selectFrom('items as i')
      .innerJoin('records as r', 'r.id', 'i.record_id')
      .select(['i.id', 'i.record_id', 'i.branch_id', 'i.collection_type_id', 'i.location_id', 'i.call_number', 'r.material_type_id', 'r.classification', 'r.call_number as record_call_number'])
      .where('i.id', 'in', wanted.slice(i, i + 500))
      .execute()) {
      out.set(r.id, r as ItemFacts);
    }
  }
  return out;
}

interface MemberFact {
  type: string;
  group: string | null;
  className: string | null;
}

async function memberFactsOf(db: Db, ids: readonly string[]): Promise<Map<string, MemberFact>> {
  const out = new Map<string, MemberFact>();
  const wanted = [...new Set(ids)];
  for (let i = 0; i < wanted.length; i += 500) {
    for (const m of await db
      .selectFrom('members as m')
      .leftJoin('member_types as t', 't.id', 'm.member_type_id')
      .select(['m.id', 'm.member_type_id', 'm.class_name', 't.accred_group'])
      .where('m.id', 'in', wanted.slice(i, i + 500))
      .execute()) {
      out.set(m.id, { type: m.member_type_id, group: m.accred_group ?? null, className: m.class_name });
    }
  }
  return out;
}

/** `stat_ddc` of a classification (the desk's rule). */
function statDdc(classification: string | null, callNumber: string | null): string | null {
  const ddc = ddcClassOf(classification, callNumber);
  return ddc.main === 'NON' ? null : (ddc.division ?? ddc.main);
}

/** The live and archived rules by id, and the type fallback rules by ALTIS type (one read per batch). */
async function policies(db: Db): Promise<{ byId: Map<string, PolicyRow>; live: PolicyRow[] }> {
  const all = await db.selectFrom('policies').selectAll().execute();
  return { byId: new Map(all.map((p) => [p.id, p])), live: all.filter((p) => p.archived_at === null) };
}

interface LoanPlan {
  key: string;
  itemId: string | null;
  memberId: string | null;
  open: boolean;
  outcome: string | null;
  loanedOn: string;
  dueOn: string;
  returnedOn: string | null;
  renewals: number;
  policy: PolicyRow | null;
  loanedBy: string | null;
  classification: string | null;
}

async function insertLoan(c: SlimsStageContext, trx: Transaction<DB>, p: LoanPlan, item: ItemFacts | undefined, member: MemberFact | undefined): Promise<string> {
  const tz = await runTimeZone(c);
  const id = newId(c.now);
  const branch = item?.branch_id ?? c.options.branchId;
  const terms = p.policy;
  await trx
    .insertInto('loans')
    .values({
      id,
      item_id: p.itemId,
      open_item_id: p.open ? p.itemId : null,
      record_id: item?.record_id ?? null,
      member_id: p.memberId,
      branch_id: branch,
      policy_id: terms?.id ?? null,
      loaned_on: p.loanedOn,
      loaned_at: localEpoch(tz, p.loanedOn),
      due_on: p.dueOn,
      renewals: p.renewals,
      last_renewed_on: null,
      returned_on: p.returnedOn,
      returned_at: p.returnedOn === null ? null : localEpoch(tz, p.returnedOn),
      return_branch_id: p.returnedOn === null ? null : branch,
      outcome: p.outcome,
      loan_days: terms === null ? Math.max(0, Math.min(365, diffDays(p.loanedOn, p.dueOn))) : Number(terms.loan_days),
      renew_limit: terms === null ? 0 : Number(terms.renew_limit),
      grace_days: terms === null ? 0 : Number(terms.grace_days),
      fine_per_day_minor: terms === null ? 0 : Number(terms.fine_per_day_minor),
      fine_cap_minor: terms === null || terms.fine_cap_minor === null ? null : Number(terms.fine_cap_minor),
      currency: terms?.currency ?? (await currency(c)),
      overrides: null,
      override_note: null,
      loaned_by: p.loanedBy,
      returned_by: null,
      source: 'migrated',
      stat_ddc: item === undefined ? statDdc(p.classification, null) : statDdc(item.classification, item.call_number ?? item.record_call_number),
      stat_material_type_id: item?.material_type_id ?? null,
      stat_collection_type_id: item?.collection_type_id ?? null,
      stat_location_id: item?.location_id ?? null,
      stat_member_type_id: member?.type ?? null,
      stat_accred_group: member?.group ?? (p.memberId === null ? 'unknown' : null),
      stat_class_name: member?.className ?? null,
      version: 0,
      created_at: c.now,
      created_by: null,
      updated_at: c.now,
      updated_by: null,
    })
    .execute();
  return id;
}

async function loansBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger, table: typeof TL | typeof TH): Promise<void> {
  const history = table === TH;
  const maps = await mappedRows(c, io.db, table, rows.map((r) => keyOf(r['loan_id'])));
  const items = await altisItemsOf(c, io.db, rows.map((r) => keyOf(r['item_code'])));
  const members = await mapped(c, io.db, 'member', rows.map((r) => keyOf(r['member_id'])));
  const staff = c.options.people.staffUsers ? await mapped(c, io.db, 'user', rows.map((r) => keyOf(r['uid']))) : new Map<string, string>();
  const rules = await mapped(c, io.db, TLR, rows.map((r) => String(intCell(r['loan_rules_id']) ?? '')));
  const typeRules = await mapped(c, io.db, TYPE_RULE, [...(await sourceMemberTypes(c)).keys()]);
  const facts = await itemFacts(io.db, [...items.values()]);
  const people = await memberFactsOf(io.db, [...members.values()]);
  const pol = await policies(io.db);
  const { openWinner } = await sourceLoans(c);
  const inLoan = history ? new Set((await sourceLoans(c)).all.map((x) => x.id)) : new Set<string>();
  const historyOf = history ? new Map<string, { classification: string }>() : await historyFacts(c);
  const sourceMembers = io.trx === null ? await sourceMemberKeys(c) : new Set<string>();
  const fallbackByType = new Map([...typeRules.values()].map((policyId) => [pol.byId.get(policyId)?.member_type_id ?? '', policyId]));
  const records = new Set<string>();
  const toMap: LegacyMapping[] = [];
  const todayIs = await today(c);
  for (const row of rows) {
    const key = keyOf(row['loan_id']);
    if (key === '') {
      l.skipped(table, 'empty_key');
      continue;
    }
    if (history && inLoan.has(key)) {
      l.skipped(table, 'in_loan_table');
      continue;
    }
    const state = circState(c, maps.get(key));
    if (state === 'done') {
      l.skipped(table, 'already_migrated');
      continue;
    }
    if (state === 'replay') {
      l.migrated(table);
      continue;
    }
    const code = keyOf(row['item_code']);
    const slimsMember = keyOf(row['member_id']);
    const itemId = items.get(code) ?? null;
    const memberId = members.get(slimsMember) ?? null;
    const lent = flagCell(row['is_lent']);
    const returned = flagCell(row['is_return']) === true;
    let open = !history && lent === true && !returned;
    const loanedOn = dateCell(row['loan_date']);
    if (loanedOn === null) {
      l.skipped(table, 'invalid_date');
      l.report(table, key, 'invalid_date', `loan_date=${keyOf(row['loan_date']) || '-'}`);
      continue;
    }
    const dueOn = dateCell(row['due_date']) ?? loanedOn;
    if (open) {
      const dryMember = io.trx === null && sourceMembers.has(slimsMember);
      const dryItem = io.trx === null && (await sourceItemIds(c)).has(code) && itemId !== null;
      if ((itemId === null && !dryItem) || (memberId === null && !dryMember)) {
        l.skipped(table, 'open_loan_unresolved');
        l.report(table, key, 'open_loan_unresolved', `${itemId === null ? `item_code=${code || '-'}` : ''}${memberId === null && !dryMember ? ` member_id=${slimsMember || '-'}` : ''}`.trim());
        continue;
      }
    }
    let outcome: string | null = null;
    if (open && openWinner.get(code) !== key) {
      open = false;
      outcome = 'closed_migration';
      l.report(table, key, 'double_open_loan', `item_code=${code}`);
    } else if (!open) {
      outcome = returned || history ? 'returned' : 'closed_migration';
    }
    if (open && itemId !== null && io.trx !== null) {
      const held = await io.trx.selectFrom('loans').select('id').where('open_item_id', '=', itemId).executeTakeFirst();
      if (held !== undefined) {
        l.skipped(table, 'item_on_loan_in_altis');
        l.report(table, key, 'item_on_loan_in_altis', `item_code=${code}`);
        continue;
      }
    }
    const item = itemId === null ? undefined : facts.get(itemId);
    const member = memberId === null ? undefined : people.get(memberId);
    // The rule: the one the SLiMS rule maps to (an archived "every" rule: the type's fallback), else ALTIS's.
    let policy: PolicyRow | null = null;
    const ruleId = rules.get(String(intCell(row['loan_rules_id']) ?? ''));
    const mappedRule = ruleId === undefined ? undefined : pol.byId.get(ruleId);
    if (mappedRule !== undefined && mappedRule.archived_at === null) policy = mappedRule;
    else if (mappedRule !== undefined && member !== undefined) policy = pol.byId.get(fallbackByType.get(member.type) ?? '') ?? null;
    if (policy === null && member !== undefined && item !== undefined) {
      policy = pickPolicy(pol.live, { memberTypeId: member.type, collectionTypeId: item.collection_type_id, materialTypeId: item.material_type_id, branchId: item.branch_id });
    }
    const returnedOn = open ? null : (dateCell(row['return_date']) ?? (outcome === 'closed_migration' ? todayIs : dueOn));
    l.migrated(table);
    if (io.trx === null) continue;
    if (!open && itemId === null) l.report(table, key, 'item_gone', `item_code=${code || '-'}`);
    const id = await insertLoan(c, io.trx, {
      key,
      itemId,
      memberId,
      open,
      outcome,
      loanedOn,
      dueOn,
      returnedOn,
      renewals: clamp(intCell(row['renewed']), 0, 32_767, 0),
      policy,
      loanedBy: staff.get(keyOf(row['uid'])) ?? null,
      classification: history ? keyOf(row['classification']) || null : (historyOf.get(key)?.classification ?? null),
    }, item, member);
    if (open && item !== undefined) records.add(item.record_id);
    toMap.push({ source: c.options.sourceName, entity: table, legacyKey: key, targetId: id, runId: c.runId });
  }
  if (io.trx === null) return;
  await mapLegacy(io.trx, toMap);
  if (records.size > 0) await indexRecords(io.trx, [...records], c.now);
}

// ---- 7. fines -------------------------------------------------------------------------------------------------------

async function finesBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger, at: { c: string | null; n: number }): Promise<void> {
  if (at.c === null && at.n === 0) {
    l.report(TF, null, 'credit_as_payment', 'Pembayaran dan penghapusan SLiMS tidak dapat dibedakan: setiap kredit menjadi pembayaran / SLiMS payments and waivers cannot be told apart: every credit becomes a payment');
  }
  const maps = await mappedRows(c, io.db, TF, rows.map((r) => keyOf(r['fines_id'])));
  const members = await mapped(c, io.db, 'member', rows.map((r) => keyOf(r['member_id'])));
  const memberIds = [...new Set(members.values())];
  // The member's migrated loans with their copy's barcode: an overdue fine names a copy in its description.
  const loans = new Map<string, { id: string; item_id: string; barcode: string; due_on: string; returned_on: string | null; branch_id: string }[]>();
  for (let i = 0; i < memberIds.length; i += 500) {
    for (const r of await io.db
      .selectFrom('loans as l')
      .innerJoin('items as i', 'i.id', 'l.item_id')
      .select(['l.id', 'l.member_id', 'l.item_id', 'i.barcode_display', 'l.due_on', 'l.returned_on', 'l.branch_id'])
      .where('l.member_id', 'in', memberIds.slice(i, i + 500))
      .where('l.source', '=', 'migrated')
      .execute()) {
      const list = loans.get(r.member_id!) ?? [];
      list.push({ id: r.id, item_id: r.item_id!, barcode: r.barcode_display, due_on: r.due_on, returned_on: r.returned_on, branch_id: r.branch_id });
      loans.set(r.member_id!, list);
    }
  }
  const todayIs = await today(c);
  const tz = await runTimeZone(c);
  const money = await currency(c);
  const sourceMembers = io.trx === null ? await sourceMemberKeys(c) : new Set<string>();
  const toMap: LegacyMapping[] = [];
  for (const row of rows) {
    const key = keyOf(row['fines_id']);
    if (key === '') {
      l.skipped(TF, 'empty_key');
      continue;
    }
    const state = circState(c, maps.get(key));
    if (state === 'done') {
      l.skipped(TF, 'already_migrated');
      continue;
    }
    if (state === 'replay') {
      l.migrated(TF);
      continue;
    }
    if (c.options.people.fineMode === 'skip') {
      l.skipped(TF, 'fine_mode_skip');
      continue;
    }
    const slimsMember = keyOf(row['member_id']);
    const memberId = members.get(slimsMember) ?? null;
    if (memberId === null && !sourceMembers.has(slimsMember)) {
      l.skipped(TF, 'member_missing');
      l.report(TF, key, 'member_missing', slimsMember || '-');
      continue;
    }
    const amount = fineMinor(c, row['debet']);
    let paid = fineMinor(c, row['credit']);
    if (amount <= 0) {
      l.skipped(TF, 'zero_fine');
      continue;
    }
    if (paid > amount) {
      l.report(TF, key, 'credit_cut', `${paid} -> ${amount}`);
      paid = amount;
    }
    const debet = decimalCell(row['debet']) ?? 0;
    const major = c.options.people.fineMode === 'major' ? debet : debet / 100;
    if (major >= c.options.people.fineOutlierMajor) l.report(TF, key, 'fine_outlier', `${major}`);
    const day = dateCell(row['fines_date']);
    const chargedOn = day ?? todayIs;
    if (day === null) l.report(TF, key, 'date_unknown', `fines_date=${keyOf(row['fines_date']) || '-'}`);
    const description = cutChars(oneLine(textOf(l, TF, 'description', row['description']) ?? ''), 191) || 'Denda SLiMS';
    const lower = description.toLowerCase();
    const loan = (memberId === null ? [] : (loans.get(memberId) ?? [])).find(
      (x) => x.barcode !== '' && lower.includes(x.barcode.toLowerCase()) && x.due_on < chargedOn && (x.returned_on === null || chargedOn <= addDays(x.returned_on, 1)),
    );
    l.migrated(TF);
    if (io.trx === null || memberId === null) continue;
    const chargeId = newId(c.now);
    const chargedAt = localEpoch(tz, chargedOn);
    await io.trx
      .insertInto('charges')
      .values({
        id: chargeId,
        member_id: memberId,
        branch_id: loan?.branch_id ?? c.options.branchId,
        loan_id: loan?.id ?? null,
        item_id: loan?.item_id ?? null,
        kind: loan === undefined ? 'migrated' : 'overdue',
        description,
        amount_minor: amount,
        paid_minor: paid,
        waived_minor: 0,
        currency: money,
        status: chargeStatusOf(amount, paid, 0),
        charged_on: chargedOn,
        charged_at: chargedAt,
        date_unknown: day === null ? 1 : 0,
        source: 'migrated',
        version: 0,
        created_at: c.now,
        created_by: null,
        updated_at: c.now,
        updated_by: null,
      })
      .execute();
    if (paid > 0) {
      const paymentId = newId(c.now);
      await io.trx
        .insertInto('payments')
        .values({
          id: paymentId,
          member_id: memberId,
          branch_id: loan?.branch_id ?? c.options.branchId,
          receipt_year: null,
          receipt_seq: null,
          receipt_no: null,
          amount_minor: paid,
          currency: money,
          method: 'other',
          paid_on: chargedOn,
          paid_at: chargedAt,
          received_by: null,
          note: null,
          voided_at: null,
          voided_by: null,
          void_reason: null,
          date_unknown: 1,
          source: 'migrated',
          version: 0,
          created_at: c.now,
          created_by: null,
          updated_at: c.now,
          updated_by: null,
        })
        .execute();
      await io.trx.insertInto('payment_allocations').values({ payment_id: paymentId, charge_id: chargeId, amount_minor: paid }).execute();
    }
    toMap.push({ source: c.options.sourceName, entity: TF, legacyKey: key, targetId: chargeId, runId: c.runId });
  }
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

// ---- 8. holds -------------------------------------------------------------------------------------------------------

/** Per (member, title) of `reserve`, the id of its first row by `reserve_date`, then `reserve_id` (cached for the run). */
function holdWinners(c: SlimsStageContext): Promise<ReadonlyMap<string, string>> {
  return cachedForRun(c, 'circ:holds', async () => {
    const ids = await sourceItemIds(c);
    const firsts = new Map<string, { id: string; date: string }>();
    const biblio = new Map<string, string>();
    await scanAll(c, 'item', (row) => biblio.set(keyOf(row['item_id']), keyOf(row['biblio_id'])));
    await scanAll(c, TRS, (row) => {
      const id = keyOf(row['reserve_id']);
      const title = keyOf(row['biblio_id']) || biblio.get(ids.get(keyOf(row['item_code'])) ?? '') || `#${keyOf(row['item_code'])}`;
      const pair = `${keyOf(row['member_id'])}\u0000${title}`;
      const date = keyOf(row['reserve_date']);
      const held = firsts.get(pair);
      if (held === undefined || date < held.date || (date === held.date && Number(id) < Number(held.id))) firsts.set(pair, { id, date });
    });
    return new Map([...firsts].map(([pair, f]) => [pair, f.id]));
  });
}

async function holdsBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const maps = await mappedRows(c, io.db, TRS, rows.map((r) => keyOf(r['reserve_id'])));
  const items = await altisItemsOf(c, io.db, rows.map((r) => keyOf(r['item_code'])));
  const members = await mapped(c, io.db, 'member', rows.map((r) => keyOf(r['member_id'])));
  const facts = await itemFacts(io.db, [...items.values()]);
  const winners = await holdWinners(c);
  const ids = await sourceItemIds(c);
  const biblio = await cachedForRun(c, 'circ:item-biblio', async () => {
    const out = new Map<string, string>();
    await scanAll(c, 'item', (row) => out.set(keyOf(row['item_id']), keyOf(row['biblio_id'])));
    return out;
  });
  const { all, openWinner } = await sourceLoans(c);
  const sourceOpen = new Set(all.filter((x) => x.open && openWinner.get(x.itemCode) === x.id).map((x) => x.itemCode));
  const tz = await runTimeZone(c);
  const todayIs = await today(c);
  const toArchive: { key: string; row: SlimsRow; slimsMember: string }[] = [];
  const toMap: LegacyMapping[] = [];
  const planned = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row['reserve_id']);
    if (key === '') {
      l.skipped(TRS, 'empty_key');
      continue;
    }
    const state = circState(c, maps.get(key));
    if (state === 'done') {
      l.skipped(TRS, 'already_migrated');
      continue;
    }
    if (state === 'replay') {
      l.migrated(TRS);
      continue;
    }
    const code = keyOf(row['item_code']);
    const slimsMember = keyOf(row['member_id']);
    const itemId = items.get(code) ?? null;
    const memberId = members.get(slimsMember) ?? null;
    const item = itemId === null ? undefined : facts.get(itemId);
    const title = keyOf(row['biblio_id']) || biblio.get(ids.get(code) ?? '') || `#${code}`;
    let reason: string | null = null;
    if (memberId === null && !(io.trx === null && (await sourceMemberKeys(c)).has(slimsMember))) reason = 'member_missing';
    if (reason === null && item === undefined && !(io.trx === null && ids.has(code))) reason = 'item_missing';
    if (reason === null) {
      const onLoan =
        io.trx === null
          ? sourceOpen.has(code)
          : (await io.db.selectFrom('loans').select('id').where('open_item_id', '=', itemId!).where('source', '=', 'migrated').executeTakeFirst()) !== undefined;
      if (!onLoan) reason = 'item_not_on_loan';
    }
    if (reason === null && winners.get(`${slimsMember}\u0000${title}`) !== key) reason = 'duplicate';
    if (reason === null && memberId !== null && item !== undefined) {
      const active = `${memberId}:${item.record_id}`;
      const held = planned.has(active) || (await io.db.selectFrom('holds').select('id').where('active_key', '=', active).executeTakeFirst()) !== undefined;
      if (held) reason = 'duplicate';
      planned.add(active);
    }
    if (reason !== null) {
      l.report(TRS, key, reason, `item_code=${code || '-'}`);
      toArchive.push({ key, row, slimsMember });
      continue;
    }
    l.migrated(TRS);
    if (io.trx === null || memberId === null || item === undefined) continue;
    const placedOn = dateCell(row['reserve_date']) ?? todayIs;
    const id = newId(c.now);
    await io.trx
      .insertInto('holds')
      .values({
        id,
        record_id: item.record_id,
        item_id: null,
        pinned: 0,
        member_id: memberId,
        pickup_branch_id: item.branch_id,
        status: 'waiting',
        active_key: `${memberId}:${item.record_id}`,
        trap_item_id: null,
        placed_on: placedOn,
        placed_at: localEpoch(tz, placedOn),
        placed_by: null,
        source: 'migrated',
        expires_on: null,
        ready_at: null,
        pickup_until: null,
        closed_at: null,
        close_reason: null,
        shelf_cleared_at: null,
        loan_id: null,
        version: 0,
        created_at: c.now,
        created_by: null,
        updated_at: c.now,
        updated_by: null,
      })
      .execute();
    toMap.push({ source: c.options.sourceName, entity: TRS, legacyKey: key, targetId: id, runId: c.runId });
  }
  await archiveRows(c, io, l, TRS, toArchive);
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

// ---- 9. reads in place ----------------------------------------------------------------------------------------------

async function readsBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger, at: { n: number }): Promise<void> {
  const pk = (await tableOf(c, TRC))?.primaryKey ?? [];
  const keys = rows.map((r, i) => rowKey(r, pk, at.n + i));
  const maps = await mappedRows(c, io.db, TRC, keys);
  const items = await altisItemsOf(c, io.db, rows.map((r) => keyOf(r['item_code'])));
  const facts = await itemFacts(io.db, [...items.values()]);
  const tz = await runTimeZone(c);
  const toMap: LegacyMapping[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const key = keys[i]!;
    if (key === '') {
      l.skipped(TRC, 'empty_key');
      continue;
    }
    const state = circState(c, maps.get(key));
    if (state === 'done') {
      l.skipped(TRC, 'already_migrated');
      continue;
    }
    if (state === 'replay') {
      l.migrated(TRC);
      continue;
    }
    const itemId = items.get(keyOf(row['item_code']));
    const item = itemId === undefined ? undefined : facts.get(itemId);
    const day = dateCell(row['created_at']);
    if (item === undefined && !(io.trx === null && (await sourceItemIds(c)).has(keyOf(row['item_code'])))) {
      l.skipped(TRC, 'item_missing');
      continue;
    }
    if (day === null) {
      l.skipped(TRC, 'invalid_date');
      continue;
    }
    l.migrated(TRC);
    if (io.trx === null || item === undefined) continue;
    const id = newId(c.now);
    await io.trx
      .insertInto('item_uses')
      .values({
        id,
        item_id: item.id,
        record_id: item.record_id,
        branch_id: item.branch_id,
        used_on: day,
        used_at: localEpoch(tz, day),
        member_id: null,
        stat_ddc: statDdc(item.classification, item.call_number ?? item.record_call_number),
        stat_material_type_id: item.material_type_id,
        stat_collection_type_id: item.collection_type_id,
        source: 'migrated',
        created_by: null,
      })
      .execute();
    toMap.push({ source: c.options.sourceName, entity: TRC, legacyKey: key, targetId: id, runId: c.runId });
  }
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

// ---- 10. "Cocokkan dengan SLiMS" -----------------------------------------------------------------------------------

function row(key: MigrationMatchRow['key'], scope: string, source: number, altis: number, explained: number, ok?: boolean): MigrationMatchRow {
  return { key, scope, source, altis, explained, ok: ok ?? source - explained === altis };
}

/** The source's numbers against ALTIS's after the run (see the top of this file). */
export async function circulationMatches(c: SlimsStageContext, db: Db): Promise<MigrationMatchRow[]> {
  const todayIs = await today(c);
  const out: MigrationMatchRow[] = [];
  const { all, openWinner } = await sourceLoans(c);
  const open = all.filter((x) => x.open);
  const items = await altisItemsOf(c, db, open.map((x) => x.itemCode));
  const members = await mapped(c, db, 'member', open.map((x) => x.member));
  const unresolved = open.filter((x) => !items.has(x.itemCode) || !members.has(x.member));
  const doubles = open.filter((x) => openWinner.get(x.itemCode) !== x.id && items.has(x.itemCode) && members.has(x.member));
  const count = async (q: Parameters<typeof countGrouped>[0]): Promise<number> => (await countGrouped(q, {}))[0]?.count ?? 0;
  const altisOpen = await count(db.selectFrom('loans').where('source', '=', 'migrated').where('open_item_id', 'is not', null));
  out.push(row('open_loans', '', open.length, altisOpen, unresolved.length + doubles.length));
  const openCodes = new Set(open.map((x) => x.itemCode));
  const resolvedCodes = new Set(open.filter((x) => items.has(x.itemCode) && members.has(x.member)).map((x) => x.itemCode));
  const altisItems = await count(db.selectFrom('loans').where('source', '=', 'migrated').where('open_item_id', 'is not', null));
  out.push(row('items_on_loan', '', openCodes.size, altisItems, openCodes.size - resolvedCodes.size));
  const missing = open.filter((x) => !items.has(x.itemCode)).length;
  out.push(row('open_loans_item_missing', '', missing, 0, 0, missing === 0));
  const overdue = open.filter((x) => x.dueDate !== null && x.dueDate < todayIs);
  const altisOverdue = await count(db.selectFrom('loans').where('source', '=', 'migrated').where('open_item_id', 'is not', null).where('due_on', '<', todayIs));
  const overdueGone = overdue.filter((x) => unresolved.includes(x) || doubles.includes(x)).length;
  out.push(row('overdue_loans', '', overdue.length, altisOverdue, overdueGone));
  // Unpaid fines of the members who came over, in minor units.
  let unpaid = 0;
  let unpaidGone = 0;
  const fines: { member: string; left: number }[] = [];
  await scanAll(c, TF, (r) => {
    const amount = fineMinor(c, r['debet']);
    const paid = Math.min(amount, fineMinor(c, r['credit']));
    if (amount > paid) fines.push({ member: keyOf(r['member_id']), left: amount - paid });
  });
  const fineMembers = await mapped(c, db, 'member', fines.map((f) => f.member));
  for (const f of fines) {
    unpaid += f.left;
    if (!fineMembers.has(f.member)) unpaidGone += f.left;
  }
  const charged = await db
    .selectFrom('charges')
    .select((eb) => [eb.fn.sum<number | string>('amount_minor').as('a'), eb.fn.sum<number | string>('paid_minor').as('p'), eb.fn.sum<number | string>('waived_minor').as('w')])
    .where('source', '=', 'migrated')
    .where('status', '=', 'open')
    .executeTakeFirst();
  const altisUnpaid = Number(charged?.a ?? 0) - Number(charged?.p ?? 0) - Number(charged?.w ?? 0);
  out.push(row('unpaid_fines_minor', '', unpaid, altisUnpaid, unpaidGone));
  // Members per SLiMS type: active and expired.
  const perType = new Map<string, { id: string; expired: boolean }[]>();
  await scanAll(c, 'member', (r) => {
    const id = keyOf(r['member_id']);
    if (id === '') return;
    const t = keyOf(r['member_type_id']);
    const e = dateCell(r['expire_date']);
    perType.set(t, [...(perType.get(t) ?? []), { id, expired: e !== null && e < todayIs }]);
  });
  for (const [type, list] of [...perType].sort(([a], [b]) => Number(a) - Number(b))) {
    const targets = await mapped(c, db, 'member', list.map((m) => m.id));
    const ids = [...targets.values()];
    let active = 0;
    let expired = 0;
    for (let i = 0; i < ids.length; i += 500) {
      for (const x of await db.selectFrom('members').select('expires_on').where('id', 'in', ids.slice(i, i + 500)).where('archived_at', 'is', null).execute()) {
        if (x.expires_on !== null && x.expires_on < todayIs) expired += 1;
        else active += 1;
      }
    }
    const gone = (expiredOnes: boolean): number => list.filter((m) => m.expired === expiredOnes && !targets.has(m.id)).length;
    out.push(row('active_members', type, list.filter((m) => !m.expired).length, active, gone(false)));
    out.push(row('expired_members', type, list.filter((m) => m.expired).length, expired, gone(true)));
  }
  // Holds: per member, the source's rows less the archived ones equal ALTIS's waiting holds.
  const reserve: string[] = [];
  await scanAll(c, TRS, (r) => reserve.push(keyOf(r['member_id'])));
  const archived = await count(db.selectFrom('migration_archive').where('source', '=', c.options.sourceName).where('table_name', '=', TRS));
  const altisHolds = await count(db.selectFrom('holds').where('source', '=', 'migrated').where('status', 'in', ['waiting', 'ready']));
  out.push(row('holds', '', reserve.length, altisHolds, archived));
  // Visits per month, the last 12 months before the cut-off: raw counts.
  const cutoff = (await visitsCutoff(c)) ?? todayIs;
  const from = `${addMonths(cutoff.slice(0, 7) + '-01', -12).slice(0, 7)}`;
  const monthly = new Map<string, number>();
  await scanAll(c, 'visitor_count', (r) => {
    const d = dateCell(r['checkin_date']);
    if (d === null || d >= cutoff) return;
    const m = d.slice(0, 7);
    if (m >= from && m <= cutoff.slice(0, 7)) monthly.set(m, (monthly.get(m) ?? 0) + 1);
  });
  const altisMonthly = new Map<string, number>();
  for (const r of await countGrouped(
    db.selectFrom('visits').where('source', '=', 'migrated').where('branch_id', '=', c.options.branchId).where('voided_at', 'is', null).where('visited_on', '>=', `${from}-01`).where('visited_on', '<', cutoff),
    { m: datePrefix('visited_on', 'month') },
  )) {
    altisMonthly.set(String(r.m), r.count);
  }
  for (const m of [...new Set([...monthly.keys(), ...altisMonthly.keys()])].sort()) out.push(row('visits_month', m, monthly.get(m) ?? 0, altisMonthly.get(m) ?? 0, 0));
  return out;
}

async function matchesOnce(c: SlimsStageContext, _rows: readonly SlimsRow[], io: BatchIo): Promise<void> {
  if (io.trx === null) return;
  pipelineOf(c).state.matches = await circulationMatches(c, io.trx);
}

const PHASES: readonly PeoplePhase[] = Object.freeze([
  { table: null, run: (c, rows, io, l) => replaceOnce(c, rows, io, l) },
  { table: null, run: (c, rows, io, l) => typeRulesOnce(c, rows, io, l) },
  { table: TLR, run: (c, rows, io, l) => rulesBatch(c, rows, io, l) },
  { table: THO, run: (c, rows, io, l) => holidaysBatch(c, rows, io, l) },
  { table: null, run: (c, rows, io, l) => settingsOnce(c, rows, io, l) },
  { table: TL, run: (c, rows, io, l) => loansBatch(c, rows, io, l, TL) },
  { table: TH, run: (c, rows, io, l) => loansBatch(c, rows, io, l, TH) },
  { table: TF, run: (c, rows, io, l, at) => finesBatch(c, rows, io, l, at) },
  { table: TRS, run: (c, rows, io, l) => holdsBatch(c, rows, io, l) },
  { table: TRC, run: (c, rows, io, l, at) => readsBatch(c, rows, io, l, at) },
  { table: null, run: (c, rows, io) => matchesOnce(c, rows, io) },
] satisfies PeoplePhase[]);

/** The circulation stage (see the top of this file). */
export const circulationStage: SlimsStage = Object.freeze({
  name: 'circulation' as const,
  reads: Object.freeze([TLR, THO, TL, TH, TF, TRS, TRC]) as readonly string[],
  run: (c: SlimsStageContext, cursor: string | null) =>
    runPeoplePhases(c, 'circulation', PHASES, cursor, async (x) => {
      await currency(x);
      await visitsCutoff(x);
    }),
});
