import { upsert, type DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { ACCRED_METRICS, type AccredMetricId } from '../metric-ids.js';
import { AccredMetaPayload, AccredResultPayload, AccredStoredValue, type AccredMetricValue } from '../types.js';

// The stored results of a period (`accred_results`, class volatile): one row per indicator (`SCH-K1`), per school
// standard (`SNP-S-01`) and for the registration prerequisites (`SCH-PRASYARAT`), each an `AccredResultPayload` of at
// most 16 000 bytes of JSON, and the evaluation's own row `_meta` (`AccredMetaPayload`: running, ready or failed, when
// it started, its job, and once ready when it was computed and the prerequisites it found).
//
// While an evaluation runs across slices it may also keep, in rows of its own (`_v.<n>`), the values of finished
// providers that a later provider's indicator still needs (a size metric, the class count of a standard, the
// prerequisites): a slice that starts after them reads them back. They are removed by the evaluation's last
// transaction; a reader of the results never reads them. A row whose JSON does not parse as its shape is read as
// missing.

type Db = Kysely<DB>;

/** The row of the evaluation's own state. */
export const META_CODE = '_meta';
/** The JSON of one stored result is at most this many bytes. */
export const RESULT_PAYLOAD_MAX_BYTES = 16_000;
/** Rows of carried values start with this. */
const CARRY_PREFIX = '_v.';

const METRIC_IDS = Object.keys(ACCRED_METRICS) as AccredMetricId[];

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** A metric's value when no provider gave one: no data. */
export function noValue(id: AccredMetricId): AccredMetricValue {
  return { value: null, unit: ACCRED_METRICS[id].unit, basis: 'none', notes: [] };
}

/** `v` as it is stored: without its facts (they never leave the evaluation), every array copied. */
export function storedValue(v: AccredMetricValue): AccredStoredValue {
  const out: AccredStoredValue = { value: v.value, unit: v.unit, basis: v.basis, notes: v.notes.map((n) => ({ ...n })) };
  if (v.numerator !== undefined) out.numerator = v.numerator;
  if (v.denominator !== undefined) out.denominator = v.denominator;
  if (v.detail !== undefined) out.detail = { reportId: v.detail.reportId, params: { ...v.detail.params } };
  if (v.table !== undefined) out.table = v.table.map((r) => [...r]);
  if (v.suggest === false) out.suggest = false;
  return out;
}

/**
 * The JSON of `payload` within `max` bytes: when it is longer, the tables of `values` (stored values inside the
 * payload, in order) lose their last rows until it fits, and each one cut is marked `tableTruncated`.
 *
 * @throws TypeError when the payload is longer than `max` even without those tables
 */
export function fittedJson(payload: object, values: readonly (AccredStoredValue | null)[], max: number = RESULT_PAYLOAD_MAX_BYTES): string {
  let json = JSON.stringify(payload);
  if (bytes(json) <= max) return json;
  for (const v of values) {
    if (v === null || v.table === undefined || v.table.length === 0) continue;
    const full = v.table;
    v.tableTruncated = true;
    // The most rows that fit, found by halving: [lo] fits (or is 0), [hi] does not.
    let lo = 0;
    let hi = full.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      v.table = full.slice(0, mid);
      if (bytes(JSON.stringify(payload)) <= max) lo = mid;
      else hi = mid;
    }
    v.table = full.slice(0, lo);
    json = JSON.stringify(payload);
    if (bytes(json) <= max) return json;
  }
  throw new TypeError(`an accreditation result is over ${max} bytes of JSON without its tables`);
}

