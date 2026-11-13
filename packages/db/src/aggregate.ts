import { sql, type Expression, type OperationNode, type RawBuilder, type SelectQueryBuilder, type SelectQueryNode } from 'kysely';
import { describe } from './checks.js';
import type { DB } from './schema.js';

// Counts (ruling L19). count(*) is a BIGINT, and the drivers hand it back as a number, a string or a bigint
// depending on the engine and on the size: SQLite and MySQL/MariaDB a number (a string above 2^53 with
// supportBigNumbers), PostgreSQL a number through the int8 parser of connect.ts (which throws above 2^53), and any
// other driver or setting a string or a bigint. countRows() is the one place that turns it into a JS number, so
// that no caller compares `'3' > 0` or adds a string to a number. Every count in 1b goes through it.

const COUNT_ALIAS = 'n';

/** A decimal count as text: digits only, no sign, no leading zeros, no blanks (what an integer column prints). */
const DECIMAL_COUNT = /^(?:0|[1-9][0-9]*)$/;

/** `value` as a JS number when it is a count a number holds exactly; a TypeError otherwise. */
function toCount(value: unknown): number {
  let n: number | undefined;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'bigint') n = value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  else if (typeof value === 'string' && DECIMAL_COUNT.test(value)) n = Number(value);
  if (n === undefined || !Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`countRows: count(*) returned ${describe(value)}, which is not a safe non-negative integer`);
  }
  return n;
}

/**
 * Why the count of `node` would not be the number of rows its query returns, or null. A GROUP BY or a DISTINCT
 * collapses rows, and a UNION is more than one SELECT: wrapping them in count(*) would answer something else.
 */
function notCountable(node: SelectQueryNode): string | null {
  if (node.groupBy !== undefined) return 'a GROUP BY';
  if (node.having !== undefined) return 'a HAVING';
  if (node.distinctOn !== undefined) return 'a DISTINCT ON';
  if (node.setOperations !== undefined) return 'a UNION, INTERSECT or EXCEPT';
  const modifiers = [...(node.frontModifiers ?? []), ...(node.endModifiers ?? [])];
  if (modifiers.some((m) => m.modifier === 'Distinct')) return 'a DISTINCT';
  return null;
}

/**
 * The number of rows `qb` selects: its selection is replaced by `count(*)`, and its ORDER BY, LIMIT and OFFSET are
 * dropped (PostgreSQL refuses an ORDER BY on a bare count, and an OFFSET would skip the one result row), so a page
 * query counts its total. Its FROM, JOINs and WHERE stay; a query that goes through a transaction counts inside it.
 *
 * @returns a JS number, whatever type the driver returns (number, string or bigint)
 * @throws TypeError when the value is not a safe integer, when no row comes back, or when the query has a
 *   GROUP BY, HAVING, DISTINCT or set operation (its count(*) would not be the number of its rows)
 */
export async function countRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qb: SelectQueryBuilder<DB, any, any>,
): Promise<number> {
  const unsupported = notCountable(qb.toOperationNode());
  if (unsupported !== null) {
    throw new TypeError(`countRows: the query has ${unsupported}, so count(*) would not be its number of rows`);
  }
  const row = await qb
    .clearSelect()
    .clearOrderBy()
    .clearLimit()
    .clearOffset()
    .select((eb) => eb.fn.countAll().as(COUNT_ALIAS))
    .executeTakeFirst();
  if (row === undefined) throw new TypeError('countRows: the count query returned no row');
  return toCount((row as Record<string, unknown>)[COUNT_ALIAS]);
}

// ---------------------------------------------------------------------------------------------------------------
// ---- Komunitas K1 (grouped counts) ----
// Grouped counts and sums: the one place for GROUP BY SQL. A report builds a query that only selects FROM, joins and
// filters; the helper adds the key selections, the aggregate and the GROUP BY, so that the same SQL runs on every
// dialect (each key is grouped by the very expression it is selected as), and turns the aggregate into a JS number
// whatever the driver returns: a number (SQLite, MySQL/MariaDB counts), a DECIMAL string (MySQL/MariaDB sums), a
// bigint or numeric string (PostgreSQL), or a bigint (another driver setting).

/** An aggregate a JS number cannot hold exactly (above 2^53 − 1), or that is not an integer at all. */
export class AggregateOverflowError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AggregateOverflowError';
  }
}

/**
 * The keys of a grouped aggregate: result field name → a column reference (`kind`, `i.status`) or an expression
 * without bound parameters ({@link datePrefix}, `sql.ref(...)`, `sql.lit(...)`).
 */
export type GroupKeys<K extends string> = Readonly<Record<K, string | Expression<unknown>>>;