/** What a period's stored results are: the evaluation's state and the rows by their code. */
export interface StoredResults {
  meta: AccredMetaPayload | null;
  rows: Map<string, AccredResultPayload>;
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The `_meta` row of `periodId`, or null. */
export async function readMeta(db: Db, periodId: string): Promise<AccredMetaPayload | null> {
  const row = await db.selectFrom('accred_results').select('payload').where('period_id', '=', periodId).where('indicator_code', '=', META_CODE).executeTakeFirst();
  if (row === undefined) return null;
  const meta = AccredMetaPayload.safeParse(parsedJson(row.payload));
  return meta.success ? meta.data : null;
}

/** Every stored result of `periodId` and its `_meta` (carried values left out). */
export async function readStoredResults(db: Db, periodId: string): Promise<StoredResults> {
  const rows = await db.selectFrom('accred_results').select(['indicator_code', 'payload']).where('period_id', '=', periodId).execute();
  const out: StoredResults = { meta: null, rows: new Map() };
  for (const r of rows) {
    if (r.indicator_code === META_CODE) {
      const meta = AccredMetaPayload.safeParse(parsedJson(r.payload));
      out.meta = meta.success ? meta.data : null;
      continue;
    }
    if (r.indicator_code.startsWith(CARRY_PREFIX)) continue;
    const payload = AccredResultPayload.safeParse(parsedJson(r.payload));
    if (payload.success) out.rows.set(r.indicator_code, payload.data);
  }
  return out;
}

/** Writes (or replaces) the row `code` of `periodId`. */
export async function writeResultRow(trx: Transaction<DB>, periodId: string, code: string, json: string, computedAt: number): Promise<void> {
  await upsert(trx, 'accred_results', { period_id: periodId, indicator_code: code }, { payload: json, computed_at: computedAt }, { payload: json, computed_at: computedAt });
}

/** Writes (or replaces) the `_meta` row of `periodId`. */
export async function writeMeta(trx: Transaction<DB>, periodId: string, meta: AccredMetaPayload, at: number): Promise<void> {
  await writeResultRow(trx, periodId, META_CODE, JSON.stringify(AccredMetaPayload.parse(meta)), at);
}

// ---- carried values ------------------------------------------------------------------------------------------------

const factValue = z.union([z.number(), z.string(), z.boolean(), z.null(), z.array(z.string())]);

/** A carried value: the stored shape with its facts (a later rule or standard may read them). */
const CarriedValue = z.strictObject({
  metric: z.enum(METRIC_IDS as [AccredMetricId, ...AccredMetricId[]]),
  value: AccredStoredValue,
  facts: z.record(z.string(), factValue).optional(),
});

/** The row code of the carried value of `id`. */
function carryCode(id: AccredMetricId): string {
  return `${CARRY_PREFIX}${METRIC_IDS.indexOf(id)}`;
}

/** Keeps `v`, the value of `id`, for a later slice of the same evaluation. */
export async function writeCarried(trx: Transaction<DB>, periodId: string, id: AccredMetricId, v: AccredMetricValue, at: number): Promise<void> {
  const value = storedValue(v);
  const carried: z.infer<typeof CarriedValue> = { metric: id, value };
  if (v.facts !== undefined) {
    const facts: NonNullable<typeof carried.facts> = {};
    for (const [k, f] of Object.entries(v.facts)) facts[k] = typeof f === 'object' && f !== null ? [...f] : f;
    carried.facts = facts;
  }
  await writeResultRow(trx, periodId, carryCode(id), fittedJson(carried, [value]), at);
}

/** The values an earlier slice of the evaluation of `periodId` kept, by metric. */
export async function readCarried(db: Db, periodId: string): Promise<Map<AccredMetricId, AccredMetricValue>> {
  const rows = await db.selectFrom('accred_results').select(['indicator_code', 'payload']).where('period_id', '=', periodId).execute();
  const out = new Map<AccredMetricId, AccredMetricValue>();
  for (const r of rows) {
    if (!r.indicator_code.startsWith(CARRY_PREFIX)) continue;
    const parsed = CarriedValue.safeParse(parsedJson(r.payload));
    if (!parsed.success) continue;
    const { tableTruncated: _cut, ...value } = parsed.data.value;
    void _cut;
    out.set(parsed.data.metric, parsed.data.facts === undefined ? value : { ...value, facts: parsed.data.facts });
  }
  return out;
}

/** Removes the values an evaluation of `periodId` kept for its later slices. */
export async function removeCarried(trx: Transaction<DB>, periodId: string): Promise<void> {
  const rows = await trx.selectFrom('accred_results').select('indicator_code').where('period_id', '=', periodId).execute();
  const codes = rows.map((r) => r.indicator_code).filter((code) => code.startsWith(CARRY_PREFIX));
  if (codes.length > 0) await trx.deleteFrom('accred_results').where('period_id', '=', periodId).where('indicator_code', 'in', codes).execute();
}

/** Removes every row of `periodId` but `keep` (the codes of this evaluation and `_meta`): carried values, old codes. */
export async function removeOtherRows(trx: Transaction<DB>, periodId: string, keep: readonly string[]): Promise<void> {
  await trx.deleteFrom('accred_results').where('period_id', '=', periodId).where('indicator_code', 'not in', [...keep]).execute();
}