/** A result field name: a plain identifier (it is quoted as an alias on every dialect). */
const KEY_ALIAS = /^[A-Za-z][A-Za-z0-9_]*$/;
/** A column reference: `column` or `table.column`. */
const COLUMN_REF = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/;
/** An integer as text: what a DECIMAL/numeric sum or a bigint count prints (a zero fraction is accepted). */
const INTEGER_TEXT = /^-?(?:0|[1-9][0-9]*)(?:\.0+)?$/;

/** `column` when it is a column reference; a TypeError naming `fn` otherwise. */
function columnRef(fn: string, column: unknown): string {
  if (typeof column !== 'string' || !COLUMN_REF.test(column)) {
    throw new TypeError(`${fn}: ${describe(column)} is not a column reference (column or table.column)`);
  }
  return column;
}

/** True when `node` (an operation node tree) binds a parameter anywhere: PostgreSQL would not match it with its copy. */
function bindsParameter(node: unknown, depth = 0): boolean {
  if (depth > 64 || typeof node !== 'object' || node === null) return false;
  const n = node as { kind?: unknown; immediate?: unknown };
  if ((n.kind === 'ValueNode' && n.immediate !== true) || n.kind === 'ValueListNode') return true;
  for (const value of Object.values(node)) {
    if (Array.isArray(value) ? value.some((v) => bindsParameter(v, depth + 1)) : bindsParameter(value, depth + 1)) return true;
  }
  return false;
}

/** The keys as [alias, expression] pairs, checked. */
function keyExpressions(fn: string, keys: Readonly<Record<string, unknown>>, aggregate: string): Array<[string, Expression<unknown>]> {
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) throw new TypeError(`${fn}: keys must be an object`);
  return Object.entries(keys).map(([alias, key]): [string, Expression<unknown>] => {
    if (!KEY_ALIAS.test(alias) || alias === aggregate) {
      throw new TypeError(`${fn}: ${JSON.stringify(alias)} cannot name a key (an identifier other than ${aggregate})`);
    }
    if (typeof key === 'string') return [alias, sql.ref(columnRef(fn, key))];
    const expression = key as Partial<Expression<unknown>> | null;
    if (typeof expression?.toOperationNode !== 'function') {
      throw new TypeError(`${fn}: the key ${alias} must be a column reference or an expression, got ${describe(key)}`);
    }
    if (bindsParameter(expression.toOperationNode() as OperationNode)) {
      throw new TypeError(`${fn}: the key ${alias} binds a parameter; use literals (sql.lit) so that its GROUP BY matches it`);
    }
    return [alias, expression as Expression<unknown>];
  });
}

/** True when `error`, or an error it was caused by, is a driver's or the database's integer overflow. */
function isIntegerOverflow(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; message?: unknown; cause?: unknown };
  const message = typeof e.message === 'string' ? e.message : '';
  if (e.code === 'ERR_OUT_OF_RANGE') return true; // node:sqlite reading an integer above 2^53 − 1
  if (e.code === 'ERR_SQLITE_ERROR' && message === 'integer overflow') return true; // SQLite's 64-bit sum
  if (e.code === '22003' || e.code === 'ER_DATA_OUT_OF_RANGE') return true; // PostgreSQL, MySQL/MariaDB
  if (error instanceof RangeError && message.includes('outside the safe integer range')) return true; // connect.ts's BIGINT parser
  return isIntegerOverflow(e.cause, depth + 1);
}

/**
 * `value` (an aggregate as the driver returned it) as a safe integer; `ifNull` for SQL NULL when given.
 *
 * @throws AggregateOverflowError for anything else: a fraction, text that is not an integer, a value beyond
 *   ±(2^53 − 1), a negative count
 */
function toSafeInteger(fn: string, alias: string, value: unknown, o: { ifNull?: number; nonNegative: boolean }): number {
  let n: number | undefined;
  if (value === null || value === undefined) n = o.ifNull;
  else if (typeof value === 'number') n = value;
  else if (typeof value === 'bigint') n = value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  else if (typeof value === 'string' && INTEGER_TEXT.test(value)) n = Number(value);
  if (n === undefined || !Number.isSafeInteger(n) || (o.nonNegative && n < 0)) {
    throw new AggregateOverflowError(`${fn}: ${alias} returned ${describe(value)}, which is not a safe integer`);
  }
  return n === 0 ? 0 : n;
}

/** A key value as the result carries it: text, a number or null (a bigint as a number when safe, else as text). */
function keyValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : String(value);
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

/** The one implementation of the grouped helpers: `aggregate` is selected as `alias`. */
async function grouped(
  fn: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qb: SelectQueryBuilder<any, any, any>,
  keys: Readonly<Record<string, unknown>>,
  alias: 'count' | 'sum',
  aggregate: Expression<unknown>,
  o: { ifNull?: number; nonNegative: boolean },
): Promise<Array<Record<string, string | number | null>>> {
  const unsupported = notCountable(qb.toOperationNode());
  if (unsupported !== null) throw new TypeError(`${fn}: the query has ${unsupported}; the helper adds the grouping itself`);
  const pairs = keyExpressions(fn, keys, alias);
  let q = qb
    .clearSelect()
    .clearOrderBy()
    .clearLimit()
    .clearOffset()
    .select([...pairs.map(([name, e]) => sql`${e}`.as(name)), sql`${aggregate}`.as(alias)]);
  if (pairs.length > 0) q = q.groupBy(pairs.map(([, e]) => e));
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await q.execute()) as Array<Record<string, unknown>>;
  } catch (error) {
    if (isIntegerOverflow(error)) {
      throw new AggregateOverflowError(`${fn}: the ${alias} does not fit in a safe integer`, { cause: error });
    }
    throw error;
  }
  return rows.map((row) => {
    const out: Record<string, string | number | null> = {};
    for (const [name] of pairs) out[name] = keyValue(row[name]);
    out[alias] = toSafeInteger(fn, alias, row[alias], o);
    return out;
  });
}

/**
 * The number of rows of `qb` per distinct combination of `keys`: one result row per group, each with the key values
 * under their names and `count` (a JS number). `qb` only selects FROM, joins and filters: its selection, ORDER BY,
 * LIMIT and OFFSET are dropped. Rows come in no particular order. With `{}` as keys there is one row, also when no row
 * matches (`count` 0).
 *
 * @throws TypeError when `qb` already has a GROUP BY, HAVING, DISTINCT or set operation, when a key name is not an
 *   identifier (or is `count`), or a key is neither a column reference nor an expression without bound parameters
 * @throws AggregateOverflowError when a count is not a safe integer
 */
export async function countGrouped<K extends string>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qb: SelectQueryBuilder<any, any, any>,
  keys: GroupKeys<K>,
): Promise<Array<Record<K, string | number | null> & { count: number }>> {
  const rows = await grouped('countGrouped', qb, keys, 'count', sql`count(*)`, { nonNegative: true });
  return rows as Array<Record<K, string | number | null> & { count: number }>;
}

/**
 * {@link countGrouped} of the distinct non-NULL values of `column` (`count(DISTINCT column)`) per group.
 *
 * @throws TypeError as countGrouped, and for a `column` that is not a column reference
 * @throws AggregateOverflowError when a count is not a safe integer
 */
export async function countDistinctGrouped<K extends string>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qb: SelectQueryBuilder<any, any, any>,
  keys: GroupKeys<K>,
  column: string,
): Promise<Array<Record<K, string | number | null> & { count: number }>> {
  const ref = sql.ref(columnRef('countDistinctGrouped', column));
  const rows = await grouped('countDistinctGrouped', qb, keys, 'count', sql`count(distinct ${ref})`, { nonNegative: true });
  return rows as Array<Record<K, string | number | null> & { count: number }>;
}

/**
 * The sum of the integer column `column` per group, as {@link countGrouped} groups, under `sum`. A group whose values
 * are all NULL (and the one row of `{}` keys over no rows) sums to 0.
 *
 * @throws TypeError as countGrouped (a key may not be named `sum`), and for a `column` that is not a column reference
 * @throws AggregateOverflowError when a sum is not a safe integer: above 2^53 − 1, or a fraction
 */
export async function sumGrouped<K extends string>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qb: SelectQueryBuilder<any, any, any>,
  keys: GroupKeys<K>,
  column: string,
): Promise<Array<Record<K, string | number | null> & { sum: number }>> {
  const ref = sql.ref(columnRef('sumGrouped', column));
  const rows = await grouped('sumGrouped', qb, keys, 'sum', sql`sum(${ref})`, { ifNull: 0, nonNegative: false });
  return rows as Array<Record<K, string | number | null> & { sum: number }>;
}

/**
 * The month (`YYYY-MM`) or year (`YYYY`) of a `YYYY-MM-DD` date column: `substr(column, 1, 7 | 4)`, which every
 * dialect has. Its length is a literal, so the expression can key a GROUP BY ({@link countGrouped}).
 *
 * @throws TypeError for a `column` that is not a column reference, or a `unit` other than `month` and `year`
 */
export function datePrefix(column: string, unit: 'month' | 'year'): RawBuilder<string> {
  if (unit !== 'month' && unit !== 'year') throw new TypeError(`datePrefix: unit must be 'month' or 'year', got ${describe(unit)}`);
  const ref = sql.ref(columnRef('datePrefix', column));
  return sql<string>`substr(${ref}, 1, ${sql.lit(unit === 'month' ? 7 : 4)})`;
}
